// Shared payment flow used by voice (Home), Bills and Contacts:
//   confirm sheet → (gateway checkout in a WebView) or (UPI app deep link) → result.
// Everything that happens is also SPOKEN, and the "did it go through?" question after a UPI app
// can be answered by voice or by the big buttons.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { accessToken } from './auth';
import { api, getBase, inr, type Pending, type Transaction, type UpiApp } from './api';
import { Text, Btn, Icon, IconTile, SuccessMark, buzz } from './ui';
import { useVoice } from './voice';
import { skipNextLock } from './LockGate';
import { authorizePayment } from './payAuth';
import { C, CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_TINT, F, R, S } from './theme';

export type PayResult = { status: 'success' | 'failed' | 'cancelled'; refId?: string; error?: string };
type Done = (r: PayResult) => void;

type Ctx = {
  /** Show the confirm sheet for a pending payment. */
  show: (p: Pending, onDone?: Done, opts?: { onVoiceTap?: () => void }) => void;
  /** The user already said "yes": open the gateway directly. `auto` also lets the demo gateway pay without another tap. */
  payGateway: (p: Pending, onDone?: Done, opts?: { auto?: boolean }) => void;
  /** The user said "Google Pay / PhonePe / Paytm" (or tapped it). */
  payUpi: (p: Pending, app: UpiApp, onDone?: Done) => void;
  /** Close the sheet without paying (voice said "no"). */
  dismiss: () => void;
};

const PayCtx = createContext<Ctx | null>(null);
export const usePay = () => useContext(PayCtx)!;

const YES = /\b(yes|yeah|yep|aama|aamaa|ama|sari|seri|paid|done|success|successful|went through|ok|okay)\b/i;
const CANCEL = /\b(cancel|cancelled|canceled|stopped|venaam|vendaam)\b/i;
const FAIL = /\b(no|not|illa|illai|fail|failed|declined|error)\b/i;

export function PayProvider({ children }: { children: React.ReactNode }) {
  const voice = useVoice();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [pending, setPending] = useState<Pending | null>(null);
  const [checkoutHtml, setCheckoutHtml] = useState<string | null>(null);
  const [result, setResult] = useState<(PayResult & { pending: Pending }) | null>(null);
  const [upiAsk, setUpiAsk] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const onDoneRef = useRef<Done | undefined>(undefined);
  const upiTx = useRef<Transaction | null>(null);
  const upiAskOpen = useRef(false);
  const current = useRef<Pending | null>(null);

  const finish = useCallback(async (r: PayResult) => {
    const p = current.current;
    setCheckoutHtml(null);
    setPending(null);
    setUpiAsk(null);
    if (p) setResult({ ...r, pending: p });
    buzz(r.status === 'success' ? 'success' : r.status === 'failed' ? 'error' : 'warn');
    const msg =
      r.status === "success" ? `${p && p.category === "topup" ? `${inr(p.amount)} added to your wallet.` : `Payment successful. ${p ? `${inr(p.amount)} to ${p.title}.` : ""}`}${r.refId ? ` Reference ${r.refId}.` : ''}`
      : r.status === 'cancelled' ? (r.error ?? 'Payment cancelled. No money was moved.')
      : `Payment failed. ${r.error ?? 'No money was moved.'}`;
    const cb = onDoneRef.current;
    onDoneRef.current = undefined;
    await voiceRef.current.speak(msg);
    cb?.(r);
  }, []);

  const voiceTapRef = useRef<(() => void) | undefined>(undefined);
  const show = useCallback((p: Pending, onDone?: Done, opts?: { onVoiceTap?: () => void }) => {
    current.current = p;
    onDoneRef.current = onDone;
    voiceTapRef.current = opts?.onVoiceTap;
    setResult(null);
    setPending(p);
  }, []);

  /** Fingerprint / face / phone PIN before any money moves. Returns false (and says why) when it was not approved. */
  const approve = useCallback(async (p: Pending): Promise<boolean> => {
    voiceRef.current.halt();
    const r = await authorizePayment(`Confirm payment of ${inr(p.amount)} to ${p.title}`, (t) => voiceRef.current.speak(t));
    if (r.ok) return true;
    const why = r.reason === 'lockout' ? 'Too many wrong tries. Please wait a little or use your phone PIN.' : r.reason === 'cancelled' ? 'You cancelled the check.' : 'The check did not match.';
    finish({ status: 'cancelled', error: `${why} No money was moved.` });
    return false;
  }, [finish]);

  const payGateway = useCallback(async (p: Pending, onDone?: Done, opts?: { auto?: boolean }) => {
    current.current = p;
    if (onDone) onDoneRef.current = onDone;
    setResult(null);
    if (!(await approve(p))) return;
    setPending(null);
    try {
      // The page calls back to the server with relative paths. Bake the server address into the page itself,
      // so it works even if the WebView does not run the injected script (that gave "requested path is invalid").
      const html = await api.checkoutHtml(p.id, !!opts?.auto);
      // The checkout page calls the server by itself, so it must carry the user's login too.
      const tok = await accessToken();
      const authFetch = tok ? `(function(){var f=window.fetch;window.fetch=function(u,o){o=o||{};o.headers=Object.assign({},o.headers,{Authorization:'Bearer '+${JSON.stringify(tok)}});return f.call(window,u,o);};})();` : '';
      const base = `<script>window.__API_BASE__=${JSON.stringify(getBase())};${authFetch}</script>`;
      setCheckoutHtml(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html);
    } catch (e) {
      finish({ status: 'failed', error: (e as Error).message });
    }
  }, [finish, approve]);

  const payUpi = useCallback(async (p: Pending, app: UpiApp, onDone?: Done) => {
    current.current = p;
    if (onDone) onDoneRef.current = onDone;
    setResult(null);
    if (!(await approve(p))) return;
    setBusy(true);
    try {
      const r = await api.upi(p.id, app);
      upiTx.current = r.transaction;
      setPending(null);
      let opened = false;
      skipNextLock();
      try { await Linking.openURL(r.link); opened = true; } catch {}
      if (!opened && r.link !== r.fallbackLink) { try { await Linking.openURL(r.fallbackLink); opened = true; } catch {} }
      if (!opened) {
        await api.upiResult(r.transaction.id, 'failed');
        upiTx.current = null;
        finish({ status: 'failed', error: 'No UPI app was found on this phone. Install Google Pay, PhonePe or Paytm, or pay through the gateway.' });
      }
    } catch (e) {
      finish({ status: 'failed', error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [finish, approve]);

  const dismiss = useCallback(() => {
    setPending(null);
    setCheckoutHtml(null);
  }, []);

  // ---- Back from the UPI app: UPI apps do not report the result to us, so we ask. By voice or by tap. ----
  const settleUpi = useCallback(async (tx: Transaction, status: 'success' | 'failed' | 'cancelled') => {
    if (!upiAskOpen.current) return;
    upiAskOpen.current = false;
    voiceRef.current.halt();
    const r = await api.upiResult(tx.id, status).catch(() => null);
    finish({ status, refId: r?.transaction.refId ?? tx.refId });
  }, [finish]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      const tx = upiTx.current;
      if (st !== 'active' || !tx) return;
      upiTx.current = null;
      upiAskOpen.current = true;
      setUpiAsk(tx);
      buzz('warn');
      (async () => {
        for (let i = 0; i < 2 && upiAskOpen.current; i++) {
          let said = '';
          try {
            said = (await voiceRef.current.ask(`Did the payment of ${inr(tx.amount)} to ${tx.payeeName} go through? Say yes or no.`)) ?? '';
          } catch { return; } // no mic: the buttons are still there
          if (!upiAskOpen.current) return;
          if (CANCEL.test(said)) return settleUpi(tx, 'cancelled');
          if (FAIL.test(said) && !YES.test(said)) return settleUpi(tx, 'failed');
          if (YES.test(said)) return settleUpi(tx, 'success');
        }
      })();
    });
    return () => sub.remove();
  }, [settleUpi]);

  function onMessage(e: WebViewMessageEvent) {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'success') finish({ status: 'success', refId: m.refId });
      else if (m.type === 'cancelled') finish({ status: 'cancelled' });
      else if (m.type === 'failed') finish({ status: 'failed', error: m.error });
    } catch {}
  }

  const p = pending;
  const r = result;
  const cancelSheet = () => { voice.halt(); setPending(null); const cb = onDoneRef.current; onDoneRef.current = undefined; cb?.({ status: 'cancelled' }); };

  return (
    <PayCtx.Provider value={{ show, payGateway, payUpi, dismiss }}>
      {children}

      {/* Confirm sheet */}
      <Modal visible={!!p} transparent animationType="slide" onRequestClose={cancelSheet}>
        <View accessibilityViewIsModal style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.scrim }}>
          {p && (
            <View style={{ backgroundColor: C.card, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: S.lg, paddingTop: S.sm, maxHeight: '90%' }}>
              <View accessible={false} importantForAccessibility="no" style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.outline, marginBottom: S.md }} />
              <ScrollView>
                {/* The sheet covers the voice orb, so the orb's controls live here too. */}
                <Pressable
                  onPress={() => { buzz('success'); if (voice.phase === 'listening') voice.finishListening(); else if (voice.phase === 'speaking') voice.halt(); else voiceTapRef.current?.(); }}
                  accessibilityRole="button"
                  accessibilityLabel={voice.phase === 'listening' ? 'Listening. Double tap when you finish speaking.' : voice.phase === 'speaking' ? 'Speaking. Double tap to stop.' : voice.phase === 'thinking' ? 'Thinking.' : 'Double tap to speak your answer.'}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, borderRadius: R.pill, marginBottom: S.md,
                    backgroundColor: voice.phase === 'listening' ? C.amber : voice.phase === 'speaking' ? C.blue : voice.phase === 'thinking' ? C.card2 : C.greenTint }}
                >
                  <Icon name={voice.phase === 'listening' ? 'ear' : voice.phase === 'speaking' ? 'volume-high' : voice.phase === 'thinking' ? 'ellipsis-horizontal' : 'mic'} size={24}
                    color={voice.phase === 'listening' ? C.onAmber : voice.phase === 'speaking' ? C.onBlue : voice.phase === 'thinking' ? C.text : C.green} />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: voice.phase === 'listening' ? C.onAmber : voice.phase === 'speaking' ? C.onBlue : voice.phase === 'thinking' ? C.text : C.green }}>
                    {voice.phase === 'listening' ? 'Listening… tap when done' : voice.phase === 'speaking' ? 'Speaking… tap to stop' : voice.phase === 'thinking' ? 'Thinking…' : 'Tap to answer by voice'}
                  </Text>
                </Pressable>
                <View style={{ alignItems: 'center' }}>
                  <IconTile icon={CATEGORY_ICON[p.category] ?? 'cash'} tint={CATEGORY_TINT[p.category] ?? C.card2} size={60} />
                  <Text style={{ color: C.sub, fontSize: F.body, marginTop: 4 }}>{CATEGORY_LABEL[p.category]}</Text>
                </View>
                <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', textAlign: 'center', marginTop: S.sm }}>{p.title}</Text>
                <Text style={{ color: C.sub, textAlign: 'center', fontSize: F.body, marginTop: 2 }}>{p.subtitle}</Text>
                <Text accessibilityLabel={`${p.amount} rupees`} style={{ color: C.text, fontSize: F.hero, fontWeight: '800', textAlign: 'center', marginVertical: S.md }}>{inr(p.amount)}</Text>
                {p.details?.map((d) => (
                  <View key={d.label} accessible style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: S.sm, borderBottomWidth: 1, borderColor: C.line }}>
                    <Text style={{ color: C.sub, fontSize: F.body }}>{d.label}</Text>
                    <Text style={{ color: C.text, fontSize: F.body, flexShrink: 1, textAlign: 'right', marginLeft: S.md }}>{d.value}</Text>
                  </View>
                ))}
                <Btn title={`Pay ${inr(p.amount)} by gateway`} icon="card" onPress={() => { voice.halt(); payGateway(p); }} style={{ marginTop: S.md }} />
                {p.upiAllowed && (
                  <>
                    <Btn title="Pay with Google Pay" icon="logo-google" kind="ghost" busy={busy} onPress={() => { voice.halt(); payUpi(p, 'gpay'); }} style={{ marginTop: S.sm }} />
                    <View style={{ flexDirection: 'row', gap: S.sm, marginTop: S.sm }}>
                      <Btn title="PhonePe" kind="ghost" onPress={() => { voice.halt(); payUpi(p, 'phonepe'); }} style={{ flex: 1, paddingHorizontal: S.sm }} />
                      <Btn title="Paytm" kind="ghost" onPress={() => { voice.halt(); payUpi(p, 'paytm'); }} style={{ flex: 1, paddingHorizontal: S.sm }} />
                      <Btn title="Any UPI" kind="ghost" onPress={() => { voice.halt(); payUpi(p, 'any'); }} style={{ flex: 1, paddingHorizontal: S.sm }} />
                    </View>
                  </>
                )}
                <Btn title="Cancel" icon="close" kind="danger" onPress={cancelSheet} style={{ marginTop: S.md }} />
                <Text style={{ color: C.faint, fontSize: F.small, textAlign: 'center', marginTop: S.md }}>
                  Test gateway: no real money moves.{p.upiAllowed ? ' UPI apps move real money: you approve with your PIN.' : ''}
                </Text>
              </ScrollView>
            </View>
          )}
        </View>
      </Modal>

      {/* Gateway checkout */}
      <Modal visible={!!checkoutHtml} animationType="slide" onRequestClose={() => finish({ status: 'cancelled' })}>
        <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: 36 }}>
          {checkoutHtml && (
            <WebView
              source={{ html: checkoutHtml, baseUrl: getBase() }}
              injectedJavaScriptBeforeContentLoaded={`window.__API_BASE__ = ${JSON.stringify(getBase())}; true;`}
              onMessage={onMessage}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
              setSupportMultipleWindows={false}
              // Razorpay's UPI option opens UPI apps via intent:// or upi:// links
              onShouldStartLoadWithRequest={(req) => {
                if (/^https?:/i.test(req.url) || req.url.startsWith('about:')) return true;
                Linking.openURL(req.url).catch(() => voiceRef.current.speak('No app on this phone can open this payment option.'));
                return false;
              }}
              style={{ backgroundColor: C.bg }}
            />
          )}
          <Btn title="Close payment" icon="close" kind="ghost" onPress={() => finish({ status: 'cancelled' })} style={{ margin: S.md }} />
        </View>
      </Modal>

      {/* "Did the UPI payment go through?" */}
      <Modal visible={!!upiAsk} transparent animationType="fade" onRequestClose={() => {}}>
        <View accessibilityViewIsModal style={{ flex: 1, justifyContent: 'center', padding: S.lg, backgroundColor: C.scrim }}>
          {upiAsk && (
            <View style={{ backgroundColor: C.card, borderRadius: R.xl, padding: S.lg }}>
              <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', textAlign: 'center' }}>Did the payment go through?</Text>
              <Text style={{ color: C.sub, fontSize: F.body, textAlign: 'center', marginVertical: S.md }}>{inr(upiAsk.amount)} to {upiAsk.payeeName}</Text>
              <Text style={{ color: C.faint, fontSize: F.small, textAlign: 'center', marginBottom: S.md }}>You can also just say yes or no.</Text>
              <Btn title="Yes, it was paid" icon="checkmark-circle" onPress={() => settleUpi(upiAsk, 'success')} />
              <Btn title="No, it failed" icon="close-circle" kind="danger" onPress={() => settleUpi(upiAsk, 'failed')} style={{ marginTop: S.sm }} />
              <Btn title="I cancelled it" kind="ghost" onPress={() => settleUpi(upiAsk, 'cancelled')} style={{ marginTop: S.sm }} />
            </View>
          )}
        </View>
      </Modal>

      {/* Result */}
      <Modal visible={!!r} transparent animationType="fade" onRequestClose={() => setResult(null)}>
        <View accessibilityViewIsModal style={{ flex: 1, justifyContent: 'center', padding: S.lg, backgroundColor: C.scrim }}>
          {r && (
            <View style={{ backgroundColor: C.card, borderRadius: R.xl, padding: S.lg, alignItems: 'center' }}>
              {r.status === 'failed' ? <Icon name="close-circle" size={80} color={C.red} /> : <SuccessMark ok={r.status === 'success'} />}
              <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginTop: S.sm }}>
                {r.status === 'success' ? 'Payment successful' : r.status === 'cancelled' ? 'Payment cancelled' : 'Payment failed'}
              </Text>
              <Text style={{ color: C.text, fontSize: F.hero - 8, fontWeight: '800', marginVertical: S.sm }}>{inr(r.pending.amount)}</Text>
              <Text style={{ color: C.sub, fontSize: F.body, textAlign: 'center' }}>{r.pending.title}</Text>
              {r.refId ? <Text style={{ color: C.sub, fontSize: F.body, marginTop: S.sm }}>Reference {r.refId}</Text> : null}
              {r.error ? <Text style={{ color: C.red, fontSize: F.body, marginTop: S.sm, textAlign: 'center' }}>{r.error}</Text> : null}
              <Btn title="Done" onPress={() => setResult(null)} style={{ marginTop: S.lg, alignSelf: 'stretch' }} />
            </View>
          )}
        </View>
      </Modal>
    </PayCtx.Provider>
  );
}
