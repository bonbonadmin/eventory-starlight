const { timingSafeEqual } = require('node:crypto');

const apiKey = process.env.XENDIT_API_KEY || '';
const webhookToken = process.env.XENDIT_WEBHOOK_TOKEN || '';
const businessId = process.env.XENDIT_BUSINESS_ID || '';
const mode = process.env.XENDIT_MODE || 'disabled';
const channelCode = process.env.XENDIT_VA_CHANNEL || 'BNI_VIRTUAL_ACCOUNT';
const ttlSeconds = Number(process.env.XENDIT_VA_TTL_SECONDS || '3600');

const banks = {
  BCA_VIRTUAL_ACCOUNT: { name: 'BCA', min: 10_000, max: 50_000_000 },
  BNI_VIRTUAL_ACCOUNT: { name: 'BNI', min: 1, max: 50_000_000 },
  BRI_VIRTUAL_ACCOUNT: { name: 'BRI', min: 1, max: 50_000_000_000 },
  MANDIRI_VIRTUAL_ACCOUNT: { name: 'Mandiri', min: 1, max: 50_000_000_000 },
};
const bank = Object.hasOwn(banks, channelCode) ? banks[channelCode] : null;
const keyPrefix = mode === 'test' ? 'xnd_development_' : 'xnd_production_';
const configured = ['test', 'live'].includes(mode) && apiKey.startsWith(keyPrefix) &&
  apiKey.length > keyPrefix.length && Boolean(webhookToken && businessId && bank) &&
  Number.isInteger(ttlSeconds) && ttlSeconds >= 300 && ttlSeconds <= 86400;
const acceptsOrders = mode === 'mock' || (configured && process.env.XENDIT_ACCEPT_NEW_ORDERS === 'true');

class XenditError extends Error {
  constructor(status, code) {
    super(`Xendit API returned HTTP ${status}`);
    this.status = status;
    this.code = typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null;
    // Conflict, throttling and transport/server failures may leave an issued VA.
    this.rejected = [400, 401, 403, 404, 422].includes(status);
  }
}

async function request(method, path, body) {
  if (!configured) throw new Error('Xendit configuration incomplete');
  const response = await fetch(`https://api.xendit.co/v3${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'api-version': '2024-11-11',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new XenditError(response.status, data?.error_code);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Xendit response');
  return data;
}

function createPaymentRequest(attempt) {
  return request('POST', '/payment_requests', {
    reference_id: attempt.reference_id,
    type: 'PAY',
    country: 'ID',
    currency: attempt.currency,
    request_amount: attempt.amount,
    capture_method: 'AUTOMATIC',
    channel_code: attempt.channel_code,
    channel_properties: {
      display_name: 'Starlight',
      expires_at: new Date(attempt.expires_at).toISOString(),
    },
    description: `Starlight votes ${attempt.order_id}`,
  });
}

function getPaymentRequest(id) {
  return request('GET', `/payment_requests/${encodeURIComponent(id)}`);
}

function getPayment(id) {
  return request('GET', `/payments/${encodeURIComponent(id)}`);
}

function verifyCallbackToken(received) {
  if (!configured || typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  const expected = Buffer.from(webhookToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { mode, configured, acceptsOrders, banks, bank, businessId, channelCode, ttlSeconds,
  createPaymentRequest, getPaymentRequest, getPayment, verifyCallbackToken };
