import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import * as ExpoContacts from 'expo-contacts';
import { api, type Contact } from '../api';
import { usePay } from '../PayFlow';
import { Text, Btn, Card, Chip, ErrorText, Field, H, Icon, IconBtn, Sub, tick } from '../ui';
import { C, F, R, S } from '../theme';

export default function Contacts({ refresh }: { refresh: () => void }) {
  const [list, setList] = useState<Contact[]>([]);
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [upiId, setUpiId] = useState('');
  const [type, setType] = useState<'person' | 'merchant'>('person');
  const [err, setErr] = useState('');
  const [payFor, setPayFor] = useState<Contact | null>(null);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneBook, setPhoneBook] = useState<Array<{ id: string; name: string; phone: string }> | null>(null);
  const [q, setQ] = useState('');
  const pay = usePay();

  const load = () => api.contacts().then((r) => setList(r.contacts)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function add() {
    setErr('');
    try {
      await api.addContact({ name, nickname: nickname || undefined, upiId, type, phone: /^[6-9]\d{9}$/.test(phone) ? phone : undefined });
      setName(''); setNickname(''); setUpiId(''); setPhone('');
      load();
    } catch (e) { setErr((e as Error).message); }
  }

  /** Opens the phone's contact list so you pick a person instead of typing the name. */
  async function openPhoneBook() {
    setErr('');
    try {
      const perm = await ExpoContacts.requestPermissionsAsync();
      if (perm.status !== 'granted') { setErr('Contacts permission is off. Allow it in the phone settings, or type the name below.'); return; }
      const { data } = await ExpoContacts.getContactsAsync({ fields: [ExpoContacts.Fields.PhoneNumbers], sort: ExpoContacts.SortTypes.FirstName });
      const rows = data.flatMap((c) => {
        const num = (c.phoneNumbers ?? []).map((p) => String(p.number ?? '').replace(/\D/g, '').slice(-10)).find((n) => /^[6-9]\d{9}$/.test(n));
        return c.name && num ? [{ id: String(c.id), name: c.name, phone: num }] : [];
      });
      if (!rows.length) setErr('No contacts with a mobile number were found on this phone.');
      setPhoneBook(rows); setQ('');
    } catch (e) { setErr((e as Error).message); }
  }

  function pickFromPhone(p: { name: string; phone: string }) {
    tick();
    setName(p.name); setNickname(p.name.split(' ')[0]); setPhone(p.phone); setType('person'); setPhoneBook(null);
  }

  async function startPay() {
    if (!payFor) return;
    setErr('');
    try {
      const r = await api.preparePay(payFor.id, Number(amount));
      setPayFor(null); setAmount('');
      if (r.pending) pay.show(r.pending, () => refresh());
    } catch (e) { setErr((e as Error).message); }
  }

  const confirmDelete = (c: Contact) =>
    Alert.alert('Delete contact?', c.name, [{ text: 'Cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => { await api.deleteContact(c.id).catch(() => {}); load(); } }]);

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <H>Contacts & shops</H>
      {err ? <ErrorText>{err}</ErrorText> : null}
      <Card>
        {list.map((c) => (
          <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: C.line, paddingVertical: S.xs }}>
            <Pressable
              onPress={() => { tick(); setPayFor(c); setAmount(''); }}
              accessibilityRole="button"
              accessibilityLabel={`${c.name}, ${c.type === 'merchant' ? 'shop' : 'person'}. Double tap to pay.`}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 64 }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.type === 'merchant' ? '#422006' : '#172554', alignItems: 'center', justifyContent: 'center', marginRight: S.md }}>
                {c.type === 'merchant' ? <Icon name="storefront" size={22} color={C.amber} /> : <Text style={{ color: C.text, fontWeight: '800', fontSize: F.body }}>{c.name[0]}</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text, fontWeight: '700', fontSize: F.body }}>{c.name}{c.nickname ? <Text style={{ color: C.sub }}>  ({c.nickname})</Text> : null}</Text>
                <Text style={{ color: C.sub, fontSize: F.small }}>{c.upiId}</Text>
              </View>
            </Pressable>
            <IconBtn icon="trash" label={`Delete ${c.name}`} size={48} onPress={() => confirmDelete(c)} />
          </View>
        ))}
        {list.length === 0 && <Sub>No contacts yet.</Sub>}
        <Text style={{ color: C.faint, fontSize: F.small, marginTop: S.sm }}>Tap a contact to pay. By voice, say "send 500 to {list[0]?.nickname ?? list[0]?.name ?? 'Ramesh'}".</Text>
      </Card>

      {payFor && (
        <Card style={{ borderColor: C.green, borderWidth: 2 }}>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Pay {payFor.name}</Text>
          <Field label="Amount in rupees" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" autoFocus />
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Btn title="Cancel" kind="ghost" onPress={() => setPayFor(null)} style={{ flex: 1 }} />
            <Btn title="Continue" disabled={!(Number(amount) > 0)} onPress={startPay} style={{ flex: 1 }} />
          </View>
        </Card>
      )}

      <Card>
        <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Add contact or shop</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Chip text="Person" icon="person" active={type === 'person'} onPress={() => setType('person')} />
          <Chip text="Shop / merchant" icon="storefront" active={type === 'merchant'} onPress={() => setType('merchant')} />
        </View>
        <Btn title="Pick from phone contacts" icon="people" kind="ghost" onPress={openPhoneBook} style={{ marginBottom: S.md }} />
        {phoneBook && (
          <View style={{ marginBottom: S.md }}>
            <Field label="Search your contacts" value={q} onChangeText={setQ} autoFocus />
            <ScrollView nestedScrollEnabled style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
              {phoneBook.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.phone.includes(q.trim())).slice(0, 60).map((p) => (
                <Pressable key={p.id + p.phone} onPress={() => pickFromPhone(p)} accessibilityRole="button" accessibilityLabel={`${p.name}, ${p.phone.split('').join(' ')}`}
                  style={{ minHeight: 56, justifyContent: 'center', borderBottomWidth: 1, borderColor: C.line }}>
                  <Text style={{ color: C.text, fontWeight: '700', fontSize: F.body }}>{p.name}</Text>
                  <Text style={{ color: C.sub, fontSize: F.small }}>{p.phone}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Btn title="Close list" kind="ghost" onPress={() => setPhoneBook(null)} style={{ marginTop: S.sm }} />
          </View>
        )}
        <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Ramesh Kumar" />
        {phone ? <Sub style={{ marginBottom: S.md }}>Mobile: {phone} (saved so "send 500 to {phone}" finds this person)</Sub> : null}
        <Field label="Nickname (optional, for voice)" value={nickname} onChangeText={setNickname} placeholder="e.g. Ramesh" />
        <Field label="UPI ID" value={upiId} onChangeText={setUpiId} autoCapitalize="none" placeholder="name@okaxis" hint="Find it in their GPay or PhonePe profile, or on the shop's QR sticker." />
        <Btn title="Add" icon="add" onPress={add} disabled={!name || !upiId} />
      </Card>
      <View style={{ height: S.lg }} />
    </ScrollView>
  );
}
