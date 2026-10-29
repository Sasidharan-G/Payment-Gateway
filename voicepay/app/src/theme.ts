// Design tokens: "Night glass", an iOS-style dark system for VoicePay.
// Inset grouped surfaces, large titles, squircle app-icon tiles, tinted buttons, capsule tab bar.
// Accessibility rules stay: text >= 4.5:1 (most >= 7:1), controls >= 56dp, no meaning by color alone.
import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export const C = {
  bg: '#05070A', // ink black with a cool tint
  card: '#0F141A', // surface
  card2: '#1A212A', // raised surface
  line: 'rgba(255,255,255,0.09)', // hairlines
  outline: '#6B7683', // input / control boundaries (>= 3:1)
  text: '#F5F7FA',
  sub: '#C3CAD3',
  faint: '#8E99A6',
  green: '#3DDC97', // mint: the money colour
  greenDeep: '#0B3D2B',
  gold: '#F5B83D', // warm highlight
  onGreen: '#02261A',
  blue: '#64A8FF',
  blueSolid: '#0A84FF',
  onBlue: '#00152E',
  red: '#FF6961',
  redSolid: '#C9001A',
  amber: '#FFD60A',
  onAmber: '#241B00',
  scrim: 'rgba(0,0,0,0.62)',
  glass: 'rgba(15,20,26,0.96)',
  greenTint: 'rgba(61,220,151,0.16)',
  redTint: 'rgba(255,105,97,0.16)',
};

export const S = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const R = { sm: 12, md: 16, lg: 22, xl: 30, pill: 999 };
export const F = { body: 18, small: 15, h2: 22, h1: 34, hero: 46 };

/** System font on both platforms (San Francisco on iOS, Roboto on Android). */
/** Inter, one file per weight (Android cannot pick weights from one family). */
export const FONT: Record<string, string> = {
  '400': 'Inter_400Regular', '500': 'Inter_500Medium', '600': 'Inter_600SemiBold', '700': 'Inter_700Bold', '800': 'Inter_800ExtraBold',
};
export const TITLE = { fontSize: F.h1, fontWeight: '800' as const, letterSpacing: 0.35 };

/** Vector icons only (no emoji as structural icons). */
export const CATEGORY_ICON: Record<string, IconName> = {
  transfer: 'arrow-up-circle',
  bank: 'business',
  topup: 'add-circle',
  electricity: 'flash',
  mobile: 'phone-portrait',
  dth: 'tv',
  gas: 'flame',
  water: 'water',
  broadband: 'wifi',
  postpaid: 'call',
  fastag: 'car',
  creditcard: 'card',
  insurance: 'shield-checkmark',
  loan: 'cash',
  tax: 'home',
};

export const CATEGORY_LABEL: Record<string, string> = {
  transfer: 'Money transfer',
  bank: 'Bank transfer',
  topup: 'Add money',
  electricity: 'Electricity',
  mobile: 'Mobile recharge',
  dth: 'DTH / TV',
  gas: 'Gas booking',
  water: 'Water',
  broadband: 'Broadband',
  postpaid: 'Postpaid',
  fastag: 'FASTag',
  creditcard: 'Credit card',
  insurance: 'Insurance',
  loan: 'Loan EMI',
  tax: 'Property tax',
};

/** App-icon colours (white glyph on a saturated squircle, like the iOS home screen). */
export const CATEGORY_TINT: Record<string, string> = {
  transfer: '#0A84FF', bank: '#5E5CE6', topup: '#248A3D', electricity: '#B87A00', mobile: '#0A7AA8', dth: '#9B3FD0',
  gas: '#D2410A', water: '#0A7FB0', broadband: '#5E5CE6', postpaid: '#0A7AA8', fastag: '#636366', creditcard: '#C2185B',
  insurance: '#16805F', loan: '#8A6508', tax: '#8A6E4B', qr: '#3A3A3C', request: '#D9541E', split: '#D6234A', due: '#C77700',
  spend: '#0B7A9E', again: '#248A3D',
};
