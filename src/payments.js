const crypto = require('node:crypto');
const { db, stmts } = require('./db');
const xendit = require('./xendit');

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const NEVER = Number.MAX_SAFE_INTEGER;
const RECONCILE_DAYS = 7;
const supportedEvents = new Set(['payment.capture', 'payment.failure', 'payment_request.expiry']);

const sql = {
  byKey: db.prepare(`SELECT a.*, o.performance_id, o.votes FROM payment_attempts a
    JOIN orders o ON o.id = a.order_id WHERE a.checkout_hash = ?`),
  byOrder: db.prepare('SELECT * FROM payment_attempts WHERE order_id = ?'),
  byRequest: db.prepare('SELECT * FROM payment_attempts WHERE payment_request_id = ?'),
  byReference: db.prepare('SELECT * FROM payment_attempts WHERE reference_id = ?'),
  reserve: db.prepare(`INSERT INTO payment_attempts
    (order_id, checkout_hash, reference_id, business_id, environment, amount, currency, channel_code,
      expires_at, state, created_at, next_check_at)
    VALUES (?, ?, ?, ?, ?, ?, 'IDR', ?, ?, 'CREATING', ?, ?)`),
  updateState: db.prepare(`UPDATE payment_attempts SET state = ?, issue = ?, next_check_at = ?, check_failures = 0 WHERE order_id = ?`),
  bindRequest: db.prepare(`UPDATE payment_attempts SET payment_request_id = ?, provider_status = ?,
    va_number = COALESCE(?, va_number), qr_string = COALESCE(?, qr_string), expires_at = ? WHERE order_id = ?`),
  bindActions: db.prepare('UPDATE payment_attempts SET payment_actions = ? WHERE order_id = ?'),
  credit: db.prepare(`UPDATE orders SET status = 'PAID', paid_at = datetime('now'), payment_method = ?
    WHERE id = ? AND status IN ('PENDING', 'EXPIRED')`),
  expire: db.prepare("UPDATE orders SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'"),
  getPayment: db.prepare('SELECT * FROM xendit_payments WHERE payment_id = ?'),
  recordPayment: db.prepare(`INSERT INTO xendit_payments
    (payment_id, order_id, payment_request_id, amount, currency, captures, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  enqueue: db.prepare(`INSERT INTO xendit_inbox (event_key, environment, business_id, summary, received_at, next_check_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`),
  dueEvents: db.prepare(`SELECT * FROM xendit_inbox WHERE environment = ? AND business_id = ?
    AND state = 'PENDING' AND next_check_at <= ? ORDER BY next_check_at, received_at LIMIT 12`),
  finishEvent: db.prepare('UPDATE xendit_inbox SET state = ?, issue = ? WHERE event_key = ?'),
  retryEvent: db.prepare(`UPDATE xendit_inbox SET issue = ?, retries = retries + 1, next_check_at = ? WHERE event_key = ?`),
  pruneInbox: db.prepare(`DELETE FROM xendit_inbox WHERE state IN ('PROCESSED', 'IGNORED', 'UNMATCHED') AND received_at < ?`),
  dueAttempts: db.prepare(`SELECT * FROM payment_attempts WHERE environment = ? AND business_id = ?
    AND next_check_at <= ? ORDER BY next_check_at LIMIT 12`),
  retryAttempt: db.prepare(`UPDATE payment_attempts SET check_failures = check_failures + 1, next_check_at = ?
    WHERE order_id = ? AND state = ? AND next_check_at = ?`),
  failure: db.prepare("UPDATE payment_attempts SET issue = ? WHERE order_id = ? AND state IN ('CREATING', 'CREATE_UNKNOWN', 'AWAITING_PAYMENT')"),
  reviewAttempts: db.prepare(`SELECT order_id, reference_id, payment_request_id, environment, channel_code, amount, state, issue, check_failures, expires_at
    FROM payment_attempts WHERE state IN ('CREATE_UNKNOWN', 'REVIEW', 'FAILED') OR issue IS NOT NULL OR check_failures >= 4
    ORDER BY created_at DESC LIMIT 100`),
  reviewPayments: db.prepare(`SELECT payment_id, order_id, payment_request_id, amount, currency, captures, outcome
    FROM xendit_payments WHERE outcome <> 'CREDITED' ORDER BY received_at DESC LIMIT 100`),
  reviewEvents: db.prepare(`SELECT event_key, summary, state, retries, issue FROM xendit_inbox
    WHERE state IN ('UNMATCHED', 'REVIEW') OR retries > 0 AND state = 'PENDING' ORDER BY received_at DESC LIMIT 100`),
};

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function checkoutHash(key) {
  return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? digest(key) : null;
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function findCheckout(hash) {
  return sql.byKey.get(hash);
}

function attemptForOrder(id, key) {
  const attempt = sql.byOrder.get(id);
  if (!attempt) return undefined;
  const hash = checkoutHash(key);
  return hash && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(attempt.checkout_hash)) ? attempt : null;
}

function reserveOrder({ id, hash, performanceId, votes, amount, voterName, voterEmail, channelCode = xendit.defaultChannel }) {
  return transaction(() => {
    const existing = sql.byKey.get(hash);
    if (existing) return { existing };
    const now = Date.now();
    stmts.insertOrder.run(id, performanceId, votes, amount, voterName, voterEmail);
    sql.reserve.run(id, hash, `starlight-${xendit.mode}-${id}`, xendit.businessId, xendit.mode, amount,
      channelCode, now + (xendit.channels[channelCode].ttl || xendit.ttlSeconds) * 1000, now, now + MINUTE);
    return { attempt: sql.byOrder.get(id) };
  });
}

function providerId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && /^[a-z0-9-]{4,80}$/i.test(value) ? value : null;
}

function label(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
}

// Only provider-returned customer navigation actions may leave this API.
function paymentActions(actions, channelCode) {
  if (!Array.isArray(actions)) return [];
  const appProtocols = { SHOPEEPAY: ['shopeeid:', 'shopee:'], DANA: ['dana:'], OVO: ['ovo:'] };
  return actions.filter(a => {
    if (a?.type !== 'REDIRECT_CUSTOMER' || !['WEB_URL', 'DEEPLINK_URL'].includes(a.descriptor) ||
        typeof a.value !== 'string' || a.value.length > 8192 || /[\u0000-\u0020\u007f]/.test(a.value)) return false;
    try {
      const url = new URL(a.value);
      return !url.username && !url.password && (url.protocol === 'https:' ||
        a.descriptor === 'DEEPLINK_URL' && (appProtocols[channelCode] || []).includes(url.protocol));
    } catch { return false; }
  }).slice(0, 6).map(a => ({ type: a.type, descriptor: a.descriptor, value: a.value }));
}

function identityMatches(attempt, data) {
  return data.business_id === attempt.business_id && data.reference_id === attempt.reference_id &&
    data.currency === attempt.currency && data.channel_code === attempt.channel_code &&
    data.type === 'PAY' && data.country === 'ID' && data.request_amount === attempt.amount;
}

function isLocal(attempt) {
  return attempt && attempt.environment === xendit.mode && attempt.business_id === xendit.businessId;
}

function flag(attempt, issue, nextCheck = NEVER) {
  console.warn(`[payments] ${attempt.order_id}: ${issue}`);
  if (attempt.state !== 'PAID') sql.updateState.run('REVIEW', issue, nextCheck, attempt.order_id);
}

// Used by creation and reconciliation. Provider request status never credits votes.
function recordRequest(orderId, data, expectedId = null) {
  return transaction(() => {
    const attempt = sql.byOrder.get(orderId);
    const requestId = providerId(data.payment_request_id, 'pr-');
    if (!requestId || (expectedId && expectedId !== requestId) || !identityMatches(attempt, data) ||
      (attempt.payment_request_id && attempt.payment_request_id !== requestId)) {
      flag(attempt, 'REQUEST_MISMATCH');
      return false;
    }
    const bound = sql.byRequest.get(requestId);
    if (bound && bound.order_id !== orderId) {
      flag(attempt, 'REQUEST_ALREADY_BOUND');
      return false;
    }
    if (attempt.state === 'PAID') return true;
    const status = label(data.status);
    const action = Array.isArray(data.actions) && data.actions.find(a =>
      a?.type === 'PRESENT_TO_CUSTOMER' && a.descriptor === 'VIRTUAL_ACCOUNT_NUMBER');
    const number = typeof action?.value === 'string' && /^\d{4,40}$/.test(action.value) ? action.value : null;
    const qrAction = Array.isArray(data.actions) && data.actions.find(a =>
      a?.type === 'PRESENT_TO_CUSTOMER' && a.descriptor === 'QR_STRING');
    const qr = attempt.channel_code === 'QRIS' && typeof qrAction?.value === 'string' &&
      qrAction.value.startsWith('000201') && qrAction.value.length <= 2000 ? qrAction.value : null;
    const actions = Array.isArray(data.actions) ? paymentActions(data.actions, attempt.channel_code)
      : JSON.parse(attempt.payment_actions || '[]');
    if (Array.isArray(data.actions)) sql.bindActions.run(JSON.stringify(actions), orderId);
    const expiry = Date.parse(data.channel_properties?.expires_at);
    sql.bindRequest.run(requestId, status, number, qr, Number.isFinite(expiry) ? expiry : attempt.expires_at, orderId);
    if (['REVIEW', 'FAILED'].includes(attempt.state)) return true;
    const now = Date.now();
    const expiresAt = Number.isFinite(expiry) ? expiry : attempt.expires_at;
    if (['CANCELED', 'CANCELLED', 'FAILED'].includes(status)) {
      sql.updateState.run('FAILED', status, NEVER, orderId);
    } else if (status === 'EXPIRED' || attempt.state === 'EXPIRED') {
      sql.expire.run(orderId);
      const nextCheck = now < expiresAt + RECONCILE_DAYS * DAY ? now + 30 * MINUTE : NEVER;
      sql.updateState.run('EXPIRED', null, nextCheck, orderId);
    } else {
      const hasInstructions = xendit.channels[attempt.channel_code]?.wallet
        ? actions.length > 0 || attempt.channel_code === 'OVO' && ['PENDING', 'REQUIRES_ACTION'].includes(status)
        : attempt.channel_code === 'QRIS' ? qr || attempt.qr_string : number || attempt.va_number;
      const issue = !hasInstructions && status !== 'SUCCEEDED' ? 'PAYMENT_INSTRUCTIONS_MISSING' : null;
      if (issue && attempt.issue !== issue) console.warn(`[payments] ${orderId}: ${issue}`);
      const nextCheck = now < expiresAt + RECONCILE_DAYS * DAY ? now + MINUTE : NEVER;
      if (nextCheck === NEVER) flag(attempt, 'REQUEST_UNRESOLVED');
      else sql.updateState.run('AWAITING_PAYMENT', issue, nextCheck, orderId);
    }
    return true;
  });
}

async function create(attempt, options) {
  try {
    const request = await xendit.createPaymentRequest(attempt, options);
    recordRequest(attempt.order_id, request);
  } catch (error) {
    const current = sql.byOrder.get(attempt.order_id);
    if (current.payment_request_id || current.state !== 'CREATING') return;
    const rejected = error.rejected === true;
    const issue = rejected ? error.code || `HTTP_${error.status}` : 'CREATE_UNKNOWN';
    console.warn(`[payments] ${attempt.order_id}: ${issue}`);
    sql.updateState.run(rejected ? 'FAILED' : 'CREATE_UNKNOWN', issue, NEVER, attempt.order_id);
  }
}

function acceptWebhook(body) {
  if (!body || typeof body !== 'object' || !label(body.event) || !body.data ||
      typeof body.data !== 'object' || Array.isArray(body.data)) return 400;
  if (!label(body.business_id)) return 400;
  if (body.data.business_id != null && body.data.business_id !== body.business_id) return 403;
  // Dashboard Test & Save uses a sample business ID. Authentication happens in
  // the route; acknowledge other businesses without persisting or processing them.
  if (body.business_id !== xendit.businessId) return 200;
  const data = body.data;
  const summary = JSON.stringify({
    event: body.event, requestId: providerId(data.payment_request_id, 'pr-'),
    paymentId: providerId(data.payment_id, 'py-'), reference: label(data.reference_id),
    status: label(data.status), failure: label(data.failure_code),
    currency: label(data.currency), channel: label(data.channel_code),
    requestAmount: Number.isSafeInteger(data.request_amount) ? data.request_amount : null,
  });
  const now = Date.now();
  sql.enqueue.run(digest(`${xendit.mode}\n${body.business_id}\n${summary}`), xendit.mode, body.business_id, summary, now, now);
  return 202;
}

function capturedAmount(payment) {
  const captures = new Map();
  let valid = Array.isArray(payment.captures) && payment.captures.length > 0;
  if (valid) for (const capture of payment.captures) {
    const id = providerId(capture?.capture_id, 'cap-') || providerId(capture?.capture_id, 'cptr-');
    const amount = capture?.capture_amount;
    if (!id || !Number.isFinite(amount) || amount <= 0 || (captures.has(id) && captures.get(id) !== amount)) {
      valid = false;
      break;
    }
    captures.set(id, amount);
  }
  const sum = [...captures.values()].reduce((total, amount) => total + amount, 0);
  return { amount: valid && Number.isFinite(sum) ? sum : null, captures: [...captures].map(([id, amount]) => ({ id, amount })) };
}

function recordCapture(orderId, payment, expectedPaymentId, expectedRequestId) {
  return transaction(() => {
    const attempt = sql.byOrder.get(orderId);
    if (payment.payment_id !== expectedPaymentId) throw new Error('Payment ID mismatch');
    if (payment.status !== 'SUCCEEDED') return null;
    const previouslyRecorded = sql.getPayment.get(expectedPaymentId);
    if (previouslyRecorded) {
      if (previouslyRecorded.order_id === orderId) return previouslyRecorded.outcome;
      flag(attempt, 'PAYMENT_ALREADY_BOUND');
      return 'PAYMENT_ALREADY_BOUND';
    }
    const requestId = providerId(payment.payment_request_id, 'pr-');
    const bound = requestId && sql.byRequest.get(requestId);
    const { amount, captures } = capturedAmount(payment);
    if (amount === null) throw new Error('Confirmed capture amount unavailable');
    const order = stmts.getOrder.get(orderId);
    let outcome = 'CREDITED';
    if (requestId !== expectedRequestId || !identityMatches(attempt, payment) ||
      (attempt.payment_request_id && attempt.payment_request_id !== requestId) || (bound && bound.order_id !== orderId)) {
      outcome = 'PAYMENT_MISMATCH';
    } else if (!Number.isSafeInteger(amount) || captures.some(c => !Number.isSafeInteger(c.amount)) || amount !== attempt.amount) {
      outcome = 'AMOUNT_MISMATCH';
    } else if (order.status === 'PAID') {
      outcome = 'EXTRA_PAYMENT';
    } else if (['FAILED', 'REVIEW'].includes(attempt.state)) {
      outcome = 'ORDER_REVIEW';
    }
    sql.recordPayment.run(expectedPaymentId, orderId, requestId || expectedRequestId, amount, label(payment.currency),
      JSON.stringify(captures), outcome, Date.now());
    if (outcome !== 'CREDITED') {
      flag(attempt, outcome);
      return outcome;
    }
    // Verified late captures can credit the original expired order, once.
    sql.bindRequest.run(requestId, payment.status, null, null, attempt.expires_at, orderId);
    if (sql.credit.run(attempt.channel_code, orderId).changes !== 1) throw new Error('Order was not creditable');
    sql.updateState.run('PAID', null, NEVER, orderId);
    return outcome;
  });
}

async function reconcile(attempt, requestId = attempt.payment_request_id) {
  const request = await xendit.getPaymentRequest(requestId);
  const latestId = providerId(request.latest_payment_id, 'py-');
  const payment = latestId ? await xendit.getPayment(latestId) : null;
  if ((payment?.status === 'SUCCEEDED' && capturedAmount(payment).amount === null) ||
      (request.status === 'SUCCEEDED' && payment?.status !== 'SUCCEEDED')) {
    throw new Error('Successful request awaiting capture details');
  }
  if (!recordRequest(attempt.order_id, request, requestId)) return 'REQUEST_MISMATCH';
  return payment ? recordCapture(attempt.order_id, payment, latestId, requestId) : null;
}

async function processEvent(row) {
  const event = JSON.parse(row.summary);
  if (!supportedEvents.has(event.event)) return sql.finishEvent.run('IGNORED', null, row.event_key);
  const byRequest = event.requestId && sql.byRequest.get(event.requestId);
  const byReference = event.reference && sql.byReference.get(event.reference);
  const attempt = byRequest || byReference;
  if (!isLocal(attempt)) return sql.finishEvent.run('UNMATCHED', 'UNKNOWN_REQUEST', row.event_key);
  try {
    if (!event.requestId || (event.reference && event.reference !== attempt.reference_id) ||
      (attempt.payment_request_id && attempt.payment_request_id !== event.requestId)) {
      return sql.finishEvent.run('REVIEW', 'EVENT_IDENTITY_MISMATCH', row.event_key);
    }
    let outcome;
    if (event.event === 'payment.capture') {
      if (event.status !== 'SUCCEEDED' || !event.paymentId) {
        return sql.finishEvent.run('REVIEW', 'INVALID_CAPTURE_EVENT', row.event_key);
      }
      if (event.reference !== attempt.reference_id || event.currency !== attempt.currency ||
          event.channel !== attempt.channel_code || event.requestAmount !== attempt.amount) {
        return sql.finishEvent.run('REVIEW', 'CAPTURE_EVENT_MISMATCH', row.event_key);
      }
      const payment = await xendit.getPayment(event.paymentId);
      outcome = recordCapture(attempt.order_id, payment, event.paymentId, event.requestId);
      if (!outcome) throw new Error('Capture not yet confirmed by Xendit');
    } else if (event.event === 'payment_request.expiry' || !attempt.payment_request_id) {
      outcome = await reconcile(attempt, event.requestId);
    } else {
      sql.failure.run(event.failure || 'PAYMENT_FAILURE', attempt.order_id);
      // A wallet rejection can make the request terminal. Ask the provider rather
      // than leaving a failed push or redirect visible until its original expiry.
      outcome = await reconcile(attempt, event.requestId);
    }
    const needsReview = outcome && outcome !== 'CREDITED';
    sql.finishEvent.run(needsReview ? 'REVIEW' : 'PROCESSED', needsReview ? outcome : null, row.event_key);
  } catch {
    if (row.retries >= 9) {
      console.warn(`[payments] ${attempt.order_id}: webhook retries exhausted (${row.event_key})`);
      sql.finishEvent.run('REVIEW', 'RETRIES_EXHAUSTED', row.event_key);
    } else {
      const backoff = Math.min(15 * MINUTE, 5000 * 2 ** row.retries);
      sql.retryEvent.run('RETRY_PENDING', Date.now() + backoff, row.event_key);
    }
  }
}

async function checkAttempt(attempt) {
  if (attempt.state === 'CREATING' && !attempt.payment_request_id) {
    console.warn(`[payments] ${attempt.order_id}: unfinished create after restart`);
    sql.updateState.run('CREATE_UNKNOWN', 'CREATE_UNKNOWN', NEVER, attempt.order_id);
    return;
  }
  try {
    await reconcile(attempt);
  } catch {
    const current = sql.byOrder.get(attempt.order_id);
    if (['PAID', 'REVIEW'].includes(current.state)) return;
    const failures = attempt.check_failures + 1;
    if (failures === 4) console.warn(`[payments] ${attempt.order_id}: reconciliation repeatedly failing`);
    if (Date.now() > current.expires_at + RECONCILE_DAYS * DAY) {
      flag(current, 'RECONCILIATION_UNRESOLVED');
      return;
    }
    const nextCheck = Date.now() + Math.min(15 * MINUTE, 30_000 * 2 ** Math.min(failures, 5));
    // Don't overwrite a concurrent webhook's successful state update.
    sql.retryAttempt.run(nextCheck, attempt.order_id, attempt.state, attempt.next_check_at);
  }
}

function startWorker() {
  if (!xendit.configured) return;
  let running = false;
  let nextPrune = 0;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const events = sql.dueEvents.all(xendit.mode, xendit.businessId, now);
      await Promise.allSettled(events.map(processEvent));
      const checks = sql.dueAttempts.all(xendit.mode, xendit.businessId, now);
      await Promise.allSettled(checks.map(checkAttempt));
      if (now >= nextPrune) {
        sql.pruneInbox.run(now - 90 * DAY);
        nextPrune = now + DAY;
      }
    } catch {
      console.error('[payments] Worker could not access the payment queue');
    } finally {
      running = false;
    }
  }
  setInterval(tick, 5000).unref();
  void tick();
}

function review() {
  return { attempts: sql.reviewAttempts.all(), payments: sql.reviewPayments.all(), events: sql.reviewEvents.all() };
}

module.exports = { checkoutHash, findCheckout, attemptForOrder, reserveOrder, create, acceptWebhook, startWorker, review };
