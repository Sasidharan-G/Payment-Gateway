// Tiny JSON-file database. Good enough for a demo/academic project:
// no setup, survives restarts, easy to inspect (server/data/db.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Category } from './billers.ts';
import type { Kyc } from './kyc.ts';

export type Contact = {
  id: string;
  name: string;
  nickname?: string;
  upiId: string; // person or merchant UPI ID, e.g. ramesh@okaxis
  phone?: string; // optional 10-digit mobile, lets "send 500 to 98765 43210" find the contact
  type: 'person' | 'merchant';
};

/** A saved bill account, e.g. "Home EB" → TNPDCL 091234567. Lets voice say "EB bill kattu". */
export type SavedBill = {
  id: string;
  category: Category;
  billerId: string;
  account: string;
  nickname: string;
};

export type TxStatus = 'success' | 'failed' | 'cancelled' | 'initiated';
export type TxMethod = 'gateway' | 'upi_app';
export type TxCategory = 'transfer' | 'bank' | 'topup' | Category;

export type Transaction = {
  id: string;
  refId: string;
  category: TxCategory;
  payeeName: string; // contact name or biller name
  payeeRef: string; // UPI ID, or masked bill account
  contactId?: string;
  billerId?: string;
  accountKey?: string; // hash of biller + full account, used to detect duplicate bill payments
  amount: number;
  method: TxMethod;
  status: TxStatus;
  transcript?: string;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  createdAt: string;
};

/** "Request money" / "split bill": a note that someone owes the user money. The payable UPI link is shared from the phone. */
export type MoneyRequest = {
  id: string;
  from: string; // who should pay
  amount: number;
  note?: string;
  createdAt: string;
  status: 'open' | 'paid' | 'cancelled';
};

export type Data = {
  balance: number;
  /** The user's own UPI ID, used in request links. Demo value until real accounts exist. */
  myUpiId: string;
  requests: MoneyRequest[];
  kyc: Kyc;
  contacts: Contact[];
  savedBills: SavedBill[];
  transactions: Transaction[];
};

const SEED: Data = {
  balance: 10000,
  myUpiId: 'you@voicepay',
  requests: [],
  kyc: { status: 'none' },
  contacts: [
    { id: 'c1', name: 'Ramesh Kumar', nickname: 'Ramesh', upiId: 'rameshkumar@okaxis', phone: '9876501234', type: 'person' },
    { id: 'c2', name: 'Ramesh S', upiId: 'rameshs@oksbi', type: 'person' },
    { id: 'c3', name: 'Priya', upiId: 'priya@okhdfcbank', phone: '9876505678', type: 'person' },
    { id: 'c4', name: 'Murugan Stores', nickname: 'Murugan', upiId: 'muruganstores@paytm', type: 'merchant' },
    { id: 'c5', name: 'Arun', upiId: 'arun@ybl', type: 'person' },
    { id: 'c6', name: 'Annapoorna Hotel', nickname: 'Annapoorna', upiId: 'annapoorna@okicici', type: 'merchant' },
  ],
  savedBills: [
    { id: 'b1', category: 'electricity', billerId: 'tnpdcl', account: '091234567', nickname: 'Home EB' },
    { id: 'b2', category: 'mobile', billerId: 'jio', account: '9876543210', nickname: 'My Jio' },
    { id: 'b3', category: 'dth', billerId: 'sundirect', account: '41234567890', nickname: 'Home TV' },
    { id: 'b4', category: 'gas', billerId: 'indane', account: '9876543210', nickname: 'Indane gas' },
  ],
  transactions: [],
};

/** What a brand-new real user starts with: nothing. No demo contacts, bills or money. */
export const EMPTY_SEED: Data = {
  balance: 0,
  myUpiId: '',
  requests: [],
  kyc: { status: 'none' },
  contacts: [],
  savedBills: [],
  transactions: [],
};

export const newId = (prefix: string) => prefix + crypto.randomBytes(4).toString('hex');

export class Db {
  private file: string | null;
  private seed: Data;
  data: Data;

  /** file = null keeps everything in memory (used by tests). `seed` = the starting data (demo data by default). */
  constructor(file: string | null, seed: Data = SEED) {
    this.file = file;
    this.seed = seed;
    if (file && fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Data>;
      this.data = { ...structuredClone(seed), ...loaded };
    } else {
      this.data = structuredClone(seed);
      this.save();
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace: a crash never leaves a half-written file
  }

  reset() {
    this.data = structuredClone(this.seed);
    this.save();
  }

  addContact(c: Omit<Contact, 'id'>): Contact {
    const contact = { ...c, id: newId('c') };
    this.data.contacts.push(contact);
    this.save();
    return contact;
  }

  updateContact(id: string, patch: Partial<Omit<Contact, 'id'>>): Contact | null {
    const c = this.data.contacts.find((x) => x.id === id);
    if (!c) return null;
    Object.assign(c, patch);
    this.save();
    return c;
  }

  deleteContact(id: string): boolean {
    const before = this.data.contacts.length;
    this.data.contacts = this.data.contacts.filter((x) => x.id !== id);
    this.save();
    return this.data.contacts.length < before;
  }

  addSavedBill(b: Omit<SavedBill, 'id'>): SavedBill {
    const bill = { ...b, id: newId('b') };
    this.data.savedBills.push(bill);
    this.save();
    return bill;
  }

  deleteSavedBill(id: string): boolean {
    const before = this.data.savedBills.length;
    this.data.savedBills = this.data.savedBills.filter((x) => x.id !== id);
    this.save();
    return this.data.savedBills.length < before;
  }

  addRequest(r: Omit<MoneyRequest, 'id' | 'createdAt' | 'status'>): MoneyRequest {
    const req: MoneyRequest = { ...r, id: newId('r'), createdAt: new Date().toISOString(), status: 'open' };
    this.data.requests.unshift(req);
    this.save();
    return req;
  }

  setKyc(kyc: Kyc) {
    this.data.kyc = kyc;
    this.save();
  }

  addTransaction(t: Omit<Transaction, 'id' | 'refId' | 'createdAt'>): Transaction {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const tx: Transaction = {
      ...t,
      id: 't' + crypto.randomBytes(6).toString('hex'),
      refId: 'VP' + ymd + crypto.randomInt(100000, 999999),
      createdAt: now.toISOString(),
    };
    this.data.transactions.unshift(tx);
    if (tx.status === 'success') this.data.balance = round2(this.data.balance + balanceDelta(tx));
    this.save();
    return tx;
  }

  setTransactionStatus(id: string, status: TxStatus, extra: Partial<Transaction> = {}): Transaction | null {
    const tx = this.data.transactions.find((x) => x.id === id);
    if (!tx) return null;
    const wasSuccess = tx.status === 'success';
    Object.assign(tx, extra, { status });
    if (!wasSuccess && status === 'success') this.data.balance = round2(this.data.balance + balanceDelta(tx));
    this.save();
    return tx;
  }

  spentToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.data.transactions
      .filter((t) => t.status === 'success' && t.category !== 'topup' && t.createdAt.startsWith(today))
      .reduce((s, t) => s + t.amount, 0);
  }

  /** Was this bill account already paid in the last 25 days? (prevents paying the same bill twice) */
  recentlyPaid(billerId: string, account: string): Transaction | null {
    const key = accountKey(billerId, account);
    const since = Date.now() - 25 * 864e5;
    return this.data.transactions.find((t) =>
      t.status === 'success' && t.accountKey === key && Date.parse(t.createdAt) > since) ?? null;
  }
}

/** Paying lowers the balance, adding money raises it. */
export const balanceDelta = (t: { category: TxCategory; amount: number }) => (t.category === 'topup' ? t.amount : -t.amount);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const accountKey = (billerId: string, account: string) =>
  crypto.createHash('sha256').update(billerId + ':' + account.replace(/\s+/g, '')).digest('hex').slice(0, 24);
