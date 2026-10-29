import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { authConfigured, loadSession, onSession, signIn, signUp, type Session } from './auth';
import { Btn, Card, ErrorText, Field, Icon, Sub, Text } from './ui';
import { C, F, R, S } from './theme';

/** Shows the app only after sign-in. Without Supabase settings (local development) it lets everything through. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!authConfigured);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!authConfigured) return;
    const off = onSession(setSession);
    loadSession().finally(() => setReady(true));
    return off;
  }, []);

  if (!authConfigured) return <>{children}</>;
  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center' }}><ActivityIndicator color={C.green} size="large" /></View>;
  return session ? <>{children}</> : <SignIn />;
}

function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setNote(''); setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else if (!(await signUp(email, password))) { setNote('Account created. Open the email we sent, confirm it, then sign in.'); setMode('in'); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= 6;
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.bg, paddingTop: Constants.statusBarHeight + S.lg }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: S.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: S.lg }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="mic" size={26} color={C.onGreen} />
          </View>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: 32, fontWeight: '800' }}>VoicePay</Text>
        </View>
        <Card>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.xs }}>
            {mode === 'in' ? 'Sign in' : 'Create your account'}
          </Text>
          <Sub style={{ marginBottom: S.md }}>Your contacts and payment history are saved to your own account.</Sub>
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" hint="At least 6 characters" />
          {err ? <ErrorText>{err}</ErrorText> : null}
          {note ? <Text accessibilityRole="alert" style={{ color: C.green, fontSize: F.body, marginBottom: S.sm }}>{note}</Text> : null}
          <Btn title={mode === 'in' ? 'Sign in' : 'Create account'} busy={busy} disabled={!valid} onPress={submit} />
          <Btn
            title={mode === 'in' ? 'New here? Create an account' : 'I already have an account'}
            kind="ghost" style={{ marginTop: S.sm }}
            onPress={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); setNote(''); }}
          />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
