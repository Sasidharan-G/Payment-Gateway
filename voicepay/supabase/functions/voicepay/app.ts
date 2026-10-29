import process from 'node:process';
import { Hono } from 'npm:hono@4';
import { cors } from 'npm:hono@4/cors';
import { z } from 'npm:zod@4';
import { Agent, toPublic, type Pending } from './agent.ts';
import { BILLERS, CATEGORY_LABEL, NO_DUPLICATE_CATEGORIES, fetchBill, getBiller, maskAccount, validateAccount } from './billers.ts';
import { accountKey, type Db } from './db.ts';
import { KycService } from './kyc.ts';
import { llmEnabled, transcribe, translateReply, type ReplyLang } from './llm.ts';
import { realMode } from './mode.ts';
import { hardening, log, rateLimit, safeEqual, sizeLimit } from './security.ts';
import { synthesize, ttsEnabled } from './tts.ts';
import {
  checkoutPage, createRazorpayOrder, parseUpiQr, razorpayEnabled, razorpayKeyId, upiLink, verifyRazorpaySignature, type UpiApp,
} from './payments.ts';

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

const ContactIn = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  nickname: z.string().trim().max(40).optional().transform((v) => v || undefined),
  upiId: z.string().trim().regex(UPI_RE, 'Invalid UPI ID (example: name@okaxis)'),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Mobile number must be 10 digits').optional(),
  type: z.enum(['person', 'merchant']).default('person'),
});

const SavedBillIn = z.object({
  billerId: z.string(),
  account: z.string().trim().transform((v) => v.replace(/\s+/g, '')),
  nickname: z.string().trim().min(1, 'Nickname is required').max(30),
});

export function createApp(db: Db, opts: { kyc?: KycService } = {}) {
  const kyc = opts.kyc ?? new KycService();
  const agent = new Agent(db, kyc);
  const app = new Hono();
  app.use('*', hardening);
  app.use('*', cors());
  app.use('/api/*', sizeLimit);
  app.use('/api/*', rateLimit);

  // Optional shared secret for a public deployment: set API_KEY on the server and the same value as
  // EXPO_PUBLIC_API_KEY in the app. (The payment pages opened inside the WebView call back with their own
  // random transaction id, so those paths are exempt.) Real multi-user auth is the next step.
  app.use('/api/*', async (c, next) => {
    const key = process.env.API_KEY?.trim();
    const path = new URL(c.req.url).pathname;
    const exempt = path === '/api/health' || /^\/api\/payments\/t[0-9a-f]{12}\//.test(path);
    // Real mode: users are authenticated by their Supabase login (done in the Edge Function entry), not by a shared key.
    if (key && !realMode() && !exempt && !safeEqual(c.req.header('x-api-key') ?? '', key)) return c.json({ ok: false, error: 'Unauthorized' }, 401);
    await next();
  });

  app.onError((err, c) => {
    log('error', 'unhandled', { path: new URL(c.req.url).pathname, id: c.get('requestId' as never), message: (err as Error).message });
    return c.json({ ok: false, error: 'Something went wrong on the server. Please try again.' }, 500);
  });

  // ---------- health ----------
  app.get('/api/health', (c) =>
    c.json({ ok: true, llm: llmEnabled(), stt: llmEnabled(), tts: ttsEnabled(), gateway: realMode() ? 'upi' : razorpayEnabled() ? 'razorpay-test' : 'demo', real: realMode() }),
  );

  // ---------- KYC ----------
  app.get('/api/kyc', (c) => c.json({ ok: true, kyc: db.data.kyc }));

  app.post('/api/kyc/start', async (c) => {
    if (realMode()) return c.json({ ok: false, error: 'KYC is not needed: payments go through your own UPI app.' }, 400);
    const r = kyc.start(await c.req.json().catch(() => ({})));
    if (!r.ok) return c.json(r, 400);
    // No SMS gateway in a free demo: the OTP is returned so the app can show it.
    // With a real SMS/KYC provider, send r.otp by SMS and remove demoOtp from this response.
    return c.json({ ok: true, sessionId: r.sessionId, mobileMasked: r.mobileMasked, demoOtp: r.otp });
  });

  app.post('/api/kyc/verify', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const r = kyc.verify(String(b.sessionId ?? ''), String(b.otp ?? ''));
    if (!r.ok) return c.json(r, 400);
    db.setKyc(r.kyc);
    return c.json({ ok: true, kyc: r.kyc });
  });

  // ---------- wallet / contacts / history ----------
  app.get('/api/wallet', (c) => c.json({ ok: true, balance: db.data.balance, spentToday: db.spentToday() }));
  app.get('/api/contacts', (c) => c.json({ ok: true, contacts: db.data.contacts }));

  app.post('/api/contacts', async (c) => {
    const parsed = ContactIn.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0].message }, 400);
    if (db.data.contacts.some((x) => x.upiId.toLowerCase() === parsed.data.upiId.toLowerCase())) {
      return c.json({ ok: false, error: 'A contact with this UPI ID already exists.' }, 400);
    }
    return c.json({ ok: true, contact: db.addContact(parsed.data) });
  });

  app.delete('/api/contacts/:id', (c) =>
    db.deleteContact(c.req.param('id')) ? c.json({ ok: true }) : c.json({ ok: false, error: 'Contact not found' }, 404),
  );

  app.get('/api/transactions', (c) => c.json({ ok: true, transactions: db.data.transactions.slice(0, 100) }));

  app.post('/api/reset', (c) => {
    if (realMode()) return c.json({ ok: false, error: 'Not available.' }, 404);
    db.reset();
    agent.reset();
    return c.json({ ok: true });
  });

  // ---------- bills ----------
  app.get('/api/billers', (c) => c.json({ ok: true, billers: BILLERS, categories: CATEGORY_LABEL }));

  app.get('/api/bills/saved', (c) =>
    c.json({
      ok: true,
      saved: db.data.savedBills.map((b) => ({ ...b, account: maskAccount(b.account), billerName: getBiller(b.billerId)?.name ?? b.billerId })),
    }),
  );

  app.post('/api/bills/saved', async (c) => {
    const parsed = SavedBillIn.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0].message }, 400);
    const biller = getBiller(parsed.data.billerId);
    if (!biller) return c.json({ ok: false, error: 'Unknown biller' }, 400);
    const err = validateAccount(biller, parsed.data.account);
    if (err) return c.json({ ok: false, error: err }, 400);
    if (db.data.savedBills.some((b) => b.billerId === biller.id && b.account === parsed.data.account)) {
      return c.json({ ok: false, error: 'This account is already saved.' }, 400);
    }
    const saved = db.addSavedBill({ category: biller.category, billerId: biller.id, account: parsed.data.account, nickname: parsed.data.nickname });
    return c.json({ ok: true, saved: { ...saved, account: maskAccount(saved.account), billerName: biller.name } });
  });

  app.delete('/api/bills/saved/:id', (c) =>
    db.deleteSavedBill(c.req.param('id')) ? c.json({ ok: true }) : c.json({ ok: false, error: 'Not found' }, 404),
  );

  /** Fetch (preview) a bill. Accepts either a saved bill id or billerId + account. */
  app.post('/api/bills/fetch', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const resolved = resolveBillInput(b);
    if ('error' in resolved) return c.json({ ok: false, error: resolved.error }, 400);
    const bill = fetchBill(resolved.biller, resolved.account);
    const paid = NO_DUPLICATE_CATEGORIES.includes(resolved.biller.category) ? db.recentlyPaid(resolved.biller.id, bill.account) : null;
    return c.json({ ok: true, bill: { ...bill, account: maskAccount(bill.account) }, alreadyPaid: paid ? { refId: paid.refId, at: paid.createdAt } : null });
  });

  /** Tap-to-pay from the Bills screen: same checks as voice (KYC, limits, plans, duplicates). */
  app.post('/api/bills/prepare', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const resolved = resolveBillInput(b);
    if ('error' in resolved) return c.json({ ok: false, error: resolved.error }, 400);
    const amount = b.amount === undefined || b.amount === null ? null : Number(b.amount);
    const r = agent.billFlow(resolved.biller, resolved.account, amount, 'tap', []);
    return c.json({ ok: r.state === 'AWAITING_CONFIRMATION', error: r.state === 'AWAITING_CONFIRMATION' ? undefined : r.reply, ...r });
  });

  /** Tap-to-pay a contact without voice. */
  app.post('/api/pay/prepare', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const contact = db.data.contacts.find((x) => x.id === b.contactId);
    if (!contact) return c.json({ ok: false, error: 'Contact not found' }, 404);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount)) return c.json({ ok: false, error: 'Enter a valid amount' }, 400);
    const r = agent.prepare({ kind: 'contact', contact }, amount, 'tap', []);
    return c.json({ ok: r.state === 'AWAITING_CONFIRMATION', error: r.state === 'AWAITING_CONFIRMATION' ? undefined : r.reply, ...r });
  });

  /** A scanned QR code (the text inside it). Same checks as voice; the reply is spoken by the app. */
  app.post('/api/pay/qr', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const qr = parseUpiQr(String(b.link ?? ''));
    if ('error' in qr) return c.json({ ok: true, reply: qr.error, state: 'ERROR', log: [] });
    const r = agent.payQr(qr, []);
    return c.json({ ok: true, transcript: '', ...r });
  });

  function resolveBillInput(b: any): { biller: NonNullable<ReturnType<typeof getBiller>>; account: string } | { error: string } {
    if (b.savedBillId) {
      const s = db.data.savedBills.find((x) => x.id === b.savedBillId);
      if (!s) return { error: 'Saved bill not found' };
      return { biller: getBiller(s.billerId)!, account: s.account };
    }
    const biller = getBiller(String(b.billerId ?? ''));
    if (!biller) return { error: 'Choose a biller' };
    const account = String(b.account ?? '').replace(/\s+/g, '');
    const err = validateAccount(biller, account);
    return err ? { error: err } : { biller, account };
  }

  // ---------- agent ----------
  app.post('/api/agent', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text.slice(0, 500) : '';
    return respond(c, text, { lowConfidence: body.lowConfidence === true, lang: body.lang === 'ta' || body.lang === 'tg' ? body.lang : 'en' });
  });

  /** Same reply for typed and spoken commands. While KYC details are being spoken, nothing is echoed back. */
  async function respond(c: any, text: string, opts?: { lowConfidence?: boolean; lang?: ReplyLang }) {
    const r = await agent.handle(text, opts);
    if (opts?.lang && opts.lang !== 'en') r.reply = await translateReply(r.reply, opts.lang);
    return c.json({ ok: true, transcript: r.sensitive ? '••••' : text, ...r });
  }

  /** Speech to text only (the app runs the agent itself, so it can speak and listen in a loop). */
  app.post('/api/stt', async (c) => {
    if (!llmEnabled()) return c.json({ ok: false, error: 'Voice needs a free GROQ_API_KEY in server/.env.' }, 400);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof Blob) || file.size === 0) return c.json({ ok: false, error: 'No audio received' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ ok: false, error: 'Audio too long' }, 400);
    const t = await transcribe(file, (file as File).name || 'voice.m4a', String(form?.get('expect') ?? ''), form?.get('vocab'));
    if (t === null) return c.json({ ok: false, error: "Sorry, I couldn't hear that clearly. Please try again." }, 502);
    return c.json({ ok: true, text: t.text, low: t.low });
  });

  /** Natural voice (optional): text in, base64 WAV out. 204-style "off" answer when no engine is configured. */
  app.post('/api/tts', async (c) => {
    if (!ttsEnabled()) return c.json({ ok: false, error: 'Natural voice is not set up on the server.' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const out = await synthesize(typeof b.text === 'string' ? b.text : '');
    if (!out) return c.json({ ok: false, error: 'Voice engine did not answer.' }, 502);
    return c.json({ ok: true, ...out });
  });

  /** Voice: multipart field "audio" → Whisper → agent. */
  app.post('/api/voice', async (c) => {
    if (!llmEnabled()) {
      return c.json({ ok: false, error: 'Voice needs a free GROQ_API_KEY in server/.env. You can type the command meanwhile.' }, 400);
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof Blob) || file.size === 0) return c.json({ ok: false, error: 'No audio received' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ ok: false, error: 'Audio too long' }, 400);
    const t = await transcribe(file, (file as File).name || 'voice.m4a', '', form?.get('vocab'));
    if (!t?.text) return c.json({ ok: false, error: "Sorry, I couldn't hear that clearly. Please try again." }, 502);
    return respond(c, t.text, { lowConfidence: t.low });
  });

  // ---------- payments ----------
  const takePending = (id: string): { p: Pending } | { error: string } => {
    if (!realMode() && db.data.kyc.status !== 'verified') return { error: 'Please complete KYC first.' };
    const p = agent.getPending(id);
    if (!p) return { error: 'This payment request expired. Please say the command again.' };
    if (p.used) return { error: 'This payment was already processed.' };
    if (!realMode() && razorpayEnabled() && p.payee.kind !== 'topup' && p.amount > db.data.balance) return { error: 'Insufficient balance.' };
    return { p };
  };

  const txFields = (p: Pending) => {
    const pub = toPublic(p);
    const payee = p.payee;
    switch (payee.kind) {
      case 'contact': return { category: 'transfer' as const, payeeName: payee.contact.name, payeeRef: payee.contact.upiId, contactId: payee.contact.id };
      case 'topup': return { category: 'topup' as const, payeeName: 'VoicePay wallet', payeeRef: 'wallet' };
      case 'bank': return { category: 'bank' as const, payeeName: payee.name, payeeRef: pub.subtitle };
      case 'bill': return { category: payee.category, payeeName: payee.biller.name, payeeRef: pub.subtitle, billerId: payee.biller.id, accountKey: accountKey(payee.biller.id, payee.account) };
    }
  };

  /** Builds the checkout page for a pending payment. Opening it = the user's explicit confirmation. */
  async function buildCheckout(pendingId: string, auto: boolean): Promise<{ status: number; html: string }> {
    const page = (msg: string) => `<p style="font-family:sans-serif;padding:24px">${msg}</p>`;
    if (realMode()) return { status: 400, html: page('Pay people and shops with your UPI app (Google Pay, PhonePe or Paytm).') };
    const r = takePending(pendingId);
    if ('error' in r) return { status: 400, html: page(r.error) };
    const { p } = r;
    agent.consume(p.id);
    const pub = toPublic(p);
    const tx = db.addTransaction({ ...txFields(p), amount: p.amount, method: 'gateway', status: 'initiated', transcript: p.transcript });
    if (!razorpayEnabled()) return { status: 200, html: checkoutPage({ mode: 'demo', txId: tx.id, title: pub.title, subtitle: pub.subtitle, amount: p.amount, auto, heading: p.payee.kind === 'topup' ? 'Adding money' : undefined }) };
    try {
      const order = await createRazorpayOrder(p.amount, tx.refId, { payee: pub.title.slice(0, 200), ref: pub.subtitle.slice(0, 200) });
      db.setTransactionStatus(tx.id, 'initiated', { gatewayOrderId: order.id });
      return { status: 200, html: checkoutPage({ mode: 'razorpay', txId: tx.id, title: pub.title, subtitle: pub.subtitle, amount: p.amount, orderId: order.id, keyId: razorpayKeyId(), heading: p.payee.kind === 'topup' ? 'Adding money' : undefined }) };
    } catch (e) {
      db.setTransactionStatus(tx.id, 'failed');
      console.error('[razorpay]', (e as Error).message);
      return { status: 502, html: page('Payment gateway error. Check the Razorpay keys on the server.') };
    }
  }

  /** As a web page (works on a normal server). */
  app.get('/checkout/:pendingId', async (c) => {
    const r = await buildCheckout(c.req.param('pendingId'), c.req.query('auto') === '1');
    return c.html(r.html, r.status as 200);
  });

  /** As JSON: the app loads the HTML into its WebView itself. Needed on hosts that refuse to serve HTML (Supabase Edge Functions). */
  app.get('/api/checkout/:pendingId', async (c) => {
    const r = await buildCheckout(c.req.param('pendingId'), c.req.query('auto') === '1');
    return c.json({ ok: r.status === 200, html: r.html, error: r.status === 200 ? undefined : r.html.replace(/<[^>]+>/g, '') }, r.status as 200);
  });

  const findTx = (id: string) => db.data.transactions.find((t) => t.id === id);

  app.post('/api/payments/:txId/verify', async (c) => {
    const tx = findTx(c.req.param('txId'));
    if (!tx) return c.json({ ok: false, error: 'Transaction not found' }, 404);
    if (tx.status === 'success') return c.json({ ok: true, transaction: tx });
    if (tx.status !== 'initiated') return c.json({ ok: false, error: `Transaction is ${tx.status}` }, 400);
    const b = await c.req.json().catch(() => ({}));
    const orderId = String(b.razorpay_order_id ?? '');
    const paymentId = String(b.razorpay_payment_id ?? '');
    const signature = String(b.razorpay_signature ?? '');
    if (orderId !== tx.gatewayOrderId || !verifyRazorpaySignature(orderId, paymentId, signature)) {
      db.setTransactionStatus(tx.id, 'failed');
      return c.json({ ok: false, error: 'Payment signature verification failed' }, 400);
    }
    return c.json({ ok: true, transaction: db.setTransactionStatus(tx.id, 'success', { gatewayPaymentId: paymentId }) });
  });

  app.post('/api/payments/:txId/demo-complete', (c) => {
    if (realMode() || razorpayEnabled()) return c.json({ ok: false, error: 'Demo gateway is off.' }, 400);
    const tx = findTx(c.req.param('txId'));
    if (!tx) return c.json({ ok: false, error: 'Transaction not found' }, 404);
    if (tx.status === 'success') return c.json({ ok: true, transaction: tx });
    // Mock gateway: a mock payment always succeeds. If the demo wallet is short, it is topped up first.
    if (tx.category !== 'topup' && tx.amount > db.data.balance) {
      db.data.balance = Math.round((db.data.balance + (tx.amount - db.data.balance) + 1000) * 100) / 100;
      db.save();
    }
    return c.json({ ok: true, transaction: db.setTransactionStatus(tx.id, 'success', { gatewayPaymentId: 'demo_' + tx.refId }) });
  });

  app.post('/api/payments/:txId/cancel', (c) => {
    const tx = findTx(c.req.param('txId'));
    if (!tx) return c.json({ ok: false, error: 'Transaction not found' }, 404);
    if (tx.status === 'initiated') db.setTransactionStatus(tx.id, 'cancelled');
    return c.json({ ok: true, transaction: tx });
  });

  /** UPI app route (people and shops only): deep link that opens GPay/PhonePe/Paytm pre-filled. */
  app.post('/api/payments/upi', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const r = takePending(String(b.pendingId ?? ''));
    if ('error' in r) return c.json({ ok: false, error: r.error }, 400);
    const { p } = r;
    if (p.payee.kind !== 'contact') return c.json({ ok: false, error: 'Bills are paid through the payment gateway.' }, 400);
    const appName: UpiApp = ['gpay', 'phonepe', 'paytm'].includes(b.app) ? b.app : 'any';
    agent.consume(p.id);
    const tx = db.addTransaction({ ...txFields(p), amount: p.amount, method: 'upi_app', status: 'initiated', transcript: p.transcript });
    const contact = p.payee.contact;
    return c.json({ ok: true, transaction: tx, link: upiLink(contact, p.amount, tx.refId, appName), fallbackLink: upiLink(contact, p.amount, tx.refId, 'any') });
  });

  /** After returning from the UPI app the user tells us whether it went through. */
  app.post('/api/payments/:txId/upi-result', async (c) => {
    const tx = findTx(c.req.param('txId'));
    if (!tx || tx.method !== 'upi_app') return c.json({ ok: false, error: 'Transaction not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const status = b.status === 'success' ? 'success' : b.status === 'failed' ? 'failed' : 'cancelled';
    if (tx.status !== 'initiated') return c.json({ ok: true, transaction: tx });
    return c.json({ ok: true, transaction: db.setTransactionStatus(tx.id, status) });
  });

  return { app, agent, kyc };
}
