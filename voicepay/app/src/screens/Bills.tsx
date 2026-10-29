import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { api, inr, type Bill, type Biller, type Category, type SavedBill } from '../api';
import { usePay } from '../PayFlow';
import { useVoice } from '../voice';
import { Text, Btn, Card, Chip, ErrorText, Field, H, IconBtn, Sub, tick, IconTile } from '../ui';
import { C, CATEGORY_ICON, CATEGORY_LABEL as LABEL, CATEGORY_TINT, F, R, S } from '../theme';

const CATS: Category[] = ['electricity', 'water', 'mobile', 'postpaid', 'dth', 'gas', 'broadband', 'fastag', 'creditcard', 'insurance', 'loan', 'tax'];
const SHORT: Partial<Record<Category, string>> = { mobile: 'Recharge', dth: 'DTH', gas: 'Gas', creditcard: 'Card', insurance: 'Insurance', broadband: 'Broadband', electricity: 'Electric' };
const PROVIDER: Partial<Record<Category, string>> = { electricity: 'Electricity board', gas: 'Gas provider', water: 'Water board', tax: 'Municipal corporation', creditcard: 'Card issuer', insurance: 'Insurer', loan: 'Lender', fastag: 'FASTag issuer' };

export default function Bills({ refresh, startCat }: { refresh: () => void; startCat?: { cat: Category; n: number } }) {
  const [billers, setBillers] = useState<Biller[]>([]);
  const [saved, setSaved] = useState<SavedBill[]>([]);
  const [cat, setCat] = useState<Category>('electricity');
  const [billerId, setBillerId] = useState('');
  const [account, setAccount] = useState('');
  const [nickname, setNickname] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [alreadyPaid, setAlreadyPaid] = useState<string | null>(null);
  const [plan, setPlan] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedSel, setSavedSel] = useState<string | null>(null); // bill on screen came from this saved account
  const pay = usePay();
  const voice = useVoice();

  const load = () => {
    api.billers().then((r) => setBillers(r.billers)).catch((e) => setErr(e.message));
    api.savedBills().then((r) => setSaved(r.saved)).catch(() => {});
  };
  useEffect(load, []);

  const list = useMemo(() => billers.filter((b) => b.category === cat), [billers, cat]);
  const biller = billers.find((b) => b.id === billerId) ?? null;
  const accountOk = biller ? new RegExp(biller.accountPattern).test(account.replace(/\s+/g, '').toUpperCase()) : false;

  useEffect(() => { if (startCat) reset(startCat.cat); }, [startCat?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset(c: Category) { setSavedSel(null); setCat(c); setBillerId(''); setAccount(''); setBill(null); setPlan(null); setErr(''); setAlreadyPaid(null); }

  async function fetchIt(input: { savedBillId?: string; billerId?: string; account?: string }) {
    setBusy(true); setErr(''); setBill(null); setPlan(null); setAlreadyPaid(null);
    try {
      const r = await api.fetchBill(input);
      setBill(r.bill);
      const name = billers.find((b) => b.id === r.bill.billerId)?.name ?? 'Bill';
      if (r.alreadyPaid) {
        const m = `Already paid on ${new Date(r.alreadyPaid.at).toLocaleDateString('en-IN')} (ref ${r.alreadyPaid.refId}). No dues now.`;
        setAlreadyPaid(m); voice.speak(`${name}. ${m}`);
      } else {
        voice.speak(r.bill.amount !== null ? `${name}. Amount ${inr(r.bill.amount)}${r.bill.dueDate ? `, due ${r.bill.dueDate}` : ''}.` : `${name}. Choose a plan.`);
      }
    } catch (e) { setErr((e as Error).message); voice.speak((e as Error).message); } finally { setBusy(false); }
  }

  async function payIt(input: { savedBillId?: string; billerId?: string; account?: string }, amountOverride?: number) {
    setBusy(true); setErr('');
    try {
      const r = await api.prepareBill({ ...input, amount: amountOverride ?? bill?.amount ?? plan });
      if (r.pending) pay.show(r.pending, () => { refresh(); setBill(null); setPlan(null); });
    } catch (e) { setErr((e as Error).message); voice.speak((e as Error).message); } finally { setBusy(false); }
  }

  async function save() {
    try {
      await api.saveBill({ billerId, account, nickname: nickname || LABEL[cat] });
      setNickname('');
      load();
      Alert.alert('Saved', 'You can now pay it by voice, e.g. "pay ' + (nickname || LABEL[cat]) + '".');
    } catch (e) { setErr((e as Error).message); }
  }

  const confirmDelete = (s: SavedBill) =>
    Alert.alert('Remove saved bill?', s.nickname, [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: async () => { await api.deleteBill(s.id).catch(() => {}); load(); } }]);

  const currentInput = { billerId, account: account.replace(/\s+/g, '').toUpperCase() };
  const needsPlan = biller?.plans && bill && bill.amount === null;
  const isTopup = cat === 'fastag' && !!bill && bill.amount === null;
  const savedHere = saved.filter((s) => s.category === cat);

  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <H>Pay bills</H>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: S.sm }}>
        {CATS.map((c) => (
          <Pressable key={c} onPress={() => { tick(); reset(c); }} accessibilityRole="button" accessibilityLabel={LABEL[c]} accessibilityState={{ selected: cat === c }}
            style={{ width: '25%', alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ padding: 3, borderRadius: 20, borderWidth: 2, borderColor: cat === c ? C.green : 'transparent' }}>
              <IconTile icon={CATEGORY_ICON[c]} tint={CATEGORY_TINT[c] ?? C.card2} size={52} />
            </View>
            <Text numberOfLines={1} style={{ color: cat === c ? C.green : C.sub, fontSize: 12.5, fontWeight: cat === c ? '700' : '500', marginTop: 4 }}>{SHORT[c] ?? LABEL[c]}</Text>
          </Pressable>
        ))}
      </View>

      {savedHere.length > 0 && (
        <Card>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h2, fontWeight: '800', marginBottom: S.sm }}>Saved accounts</Text>
          {savedHere.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: C.line, paddingVertical: S.xs }}>
              <Pressable
                onPress={() => { tick(); setBillerId(s.billerId); setAccount(''); setSavedSel(s.id); fetchIt({ savedBillId: s.id }); }}
                accessibilityRole="button"
                accessibilityLabel={`${s.nickname}, ${s.billerName}, account ${s.account}. Double tap to fetch the bill.`}
                style={{ flex: 1, minHeight: 64, justifyContent: 'center' }}
              >
                <Text style={{ color: C.text, fontWeight: '700', fontSize: F.body }}>{s.nickname}</Text>
                <Text style={{ color: C.sub, fontSize: F.small }}>{s.billerName} • {s.account}</Text>
              </Pressable>
              <IconBtn icon="trash" label={`Remove ${s.nickname}`} size={48} onPress={() => confirmDelete(s)} />
            </View>
          ))}
          <Text style={{ color: C.faint, fontSize: F.small, marginTop: S.sm }}>Tap one to fetch the bill. By voice, say "pay {savedHere[0].nickname}".</Text>
        </Card>
      )}

      <Card>
        <Text style={{ color: C.sub, fontSize: F.body, fontWeight: '600', marginBottom: S.sm }}>{PROVIDER[cat] ?? 'Operator'}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {list.map((b) => <Chip key={b.id} text={b.name} active={billerId === b.id} onPress={() => { setBillerId(b.id); setBill(null); setSavedSel(null); }} />)}
        </View>
        {biller && (
          <>
            <Field label={biller.accountLabel} hint={biller.accountHint} value={account} onChangeText={(t) => { setAccount(t); setBill(null); setSavedSel(null); }} keyboardType={cat === 'fastag' ? 'default' : 'number-pad'} autoCapitalize="characters" maxLength={20} />
            <Btn title={cat === 'mobile' || cat === 'dth' ? 'Show plans' : cat === 'gas' ? 'Check booking' : cat === 'fastag' ? 'Check FASTag' : 'Fetch bill'} disabled={!accountOk} busy={busy} onPress={() => fetchIt(currentInput)} />
          </>
        )}
      </Card>

      {err ? <ErrorText>{err}</ErrorText> : null}

      {bill && (
        <Card style={{ borderColor: C.green, borderWidth: 2 }}>
          <Text accessibilityRole="header" style={{ color: C.text, fontWeight: '800', fontSize: F.h2 }}>{billers.find((b) => b.id === bill.billerId)?.name}</Text>
          <Sub>{bill.customerName} • {bill.account}</Sub>
          {bill.amount !== null && <Text accessibilityLabel={`${bill.amount} rupees`} style={{ color: C.text, fontSize: F.hero, fontWeight: '800', marginVertical: S.sm }}>{inr(bill.amount)}</Text>}
          {bill.units ? <Sub>Units: {bill.units}</Sub> : null}
          {bill.dueDate ? <Sub>Due date: {bill.dueDate}</Sub> : null}
          {bill.billNumber ? <Sub>Bill number: {bill.billNumber}</Sub> : null}
          <Text style={{ color: C.amber, fontSize: F.small, marginTop: S.sm }}>{bill.note}</Text>

          {isTopup && (
            <View style={{ marginTop: S.md }}>
              <Field label="Amount to add (100 to 10,000)" keyboardType="number-pad" maxLength={5}
                value={plan ? String(plan) : ''} onChangeText={(t) => setPlan(Number(t.replace(/\D/g, '')) || null)} />
            </View>
          )}

          {needsPlan && (
            <View style={{ marginTop: S.md }}>
              {bill.plans!.map((p) => (
                <Pressable key={p.amount} onPress={() => { tick(); setPlan(p.amount); }}
                  accessibilityRole="radio" accessibilityState={{ selected: plan === p.amount }}
                  accessibilityLabel={`${p.amount} rupees plan, ${p.validity}, ${p.benefit}`}
                  style={{ padding: S.md, borderRadius: R.md, borderWidth: 2, borderColor: plan === p.amount ? C.green : C.outline, marginBottom: S.sm, backgroundColor: plan === p.amount ? '#052e16' : 'transparent', minHeight: 64 }}>
                  <Text style={{ color: C.text, fontWeight: '800', fontSize: F.body }}>{inr(p.amount)} <Text style={{ color: C.sub, fontWeight: '400' }}>• {p.validity}</Text></Text>
                  <Sub style={{ fontSize: F.small }}>{p.benefit}</Sub>
                </Pressable>
              ))}
            </View>
          )}

          {alreadyPaid ? <Text style={{ color: C.green, fontSize: F.body, marginTop: S.md, fontWeight: '700' }}>{alreadyPaid}</Text> : (
            <>
              <Btn title={bill.amount !== null ? `Pay ${inr(bill.amount)}` : plan ? `${isTopup ? 'Add' : 'Recharge'} ${inr(plan)}` : isTopup ? 'Enter an amount' : 'Choose a plan'}
                disabled={bill.amount === null && !plan} busy={busy} style={{ marginTop: S.md }}
                onPress={() => payIt(savedSel ? { savedBillId: savedSel } : currentInput)} />
              {bill.minDue ? (
                <Btn title={`Pay minimum due ${inr(bill.minDue)}`} kind="ghost" busy={busy} style={{ marginTop: S.sm }}
                  onPress={() => payIt(savedSel ? { savedBillId: savedSel } : currentInput, bill.minDue)} />
              ) : null}
            </>
          )}

          {!savedSel && biller && accountOk && (
            <View style={{ marginTop: S.md }}>
              <Field label="Save as (for voice)" placeholder={LABEL[cat]} value={nickname} onChangeText={setNickname} maxLength={30} />
              <Btn title="Save this account" kind="ghost" onPress={save} />
            </View>
          )}
        </Card>
      )}
      <Text style={{ color: C.faint, fontSize: F.small, marginBottom: S.lg }}>
        Bill amounts are simulated (BBPS needs a licensed aggregator). Formats, plans and checks follow the real flow.
      </Text>
    </ScrollView>
  );
}
