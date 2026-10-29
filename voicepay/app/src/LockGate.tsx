// App lock. VoicePay opens only after the phone's own security check, biometrics first:
// fingerprint or face (whichever the phone has set up), and the phone PIN / pattern / password otherwise.
// If the phone has a fingerprint / face sensor that was never set up, the app says so and offers the settings.
// It locks again when the app has been in the background for a minute, so an unattended phone never shows money.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Text, Btn, Icon } from './ui';
import { useVoice } from './voice';
import { planAuth, type AuthPlan } from './authPlan';
import { C, F, R, S } from './theme';

const GRACE_MS = 60_000;

// Screens that leave the app on purpose (UPI app, share sheet) must not trigger the lock on return.
let skipNext = false;
export const skipNextLock = () => { skipNext = true; };

export async function readPlan(): Promise<AuthPlan> {
  const [hasHardware, types, biometricEnrolled, level] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => [] as number[]),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    LocalAuthentication.getEnrolledLevelAsync().catch(() => 1),
  ]);
  return planAuth({ hasHardware, types: types as number[], biometricEnrolled, level: level as number });
}

export default function LockGate({ children }: { children: React.ReactNode }) {
  const voice = useVoice();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [locked, setLocked] = useState(true);
  const [opened, setOpened] = useState(false); // the app itself is mounted only after the first unlock
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [plan, setPlan] = useState<AuthPlan | null>(null);
  const asking = useRef(false);
  const leftAt = useRef<number | null>(null);
  const told = useRef('');

  const unlock = useCallback(async (first = false) => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    try {
      const p = await readPlan();
      setPlan(p);
      // Say what is going to happen once per kind of situation (not on every retry).
      if (told.current !== p.mode && (p.mode === 'setup_then_pin' || p.mode === 'none')) {
        told.current = p.mode;
        voiceRef.current.speak(p.say);
      }
      if (p.mode === 'none') { setLocked(false); setOpened(true); return; }
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock VoicePay',
        cancelLabel: 'Cancel',
        fallbackLabel: 'Use passcode',
        // Biometric first. The phone PIN stays available inside the prompt (and is the only way if there is no sensor).
        disableDeviceFallback: false,
      });
      if (r.success) {
        setMsg('');
        setLocked(false);
        setOpened(true);
      } else {
        const cancelled = r.error === 'user_cancel' || r.error === 'system_cancel' || r.error === 'app_cancel';
        const m = cancelled
          ? `VoicePay is locked. Double tap ${p.button}.`
          : r.error === 'lockout' ? 'Too many tries. Wait a little, or use your phone PIN. Then double tap Unlock.'
          : `That did not work. Double tap ${p.button} to try again.`;
        setMsg(m);
        if (!(first && cancelled)) voiceRef.current.speak(m);
      }
    } catch {
      setMsg('Could not open the phone security check. Double tap Unlock to try again.');
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => { unlock(true); }, [unlock]);

  // lock again after a minute away
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') leftAt.current = Date.now();
      if (st === 'active' && leftAt.current !== null) {
        const away = Date.now() - leftAt.current;
        leftAt.current = null;
        if (skipNext) { skipNext = false; return; }
        if (away > GRACE_MS) {
          voiceRef.current.halt();
          setLocked(true);
          unlock();
        }
      }
    });
    return () => sub.remove();
  }, [unlock]);

  const openSecuritySettings = () => {
    Linking.sendIntent('android.settings.SECURITY_SETTINGS').catch(() => Linking.openSettings().catch(() => {}));
  };

  const icon = plan?.kind === 'face' ? 'scan' : plan?.mode === 'pin' || plan?.mode === 'setup_then_pin' ? 'keypad' : 'finger-print';

  return (
    <View style={{ flex: 1 }}>
      {opened ? children : null}
      {locked && (
        <View
          accessibilityViewIsModal
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: S.lg }}
        >
          <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: C.greenTint, alignItems: 'center', justifyContent: 'center', marginBottom: S.lg }}>
            <Icon name="lock-closed" size={56} color={C.green} />
          </View>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h1, fontWeight: '800', textAlign: 'center' }}>VoicePay is locked</Text>
          <Text style={{ color: C.sub, fontSize: F.body, textAlign: 'center', marginTop: S.sm, marginBottom: S.lg }}>
            {msg || plan?.say || 'Use your fingerprint, face, or the PIN you use to open this phone.'}
          </Text>
          <Btn title={plan?.button ?? 'Unlock'} icon={icon} busy={busy} onPress={() => unlock()} style={{ alignSelf: 'stretch', borderRadius: R.xl }} />
          {plan?.mode === 'setup_then_pin' && (
            <Btn title={`Set up ${plan.kind} unlock`} icon="settings" kind="ghost" onPress={openSecuritySettings} style={{ alignSelf: 'stretch', marginTop: S.sm, borderRadius: R.xl }} />
          )}
        </View>
      )}
    </View>
  );
}
