// Finds the backend automatically: the phone already talks to your laptop's Expo dev server,
// so we reuse that laptop IP with the backend port. No config editing needed.
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { SUPABASE_URL, authHeader, authConfigured } from './auth';

const PORT = 4000;

function autoBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (authConfigured) return `${SUPABASE_URL}/functions/v1/voicepay`; // real mode: the Supabase backend
  const hostUri = Constants.expoConfig?.hostUri ?? (Constants as any).expoGoConfig?.debuggerHost ?? '';
  const host = hostUri.split(':')[0];
  return `http://${host || 'localhost'}:${PORT}`;
}

const STATIC_KEY: Record<string, string> = process.env.EXPO_PUBLIC_API_KEY ? { 'x-api-key': process.env.EXPO_PUBLIC_API_KEY } : {};
/** Headers for every backend call: the signed-in user's token (real mode) or the shared dev key. */
const authHeaders = async () => ({ ...STATIC_KEY, ...(await authHeader()) });

let base = autoBase();
let lastLow = false;
let vocab = '';
const hashCode = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
export const getBase = () => base;
export const setBase = (url: string) => { base = url.trim().replace(/\/$/, ''); };

export type Contact = { id: string; name: string; nickname?: string; upiId: string; phone?: string; type: 'person' | 'merchant' };
export type Category =
  | 'electricity' | 'mobile' | 'dth' | 'gas' | 'water' | 'broadband' | 'postpaid'
  | 'fastag' | 'creditcard' | 'insurance' | 'loan' | 'tax';
export type Plan = { amount: number; validity: string; benefit: string };
export type Biller = { id: string; name: string; category: Category; accountLabel: string; accountPattern: string; accountHint: string; plans?: Plan[]; fixedAmount?: number };
export type SavedBill = { id: string; category: Category; billerId: string; billerName: string; account: string; nickname: string };
export type Bill = { billerId: string; account: string; customerName: string; amount: number | null; dueDate?: string; billNumber?: string; minDue?: number; units?: number; plans?: Plan[]; note: string };
export type Kyc = { status: 'none' | 'verified'; name?: string; dob?: string; panMasked?: string; aadhaarLast4?: string; mobile?: string; verifiedAt?: string };
export type Pending = {
  id: string; amount: number; kind: 'contact' | 'bill' | 'bank' | 'topup'; category: 'transfer' | 'bank' | 'topup' | Category;
  title: string; subtitle: string; upiAllowed: boolean; details?: { label: string; value: string }[];
};
export type Choice = { id: string; name: string; subtitle: string };
export type Transaction = {
  id: string; refId: string; category: 'transfer' | 'bank' | 'topup' | Category; payeeName: string; payeeRef: string; amount: number;
  method: 'gateway' | 'upi_app'; status: 'success' | 'failed' | 'cancelled' | 'initiated'; createdAt: string; transcript?: string;
};
export type AgentState = 'DONE' | 'NEEDS_INFO' | 'AWAITING_CHOICE' | 'AWAITING_CONFIRMATION' | 'READY_TO_PAY' | 'CANCELLED' | 'KYC_REQUIRED' | 'ERROR';
export type Screen = 'home' | 'bills' | 'contacts' | 'history' | 'profile';
export type AgentAction =
  | { type: 'navigate'; screen: Screen; category?: Category }
  | { type: 'stop_listening' }
  | { type: 'scan_qr' }
  | { type: 'share'; text: string; title: string };
export type UpiApp = 'gpay' | 'phonepe' | 'paytm' | 'any';
export type AgentReply = {
  ok: boolean; error?: string; transcript?: string; reply: string; state: AgentState;
  pending?: Pending; choices?: Choice[];
  action?: AgentAction;
  route?: { method: 'upi'; app: UpiApp };
  sensitive?: boolean;
  expect?: 'name' | 'dob' | 'letters' | 'digits' | 'upi';
  log?: Array<{ step: string; value: unknown }>;
};

/**
 * fetch with a timeout. React Native waits forever by default, and a phone that kept a connection open
 * for a few idle minutes can end up on a dead one (the request just hangs). Aborting closes that
 * connection, so the retry goes out on a fresh one.
 */
async function timedFetch(url: string, init: RequestInit, ms: number, retries = 1): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init?.headers || {}) } }, 12000);
  } catch {
    throw new Error(`I can't reach the VoicePay server at ${base}. Check that the server is running and the phone has internet or the same Wi-Fi.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `Server error ${res.status}`);
  return json as T;
}

export const api = {
  health: () => req<{ ok: boolean; llm: boolean; stt: boolean; tts?: boolean; gateway: string; real?: boolean }>('/api/health'),
  wallet: () => req<{ balance: number; spentToday: number }>('/api/wallet'),
  contacts: () => req<{ contacts: Contact[] }>('/api/contacts'),
  addContact: (c: Omit<Contact, 'id'>) => req<{ contact: Contact }>('/api/contacts', { method: 'POST', body: JSON.stringify(c) }),
  deleteContact: (id: string) => req('/api/contacts/' + id, { method: 'DELETE' }),
  transactions: () => req<{ transactions: Transaction[] }>('/api/transactions'),
  /** `lowConfidence`: the recognizer was not sure, so the agent confirms "I heard … is that right?" before preparing a payment. */
  agent: (text: string, lowConfidence = false) => req<AgentReply>('/api/agent', { method: 'POST', body: JSON.stringify({ text, lowConfidence, lang: replyLang }) }),
  /** After a spoken command: was the last transcript doubtful? (read once) */
  /** The room was loud: treat the next command as doubtful, whatever the recognizer said. */
  flagLow() { lastLow = true; },
  takeLowConfidence(): boolean { const v = lastLow; lastLow = false; return v; },
  /** Names of your contacts and saved bills, sent with every recording so they are spelled right. */
  async refreshVocab() {
    try {
      const [c, b] = await Promise.all([api.contacts(), api.savedBills()]);
      const names = [...c.contacts.flatMap((x) => [x.name, x.nickname ?? '']), ...b.saved.map((x) => x.nickname)].filter(Boolean);
      vocab = [...new Set(names)].join(', ').slice(0, 280);
    } catch { /* hints are a bonus */ }
  },
  /** Natural voice (optional, server must have a voice engine). Returns a local audio file path, or throws. */
  async tts(text: string): Promise<string> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetch(base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ text }), signal: ctl.signal });
      const json = await res.json();
      if (!res.ok || !json.ok || !json.audio) throw new Error(json.error || 'no audio');
      const uri = (FileSystem.cacheDirectory ?? '') + 'tts_' + Math.abs(hashCode(text)) + '.wav';
      await FileSystem.writeAsStringAsync(uri, json.audio, { encoding: FileSystem.EncodingType.Base64 });
      return uri;
    } finally { clearTimeout(timer); }
  },
  upi: (pendingId: string, app: 'gpay' | 'phonepe' | 'paytm' | 'any') =>
    req<{ transaction: Transaction; link: string; fallbackLink: string }>('/api/payments/upi', { method: 'POST', body: JSON.stringify({ pendingId, app }) }),
  upiResult: (txId: string, status: 'success' | 'failed' | 'cancelled') =>
    req<{ transaction: Transaction }>(`/api/payments/${txId}/upi-result`, { method: 'POST', body: JSON.stringify({ status }) }),
  reset: () => req('/api/reset', { method: 'POST' }),
  kyc: () => req<{ kyc: Kyc }>('/api/kyc'),
  kycStart: (d: { name: string; dob: string; pan: string; aadhaar: string; mobile: string }) =>
    req<{ sessionId: string; mobileMasked: string; demoOtp: string }>('/api/kyc/start', { method: 'POST', body: JSON.stringify(d) }),
  kycVerify: (sessionId: string, otp: string) => req<{ kyc: Kyc }>('/api/kyc/verify', { method: 'POST', body: JSON.stringify({ sessionId, otp }) }),
  billers: () => req<{ billers: Biller[]; categories: Record<Category, string> }>('/api/billers'),
  savedBills: () => req<{ saved: SavedBill[] }>('/api/bills/saved'),
  saveBill: (b: { billerId: string; account: string; nickname: string }) => req<{ saved: SavedBill }>('/api/bills/saved', { method: 'POST', body: JSON.stringify(b) }),
  deleteBill: (id: string) => req('/api/bills/saved/' + id, { method: 'DELETE' }),
  fetchBill: (b: { savedBillId?: string; billerId?: string; account?: string }) =>
    req<{ bill: Bill; alreadyPaid: { refId: string; at: string } | null }>('/api/bills/fetch', { method: 'POST', body: JSON.stringify(b) }),
  prepareBill: (b: { savedBillId?: string; billerId?: string; account?: string; amount?: number | null }) =>
    req<AgentReply>('/api/bills/prepare', { method: 'POST', body: JSON.stringify(b) }),
  /** A scanned UPI QR code: the server checks it and replies like a voice command (spoken by the app). */
  payQr: (link: string) => req<AgentReply>('/api/pay/qr', { method: 'POST', body: JSON.stringify({ link }) }),
  preparePay: (contactId: string, amount: number) => req<AgentReply>('/api/pay/prepare', { method: 'POST', body: JSON.stringify({ contactId, amount }) }),
  /** The checkout page as HTML text (loaded into the WebView by the app: some hosts refuse to serve HTML pages).
   *  `auto` = the user already said "yes" by voice, so the demo gateway pays without another tap. */
  checkoutHtml: (pendingId: string, auto = false) =>
    req<{ html: string }>(`/api/checkout/${pendingId}${auto ? '?auto=1' : ''}`).then((r) => r.html),

  /**
   * Speech to text only: returns what was said ('' when nothing was understood).
   * The file is uploaded by the native uploader (fetch + FormData can't send a recorded file on this Expo version).
   * `expect` tells the server what kind of answer is coming (letters, digits, name, dob) so it can tune the recognizer.
   */
  async stt(uri: string, expect?: string): Promise<string> {
    const ext = uri.split('.').pop()?.toLowerCase() || 'm4a';
    const mime = ext === 'wav' ? 'audio/wav' : ext === '3gp' ? 'audio/3gpp' : ext === 'webm' ? 'audio/webm' : 'audio/mp4';
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await FileSystem.uploadAsync(base + '/api/stt', uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'audio',
          mimeType: mime,
          parameters: { ...(expect ? { expect } : {}), ...(vocab ? { vocab } : {}) },
          headers: await authHeaders(),
        });
        if (r.status === 502) return ''; // heard nothing useful
        const json = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
        if (r.status < 200 || r.status >= 300 || json.ok === false) throw new Error(json.error || `Server error ${r.status}`);
        lastLow = json.low === true;
        return String(json.text ?? '').trim();
      } catch (e) {
        last = (e as Error).message;
        if (/^Server error|Unauthorized|GROQ/i.test(last)) throw e; // a real answer from the server: no retry
      }
    }
    throw new Error(`I can't send your voice to the server at ${base}. (${last})`);
  },
};

// ---------- settings that survive closing the app ----------
export type ReplyLang = 'en' | 'tg' | 'ta';
export type Settings = { server?: string; handsFree: boolean; speechRate: number; neuralVoice?: boolean; replyLang?: ReplyLang };
/** Language VoicePay answers in: English, Tanglish (Tamil in English letters) or Tamil script. */
let replyLang: ReplyLang = 'tg';
export const getReplyLang = () => replyLang;
const KEY = 'voicepay.settings.v1';
export const defaultSettings: Settings = { handsFree: true, speechRate: 1, replyLang: 'tg' };

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const s = { ...defaultSettings, ...(raw ? JSON.parse(raw) : {}) } as Settings;
    if (s.server) setBase(s.server);
    replyLang = s.replyLang ?? 'tg';
    return s;
  } catch {
    return defaultSettings;
  }
}
export async function saveSettings(s: Settings) {
  replyLang = s.replyLang ?? 'tg';
  try { await AsyncStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
