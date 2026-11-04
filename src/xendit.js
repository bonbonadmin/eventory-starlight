const crypto = require('node:crypto');

const API = 'https://api.xendit.co';
const secretKey = process.env.XENDIT_SECRET_KEY || '';
const callbackToken = process.env.XENDIT_CALLBACK_TOKEN || '';

const isMock = !secretKey;

function authHeader() {
  return 'Basic ' + Buffer.from(secretKey + ':').toString('base64');
}

async function request(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Xendit ${method} ${path} failed: ${res.status} ${data.error_code || ''} ${data.message || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// https://developers.xendit.co/api-reference/#create-invoice
function createInvoice({ externalId, amount, description, items, customer, successUrl, failureUrl, duration }) {
  return request('POST', '/v2/invoices', {
    external_id: externalId,
    amount,
    currency: 'IDR',
    description,
    invoice_duration: duration,
    success_redirect_url: successUrl,
    failure_redirect_url: failureUrl,
    items,
    ...(customer ? { customer } : {}),
  });
}

function getInvoice(invoiceId) {
  return request('GET', `/v2/invoices/${encodeURIComponent(invoiceId)}`);
}

function verifyCallbackToken(received) {
  if (!callbackToken || typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(callbackToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isMock, createInvoice, getInvoice, verifyCallbackToken };
