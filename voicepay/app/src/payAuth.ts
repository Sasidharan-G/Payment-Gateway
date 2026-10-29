// Every payment is approved with the phone's own security check, at the moment the user says "yes":
// fingerprint or face first (whatever the phone has set up), the phone PIN / pattern otherwise.
// This is separate from the app lock: the app lock protects looking, this protects spending.
import * as LocalAuthentication from 'expo-local-authentication';
import { readPlan, skipNextLock } from './LockGate';

export type AuthResult = { ok: true } | { ok: false; reason: 'cancelled' | 'failed' | 'lockout' };

/**
 * Asks the phone to confirm a payment. `say` is used to tell the user (who may not see the screen) what to do
 * before the system prompt appears. The user gets two tries; cancelling the prompt stops straight away.
 */
export async function authorizePayment(
  description: string,
  say: (text: string) => Promise<void> | void,
): Promise<AuthResult> {
  let plan;
  try { plan = await readPlan(); } catch { return { ok: true }; } // cannot read the phone: do not block
  if (plan.mode === 'none') return { ok: true }; // no screen lock exists on this phone, nothing to check against

  const how = plan.mode === 'biometric' ? `Confirm with your ${plan.kind}.` : 'Confirm with your phone PIN, pattern or password.';
  await say(`${how}`);

  let last: AuthResult = { ok: false, reason: 'failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      skipNextLock();
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: description,
        cancelLabel: 'Cancel payment',
        fallbackLabel: 'Use passcode',
        disableDeviceFallback: false,
      });
      if (r.success) return { ok: true };
      if (r.error === 'user_cancel' || r.error === 'system_cancel' || r.error === 'app_cancel') return { ok: false, reason: 'cancelled' };
      if (r.error === 'lockout') return { ok: false, reason: 'lockout' };
      last = { ok: false, reason: 'failed' };
      if (attempt === 0) await say('That did not match. Try once more.');
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }
  return last;
}
