import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';
import { api, inr, type Transaction } from '../api';
import { Text, Chip, H, Icon, IconBtn, IconTile } from '../ui';
import { C, CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_TINT, F, R, S } from '../theme';

// Status is shown with an icon AND a word, never by color alone.
const STATUS: Record<Transaction['status'], { color: string; label: string; icon: 'checkmark-circle' | 'close-circle' | 'remove-circle' | 'time' }> = {
  success: { color: C.green, label: 'Paid', icon: 'checkmark-circle' },
  failed: { color: C.red, label: 'Failed', icon: 'close-circle' },
  cancelled: { color: C.sub, label: 'Cancelled', icon: 'remove-circle' },
  initiated: { color: C.amber, label: 'Pending', icon: 'time' },
};
const FILTERS = ['all', 'transfer', 'topup', 'electricity', 'water', 'mobile', 'dth', 'gas', 'broadband', 'creditcard', 'fastag'] as const;

export default function History({ tick }: { tick: number }) {
  const [list, setList] = useState<Transaction[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false); // amounts stay hidden until asked
  const load = useCallback(() => {
    setLoading(true);
    api.transactions().then((r) => setList(r.transactions)).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load, tick]);
  const shown = filter === 'all' ? list : list.filter((t) => t.category === filter);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <H>History</H>
        <View style={{ marginBottom: S.md }}>
          <IconBtn icon={show ? 'eye' : 'eye-off'} active={show} label={show ? 'Amounts are shown. Double tap to hide.' : 'Amounts are hidden. Double tap to show.'} onPress={() => setShow((v) => !v)} />
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        {FILTERS.map((f) => <Chip key={f} text={f === 'all' ? 'All' : CATEGORY_LABEL[f]} icon={f === 'all' ? undefined : CATEGORY_ICON[f]} active={filter === f} onPress={() => setFilter(f)} />)}
      </ScrollView>
      <FlatList
        data={shown}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.sub} />}
        ListEmptyComponent={<Text style={{ color: C.sub, fontSize: F.body, marginTop: S.lg }}>No payments yet. Say "send 500 to Priya" on the Voice screen.</Text>}
        renderItem={({ item: t, index }) => {
          const st = STATUS[t.status];
          const day = (iso: string) => new Date(iso).toDateString();
          const newDay = index === 0 || day(shown[index - 1].createdAt) !== day(t.createdAt);
          const today = day(t.createdAt) === new Date().toDateString();
          const dayLabel = today ? 'Today' : new Date(t.createdAt).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
          const when = new Date(t.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
          return (
            <View>
            {newDay && <Text accessibilityRole="header" style={{ color: C.faint, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: S.sm, marginBottom: 6, marginLeft: 4 }}>{dayLabel}</Text>}
            <View accessible accessibilityLabel={`${show ? inr(t.amount) + ' rupees' : 'Amount hidden'} to ${t.payeeName}. ${st.label}. ${when}. Reference ${t.refId}.`}
              style={{ backgroundColor: C.card, borderRadius: R.lg, padding: S.md, marginBottom: S.sm }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: S.sm }}>
                  <IconTile icon={CATEGORY_ICON[t.category] ?? 'cash'} tint={CATEGORY_TINT[t.category] ?? C.card2} size={40} />
                  <Text style={{ color: C.text, fontWeight: '700', fontSize: F.body, flex: 1 }}>{t.payeeName}</Text>
                </View>
                <Text style={{ color: C.text, fontWeight: '800', fontSize: F.body + 2 }}>{show ? inr(t.amount) : '₹ ••••'}</Text>
              </View>
              <Text style={{ color: C.sub, fontSize: F.small, marginTop: 4 }}>{t.payeeRef}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: S.sm }}>
                <Text style={{ color: C.sub, fontSize: F.small, flex: 1 }}>{when} • {t.method === 'upi_app' ? 'UPI app' : 'Gateway'}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name={st.icon} size={18} color={st.color} />
                  <Text style={{ color: st.color, fontSize: F.small, fontWeight: '800' }}>{st.label}</Text>
                </View>
              </View>
              <Text style={{ color: C.faint, fontSize: F.small - 1, marginTop: 2 }}>Ref {t.refId}</Text>
            </View>
            </View>
          );
        }}
      />
    </View>
  );
}
