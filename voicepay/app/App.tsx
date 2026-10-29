import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import Constants from 'expo-constants';
import { api, getBase, type Category, type Kyc, type Screen } from './src/api';
import { PayProvider } from './src/PayFlow';
import { VoiceProvider, useVoice } from './src/voice';
import { C, F, R, S, type IconName } from './src/theme';
import { Text, Btn, Icon, tick } from './src/ui';
import LockGate from './src/LockGate';
import AuthGate from './src/AuthGate';
import Home from './src/screens/Home';
import Bills from './src/screens/Bills';
import Contacts from './src/screens/Contacts';
import History from './src/screens/History';
import Profile from './src/screens/Profile';

const TABS: Array<{ id: Screen; icon: IconName; label: string }> = [
  { id: 'home', icon: 'mic', label: 'Voice' },
  { id: 'bills', icon: 'receipt', label: 'Bills' },
  { id: 'contacts', icon: 'people', label: 'Contacts' },
  { id: 'history', icon: 'time', label: 'History' },
  { id: 'profile', icon: 'person', label: 'Profile' },
];

export default function App() {
  const [fontsReady] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  return (
    <VoiceProvider>
      <PayProvider>
        <LockGate>
          <AuthGate>
            <Shell />
          </AuthGate>
        </LockGate>
      </PayProvider>
    </VoiceProvider>
  );
}

function Shell() {
  const voice = useVoice();
  const [tab, setTab] = useState<Screen>('home');
  const [health, setHealth] = useState<{ llm: boolean; gateway: string; real?: boolean } | null>(null);
  const [connErr, setConnErr] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [kyc, setKyc] = useState<Kyc | null>(null);
  const [tickN, setTickN] = useState(0);
  const [billsCat, setBillsCat] = useState<{ cat: Category; n: number } | undefined>();
  const [command, setCommand] = useState<{ text: string; n: number } | undefined>();
  const spokenErr = useRef('');
  const [kbOpen, setKbOpen] = useState(false); // the tab bar steps aside while the keyboard is up
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKbOpen(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKbOpen(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  const refresh = useCallback(() => {
    api.refreshVocab();
    api.wallet().then((w) => setBalance(w.balance)).catch(() => {});
    api.kyc().then((r) => setKyc(r.kyc)).catch(() => {});
    setTickN((t) => t + 1);
  }, []);

  const connect = useCallback(() => {
    setConnErr('');
    api.health().then((h) => { setHealth(h); voice.setServerTts(!!h.tts); api.refreshVocab(); refresh(); }).catch((e) => { setHealth(null); setConnErr(e.message); });
  }, [refresh]);

  useEffect(connect, [connect]);

  // A blind user cannot see the red banner: say it once.
  useEffect(() => {
    if (connErr && spokenErr.current !== connErr) {
      spokenErr.current = connErr;
      voice.speak(`${connErr} Tap Retry, or ask a friend to check the server address in Profile.`);
    }
  }, [connErr, voice]);

  /** Switch screen. Voice already speaks the reply, so only announce for screen-reader taps. */
  const goTo = useCallback((screen: Screen, announce = false) => {
    setTab(screen);
    if (announce) AccessibilityInfo.announceForAccessibility(`${TABS.find((t) => t.id === screen)?.label} screen`);
  }, []);

  /** Run a command as if it was spoken (used by the Profile "Complete KYC by voice" button). */
  const runCommand = useCallback((text: string) => {
    setTab('home');
    setCommand((c) => ({ text, n: (c?.n ?? 0) + 1 }));
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.bg, paddingTop: Constants.statusBarHeight + S.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.md, marginBottom: S.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="mic" size={22} color={C.onGreen} />
            </View>
            <Text accessibilityRole="header" style={{ color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 }}>VoicePay</Text>
          </View>
          {!health?.real && (
          <View accessible accessibilityLabel={kyc?.status === 'verified' ? 'KYC verified' : 'KYC pending'}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: kyc?.status === 'verified' ? C.greenTint : 'rgba(255,214,10,0.16)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: R.pill }}>
            <Icon name={kyc?.status === 'verified' ? 'shield-checkmark' : 'alert-circle'} size={20} color={kyc?.status === 'verified' ? C.green : C.amber} />
            <Text style={{ color: kyc?.status === 'verified' ? C.green : C.amber, fontSize: F.small + 1, fontWeight: '700' }}>
              {kyc?.status === 'verified' ? 'KYC verified' : 'KYC pending'}
            </Text>
          </View>
          )}
        </View>

        {connErr ? (
          <View accessibilityRole="alert" style={{ marginHorizontal: S.md, marginBottom: S.sm, padding: S.md, borderRadius: R.md, backgroundColor: '#450a0a', borderWidth: 2, borderColor: C.red }}>
            <Text style={{ color: C.text, fontSize: F.body, marginBottom: S.sm }}>{connErr}</Text>
            <Text style={{ color: C.sub, fontSize: F.small, marginBottom: S.sm }}>Trying: {getBase()}</Text>
            <Btn title="Retry" icon="refresh" onPress={connect} />
            <Btn title="Change server address" kind="ghost" onPress={() => { setConnErr(''); goTo('profile'); }} style={{ marginTop: S.sm }} />
          </View>
        ) : null}

        <View style={{ flex: 1, paddingHorizontal: S.md }}>
          {/* Home stays mounted so the voice conversation survives screen changes. */}
          <View style={{ flex: 1, display: tab === 'home' ? 'flex' : 'none' }}>
            <Home voiceReady={!!health?.llm} connected={!!health} kycVerified={kyc?.status === 'verified' || !!health?.real} kycReady={kyc !== null} balance={balance} refresh={refresh} goTo={(s, cat) => { if (cat) setBillsCat((b) => ({ cat, n: (b?.n ?? 0) + 1 })); goTo(s); }} command={command} />
          </View>
          {tab === 'bills' && <Bills refresh={refresh} startCat={billsCat} />}
          {tab === 'contacts' && <Contacts refresh={refresh} />}
          {tab === 'history' && <History tick={tickN} />}
          {tab === 'profile' && <Profile kyc={kyc} onKyc={(k) => { setKyc(k); refresh(); }} health={health} reconnect={connect} refresh={refresh} runCommand={runCommand} />}
        </View>

        {!kbOpen && <View accessibilityRole="tablist" style={{
          flexDirection: 'row', backgroundColor: C.glass, borderRadius: R.xl, marginHorizontal: S.md, marginBottom: Platform.OS === 'ios' ? 22 : S.md, marginTop: S.xs,
          padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: C.outline,
        }}>
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => { tick(); goTo(t.id, true); }}
                style={{ flex: 1, alignItems: 'center', minHeight: 60, justifyContent: 'center', borderRadius: R.lg, backgroundColor: on ? C.greenTint : 'transparent' }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t.label}
              >
                <Icon name={t.icon} size={26} color={on ? C.green : C.sub} />
                <Text numberOfLines={1} style={{ color: on ? C.green : C.sub, fontSize: 12.5, marginTop: 2, fontWeight: on ? '700' : '500' }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>}
      </KeyboardAvoidingView>
    </>
  );
}
