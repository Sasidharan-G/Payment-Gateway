// The voice screen. A blind or low-vision user can run the whole app from here:
//   greeting → listen → understand → act (pay, read screens, KYC…) → speak → listen again.
// "Tap anywhere on the big circle" starts / finishes / interrupts. Everything is also readable on screen.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, inr, type AgentReply, type Category, type Choice, type Screen } from '../api';
import { usePay, type PayResult } from '../PayFlow';
import QrScanner from '../QrScanner';
import { skipNextLock } from '../LockGate';
import { useMicLevel, useVoice, type Phase } from '../voice';
import { Text, Chip, Icon, IconBtn, IconTile, buzz, usePressScale } from '../ui';
import { C, CATEGORY_TINT, F, R, S, type IconName } from '../theme';

type Msg = { id: number; from: 'me' | 'agent'; text: string };

const TILE_TINT: Record<string, string> = {
  'Send money': CATEGORY_TINT.transfer, 'Scan QR': CATEGORY_TINT.qr, Electricity: CATEGORY_TINT.electricity, Recharge: CATEGORY_TINT.mobile,
  DTH: CATEGORY_TINT.dth, Gas: CATEGORY_TINT.gas, Water: CATEGORY_TINT.water, Broadband: CATEGORY_TINT.broadband, Postpaid: CATEGORY_TINT.postpaid,
  FASTag: CATEGORY_TINT.fastag, 'Credit card': CATEGORY_TINT.creditcard, Insurance: CATEGORY_TINT.insurance, 'Loan EMI': CATEGORY_TINT.loan,
  'Property tax': CATEGORY_TINT.tax, 'Bank transfer': CATEGORY_TINT.bank, 'Add money': CATEGORY_TINT.topup, Request: CATEGORY_TINT.request,
  'Split bill': CATEGORY_TINT.split, 'Bills due': CATEGORY_TINT.due, Spending: CATEGORY_TINT.spend, 'Pay again': CATEGORY_TINT.again,
};

const SUGGESTIONS = [
  'Send 500 to Ramesh', 'Priya ku aayiram anuppu', 'Scan QR', 'EB bill kattu', 'Jio recharge 299', 'Gas cylinder book pannu', 'Add money',
  'Request 500 from Priya', 'Split 1200 between me and Ramesh', 'Which bills are due', 'Last payment', 'My balance', 'Help',
];

/** Big one-tap shortcuts for people who can see a little. Each one runs the same voice command. */
const TILES: Array<{ icon: IconName; label: string; say: string }> = [
  { icon: 'arrow-up-circle', label: 'Send money', say: 'send money' },
  { icon: 'qr-code', label: 'Scan QR', say: 'scan qr' },
  { icon: 'flash', label: 'Electricity', say: 'pay electricity bill' },
  { icon: 'phone-portrait', label: 'Recharge', say: 'mobile recharge' },
  { icon: 'tv', label: 'DTH', say: 'dth recharge' },
  { icon: 'flame', label: 'Gas', say: 'book gas cylinder' },
  { icon: 'water', label: 'Water', say: 'pay water bill' },
  { icon: 'wifi', label: 'Broadband', say: 'pay broadband bill' },
  { icon: 'call', label: 'Postpaid', say: 'pay postpaid bill' },
  { icon: 'car', label: 'FASTag', say: 'fastag recharge' },
  { icon: 'card', label: 'Credit card', say: 'pay credit card bill' },
  { icon: 'shield-checkmark', label: 'Insurance', say: 'pay insurance premium' },
  { icon: 'cash', label: 'Loan EMI', say: 'pay loan emi' },
  { icon: 'home', label: 'Property tax', say: 'pay property tax' },
  { icon: 'business', label: 'Bank transfer', say: 'bank transfer' },
  { icon: 'add-circle', label: 'Add money', say: 'add money' },
  { icon: 'hand-left', label: 'Request', say: 'request money' },
  { icon: 'people', label: 'Split bill', say: 'split bill' },
  { icon: 'alarm', label: 'Bills due', say: 'which bills are due' },
  { icon: 'stats-chart', label: 'Spending', say: 'how much did I spend this month' },
  { icon: 'refresh', label: 'Pay again', say: 'pay again' },
];
const EXPECTS_ANSWER = new Set(['NEEDS_INFO', 'AWAITING_CHOICE', 'AWAITING_CONFIRMATION']);

const PHASE: Record<Phase, { icon: IconName; text: string; label: string }> = {
  idle: { icon: 'mic', text: 'Tap anywhere on the circle to talk', label: 'Talk to VoicePay. Double tap, then speak your command.' },
  listening: { icon: 'ear', text: 'Listening… speak now', label: 'Listening. Double tap when you finish speaking.' },
  thinking: { icon: 'ellipsis-horizontal', text: 'Thinking…', label: 'Thinking.' },
  speaking: { icon: 'volume-high', text: 'Speaking… tap to interrupt', label: 'VoicePay is speaking. Double tap to interrupt and talk.' },
};

const ORB: Record<Phase, { grad: [string, string, string]; fg: string }> = {
  idle: { grad: ['#7CF0AB', '#30D158', '#12803A'], fg: C.onGreen },
  listening: { grad: ['#FFE98A', '#FFD60A', '#C79A00'], fg: C.onAmber },
  speaking: { grad: ['#A9D2FF', '#64A8FF', '#2F6FD6'], fg: C.onBlue },
  thinking: { grad: ['#8E8E93', '#555559', '#3A3A3C'], fg: C.text },
};

/** The signature: a glass sphere that swells with your voice and breathes with rings. Reads the mic level on its own. */
function Orb({ phase, size }: { phase: Phase; size: number }) {
  const level = useMicLevel();
  const swell = useRef(new Animated.Value(1)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const [reduce, setReduce] = useState(false);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {}); }, []);
  useEffect(() => {
    const v = phase === 'listening' ? 1 + Math.max(0, Math.min(1, (level + 60) / 50)) * 0.2 : 1;
    Animated.spring(swell, { toValue: v, speed: 18, bounciness: 6, useNativeDriver: true }).start();
  }, [level, phase, swell]);
  useEffect(() => {
    if (reduce) { breathe.setValue(0); return; }
    breathe.setValue(0);
    const loop = Animated.loop(Animated.timing(breathe, {
      toValue: 1, duration: phase === 'idle' ? 3400 : phase === 'thinking' ? 1300 : 2000, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [phase, reduce, breathe]);

  const p = PHASE[phase];
  const o = ORB[phase];
  const box = size * 1.2;
  const ring = (from: number, to: number, op: number) => ({
    position: 'absolute' as const, width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: o.grad[1],
    opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [op, 0] }),
    transform: [{ scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [from, to] }) }],
  });
  return (
    <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={ring(1, 1.38, 0.55)} />
      <Animated.View style={ring(0.92, 1.22, 0.32)} />
      <Animated.View style={{ transform: [{ scale: swell }] }}>
        <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.3)' }}>
          <LinearGradient colors={o.grad} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ position: 'absolute', top: size * 0.08, left: size * 0.16, width: size * 0.52, height: size * 0.27, borderRadius: size, backgroundColor: 'rgba(255,255,255,0.24)', transform: [{ rotate: '-18deg' }] }} />
            <Icon name={p.icon} size={size * 0.42} color={o.fg} />
          </LinearGradient>
        </View>
      </Animated.View>
    </View>
  );
}

/** A compact quick action: icon tile above a short label. */
function Quick({ icon, label, tint, hint, onPress }: { icon: IconName; label: string; tint: string; hint: string; onPress: () => void }) {
  const press = usePressScale(0.94);
  return (
    <Animated.View style={[press.style, { flex: 1 }]}>
      <Pressable
        onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut}
        accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
        style={{ minHeight: 88, borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 }}
      >
        <IconTile icon={icon} tint={tint} size={42} />
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 12.5, fontWeight: '600', marginTop: 6 }}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

function Tile({ icon, label, say, onPress }: { icon: IconName; label: string; say: string; onPress: () => void }) {
  const press = usePressScale(0.92);
  return (
    <Animated.View style={press.style}>
      <Pressable
        onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut}
        accessibilityRole="button" accessibilityLabel={label} accessibilityHint={'Says: ' + say}
        style={{ width: 78, alignItems: 'center', minHeight: 92 }}
      >
        <IconTile icon={icon} tint={TILE_TINT[label] ?? C.card2} size={60} />
        <Text numberOfLines={2} style={{ color: C.text, fontSize: 13, fontWeight: '600', marginTop: 6, textAlign: 'center' }}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export default function Home(props: {
  voiceReady: boolean; connected: boolean; kycVerified: boolean; kycReady: boolean; balance: number | null;
  refresh: () => void; goTo: (screen: Screen, category?: Category) => void;
  /** A command to run as if spoken (e.g. the Profile "Complete KYC by voice" button). */
  command?: { text: string; n: number };
}) {
  const voice = useVoice();
  const pay = usePay();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [screenReader, setScreenReader] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showBalance, setShowBalance] = useState(false); // money is hidden until the user asks
  useEffect(() => {
    if (!showBalance) return;
    const t = setTimeout(() => setShowBalance(false), 8000);
    return () => clearTimeout(t);
  }, [showBalance]);
  const [scanAnnounce, setScanAnnounce] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const nextId = useRef(1);
  const run = useRef(0); // conversation token: bumping it cancels a running voice loop
  const silent = useRef(0);
  const patient = useRef(false);
  const expectRef = useRef<string | undefined>(undefined);
  const greeted = useRef(false);
  const bigTapRef = useRef<() => void>(() => {});
  const live = useRef({ handsFree: voice.settings.handsFree, props });
  live.current = { handsFree: voice.settings.handsFree, props };

  useEffect(() => { AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader); }, []);

  const add = useCallback((from: Msg['from'], t: string) => setMsgs((m) => [...m.slice(-30), { id: nextId.current++, from, text: t }]), []);
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60); }, [msgs]);

  const stopLoop = useCallback(() => { run.current++; }, []);

  /** Act on one agent reply: show it, navigate, pay, speak, and decide whether to keep listening. */
  const applyReply = useCallback(async (r: AgentReply, said: string, token: number, keepListening: boolean) => {
    const L = live.current;
    add('me', r.sensitive ? '••••' : said);
    add('agent', r.reply);
    setChoices(r.state === 'AWAITING_CHOICE' ? r.choices ?? [] : []);
    patient.current = !!r.sensitive && r.state === 'NEEDS_INFO';
    expectRef.current = r.expect;
    if (r.action?.type === 'navigate') L.props.goTo(r.action.screen, r.action.category);
    L.props.refresh();
    buzz(r.state === 'ERROR' ? 'warn' : 'success');

    const resume = () => { if (token === run.current && (L.handsFree || EXPECTS_ANSWER.has(r.state)) && keepListening) turn(token); };
    const done = (res: PayResult) => {
      L.props.refresh();
      if (res.status === 'cancelled') api.agent('cancel').catch(() => {}); // tell the agent the sheet was closed
      if (keepListening && L.handsFree) { run.current++; turn(run.current); }
    };

    if (r.state === 'AWAITING_CONFIRMATION' && r.pending) pay.show(r.pending, done, { onVoiceTap: () => bigTapRef.current() });
    await voice.speak(r.reply);
    if (token !== run.current) return;

    if (r.action?.type === 'stop_listening') { stopLoop(); return; }
    if (r.action?.type === 'scan_qr') { setScanAnnounce(false); setScanning(true); return; } // the camera speaks and finds the code
    if (r.action?.type === 'share') {
      skipNextLock();
      try { await Share.share({ message: r.action.text, title: r.action.title }); } catch {}
      if (token === run.current) resume();
      return;
    }
    if (r.state === 'CANCELLED') pay.dismiss();
    if (r.state === 'READY_TO_PAY' && r.pending) {
      if (r.route?.method === 'upi') pay.payUpi(r.pending, r.route.app, done);
      else pay.payGateway(r.pending, done, { auto: true });
      return; // the payment flow speaks the result, then `done` resumes listening
    }
    resume();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [add, pay, voice, stopLoop]);

  const fail = useCallback(async (e: unknown, token: number) => {
    if (token !== run.current) return;
    const msg = (e as Error).message || 'Something went wrong.';
    add('agent', msg);
    buzz('error');
    stopLoop(); // never loop on an error
    await voice.speak(`${msg} Tap anywhere to try again.`);
  }, [add, stopLoop, voice]);

  /** One turn of the conversation: listen → agent → reply. */
  const turn = useCallback(async (token: number) => {
    if (token !== run.current) return;
    try {
      const said = await voice.listen({ patient: patient.current, expect: expectRef.current });
      if (said === null || token !== run.current) return; // interrupted by a tap or by the payment screen
      if (!said) {
        silent.current++;
        if (silent.current >= 2) {
          silent.current = 0;
          voice.setPhase('idle');
          await voice.speak("I didn't hear anything. Tap anywhere on the circle when you want to talk.");
          return;
        }
        return turn(token); // one quiet retry
      }
      silent.current = 0;
      const r = await api.agent(said, api.takeLowConfidence());
      if (token !== run.current) return;
      await applyReply(r, said, token, true);
    } catch (e) {
      fail(e, token);
    }
  }, [voice, applyReply, fail]);

  const startTalking = useCallback(() => {
    if (!props.voiceReady) {
      add('agent', 'Voice needs the server to have a Groq key. You can type your command below.');
      voice.speak('Voice is not ready on the server. You can type your command instead.');
      return;
    }
    voice.halt();
    silent.current = 0;
    const token = ++run.current;
    turn(token);
  }, [props.voiceReady, voice, turn, add]);

  const onBigTap = useCallback(() => {
    if (voice.phase === 'listening') voice.finishListening(); // "I'm done speaking"
    else startTalking(); // idle, speaking (interrupt) or stuck thinking (start over)
  }, [voice, startTalking]);

  bigTapRef.current = onBigTap;

  async function sendText(t: string) {
    const q = t.trim();
    if (!q) return;
    setText('');
    voice.halt();
    const token = ++run.current;
    voice.setPhase('thinking');
    try {
      const r = await api.agent(q);
      await applyReply(r, q, token, false);
    } catch (e) { fail(e, token); }
  }

  /** Run a command as if it was spoken, then keep the conversation going by voice. */
  const runText = useCallback((text: string) => {
    voice.halt();
    const token = ++run.current;
    voice.setPhase('thinking');
    api.agent(text).then((r) => applyReply(r, text, token, true)).catch((e) => fail(e, token));
  }, [voice, applyReply, fail]);

  // A command handed over by another screen (e.g. Profile "Complete KYC by voice").
  const commandN = props.command?.n;
  useEffect(() => {
    if (props.command) runText(props.command.text);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandN]);

  /** A scanned QR code: the server checks it and asks for the amount / confirmation by voice. */
  const onQr = useCallback((link: string) => {
    setScanning(false);
    const token = ++run.current;
    voice.setPhase('thinking');
    api.payQr(link).then((r) => applyReply(r, 'Scanned a QR code', token, true)).catch((e) => fail(e, token));
  }, [voice, applyReply, fail]);

  const onQrClose = useCallback((reason: 'cancelled' | 'timeout' | 'denied') => {
    setScanning(false);
    (async () => {
      if (reason === 'cancelled') await voice.speak('Okay, camera closed.');
      if (live.current.handsFree && live.current.props.voiceReady) startTalking();
    })();
  }, [voice, startTalking]);

  // Greet once, as soon as the server answered and the data is loaded. Hands-free users then just talk.
  useEffect(() => {
    if (greeted.current || !voice.ready || !props.connected || props.balance === null || !props.kycReady) return;
    greeted.current = true;
    const token = ++run.current;
    const hello = props.kycVerified
      ? 'Welcome to VoicePay. What would you like to do? You can say help at any time.'
      : 'Welcome to VoicePay. Your KYC is not complete yet. Say start KYC and I will guide you, or say help.';
    add('agent', hello);
    (async () => {
      await voice.speak(hello);
      if (token === run.current && voice.settings.handsFree && props.voiceReady) turn(token);
    })();
  }, [voice.ready, props.connected, props.balance, props.kycVerified, props.kycReady, props.voiceReady, voice, add, turn]);

  const p = PHASE[voice.phase];
  const lastMe = [...msgs].reverse().find((m) => m.from === 'me');
  const lastAgent = [...msgs].reverse().find((m) => m.from === 'agent');
  const [stageH, setStageH] = useState(300);
  const [services, setServices] = useState(false);
  const orbSize = Math.max(130, Math.min(230, (stageH - 70) / 1.2));
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const go = (t: { label: string; say: string }) => {
    buzz('success');
    setServices(false);
    if (t.say === 'scan qr') { voice.halt(); run.current++; setScanAnnounce(true); setScanning(true); } else runText(t.say);
  };

  return (
    <View style={{ flex: 1 }}>
      {/* wallet (hidden while typing so the keyboard has room) */}
      {!typing && <LinearGradient colors={['#103A2C', '#0B2019', '#0F141A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={{ borderRadius: R.lg, marginBottom: S.sm, borderWidth: 1, borderColor: 'rgba(61,220,151,0.28)' }}>
        <View style={{ padding: S.md, paddingBottom: S.sm }}>
          <Text style={{ color: C.faint, fontSize: 13, fontWeight: '600' }}>{greet}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Pressable
              onPress={() => { buzz('success'); if (showBalance) setShowBalance(false); else { setShowBalance(true); if (props.balance !== null) voice.speak(`Your balance is ${inr(props.balance)}.`); } }}
              accessibilityRole="button"
              accessibilityLabel={showBalance && props.balance !== null ? `Wallet balance ${inr(props.balance)} rupees. Double tap to hide.` : 'Wallet balance is hidden. Double tap to show it.'}
              style={{ flex: 1, minHeight: 64, justifyContent: 'center' }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ color: C.sub, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 }}>WALLET BALANCE</Text>
                <Icon name={showBalance ? 'eye' : 'eye-off'} size={15} color={C.sub} />
              </View>
              <Text style={{ color: C.text, fontSize: 40, fontWeight: '800', letterSpacing: 0.2 }}>
                {props.balance === null ? '—' : showBalance ? inr(props.balance) : '₹ ••••••'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => { buzz('success'); const on = !voice.settings.handsFree; voice.update({ handsFree: on }); voice.speak(on ? 'Hands-free on. I will keep listening.' : 'Hands-free off. Tap to talk.'); if (!on) stopLoop(); }}
              accessibilityRole="switch"
              accessibilityState={{ checked: voice.settings.handsFree }}
              accessibilityLabel="Hands-free listening"
              accessibilityHint="Double tap to turn on or off"
              style={{ minHeight: 56, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: voice.settings.handsFree ? C.green : C.card2, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Icon name={voice.settings.handsFree ? 'ear' : 'ear-outline'} size={22} color={voice.settings.handsFree ? C.onGreen : C.text} />
              <Text style={{ color: voice.settings.handsFree ? C.onGreen : C.text, fontSize: 14, fontWeight: '700' }}>Hands-free {voice.settings.handsFree ? 'on' : 'off'}</Text>
            </Pressable>
          </View>
          <Text style={{ color: C.faint, fontSize: 12.5 }}>{showBalance ? 'Hides again in a few seconds' : 'Tap the amount to show it'}</Text>
        </View>
      </LinearGradient>}

      {/* the voice stage: the orb is the main control */}
      <Pressable
        onPress={onBigTap}
        onLayout={(e) => setStageH(e.nativeEvent.layout.height)}
        accessibilityRole="button"
        accessibilityLabel={p.label}
        accessibilityState={{ busy: voice.phase === 'thinking' }}
        style={{ flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center' }}
      >
        <Orb phase={voice.phase} size={orbSize} />
        <View style={{ marginTop: 2, backgroundColor: C.card2, borderRadius: R.pill, paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text accessibilityLiveRegion={screenReader ? 'none' : 'polite'} style={{ color: C.text, fontSize: 15.5, fontWeight: '600', textAlign: 'center' }}>{p.text}</Text>
        </View>
      </Pressable>

      {/* quick actions: the same commands you can say */}
      {!typing && <View style={{ flexDirection: 'row', gap: S.sm, marginBottom: S.sm }}>
        <Quick icon="arrow-up-circle" label="Send" tint={CATEGORY_TINT.transfer} hint="Says: send money" onPress={() => go({ label: 'Send money', say: 'send money' })} />
        <Quick icon="qr-code" label="Scan QR" tint="#5B6573" hint="Opens the camera to scan a shop QR code" onPress={() => go({ label: 'Scan QR', say: 'scan qr' })} />
        <Quick icon="receipt" label="Bills" tint={CATEGORY_TINT.electricity} hint="Opens the bills screen" onPress={() => { buzz('success'); props.goTo('bills'); }} />
        <Quick icon="add-circle" label="Top up" tint={CATEGORY_TINT.topup} hint="Says: add money" onPress={() => go({ label: 'Add money', say: 'add money' })} />
        <Quick icon="apps" label="More" tint="#3D4654" hint="Shows all services" onPress={() => { buzz('success'); setServices(true); }} />
      </View>}

      {/* the conversation, like a chat */}
      <View style={{ maxHeight: 190 }}>
        <ScrollView ref={scroll} showsVerticalScrollIndicator={false}>
          {lastMe && (
            <View style={{ alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: C.greenTint, borderRadius: R.lg, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 9, marginBottom: 6 }}>
              <Text style={{ color: C.green, fontSize: 16, fontWeight: '600' }}>{lastMe.text}</Text>
            </View>
          )}
          {lastAgent && (
            <View style={{ alignSelf: 'flex-start', maxWidth: '94%', backgroundColor: C.card, borderRadius: R.lg, borderBottomLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 11, borderWidth: 1, borderColor: C.line }}>
              <Text accessibilityLiveRegion={screenReader ? 'none' : 'polite'} style={{ color: C.text, fontSize: 17, fontWeight: '500', lineHeight: 24 }}>{lastAgent.text}</Text>
            </View>
          )}
          {choices.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: S.sm }}>
              {choices.map((c) => <Chip key={c.id} text={c.name} onPress={() => sendText(c.name)} />)}
            </View>
          )}
        </ScrollView>
      </View>

      {/* typing is for helpers / quiet places */}
      {typing ? (
        <View style={{ marginTop: S.sm, marginBottom: S.lg }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: S.sm }}>
            {SUGGESTIONS.map((t) => <Chip key={t} text={t} onPress={() => sendText(t)} />)}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <TextInput
              autoFocus
              value={text} onChangeText={setText} placeholder="Type a command…" placeholderTextColor={C.faint}
              onSubmitEditing={() => sendText(text)} returnKeyType="send" accessibilityLabel="Type a command"
              style={{ flex: 1, backgroundColor: C.card2, color: C.text, borderRadius: R.pill, paddingHorizontal: S.lg, paddingVertical: 12, fontSize: 17, minHeight: 56, fontFamily: 'Inter_500Medium' }}
            />
            <IconBtn icon="send" label="Send command" onPress={() => sendText(text)} />
            <IconBtn icon="close" label="Hide keyboard" onPress={() => setTyping(false)} />
          </View>
        </View>
      ) : (
        <View style={{ alignItems: 'center' }}>
          <Pressable onPress={() => setTyping(true)} accessibilityRole="button" accessibilityLabel="Type a command instead" hitSlop={8}
            style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: S.md, flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Icon name="keypad" size={18} color={C.faint} />
            <Text style={{ color: C.faint, fontSize: 15, fontWeight: '500' }}>Type instead</Text>
          </Pressable>
        </View>
      )}

      {/* every service */}
      <Modal visible={services} transparent animationType="slide" onRequestClose={() => setServices(false)}>
        <View accessibilityViewIsModal style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: C.scrim }}>
          <Pressable style={{ flex: 1 }} onPress={() => setServices(false)} accessibilityRole="button" accessibilityLabel="Close services" />
          <View style={{ backgroundColor: C.card, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, paddingHorizontal: S.md, paddingBottom: S.lg, maxHeight: '78%' }}>
            <View accessible={false} importantForAccessibility="no" style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.outline, marginTop: S.sm, marginBottom: S.sm }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: S.sm }}>
              <Text accessibilityRole="header" style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>All services</Text>
              <IconBtn icon="close" label="Close" size={48} onPress={() => setServices(false)} />
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {TILES.map((t) => (
                  <View key={t.label} style={{ width: '25%', alignItems: 'center', marginBottom: S.md }}>
                    <Tile icon={t.icon} label={t.label} say={t.say} onPress={() => go(t)} />
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <QrScanner visible={scanning} announce={scanAnnounce} onResult={onQr} onClose={onQrClose} />
    </View>
  );
}
