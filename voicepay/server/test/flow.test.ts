import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseAmount, parseCommand, extractName } from '../src/parser.js';
import { matchContacts, pickCandidate } from '../src/matcher.js';
import { Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { upiLink, verifyRazorpaySignature } from '../src/payments.js';
import { verhoeffGenerate, verhoeffValid, validatePan, validateAadhaar, validateDob, KycService } from '../src/kyc.js';
import { detectCategory } from '../src/billers.js';
import { extractAccount } from '../src/parser.js';

const AADHAAR = verhoeffGenerate('23456789012'); // valid checksum test number

/** Fresh app with KYC already completed through the real endpoints. */
async function readyApp() {
  const db = new Db(null);
  const { app } = createApp(db);
  const s = await call(app, '/api/kyc/start', { name: 'Sasi Dharan', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: AADHAAR, mobile: '9876543210' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const v = await call(app, '/api/kyc/verify', { sessionId: s.json.sessionId, otp: s.json.demoOtp });
  assert.equal(v.json.kyc.status, 'verified');
  return { db, app };
}

delete process.env.GROQ_API_KEY; // tests use the rule parser (offline, deterministic)

test('amounts: digits, words, Tamil', () => {
  const cases: Array<[string, number | null]> = [
    ['send 500 to ramesh', 500], ['₹1,500 to priya', 1500], ['pay rs. 250', 250], ['1.5k to arun', 1500],
    ['2 aayiram priya ku', 2000], ['five hundred to ramesh', 500], ['two thousand five hundred', 2500],
    ['priya ku aayiram anuppu', 1000], ['rendu aayiram anuppu', 2000], ['aayirathi ainooru', 1500],
    ['ramesh ku ainooru kudu', 500], ['anju nooru', 500], ['what is my balance', null],
  ];
  for (const [t, want] of cases) assert.equal(parseAmount(t), want, t);
});

test('names and intents', () => {
  assert.equal(extractName('Ramesh ku 500 anuppu'), 'ramesh');
  assert.equal(extractName('send 500 to Murugan Stores'), 'murugan stores');
  assert.equal(extractName('Priyavukku aayiram kudu'), 'priya');
  assert.equal(extractName('pay arun 300 rupees'), 'arun');
  assert.equal(parseCommand('en balance evlo').intent, 'check_balance');
  assert.equal(parseCommand('show my history').intent, 'get_history');
  assert.deepEqual(parseCommand('Annapoorna ku 250 anuppu'), { intent: 'send_money', name: 'annapoorna', amount: 250 });
});

test('fuzzy + phonetic contact matching', () => {
  const db = new Db(null);
  const names = (q: string) => matchContacts(q, db.data.contacts).map((m) => m.contact.name);
  assert.deepEqual(names('priyaa'), ['Priya']);
  assert.deepEqual(names('murgan'), ['Murugan Stores']);
  assert.deepEqual(names('ramesh kumar'), ['Ramesh Kumar']);
  assert.deepEqual(names('ramesh').sort(), ['Ramesh Kumar', 'Ramesh S']);
  assert.deepEqual(names('zxqv'), []);
  const two = db.data.contacts.filter((c) => c.name.startsWith('Ramesh'));
  assert.equal(pickCandidate('kumar', two)?.name, 'Ramesh Kumar');
  assert.equal(pickCandidate('the second one', two)?.name, 'Ramesh S');
});

test('razorpay signature + upi link', () => {
  const sig = crypto.createHmac('sha256', 'sec').update('order_1|pay_1').digest('hex');
  assert.equal(verifyRazorpaySignature('order_1', 'pay_1', sig, 'sec'), true);
  assert.equal(verifyRazorpaySignature('order_1', 'pay_2', sig, 'sec'), false);
  const link = upiLink({ id: 'x', name: 'Murugan Stores', upiId: 'murugan@paytm', type: 'merchant' }, 250, 'VP1', 'gpay');
  assert.equal(link, 'tez://upi/pay?pa=murugan%40paytm&pn=Murugan%20Stores&am=250.00&cu=INR&tn=VoicePay%20VP1&tr=VP1');
});

async function call(app: any, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? await res.json() : null, text: type.includes('html') ? await res.text() : null };
}

test('E2E: voice text → disambiguate → confirm → demo gateway → balance + history', async () => {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  const { db, app } = await readyApp();

  let r = await call(app, '/api/agent', { text: 'Ramesh ku 500 anuppu' });
  assert.equal(r.json.state, 'AWAITING_CHOICE');
  r = await call(app, '/api/agent', { text: 'Kumar' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.json.pending.amount, 500);
  assert.equal(r.json.pending.title, 'Ramesh Kumar');
  assert.equal(r.json.pending.upiAllowed, true);
  const pendingId = r.json.pending.id;

  r = await call(app, '/api/agent', { text: 'sari anuppu' });
  assert.equal(r.json.state, 'READY_TO_PAY');

  const page = await call(app, `/checkout/${pendingId}`);
  assert.equal(page.status, 200);
  assert.match(page.text!, /Demo gateway/);
  const txId = page.text!.match(/\/api\/payments\/(t[0-9a-f]+)\/demo-complete/)![1];

  r = await call(app, `/api/payments/${txId}/demo-complete`, {});
  assert.equal(r.json.ok, true);
  assert.equal(r.json.transaction.status, 'success');

  r = await call(app, '/api/wallet');
  assert.equal(r.json.balance, 9500);
  r = await call(app, '/api/transactions');
  assert.equal(r.json.transactions[0].payeeName, 'Ramesh Kumar');

  // same pending cannot be paid twice
  const again = await call(app, `/checkout/${pendingId}`);
  assert.equal(again.status, 400);

  r = await call(app, '/api/agent', { text: 'what is my balance' });
  assert.match(r.json.reply, /9,500/);
});

test('E2E: missing amount, cancel, limits, unknown contact', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'Priya ku anuppu' });
  assert.equal(r.json.state, 'NEEDS_INFO');
  r = await call(app, '/api/agent', { text: 'aayiram' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.json.pending.amount, 1000);
  r = await call(app, '/api/agent', { text: 'venaam' });
  assert.equal(r.json.state, 'CANCELLED');

  r = await call(app, '/api/agent', { text: 'send 50000 to arun' });
  assert.equal(r.json.state, 'ERROR');
  assert.match(r.json.reply, /limit/);

  r = await call(app, '/api/agent', { text: 'send 100 to vignesh' });
  assert.match(r.json.reply, /couldn't find/);
});

test('E2E: UPI app route opens GPay link and records result', async () => {
  const { db, app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'pay murugan stores 250' });
  const pendingId = r.json.pending.id;
  r = await call(app, '/api/payments/upi', { pendingId, app: 'gpay' });
  assert.ok(r.json.link.startsWith('tez://upi/pay?pa=muruganstores%40paytm'));
  r = await call(app, `/api/payments/${r.json.transaction.id}/upi-result`, { status: 'success' });
  assert.equal(r.json.transaction.status, 'success');
  assert.equal(db.data.balance, 9750);
});

test('E2E: Razorpay test mode creates order and verifies signature', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
  process.env.RAZORPAY_KEY_SECRET = 'testsecret';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders');
    assert.equal(JSON.parse(String(init.body)).amount, 30000); // paise
    return new Response(JSON.stringify({ id: 'order_TEST123', amount: 30000, currency: 'INR' }), { status: 200 });
  }) as typeof fetch;
  try {
    const { db, app } = await readyApp();
    const r1 = await call(app, '/api/agent', { text: 'send 300 to arun' });
    const page = await call(app, `/checkout/${r1.json.pending.id}`);
    assert.match(page.text!, /order_TEST123/);
    assert.match(page.text!, /checkout\.razorpay\.com/);
    const txId = page.text!.match(/\/api\/payments\/(t[0-9a-f]+)\/verify/)![1];

    const bad = await call(app, `/api/payments/${txId}/verify`, { razorpay_order_id: 'order_TEST123', razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' });
    assert.equal(bad.status, 400);

    // new attempt with a valid signature
    const r2 = await call(app, '/api/agent', { text: 'send 300 to arun' });
    const page2 = await call(app, `/checkout/${r2.json.pending.id}`);
    const txId2 = page2.text!.match(/\/api\/payments\/(t[0-9a-f]+)\/verify/)![1];
    const sig = crypto.createHmac('sha256', 'testsecret').update('order_TEST123|pay_OK').digest('hex');
    const ok = await call(app, `/api/payments/${txId2}/verify`, { razorpay_order_id: 'order_TEST123', razorpay_payment_id: 'pay_OK', razorpay_signature: sig });
    assert.equal(ok.json.transaction.status, 'success');
    assert.equal(db.data.balance, 9700);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  }
});

test('KYC validation rules', () => {
  assert.equal(verhoeffValid(AADHAAR), true);
  assert.equal(validateAadhaar(AADHAAR), null);
  assert.match(validateAadhaar(AADHAAR.slice(0, 11) + ((Number(AADHAAR[11]) + 1) % 10))!, /checksum/);
  assert.match(validateAadhaar('123456789012')!, /start with 0 or 1/);
  assert.equal(validatePan('abcpe1234f'), null);
  assert.match(validatePan('ABCCE1234F')!, /individual/);
  assert.match(validatePan('ABC1234')!, /ABCDE1234F/);
  assert.match(validateDob('2015-01-01')!, /18/);
  assert.match(validateDob('2001-02-30')!, /real date/);
});

test('KYC OTP: wrong attempts lock, never stores full Aadhaar/PAN', () => {
  const k = new KycService();
  const s = k.start({ name: 'Sasi', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: AADHAAR, mobile: '9876543210' });
  assert.ok(s.ok);
  if (!s.ok) return;
  const wrong = s.otp === '111111' ? '222222' : '111111';
  assert.match((k.verify(s.sessionId, wrong) as any).error, /2 attempt/);
  assert.match((k.verify(s.sessionId, wrong) as any).error, /1 attempt/);
  assert.match((k.verify(s.sessionId, wrong) as any).error, /Too many/);
  assert.equal(k.verify(s.sessionId, s.otp).ok, false); // locked even with the right OTP

  const s2 = k.start({ name: 'Sasi', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: AADHAAR, mobile: '9876543210' });
  if (!s2.ok) throw new Error('start failed');
  const v = k.verify(s2.sessionId, s2.otp);
  assert.ok(v.ok);
  if (!v.ok) return;
  const stored = JSON.stringify(v.kyc);
  assert.ok(!stored.includes(AADHAAR) && !stored.includes('ABCPE1234F'));
  assert.equal(v.kyc.aadhaarLast4, AADHAAR.slice(-4));
  assert.equal(v.kyc.panMasked, 'ABC****34F');
});

test('payments are blocked until KYC is done', async () => {
  const { app } = createApp(new Db(null));
  const r = await call(app, '/api/agent', { text: 'send 100 to arun' });
  assert.equal(r.json.state, 'KYC_REQUIRED');
  const b = await call(app, '/api/agent', { text: 'EB bill kattu' });
  assert.equal(b.json.state, 'KYC_REQUIRED');
});

test('bill intent detection and account extraction', () => {
  assert.equal(detectCategory('EB bill kattu'), 'electricity');
  assert.equal(detectCategory('current bill pay pannu'), 'electricity');
  assert.equal(detectCategory('jio recharge 299'), 'mobile');
  assert.equal(detectCategory('sun direct recharge'), 'dth');
  assert.equal(detectCategory('gas cylinder book pannu'), 'gas');
  assert.equal(detectCategory('send 500 to arun'), null);
  assert.equal(parseCommand('what is my current balance').intent, 'check_balance');
  assert.equal(extractAccount('recharge 98765 43210 for 299'), '9876543210');
  assert.equal(extractAccount('recharge 9876543210 299'), '9876543210');
  const c = parseCommand('jio recharge 9876543210 299');
  assert.deepEqual([c.intent, c.category, c.account, c.amount], ['pay_bill', 'mobile', '9876543210', 299]);
  assert.equal(parseCommand('recharge 98765 43210 for 299').amount, 299);
});

test('E2E: electricity bill by voice → pay → duplicate blocked', async () => {
  const { db, app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'EB bill kattu' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION', r.json.reply);
  assert.equal(r.json.pending.category, 'electricity');
  assert.equal(r.json.pending.upiAllowed, false);
  assert.ok(!JSON.stringify(r.json.pending).includes('091234567'), 'full account must not leak');
  const amount = r.json.pending.amount;
  // UPI route is refused for bills
  const upi = await call(app, '/api/payments/upi', { pendingId: r.json.pending.id, app: 'gpay' });
  assert.equal(upi.status, 400);
  const page = await call(app, `/checkout/${r.json.pending.id}`);
  const txId = page.text!.match(/\/api\/payments\/(t[0-9a-f]+)\/demo-complete/)![1];
  r = await call(app, `/api/payments/${txId}/demo-complete`, {});
  assert.equal(r.json.transaction.category, 'electricity');
  assert.equal(db.data.balance, 10000 - amount);
  r = await call(app, '/api/agent', { text: 'pay electricity bill' });
  assert.equal(r.json.state, 'DONE');
  assert.match(r.json.reply, /already paid/);
});

test('E2E: mobile recharge asks for plan, rejects non-plan amount', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'mobile recharge pannu' });
  assert.equal(r.json.state, 'NEEDS_INFO');
  assert.match(r.json.reply, /Which number/);
  r = await call(app, '/api/agent', { text: '9876543210' });
  assert.match(r.json.reply, /Which SIM/);
  r = await call(app, '/api/agent', { text: 'jio' });
  assert.equal(r.json.state, 'NEEDS_INFO');
  assert.match(r.json.reply, /Jio Prepaid plans/);
  r = await call(app, '/api/agent', { text: '250' });
  assert.equal(r.json.state, 'NEEDS_INFO');
  assert.match(r.json.reply, /not a Jio Prepaid plan/);
  r = await call(app, '/api/agent', { text: '299' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.json.pending.amount, 299);
  assert.ok(r.json.pending.details.some((d: any) => d.label === 'Plan'));
  // operator + number spoken directly, not saved
  r = await call(app, '/api/agent', { text: 'airtel recharge 9123456780 379' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION', r.json.reply);
  assert.equal(r.json.pending.title, 'Airtel Prepaid');
});

test('E2E: gas booking, DTH, and Bills screen tap flow', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'gas cylinder book pannu' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.json.pending.amount, 868.5);
  r = await call(app, '/api/agent', { text: 'venaam' });
  assert.equal(r.json.state, 'CANCELLED');

  // a pending payment must never be confirmed by a NEW command that happens to contain "pay"
  r = await call(app, '/api/agent', { text: 'send 100 to arun' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  r = await call(app, '/api/agent', { text: 'pay 200 to priya' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(r.json.pending.title, 'Priya');

  r = await call(app, '/api/agent', { text: 'sun direct recharge 330' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION', r.json.reply);

  // Bills screen: save a new account, bad account rejected
  const bad = await call(app, '/api/bills/saved', { billerId: 'bescom', account: '123', nickname: 'Office' });
  assert.match(bad.json.error, /10 digits/);
  const good = await call(app, '/api/bills/saved', { billerId: 'bescom', account: '1234567890', nickname: 'Office' });
  assert.equal(good.json.saved.account, '12******90');
  const f = await call(app, '/api/bills/fetch', { savedBillId: good.json.saved.id });
  assert.ok(f.json.bill.amount > 0);
  const p = await call(app, '/api/bills/prepare', { savedBillId: good.json.saved.id });
  assert.equal(p.json.state, 'AWAITING_CONFIRMATION');
  assert.equal(p.json.pending.amount, f.json.bill.amount);

  // two electricity accounts now → voice asks which one, answer by nickname
  r = await call(app, '/api/agent', { text: 'electricity bill pay pannu' });
  assert.equal(r.json.state, 'AWAITING_CHOICE');
  r = await call(app, '/api/agent', { text: 'office' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  assert.match(r.json.pending.title, /BESCOM/);
});

// ---------------- voice-first additions ----------------
import { alnumFromSpeech, digitsFromSpeech, parseSpokenDob } from '../src/speech.js';

test('speech helpers: digits, PAN letters, dates', () => {
  assert.equal(digitsFromSpeech('98765 43210'), '9876543210');
  assert.equal(digitsFromSpeech('nine eight seven six five double four three two one'), '9876544321');
  assert.equal(digitsFromSpeech('2 3 4 5, 6 7 8 9, 0 1 2 4'), '234567890124');
  assert.equal(alnumFromSpeech('A B C P E 1 2 3 4 F'), 'ABCPE1234F');
  assert.equal(alnumFromSpeech('my PAN is abcpe1234f'), 'ABCPE1234F');
  assert.equal(parseSpokenDob('14th May 2001'), '2001-05-14');
  assert.equal(parseSpokenDob('14-05-2001'), '2001-05-14');
  assert.equal(parseSpokenDob('2001-05-14'), '2001-05-14');
  assert.equal(parseSpokenDob('whenever'), null);
});

test('voice navigation: screens are read out loud', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'open contacts' });
  assert.deepEqual(r.json.action, { type: 'navigate', screen: 'contacts' });
  assert.match(r.json.reply, /Ramesh Kumar.*Priya/);
  r = await call(app, '/api/agent', { text: 'who are my contacts' });
  assert.equal(r.json.action.screen, 'contacts');
  r = await call(app, '/api/agent', { text: 'show my bills' });
  assert.equal(r.json.action.screen, 'bills');
  assert.match(r.json.reply, /Home EB/);
  r = await call(app, '/api/agent', { text: 'show my history' });
  assert.equal(r.json.action.screen, 'history');
  assert.match(r.json.reply, /no payments yet/);
  r = await call(app, '/api/agent', { text: 'open profile' });
  assert.match(r.json.reply, /KYC is verified for Sasi Dharan/);
});

test('help, repeat and stop never break a pending question', async () => {
  const { app } = await readyApp();
  let r = await call(app, '/api/agent', { text: 'help' });
  assert.match(r.json.reply, /send money/i);
  r = await call(app, '/api/agent', { text: 'send 500 to priya' });
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  const question = r.json.reply;
  r = await call(app, '/api/agent', { text: 'repeat' });
  assert.equal(r.json.reply, question);
  assert.equal(r.json.state, 'AWAITING_CONFIRMATION');
  r = await call(app, '/api/agent', { text: 'yes' }); // still pending after "repeat"
  assert.equal(r.json.state, 'READY_TO_PAY');
  r = await call(app, '/api/agent', { text: 'stop listening' });
  assert.deepEqual(r.json.action, { type: 'stop_listening' });
});

test('voice says Google Pay while confirming a contact payment → UPI route', async () => {
  const { app } = await readyApp();
  await call(app, '/api/agent', { text: 'send 300 to arun' });
  const r = await call(app, '/api/agent', { text: 'use google pay' });
  assert.equal(r.json.state, 'READY_TO_PAY');
  assert.deepEqual(r.json.route, { method: 'upi', app: 'gpay' });
});

test('guided voice KYC: whole flow by speaking, nothing sensitive echoed back', async () => {
  const db = new Db(null);
  const { app } = createApp(db);
  const say = async (text: string) => (await call(app, '/api/agent', { text })).json;
  let r = await say('pay 500 to priya');
  assert.equal(r.state, 'KYC_REQUIRED');
  assert.match(r.reply, /start KYC/i);

  r = await say('start KYC');
  assert.equal(r.state, 'NEEDS_INFO');
  assert.equal(r.sensitive, true);
  r = await say('my name is sasi dharan');
  assert.match(r.reply, /date of birth/i);
  r = await say('14th May 2001');
  assert.match(r.reply, /PAN/);
  r = await say('A B C P E 1 2 3 4 F');
  assert.match(r.reply, /Aadhaar/);
  assert.equal(r.transcript, '••••');
  assert.deepEqual(r.log, []);
  r = await say(AADHAAR.split('').join(' '));
  assert.match(r.reply, /mobile/i);
  r = await say('9 8 7 6 5 4 3 2 1 0');
  assert.match(r.reply, /OTP/);
  const otp = r.reply.match(/here it is: ([\d ]+)\./)![1].replace(/ /g, '');
  assert.equal(otp.length, 6);
  r = await say('wrong guess 1 1 1 1 1 1');
  assert.match(r.reply, /Wrong OTP/);
  r = await say(otp.split('').join(' '));
  assert.equal(r.state, 'DONE');
  assert.equal(db.data.kyc.status, 'verified');
  assert.equal(db.data.kyc.name, 'Sasi Dharan');
  assert.ok(!JSON.stringify(db.data.kyc).includes(AADHAAR));

  r = await say('send 500 to priya');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
});

test('voice KYC: bad answers are re-asked, cancel works, stt endpoint needs a key', async () => {
  const db = new Db(null);
  const created = createApp(db);
  const say = async (text: string) => (await call(created.app, '/api/agent', { text })).json;
  await say('start kyc');
  let r = await say('12345');
  assert.match(r.reply, /Name should contain only letters/);
  r = await say('sasi dharan');
  r = await say('14 May 2015'); // under 18
  assert.match(r.reply, /18/);
  r = await say('cancel');
  assert.equal(r.state, 'CANCELLED');
  const stt = await call(created.app, '/api/stt', undefined, 'POST');
  assert.equal(stt.status, 400);
});

test('API_KEY guard: public deployments reject calls without the key', async () => {
  const { app } = createApp(new Db(null));
  process.env.API_KEY = 'secret123';
  try {
    assert.equal((await app.request('/api/health')).status, 200);
    assert.equal((await app.request('/api/wallet')).status, 401);
    assert.equal((await app.request('/api/wallet', { headers: { 'x-api-key': 'nope' } })).status, 401);
    assert.equal((await app.request('/api/wallet', { headers: { 'x-api-key': 'secret123' } })).status, 200);
    // checkout pages call back with their own random transaction id, so they stay reachable
    assert.equal((await app.request('/api/payments/tabcdef012345/cancel', { method: 'POST' })).status, 404);
  } finally {
    delete process.env.API_KEY;
  }
});

test('stateless host: every request rebuilds the app from JSON (Supabase Edge Function style)', async () => {
  let saved = { data: JSON.stringify(new Db(null).data), agent: null as unknown, kyc: null as unknown };
  const req = async <T>(fn: (app: any) => Promise<T>): Promise<T> => {
    const db = new Db(null);
    db.data = JSON.parse(saved.data);
    const kyc = new KycService();
    kyc.restore(saved.kyc);
    const { app, agent } = createApp(db, { kyc });
    agent.restore(saved.agent);
    const out = await fn(app);
    saved = { data: JSON.stringify(db.data), agent: JSON.parse(JSON.stringify(agent.snapshot())), kyc: JSON.parse(JSON.stringify(kyc.snapshot())) };
    return out;
  };
  const say = (text: string) => req(async (app) => (await call(app, '/api/agent', { text })).json);

  // voice KYC, one request at a time
  await say('start kyc');
  await say('sasi dharan');
  await say('14 May 2001');
  await say('A B C P E 1 2 3 4 F');
  await say(AADHAAR.split('').join(' '));
  const otpReply = await say('9876543210');
  const otp = otpReply.reply.match(/here it is: ([\d ]+)\./)![1].replace(/ /g, '');
  const done = await say(otp.split('').join(' '));
  assert.equal(done.state, 'DONE');
  assert.ok(!saved.data.includes(AADHAAR), 'full Aadhaar must never be stored');
  assert.ok(!JSON.stringify(saved.agent).includes('ABCPE1234F'), 'full PAN must never be stored');

  // payment across requests, checkout as JSON (HTML is not servable on Edge Functions)
  let r = await say('send 400 to arun');
  assert.equal(r.state, 'AWAITING_CONFIRMATION');
  r = await say('yes');
  assert.equal(r.state, 'READY_TO_PAY');
  const co = await req(async (app) => call(app, `/api/checkout/${r.pending.id}?auto=1`));
  assert.equal(co.status, 200);
  assert.ok(co.json.ok && co.json.html.includes('Arun') && co.json.html.includes("click()"));
  const txId = co.json.html.match(/payments\/(t[0-9a-f]+)\//)![1];
  const paid = await req(async (app) => call(app, `/api/payments/${txId}/demo-complete`, {}));
  assert.equal(paid.json.transaction.status, 'success');
  const w = await req(async (app) => call(app, '/api/wallet'));
  assert.equal(w.json.balance, 9600);
  // the same pending payment can never be opened twice
  const again = await req(async (app) => call(app, `/api/checkout/${r.pending.id}`));
  assert.equal(again.status, 400);
});

test('spelled letters: phonetic words, homophones and "P for Papa"', () => {
  assert.equal(alnumFromSpeech('A for Apple B for Boy C P for Papa E 1 2 3 4 F'), 'ABCPE1234F');
  assert.equal(alnumFromSpeech('a be see pea e one two three four ef'), 'ABCPE1234EF');
  assert.equal(alnumFromSpeech('Alpha Bravo Charlie Papa Echo 1 2 3 4 Foxtrot'), 'ABCPE1234F');
  assert.equal(alnumFromSpeech('ABCPE 1234 F'), 'ABCPE1234F');
});

test('voice KYC reads back what it heard, and "wrong" goes one step back', async () => {
  const db = new Db(null);
  const { app } = createApp(db);
  const say = async (text: string) => (await call(app, '/api/agent', { text })).json;
  let r = await say('start kyc');
  assert.equal(r.expect, 'name');
  r = await say('sasi dharan');
  assert.match(r.reply, /Got it: Sasi Dharan/);
  assert.equal(r.expect, 'dob');
  r = await say('14 May 2001');
  assert.match(r.reply, /Date of birth 14 May 2001/);
  assert.equal(r.expect, 'letters');
  r = await say('A for Apple B for Boy C P for Papa E 1 2 3 4 F');
  assert.match(r.reply, /PAN A B C P E 1 2 3 4 F/);
  assert.equal(r.expect, 'digits');
  r = await say('wrong'); // goes back to the PAN question
  assert.match(r.reply, /redo that.*PAN/);
  assert.equal(r.expect, 'letters');
  r = await say('wrong'); // and back to the date of birth
  assert.match(r.reply, /redo that.*date of birth/i);
  r = await say('15 June 1999');
  assert.match(r.reply, /Date of birth 15 June 1999/);
  assert.equal(r.log.length, 0);
});
