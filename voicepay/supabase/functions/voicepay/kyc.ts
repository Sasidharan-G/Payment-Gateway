// KYC (Know Your Customer) — minimum KYC before any payment.
//
// What is REAL here: PAN format rules, Aadhaar Verhoeff checksum, age >= 18, mobile format,
// OTP with expiry + attempt limit, and storing only masked identifiers.
// What is SIMULATED: the OTP is shown in the app (no SMS gateway) and no UIDAI / NSDL lookup is made.
// Real Aadhaar eKYC needs a UIDAI-licensed KUA/ASA partner; real PAN verification needs an
// NSDL/Protean or KYC-provider API (e.g. Digio, IDfy, Signzy). Swap verifyWithProvider() for those.
import crypto from 'node:crypto';

export type Kyc = {
  status: 'none' | 'verified';
  name?: string;
  dob?: string;
  panMasked?: string;
  aadhaarLast4?: string;
  mobile?: string;
  verifiedAt?: string;
};

// ---------- Verhoeff checksum (used by Aadhaar's last digit) ----------
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffValid(num: string): boolean {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

/** Appends the Verhoeff check digit (handy for making valid test Aadhaar numbers). */
export function verhoeffGenerate(num: string): string {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[(i + 1) % 8][digits[i]]];
  return num + INV[c];
}

export function validateAadhaar(raw: string): string | null {
  const a = raw.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(a)) return 'Aadhaar must be 12 digits.';
  if (/^[01]/.test(a)) return 'Aadhaar cannot start with 0 or 1.';
  if (!verhoeffValid(a)) return 'Aadhaar number is not valid (checksum failed). Please check the digits.';
  return null;
}

export function validatePan(raw: string): string | null {
  const p = raw.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(p)) return 'PAN must look like ABCDE1234F.';
  if (p[3] !== 'P') return 'For a personal account the 4th letter of PAN must be P (individual).';
  return null;
}

export function validateDob(dob: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Date of birth must be YYYY-MM-DD.';
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) return 'Date of birth is not a real date.';
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  if (age < 18) return 'You must be at least 18 years old.';
  if (age > 120) return 'Please check the date of birth.';
  return null;
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!/^[A-Za-z][A-Za-z .']{1,59}$/.test(n)) return 'Name should contain only letters, spaces and dots (2-60 characters).';
  return null;
}

export const maskPan = (pan: string) => { const p = pan.toUpperCase(); return p.slice(0, 3) + '****' + p.slice(7); };

// ---------- OTP sessions (in memory) ----------
type Session = {
  id: string;
  otpHash: string;
  expires: number;
  attempts: number;
  data: { name: string; dob: string; panMasked: string; aadhaarLast4: string; mobile: string };
};

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export type KycData = Session['data'];

export class KycService {
  private sessions = new Map<string, Session>();

  /** The in-flight OTP sessions (hashed OTPs only), so a stateless host can keep them between requests. */
  snapshot(): Session[] { return [...this.sessions.values()]; }
  restore(list: unknown) {
    this.sessions.clear();
    if (Array.isArray(list)) for (const s of list as Session[]) if (s?.id) this.sessions.set(s.id, s);
  }

  /** Voice KYC validates and masks each value as it is spoken, so the full PAN / Aadhaar are never kept anywhere. */
  startVerified(data: KycData) {
    const otp = String(crypto.randomInt(100000, 1000000));
    const id = 'kyc_' + crypto.randomBytes(8).toString('hex');
    this.sessions.set(id, { id, otpHash: hash(id + otp), expires: Date.now() + OTP_TTL_MS, attempts: 0, data });
    return { ok: true as const, sessionId: id, otp, mobileMasked: 'XXXXXX' + data.mobile.slice(-4) };
  }

  start(input: { name?: string; dob?: string; pan?: string; aadhaar?: string; mobile?: string }) {
    const name = String(input.name ?? '').trim();
    const dob = String(input.dob ?? '').trim();
    const pan = String(input.pan ?? '').trim().toUpperCase();
    const aadhaar = String(input.aadhaar ?? '').replace(/[\s-]/g, '');
    const mobile = String(input.mobile ?? '').replace(/\D/g, '').slice(-10);
    const error =
      validateName(name) ?? validateDob(dob) ?? validatePan(pan) ?? validateAadhaar(aadhaar) ??
      (/^[6-9]\d{9}$/.test(mobile) ? null : 'Mobile number must be 10 digits starting with 6-9.');
    if (error) return { ok: false as const, error };

    const otp = String(crypto.randomInt(100000, 1000000));
    const id = 'kyc_' + crypto.randomBytes(8).toString('hex');
    // The full Aadhaar/PAN never leave this function: only masked values are kept.
    this.sessions.set(id, {
      id, otpHash: hash(id + otp), expires: Date.now() + OTP_TTL_MS, attempts: 0,
      data: { name, dob, panMasked: maskPan(pan), aadhaarLast4: aadhaar.slice(-4), mobile },
    });
    return { ok: true as const, sessionId: id, otp, mobileMasked: 'XXXXXX' + mobile.slice(-4) };
  }

  verify(sessionId: string, otp: string): { ok: true; kyc: Kyc } | { ok: false; error: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, error: 'OTP session not found. Please start again.' };
    if (Date.now() > s.expires) { this.sessions.delete(sessionId); return { ok: false, error: 'OTP expired. Please start again.' }; }
    if (s.attempts >= MAX_ATTEMPTS) { this.sessions.delete(sessionId); return { ok: false, error: 'Too many wrong attempts. Please start again.' }; }
    s.attempts++;
    if (hash(sessionId + String(otp).trim()) !== s.otpHash) {
      const left = MAX_ATTEMPTS - s.attempts;
      if (left <= 0) this.sessions.delete(sessionId);
      return { ok: false, error: left > 0 ? `Wrong OTP. ${left} attempt(s) left.` : 'Too many wrong attempts. Please start again.' };
    }
    this.sessions.delete(sessionId);
    return { ok: true, kyc: { status: 'verified', ...s.data, verifiedAt: new Date().toISOString() } };
  }
}
