// Groq (free tier) — LLM tool calling for intent extraction + Whisper speech-to-text.
// Every function returns null on failure so the caller can fall back to the rule parser.
import process from 'node:process';
import { z } from 'zod';
import type { ParsedCommand } from './parser.js';

const GROQ = 'https://api.groq.com/openai/v1';
const key = () => process.env.GROQ_API_KEY?.trim() || '';
export const llmEnabled = () => key().length > 0;

const SYSTEM = `You are the brain of VoicePay, a voice payment assistant used in India.
The user speaks English, Tamil, or Tanglish (Tamil in English letters). The text comes from speech recognition and may have spelling mistakes.
Always call the tool "command" exactly once.
- intent: send_money (pay a person/shop) | pay_bill (electricity/EB/current bill, mobile recharge, DTH/TV recharge, gas cylinder booking) | check_balance | get_history | confirm (yes/aama/sari/ok) | cancel (no/venaam/cancel) | navigate (open/read a screen: bills, contacts, profile, home) | help (what can you do) | repeat (say that again) | stop (stop listening, that's all, bye, podhum) | start_kyc (verify identity / KYC) | scan_qr (scan a QR code to pay a shop) | add_contact (save a new payee) | delete_contact | add_bill (save a bill account for later) | check_dues (which bills are due) | spending (how much did I spend) | last_payment | pay_again (repeat the last payment) | request_money (ask someone to pay me) | split_bill (divide an amount between people) | bank_transfer (send to a bank account number + IFSC) | add_money (add money to the wallet) | limits (daily / per-payment limit) | share_receipt | unknown
- screen: for navigate only: home | bills | contacts | profile. null otherwise.
- name: for send_money, the payee exactly as heard, without Tamil suffixes like "ku", "kku", "ukku". null otherwise.
- category: for pay_bill and add_bill: electricity | mobile | dth | gas | water | broadband | postpaid (monthly mobile bill) | fastag | creditcard | insurance | loan (EMI) | tax (property tax). null otherwise.
- name: also the person for request_money, add_contact, delete_contact.
- account: for pay_bill only: the mobile / consumer / subscriber number if spoken (digits only), else null. Never put the account number in amount.
- amount: number in rupees. Tamil numbers: onnu=1 rendu=2 moonu=3 naalu=4 anju=5 pathu=10 nooru=100 ainooru=500 aayiram=1000 "rendu aayiram"=2000 "aayirathi ainooru"=1500. English words too ("two thousand"=2000, "1.5k"=1500). null if not said.
Never invent a name or an amount.`;

const tool = {
  type: 'function',
  function: {
    name: 'command',
    description: 'The structured command the user spoke.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['send_money', 'pay_bill', 'check_balance', 'get_history', 'confirm', 'cancel', 'navigate', 'help', 'repeat', 'stop', 'start_kyc', 'scan_qr', 'add_contact', 'delete_contact', 'add_bill', 'check_dues', 'spending', 'last_payment', 'pay_again', 'request_money', 'split_bill', 'bank_transfer', 'add_money', 'limits', 'share_receipt', 'unknown'] },
        screen: { type: ['string', 'null'], enum: ['home', 'bills', 'contacts', 'profile', null] },
        name: { type: ['string', 'null'] },
        amount: { type: ['number', 'null'] },
        category: { type: ['string', 'null'], enum: ['electricity', 'mobile', 'dth', 'gas', 'water', 'broadband', 'postpaid', 'fastag', 'creditcard', 'insurance', 'loan', 'tax', null] },
        account: { type: ['string', 'null'] },
      },
      required: ['intent', 'name', 'amount', 'category', 'account', 'screen'],
    },
  },
};

const Out = z.object({
  intent: z.enum(['send_money', 'pay_bill', 'check_balance', 'get_history', 'confirm', 'cancel', 'navigate', 'help', 'repeat', 'stop', 'start_kyc', 'scan_qr', 'add_contact', 'delete_contact', 'add_bill', 'check_dues', 'spending', 'last_payment', 'pay_again', 'request_money', 'split_bill', 'bank_transfer', 'add_money', 'limits', 'share_receipt', 'unknown']),
  screen: z.enum(['home', 'bills', 'contacts', 'history', 'profile']).nullable().optional().catch(null).transform((v) => v ?? null),
  category: z.enum(['electricity', 'mobile', 'dth', 'gas', 'water', 'broadband', 'postpaid', 'fastag', 'creditcard', 'insurance', 'loan', 'tax']).nullable().optional().transform((v) => v ?? null),
  account: z.string().regex(/^\d{6,17}$/).nullable().optional().catch(null).transform((v) => v ?? null),
  name: z.string().min(1).max(60).nullable().optional().transform((v) => v ?? null),
  amount: z.number().positive().max(1_000_000).nullable().optional().transform((v) => v ?? null),
});

export async function llmParse(text: string): Promise<ParsedCommand | null> {
  if (!llmEnabled()) return null;
  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text },
        ],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'command' } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn('[llm] HTTP', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json();
    const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = Out.safeParse(JSON.parse(args));
    if (!parsed.success) return null;
    return parsed.data;
  } catch (e) {
    console.warn('[llm] failed:', (e as Error).message);
    return null;
  }
}

/**
 * What the next answer is expected to be. Letters, digits, dates and names are transcribed with the more
 * accurate (slower) Whisper model, in English, with a prompt that shows the format. That is much better
 * for "A B C P E 1 2 3 4 F" than the multilingual auto-detect used for normal commands.
 */
export type Expect = 'name' | 'dob' | 'letters' | 'digits' | 'upi' | 'yesno';
const HINTS: Record<Expect, string> = {
  name: 'My name is Sasi Dharan.',
  dob: '14 May 2001. 3 March 1998.',
  letters: 'A B C P E 1 2 3 4 F. P for Papa. Letters and digits spelled one by one.',
  digits: '9 8 7 6 5 4 3 2 1 0. Digits spoken one by one.',
  upi: 'ramesh at okaxis. priya dot s at ok hdfc bank. arun one two three at ybl.',
  yesno: 'Yes. No. Aama. Illa. Wrong.',
};

export type Transcript = { text: string; /** Whisper was not sure it heard this right. */ low: boolean };

/** Names from the user's own contacts help the recognizer spell them right. Letters, digits and basic punctuation only. */
export const cleanVocab = (v: unknown) =>
  String(v ?? '').replace(/[^\p{L}\p{N} ,.'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

const BASE_PROMPT = 'VoicePay. Send 500 to Ramesh. Priya ku aayiram anuppu. Balance evlo. EB bill kattu. Jio recharge 299. Gas cylinder book pannu.';

/** The text that steers Whisper: a format hint for numbers / letters, or the usual commands plus the user's contact names. */
export function buildPrompt(expect: string | undefined, vocab: string): string {
  const hint = expect && expect in HINTS ? HINTS[expect as Expect] : null;
  if (hint) return hint; // the user's own name or a new payee is not in the address book: no names here
  return vocab ? `${BASE_PROMPT} People and shops: ${vocab}.` : BASE_PROMPT;
}

/** Whisper's own scores: a low average log-probability or a repetitive output means "probably misheard". */
export function isLowConfidence(segments: Array<{ avg_logprob?: number; compression_ratio?: number }>): boolean {
  const lp = segments.map((x) => x.avg_logprob).filter((n): n is number => typeof n === 'number');
  if (lp.length && lp.reduce((a, b) => a + b, 0) / lp.length < -0.9) return true;
  return segments.some((x) => (x.compression_ratio ?? 0) > 2.4);
}

/** Optional Indian-language engine (Sarvam AI): set SARVAM_API_KEY. Returns null on any problem so Groq takes over. */
async function sarvamStt(audio: Blob, filename: string): Promise<Transcript | null> {
  const k = process.env.SARVAM_API_KEY?.trim();
  if (!k) return null;
  try {
    const form = new FormData();
    form.append('file', audio, filename);
    form.append('model', process.env.SARVAM_STT_MODEL || 'saarika:v2.5');
    form.append('language_code', process.env.SARVAM_LANG || 'unknown'); // auto-detect Tamil / English / Hindi…
    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST', headers: { 'api-subscription-key': k }, body: form, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.warn('[stt:sarvam] HTTP', res.status); return null; }
    const json: any = await res.json();
    return typeof json.transcript === 'string' ? { text: json.transcript.trim(), low: false } : null;
  } catch (e) {
    console.warn('[stt:sarvam] failed:', (e as Error).message);
    return null;
  }
}

/** Speech-to-text. Audio = m4a/webm/wav bytes from the phone. Groq Whisper by default, Sarvam first for commands when configured. */
export async function transcribe(audio: Blob, filename: string, expect?: string, vocabRaw?: unknown): Promise<Transcript | null> {
  if (!llmEnabled()) return null;
  const hint = expect && expect in HINTS ? HINTS[expect as Expect] : null;
  if (!hint) {
    const s = await sarvamStt(audio, filename);
    if (s) return s;
  }
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', hint ? (process.env.GROQ_STT_PRECISE_MODEL || 'whisper-large-v3') : (process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'));
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json'); // gives no_speech_prob and avg_logprob per segment
  form.append('prompt', buildPrompt(expect, cleanVocab(vocabRaw)));
  if (hint) form.append('language', 'en');
  else if (process.env.STT_LANGUAGE) form.append('language', process.env.STT_LANGUAGE);
  try {
    const res = await fetch(`${GROQ}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn('[stt] HTTP', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json();
    // Whisper "hears" its own prompt in silence or noise. Ignore audio it is not sure contains speech.
    const segs: Array<{ no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }> = Array.isArray(json.segments) ? json.segments : [];
    if (segs.length && segs.every((x) => (x.no_speech_prob ?? 0) > 0.6)) return { text: '', low: false };
    if (typeof json.text !== 'string') return null;
    // Numbers, letters and dates are read back to the user anyway; only free commands need the "did you say…?" check.
    return { text: json.text.trim(), low: !hint && isLowConfidence(segs) };
  } catch (e) {
    console.warn('[stt] failed:', (e as Error).message);
    return null;
  }
}

export type ReplyLang = 'en' | 'ta' | 'tg';

/**
 * Says an English assistant reply in the user's language: 'ta' = Tamil script, 'tg' = Tanglish (Tamil in English letters).
 * Numbers, rupee amounts, names and codes stay exactly as they are. Returns the original text on any problem.
 */
export async function translateReply(text: string, lang: ReplyLang): Promise<string> {
  if (lang === 'en' || !llmEnabled() || !text.trim()) return text;
  const how = lang === 'ta'
    ? 'Tamil script (தமிழ்), simple spoken Tamil an everyday person uses'
    : 'Tanglish: spoken Tamil written in English letters, the way people text each other (for example "Ramesh ku 500 rupees anuppanuma? Aama nu sollunga")';
  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `You translate short replies of a voice payment assistant into ${how}. Keep every digit, amount (like ₹500), person or shop name, bank/UPI app name (Google Pay, PhonePe, Paytm), and word the user must say (yes, no, cancel, help, skip) unchanged and in English letters. Keep it short and friendly. Output only the translation, no quotes, no notes.` },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) { console.warn('[translate] HTTP', res.status); return text; }
    const out: any = await res.json();
    const t = String(out.choices?.[0]?.message?.content ?? '').trim();
    return t.length >= 2 ? t : text;
  } catch (e) {
    console.warn('[translate] failed:', (e as Error).message);
    return text;
  }
}
