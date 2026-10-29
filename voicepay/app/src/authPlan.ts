// Decides HOW the app lock should ask, from what the phone offers. Pure logic (no native calls), so it is testable.
//   1. Fingerprint / face enrolled  → ask for that first (the phone PIN stays as the prompt's own fallback).
//   2. The phone has the sensor but the user never set it up → tell them to use it, and meanwhile use the phone PIN.
//   3. No biometric sensor → the same PIN / pattern / password the user opens the phone with.
//   4. No screen lock at all → nothing to check against: open, with a warning.
// Numbers match expo-local-authentication: AuthenticationType 1 fingerprint, 2 face, 3 iris · SecurityLevel 0 none, 1 secret (PIN/pattern), 2-3 biometric.

export type AuthInfo = { hasHardware: boolean; types: number[]; biometricEnrolled: boolean; level: number };
export type AuthKind = 'fingerprint' | 'face' | 'fingerprint or face' | 'iris' | 'biometric';
export type AuthPlan = {
  mode: 'biometric' | 'setup_then_pin' | 'pin' | 'none';
  kind: AuthKind | null;
  button: string; // text on the Unlock button
  say: string; // spoken on the lock screen
};

const kindOf = (types: number[]): AuthKind | null => {
  const f = types.includes(1), face = types.includes(2), iris = types.includes(3);
  if (f && face) return 'fingerprint or face';
  if (face) return 'face';
  if (f) return 'fingerprint';
  if (iris) return 'iris';
  return types.length ? 'biometric' : null;
};

export function planAuth(i: AuthInfo): AuthPlan {
  const kind = kindOf(i.types);
  if (i.level === 0 && !i.biometricEnrolled) {
    return { mode: 'none', kind, button: 'Open', say: 'This phone has no screen lock, so I cannot protect VoicePay. Please set a PIN or fingerprint in the phone settings.' };
  }
  if (i.hasHardware && kind && i.biometricEnrolled) {
    return { mode: 'biometric', kind, button: `Unlock with ${kind}`, say: `VoicePay is locked. Use your ${kind} to unlock.` };
  }
  if (i.hasHardware && kind && !i.biometricEnrolled) {
    return {
      mode: 'setup_then_pin', kind, button: 'Unlock with phone PIN',
      say: `Your phone supports ${kind} unlock, but it is not set up. It is faster and safer, so please set it up in the phone settings. For now, use your phone PIN, pattern or password.`,
    };
  }
  return { mode: 'pin', kind: null, button: 'Unlock with phone PIN', say: 'VoicePay is locked. Use the PIN, pattern or password you use to open this phone.' };
}
