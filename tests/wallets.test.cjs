const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

test('wallet checkout validates method and phone, protects handoffs and credits verified captures once', {timeout: 25000}, async t => {
  const root = path.resolve(__dirname, '..');
  const dir = mkdtempSync(path.join(tmpdir(), 'starlight-wallet-test-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = fork(path.join(root, 'src/server.js'), [], {
    cwd: root, silent: true, execArgv: ['--require', path.join(__dirname, 'fixtures/xendit.cjs')],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_URL: base,
      DB_PATH: path.join(dir, 'live.db'), XENDIT_TEST_DB_PATH: path.join(dir, 'test.db'),
      XENDIT_MODE: 'test', XENDIT_CHANNEL_CODE: 'SHOPEEPAY', XENDIT_CHANNEL_CODES: 'SHOPEEPAY,OVO,DANA',
      XENDIT_PAYMENT_TTL_SECONDS: '3600', XENDIT_ACCEPT_NEW_ORDERS: 'true',
      XENDIT_API_KEY: 'xnd_development_fixture', XENDIT_WEBHOOK_TOKEN: 'fixture-token',
      XENDIT_BUSINESS_ID: 'fixture-business', ADMIN_KEY: 'fixture-admin' },
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
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.paymentsOpen, true);
  assert.equal(config.channelCode, 'SHOPEEPAY');
  assert.deepEqual(config.paymentMethods.map(m => m.code), ['SHOPEEPAY', 'OVO', 'DANA']);
  assert.equal(config.paymentMethods.find(m => m.code === 'OVO').requiresPhone, true);
  assert.ok(config.paymentMethods.every(m => m.kind === 'wallet' && m.minVotes === 1 && m.maxVotes === 1000));
  const performers = await (await fetch(`${base}/api/performances`)).json();
  const key = () => randomBytes(32).toString('hex');
  const headers = access => ({'content-type': 'application/json', 'x-order-access': access});
  const create = (body, access = key()) => fetch(`${base}/api/orders`, {
    method: 'POST', headers: headers(access), body: JSON.stringify({performanceId: performers[0].id, votes: 1, ...body}),
  });
  assert.equal((await create({channelCode: 'LINKAJA'})).status, 400);
  assert.equal((await create({channelCode: 'QRIS'})).status, 400);
  assert.equal((await create({channelCode: 'OVO', phoneNumber: 'not-a-phone'})).status, 400);
  assert.equal((await create({channelCode: 'OVO'})).status, 400);
  assert.equal(created.length, 0, 'invalid checkout must never contact Xendit');
  const placed = [];
  for (const channelCode of ['SHOPEEPAY', 'OVO', 'DANA']) {
    const access = key();
    const res = await create({channelCode, ...(channelCode === 'OVO' ? {phoneNumber: '081234567890'} : {})}, access);
    assert.equal(res.status, 201, output);
    const order = await res.json();
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'checkout sets a receipt cookie for wallet returns in another tab');
    assert.match(setCookie, /; HttpOnly(?:;|$)/i);
    assert.match(setCookie, /; SameSite=Lax(?:;|$)/i);
    assert.ok(setCookie.includes(`; Path=/api/orders/${order.orderId};`));
    assert.match(setCookie, /; Max-Age=691200(?:;|$)/i);
    const cookie = setCookie.split(';')[0];
    const request = created.find(r => r.reference_id.endsWith(order.orderId));
    assert.ok(request, output);
    assert.equal(request.channel_code, channelCode);
    if (channelCode === 'OVO') assert.equal(request.channel_properties.account_mobile_number, '+6281234567890');
    placed.push({...order, access, request, channelCode, cookie});
  }
  // App returns may open another tab without the receipt fragment or sessionStorage.
  const cookieOrder = placed[0];
  const receiptUrl = `${base}/api/orders/${cookieOrder.orderId}`;
  const returned = await fetch(receiptUrl, {headers: {cookie: cookieOrder.cookie}});
  assert.equal(returned.status, 200);
  assert.equal((await returned.json()).id, cookieOrder.orderId);
  assert.equal((await fetch(receiptUrl, {headers: {cookie: placed[1].cookie}})).status, 404,
    'another order cookie cannot authorize this receipt');
  assert.equal((await fetch(receiptUrl, {headers: {cookie: cookieOrder.cookie.split('=')[0] + '=' + key()}})).status, 404,
    'a forged cookie cannot authorize this receipt');
  assert.equal((await fetch(receiptUrl, {headers: {...headers(key()), cookie: cookieOrder.cookie}})).status, 404,
    'an explicit incorrect header must not fall back to a valid cookie');
  const get = async o => {
    const res = await fetch(`${base}/api/orders/${o.orderId}`, {headers: headers(o.access)});
    assert.equal(res.status, 200);
    return res.json();
  };
  for (const o of placed) {
    const pending = await get(o);
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.channelCode, o.channelCode);
    assert.equal(pending.walletPayment, true);
    assert.equal(pending.paymentKind, 'wallet');
    assert.equal(pending.qrCodeImage, null);
    assert.equal(pending.virtualAccount, null);
    assert.equal(pending.paymentActions.length, o.channelCode === 'OVO' ? 0 : 2);
    assert.equal((await fetch(`${base}/api/orders/${o.orderId}`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/${o.orderId}`, {headers: headers(key())})).status, 404);
    const expiry = new Date(pending.expiresAt).getTime();
    const ttl = o.channelCode === 'OVO' ? 900000 : o.channelCode === 'SHOPEEPAY' ? 1800000 : 86400000;
    assert.ok(expiry > Date.now() + ttl - 30000 && expiry <= Date.now() + ttl, `provider expiry for ${o.channelCode}`);
  }
  // Returning from a wallet is navigation, never evidence that money was received.
  await fetch(`${base}/status?order=${placed[0].orderId}&status=SUCCEEDED`);
  assert.equal((await get(placed[0])).status, 'PENDING');
  const reused = await create({channelCode: 'DANA'}, placed[0].access);
  assert.equal(reused.status, 409, 'changing method must not silently reuse another method');
  assert.equal(created.length, 3);
  const unsafeAccess = key();
  const unsafeRes = await create({channelCode: 'DANA', votes: 2}, unsafeAccess);
  assert.equal(unsafeRes.status, 201);
  const unsafe = {...await unsafeRes.json(), access: unsafeAccess};
  assert.deepEqual((await get(unsafe)).paymentActions, [], 'unsafe provider URL schemes and credentials must be omitted');
  const webhook = body => fetch(`${base}/api/xendit/v3/test`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-callback-token': 'fixture-token'}, body: JSON.stringify(body),
  });
  for (const o of placed) {
    const body = {event: 'payment.capture', business_id: 'fixture-business', data: {
      ...o.request, status: 'SUCCEEDED', payment_id: `py-${o.request.payment_request_id.slice(3)}`,
    }};
    assert.equal((await webhook(body)).status, 202);
    assert.equal((await webhook(body)).status, 202);
  }
  for (let i = 0; i < 40; i++) {
    if ((await Promise.all(placed.map(get))).every(o => o.status === 'PAID')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const o of placed) {
    const paid = await get(o);
    assert.equal(paid.status, 'PAID', output);
    assert.deepEqual(paid.paymentActions, []);
  }
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM xendit_payments WHERE outcome = 'CREDITED'").get().n, 3);
    assert.equal(db.prepare('SELECT SUM(votes) AS votes FROM orders WHERE status = ?').get('PAID').votes, 3);
    assert.deepEqual(db.prepare("SELECT DISTINCT payment_method FROM orders WHERE status = 'PAID' ORDER BY payment_method").all()
      .map(r => r.payment_method), ['DANA', 'OVO', 'SHOPEEPAY']);
    const order = placed[0];
    const payment = db.prepare("SELECT payment_id FROM xendit_payments WHERE order_id = ? AND outcome = 'CREDITED'").get(order.orderId);
    db.prepare(`INSERT INTO vote_exclusions (order_id, payment_id, excluded_votes, reason, recorded_by)
      VALUES (?, ?, 1, 'Owner requested separate vote audit', 'Owner')`).run(order.orderId, payment.payment_id);
    const votesNow = async () => (await (await fetch(`${base}/api/performances`)).json()).find(p => p.id === performers[0].id).votes;
    assert.equal(await votesNow(), 2, 'audited exclusion removes one vote from the public totals');
    const results = await (await fetch(`${base}/api/admin/results`, {headers: {'x-admin-key': 'fixture-admin'}})).json();
    const result = results.find(p => p.id === performers[0].id);
    assert.equal(result.votes, 2);
    assert.equal(result.revenue, 15000, 'excluding votes must retain captured revenue');
    assert.equal((await get(order)).status, 'PAID', 'the payment receipt remains paid');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM xendit_payments WHERE outcome = 'CREDITED'").get().n, 3);
    assert.throws(() => db.prepare(`INSERT INTO vote_exclusions (order_id, excluded_votes, reason, recorded_by)
      VALUES (?, 1, 'Duplicate exclusion', 'Owner')`).run(order.orderId), /UNIQUE/);
    // Replaying a capture after the adjustment cannot restore the excluded vote.
    assert.equal((await webhook({event: 'payment.capture', business_id: 'fixture-business', data: {
      ...order.request, status: 'SUCCEEDED', payment_id: payment.payment_id,
    }})).status, 202);
    assert.equal(await votesNow(), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vote_exclusions').get().n, 1);
  } finally { db.close(); }
});
