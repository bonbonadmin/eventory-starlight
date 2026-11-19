const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.umask(0o077);

const express = require('express');
const { stmts, syncPerformances } = require('./db');
const xendit = require('./xendit');
const payments = require('./payments');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const VOTE_PRICE = Number(process.env.VOTE_PRICE) || 5000;
const MAX_VOTES = Number(process.env.MAX_VOTES_PER_ORDER) || 1000;
const SHOW_RESULTS = (process.env.SHOW_RESULTS || 'true').toLowerCase() === 'true';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const mock = xendit.mode === 'mock';
const paymentMethods = xendit.enabledChannels.map(code => {
  const method = xendit.channels[code];
  return { code, name: method.name, kind: method.wallet ? 'wallet' : code === 'QRIS' ? 'qr' : 'bank',
    requiresPhone: Boolean(method.requiresPhone), minVotes: Math.max(1, Math.ceil(method.min / VOTE_PRICE)),
    maxVotes: Math.min(MAX_VOTES, Math.floor(method.max / VOTE_PRICE)) };
}).filter(method => method.minVotes <= method.maxVotes);
const minVotes = xendit.configured ? Math.min(...paymentMethods.map(method => method.minVotes)) : 1;
const maxVotes = xendit.configured ? Math.max(...paymentMethods.map(method => method.maxVotes)) : MAX_VOTES;

syncPerformances(path.join(__dirname, '..', 'data', 'performances.json'));

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const parseJson = express.json({ limit: '100kb' });

// Authenticate before reading the payload. Test and live use separate paths and databases.
app.post(['/api/xendit/v3', '/api/xendit/v3/test'], (req, res, next) => {
  const expectedPath = xendit.mode === 'test' ? '/api/xendit/v3/test' : '/api/xendit/v3';
  if (!xendit.configured || req.path !== expectedPath) return res.sendStatus(503);
  if (!xendit.verifyCallbackToken(req.get('x-callback-token'))) return res.sendStatus(401);
  next();
}, parseJson, (req, res) => res.sendStatus(payments.acceptWebhook(req.body)));

app.use(parseJson);
// The mock checkout page only exists when payments are simulated.
app.get(['/mock-pay', '/mock-pay.html'], (req, res, next) => (mock ? next() : res.sendStatus(404)));
app.get(['/status', '/status.html'], (req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- helpers ----------

// Small in-memory limiter for checkout creation (per IP, sliding window).
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests, please wait a moment.' });
    list.push(now);
    hits.set(req.ip, list);
    next();
  };
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
  const key = Buffer.from(req.get('x-admin-key') || '');
  const expected = Buffer.from(ADMIN_KEY);
  const ok = expected.length > 0 && key.length === expected.length && crypto.timingSafeEqual(key, expected);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function receiptCookieName(id) { return `starlight-order-${id}`; }

function rememberReceipt(res, id, key) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) return;
  res.cookie(receiptCookieName(id), key, { httpOnly: true, secure: BASE_URL.startsWith('https://'),
    sameSite: 'lax', path: `/api/orders/${id}`, maxAge: 8 * 24 * 60 * 60 * 1000 });
}

function receiptKey(req, id) {
  const header = req.get('x-order-access');
  if (header) return header;
  const prefix = `${receiptCookieName(id)}=`;
  return (req.get('cookie') || '').split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
}

async function publicOrder(o, attempt) {
  const canPay = attempt && attempt.state === 'AWAITING_PAYMENT' &&
    ['REQUIRES_ACTION', 'ACCEPTING_PAYMENTS', 'PENDING'].includes(attempt.provider_status) &&
    attempt.expires_at > Date.now();
  return {
    id: o.id,
    status: o.status,
    votes: o.votes,
    amount: o.amount,
    performanceId: o.performance_id,
    performanceName: o.performance_name,
    invoiceUrl: mock && o.status === 'PENDING' && o.xendit_invoice_id?.startsWith('mock-') ? o.invoice_url : null,
    paymentState: attempt?.state,
    test: attempt?.environment === 'test',
    channelCode: attempt?.channel_code,
    paymentMethod: attempt ? xendit.channels[attempt.channel_code]?.name : undefined,
    paymentKind: attempt ? xendit.channels[attempt.channel_code]?.wallet ? 'wallet' : attempt.channel_code === 'QRIS' ? 'qr' : 'bank' : undefined,
    walletPayment: Boolean(canPay && xendit.channels[attempt.channel_code]?.wallet && !attempt.issue),
    paymentActions: canPay ? JSON.parse(attempt.payment_actions || '[]') : [],
    paymentError: attempt?.state === 'FAILED'
      ? 'This payment method is currently unavailable. Please choose another payment method or contact the organizers.' : null,
    bank: attempt && !xendit.channels[attempt.channel_code]?.wallet && attempt.channel_code !== 'QRIS'
      ? xendit.channels[attempt.channel_code]?.name : null,
    virtualAccount: canPay ? attempt.va_number : null,
    qrCodeImage: canPay && attempt.channel_code === 'QRIS' && attempt.qr_string
      ? await QRCode.toDataURL(attempt.qr_string, { width: 384, margin: 4, errorCorrectionLevel: 'M' }) : null,
    expiresAt: attempt ? new Date(attempt.expires_at).toISOString() : null,
  };
}

// ---------- public API ----------

app.get('/api/config', (req, res) => {
  res.json({ votePrice: VOTE_PRICE, minVotes, maxVotes, showResults: SHOW_RESULTS, mock,
    paymentsOpen: xendit.acceptsOrders && minVotes <= maxVotes, paymentMode: xendit.configured ? xendit.mode : mock ? 'mock' : 'disabled',
    channelCode: xendit.configured ? xendit.defaultChannel : null,
    paymentMethods: xendit.configured ? paymentMethods : [],
    paymentMethod: xendit.configured ? xendit.channels[xendit.defaultChannel].name : null,
    bank: xendit.configured && !xendit.channels[xendit.defaultChannel].wallet && xendit.defaultChannel !== 'QRIS'
      ? xendit.channels[xendit.defaultChannel].name : null });
});

app.get('/api/performances', (req, res) => {
  const list = stmts.listPerformances.all(Number(mock)).map((p) => ({ ...p, votes: SHOW_RESULTS ? p.votes : undefined }));
  res.json(list);
});

app.get('/api/performances/:id', (req, res) => {
  const p = stmts.getPerformance.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Performance not found' });
  res.json(p);
});

app.post('/api/orders', rateLimit(10, 60 * 1000), async (req, res) => {
  const { performanceId, votes, name, email } = req.body || {};
  const channelCode = req.body?.channelCode ?? xendit.defaultChannel;
  const method = paymentMethods.find(method => method.code === channelCode);
  const count = Number(votes);
  const hash = mock ? null : payments.checkoutHash(req.get('x-order-access'));
  if (!mock && !hash) return res.status(400).json({ error: 'A valid checkout key is required.' });

  if (hash) {
    const existing = payments.findCheckout(hash);
    if (existing) {
      rememberReceipt(res, existing.order_id, req.get('x-order-access'));
      return sendExistingCheckout(res, existing, performanceId, count, req.body?.channelCode);
    }
  }
  if (!xendit.acceptsOrders || minVotes > maxVotes) {
    return res.status(503).json({ error: 'Voting checkout is currently unavailable.' });
  }
  if (!mock && !method) return res.status(400).json({ error: 'Please choose an available payment method.' });
  const performance = stmts.getPerformance.get(String(performanceId || ''));
  if (!performance) return res.status(400).json({ error: 'Please choose a valid performance.' });
  const methodMin = mock ? minVotes : method.minVotes;
  const methodMax = mock ? maxVotes : method.maxVotes;
  if (!Number.isInteger(count) || count < methodMin || count > methodMax) {
    return res.status(400).json({ error: `Votes must be a whole number between ${methodMin} and ${methodMax}.` });
  }

  let phoneNumber;
  if (!mock && method.requiresPhone) {
    phoneNumber = typeof req.body.phoneNumber === 'string' ? req.body.phoneNumber.trim().replace(/[\s()-]/g, '') : '';
    if (phoneNumber.startsWith('08')) phoneNumber = '+62' + phoneNumber.slice(1);
    else if (phoneNumber.startsWith('628')) phoneNumber = '+' + phoneNumber;
    if (!/^\+628\d{7,11}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Enter the Indonesian phone number registered with OVO, for example 081234567890.' });
    }
  }

  const voterName = String(name || '').trim().slice(0, 80);
  const voterEmail = String(email || '').trim().slice(0, 120);
  if (voterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(voterEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address, or leave it empty.' });
  }
  const amount = count * VOTE_PRICE;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid payment amount.' });
  }
  const id = `SL-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
  if (mock) {
    const checkoutUrl = `/mock-pay?order=${id}`;
    stmts.insertOrder.run(id, performance.id, count, amount, voterName, voterEmail);
    stmts.attachInvoice.run(`mock-${id}`, checkoutUrl, id);
    return res.status(201).json({ orderId: id, checkoutUrl, amount, votes: count });
  }

  const { attempt, existing } = payments.reserveOrder({ id, hash, performanceId: performance.id,
    votes: count, amount, voterName, voterEmail, channelCode });
  rememberReceipt(res, existing?.order_id || id, req.get('x-order-access'));
  if (existing) return sendExistingCheckout(res, existing, performanceId, count, channelCode);
  await payments.create(attempt, { phoneNumber, returnUrl: `${BASE_URL}/status?order=${encodeURIComponent(id)}` });
  res.status(201).json(checkoutResponse(id, amount, count));
});

function checkoutResponse(id, amount, votes) {
  return { orderId: id, checkoutUrl: `/status?order=${id}`, amount, votes };
}

function sendExistingCheckout(res, existing, performanceId, votes, channelCode) {
  if (existing.performance_id !== performanceId || existing.votes !== votes) {
    return res.status(409).json({ error: `This checkout was opened for ${existing.votes} vote(s). Use that quantity to resume payment.` });
  }
  if (channelCode !== undefined && existing.channel_code !== channelCode) {
    return res.status(409).json({ error: 'This checkout already uses a different payment method. Resume the original payment before starting another.' });
  }
  return res.json(checkoutResponse(existing.order_id, existing.amount, existing.votes));
}

app.get('/api/orders/:id', async (req, res) => {
  const id = req.params.id;
  const key = receiptKey(req, id);
  const attempt = payments.attemptForOrder(id, key);
  if (attempt === null) return res.status(404).json({ error: 'Order not found' });
  const order = stmts.getOrder.get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (attempt) rememberReceipt(res, id, key);
  res.json(await publicOrder(order, attempt));
});

if (mock) {
  app.post('/api/mock/pay/:id', (req, res) => {
    const order = stmts.getOrder.get(req.params.id);
    if (!order?.xendit_invoice_id?.startsWith('mock-')) return res.status(404).json({ error: 'Order not found' });
    const result = req.body?.outcome === 'EXPIRED' ? 'EXPIRED' : 'PAID';
    if (result === 'EXPIRED') stmts.markExpired.run(null, order.id);
    else stmts.markPaid.run('MOCK', null, order.id);
    res.json({ ok: true, result });
  });
}

// ---------- admin ----------

app.get('/api/admin/results', requireAdmin, (req, res) => {
  const rows = stmts.listPerformances.all(Number(mock));
  res.json(rows.map((p) => ({ ...p,
    revenue: stmts.revenueForPerformance.get(p.id, Number(mock)).revenue })));
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(stmts.recentOrders.all(limit));
});

app.get('/api/admin/payment-review', requireAdmin, (req, res) => res.json(payments.review()));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html')));

app.use((err, req, res, next) => {
  console.error(`[server] ${req.method} request failed (${err.code || err.type || err.name})`);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
});

app.listen(PORT, HOST, () => {
  console.log(`Starlight voting running at ${BASE_URL} (port ${PORT})`);
  console.log(`Payment mode: ${xendit.configured ? xendit.mode : mock ? 'mock' : 'disabled'}. New checkout: ${xendit.acceptsOrders ? 'open' : 'paused'}.`);
  payments.startWorker();
});
