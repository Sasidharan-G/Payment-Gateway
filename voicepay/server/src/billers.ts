// Biller catalogue + bill fetch for 12 bill types: electricity, mobile recharge, DTH, gas, water,
// broadband, postpaid, FASTag, credit card, insurance, loan EMI and property tax.
//
// REAL vs SIMULATED: real bill fetch/payment in India goes through BBPS (Bharat Bill Payment System),
// which needs an authorised BBPS agent/aggregator account (Setu, PaySprint, Cashfree BBPS, ...).
// Those need business KYC, so this project SIMULATES the BBPS responses here. Account-number
// formats, plans and the overall flow follow the real thing. To go live, replace fetchBill()
// with the aggregator's "bill fetch" API and send the payment through their "bill pay" API.
import crypto from 'node:crypto';

export type Category =
  | 'electricity' | 'mobile' | 'dth' | 'gas' | 'water' | 'broadband' | 'postpaid'
  | 'fastag' | 'creditcard' | 'insurance' | 'loan' | 'tax';

export type Plan = { amount: number; validity: string; benefit: string };

/** mobile + DTH: pick one of the operator's packs. */
export const PLAN_CATEGORIES: Category[] = ['mobile', 'dth'];
/** FASTag: the customer chooses the top-up amount. */
export const TOPUP_CATEGORIES: Category[] = ['fastag'];
/** Everything else: the biller sends the amount due (bill fetch). */
export const isDueCategory = (c: Category) => !PLAN_CATEGORIES.includes(c) && !TOPUP_CATEGORIES.includes(c);
/** Bills that must not be paid twice in a row (a credit card can be part-paid more than once). */
export const NO_DUPLICATE_CATEGORIES: Category[] = ['electricity', 'gas', 'water', 'broadband', 'postpaid', 'insurance', 'loan', 'tax'];
export const TOPUP_MIN = 100;
export const TOPUP_MAX = 10000;

export type Biller = {
  id: string;
  name: string;
  category: Category;
  accountLabel: string; // what the customer types
  accountPattern: string; // regex source
  accountHint: string;
  plans?: Plan[]; // mobile + DTH packs
  fixedAmount?: number; // gas cylinder price (demo)
};

const MOBILE = { accountLabel: 'Mobile number', accountPattern: '^[6-9]\\d{9}$', accountHint: '10-digit number, e.g. 9876543210' };
const VEHICLE = { accountLabel: 'Vehicle number', accountPattern: '^[A-Z]{2}\\d{1,2}[A-Z]{0,3}\\d{4}$', accountHint: 'like TN09AB1234' };
const CARD = { accountLabel: 'Registered mobile number', accountPattern: '^[6-9]\\d{9}$', accountHint: '10-digit mobile number linked to the card' };
const GAS = { accountLabel: 'Consumer number / registered mobile', accountPattern: '^(\\d{7,17}|[6-9]\\d{9})$', accountHint: 'LPG ID (17 digits), consumer no, or mobile', fixedAmount: 868.5 };
const digits = (label: string, n: string, hint: string) => ({ accountLabel: label, accountPattern: `^\\d{${n}}$`, accountHint: hint });

export const BILLERS: Biller[] = [
  // Electricity
  { id: 'tnpdcl', name: 'TNPDCL (TANGEDCO) - Tamil Nadu', category: 'electricity', accountLabel: 'Service connection number', accountPattern: '^\\d{9,12}$', accountHint: '9 to 12 digits, e.g. 091234567' },
  { id: 'bescom', name: 'BESCOM - Bengaluru', category: 'electricity', accountLabel: 'Account ID', accountPattern: '^\\d{10}$', accountHint: '10 digits' },
  { id: 'kseb', name: 'KSEB - Kerala', category: 'electricity', accountLabel: 'Consumer number', accountPattern: '^\\d{13}$', accountHint: '13 digits' },
  { id: 'msedcl', name: 'MSEDCL - Maharashtra', category: 'electricity', accountLabel: 'Consumer number', accountPattern: '^\\d{12}$', accountHint: '12 digits' },
  { id: 'adani-mum', name: 'Adani Electricity - Mumbai', category: 'electricity', accountLabel: 'Account number', accountPattern: '^\\d{9}$', accountHint: '9 digits' },
  // Mobile prepaid (plan list is a sample, real plans change often)
  { id: 'jio', name: 'Jio Prepaid', category: 'mobile', ...MOBILE, plans: [
    { amount: 199, validity: '18 days', benefit: '1.5 GB/day, unlimited calls' },
    { amount: 299, validity: '28 days', benefit: '1.5 GB/day, unlimited calls' },
    { amount: 349, validity: '28 days', benefit: '2 GB/day, unlimited calls' },
    { amount: 799, validity: '84 days', benefit: '1.5 GB/day, unlimited calls' },
  ] },
  { id: 'airtel', name: 'Airtel Prepaid', category: 'mobile', ...MOBILE, plans: [
    { amount: 199, validity: '28 days', benefit: '2 GB total, unlimited calls' },
    { amount: 299, validity: '28 days', benefit: '1 GB/day, unlimited calls' },
    { amount: 379, validity: '1 month', benefit: '2 GB/day, unlimited calls' },
    { amount: 859, validity: '84 days', benefit: '1.5 GB/day, unlimited calls' },
  ] },
  { id: 'vi', name: 'Vi (Vodafone Idea) Prepaid', category: 'mobile', ...MOBILE, plans: [
    { amount: 199, validity: '28 days', benefit: '2 GB total, unlimited calls' },
    { amount: 299, validity: '28 days', benefit: '1 GB/day, unlimited calls' },
    { amount: 349, validity: '28 days', benefit: '1.5 GB/day, unlimited calls' },
  ] },
  { id: 'bsnl', name: 'BSNL Prepaid', category: 'mobile', ...MOBILE, plans: [
    { amount: 107, validity: '35 days', benefit: '3 GB, 200 minutes' },
    { amount: 199, validity: '30 days', benefit: '2 GB/day, unlimited calls' },
    { amount: 397, validity: '150 days', benefit: '2 GB/day for 30 days' },
  ] },
  // DTH
  { id: 'tataplay', name: 'Tata Play', category: 'dth', accountLabel: 'Subscriber ID', accountPattern: '^1\\d{9}$', accountHint: '10 digits starting with 1', plans: [
    { amount: 250, validity: '1 month', benefit: 'Tamil Basic' }, { amount: 399, validity: '1 month', benefit: 'Tamil Value HD' } ] },
  { id: 'airteldth', name: 'Airtel Digital TV', category: 'dth', accountLabel: 'Customer ID', accountPattern: '^3\\d{9}$', accountHint: '10 digits starting with 3', plans: [
    { amount: 270, validity: '1 month', benefit: 'Tamil Value' }, { amount: 420, validity: '1 month', benefit: 'Tamil Mega HD' } ] },
  { id: 'sundirect', name: 'Sun Direct', category: 'dth', accountLabel: 'Smart card number', accountPattern: '^[14]\\d{10}$', accountHint: '11 digits starting with 1 or 4', plans: [
    { amount: 199, validity: '1 month', benefit: 'Tamil Super Value' }, { amount: 330, validity: '1 month', benefit: 'Tamil HD Pack' } ] },
  { id: 'dishtv', name: 'Dish TV', category: 'dth', accountLabel: 'Registered mobile / VC number', accountPattern: '^(\\d{11}|[6-9]\\d{9})$', accountHint: '11-digit VC number or mobile', plans: [
    { amount: 260, validity: '1 month', benefit: 'South Basic' } ] },
  // Gas cylinder booking (14.2 kg domestic; demo price, real price depends on city and month)
  { id: 'indane', name: 'Indane Gas', category: 'gas', ...GAS },
  { id: 'hpgas', name: 'HP Gas', category: 'gas', ...GAS },
  { id: 'bharatgas', name: 'Bharat Gas', category: 'gas', ...GAS },
  // Water
  { id: 'cmwssb', name: 'Chennai Metrowater', category: 'water', ...digits('Consumer number', '10', '10 digits') },
  { id: 'bwssb', name: 'BWSSB - Bengaluru', category: 'water', ...digits('RR number', '9,10', '9 or 10 digits') },
  { id: 'twad', name: 'TWAD - Tamil Nadu', category: 'water', ...digits('Connection number', '8,10', '8 to 10 digits') },
  { id: 'hmwssb', name: 'HMWSSB - Hyderabad', category: 'water', ...digits('CAN number', '9', '9 digits') },
  // Broadband / landline
  { id: 'actfibernet', name: 'ACT Fibernet', category: 'broadband', ...digits('Account number', '9,12', '9 to 12 digits') },
  { id: 'airtelxstream', name: 'Airtel Xstream Fiber', category: 'broadband', ...digits('Customer ID', '10', '10 digits') },
  { id: 'jiofiber', name: 'JioFiber', category: 'broadband', ...MOBILE, accountLabel: 'JioFiber mobile number' },
  { id: 'bsnlbb', name: 'BSNL Broadband / Landline', category: 'broadband', ...digits('Landline number with STD code', '8,12', 'STD code + number, e.g. 04412345678') },
  // Postpaid mobile bill
  { id: 'jiopost', name: 'Jio Postpaid', category: 'postpaid', ...MOBILE },
  { id: 'airtelpost', name: 'Airtel Postpaid', category: 'postpaid', ...MOBILE },
  { id: 'vipost', name: 'Vi Postpaid', category: 'postpaid', ...MOBILE },
  { id: 'bsnlpost', name: 'BSNL Postpaid', category: 'postpaid', ...MOBILE },
  // FASTag (top-up of any amount)
  { id: 'iciciftag', name: 'ICICI Bank FASTag', category: 'fastag', ...VEHICLE },
  { id: 'hdfcftag', name: 'HDFC Bank FASTag', category: 'fastag', ...VEHICLE },
  { id: 'sbiftag', name: 'SBI FASTag', category: 'fastag', ...VEHICLE },
  { id: 'airtelftag', name: 'Airtel Payments Bank FASTag', category: 'fastag', ...VEHICLE },
  // Credit card bill
  { id: 'hdfccard', name: 'HDFC Bank Credit Card', category: 'creditcard', ...CARD },
  { id: 'sbicard', name: 'SBI Card', category: 'creditcard', ...CARD },
  { id: 'icicicard', name: 'ICICI Bank Credit Card', category: 'creditcard', ...CARD },
  { id: 'axiscard', name: 'Axis Bank Credit Card', category: 'creditcard', ...CARD },
  // Insurance premium
  { id: 'lic', name: 'LIC of India Premium', category: 'insurance', ...digits('Policy number', '9', '9 digits') },
  { id: 'hdfclife', name: 'HDFC Life Premium', category: 'insurance', ...digits('Policy number', '8', '8 digits') },
  { id: 'starhealth', name: 'Star Health Insurance', category: 'insurance', ...digits('Policy number', '10,12', '10 to 12 digits') },
  // Loan EMI
  { id: 'bajajfin', name: 'Bajaj Finance EMI', category: 'loan', ...digits('Loan account number', '10,12', '10 to 12 digits') },
  { id: 'hdfcloan', name: 'HDFC Bank Loan EMI', category: 'loan', ...digits('Loan account number', '8,14', '8 to 14 digits') },
  // Municipal / property tax
  { id: 'gcc-tax', name: 'Greater Chennai Corporation Property Tax', category: 'tax', ...digits('Assessment number', '8,12', '8 to 12 digits') },
  { id: 'bbmp-tax', name: 'BBMP Property Tax - Bengaluru', category: 'tax', ...digits('PID number', '10,15', '10 to 15 digits') },
];

export const CATEGORY_LABEL: Record<Category, string> = {
  electricity: 'Electricity bill',
  mobile: 'Mobile recharge',
  dth: 'DTH recharge',
  gas: 'Gas cylinder booking',
  water: 'Water bill',
  broadband: 'Broadband bill',
  postpaid: 'Postpaid mobile bill',
  fastag: 'FASTag recharge',
  creditcard: 'Credit card bill',
  insurance: 'Insurance premium',
  loan: 'Loan EMI',
  tax: 'Property tax',
};

export const getBiller = (id: string) => BILLERS.find((b) => b.id === id) ?? null;

export const normalizeAccount = (account: string) => account.replace(/\s+/g, '').toUpperCase();

export function validateAccount(biller: Biller, account: string): string | null {
  return new RegExp(biller.accountPattern).test(normalizeAccount(account)) ? null : `Invalid ${biller.accountLabel}. ${biller.accountHint}.`;
}

export function maskAccount(account: string): string {
  const a = account.replace(/\s+/g, '');
  if (a.length <= 4) return a;
  return a.slice(0, 2) + '*'.repeat(Math.max(0, a.length - 4)) + a.slice(-2);
}

export type FetchedBill = {
  billerId: string;
  account: string;
  customerName: string;
  amount: number | null; // null = customer chooses (recharge, FASTag)
  dueDate?: string;
  billNumber?: string;
  minDue?: number; // credit card
  units?: number;
  plans?: Plan[];
  note: string;
};

/** Simulated BBPS bill fetch. Deterministic per account so demos are repeatable. */
export function fetchBill(biller: Biller, account: string): FetchedBill {
  const a = normalizeAccount(account);
  const h = crypto.createHash('sha256').update(biller.id + a).digest();
  const n = h.readUInt32BE(0);
  const note = 'Simulated BBPS response (demo)';
  const dueIn = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  if (biller.category === 'electricity') {
    const units = 80 + (n % 420);
    const amount = Math.round(units * 6.35 + 60); // energy charge + fixed charge (demo tariff)
    return { billerId: biller.id, account: a, customerName: 'Demo Consumer', amount, units, dueDate: dueIn(10), billNumber: 'BB' + (n % 1e8), note };
  }
  if (biller.category === 'gas') {
    return { billerId: biller.id, account: a, customerName: 'Demo Consumer', amount: biller.fixedAmount!, note: note + ' - 14.2 kg cylinder, demo price' };
  }
  if (biller.category === 'fastag') {
    return { billerId: biller.id, account: a, customerName: 'Demo Vehicle Owner', amount: null, note: `${note} - top-up from ₹${TOPUP_MIN} to ₹${TOPUP_MAX}` };
  }
  if (isDueCategory(biller.category)) {
    const range: Partial<Record<Category, [number, number, number]>> = { // [min, span, round to]
      water: [150, 700, 5], broadband: [399, 1100, 1], postpaid: [299, 700, 1], creditcard: [2000, 7000, 10],
      insurance: [1500, 4500, 50], loan: [3000, 6500, 10], tax: [1000, 3500, 10],
    };
    const [lo, span, step] = range[biller.category] ?? [100, 900, 1];
    const amount = Math.round((lo + (n % span)) / step) * step;
    const out: FetchedBill = { billerId: biller.id, account: a, customerName: 'Demo Customer', amount, dueDate: dueIn(5 + (n % 12)), billNumber: 'BB' + (n % 1e8), note };
    if (biller.category === 'creditcard') out.minDue = Math.max(100, Math.round((amount * 0.05) / 10) * 10);
    return out;
  }
  return { billerId: biller.id, account: a, customerName: 'Demo Subscriber', amount: null, plans: biller.plans, note };
}

/** Recharges must match a real plan of the operator. */
export function isValidPlanAmount(biller: Biller, amount: number): boolean {
  if (!biller.plans) return true;
  return biller.plans.some((p) => p.amount === amount);
}

export function detectCategory(text: string): Category | null {
  const t = text.toLowerCase();
  if (/\b(post ?paid)\b/.test(t)) return 'postpaid';
  if (/\b(fast ?-?t?ag|toll)\b/.test(t)) return 'fastag';
  if (/\b(credit ?card|card bill)\b/.test(t)) return 'creditcard';
  if (/\b(broadband|wi-?fi|internet|fiber|fibre|landline|fibernet|jiofiber|xstream)\b/.test(t)) return 'broadband';
  if (/\b(water|metro ?water|metrowater|twad|bwssb|hmwssb|kudineer|thanni)\b/.test(t)) return 'water';
  if (/\b(insurance|lic|premium|policy)\b/.test(t)) return 'insurance';
  if (/\b(loan|emi)\b/.test(t)) return 'loan';
  if (/\b(property tax|house tax|municipal|corporation tax|tax)\b/.test(t)) return 'tax';
  if (/\b(electricity|electric|current|karant|eb|power|tneb|tangedco|tnpdcl|bescom|kseb|light)\b/.test(t)) return 'electricity';
  if (/\b(gas|cylinder|silinder|lpg|indane|hp gas|bharat gas)\b/.test(t)) return 'gas';
  if (/\b(dth|tv|cable|tata play|tataplay|sun direct|dish|d2h|set ?top)\b/.test(t)) return 'dth';
  if (/\b(recharge|rechaarge|mobile|prepaid|top ?up|jio|airtel|vi|vodafone|bsnl|phone)\b/.test(t)) return 'mobile';
  if (/\bbill\b/.test(t) && /\b(kattu|katt|pay|pannu)\b/.test(t)) return 'electricity';
  return null;
}

/** "TN09AB1234", "TN 09 AB 1234" → "TN09AB1234" */
export function extractVehicle(raw: string): string | null {
  const m = raw.toUpperCase().match(/\b([A-Z]{2})\s?(\d{1,2})\s?([A-Z]{0,3})\s?(\d{4})\b/);
  return m ? m[1] + m[2] + m[3] + m[4] : null;
}
