// Rule-based command parser (English + Tamil + Tanglish).
// Used when no LLM key is set, or as a fallback when the LLM fails.
// Also used to double-check the amount the LLM returns.
import { detectCategory, type Category } from './billers.ts';

export type Intent =
  | 'send_money' | 'pay_bill' | 'check_balance' | 'get_history' | 'confirm' | 'cancel'
  | 'navigate' | 'help' | 'repeat' | 'stop' | 'start_kyc'
  | 'scan_qr' | 'add_contact' | 'delete_contact' | 'add_bill' | 'check_dues' | 'spending' | 'last_payment'
  | 'pay_again' | 'request_money' | 'split_bill' | 'bank_transfer' | 'add_money' | 'limits' | 'share_receipt'
  | 'unknown';

/** Intents the rule parser recognises with high confidence: they win over a doubtful LLM answer. */
export const RULE_FIRST_INTENTS = new Set<Intent>([
  'scan_qr', 'add_contact', 'delete_contact', 'add_bill', 'check_dues', 'spending', 'last_payment', 'pay_again',
  'request_money', 'split_bill', 'bank_transfer', 'add_money', 'limits', 'share_receipt',
]);

export type Screen = 'home' | 'bills' | 'contacts' | 'history' | 'profile';

export type ParsedCommand = {
  intent: Intent;
  name: string | null;
  amount: number | null;
  category?: Category | null; // for pay_bill
  account?: string | null; // consumer / mobile / subscriber number heard in the sentence
  screen?: Screen | null; // for navigate
};

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Tamil (romanised, common spellings)
  onnu: 1, oru: 1, rendu: 2, irandu: 2, moonu: 3, munu: 3, naalu: 4, nalu: 4, anju: 5, aindhu: 5,
  aaru: 6, ezhu: 7, elu: 7, ettu: 8, onbathu: 9, onbadhu: 9,
  pathu: 10, paththu: 10, irupathu: 20, iruvathu: 20, irupadhu: 20, iruvadhu: 20, irubadhu: 20, muppathu: 30, muppadhu: 30, naarpathu: 40, narpathu: 40, naarpadhu: 40, naarpatthu: 40,
  aimbathu: 50, aimbadhu: 50, ambathu: 50, aivathu: 50, arupathu: 60, arubadhu: 60, ezhupathu: 70, ezhubadhu: 70, enbathu: 80, enbadhu: 80, thonnooru: 90, thonnuru: 90,
  // Tamil hundreds written as one word
  irunooru: 200, irunuru: 200, munnooru: 300, munnuru: 300, naanooru: 400, nanuru: 400,
  ainooru: 500, ainnooru: 500, aynooru: 500, ainuru: 500, arunooru: 600, aranooru: 600,
  ezhunooru: 700, ennooru: 800, tholaayiram: 900, thollayiram: 900,
};
const HUNDRED = new Set(['hundred', 'nooru', 'nuru', 'nuuru']);
const THOUSAND = new Set(['thousand', 'aayiram', 'ayiram', 'aayram', 'ayram']);
const THOUSAND_AND = new Set(['aayirathi', 'ayirathi', 'aayirathu', 'ayirathu']); // "aayirathi ainooru" = 1500
const LAKH = new Set(['lakh', 'lakhs', 'latcham', 'laksham']);

/** Extract a rupee amount from free text. Returns null if none found. */
export function parseAmount(raw: string): number | null {
  // Speech-to-text sometimes splits a number: "5 00" is 500, "10 00" is 1000, "2 000" is 2000.
  const text = raw.toLowerCase().replace(/,(?=\d{2,3}\b)/g, '').replace(/\b(\d{1,2}) (00|000)\b/g, '$1$2');

  // 1) digits: "500", "₹500", "rs 1500", "1.5k", "2 aayiram", "5000 rupees".
  //    Runs of 6+ digits are phone / consumer numbers, not amounts, so they are skipped.
  const re = /(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k\b|thousand|aayiram|ayiram|lakh|l\b|hundred|nooru)?/g;
  for (const m of text.matchAll(re)) {
    const intPart = m[1].split('.')[0];
    const unit = m[2]?.trim();
    if (intPart.length >= 6 && !unit) continue;
    let n = parseFloat(m[1]);
    if (unit === 'k' || (unit && THOUSAND.has(unit))) n *= 1000;
    else if (unit && LAKH.has(unit)) n *= 100000;
    else if (unit === 'l') n *= 100000;
    else if (unit && HUNDRED.has(unit)) n *= 100;
    return Math.round(n * 100) / 100;
  }
  // 2) number words: "five hundred", "two thousand five hundred", "rendu aayiram", "aayirathi ainooru"
  const tokens = text.split(/[^a-z]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let found = false;
  for (const t of tokens) {
    if (t in UNITS) { current += UNITS[t]; found = true; }
    else if (HUNDRED.has(t)) { current = (current || 1) * 100; found = true; }
    else if (THOUSAND.has(t) || THOUSAND_AND.has(t)) { total += (current || 1) * 1000; current = 0; found = true; }
    else if (LAKH.has(t)) { total += (current || 1) * 100000; current = 0; found = true; }
  }
  if (!found) return null;
  const value = total + current;
  return value > 0 ? value : null;
}

const YES = /\b(yes|yeah|yep|ok|okay|aama|aamaa|ama|sari|seri|confirm|confirmed|go ahead|proceed|anuppu|anupu|pay it|pay now|done)\b/;
const NO = /\b(no|nope|cancel|venaam|vendaam|vendam|venam|vena|stop|illa|illai|wait)\b/;

const STOP = new Set([
  'send', 'sent', 'pay', 'paid', 'transfer', 'give', 'please', 'pls', 'to', 'for', 'the', 'a', 'an', 'my',
  'money', 'rupees', 'rupee', 'rs', 'inr', 'amount', 'of', 'and', 'now', 'immediately', 'quickly',
  'anuppu', 'anupu', 'anuppunga', 'anupunga', 'anupp', 'anuppa', 'kudu', 'kudunga', 'koduthudu', 'pannu',
  'pannunga', 'panam', 'panna', 'rupa', 'rubai', 'roova', 'rupaai', 'rupaay', 'rupai', 'rupay', 'rubaai', 'ruba', 'rupaa', 'ku', 'kku', 'ukku', 'ikku', 'ah', 'ahh', 'ta',
  'request', 'from', 'ask', 'collect', 'split', 'between', 'among', 'me', 'myself', 'with', 'add', 'save', 'new', 'contact', 'payee', 'delete', 'remove', 'contacts', 'payees', 'named', 'called', 'as',
  'ippo', 'konjam', 'oru', 'hey', 'voicepay', 'can', 'you', 'i', 'want', 'need', 'gpay', 'via', 'using',
  'through', 'upi', 'yes', 'yeah', 'ok', 'okay', 'aama', 'aamaa', 'ama', 'sari', 'seri', 'confirm', 'it', 'now', 'done', 'k', 'thousand', 'hundred', 'lakh', 'aayiram', 'ayiram', 'nooru',
]);

/** Pull the payee name out of a send-money sentence. */
export function extractName(raw: string): string | null {
  let text = raw.toLowerCase();
  text = text.replace(/₹?\s*\d+(?:[.,]\d+)*\s*(k\b)?/g, ' ');
  const words = text.split(/[^a-z]+/).filter(Boolean);
  const kept: string[] = [];
  for (let w of words) {
    if (STOP.has(w) || w in UNITS || HUNDRED.has(w) || THOUSAND.has(w) || THOUSAND_AND.has(w) || LAKH.has(w)) continue;
    // Tamil dative suffix glued to the name: "rameshukku", "priyakku", "arunku"
    w = w.replace(/(vukku|ukku|ikku|kku|ku)$/, '');
    if (w.length < 2 || STOP.has(w)) continue;
    kept.push(w);
  }
  if (!kept.length) return null;
  return kept.join(' ');
}

export function isYes(text: string) { return YES.test(text.toLowerCase()) && !NO.test(text.toLowerCase()); }
export function isNo(text: string) { return NO.test(text.toLowerCase()); }

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.toLowerCase().trim();
  if (!text) return { intent: 'unknown', name: null, amount: null };

  // Assistant / navigation commands (checked first; none of these contain an amount).
  if (/\b(stop listening|that'?s all|that is all|bye|good ?bye|podhum|pothum|nirutha?)\b/.test(text)) {
    return { intent: 'stop', name: null, amount: null };
  }
  if (/\b(pay again|send again|same (payment|again)|(repeat|redo) (the |my )?(last |previous )?(payment|transaction|transfer))\b|marubadiyum anuppu/.test(text)) {
    return { intent: 'pay_again', name: null, amount: null };
  }
  if (/\b(repeat|say (that )?again|once more|marubadiyum|marupadi sollu|again sollu)\b/.test(text)) {
    return { intent: 'repeat', name: null, amount: null };
  }
  if (/\b(help|what can you do|what can i say|how does this work|udhavi|uthavi|enna pannalam)\b/.test(text)) {
    return { intent: 'help', name: null, amount: null };
  }
  if (/\bkyc\b|\bverify (me|my (identity|account))\b/.test(text)) {
    return { intent: 'start_kyc', name: null, amount: null };
  }
  const extra = parseExtra(text);
  if (extra) return extra;
  const screen = detectScreen(text);
  if (screen) return { intent: 'navigate', name: null, amount: null, screen };

  if (/\b(balance|bal)\b|evlo irukk|evvalavu irukk|(kaasu|kasu|panam|cash) evlo|evlo (kaasu|kasu|panam|cash)|how much (money|cash|balance)\b.*\b(have|left|there|in)\b/.test(text)) {
    return { intent: 'check_balance', name: null, amount: null };
  }
  if (/\b(history|transactions?|recent|statement|last \d* ?(payments?|transactions?))\b/.test(text)) {
    return { intent: 'get_history', name: null, amount: null };
  }

  const category = detectCategory(text);
  if (category) {
    const account = extractAccount(text);
    const rest = account ? joinSplitNumbers(text).replace(account, ' ') : text;
    return { intent: 'pay_bill', name: null, amount: parseAmount(rest), category, account };
  }

  const amount = parseAmount(text);
  if (amount === null && isYes(text) && !extractName(text)) return { intent: 'confirm', name: null, amount: null };
  const sendVerb = /\b(send|pay|transfer|give)\b|anupp|anup|kudu|kodu/.test(text);
  if (amount !== null || sendVerb) {
    return { intent: 'send_money', name: extractName(text), amount };
  }
  if (isNo(text)) return { intent: 'cancel', name: null, amount: null };
  if (isYes(text)) return { intent: 'confirm', name: null, amount: null };
  return { intent: 'unknown', name: null, amount: null };
}

/** "open bills", "go to contacts", "who are my contacts", "profile kaattu" → a screen. */
export function detectScreen(text: string): Screen | null {
  const t = text.toLowerCase();
  if (parseAmount(t) !== null || /\b(send|pay|transfer|recharge|book)\b/.test(t)) return null;
  const nav = /\b(open|go to|goto|go|show|take me|switch to|list|read|kaattu|kaamunga|kaatunga|thira|who are)\b/.test(t);
  if (/\b(contacts?|contact list|payees?)\b/.test(t) && (nav || /^(my )?contacts?$/.test(t))) return 'contacts';
  if (/\b(bills|saved bills|bill list|bills? screen)\b/.test(t) && (nav || /^(my )?bills$/.test(t))) return 'bills';
  if (/\b(profile|settings)\b/.test(t) && nav) return 'profile';
  if (/\b(home|main screen|voice screen|start screen)\b/.test(t) && nav) return 'home';
  return null;
}

/** A phone / consumer / subscriber number (6-17 digits, spaces allowed between groups). */
export function extractAccount(raw: string): string | null {
  // Speech-to-text often writes a mobile number as "98765 43210": join that 5+5 pattern only,
  // so "9876543210 299" (number + amount) is NOT merged.
  const m = joinSplitNumbers(raw).match(/\b\d{6,17}\b/);
  return m ? m[0] : null;
}

export const joinSplitNumbers = (raw: string) => raw.replace(/\b(\d{5})[\s-](\d{5})\b/g, '$1$2');

/** Payment features beyond "send money / pay bill": QR, requests, splitting, bank transfer, wallet, summaries. */
function parseExtra(text: string): ParsedCommand | null {
  const cmd = (intent: Intent, extra: Partial<ParsedCommand> = {}): ParsedCommand => ({ intent, name: null, amount: null, ...extra });
  if (/\b(scan|qr)\b/.test(text)) return cmd('scan_qr');
  if (/\b(split|divide|go dutch)\b/.test(text)) return cmd('split_bill', { amount: parseAmount(text) });
  if (/\b(delete|remove)\b.*\b(contacts?|payees?)\b/.test(text)) return cmd('delete_contact', { name: extractName(text) });
  if (/\b(add|save|create|new)\b.*\b(contact|payee|friend|person)\b/.test(text) || /\bcontact (add|save)\b/.test(text)) {
    return cmd('add_contact', { name: extractName(text) });
  }
  const walletTopUp =
    /\b(add|put|load|top ?up)\b.*\b(wallet|money|cash|funds)\b|\b(wallet|money) (add|load)\b|\bwallet\b.*\b(add|load|pottu)\b|\b(add|load)\b.*\bwallet\b/.test(text) ||
    (/\btop ?up\b/.test(text) && !/\b(mobile|phone|dth|fastag|prepaid|postpaid|recharge|number)\b|\d{10}/.test(text));
  if (walletTopUp && !/\b(send|pay|transfer)\b/.test(text)) {
    return cmd('add_money', { amount: parseAmount(text) });
  }
  if (/\b(request|ask)\b.*(\d|\bfor\b|\bmoney\b)|\bcollect\b.*\d/.test(text) && !/\b(bill|recharge)\b/.test(text)) {
    return cmd('request_money', { name: extractName(text), amount: parseAmount(text) });
  }
  if (/\b(bank (account|transfer)|ifsc|neft|imps|rtgs|account number)\b/.test(text) && /\b(send|pay|transfer|anuppu)\b/.test(text)) {
    return cmd('bank_transfer', { amount: parseAmount(text) });
  }
  if (/\b(receipt|share (the |my )?(last )?(payment|transaction)|screenshot)\b/.test(text)) return cmd('share_receipt');
  if (/\b(limit|limits)\b/.test(text)) return cmd('limits');
  if (/\b(spent|spend|spending|expenses?|selavu|selavaachu)\b/.test(text)) return cmd('spending');
  if (/\blast (payment|transaction|transfer)\b(?!s)|\bwhat did i (pay|send) last\b/.test(text)) return cmd('last_payment');
  if (/\b(dues?|pending bills?|upcoming bills?|bills? due|what do i owe)\b/.test(text) && !/\b(pay|kattu|recharge)\b/.test(text)) return cmd('check_dues');
  const category = detectCategory(text);
  if (category && /\b(add|save|register|link|new)\b/.test(text) && !/\b(pay|kattu|recharge now|book)\b/.test(text)) {
    return cmd('add_bill', { category });
  }
  return null;
}
