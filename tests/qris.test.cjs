const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

test('QRIS checkout, private QR images, verified capture, duplicate delivery and amount mismatch', {timeout: 25000}, async t => {
  const root = path.resolve(__dirname, '..');
  const dir = mkdtempSync(path.join(tmpdir(), 'starlight-qris-test-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = fork(path.join(root, 'src/server.js'), [], {
    cwd: root, silent: true, execArgv: ['--require', path.join(__dirname, 'fixtures/xendit.cjs')],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_URL: `http://127.0.0.1:${port}`,
      DB_PATH: path.join(dir, 'live.db'), XENDIT_TEST_DB_PATH: path.join(dir, 'test.db'),
      XENDIT_MODE: 'test', XENDIT_CHANNEL_CODE: 'QRIS', XENDIT_CHANNEL_CODES: 'QRIS', XENDIT_PAYMENT_TTL_SECONDS: '3600',
      XENDIT_ACCEPT_NEW_ORDERS: 'true', XENDIT_API_KEY: 'xnd_development_fixture',
      XENDIT_WEBHOOK_TOKEN: 'fixture-token', XENDIT_BUSINESS_ID: 'fixture-business' },
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const created = [];
  child.on('message', message => { if (message.type === 'created') created.push(message.request); });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve));
    rmSync(dir, {recursive: true, force: true});
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (String(data).includes('Starlight voting running')) resolve(); });
    child.once('exit', () => reject(new Error(output)));
  });
  const base = `http://127.0.0.1:${port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.channelCode, 'QRIS');
  assert.equal(config.bank, null);
  assert.equal(config.paymentsOpen, true);
  const performers = await (await fetch(`${base}/api/performances`)).json();
  const headers = key => ({'content-type': 'application/json', 'x-order-access': key});
  const placeOrder = async () => {
    const key = randomBytes(32).toString('hex');
    const res = await fetch(`${base}/api/orders`, {method: 'POST', headers: headers(key),
      body: JSON.stringify({performanceId: performers[0].id, votes: 1})});
    assert.equal(res.status, 201, output);
    const order = await res.json();
    return { ...order, key, request: created.find(r => r.reference_id.endsWith(order.orderId)) };
  };
  const getOrder = async o => (await fetch(`${base}/api/orders/${o.orderId}`, {headers: headers(o.key)})).json();
  const good = await placeOrder();
  assert.ok(good.request);
  const pending = await getOrder(good);
  assert.equal(pending.channelCode, 'QRIS');
  assert.equal(pending.virtualAccount, null);
  assert.match(pending.qrCodeImage, /^data:image\/png;base64,iVBOR/);
  assert.equal(pending.status, 'PENDING');
  assert.equal((await fetch(`${base}/api/orders/${good.orderId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/orders/${good.orderId}`, {headers: headers(randomBytes(32).toString('hex'))})).status, 404);
  const webhook = (body, token = 'fixture-token') => fetch(`${base}/api/xendit/v3/test`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-callback-token': token}, body: JSON.stringify(body),
  });
  const sample = {event: 'payment.capture', business_id: 'sample-business', data: {business_id: 'sample-business'}};
  assert.equal((await webhook(sample, 'wrong')).status, 401);
  assert.equal((await webhook(sample)).status, 200);
  assert.equal((await webhook({...sample, business_id: 'fixture-business'})).status, 403);
  const capture = (o, prefix = 'py-') => ({event: 'payment.capture', business_id: 'fixture-business',
    data: {...o.request, payment_id: prefix + o.request.payment_request_id.slice(3), status: 'SUCCEEDED'}});
  const short = await placeOrder();
  assert.equal((await webhook(capture(short, 'py-short-'))).status, 202);
  assert.equal((await webhook(capture(good))).status, 202);
  assert.equal((await webhook(capture(good))).status, 202);
  let paid;
  for (let i = 0; i < 40; i++) {
    paid = await getOrder(good);
    const bad = await getOrder(short);
    if (paid.status === 'PAID' && bad.paymentState === 'REVIEW') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(paid.status, 'PAID', output);
  assert.equal(paid.qrCodeImage, null);
  assert.equal((await getOrder(short)).status, 'PENDING');
  assert.equal((await getOrder(short)).paymentState, 'REVIEW');
  const db = new DatabaseSync(path.join(dir, 'test.db'), {readOnly: true});
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM xendit_payments WHERE outcome = 'CREDITED'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM xendit_inbox WHERE business_id = 'sample-business'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM xendit_inbox').get().n, 2);
  } finally { db.close(); }
});
