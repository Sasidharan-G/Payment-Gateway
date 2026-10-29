// Email + password sign-in with Supabase Auth, using its plain REST API (no extra packages).
// The session (access + refresh token) is kept on the phone so the user stays signed in.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
export const authConfigured = !!(SUPABASE_URL && ANON_KEY);

export type Session = { access_token: string; refresh_token: string; expires_at: number; email: string };
const KEY = 'voicepay.session.v1';

let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();
const emit = () => listeners.forEach((f) => f(session));
export const onSession = (f: (s: Session | null) => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const currentSession = () => session;

async function store(s: Session | null) {
  session = s;
  try { s ? await AsyncStorage.setItem(KEY, JSON.stringify(s)) : await AsyncStorage.removeItem(KEY); } catch {}
  emit();
}

function fromResponse(j: any, fallbackEmail = ''): Session {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
    email: j.user?.email ?? fallbackEmail,
  };
}

async function call(path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(SUPABASE_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON_KEY }, body: JSON.stringify(body) });
  } catch {
    throw new Error('No internet. Please check your connection and try again.');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = String(j.msg || j.error_description || j.message || j.error || '');
    if (/invalid login/i.test(m)) throw new Error('Wrong email or password.');
    if (/already registered/i.test(m)) throw new Error('This email already has an account. Please sign in.');
    if (/email not confirmed/i.test(m)) throw new Error('Please confirm your email first (check your inbox), then sign in.');
    if (/password/i.test(m) && /6|short|weak/i.test(m)) throw new Error('Password must be at least 6 characters.');
    throw new Error(m || `Sign-in failed (${res.status}).`);
  }
  return j;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch { session = null; }
  emit();
  return session;
}

export async function signIn(email: string, password: string) {
  const j = await call('/auth/v1/token?grant_type=password', { email: email.trim(), password });
  await store(fromResponse(j, email.trim()));
}

/** Returns true when the user is signed in straight away, false when Supabase wants the email confirmed first. */
export async function signUp(email: string, password: string): Promise<boolean> {
  const j = await call('/auth/v1/signup', { email: email.trim(), password });
  if (j.access_token) { await store(fromResponse(j, email.trim())); return true; }
  return false;
}

export async function signOut() {
  const s = session;
  await store(null);
  if (s) fetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
}

let refreshing: Promise<void> | null = null;

/** A valid access token (refreshed a minute before it expires), or null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (!session) return null;
  if (session.expires_at - 60 > Math.floor(Date.now() / 1000)) return session.access_token;
  refreshing ??= (async () => {
    try {
      const j = await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: session!.refresh_token });
      await store(fromResponse(j, session!.email));
    } catch (e) {
      // A refused refresh token means the login is over; a network error should not log the user out.
      if (!/internet/i.test((e as Error).message)) await store(null);
    }
  })().finally(() => { refreshing = null; });
  await refreshing;
  return session?.access_token ?? null;
}

export async function authHeader(): Promise<Record<string, string>> {
  const t = await accessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
