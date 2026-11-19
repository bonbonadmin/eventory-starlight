// Fake only Xendit's HTTP API. The application and its SQLite queue run normally.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const originalFetch = global.fetch;
const requests = new Map();
global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.xendit.co/v3/')) return originalFetch(url, options);
  const path = new URL(url).pathname;
  if (options.method === 'POST' && path === '/v3/payment_requests') {
    const body = JSON.parse(options.body);
    assert.ok(['QRIS', 'SHOPEEPAY', 'OVO', 'DANA'].includes(body.channel_code));
    assert.equal(body.type, 'PAY');
    assert.equal(body.country, 'ID');
    assert.equal(body.currency, 'IDR');
    assert.equal(body.channel_properties.display_name, undefined);
    const wallet = body.channel_code !== 'QRIS';
    if (wallet) {
      assert.equal(body.channel_properties.expires_at, undefined);
      if (body.channel_code === 'OVO') {
        assert.deepEqual(Object.keys(body.channel_properties), ['account_mobile_number']);
        assert.match(body.channel_properties.account_mobile_number, /^\+628\d{7,12}$/);
      } else {
        assert.deepEqual(Object.keys(body.channel_properties), ['success_return_url']);
        const returned = new URL(body.channel_properties.success_return_url);
        assert.equal(returned.origin, new URL(process.env.BASE_URL).origin);
        assert.equal(returned.pathname, '/status');
        assert.ok(body.reference_id.endsWith(returned.searchParams.get('order')));
        assert.equal(returned.hash, '');
      }
    }
    let actions = wallet ? body.channel_code === 'OVO' ? [] : [
      {type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://checkout.xendit.co/pay/fixture'},
      {type: 'REDIRECT_CUSTOMER', descriptor: 'DEEPLINK_URL', value: 'https://link.dana.id/fixture'},
    ] : [{type: 'PRESENT_TO_CUSTOMER', descriptor: 'QR_STRING',
      value: '0002010102125303360540450005802ID5910STARLIGHT6007JAKARTA6304ABCD'}];
    if (wallet && body.request_amount === 10000) actions = [
      {type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'javascript:alert(1)'},
      {type: 'REDIRECT_CUSTOMER', descriptor: 'DEEPLINK_URL', value: 'data:text/html,malicious'},
      {type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://user:pass@checkout.xendit.co/pay'},
    ];
    const request = { ...body, business_id: process.env.XENDIT_BUSINESS_ID,
      payment_request_id: `pr-${randomUUID()}`, status: body.channel_code === 'OVO' ? 'PENDING' : 'REQUIRES_ACTION',
      actions };
    requests.set(request.payment_request_id, request);
    process.send({ type: 'created', request });
    return Response.json(request);
  }
  if (path.startsWith('/v3/payment_requests/')) {
    const request = requests.get(path.split('/').pop());
    return Response.json(request || {}, {status: request ? 200 : 404});
  }
  if (path.startsWith('/v3/payments/')) {
    const paymentId = path.split('/').pop();
    const request = [...requests.values()].find(r => paymentId.endsWith(r.payment_request_id.slice(3)));
    assert.ok(request);
    return Response.json({ ...request, status: 'SUCCEEDED', payment_id: paymentId,
      captures: [{ capture_id: `cap-${randomUUID()}`,
        capture_amount: request.request_amount - (paymentId.startsWith('py-short-') ? 1 : 0) }] });
  }
  throw new Error(`Unexpected Xendit endpoint ${path}`);
};
