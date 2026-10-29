// Payment layer.
// 1) Razorpay gateway (TEST mode, free): real checkout UI, real signature verification, no real money.
// 2) UPI intent: opens GPay / PhonePe / Paytm with payee + amount pre-filled; the user enters their UPI PIN.
// Without Razorpay keys a built-in demo checkout is used, so the app works out of the box.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import type { Contact } from './db.ts';
import { UPI_RE } from './speech.ts';

const keyId = () => process.env.RAZORPAY_KEY_ID?.trim() || '';
const keySecret = () => process.env.RAZORPAY_KEY_SECRET?.trim() || '';
export const razorpayEnabled = () => keyId().length > 0 && keySecret().length > 0;
export const razorpayKeyId = keyId;

export async function createRazorpayOrder(amountInr: number, receipt: string, notes: Record<string, string>) {
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${keyId()}:${keySecret()}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: Math.round(amountInr * 100), currency: 'INR', receipt, notes }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Razorpay order failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { id: string; amount: number; currency: string };
}

/** Razorpay's documented check: HMAC_SHA256(order_id + "|" + payment_id, key_secret) === signature */
export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, secret = keySecret()): boolean {
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type UpiApp = 'gpay' | 'phonepe' | 'paytm' | 'any';

/** Standard NPCI UPI deep link. App-specific schemes open that app directly on Android. */
export function upiLink(contact: Contact, amount: number, ref: string, app: UpiApp = 'any'): string {
  const params = new URLSearchParams({
    pa: contact.upiId,
    pn: contact.name,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `VoicePay ${ref}`,
    tr: ref,
  });
  const q = params.toString().replace(/\+/g, '%20');
  switch (app) {
    case 'gpay': return `tez://upi/pay?${q}`;
    case 'phonepe': return `phonepe://pay?${q}`;
    case 'paytm': return `paytmmp://pay?${q}`;
    default: return `upi://pay?${q}`;
  }
}

/**
 * A scanned UPI QR code: upi://pay?pa=shop@okaxis&pn=Murugan%20Stores&am=120&cu=INR&tn=...
 * Returns the payee and an optional fixed amount, or an error sentence that is safe to speak.
 */
export function parseUpiQr(raw: string): { upiId: string; name: string; amount: number | null; merchant: boolean } | { error: string } {
  const text = String(raw ?? '').trim().slice(0, 2000);
  if (!/^upi:\/\/pay\?/i.test(text)) return { error: 'This QR code is not a UPI payment code. Please scan a shop or person QR from a UPI app.' };
  let q: URLSearchParams;
  try { q = new URL(text.replace(/^upi:\/\//i, 'https://upi.invalid/')).searchParams; } catch { return { error: 'I could not read this QR code. Please try again.' }; }
  const upiId = (q.get('pa') ?? '').trim();
  if (!UPI_RE.test(upiId)) return { error: 'This QR code does not have a valid UPI ID.' };
  const cur = (q.get('cu') ?? 'INR').toUpperCase();
  if (cur !== 'INR') return { error: 'This QR code asks for a payment in a currency other than rupees. I cannot pay it.' };
  const name = (q.get('pn') ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || upiId;
  const am = q.get('am');
  let amount: number | null = null;
  if (am !== null && am !== '') {
    amount = Number(am);
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'The amount in this QR code is not valid.' };
    amount = Math.round(amount * 100) / 100;
  }
  return { upiId, name, amount, merchant: !!q.get('mc') };
}

/** A link the user can share ("pay me 500"): opens any UPI app with the amount filled in. */
export function requestLink(upiId: string, name: string, amount: number, note: string): string {
  const q = new URLSearchParams({ pa: upiId, pn: name, am: amount.toFixed(2), cu: 'INR', tn: note.slice(0, 50) });
  return 'upi://pay?' + q.toString().replace(/\+/g, '%20');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** JSON for inline <script>: '<' escaped so text can never close the script tag. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const PAGE_STYLE = `
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Roboto,sans-serif;background:#0b1220;color:#e8eefc;
  display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:380px;background:#131c2e;border:1px solid #24304a;border-radius:20px;padding:28px;text-align:center}
  .to{color:#9fb0d0;font-size:14px}.name{font-size:20px;font-weight:600;margin:4px 0}.upi{color:#9fb0d0;font-size:13px}
  .amt{font-size:44px;font-weight:700;margin:20px 0}.tag{display:inline-block;background:#2a1f05;color:#ffcc66;border-radius:999px;
  padding:4px 10px;font-size:12px;margin-bottom:16px}button{width:100%;border:0;border-radius:14px;padding:16px;font-size:16px;
  font-weight:600;margin-top:10px}.pay{background:#3b82f6;color:#fff}.cancel{background:transparent;color:#9fb0d0;border:1px solid #24304a}
  .msg{margin-top:14px;color:#9fb0d0;font-size:14px;min-height:20px}`;

const BRIDGE = `
  const API = window.__API_BASE__ || '';
  function send(m){ if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(m));} }
  async function post(url, body){ const r = await fetch(API + url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return r.json(); }`;

export function checkoutPage(opts: {
  mode: 'razorpay' | 'demo';
  txId: string;
  title: string; // payee / biller name
  subtitle: string; // UPI ID or masked account
  amount: number;
  orderId?: string;
  keyId?: string;
  /** Demo gateway only: the user already said "yes" by voice, so pay without another tap. */
  auto?: boolean;
  /** "Paying" (default) or e.g. "Adding money to wallet". */
  heading?: string;
}): string {
  const { title, subtitle, amount, txId } = opts;
  const amountText = '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VoicePay Checkout</title><style>${PAGE_STYLE}</style></head><body><div class="card">
  <div class="tag">${opts.mode === 'razorpay' ? 'Razorpay TEST mode — no real money' : 'Demo gateway — no real money'}</div>
  <div class="to">${esc(opts.heading ?? 'Paying')}</div><div class="name">${esc(title)}</div><div class="upi">${esc(subtitle)}</div>
  <div class="amt">${amountText}</div>
  <button class="pay" id="pay">Pay ${amountText}</button><button class="cancel" id="cancel">Cancel</button><div class="msg" id="msg"></div></div>`;

  const cancel = `document.getElementById('cancel').onclick = async () => {
      await post('/api/payments/${txId}/cancel', {}); send({type:'cancelled', txId:'${txId}'}); };`;

  if (opts.mode === 'demo') {
    return `${head}<script>${BRIDGE}
    document.getElementById('pay').onclick = async () => {
      document.getElementById('msg').textContent = 'Processing…';
      const r = await post('/api/payments/${txId}/demo-complete', {});
      if (r.ok) send({type:'success', txId:'${txId}', refId:r.transaction.refId}); else { document.getElementById('msg').textContent = r.error || 'Failed'; send({type:'failed', txId:'${txId}', error:r.error}); }
    };
    ${cancel}
    ${opts.auto ? "setTimeout(() => document.getElementById('pay').click(), 900);" : ''}</script></body></html>`;
  }

  return `${head}<script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>${BRIDGE}
  const rzp = new Razorpay({
    key: ${js(opts.keyId)}, amount: ${Math.round(amount * 100)}, currency: 'INR', order_id: ${js(opts.orderId)},
    name: 'VoicePay', description: ${js(('Payment to ' + title).slice(0, 250))},
    notes: { payee: ${js(subtitle)} }, theme: { color: '#3b82f6' },
    handler: async (resp) => {
      document.getElementById('msg').textContent = 'Verifying payment…';
      const r = await post('/api/payments/${txId}/verify', resp);
      if (r.ok) send({type:'success', txId:'${txId}', refId:r.transaction.refId}); else { document.getElementById('msg').textContent = r.error || 'Verification failed'; send({type:'failed', txId:'${txId}', error:r.error}); }
    },
    modal: { ondismiss: () => { document.getElementById('msg').textContent = 'Checkout closed. Tap Pay to try again.'; } }
  });
  rzp.on('payment.failed', (e) => { document.getElementById('msg').textContent = (e.error && e.error.description) || 'Payment failed'; });
  document.getElementById('pay').onclick = () => rzp.open();
  ${cancel}
  setTimeout(() => rzp.open(), 300);
  </script></body></html>`;
}
