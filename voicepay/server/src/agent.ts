// The agent: text in → decide → act (look up contacts / bills, check KYC + limits, prepare a payment) → reply out.
// It NEVER moves money by itself. It only prepares a "pending payment"; the user must confirm
// and then pay through the gateway (Razorpay) or, for people/shops, their own UPI app.
//
// Everything a payment app offers is reachable by voice: pay people (saved, new UPI ID, QR), 12 kinds of bills,
// bank transfer, add money, request money, split a bill, history / dues / spending summaries, receipts.
import crypto from 'node:crypto';
import type { Contact, Db, SavedBill, Transaction } from './db.js';
import {
  BILLERS, CATEGORY_LABEL, NO_DUPLICATE_CATEGORIES, TOPUP_MAX, TOPUP_MIN, extractVehicle, fetchBill, getBiller,
  isDueCategory, isValidPlanAmount, maskAccount, validateAccount,
  type Biller, type Category, type FetchedBill,
} from './billers.js';
import { llmParse, llmEnabled } from './llm.js';
import { KycService, maskPan, validateAadhaar, validateDob, validateName, validatePan } from './kyc.js';
import {
  alnumFromSpeech, digitsFromSpeech, ifscFromSpeech, nameFromSpeech, parseSpokenDob, phoneFromText, spellDigits,
  spokenUpi, upiFromSpeech,
} from './speech.js';
import { matchContacts, pickCandidate, similarity } from './matcher.js';
import { razorpayEnabled, requestLink } from './payments.js';
import { realMode } from './mode.js';
import {
  RULE_FIRST_INTENTS, extractName, parseAmount, parseCommand, isNo, isYes, extractAccount,
  type ParsedCommand, type Screen,
} from './parser.js';

export const LIMITS = { perTransfer: 10000, perDay: 25000 };

export type AgentState =
  | 'DONE' | 'NEEDS_INFO' | 'AWAITING_CHOICE' | 'AWAITING_CONFIRMATION' | 'READY_TO_PAY'
  | 'CANCELLED' | 'KYC_REQUIRED' | 'ERROR';

export type Payee =
  | { kind: 'contact'; contact: Contact }
  | { kind: 'bill'; category: Category; biller: Biller; account: string; bill: FetchedBill }
  | { kind: 'bank'; name: string; account: string; ifsc: string }
  | { kind: 'topup' };

export type Pending = {
  id: string;
  payee: Payee;
  amount: number;
  transcript: string;
  createdAt: number;
  used: boolean;
};

/** What the app is allowed to see about a pending payment (no full account numbers). */
export type PublicPending = {
  id: string;
  amount: number;
  kind: 'contact' | 'bill' | 'bank' | 'topup';
  category: 'transfer' | 'bank' | 'topup' | Category;
  title: string; // "Ramesh Kumar" / "TNPDCL (TANGEDCO) - Tamil Nadu"
  subtitle: string; // UPI ID / masked account
  upiAllowed: boolean; // UPI-app route only for people and shops
  details?: { label: string; value: string }[];
};

export type Choice = { id: string; name: string; subtitle: string };

/** Things the app should DO besides speaking: switch screen, open the camera, share a message, stop listening. */
export type AgentAction =
  | { type: 'navigate'; screen: Screen; category?: Category }
  | { type: 'stop_listening' }
  | { type: 'scan_qr' }
  | { type: 'share'; text: string; title: string };

export type Expect = 'name' | 'dob' | 'letters' | 'digits' | 'upi';

export type AgentReply = {
  reply: string;
  state: AgentState;
  pending?: PublicPending;
  choices?: Choice[];
  action?: AgentAction;
  /** Voice said "Google Pay / PhonePe / Paytm": open that UPI app instead of the gateway. */
  route?: { method: 'upi'; app: 'gpay' | 'phonepe' | 'paytm' | 'any' };
  /** True while collecting KYC / bank details by voice: the app must not show or store what was said. */
  sensitive?: boolean;
  /** What the next spoken answer should be, so the speech-to-text can be tuned for it. */
  expect?: Expect;
  log: Array<{ step: string; value: unknown }>;
};

type KycStep = 'name' | 'dob' | 'pan' | 'aadhaar' | 'mobile' | 'otp';
type Log = AgentReply['log'];

type Conversation =
  | { kind: 'idle' }
  | { kind: 'need_amount'; contact: Contact; transcript: string }
  | { kind: 'need_name'; amount: number; transcript: string }
  | { kind: 'choose_contact'; candidates: Contact[]; amount: number | null; transcript: string }
  | { kind: 'choose_bill'; candidates: SavedBill[]; amount: number | null; transcript: string }
  | { kind: 'need_plan'; biller: Biller; account: string; transcript: string }
  | { kind: 'confirm'; pendingId: string }
  | { kind: 'kyc'; step: KycStep; data: { name?: string; dob?: string; panMasked?: string; aadhaarLast4?: string }; sessionId?: string; tries: number }
  | { kind: 'offer_add'; name: string | null; phone: string | null; amount: number | null }
  | { kind: 'add_contact'; step: 'name' | 'upi' | 'confirm'; name?: string; upiId?: string; phone: string | null; amount: number | null; tries: number }
  | { kind: 'confirm_delete'; contactId: string }
  | { kind: 'own_acct'; amount: number | null; transcript: string }
  | { kind: 'recharge'; step: 'number' | 'operator'; account?: string; amount: number | null; transcript: string; tries: number }
  | { kind: 'add_bill'; step: 'category' | 'biller' | 'account' | 'nickname' | 'confirm'; category?: Category; billerId?: string; account?: string; nickname?: string; payAfter: boolean; amount: number | null; transcript: string; tries: number }
  | { kind: 'bank'; step: 'name' | 'account' | 'ifsc' | 'amount'; name?: string; account?: string; ifsc?: string; amount: number | null; transcript: string; tries: number }
  | { kind: 'need_topup'; transcript: string }
  | { kind: 'verify_heard'; text: string }
  | { kind: 'split_confirm'; people: Array<{ name: string; amount: number }>; total: number };

const PENDING_TTL_MS = 5 * 60 * 1000;
/** Commands the rule parser never gets wrong: no need to wait for the AI model. */
const SIMPLE_INTENTS = new Set<string>([
  'check_balance', 'get_history', 'help', 'repeat', 'stop', 'start_kyc', 'scan_qr', 'limits', 'last_payment', 'pay_again',
  'check_dues', 'spending', 'share_receipt', 'navigate',
]);
const MONEY_INTENTS = new Set<string>(['send_money', 'pay_bill', 'bank_transfer', 'add_money', 'request_money', 'split_bill']);
export const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
const shortName = (b: Biller) => b.name.split(/ - | \(/)[0];

export class Agent {
  private convo: Conversation = { kind: 'idle' };
  readonly pendings = new Map<string, Pending>();

  private last: AgentReply | null = null;

  constructor(private db: Db, private kyc: KycService = new KycService()) {}

  reset() {
    this.convo = { kind: 'idle' };
    this.pendings.clear();
    this.last = null;
  }

  /** Conversation state as plain JSON, so a stateless host (Edge Functions) can keep it between requests. */
  snapshot() {
    return { convo: this.convo, pendings: [...this.pendings.values()], last: this.last };
  }

  restore(s: any) {
    this.pendings.clear();
    if (!s || typeof s !== 'object') { this.convo = { kind: 'idle' }; this.last = null; return; }
    this.convo = s.convo ?? { kind: 'idle' };
    for (const p of s.pendings ?? []) if (p?.id) this.pendings.set(p.id, p);
    this.last = s.last ?? null;
  }

  getPending(id: string): Pending | null {
    const p = this.pendings.get(id);
    if (!p) return null;
    if (Date.now() - p.createdAt > PENDING_TTL_MS) {
      this.pendings.delete(id);
      return null;
    }
    return p;
  }

  /** Mark a pending payment as finished so it can never be paid twice. */
  consume(id: string) {
    const p = this.pendings.get(id);
    if (p) p.used = true;
    if (this.convo.kind === 'confirm' && this.convo.pendingId === id) this.convo = { kind: 'idle' };
  }

  async handle(transcriptRaw: string, opts: { lowConfidence?: boolean } = {}): Promise<AgentReply> {
    const transcript = transcriptRaw.trim();
    const c = this.convo;
    // ID numbers and bank details are never echoed back or logged.
    const sensitive = c.kind === 'kyc' || (c.kind === 'bank' && (c.step === 'account' || c.step === 'ifsc'));
    const r = await this.handleInner(transcript, opts);
    if (sensitive || r.sensitive) { r.sensitive = true; r.log = []; }
    if (r.action?.type !== 'stop_listening') this.last = r;
    return r;
  }

  private async handleInner(transcript: string, opts: { lowConfidence?: boolean; verified?: boolean } = {}): Promise<AgentReply> {
    const log: Log = [{ step: 'heard', value: transcript }];
    if (!transcript) return { reply: "Sorry, I didn't catch that. Please try again.", state: 'ERROR', log };

    // Answer to "I heard …, is that right?"
    if (this.convo.kind === 'verify_heard') {
      const heard = this.convo.text;
      this.convo = { kind: 'idle' };
      if (isYes(transcript)) return this.handleInner(heard, { verified: true });
      if (isNo(transcript)) return { reply: 'Okay, please say it again.', state: 'CANCELLED', log };
    }

    // "repeat" / "help" never disturb a question that is waiting for an answer.
    if (this.convo.kind !== 'idle') {
      const side = parseCommand(transcript).intent;
      if (side === 'repeat' && this.last) return { ...this.last, log };
      if (side === 'help' && this.convo.kind !== 'kyc') return { reply: HELP, state: 'DONE', log };
      if (side === 'stop') this.convo = { kind: 'idle' }; // "stop listening" ends any question
    }

    const followUp = this.followUp(transcript, log);
    if (followUp) return followUp;

    // New command. Simple, unmistakable commands ("scan qr", "my balance") skip the AI call: faster. Everything else: AI first, rules as fallback.
    const rules = parseCommand(transcript);
    let cmd: ParsedCommand | null = SIMPLE_INTENTS.has(rules.intent) ? null : await llmParse(transcript);
    log.push({ step: 'parser', value: cmd ? 'llm' : SIMPLE_INTENTS.has(rules.intent) ? 'rules (simple command)' : llmEnabled() ? 'rules (llm failed)' : 'rules' });
    if (!cmd) cmd = rules;
    // Narrow rules (QR, split, receipts…) are more reliable than a doubtful model answer.
    if (RULE_FIRST_INTENTS.has(rules.intent) && cmd.intent !== rules.intent) cmd = rules;
    // Cross-check numbers with the rule parser: digits the user actually said win.
    if (/\d/.test(transcript)) {
      if (cmd.intent === rules.intent) cmd.amount = rules.amount ?? cmd.amount;
      if (cmd.intent === 'pay_bill') cmd.account = extractAccount(transcript) ?? cmd.account ?? null;
    }
    if (cmd.intent === 'pay_bill' && cmd.category === 'fastag') cmd.account = extractVehicle(transcript) ?? cmd.account ?? null;
    log.push({ step: 'intent', value: cmd });

    // Money is about to be prepared from a sentence the recognizer was not sure about: confirm what was heard first.
    if (opts.lowConfidence && !opts.verified && MONEY_INTENTS.has(cmd.intent)) {
      this.convo = { kind: 'verify_heard', text: transcript };
      return { reply: `I heard: ${transcript}. Is that right? Say yes or no.`, state: 'NEEDS_INFO', log };
    }

    switch (cmd.intent) {
      case 'check_balance':
        return { reply: realMode()
          ? `VoicePay does not hold your money, so your bank balance is in your bank or UPI app. ${this.balanceLine()}`
          : `Your balance is ${inr(this.db.data.balance)}.`, state: 'DONE', log };
      case 'get_history':
        return { ...this.describe('history'), log };
      case 'navigate':
        return { ...this.describe(cmd.screen ?? 'home'), log };
      case 'help':
        return { reply: HELP, state: 'DONE', log };
      case 'repeat':
        return this.last ? { ...this.last, log } : { reply: 'There is nothing to repeat yet.', state: 'DONE', log };
      case 'stop':
        return { reply: 'Okay, I stopped listening. Tap anywhere on the screen when you want to talk.', state: 'DONE', action: { type: 'stop_listening' }, log };
      case 'start_kyc':
        return this.startKyc(log);
      case 'pay_bill':
        return this.routeBill(cmd.category ?? null, cmd.account ?? null, cmd.amount, transcript, log);
      case 'send_money':
        return this.routeSendCommand(cmd, transcript, log);
      case 'scan_qr':
        return { reply: 'Opening the camera. Hold your phone about a foot away from the QR code and move it slowly. I will beep and speak when I find it. Tap Cancel to stop.', state: 'DONE', action: { type: 'scan_qr' }, log };
      case 'add_contact':
        return this.startAddContact(cmd.name, null, null, log);
      case 'delete_contact':
        return this.startDeleteContact(cmd.name, log);
      case 'add_bill':
        return this.startAddBill(cmd.category ?? null, transcript, false, null, log);
      case 'check_dues':
        return this.checkDues(log);
      case 'spending':
        return this.spending(transcript, log);
      case 'last_payment':
        return this.lastPayment(log);
      case 'pay_again':
        return this.payAgain(log);
      case 'request_money':
        return this.requestMoney(cmd.name, cmd.amount, log);
      case 'split_bill':
        return this.startSplit(transcript, cmd.amount, log);
      case 'bank_transfer':
        return this.startBank(cmd.amount, transcript, log);
      case 'add_money':
        return this.startTopup(cmd.amount, transcript, log);
      case 'limits':
        return this.limits(log);
      case 'share_receipt':
        return this.shareReceipt(log);
      case 'confirm':
      case 'cancel':
        return { reply: 'There is nothing to confirm right now. Say something like "Send 500 to Ramesh".', state: 'DONE', log };
      default:
        return {
          reply: 'Sorry, I did not understand. I can send money, scan a QR code, pay bills, recharge, add money, and more. Say help to hear everything. Try "Send 500 to Priya".',
          state: 'ERROR', log,
        };
    }
  }

  /** Answers to a question the agent asked earlier. Returns null if the text is a new command. */
  private followUp(transcript: string, log: Log): AgentReply | null {
    const c = this.convo;
    if (c.kind === 'idle') return null;
    const cancelled = (): AgentReply => { this.convo = { kind: 'idle' }; return { reply: 'Okay, cancelled.', state: 'CANCELLED', log }; };

    if (c.kind === 'kyc') return this.kycStep(transcript, c, log);
    if (c.kind === 'add_contact') return this.addContactStep(transcript, c, log);
    if (c.kind === 'add_bill') return this.addBillStep(transcript, c, log);
    if (c.kind === 'recharge') return this.rechargeStep(transcript, c, log);
    if (c.kind === 'own_acct') {
      this.convo = { kind: 'idle' };
      if (isYes(transcript)) return this.startBank(c.amount, c.transcript, log);
      return isNo(transcript) ? { reply: 'Okay, cancelled.', state: 'CANCELLED', log } : null;
    }
    if (c.kind === 'bank') return this.bankStep(transcript, c, log);

    if (c.kind === 'offer_add') {
      if (isYes(transcript)) return this.startAddContact(c.name, c.phone, c.amount, log);
      this.convo = { kind: 'idle' };
      return isNo(transcript) ? { reply: 'Okay, I will not add them.', state: 'CANCELLED', log } : null;
    }

    if (c.kind === 'confirm_delete') {
      this.convo = { kind: 'idle' };
      if (isYes(transcript)) {
        const gone = this.db.data.contacts.find((x) => x.id === c.contactId);
        if (gone) this.db.deleteContact(gone.id);
        return { reply: gone ? `Removed ${gone.name} from your contacts.` : 'That contact was already removed.', state: 'DONE', log };
      }
      return isNo(transcript) ? { reply: 'Okay, I kept the contact.', state: 'CANCELLED', log } : null;
    }

    if (c.kind === 'split_confirm') {
      this.convo = { kind: 'idle' };
      if (isNo(transcript)) return { reply: 'Okay, I did not send any requests.', state: 'CANCELLED', log };
      if (!isYes(transcript)) return null;
      const name = this.myName();
      const lines: string[] = [];
      for (const p of c.people) {
        this.db.addRequest({ from: p.name, amount: p.amount, note: 'Split bill' });
        lines.push(`${p.name}: ${inr(p.amount)}`);
      }
      const each = c.people[0]?.amount ?? 0;
      const link = requestLink(this.db.data.myUpiId, name, each, 'Split bill via VoicePay');
      const text = `Split bill of ${inr(c.total)} via VoicePay. ${lines.join(', ')}. Pay ${name} here: ${link}`;
      return {
        reply: `Done. I made ${c.people.length} request${c.people.length > 1 ? 's' : ''} of ${inr(each)} each. Choose WhatsApp, SMS or any app to send the message.`,
        state: 'DONE', action: { type: 'share', text, title: 'Split bill' }, log,
      };
    }

    if (c.kind === 'need_topup') {
      const amount = parseAmount(transcript);
      if (amount === null) { this.convo = { kind: 'idle' }; return null; }
      return this.startTopup(amount, c.transcript, log);
    }

    if (c.kind === 'confirm') {
      const p = this.getPending(c.pendingId);
      // A new full command ("EB bill pay pannu", "send 200 to Arun") is never read as a "yes".
      const asNew = parseCommand(transcript);
      const isNewCommand = !upiAppFrom(transcript) && (
        (asNew.intent === 'send_money' && (asNew.name !== null || asNew.amount !== null)) ||
        asNew.intent === 'pay_bill' || asNew.intent === 'check_balance' || asNew.intent === 'get_history' ||
        RULE_FIRST_INTENTS.has(asNew.intent));
      if (p && !p.used && !isNewCommand) {
        if (isNo(transcript)) {
          this.pendings.delete(p.id);
          log.push({ step: 'decision', value: 'cancelled by user' });
          return cancelled();
        }
        // Real mode has no gateway: a plain "yes" for a person/shop opens whichever UPI app the phone picks.
        const upi = upiAppFrom(transcript) ?? (realMode() && p.payee.kind === 'contact' && isYes(transcript) ? 'any' : null);
        if (upi && p.payee.kind === 'contact') {
          log.push({ step: 'decision', value: `confirmed by user, via ${upi}` });
          return { reply: `Opening ${UPI_NAME[upi]} for ${inr(p.amount)}. Enter your UPI PIN there.`, state: 'READY_TO_PAY', pending: toPublic(p), route: { method: 'upi', app: upi }, log };
        }
        if (isYes(transcript) || upi) {
          log.push({ step: 'decision', value: 'confirmed by user' });
          return { reply: `Opening payment for ${inr(p.amount)}.`, state: 'READY_TO_PAY', pending: toPublic(p), log };
        }
      }
      this.convo = { kind: 'idle' };
      return null;
    }

    if (isNo(transcript)) return cancelled();

    if (c.kind === 'choose_contact') {
      const chosen = pickCandidate(transcript, c.candidates);
      log.push({ step: 'choice', value: chosen?.name ?? null });
      if (!chosen) { this.convo = { kind: 'idle' }; return null; }
      const amount = c.amount ?? parseAmount(transcript);
      if (amount === null) {
        this.convo = { kind: 'need_amount', contact: chosen, transcript: c.transcript };
        return { reply: `How much should I send to ${chosen.name}?`, state: 'NEEDS_INFO', log };
      }
      return this.prepare({ kind: 'contact', contact: chosen }, amount, c.transcript, log);
    }

    if (c.kind === 'choose_bill') {
      const chosen = pickSavedBill(transcript, c.candidates);
      log.push({ step: 'choice', value: chosen?.nickname ?? null });
      if (!chosen) { this.convo = { kind: 'idle' }; return null; }
      return this.billFlow(getBiller(chosen.billerId)!, chosen.account, c.amount, c.transcript, log);
    }

    if (c.kind === 'need_amount') {
      const amount = parseAmount(transcript);
      log.push({ step: 'amount', value: amount });
      if (amount === null) { this.convo = { kind: 'idle' }; return null; }
      return this.prepare({ kind: 'contact', contact: c.contact }, amount, c.transcript, log);
    }

    if (c.kind === 'need_name') {
      this.convo = { kind: 'idle' };
      return this.routeSend(transcript, c.amount, c.transcript, log);
    }

    if (c.kind === 'need_plan') {
      const amount = parseAmount(transcript);
      log.push({ step: 'plan', value: amount });
      if (amount === null) { this.convo = { kind: 'idle' }; return null; }
      return this.billFlow(c.biller, c.account, amount, c.transcript, log);
    }
    return null;
  }

  // ---------------- screens: what a blind user "sees" ----------------
  /** Spoken description of a screen. The app also switches to that screen. */
  private describe(screen: Screen): Pick<AgentReply, 'reply' | 'state' | 'action'> {
    const d = this.db.data;
    const action: AgentAction = { type: 'navigate', screen };
    switch (screen) {
      case 'history': {
        const done = d.transactions.filter((t) => t.status === 'success').slice(0, 5);
        if (!done.length) return { reply: 'You have no payments yet.', state: 'DONE', action };
        const list = done.map((t) => `${t.category === 'topup' ? `${inr(t.amount)} added to wallet` : `${inr(t.amount)} to ${t.payeeName}`} on ${fmtDate(t.createdAt)}`).join('; ');
        return { reply: `Your last ${done.length} payment${done.length > 1 ? 's' : ''}: ${list}.`, state: 'DONE', action };
      }
      case 'contacts': {
        const names = d.contacts.map((c) => c.name);
        if (!names.length) return { reply: 'You have no contacts yet. Say "add contact" and I will save one for you.', state: 'DONE', action };
        const first = d.contacts[0];
        return { reply: `You have ${names.length} contacts: ${spokenList(names)}. Say, for example, "send 500 to ${first.nickname ?? first.name}". To save a new person, say "add contact".`, state: 'DONE', action };
      }
      case 'bills': {
        const list = d.savedBills.map((b) => b.nickname);
        if (!list.length) return { reply: 'You have no saved bills yet. Say "add electricity bill" or any bill type and I will save it for you.', state: 'DONE', action };
        return { reply: `You have ${list.length} saved bills: ${spokenList(list)}. Say, for example, "pay ${list[0]}", or say "which bills are due".`, state: 'DONE', action };
      }
      case 'profile':
        return {
          reply: d.kyc.status === 'verified'
            ? `Your KYC is verified for ${d.kyc.name}. ${this.balanceLine()}`
            : realMode() ? 'This is your profile. Payments go through your own UPI app, so no extra KYC is needed.'
            : 'Your KYC is not complete. Say "start KYC" and I will guide you.',
          state: 'DONE', action,
        };
      default:
        return { reply: `You are on the home screen. ${this.balanceLine()} Say what you want to do, or say help.`, state: 'DONE', action };
    }
  }

  // ---------------- guided voice KYC ----------------
  private startKyc(log: Log): AgentReply {
    if (this.db.data.kyc.status === 'verified') {
      return { reply: `Your KYC is already verified for ${this.db.data.kyc.name}.`, state: 'DONE', log };
    }
    this.convo = { kind: 'kyc', step: 'name', data: {}, tries: 0 };
    return { reply: `Let's complete your KYC. It takes about a minute. Say cancel to stop, or wrong if I mishear something. First: ${KYC_Q.name}`, state: 'NEEDS_INFO', sensitive: true, expect: 'name', log };
  }

  private kycStep(transcript: string, c: Extract<Conversation, { kind: 'kyc' }>, log: Log): AgentReply {
    const out = (reply: string, state: AgentState = 'NEEDS_INFO'): AgentReply => ({
      reply, state, sensitive: true, log,
      expect: this.convo.kind === 'kyc' ? KYC_EXPECT[c.step] : undefined,
    });
    if (wantsCancel(transcript)) {
      this.convo = { kind: 'idle' };
      return out('Okay, KYC cancelled. Say start KYC whenever you are ready.', 'CANCELLED');
    }
    // "wrong" / "back": go to the previous question (not possible once the OTP was sent)
    if (/\b(wrong|incorrect|go back|back|previous|thappu|thappa)\b/i.test(transcript) && c.step !== 'name' && c.step !== 'otp') {
      const prev = KYC_ORDER[KYC_ORDER.indexOf(c.step) - 1] as Exclude<KycStep, 'otp'>;
      delete c.data[KYC_FIELD[prev]];
      c.step = prev;
      c.tries = 0;
      return out(`Okay, let's redo that. ${KYC_Q[prev]}`);
    }
    const retry = (why: string, example: string): AgentReply => {
      c.tries++;
      if (c.tries >= 3) {
        this.convo = { kind: 'idle' };
        return out(`${why} I could not get that after three tries, so I stopped. Say start KYC to try again.`, 'ERROR');
      }
      return out(`${why} ${example}`);
    };
    const advance = (step: KycStep, reply: string): AgentReply => { c.step = step; c.tries = 0; return out(reply); };

    switch (c.step) {
      case 'name': {
        const name = nameFromSpeech(transcript);
        const err = validateName(name);
        if (err) return retry(err, 'Please say your full name again.');
        c.data.name = name;
        return advance('dob', `Got it: ${name}. ${KYC_Q.dob}`);
      }
      case 'dob': {
        const dob = parseSpokenDob(transcript);
        const err = dob ? validateDob(dob) : 'I could not understand the date.';
        if (err || !dob) return retry(err ?? 'Invalid date.', 'Say it like: 14 May 2001.');
        c.data.dob = dob;
        const spoken = new Date(dob + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
        return advance('pan', `Date of birth ${spoken}. ${KYC_Q.pan}`);
      }
      case 'pan': {
        const pan = alnumFromSpeech(transcript);
        const err = validatePan(pan);
        if (err) return retry(err, 'Please say your PAN again, one letter or digit at a time.');
        c.data.panMasked = maskPan(pan); // keep only the masked PAN
        return advance('aadhaar', `PAN ${spellDigits(pan.toUpperCase())}. ${KYC_Q.aadhaar}`);
      }
      case 'aadhaar': {
        const a = digitsFromSpeech(transcript);
        const err = validateAadhaar(a);
        if (err) return retry(err, 'Please say all 12 digits again, slowly.');
        c.data.aadhaarLast4 = a.slice(-4); // keep only the last 4 digits
        return advance('mobile', `Aadhaar ending ${spellDigits(a.slice(-4))}. ${KYC_Q.mobile}`);
      }
      case 'mobile': {
        const mobile = digitsFromSpeech(transcript).slice(-10);
        if (!/^[6-9]\d{9}$/.test(mobile)) return retry('A mobile number has 10 digits and starts with 6, 7, 8 or 9.', 'Please say it again.');
        const r = this.kyc.startVerified({ name: c.data.name!, dob: c.data.dob!, panMasked: c.data.panMasked!, aadhaarLast4: c.data.aadhaarLast4!, mobile });
        c.data = {};
        c.sessionId = r.sessionId;
        c.step = 'otp';
        c.tries = 0;
        return out(`I sent a 6 digit OTP to the number ending ${mobile.slice(-4)}. This is demo mode, so here it is: ${spellDigits(r.otp)}. Please say the OTP.`);
      }
      case 'otp': {
        const v = this.kyc.verify(c.sessionId ?? '', digitsFromSpeech(transcript));
        if (v.ok) {
          this.db.setKyc(v.kyc);
          this.convo = { kind: 'idle' };
          return out(`KYC complete. You can now make payments. ${this.balanceLine()}`, 'DONE');
        }
        if (/start again/i.test(v.error)) {
          this.convo = { kind: 'idle' };
          return out(`${v.error} Say start KYC to begin again.`, 'ERROR');
        }
        return out(`${v.error} Please say the OTP again.`);
      }
    }
  }

  // ---------------- people / shops ----------------
  /** "send 500 to Ramesh" · "send 500 to 98765 43210" · "send 500 to ramesh@okaxis" */
  private routeSendCommand(cmd: ParsedCommand, transcript: string, log: Log): AgentReply {
    // "Send 5000 to my other account": your own account is not a contact. Use the bank-transfer steps and say so.
    if (/\b(my|own)\s+(other\s+|another\s+|second\s+|own\s+)?(bank\s+)?account\b|\b(en|ennoda)\s+(innoru|vera|veru|mathu|other)\s*(bank\s*)?account\b|\bto\s+myself\b|\bself\s+transfer\b/i.test(transcript)) {
      this.convo = { kind: 'idle' };
      const r = this.startBank(cmd.amount, transcript, log);
      return { ...r, reply: `This is a transfer to your own other account. ${r.reply}` };
    }
    const written = transcript.match(/\b([a-z0-9._-]{2,})\s*(?:@|at the rate(?: of)?)\s*([a-z][a-z0-9.-]{1,})/i);
    if (written) {
      const upi = upiFromSpeech(`${written[1]} at ${written[2]}`);
      if (upi) return this.payUpiId(upi, cmd.amount, log);
    }
    const phone = phoneFromText(transcript);
    if (phone) {
      const byPhone = this.db.data.contacts.find((c) => c.phone === phone);
      if (byPhone) return this.afterContact(byPhone, cmd.amount, transcript, log);
      this.convo = { kind: 'offer_add', name: null, phone, amount: cmd.amount };
      return { reply: `I don't have ${spellDigits(phone)} saved, and UPI payments need a UPI ID. Do you want to add this person? Say yes or no.`, state: 'NEEDS_INFO', log };
    }
    if (!cmd.name) {
      if (cmd.amount === null) return { reply: 'Who should I pay, and how much? You can also say scan to scan a QR code.', state: 'NEEDS_INFO', log };
      this.convo = { kind: 'need_name', amount: cmd.amount, transcript };
      return { reply: `Who should I send ${inr(cmd.amount)} to?`, state: 'NEEDS_INFO', log };
    }
    return this.routeSend(cmd.name, cmd.amount, transcript, log);
  }

  private routeSend(name: string, amount: number | null, transcript: string, log: Log): AgentReply {
    const matches = matchContacts(name, this.db.data.contacts);
    log.push({ step: 'contact_match', value: matches.map((m) => `${m.contact.name} (${m.score.toFixed(2)})`) });
    // Your own name is not a payee. Offer the own-account transfer instead of paying "yourself" as if you were a contact.
    const me = this.db.data.kyc.status === 'verified' ? this.db.data.kyc.name : undefined;
    if (!matches.length && me && similarity(name.toLowerCase(), me.toLowerCase()) >= 0.8) {
      this.convo = { kind: 'own_acct', amount, transcript };
      return { reply: `${titleCase(name)} is your own name. Do you want to move money to your other bank account? Say yes or no.`, state: 'NEEDS_INFO', log };
    }
    if (!matches.length) {
      this.convo = { kind: 'offer_add', name: titleCase(name), phone: null, amount };
      return { reply: `I couldn't find a contact named ${titleCase(name)}. Do you want to add them? Say yes or no.`, state: 'NEEDS_INFO', log };
    }
    if (matches.length > 1) {
      const candidates = matches.map((m) => m.contact);
      this.convo = { kind: 'choose_contact', candidates, amount, transcript };
      return {
        reply: `I found ${candidates.length} contacts: ${spokenList(candidates.map((x) => x.name))}. Which one?`,
        state: 'AWAITING_CHOICE',
        choices: candidates.map((x) => ({ id: x.id, name: x.name, subtitle: x.upiId })),
        log,
      };
    }
    return this.afterContact(matches[0].contact, amount, transcript, log);
  }

  private afterContact(contact: Contact, amount: number | null, transcript: string, log: Log): AgentReply {
    if (amount === null) {
      this.convo = { kind: 'need_amount', contact, transcript };
      return { reply: `How much should I send to ${contact.name}?`, state: 'NEEDS_INFO', log };
    }
    return this.prepare({ kind: 'contact', contact }, amount, transcript, log);
  }

  /** A UPI ID that is not saved (spoken, or read from a QR code). The payee name is read out before paying. */
  payUpiId(upiId: string, amount: number | null, log: Log, name?: string, from: 'qr' | 'voice' = 'voice'): AgentReply {
    const existing = this.db.data.contacts.find((c) => c.upiId.toLowerCase() === upiId.toLowerCase());
    const contact: Contact = existing ?? {
      id: 'q_' + crypto.createHash('sha256').update(upiId.toLowerCase()).digest('hex').slice(0, 8),
      name: name || upiId.split('@')[0], upiId, type: 'merchant',
    };
    const lead = from === 'qr'
      ? `QR code found: ${contact.name}${existing ? '' : `, UPI ID ${spokenUpi(upiId)}`}. `
      : existing ? '' : `New payee, ${spokenUpi(upiId)}. `;
    log.push({ step: 'payee', value: { upiId, known: !!existing } });
    if (amount === null) {
      this.convo = { kind: 'need_amount', contact, transcript: from };
      return { reply: `${lead}How much should I pay?`, state: 'NEEDS_INFO', log };
    }
    const r = this.prepare({ kind: 'contact', contact }, amount, from, log);
    if (r.state === 'AWAITING_CONFIRMATION') r.reply = lead + r.reply;
    return r;
  }

  /** The app scanned a QR code and sent its text here. */
  payQr(qr: { upiId: string; name: string; amount: number | null }, log: Log = []): AgentReply {
    return this.payUpiId(qr.upiId, qr.amount, log, qr.name, 'qr');
  }

  // ---------------- add / delete contact by voice ----------------
  private startAddContact(name: string | null, phone: string | null, amount: number | null, log: Log): AgentReply {
    const cleaned = name ? nameFromSpeech(name) : '';
    if (cleaned.length >= 2) {
      this.convo = { kind: 'add_contact', step: 'upi', name: cleaned, phone, amount, tries: 0 };
      return { reply: `Okay, adding ${cleaned}. ${ADD_UPI_Q}`, state: 'NEEDS_INFO', expect: 'upi', log };
    }
    this.convo = { kind: 'add_contact', step: 'name', phone, amount, tries: 0 };
    return { reply: "Okay. What is the person's name?", state: 'NEEDS_INFO', expect: 'name', log };
  }

  private addContactStep(transcript: string, c: Extract<Conversation, { kind: 'add_contact' }>, log: Log): AgentReply {
    const ask = (reply: string, expect?: Expect): AgentReply => ({ reply, state: 'NEEDS_INFO', expect, log });
    if (wantsCancel(transcript)) { this.convo = { kind: 'idle' }; return { reply: 'Okay, I did not add anyone.', state: 'CANCELLED', log }; }
    const retry = (why: string, expect: Expect): AgentReply => {
      c.tries++;
      if (c.tries >= 3) { this.convo = { kind: 'idle' }; return { reply: `${why} I could not get that after three tries, so I stopped. Say add contact to try again.`, state: 'ERROR', log }; }
      return ask(why, expect);
    };
    switch (c.step) {
      case 'name': {
        const name = nameFromSpeech(transcript);
        if (name.length < 2) return retry('I did not catch the name. Please say it again.', 'name');
        c.name = name; c.step = 'upi'; c.tries = 0;
        return ask(`Got it: ${name}. ${ADD_UPI_Q}`, 'upi');
      }
      case 'upi': {
        const upi = upiFromSpeech(transcript);
        if (!upi) return retry('I could not understand that UPI ID. Say it like: name at ok axis, or spell it letter by letter.', 'upi');
        const dup = this.db.data.contacts.find((x) => x.upiId.toLowerCase() === upi.toLowerCase());
        if (dup) { this.convo = { kind: 'idle' }; return { reply: `That UPI ID is already saved as ${dup.name}.`, state: 'DONE', log }; }
        c.upiId = upi; c.step = 'confirm'; c.tries = 0;
        return ask(`I heard ${c.name}, UPI ID ${spokenUpi(upi)}. Is that right? Say yes to save, or no to say it again.`);
      }
      case 'confirm': {
        if (isNo(transcript) || /\b(wrong|thappu|thappa)\b/i.test(transcript)) { c.step = 'upi'; c.tries = 0; return ask(`Okay. ${ADD_UPI_Q}`, 'upi'); }
        if (!isYes(transcript)) return ask('Please say yes to save, or no to say the UPI ID again.');
        this.convo = { kind: 'idle' };
        const contact = this.db.addContact({ name: c.name!, upiId: c.upiId!, phone: c.phone ?? undefined, type: 'person' });
        log.push({ step: 'contact_saved', value: contact.name });
        if (c.amount !== null) {
          const r = this.prepare({ kind: 'contact', contact }, c.amount, 'new contact', log);
          if (r.state === 'AWAITING_CONFIRMATION') r.reply = `Saved ${contact.name}. ${r.reply}`;
          return r;
        }
        return { reply: `Saved ${contact.name} as a contact. You can now say "send 500 to ${contact.name.split(' ')[0]}".`, state: 'DONE', log };
      }
    }
  }

  private startDeleteContact(name: string | null, log: Log): AgentReply {
    if (!name) return { reply: 'Which contact should I remove? Say "remove contact" and the name.', state: 'NEEDS_INFO', log };
    const matches = matchContacts(name, this.db.data.contacts);
    if (!matches.length) return { reply: `I couldn't find a contact named ${titleCase(name)}.`, state: 'ERROR', log };
    if (matches.length > 1) {
      return { reply: `I found ${spokenList(matches.map((m) => m.contact.name))}. Please say the full name of the one to remove.`, state: 'NEEDS_INFO', log };
    }
    this.convo = { kind: 'confirm_delete', contactId: matches[0].contact.id };
    return { reply: `Remove ${matches[0].contact.name} from your contacts? Say yes or no.`, state: 'NEEDS_INFO', log };
  }

  // ---------------- bills ----------------
  private routeBill(category: Category | null, account: string | null, amount: number | null, transcript: string, log: Log): AgentReply {
    if (!category) return { reply: 'Which bill? Electricity, mobile recharge, DTH, gas, water, broadband, postpaid, FASTag, credit card, insurance, loan, or property tax?', state: 'NEEDS_INFO', log };
    const label = CATEGORY_LABEL[category];

    // "Mobile recharge" on its own: ask which number and which SIM, then the plan. (Saved bills, a number or an operator named in the sentence skip this.)
    if (category === 'mobile' && !account && !findBiller(transcript, category)
      && !pickSavedBill(transcript, this.db.data.savedBills.filter((b) => b.category === 'mobile'))) {
      return this.startRecharge(amount, transcript, log);
    }

    // Operator / board named in the sentence ("Jio recharge 9876543210 299")
    const named = findBiller(transcript, category);
    let saved = this.db.data.savedBills.filter((b) => b.category === category);
    if (account) saved = saved.filter((b) => b.account === account);
    if (named) saved = saved.filter((b) => b.billerId === named.id);

    if (account && named && !saved.length) return this.billFlow(named, account, amount, transcript, log);
    if (!saved.length) {
      // Nothing saved yet: save it now, by voice, and then pay.
      const intro = account ? `I don't have ${maskAccount(account)} saved for ${label}.` : `You have no saved ${label.toLowerCase()} yet.`;
      const r = this.startAddBill(category, transcript, true, amount, log);
      return { ...r, reply: `${intro} Let me save it first. ${r.reply}` };
    }
    if (saved.length > 1) {
      const byName = pickSavedBill(transcript, saved);
      if (byName) return this.billFlow(getBiller(byName.billerId)!, byName.account, amount, transcript, log);
      this.convo = { kind: 'choose_bill', candidates: saved, amount, transcript };
      return {
        reply: `Which one: ${spokenList(saved.map((b) => b.nickname))}?`,
        state: 'AWAITING_CHOICE',
        choices: saved.map((b) => ({ id: b.id, name: b.nickname, subtitle: `${getBiller(b.billerId)?.name ?? b.billerId} • ${maskAccount(b.account)}` })),
        log,
      };
    }
    return this.billFlow(getBiller(saved[0].billerId)!, saved[0].account, amount, transcript, log);
  }

  // ---------------- mobile recharge: which number, which SIM ----------------
  private startRecharge(amount: number | null, transcript: string, log: Log): AgentReply {
    this.convo = { kind: 'recharge', step: 'number', amount, transcript, tries: 0 };
    return { reply: 'Opening recharge. Which number should I recharge? Say "my number", or say the 10 digit mobile number.', state: 'NEEDS_INFO', expect: 'digits', action: { type: 'navigate', screen: 'bills', category: 'mobile' }, log };
  }

  private rechargeStep(transcript: string, c: Extract<Conversation, { kind: 'recharge' }>, log: Log): AgentReply {
    if (wantsCancel(transcript)) { this.convo = { kind: 'idle' }; return { reply: 'Okay, recharge cancelled.', state: 'CANCELLED', log }; }
    const retry = (why: string, expect?: Expect): AgentReply => {
      c.tries++;
      if (c.tries >= 3) { this.convo = { kind: 'idle' }; return { reply: `${why} I could not get that, so I stopped. Say mobile recharge to try again.`, state: 'ERROR', log }; }
      return { reply: why, state: 'NEEDS_INFO', expect, log };
    };
    if (c.step === 'number') {
      const own = this.db.data.kyc.mobile ?? this.db.data.savedBills.find((b) => b.category === 'mobile')?.account;
      if (/\b(my|own)\s+(number|phone|mobile|sim)\b|\b(en|ennoda|enakku?)\b.*\b(number|phone|mobile|sim)\b|\b(en|ennoda)\s+(number|phone|mobile|sim|nambar)\b/i.test(transcript) && own) {
        c.account = own;
      } else {
        const acct = digitsFromSpeech(transcript);
        if (!/^[6-9]\d{9}$/.test(acct)) return retry(own ? 'I did not get a 10 digit number. Say "my number", or say the number digit by digit.' : 'I did not get a 10 digit mobile number. Say it digit by digit.', 'digits');
        c.account = acct;
      }
      c.step = 'operator'; c.tries = 0;
      log.push({ step: 'recharge_number', value: maskAccount(c.account) });
      return { reply: `Recharging ${spellDigits(c.account.slice(-4))} at the end. Which SIM is it: Airtel, Jio, Vi or BSNL?`, state: 'NEEDS_INFO', log };
    }
    const biller = findBiller(transcript, 'mobile');
    if (!biller) return retry('I did not get the SIM. Say Airtel, Jio, Vi or BSNL.');
    this.convo = { kind: 'idle' };
    return this.billFlow(biller, c.account!, c.amount, c.transcript, log);
  }

  /** Validate account → fetch bill → pick amount → prepare. Also used by the Bills screen. */
  billFlow(biller: Biller, account: string, amount: number | null, transcript: string, log: Log): AgentReply {
    this.convo = { kind: 'idle' };
    const err = validateAccount(biller, account);
    if (err) return { reply: err, state: 'ERROR', log };
    const bill = fetchBill(biller, account);
    const cat = biller.category;
    log.push({ step: 'bill_fetch', value: { biller: biller.id, account: maskAccount(account), amount: bill.amount, note: bill.note } });
    const payee = (): Payee => ({ kind: 'bill', category: cat, biller, account: bill.account, bill });

    if (NO_DUPLICATE_CATEGORIES.includes(cat)) {
      const paid = this.db.recentlyPaid(biller.id, bill.account);
      if (paid) {
        const what = cat === 'gas' ? 'A cylinder was already booked' : 'This bill was already paid';
        return { reply: `${what} on ${new Date(paid.createdAt).toLocaleDateString('en-IN')} (ref ${paid.refId}). No dues now.`, state: 'DONE', log };
      }
    }

    // Bill amount comes from the biller, not from what was spoken.
    if (cat === 'creditcard') {
      const total = bill.amount!, min = bill.minDue!;
      let pay = total;
      if (/\b(minimum|min due|min)\b/i.test(transcript)) pay = min;
      else if (amount !== null && amount >= min && amount <= total) pay = amount;
      return this.prepare(payee(), pay, transcript, log);
    }
    if (isDueCategory(cat)) return this.prepare(payee(), bill.amount!, transcript, log);

    // FASTag: any amount in range
    if (cat === 'fastag') {
      if (amount === null || amount < TOPUP_MIN || amount > TOPUP_MAX) {
        this.convo = { kind: 'need_plan', biller, account: bill.account, transcript };
        return { reply: `How much should I add to the FASTag? Between ${inr(TOPUP_MIN)} and ${inr(TOPUP_MAX)}.`, state: 'NEEDS_INFO', log };
      }
      return this.prepare(payee(), amount, transcript, log);
    }

    // Mobile / DTH recharge: must be one of the operator's plans.
    const plans = biller.plans ?? [];
    const planList = plans.map((p) => inr(p.amount)).join(', ');
    if (amount === null) {
      this.convo = { kind: 'need_plan', biller, account: bill.account, transcript };
      return { reply: `${biller.name} plans: ${planList}. Which plan?`, state: 'NEEDS_INFO', log };
    }
    if (!isValidPlanAmount(biller, amount)) {
      this.convo = { kind: 'need_plan', biller, account: bill.account, transcript };
      return { reply: `${inr(amount)} is not a ${biller.name} plan. Choose from ${planList}.`, state: 'NEEDS_INFO', log };
    }
    return this.prepare(payee(), amount, transcript, log);
  }

  // ---------------- add a bill account by voice ----------------
  private startAddBill(category: Category | null, transcript: string, payAfter: boolean, amount: number | null, log: Log): AgentReply {
    const c: Extract<Conversation, { kind: 'add_bill' }> = { kind: 'add_bill', step: 'category', payAfter, amount, transcript, tries: 0 };
    this.convo = c;
    if (category) {
      c.category = category;
      const named = findBiller(transcript, category);
      if (named) c.billerId = named.id;
      const acct = category === 'fastag' ? extractVehicle(transcript) : extractAccount(transcript);
      if (acct && named && !validateAccount(named, acct)) c.account = acct;
    }
    return this.nextAddBillQuestion(c, log);
  }

  /** Skips the steps that are already answered and asks the next one. */
  private nextAddBillQuestion(c: Extract<Conversation, { kind: 'add_bill' }>, log: Log): AgentReply {
    const ask = (reply: string, expect?: Expect): AgentReply => ({ reply, state: 'NEEDS_INFO', expect, log });
    if (!c.category) {
      c.step = 'category';
      return ask('Which bill do you want to save? Electricity, water, mobile recharge, DTH, gas, broadband, postpaid, FASTag, credit card, insurance, loan, or property tax?');
    }
    if (!c.billerId) {
      const list = BILLERS.filter((b) => b.category === c.category);
      if (list.length === 1) c.billerId = list[0].id;
      else {
        c.step = 'biller';
        return ask(`Which provider? ${spokenList(list.map(shortName))}?`);
      }
    }
    const biller = getBiller(c.billerId!)!;
    if (!c.account) {
      c.step = 'account';
      const how = c.category === 'fastag' ? 'Say the vehicle number, letter by letter, for example T N 0 9 A B 1 2 3 4.' : 'Say the number digit by digit.';
      return ask(`${shortName(biller)}. What is the ${biller.accountLabel}? ${how}`, c.category === 'fastag' ? 'letters' : 'digits');
    }
    if (!c.nickname) {
      c.step = 'nickname';
      return ask('What should I call it? For example, Home EB. Say skip to use the provider name.', 'name');
    }
    c.step = 'confirm';
    return ask(`Save ${c.nickname}: ${biller.name}, account ending ${spellDigits(c.account.slice(-4))}. Say yes to save, or no to cancel.`);
  }

  private addBillStep(transcript: string, c: Extract<Conversation, { kind: 'add_bill' }>, log: Log): AgentReply {
    if (wantsCancel(transcript) && c.step !== 'nickname') { this.convo = { kind: 'idle' }; return { reply: 'Okay, I did not save it.', state: 'CANCELLED', log }; }
    const retry = (why: string): AgentReply => {
      c.tries++;
      if (c.tries >= 3) { this.convo = { kind: 'idle' }; return { reply: `${why} I could not get that after three tries, so I stopped. Say add bill to try again.`, state: 'ERROR', log }; }
      return { reply: why, state: 'NEEDS_INFO', log, expect: c.step === 'account' ? (c.category === 'fastag' ? 'letters' : 'digits') : undefined };
    };
    switch (c.step) {
      case 'category': {
        const cat = detectCategory2(transcript);
        if (!cat) return retry('I did not get the bill type. Say, for example, electricity or credit card.');
        c.category = cat; c.tries = 0;
        break;
      }
      case 'biller': {
        const b = findBiller(transcript, c.category!);
        if (!b) return retry(`I did not get the provider. Choose from ${spokenList(BILLERS.filter((x) => x.category === c.category).map(shortName))}.`);
        c.billerId = b.id; c.tries = 0;
        break;
      }
      case 'account': {
        const biller = getBiller(c.billerId!)!;
        const acct = c.category === 'fastag' ? (extractVehicle(transcript) ?? alnumFromSpeech(transcript)) : digitsFromSpeech(transcript);
        const err = validateAccount(biller, acct);
        if (err) return retry(`${err} Please say it again.`);
        c.account = acct.toUpperCase(); c.tries = 0;
        break;
      }
      case 'nickname': {
        const skip = /^\s*(skip|no|default|same|vendaam|venaam)\b/i.test(transcript);
        const nick = skip ? shortName(getBiller(c.billerId!)!) : nameFromSpeech(transcript).slice(0, 30);
        if (nick.length < 2) return retry('Please say a short name, or say skip.');
        c.nickname = nick; c.tries = 0;
        break;
      }
      case 'confirm': {
        if (isNo(transcript)) { this.convo = { kind: 'idle' }; return { reply: 'Okay, I did not save it.', state: 'CANCELLED', log }; }
        if (!isYes(transcript)) return { reply: 'Please say yes to save, or no to cancel.', state: 'NEEDS_INFO', log };
        const biller = getBiller(c.billerId!)!;
        this.convo = { kind: 'idle' };
        if (this.db.data.savedBills.some((b) => b.billerId === biller.id && b.account === c.account)) {
          return { reply: 'That account is already saved.', state: 'DONE', log };
        }
        const saved = this.db.addSavedBill({ category: biller.category, billerId: biller.id, account: c.account!, nickname: c.nickname! });
        log.push({ step: 'bill_saved', value: saved.nickname });
        if (c.payAfter) {
          const r = this.billFlow(biller, saved.account, c.amount, c.transcript, log);
          return { ...r, reply: `Saved ${saved.nickname}. ${r.reply}` };
        }
        return { reply: `Saved ${saved.nickname}. You can now say "pay ${saved.nickname}".`, state: 'DONE', log };
      }
    }
    return this.nextAddBillQuestion(c, log);
  }

  // ---------------- wallet: add money, limits ----------------
  private startTopup(amount: number | null, transcript: string, log: Log): AgentReply {
    if (amount === null) {
      this.convo = { kind: 'need_topup', transcript };
      return { reply: `How much do you want to add to your wallet? Up to ${inr(LIMITS.perTransfer)}.`, state: 'NEEDS_INFO', log };
    }
    return this.prepare({ kind: 'topup' }, amount, transcript, log);
  }

  private limits(log: Log): AgentReply {
    const spent = this.db.spentToday();
    return {
      reply: `Your limit is ${inr(LIMITS.perTransfer)} for one payment and ${inr(LIMITS.perDay)} per day. Today you have paid ${inr(spent)}, so ${inr(Math.max(0, LIMITS.perDay - spent))} is left. ${this.balanceLine()}`,
      state: 'DONE', log,
    };
  }

  /** Real mode has no wallet: say what was paid today instead of a made-up balance. */
  private balanceLine(): string {
    return realMode() ? `Today you have paid ${inr(this.db.spentToday())}.` : `Your balance is ${inr(this.db.data.balance)}.`;
  }

  // ---------------- bank transfer (account number + IFSC) ----------------
  private startBank(amount: number | null, transcript: string, log: Log): AgentReply {
    this.convo = { kind: 'bank', step: 'name', amount, transcript, tries: 0 };
    return { reply: "Okay, a bank transfer. What is the account holder's name?", state: 'NEEDS_INFO', sensitive: true, expect: 'name', log };
  }

  private bankStep(transcript: string, c: Extract<Conversation, { kind: 'bank' }>, log: Log): AgentReply {
    const out = (reply: string, expect?: Expect, state: AgentState = 'NEEDS_INFO'): AgentReply => ({ reply, state, sensitive: true, log, expect });
    if (wantsCancel(transcript)) { this.convo = { kind: 'idle' }; return out('Okay, bank transfer cancelled.', undefined, 'CANCELLED'); }
    const retry = (why: string, expect: Expect): AgentReply => {
      c.tries++;
      if (c.tries >= 3) { this.convo = { kind: 'idle' }; return out(`${why} I could not get that after three tries, so I stopped. Say bank transfer to try again.`, undefined, 'ERROR'); }
      return out(why, expect);
    };
    if (/\b(wrong|thappu|thappa|go back|back)\b/i.test(transcript) && c.step !== 'name') {
      const prev = c.step === 'ifsc' ? 'account' : c.step === 'amount' ? 'ifsc' : 'name';
      c.step = prev; c.tries = 0;
      return out(`Okay, let's redo that. ${BANK_Q[prev]}`, BANK_EXPECT[prev]);
    }
    switch (c.step) {
      case 'name': {
        const name = nameFromSpeech(transcript);
        if (name.length < 2) return retry("I did not catch the name. Please say the account holder's name.", 'name');
        c.name = name; c.step = 'account'; c.tries = 0;
        return out(`Got it: ${name}. ${BANK_Q.account}`, 'digits');
      }
      case 'account': {
        const a = digitsFromSpeech(transcript);
        if (!/^\d{9,18}$/.test(a)) return retry('A bank account number has 9 to 18 digits. Please say it again, slowly.', 'digits');
        c.account = a; c.step = 'ifsc'; c.tries = 0;
        return out(`Account ending ${spellDigits(a.slice(-4))}. ${BANK_Q.ifsc}`, 'letters');
      }
      case 'ifsc': {
        const ifsc = ifscFromSpeech(transcript);
        if (!ifsc) return retry('An IFSC code is 4 letters, then 0, then 6 letters or digits. Please say it again, one character at a time.', 'letters');
        c.ifsc = ifsc; c.tries = 0;
        if (c.amount === null) { c.step = 'amount'; return out(`IFSC ${spellDigits(ifsc)}. ${BANK_Q.amount}`); }
        break;
      }
      case 'amount': {
        const amount = parseAmount(transcript);
        if (amount === null) return retry('I did not catch the amount.', 'digits');
        c.amount = amount;
        break;
      }
    }
    const { name, account, ifsc, amount, transcript: t } = c;
    this.convo = { kind: 'idle' };
    const r = this.prepare({ kind: 'bank', name: name!, account: account!, ifsc: ifsc! }, amount!, t, log);
    return { ...r, sensitive: false };
  }

  // ---------------- request money, split a bill ----------------
  private myName() {
    return this.db.data.kyc.status === 'verified' && this.db.data.kyc.name ? this.db.data.kyc.name : 'VoicePay user';
  }

  private requestMoney(name: string | null, amount: number | null, log: Log): AgentReply {
    if (!name || amount === null) {
      return { reply: 'Whom should I request money from, and how much? Say, for example, "request 500 from Priya".', state: 'NEEDS_INFO', log };
    }
    if (amount > LIMITS.perTransfer) return { reply: `A request can be up to ${inr(LIMITS.perTransfer)}.`, state: 'ERROR', log };
    const match = matchContacts(name, this.db.data.contacts)[0]?.contact;
    const from = match?.name ?? titleCase(name);
    this.db.addRequest({ from, amount, note: 'Payment request' });
    const me = this.myName();
    const link = requestLink(this.db.data.myUpiId, me, amount, `Request from ${me}`);
    const text = `${me} requested ${inr(amount)} from ${from} via VoicePay. Pay here: ${link}`;
    return {
      reply: `I made a request for ${inr(amount)} from ${from}. Choose WhatsApp, SMS or any app to send them the payment link.`,
      state: 'DONE', action: { type: 'share', text, title: 'Payment request' }, log,
    };
  }

  private startSplit(transcript: string, amount: number | null, log: Log): AgentReply {
    if (amount === null) return { reply: 'How much is the bill, and who is it split with? Say, for example, "split 1200 between me, Ramesh and Priya".', state: 'NEEDS_INFO', log };
    const t = transcript.toLowerCase();
    const seg = (t.match(/\b(?:between|among|with)\b(.*)$/)?.[1] ?? t.replace(/^.*\bsplit\b/, '')).replace(/[\d.,₹]+/g, ' ');
    const chunks = seg.split(/,|&|\band\b/).map((x) => x.trim()).filter(Boolean);
    const meWords = /^(me|myself|i|us|nan|naan)$/;
    const hasMe = chunks.some((x) => x.split(/\s+/).some((w) => meWords.test(w)));
    const people: string[] = [];
    for (const chunk of chunks) {
      const name = extractName(chunk.split(/\s+/).filter((w) => !meWords.test(w)).join(' '));
      if (!name) continue;
      const m = matchContacts(name, this.db.data.contacts)[0]?.contact;
      people.push(m?.name ?? titleCase(name));
    }
    const unique = [...new Set(people)];
    if (!unique.length) return { reply: 'Who is the bill split with? Say, for example, "split 1200 between me, Ramesh and Priya".', state: 'NEEDS_INFO', log };
    const share = hasMe || !/\b(without me|except me)\b/.test(t);
    const count = unique.length + (share ? 1 : 0);
    const each = Math.round((amount / count) * 100) / 100;
    this.convo = { kind: 'split_confirm', people: unique.map((name) => ({ name, amount: each })), total: amount };
    return {
      reply: `Splitting ${inr(amount)} between ${share ? 'you and ' : ''}${spokenList(unique)}: each pays ${inr(each)}. Should I send payment requests to ${spokenList(unique)}? Say yes or no.`,
      state: 'NEEDS_INFO', log,
    };
  }

  // ---------------- summaries: dues, spending, last payment, repeat, receipt ----------------
  private checkDues(log: Log): AgentReply {
    const rows: Array<{ nick: string; amount: number; due?: string }> = [];
    for (const s of this.db.data.savedBills) {
      const biller = getBiller(s.billerId);
      if (!biller || !isDueCategory(biller.category)) continue;
      if (NO_DUPLICATE_CATEGORIES.includes(biller.category) && this.db.recentlyPaid(biller.id, s.account)) continue;
      const b = fetchBill(biller, s.account);
      if (b.amount !== null) rows.push({ nick: s.nickname, amount: b.amount, due: b.dueDate });
    }
    if (!rows.length) return { reply: 'Good news. None of your saved bills are due right now.', state: 'DONE', log };
    rows.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const list = rows.slice(0, 6).map((r) => `${r.nick}, ${inr(r.amount)}${r.due ? `, due ${fmtDate(r.due)}` : ''}`).join('; ');
    return {
      reply: `You have ${rows.length} bill${rows.length > 1 ? 's' : ''} due: ${list}. Total ${inr(total)}. Say pay, and the bill name.`,
      state: 'DONE', log,
    };
  }

  private spending(transcript: string, log: Log): AgentReply {
    const t = transcript.toLowerCase();
    const days = /\b(today|innaiku|indru)\b/.test(t) ? 1 : /\bweek\b/.test(t) ? 7 : /\byear\b/.test(t) ? 365 : 30;
    const label = days === 1 ? 'today' : days === 7 ? 'in the last 7 days' : days === 365 ? 'in the last year' : 'in the last 30 days';
    const since = days === 1 ? new Date().toISOString().slice(0, 10) : new Date(Date.now() - days * 864e5).toISOString();
    const paid = this.db.data.transactions.filter((x) => x.status === 'success' && x.category !== 'topup' && x.createdAt >= since);
    if (!paid.length) return { reply: `You have not paid anything ${label}.`, state: 'DONE', log };
    const total = paid.reduce((s, x) => s + x.amount, 0);
    const by = new Map<string, number>();
    for (const x of paid) {
      const k = x.category === 'transfer' || x.category === 'bank' ? 'transfers' : CATEGORY_LABEL[x.category as Category].toLowerCase();
      by.set(k, (by.get(k) ?? 0) + x.amount);
    }
    const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${inr(v)} on ${k}`);
    return { reply: `${label[0].toUpperCase() + label.slice(1)} you paid ${inr(total)} in ${paid.length} payment${paid.length > 1 ? 's' : ''}: ${spokenList(top)}.`, state: 'DONE', log };
  }

  private lastSuccess(): Transaction | undefined {
    return this.db.data.transactions.find((x) => x.status === 'success');
  }

  private lastPayment(log: Log): AgentReply {
    const t = this.lastSuccess();
    if (!t) return { reply: 'You have no payments yet.', state: 'DONE', log };
    const what = t.category === 'topup' ? `You added ${inr(t.amount)} to your wallet` : `Your last payment was ${inr(t.amount)} to ${t.payeeName}`;
    return { reply: `${what} on ${fmtDate(t.createdAt)}. Reference ${t.refId}.`, state: 'DONE', log };
  }

  private shareReceipt(log: Log): AgentReply {
    const t = this.lastSuccess();
    if (!t) return { reply: 'You have no payments yet, so there is no receipt.', state: 'DONE', log };
    const to = t.category === 'topup' ? 'your VoicePay wallet' : t.payeeName;
    const text = `VoicePay receipt: ${inr(t.amount)} ${t.category === 'topup' ? 'added to' : 'paid to'} ${to} on ${new Date(t.createdAt).toLocaleDateString('en-IN')}. Reference ${t.refId}.`;
    return { reply: 'I made the receipt for your last payment. Choose where to send it.', state: 'DONE', action: { type: 'share', text, title: 'Payment receipt' }, log };
  }

  /** "Pay again": same payee, same amount as the last successful payment. Still asks to confirm. */
  private payAgain(log: Log): AgentReply {
    const t = this.db.data.transactions.find((x) => x.status === 'success' && x.category !== 'topup');
    if (!t) return { reply: 'You have no earlier payment to repeat.', state: 'DONE', log };
    if (t.category === 'transfer') {
      const saved = this.db.data.contacts.find((c) => c.id === t.contactId || c.upiId.toLowerCase() === t.payeeRef.toLowerCase());
      if (saved) return this.prepare({ kind: 'contact', contact: saved }, t.amount, 'pay again', log);
      if (UPI_LIKE.test(t.payeeRef)) return this.payUpiId(t.payeeRef, t.amount, log, t.payeeName);
    }
    if (t.billerId && t.accountKey) {
      const biller = getBiller(t.billerId);
      const s = this.db.data.savedBills.find((b) => b.billerId === t.billerId && accountKeyOf(b) === t.accountKey);
      if (biller && s) return this.billFlow(biller, s.account, t.amount, 'pay again', log);
    }
    return { reply: `I can't repeat the payment to ${t.payeeName} automatically. Please say the full command.`, state: 'ERROR', log };
  }

  // ---------------- common checks ----------------
  prepare(payee: Payee, amountRaw: number, transcript: string, log: Log): AgentReply {
    this.convo = { kind: 'idle' };
    if (realMode() && payee.kind !== 'contact') {
      return { reply: "Bill payments, bank transfers and wallet top-ups aren't connected yet. I can send money to your contacts and to shops by UPI, or scan a QR code.", state: 'ERROR', log };
    }
    if (!realMode() && this.db.data.kyc.status !== 'verified') {
      return { reply: 'Please complete your KYC before making payments. Say "start KYC" and I will guide you step by step.', state: 'KYC_REQUIRED', log };
    }
    const amount = Math.round(amountRaw * 100) / 100;
    if (!(amount > 0)) return { reply: 'The amount must be more than zero.', state: 'ERROR', log };
    if (amount > LIMITS.perTransfer) return { reply: `The limit is ${inr(LIMITS.perTransfer)} per payment.`, state: 'ERROR', log };
    if (payee.kind !== 'topup') {
      if (this.db.spentToday() + amount > LIMITS.perDay) {
        return { reply: `That would cross your daily limit of ${inr(LIMITS.perDay)}.`, state: 'ERROR', log };
      }
      // Demo gateway: the mock wallet tops itself up, so a mock payment never fails for lack of money.
      if (!realMode() && razorpayEnabled() && amount > this.db.data.balance) {
        return { reply: `Your balance is ${inr(this.db.data.balance)}. You can't pay ${inr(amount)}. Say "add money" to top up your wallet.`, state: 'ERROR', log };
      }
    }
    const p: Pending = { id: 'p_' + crypto.randomBytes(6).toString('hex'), payee, amount, transcript, createdAt: Date.now(), used: false };
    this.pendings.set(p.id, p);
    this.convo = { kind: 'confirm', pendingId: p.id };
    const pub = toPublic(p);
    log.push({ step: 'pending', value: pub });
    const via = payee.kind === 'contact'
      ? (realMode() ? ' Say Google Pay, PhonePe or Paytm to pay, or say no.' : ' Say yes to pay by gateway, or say Google Pay, PhonePe or Paytm.')
      : ' Say yes or no.';
    return { reply: `${confirmQuestion(payee, amount)}?${via}`, state: 'AWAITING_CONFIRMATION', pending: pub, log };
  }
}

function confirmQuestion(payee: Payee, amount: number): string {
  switch (payee.kind) {
    case 'contact': return `Send ${inr(amount)} to ${payee.contact.name}`;
    case 'topup': return `Add ${inr(amount)} to your wallet`;
    case 'bank': return `Send ${inr(amount)} to ${payee.name}, bank account ending ${spellDigits(payee.account.slice(-4))}, bank code ${payee.ifsc.slice(0, 4)}`;
    case 'bill': {
      const { biller, bill, category } = payee;
      const due = bill.dueDate ? `, due ${fmtDate(bill.dueDate)}` : '';
      if (category === 'gas') return `Book a gas cylinder with ${biller.name} for ${inr(amount)}`;
      if (category === 'mobile' || category === 'dth') return `Recharge ${maskAccount(payee.account)} on ${biller.name} for ${inr(amount)}`;
      if (category === 'fastag') return `Add ${inr(amount)} to the ${biller.name} for vehicle ${payee.account.split('').join(' ')}`;
      if (category === 'creditcard') {
        const part = bill.amount !== null && amount < bill.amount ? ` (the total due is ${inr(bill.amount)}, minimum ${inr(bill.minDue ?? 0)})` : ' (total due)';
        return `Pay ${inr(amount)} on your ${shortName(biller)}${part}`;
      }
      return `Pay ${shortName(biller)} ${CATEGORY_LABEL[category].toLowerCase()} of ${inr(amount)}${due}`;
    }
  }
}

export function toPublic(p: Pending): PublicPending {
  const { payee } = p;
  if (payee.kind === 'contact') {
    return { id: p.id, amount: p.amount, kind: 'contact', category: 'transfer', title: payee.contact.name, subtitle: payee.contact.upiId, upiAllowed: true };
  }
  if (payee.kind === 'topup') {
    return { id: p.id, amount: p.amount, kind: 'topup', category: 'topup', title: 'Add money to wallet', subtitle: 'VoicePay wallet', upiAllowed: false };
  }
  if (payee.kind === 'bank') {
    return {
      id: p.id, amount: p.amount, kind: 'bank', category: 'bank', title: payee.name,
      subtitle: `Bank account ${maskAccount(payee.account)} • ${payee.ifsc}`, upiAllowed: false,
      details: [{ label: 'Account number', value: maskAccount(payee.account) }, { label: 'IFSC', value: payee.ifsc }, { label: 'Source', value: 'Simulated bank transfer (demo)' }],
    };
  }
  const b = payee.bill;
  const details: { label: string; value: string }[] = [{ label: payee.biller.accountLabel, value: maskAccount(payee.account) }];
  if (b.billNumber) details.push({ label: 'Bill number', value: b.billNumber });
  if (b.units) details.push({ label: 'Units', value: String(b.units) });
  if (b.dueDate) details.push({ label: 'Due date', value: b.dueDate });
  if (b.minDue) details.push({ label: 'Minimum due', value: inr(b.minDue) });
  const plan = payee.biller.plans?.find((x) => x.amount === p.amount);
  if (plan) details.push({ label: 'Plan', value: `${plan.benefit}, ${plan.validity}` });
  details.push({ label: 'Source', value: b.note });
  return {
    id: p.id, amount: p.amount, kind: 'bill', category: payee.category, title: payee.biller.name,
    subtitle: `${CATEGORY_LABEL[payee.category]} • ${maskAccount(payee.account)}`, upiAllowed: false, details,
  };
}

/** Operator / board named in a sentence ("jio", "bescom", "hdfc card"). */
const BILLER_KEYS: Record<string, RegExp> = {
  jio: /\bjio\b/, airtel: /\bairtel\b(?!.*\b(dth|tv)\b)/, vi: /\b(vi|vodafone|idea)\b/, bsnl: /\bbsnl\b/,
  tataplay: /\btata ?play|tata sky\b/, airteldth: /\bairtel\b.*\b(dth|tv)\b|\b(dth|tv)\b.*\bairtel\b/, sundirect: /\bsun ?direct\b/, dishtv: /\bdish\b/,
  indane: /\bindane\b/, hpgas: /\bhp\b/, bharatgas: /\bbharat\b/,
  jiopost: /\bjio\b/, airtelpost: /\bairtel\b/, vipost: /\b(vi|vodafone|idea)\b/, bsnlpost: /\bbsnl\b/,
  sbiftag: /\bsbi\b/, iciciftag: /\bicici\b/, hdfcftag: /\bhdfc\b/, airtelftag: /\bairtel\b/,
  hdfccard: /\bhdfc\b/, sbicard: /\bsbi\b/, icicicard: /\bicici\b/, axiscard: /\baxis\b/,
  cmwssb: /\b(chennai|metro ?water)\b/, bwssb: /\b(bwssb|bangalore|bengaluru)\b/, twad: /\btwad\b/, hmwssb: /\b(hmwssb|hyderabad)\b/,
  lic: /\blic\b/, hdfclife: /\bhdfc\b/, starhealth: /\bstar\b/, bajajfin: /\bbajaj\b/, hdfcloan: /\bhdfc\b/,
  'gcc-tax': /\b(chennai|gcc)\b/, 'bbmp-tax': /\b(bbmp|bangalore|bengaluru)\b/,
  tnpdcl: /\b(tnpdcl|tangedco|tneb|eb)\b/, bescom: /\bbescom\b/, kseb: /\bkseb\b/, msedcl: /\b(msedcl|mahavitaran)\b/, 'adani-mum': /\badani\b/,
};
const GENERIC_WORDS = new Set([
  'bank', 'prepaid', 'postpaid', 'credit', 'card', 'fastag', 'tamil', 'nadu', 'premium', 'insurance', 'broadband', 'landline',
  'finance', 'emi', 'loan', 'property', 'tax', 'corporation', 'electricity', 'water', 'india', 'life', 'health', 'payments', 'fiber', 'digital',
]);

export function findBiller(text: string, category: Category): Biller | null {
  const t = text.toLowerCase();
  const cands = BILLERS.filter((b) => b.category === category);
  for (const b of cands) if (BILLER_KEYS[b.id]?.test(t)) return b;
  for (const b of cands) {
    const words = b.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return b;
  }
  return null;
}

/** Bill type from a short spoken answer ("water", "credit card", "EB"). */
function detectCategory2(text: string): Category | null {
  const t = text.toLowerCase();
  const table: Array<[RegExp, Category]> = [
    [/post ?paid/, 'postpaid'], [/fast ?-?t?ag|toll/, 'fastag'], [/credit|card/, 'creditcard'], [/broadband|wi-?fi|internet|fib(er|re)|landline/, 'broadband'],
    [/water|thanni|kudineer/, 'water'], [/insurance|lic|premium|policy/, 'insurance'], [/loan|emi/, 'loan'], [/tax|municipal/, 'tax'],
    [/electric|\beb\b|current|power|light/, 'electricity'], [/gas|cylinder|lpg/, 'gas'], [/dth|\btv\b|cable|dish/, 'dth'],
    [/recharge|mobile|prepaid|phone|jio|airtel|vodafone|bsnl/, 'mobile'],
  ];
  for (const [re, c] of table) if (re.test(t)) return c;
  return null;
}

function pickSavedBill(answer: string, saved: SavedBill[]): SavedBill | null {
  const t = answer.toLowerCase();
  const ordinals: Array<[RegExp, number]> = [[/\b(third|3rd|three)\b/, 2], [/\b(second|2nd|two|rendavathu)\b/, 1], [/\b(first|1st|one|mudhal)\b/, 0]];
  for (const [re, i] of ordinals) if (re.test(t) && saved[i]) return saved[i];
  const acc = extractAccount(answer);
  if (acc) { const byAcc = saved.find((b) => b.account === acc); if (byAcc) return byAcc; }
  let best: { b: SavedBill; s: number } | null = null;
  const words = t.split(/[^a-z]+/).filter((w) => w.length > 1);
  for (const b of saved) {
    const parts = [b.nickname, ...b.nickname.split(/\s+/), getBiller(b.billerId)?.name.split(' ')[0] ?? ''].filter((p) => p.length > 1);
    const distinct = parts.filter((p) => !saved.some((o) => o !== b && o.nickname.toLowerCase().includes(p.toLowerCase())));
    for (const w of words) for (const p of distinct) {
      const s = similarity(w, p);
      if (s >= 0.8 && (!best || s > best.s)) best = { b, s };
    }
  }
  return best?.b ?? null;
}

const accountKeyOf = (b: SavedBill) =>
  crypto.createHash('sha256').update(b.billerId + ':' + b.account.replace(/\s+/g, '')).digest('hex').slice(0, 24);
const UPI_LIKE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;
const wantsCancel = (t: string) => /\b(cancel|stop|exit|quit|venaam|vendaam|leave it)\b/i.test(t);

const spokenList = (names: string[]) =>
  names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} or ${names[1]}` : names.slice(0, -1).join(', ') + ', or ' + names.at(-1);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

const ADD_UPI_Q = 'Say their UPI ID, for example: ramesh at ok axis.';
const BANK_Q = {
  name: "What is the account holder's name?",
  account: 'Say the bank account number, digit by digit.',
  ifsc: 'Now the IFSC code, one letter or digit at a time. For example: H D F C zero zero zero one two three four.',
  amount: 'How much should I send?',
} as const;
const BANK_EXPECT: Record<'name' | 'account' | 'ifsc' | 'amount', Expect> = { name: 'name', account: 'digits', ifsc: 'letters', amount: 'digits' };

const KYC_ORDER: KycStep[] = ['name', 'dob', 'pan', 'aadhaar', 'mobile', 'otp'];
const KYC_FIELD: Record<Exclude<KycStep, 'otp'>, 'name' | 'dob' | 'panMasked' | 'aadhaarLast4'> = {
  name: 'name', dob: 'dob', pan: 'panMasked', aadhaar: 'aadhaarLast4', mobile: 'name',
};
const KYC_EXPECT: Record<KycStep, Expect> = {
  name: 'name', dob: 'dob', pan: 'letters', aadhaar: 'digits', mobile: 'digits', otp: 'digits',
};
const KYC_Q: Record<Exclude<KycStep, 'otp'>, string> = {
  name: 'What is your full name, as on your PAN card?',
  dob: 'What is your date of birth? For example, 14 May 2001.',
  pan: 'Say your PAN number, one letter or digit at a time, for example: A B C P E 1 2 3 4 F. You can also say P for Papa.',
  aadhaar: 'Now your 12 digit Aadhaar number, digit by digit. Only the last 4 digits are kept.',
  mobile: 'Last detail. Your 10 digit mobile number?',
};

const HELP =
  'Here is what I can do. Send money to people: "send 500 to Ramesh", or say "scan" to pay a shop QR code. ' +
  'Pay bills: electricity, water, mobile recharge, DTH, gas, broadband, postpaid, FASTag, credit card, insurance, loan and property tax. For example "pay EB bill", "Jio recharge 299". ' +
  'Money: "add money", "request 500 from Priya", "split 1200 between me and Ramesh", "bank transfer". ' +
  'Information: "my balance", "last payment", "how much did I spend this month", "which bills are due", "my limit". ' +
  'To save things: "add contact", "add electricity bill". Also "pay again", "send receipt", "open contacts", "start KYC". ' +
  'Say "repeat" to hear me again, and "stop listening" when you are done.';

const UPI_NAME = { gpay: 'Google Pay', phonepe: 'PhonePe', paytm: 'Paytm', any: 'your UPI app' } as const;
function upiAppFrom(text: string): 'gpay' | 'phonepe' | 'paytm' | 'any' | null {
  const t = text.toLowerCase();
  if (/\b(g ?pay|google ?pay|tez)\b/.test(t)) return 'gpay';
  if (/\bphone ?pe\b/.test(t)) return 'phonepe';
  if (/\bpaytm\b/.test(t)) return 'paytm';
  if (/\bupi\b/.test(t)) return 'any';
  return null;
}
