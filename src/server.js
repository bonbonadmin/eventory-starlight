const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
const minVotes = xendit.configured ? Math.ceil(xendit.bank.min / VOTE_PRICE) : 1;
const maxVotes = xendit.configured ? Math.min(MAX_VOTES, Math.floor(xendit.bank.max / VOTE_PRICE)) : MAX_VOTES;

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

function publicOrder(o, attempt) {
  const canPay = attempt && attempt.state === 'AWAITING_PAYMENT' &&
    ['REQUIRES_ACTION', 'ACCEPTING_PAYMENTS', 'PENDING'].includes(attempt.provider_status) &&
    attempt.va_number && attempt.expires_at > Date.now();
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
    bank: attempt ? xendit.banks[attempt.channel_code]?.name : undefined,
    virtualAccount: canPay ? attempt.va_number : null,
    expiresAt: attempt ? new Date(attempt.expires_at).toISOString() : null,
  };
}

// ---------- public API ----------

app.get('/api/config', (req, res) => {
  res.json({ votePrice: VOTE_PRICE, minVotes, maxVotes, showResults: SHOW_RESULTS, mock,
    paymentsOpen: xendit.acceptsOrders && minVotes <= maxVotes, paymentMode: xendit.configured ? xendit.mode : mock ? 'mock' : 'disabled',
    bank: xendit.configured ? xendit.bank.name : null });
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
  const count = Number(votes);
  const hash = mock ? null : payments.checkoutHash(req.get('x-order-access'));
  if (!mock && !hash) return res.status(400).json({ error: 'A valid checkout key is required.' });

  if (hash) {
    const existing = payments.findCheckout(hash);
    if (existing) return sendExistingCheckout(res, existing, performanceId, count);
  }
  if (!xendit.acceptsOrders || minVotes > maxVotes) {
    return res.status(503).json({ error: 'Voting checkout is currently unavailable.' });
  }
  const performance = stmts.getPerformance.get(String(performanceId || ''));
  if (!performance) return res.status(400).json({ error: 'Please choose a valid performance.' });
  if (!Number.isInteger(count) || count < minVotes || count > maxVotes) {
    return res.status(400).json({ error: `Votes must be a whole number between ${minVotes} and ${maxVotes}.` });
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
    votes: count, amount, voterName, voterEmail });
  if (existing) return sendExistingCheckout(res, existing, performanceId, count);
  await payments.create(attempt);
  res.status(201).json(checkoutResponse(id, amount, count));
});

function checkoutResponse(id, amount, votes) {
  return { orderId: id, checkoutUrl: `/status?order=${id}`, amount, votes };
}

function sendExistingCheckout(res, existing, performanceId, votes) {
  if (existing.performance_id !== performanceId || existing.votes !== votes) {
    return res.status(409).json({ error: `This checkout was opened for ${existing.votes} vote(s). Use that quantity to resume payment.` });
  }
  return res.json(checkoutResponse(existing.order_id, existing.amount, existing.votes));
}

app.get('/api/orders/:id', (req, res) => {
  const id = req.params.id;
  const attempt = payments.attemptForOrder(id, req.get('x-order-access'));
  if (attempt === null) return res.status(404).json({ error: 'Order not found' });
  const order = stmts.getOrder.get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrder(order, attempt));
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
  res.json(rows.map((p) => ({ ...p, revenue: p.votes * VOTE_PRICE })));
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(stmts.recentOrders.all(limit));
});

app.get('/api/admin/payment-review', requireAdmin, (req, res) => res.json(payments.review()));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(`[server] ${req.method} request failed (${err.code || err.type || err.name})`);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
});

app.listen(PORT, HOST, () => {
  console.log(`Starlight voting running at ${BASE_URL} (port ${PORT})`);
  console.log(`Payment mode: ${xendit.configured ? xendit.mode : mock ? 'mock' : 'disabled'}. New checkout: ${xendit.acceptsOrders ? 'open' : 'paused'}.`);
  payments.startWorker();
});
