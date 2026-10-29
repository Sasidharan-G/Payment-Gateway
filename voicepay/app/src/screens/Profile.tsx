import React, { useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { api, getBase, setBase, type Kyc } from '../api';
import { currentSession, signOut } from '../auth';
import { useVoice } from '../voice';
import { Text, Btn, Card, Chip, ErrorText, Field, H, Icon, Sub } from '../ui';
import { C, F, S } from '../theme';

export default function Profile(props: {
  kyc: Kyc | null; onKyc: (k: Kyc) => void; health: { llm: boolean; gateway: string; real?: boolean } | null;
  reconnect: () => void; refresh: () => void; runCommand: (text: string) => void;
}) {
  const voice = useVoice();
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [pan, setPan] = useState('');
  const [aadhaar, setAadhaar] = useState('');
  const [mobile, setMobile] = useState('');
  const [session, setSession] = useState<{ id: string; mobile: string; demoOtp: string } | null>(null);
  const [otp, setOtp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(getBase());

  async function start() {
    setErr(''); setBusy(true);
    try {
      const r = await api.kycStart({ name, dob, pan, aadhaar, mobile });
      setSession({ id: r.sessionId, mobile: r.mobileMasked, demoOtp: r.demoOtp });
    } catch (e) { setErr((e as Error).message); voice.speak((e as Error).message); } finally { setBusy(false); }
  }
  async function verify() {
    if (!session) return;
    setErr(''); setBusy(true);
    try {
      const r = await api.kycVerify(session.id, otp);
      props.onKyc(r.kyc);
      voice.speak('KYC complete. You can now make payments.');
      setSession(null); setAadhaar(''); setPan(''); setOtp('');
    } catch (e) {
      const m = (e as Error).message;
      setErr(m); voice.speak(m);
      if (/start again/i.test(m)) { setSession(null); setOtp(''); }
    } finally { setBusy(false); }
  }

  const k = props.kyc;
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <H>Profile & settings</H>

      <Card>
        <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Voice</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 }}>
          <View style={{ flex: 1, paddingRight: S.md }}>
            <Text style={{ color: C.text, fontSize: F.body, fontWeight: '700' }}>Hands-free</Text>
            <Sub style={{ fontSize: F.small }}>Keeps listening after each answer. The screen stays on.</Sub>
          </View>
          <Switch
            value={voice.settings.handsFree}
            onValueChange={(v) => voice.update({ handsFree: v })}
            accessibilityLabel="Hands-free listening"
            trackColor={{ false: C.outline, true: C.green }}
            thumbColor={C.text}
          />
        </View>
        {voice.serverTts && (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, marginTop: S.md }}>
            <View style={{ flex: 1, paddingRight: S.md }}>
              <Text style={{ color: C.text, fontSize: F.body, fontWeight: '700' }}>Natural voice (beta)</Text>
              <Sub style={{ fontSize: F.small }}>A more human voice. If it is slow or fails, the phone voice is used.</Sub>
            </View>
            <Switch
              value={!!voice.settings.neuralVoice}
              onValueChange={(v) => { voice.update({ neuralVoice: v }); setTimeout(() => voice.speak(v ? 'Natural voice on.' : 'Phone voice on.'), 100); }}
              accessibilityLabel="Natural voice"
              trackColor={{ false: C.outline, true: C.green }}
              thumbColor={C.text}
            />
          </View>
        )}
        <Text style={{ color: C.text, fontSize: F.body, fontWeight: '700', marginTop: S.md, marginBottom: S.sm }}>Reply language</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {([['English', 'en'], ['Tanglish', 'tg'], ['தமிழ்', 'ta']] as const).map(([label, code]) => (
            <Chip key={code} text={label} active={(voice.settings.replyLang ?? 'tg') === code}
              onPress={() => { voice.update({ replyLang: code }); voice.speak(code === 'en' ? 'I will reply in English.' : code === 'ta' ? 'இனி தமிழில் பதில் சொல்கிறேன்.' : 'Ini Tanglish la pesuren.'); }} />
          ))}
        </View>
        <Text style={{ color: C.text, fontSize: F.body, fontWeight: '700', marginTop: S.md, marginBottom: S.sm }}>Speaking speed</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {([['Slow', 0.8], ['Normal', 1], ['Fast', 1.25]] as const).map(([label, rate]) => (
            <Chip key={label} text={label} active={voice.settings.speechRate === rate}
              onPress={() => { voice.update({ speechRate: rate }); voice.speak(`${label} speed.`); }} />
          ))}
        </View>
      </Card>

      {currentSession() ? (
        <Card>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Account</Text>
          <Sub>Signed in as {currentSession()?.email}</Sub>
          <Sub style={{ marginTop: S.xs }}>Demo mode: the wallet and payments are simulated.</Sub>
          <Btn title="Sign out" kind="ghost" style={{ marginTop: S.md }} onPress={() => Alert.alert('Sign out?', 'You will need your email and password to sign in again.', [{ text: 'Cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => { signOut(); } }])} />
        </Card>
      ) : null}

      {props.health?.real ? null : k?.status === 'verified' ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Icon name="shield-checkmark" size={28} color={C.green} />
            <Text style={{ color: C.green, fontWeight: '800', fontSize: F.h2 }}>KYC verified</Text>
          </View>
          <Sub style={{ marginTop: S.sm }}>Name: {k.name}</Sub>
          <Sub>Date of birth: {k.dob}</Sub>
          <Sub>PAN: {k.panMasked}</Sub>
          <Sub>Aadhaar: XXXX XXXX {k.aadhaarLast4}</Sub>
          <Sub>Mobile: {k.mobile}</Sub>
          <Text style={{ color: C.faint, fontSize: F.small, marginTop: S.sm }}>Full Aadhaar and PAN are never stored.</Text>
        </Card>
      ) : !session ? (
        <>
          <Card>
            <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>KYC by voice</Text>
            <Sub style={{ marginBottom: S.md }}>I ask for your name, date of birth, PAN, Aadhaar and mobile number one by one. Nothing you say is shown on screen.</Sub>
            <Btn title="Complete KYC by voice" icon="mic" onPress={() => props.runCommand('start KYC')} />
          </Card>
          <Card>
            <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Or type your details</Text>
            <Field label="Full name (as on PAN)" value={name} onChangeText={setName} autoCapitalize="words" />
            <Field label="Date of birth" value={dob} onChangeText={setDob} placeholder="YYYY-MM-DD" hint="You must be 18 or older" maxLength={10} />
            <Field label="PAN" value={pan} onChangeText={(t) => setPan(t.toUpperCase())} autoCapitalize="characters" placeholder="ABCPE1234F" maxLength={10} />
            <Field label="Aadhaar number" value={aadhaar} onChangeText={setAadhaar} keyboardType="number-pad" maxLength={14} secureTextEntry hint="Checked with the official Verhoeff checksum. Only the last 4 digits are kept." />
            <Field label="Mobile number" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" maxLength={10} />
            <Btn title="Send OTP" busy={busy} disabled={!name || !dob || !pan || !aadhaar || !mobile} onPress={start} />
          </Card>
        </>
      ) : (
        <Card>
          <Sub>Enter the OTP sent to {session.mobile}</Sub>
          <Text style={{ color: C.amber, fontSize: F.body, marginVertical: S.sm, fontWeight: '700' }}>Demo mode (no SMS gateway): your OTP is {session.demoOtp}</Text>
          <Field label="OTP" value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} autoFocus />
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Btn title="Back" kind="ghost" onPress={() => { setSession(null); setOtp(''); }} style={{ flex: 1 }} />
            <Btn title="Verify" busy={busy} disabled={otp.length !== 6} onPress={verify} style={{ flex: 1 }} />
          </View>
        </Card>
      )}
      {err ? <ErrorText>{err}</ErrorText> : null}

      {props.health?.real ? null : <Card>
        <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Server</Text>
        <Text style={{ color: C.sub, fontSize: F.body }}>
          {props.health ? `Connected. Voice and AI: ${props.health.llm ? 'on' : 'off, the server needs a Groq key'}. Gateway: ${props.health.gateway}.` : 'Not connected.'}
        </Text>
        <View style={{ height: S.md }} />
        <Field label="Server address" value={server} onChangeText={setServer} autoCapitalize="none" keyboardType="url" hint="Only change this if a helper tells you to." />
        <Btn title="Save and reconnect" kind="ghost" onPress={() => { setBase(server); voice.update({ server: server.trim() }); props.reconnect(); }} />
        <Btn title="Reset demo data" kind="danger" style={{ marginTop: S.sm }} onPress={() =>
          Alert.alert('Reset demo data?', 'Balance, contacts, saved bills, KYC and history go back to the start.', [
            { text: 'Cancel' }, { text: 'Reset', style: 'destructive', onPress: async () => { await api.reset().catch(() => {}); props.reconnect(); props.refresh(); } },
          ])} />
      </Card>}
      <View style={{ height: S.lg }} />
    </ScrollView>
  );
}
