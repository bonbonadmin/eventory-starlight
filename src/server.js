const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const express = require('express');
const { stmts, syncPerformances } = require('./db');
const xendit = require('./xendit');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const VOTE_PRICE = Number(process.env.VOTE_PRICE) || 5000;
const MAX_VOTES = Number(process.env.MAX_VOTES_PER_ORDER) || 1000;
const INVOICE_DURATION = Number(process.env.INVOICE_DURATION) || 3600;
const SHOW_RESULTS = (process.env.SHOW_RESULTS || 'true').toLowerCase() === 'true';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

syncPerformances(path.join(__dirname, '..', 'data', 'performances.json'));

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
// The mock checkout page only exists when payments are simulated.
app.use('/mock-pay', (req, res, next) => (xendit.isMock ? next() : res.status(404).send('Not found')));
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
  const key = req.get('x-admin-key') || '';
  const ok = ADMIN_KEY && key.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function publicOrder(o) {
  return {
    id: o.id,
    status: o.status,
    votes: o.votes,
    amount: o.amount,
    performanceId: o.performance_id,
    performanceName: o.performance_name,
    invoiceUrl: o.status === 'PENDING' ? o.invoice_url : null,
  };
}

// Applies a verified invoice state to an order. Only PAID/SETTLED with a matching amount confirms votes.
function applyInvoiceState(order, invoice, rawPayload) {
  const status = String(invoice.status || '').toUpperCase();
  const payload = JSON.stringify(rawPayload);

  if (status === 'PAID' || status === 'SETTLED') {
    const paid = Number(invoice.paid_amount ?? invoice.amount);
    if (paid < order.amount) {
      console.warn(`[callback] order ${order.id}: paid ${paid} < expected ${order.amount}, not confirming`);
      return 'AMOUNT_MISMATCH';
    }
    const r = stmts.markPaid.run(invoice.payment_channel || invoice.payment_method || '', payload, order.id);
    if (r.changes) console.log(`[callback] order ${order.id}: PAID, +${order.votes} votes for ${order.performance_id}`);
    return 'PAID';
  }
  if (status === 'EXPIRED') {
    stmts.markExpired.run(payload, order.id);
    return 'EXPIRED';
  }
  return status || 'IGNORED';
}

// ---------- public API ----------

app.get('/api/config', (req, res) => {
  res.json({ votePrice: VOTE_PRICE, maxVotes: MAX_VOTES, showResults: SHOW_RESULTS, mock: xendit.isMock });
});

app.get('/api/performances', (req, res) => {
  const list = stmts.listPerformances.all().map((p) => ({ ...p, votes: SHOW_RESULTS ? p.votes : undefined }));
  res.json(list);
});

app.get('/api/performances/:id', (req, res) => {
  const p = stmts.getPerformance.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Performance not found' });
  res.json(p);
});

app.post('/api/orders', rateLimit(10, 60 * 1000), async (req, res) => {
  const { performanceId, votes, name, email } = req.body || {};

  const performance = stmts.getPerformance.get(String(performanceId || ''));
  if (!performance) return res.status(400).json({ error: 'Please choose a valid performance.' });

  const count = Number(votes);
  if (!Number.isInteger(count) || count < 1 || count > MAX_VOTES) {
    return res.status(400).json({ error: `Votes must be a whole number between 1 and ${MAX_VOTES}.` });
  }

  const voterName = String(name || '').trim().slice(0, 80);
  const voterEmail = String(email || '').trim().slice(0, 120);
  if (voterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(voterEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address, or leave it empty.' });
  }

  const amount = count * VOTE_PRICE;
  const orderId = `SL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  stmts.insertOrder.run(orderId, performance.id, count, amount, voterName, voterEmail);

  const statusUrl = `${BASE_URL}/status?order=${encodeURIComponent(orderId)}`;

  try {
    let invoiceId, invoiceUrl;
    if (xendit.isMock) {
      invoiceId = `mock-${orderId}`;
      invoiceUrl = `${BASE_URL}/mock-pay?order=${encodeURIComponent(orderId)}`;
    } else {
      const invoice = await xendit.createInvoice({
        externalId: orderId,
        amount,
        description: `Starlight vote: ${count} vote(s) for ${performance.name}`,
        items: [{ name: `Vote for ${performance.name}`, quantity: count, price: VOTE_PRICE }],
        customer: voterEmail || voterName
          ? { ...(voterName ? { given_names: voterName } : {}), ...(voterEmail ? { email: voterEmail } : {}) }
          : null,
        successUrl: statusUrl,
        failureUrl: statusUrl,
        duration: INVOICE_DURATION,
      });
      invoiceId = invoice.id;
      invoiceUrl = invoice.invoice_url;
    }
    stmts.attachInvoice.run(invoiceId, invoiceUrl, orderId);
    res.status(201).json({ orderId, invoiceUrl, amount, votes: count });
  } catch (err) {
    console.error('[orders] invoice creation failed:', err.message);
    stmts.deleteOrder.run(orderId);
    res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = stmts.getOrder.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrder(order));
});

// ---------- Xendit invoice callback ----------
// Configure in Xendit Dashboard > Settings > Webhooks > "Invoices paid": <BASE_URL>/api/xendit/callback

app.post('/api/xendit/callback', async (req, res) => {
  if (!xendit.verifyCallbackToken(req.get('x-callback-token'))) {
    console.warn('[callback] rejected: bad x-callback-token');
    return res.status(401).json({ error: 'Invalid callback token' });
  }

  const body = req.body || {};
  const order = body.external_id ? stmts.getOrder.get(String(body.external_id)) : null;
  if (!order) {
    // Acknowledge so Xendit doesn't retry forever (e.g. Dashboard "test callback").
    console.warn(`[callback] unknown external_id ${body.external_id}`);
    return res.json({ ok: true, ignored: true });
  }
  if (order.xendit_invoice_id && body.id && order.xendit_invoice_id !== body.id) {
    console.warn(`[callback] invoice id mismatch for ${order.id}`);
    return res.status(400).json({ error: 'Invoice mismatch' });
  }

  try {
    // Re-fetch the invoice from Xendit so the payload itself is never the source of truth.
    const invoice = await xendit.getInvoice(order.xendit_invoice_id || body.id);
    if (invoice.external_id !== order.id) return res.status(400).json({ error: 'Invoice mismatch' });
    const result = applyInvoiceState(order, invoice, body);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[callback] verification failed:', err.message);
    res.status(500).json({ error: 'Verification failed' }); // non-2xx makes Xendit retry
  }
});

// ---------- mock payments (only when XENDIT_SECRET_KEY is not set) ----------

if (xendit.isMock) {
  app.post('/api/mock/pay/:id', (req, res) => {
    const order = stmts.getOrder.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const status = req.body?.outcome === 'EXPIRED' ? 'EXPIRED' : 'PAID';
    const fake = { id: order.xendit_invoice_id, external_id: order.id, status, paid_amount: order.amount, payment_channel: 'MOCK' };
    res.json({ ok: true, result: applyInvoiceState(order, fake, fake) });
  });
}

// ---------- admin ----------

app.get('/api/admin/results', requireAdmin, (req, res) => {
  const rows = stmts.listPerformances.all();
  res.json(rows.map((p) => ({ ...p, revenue: p.votes * VOTE_PRICE })));
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(stmts.recentOrders.all(limit));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`Starlight voting running at ${BASE_URL} (port ${PORT})`);
  if (xendit.isMock) console.log('MOCK payment mode: XENDIT_SECRET_KEY not set, payments are simulated.');
  else if (!process.env.XENDIT_CALLBACK_TOKEN) console.warn('WARNING: XENDIT_CALLBACK_TOKEN not set, all callbacks will be rejected.');
});
