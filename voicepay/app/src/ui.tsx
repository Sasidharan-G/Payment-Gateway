import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text as RNText, TextInput, View, type TextInputProps, type TextProps, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { C, F, FONT, R, S, TITLE, type IconName } from './theme';

/** Text that uses Inter in the weight asked by fontWeight (the whole app imports this instead of react-native's Text). */
export function Text({ style, ...rest }: TextProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  const w = String(flat.fontWeight ?? '400');
  const family = FONT[w === 'bold' ? '700' : w === 'normal' ? '400' : w] ?? FONT['400'];
  return <RNText {...rest} style={[style, { fontFamily: family, fontWeight: undefined }]} />;
}

/** Small tap feedback for every control (silently ignored where haptics are missing). */
export const tick = () => { Haptics.selectionAsync().catch(() => {}); };
export const buzz = (kind: 'success' | 'error' | 'warn') =>
  Haptics.notificationAsync(
    kind === 'success' ? Haptics.NotificationFeedbackType.Success : kind === 'error' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning,
  ).catch(() => {});

export function Icon({ name, size = 24, color = C.text }: { name: IconName; size?: number; color?: string }) {
  // Decorative: the text beside it (or the control's label) carries the meaning.
  return <Ionicons name={name} size={size} color={color} accessible={false} importantForAccessibility="no" />;
}

/** Press feedback that feels physical: a quick spring down and back (native driver, interruptible). */
export function usePressScale(to = 0.96) {
  const v = useRef(new Animated.Value(1)).current;
  const onPressIn = () => Animated.spring(v, { toValue: to, speed: 40, bounciness: 0, useNativeDriver: true }).start();
  const onPressOut = () => Animated.spring(v, { toValue: 1, speed: 24, bounciness: 8, useNativeDriver: true }).start();
  return { style: { transform: [{ scale: v }] }, onPressIn, onPressOut };
}

type Kind = 'primary' | 'ghost' | 'danger' | 'green';
export function Btn(props: {
  title: string; onPress: () => void; kind?: Kind; icon?: IconName; disabled?: boolean; busy?: boolean; hint?: string; style?: ViewStyle;
}) {
  const { kind = 'primary' } = props;
  const press = usePressScale(0.97);
  // filled = prominent; ghost = iOS "gray" button; danger = destructive filled
  const bg = kind === 'primary' || kind === 'green' ? C.green : kind === 'danger' ? C.redSolid : C.card2;
  const fg = kind === 'primary' || kind === 'green' ? C.onGreen : C.text;
  const off = props.disabled || props.busy;
  // Layout props (flex, margins, width) belong to the wrapper; the rest (padding, radius…) styles the button itself.
  const { flex, alignSelf, width, margin, marginTop, marginBottom, marginLeft, marginRight, marginHorizontal, marginVertical, ...inner } = (StyleSheet.flatten(props.style) ?? {}) as ViewStyle;
  const outer = { flex, alignSelf, width, margin, marginTop, marginBottom, marginLeft, marginRight, marginHorizontal, marginVertical };
  return (
    <Animated.View style={[press.style, outer]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.title}
        accessibilityHint={props.hint}
        accessibilityState={{ disabled: !!off, busy: !!props.busy }}
        onPress={() => { tick(); props.onPress(); }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={off}
        style={[s.btn, { backgroundColor: bg, opacity: off ? 0.45 : 1 }, inner]}
      >
        {props.busy ? <ActivityIndicator color={fg} /> : (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm }}>
            {props.icon ? <Icon name={props.icon} color={fg} size={22} /> : null}
            <Text style={[s.btnText, { color: fg }]}>{props.title}</Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** Round icon button with a REQUIRED text label for screen readers (>= 56dp target). */
export function IconBtn(props: { icon: IconName; label: string; onPress: () => void; active?: boolean; size?: number }) {
  const press = usePressScale(0.92);
  const size = props.size ?? 56;
  return (
    <Animated.View style={press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ selected: !!props.active }}
        onPress={() => { tick(); props.onPress(); }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        hitSlop={8}
        style={{ width: size, height: size, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: props.active ? C.green : C.card2 }}
      >
        <Icon name={props.icon} color={props.active ? C.onGreen : C.text} size={26} />
      </Pressable>
    </Animated.View>
  );
}

/** Inset grouped surface (the rounded section card of iOS Settings). */
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

/** Small caps section label above a card, like iOS grouped lists. */
export const SectionTitle = ({ children }: { children: string }) => (
  <Text accessibilityRole="header" style={s.section}>{children}</Text>
);

/** Rounded square icon (iOS app-icon style) with a saturated tint and a white glyph. */
export function IconTile({ icon, tint, size = 44 }: { icon: IconName; tint: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={size * 0.54} color="#FFFFFF" />
    </View>
  );
}

export function Field(props: TextInputProps & { label: string; hint?: string }) {
  const { label, hint, onFocus, onBlur, ...rest } = props;
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ marginBottom: S.md }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        placeholderTextColor={C.faint}
        style={[s.input, focus && { borderColor: C.green }]}
        accessibilityLabel={label}
        accessibilityHint={hint}
        onFocus={(e) => { setFocus(true); onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); onBlur?.(e); }}
        {...rest}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

/** Capsule choice (segmented-control feel). */
export function Chip({ text, active, icon, onPress }: { text: string; active?: boolean; icon?: IconName; onPress: () => void }) {
  const press = usePressScale(0.95);
  return (
    <Animated.View style={[press.style, { marginRight: S.sm, marginBottom: S.sm }]}>
      <Pressable
        onPress={() => { tick(); onPress(); }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityState={{ selected: !!active }}
        style={[s.chip, active && { backgroundColor: C.green }]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {icon ? <Icon name={icon} size={18} color={active ? C.onGreen : C.text} /> : null}
          <Text style={{ color: active ? C.onGreen : C.text, fontSize: F.small + 1, fontWeight: '700' }}>{text}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** Large title: announced as a header so screen readers can jump between sections. */
export const H = ({ children }: { children: React.ReactNode }) => <Text accessibilityRole="header" style={s.h}>{children}</Text>;
export const Sub = ({ children, style }: { children: React.ReactNode; style?: object }) => <Text style={[s.sub, style]}>{children}</Text>;
export const ErrorText = ({ children }: { children: string }) => (
  <View accessibilityLiveRegion="assertive" accessibilityRole="alert" style={{ backgroundColor: C.redTint, borderRadius: R.md, padding: S.md, marginBottom: S.md, flexDirection: 'row', gap: S.sm }}>
    <Icon name="alert-circle" size={22} color={C.red} />
    <Text style={{ color: C.red, fontSize: F.body, fontWeight: '600', flex: 1 }}>{children}</Text>
  </View>
);

/** Completion moment: the check springs in and a ring bursts outward. */
export function SuccessMark({ size = 96, ok = true }: { size?: number; ok?: boolean }) {
  const pop = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(pop, { toValue: 1, damping: 9, stiffness: 160, mass: 0.8, useNativeDriver: true }),
      Animated.timing(ring, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [pop, ring]);
  const color = ok ? C.green : C.amber;
  return (
    <View style={{ width: size * 1.45, height: size * 1.45, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 3, borderColor: color,
        opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }],
      }} />
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Ionicons name={ok ? 'checkmark-circle' : 'return-up-back'} size={size} color={color} accessible={false} importantForAccessibility="no" />
      </Animated.View>
    </View>
  );
}

export const s = StyleSheet.create({
  btn: { borderRadius: R.md + 2, paddingVertical: 14, paddingHorizontal: S.lg, alignItems: 'center', justifyContent: 'center', minHeight: 56 },
  btnText: { fontSize: F.body, fontWeight: '700' },
  card: { backgroundColor: C.card, borderRadius: R.lg, padding: S.md, marginBottom: S.md, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  section: { color: C.faint, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6, marginLeft: S.sm },
  label: { color: C.sub, fontSize: F.small + 1, marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: C.card2, color: C.text, borderRadius: R.md, paddingHorizontal: S.md, paddingVertical: 14, fontSize: F.body, borderWidth: 2, borderColor: 'transparent', minHeight: 56 },
  hint: { color: C.faint, fontSize: F.small, marginTop: 6 },
  chip: { backgroundColor: C.card2, borderRadius: R.pill, paddingHorizontal: S.md, minHeight: 48, justifyContent: 'center' },
  h: { color: C.text, ...TITLE, marginBottom: S.md },
  sub: { color: C.sub, fontSize: F.body },
});
