// Everything a payment app offers, by voice: QR, new payees, 12 bill types, bank transfer, add money,
// request money, split bill, summaries. Runs offline with the rule parser (no Groq key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import { Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { detectCategory } from '../src/billers.js';
import { verhoeffGenerate } from '../src/kyc.js';
import { upiFromSpeech, ifscFromSpeech, phoneFromText, spokenUpi } from '../src/speech.js';
import { parseUpiQr } from '../src/payments.js';

delete process.env.GROQ_API_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const AADHAAR = verhoeffGenerate('23456789012');

async function call(app: any, path: string, body?: unknown) {
  const res = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? await res.json() : null, text: type.includes('html') ? await res.text() : null };
}

async function readyApp() {
  const db = new Db(null);
  const { app } = createApp(db);
  const s = await call(app, '/api/kyc/start', { name: 'Sasi Dharan', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: AADHAAR, mobile: '9876543210' });
  const v = await call(app, '/api/kyc/verify', { sessionId: s.json.sessionId, otp: s.json.demoOtp });
  assert.equal(v.json.kyc.status, 'verified');
  return { db, app };
}

/** Pays the pending payment through the demo gateway so the balance really changes. */
async function payPending(app: any, pendingId: string) {
  const page = await call(app, `/checkout/${pendingId}`);
  assert.equal(page.status, 200, page.text ?? '');
  const txId = page.text!.match(/\/api\/payments\/(t[0-9a-f]+)\/demo-complete/)![1];
  const r = await call(app, `/api/payments/${txId}/demo-complete`, {});
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  return r.json.transaction;
}
const say = async (app: any, text: string) => (await call(app, '/api/agent', { text })).json;

test('speech: spoken UPI IDs, IFSC codes and phone numbers', () => {
  assert.equal(upiFromSpeech('ramesh at okaxis'), 'ramesh@okaxis');
  assert.equal(upiFromSpeech('Priya dot S at OK HDFC bank'), 'priya.s@okhdfcbank');
  assert.equal(upiFromSpeech('arun one two three at ybl'), 'arun123@ybl');
  assert.equal(upiFromSpeech('r a m e s h at the rate okaxis'), 'ramesh@okaxis');
  assert.equal(upiFromSpeech('ramesh@okaxis'), 'ramesh@okaxis');
  assert.equal(upiFromSpeech('hello world'), null);
  assert.equal(spokenUpi('priya.s@okhdfcbank'), 'priya dot s at okhdfcbank');
  assert.equal(ifscFromSpeech('H D F C zero zero zero one two three four'), 'HDFC0001234');
  assert.equal(ifscFromSpeech('hello'), null);
  assert.equal(phoneFromText('send 500 to 98765 43210'), '9876543210');
  assert.equal(phoneFromText('send 500 to ramesh'), null);
});

test('QR codes: valid UPI payloads, fixed amounts, and bad codes are refused', () => {
  const ok = parseUpiQr('upi://pay?pa=muruganstores@paytm&pn=Murugan%20Stores&am=120.50&cu=INR&mc=5411');
  assert.deepEqual(ok, { upiId: 'muruganstores@paytm', name: 'Murugan Stores', amount: 120.5, merchant: true });
  const noAmount = parseUpiQr('UPI://pay?pa=tea@okaxis&pn=Tea%20Shop');
  assert.ok(!('error' in noAmount) && noAmount.amount === null);
  for (const bad of ['https://example.com', 'upi://pay?pn=NoId', 'upi://pay?pa=bad&pn=x', 'upi://pay?pa=a@b1&am=-5', 'upi://pay?pa=ok@okaxis&cu=USD', '']) {
    assert.ok('error' in parseUpiQr(bad), bad);
  }
});

test('new intents are understood by the rule parser', () => {
  const want: Array<[string, string]> = [
    ['scan qr', 'scan_qr'], ['scan and pay', 'scan_qr'], ['add contact Kumar', 'add_contact'], ['remove contact Arun', 'delete_contact'],
    ['add water bill', 'add_bill'], ['save my electricity bill', 'add_bill'], ['which bills are due', 'check_dues'],
    ['how much did I spend this month', 'spending'], ['last payment', 'last_payment'], ['pay again', 'pay_again'],
    ['request 500 from priya', 'request_money'], ['split 1200 between me and ramesh', 'split_bill'],
    ['bank transfer 500', 'bank_transfer'], ['add money 1000', 'add_money'], ['what is my limit', 'limits'], ['send receipt', 'share_receipt'],
    ['water bill pay pannu', 'pay_bill'], ['credit card bill', 'pay_bill'], ['fastag recharge 500', 'pay_bill'], ['send 500 to ramesh', 'send_money'],
  ];
  for (const [t, intent] of want) assert.equal(parseCommand(t).intent, intent, t);
  assert.equal(detectCategory('broadband bill'), 'broadband');
  assert.equal(detectCategory('postpaid bill'), 'postpaid');
  assert.equal(detectCategory('property tax'), 'tax');
  assert.equal(detectCategory('loan emi'), 'loan');
});

test('QR scan: pay a shop, fixed amount from the QR, asks amount when missing, bad QR spoken', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/pay/qr', { link: 'upi://pay?pa=chaishop@okaxis&pn=Chai%20Shop&am=40' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.match(r.json.reply, /QR code found: Chai Shop/);
  assert.match(r.json.reply, /chaishop at okaxis/);
  assert.equal(r.json.pending.amount, 40);
  assert.equal(r.json.pending.upiAllowed, true);
  const tx = await payPending(app, r.json.pending.id);
  assert.equal(tx.payeeName, 'Chai Shop');

  r = await call(app, '/api/pay/qr', { link: 'upi://pay?pa=juice@okaxis&pn=Juice%20Bar' });
  assert.equal(r.json.state, 'NEEDS_INFO');
  assert.match(r.json.reply, /How much/);
  r = await call(app, '/api/agent', { text: 'two hundred rupees' });
  assert.equal(r.json.pending.amount, 200);
  assert.equal(r.json.pending.title, 'Juice Bar');

  r = await call(app, '/api/pay/qr', { link: 'https://evil.example/pay' });
  assert.equal(r.json.state, 'ERROR');
  assert.match(r.json.reply, /not a UPI payment code/);

  r = await call(app, '/api/agent', { text: 'scan the qr' });
  assert.equal(r.json.action.type, 'scan_qr');
});

test('QR scan needs KYC like every other payment', async () => {
  const { app } = createApp(new Db(null));
  const r = await call(app, '/api/pay/qr', { link: 'upi://pay?pa=chaishop@okaxis&pn=Chai%20Shop&am=40' });
  assert.equal(r.json.state, 'KYC_REQUIRED');
});

test('unknown name → add contact by voice → pay; spoken UPI ID is read back', async () => {
  const { app, db } = await readyApp();
  let r = await say(app, 'send 300 to Vignesh');
  assert.equal(r.state, 'NEEDS_INFO');
  assert.match(r.reply, /couldn't find a contact named Vignesh/);
  r = await say(app, 'yes');
  assert.equal(r.expect, 'upi');
  r = await say(app, 'blah blah');
  assert.match(r.reply, /could not understand/);
  r = await say(app, 'vignesh dot k at ok icici');
  assert.match(r.reply, /vignesh dot k at okicici/);
  r = await say(app, 'no'); // wrong, say it again
  assert.equal(r.expect, 'upi');
  r = await say(app, 'vignesh at okicici');
  r = await say(app, 'yes');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.match(r.reply, /Saved Vignesh/);
  assert.equal(r.pending.amount, 300);
  assert.ok(db.data.contacts.some((c) => c.upiId === 'vignesh@okicici'));
  await say(app, 'no');

  r = await say(app, 'add contact Meena');
  assert.equal(r.expect, 'upi');
  await say(app, 'meena at ybl');
  r = await say(app, 'aama');
  assert.match(r.reply, /Saved Meena/);
  await say(app, 'add contact Meena again');
  r = await say(app, 'meena at ybl');
  assert.match(r.reply, /already saved as Meena/);

  r = await say(app, 'remove contact Meena');
  assert.match(r.reply, /Remove Meena/);
  r = await say(app, 'yes');
  assert.match(r.reply, /Removed Meena/);
  assert.ok(!db.data.contacts.some((c) => c.name === 'Meena'));
});

test('pay by mobile number: saved contact is found, unknown number offers to add', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'send 100 to 98765 05678');
  assert.equal(r.pending.title, 'Priya');
  await say(app, 'no');
  r = await say(app, 'send 100 to 9123456789');
  assert.match(r.reply, /don't have/);
  r = await say(app, 'no');
  assert.equal(r.state, 'CANCELLED');
});

test('pay a UPI ID written in the sentence (not saved) reads the payee out before paying', async () => {
  const { app } = await readyApp();
  const r = await say(app, 'send 75 to kavin@okaxis');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.match(r.reply, /New payee, kavin at okaxis/);
});

test('12 bill types: add by voice, dues, pay, duplicate guard, credit card minimum, FASTag range', async () => {
  const { app, db } = await readyApp();

  // water: nothing saved → saves it by voice, then pays
  let r = await say(app, 'pay water bill');
  assert.match(r.reply, /Which provider/);
  r = await say(app, 'chennai metrowater');
  assert.equal(r.expect, 'digits');
  r = await say(app, 'one two three four five six seven eight nine zero');
  assert.equal(r.expect, 'name');
  r = await say(app, 'Home water');
  assert.match(r.reply, /Save Home Water/);
  r = await say(app, 'yes');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.match(r.reply, /Saved Home Water. Pay Chennai Metrowater water bill of ₹/);
  assert.equal(r.pending.category, 'water');
  const amount = r.pending.amount;
  assert.ok(amount >= 150 && amount <= 850, String(amount));
  await payPending(app, r.pending.id);
  r = await say(app, 'pay home water');
  assert.match(r.reply, /already paid/);

  // add_bill with the provider and number in one sentence + default nickname
  r = await say(app, 'save my jio postpaid number 9876543210');
  assert.match(r.reply, /What should I call it/);
  r = await say(app, 'skip');
  assert.match(r.reply, /Save Jio/);
  r = await say(app, 'yes');
  assert.match(r.reply, /Saved Jio/);
  r = await say(app, 'which bills are due');
  assert.match(r.reply, /Home EB/);
  assert.match(r.reply, /Jio/);
  assert.doesNotMatch(r.reply, /Home Water/); // already paid

  // credit card: total by default, minimum on request
  await say(app, 'add credit card');
  await say(app, 'hdfc');
  await say(app, '9 8 7 6 5 4 3 2 1 0');
  await say(app, 'skip');
  await say(app, 'yes');
  r = await say(app, 'pay credit card bill');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.match(r.reply, /total due/);
  const total = r.pending.amount;
  await say(app, 'no');
  r = await say(app, 'pay credit card minimum');
  assert.ok(r.pending.amount < total);
  assert.match(r.reply, /minimum/);
  await say(app, 'no');

  // FASTag: vehicle number, amount must be 100..10000
  r = await say(app, 'add fastag');
  r = await say(app, 'sbi');
  assert.equal(r.expect, 'letters');
  await say(app, 'TN 09 AB 1234');
  await say(app, 'my car');
  r = await say(app, 'yes');
  assert.match(r.reply, /Saved my car/i);
  r = await say(app, 'fastag recharge');
  assert.match(r.reply, /How much/);
  r = await say(app, '50');
  assert.match(r.reply, /Between/);
  r = await say(app, '500');
  assert.equal(r.pending.amount, 500);
  assert.match(r.reply, /FASTag/);
  await say(app, 'no');

  // account format is validated per biller
  await say(app, 'add insurance');
  await say(app, 'lic');
  r = await say(app, '123');
  assert.match(r.reply, /Invalid Policy number/);
  r = await say(app, 'cancel');
  assert.equal(r.state, 'CANCELLED');
  assert.equal(db.data.savedBills.filter((b) => b.category === 'insurance').length, 0);
});

test('bank transfer by voice: account + IFSC are redacted, readback, confirm, gateway only', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'bank transfer 750');
  assert.equal(r.expect, 'name');
  r = await say(app, 'Suresh Kumar');
  assert.equal(r.expect, 'digits');
  r = await say(app, '12345');
  assert.match(r.reply, /9 to 18 digits/);
  const a = await call(app, '/api/agent', { text: '1 2 3 4 5 6 7 8 9 0 1 2' });
  assert.equal(a.json.transcript, '••••'); // account numbers are never echoed
  assert.deepEqual(a.json.log, []);
  assert.match(a.json.reply, /ending 9 0 1 2/);
  r = await say(app, 'wrong');
  assert.match(r.reply, /bank account number/);
  await say(app, '1 2 3 4 5 6 7 8 9 0 1 2');
  r = await say(app, 'H D F C zero zero zero one two three four');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.pending.kind, 'bank');
  assert.equal(r.pending.amount, 750);
  assert.equal(r.pending.upiAllowed, false);
  assert.match(r.reply, /Suresh Kumar/);
  assert.match(r.reply, /ending 9 0 1 2/);
  assert.doesNotMatch(r.pending.subtitle, /123456789012/);
  const tx = await payPending(app, r.pending.id);
  assert.equal(tx.category, 'bank');
  assert.equal((await call(app, '/api/wallet')).json.balance, 9250);
});

test('add money raises the balance and does not use up the daily limit', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'add money');
  assert.match(r.reply, /How much/);
  r = await say(app, '2000');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.pending.kind, 'topup');
  const tx = await payPending(app, r.pending.id);
  assert.equal(tx.category, 'topup');
  const w = (await call(app, '/api/wallet')).json;
  assert.equal(w.balance, 12000);
  assert.equal(w.spentToday, 0);
  r = await say(app, 'send 9000 to arun'); // possible because of the top-up
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  await say(app, 'no');
  r = await say(app, 'add money 20000');
  assert.match(r.reply, /limit/);
});

test('request money and split a bill produce share messages (no money moves)', async () => {
  const { app, db } = await readyApp();
  let r = await say(app, 'request 500 from priya');
  assert.equal(r.action.type, 'share');
  assert.match(r.action.text, /₹500/);
  assert.match(r.action.text, /upi:\/\/pay\?pa=you%40voicepay/);
  assert.match(r.reply, /from Priya/);
  assert.equal(db.data.requests[0].from, 'Priya');

  r = await say(app, 'split 1200 between me, Ramesh Kumar and Priya');
  assert.match(r.reply, /each pays ₹400/);
  r = await say(app, 'yes');
  assert.equal(r.action.type, 'share');
  assert.match(r.action.text, /Ramesh Kumar: ₹400, Priya: ₹400/);
  assert.equal(db.data.requests.length, 3);
  assert.equal(db.data.balance, 10000);

  await say(app, 'split 900 between arun and priya');
  r = await say(app, 'no');
  assert.equal(r.state, 'CANCELLED');
});

test('summaries: last payment, spending, limits, pay again, receipt', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'last payment');
  assert.match(r.reply, /no payments/);
  r = await say(app, 'send 250 to murugan stores');
  await payPending(app, r.pending.id);
  r = await say(app, 'send 100 to arun');
  await payPending(app, r.pending.id);

  r = await say(app, 'last payment');
  assert.match(r.reply, /₹100 to Arun/);
  r = await say(app, 'how much did I spend this month');
  assert.match(r.reply, /₹350/);
  assert.match(r.reply, /2 payments/);
  r = await say(app, 'what is my limit');
  assert.match(r.reply, /₹24,650 is left/);
  r = await say(app, 'send receipt');
  assert.equal(r.action.type, 'share');
  assert.match(r.action.text, /₹100 paid to Arun/);

  r = await say(app, 'pay again');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.pending.title, 'Arun');
  assert.equal(r.pending.amount, 100);
  await say(app, 'no');
});

test('pay again works for bills too, and the tap endpoints still work with the new payee types', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'pay eb bill');
  await payPending(app, r.pending.id);
  r = await say(app, 'jio recharge 299');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  await payPending(app, r.pending.id);
  r = await say(app, 'pay again');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  assert.match(r.reply, /Jio/);
  assert.equal(r.pending.amount, 299);
  await say(app, 'no');
  r = await call(app, '/api/pay/prepare', { contactId: 'c3', amount: 20 });
  assert.equal(r.json.ok, true);
});

test('mock gateway: a payment never fails, even when the demo wallet is short', async () => {
  const { app, db } = await readyApp();
  db.data.balance = 50;
  let r = await say(app, 'send 900 to arun');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  const tx = await payPending(app, r.pending.id);
  assert.equal(tx.status, 'success');
  assert.ok(db.data.balance >= 0);
  r = await say(app, 'pay eb bill');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
});
