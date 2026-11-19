const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const liveDbPath = path.resolve(process.env.DB_PATH || './data/starlight.db');
const dbPath = process.env.XENDIT_MODE === 'test'
  ? path.resolve(process.env.XENDIT_TEST_DB_PATH || `${liveDbPath}.test.db`)
  : liveDbPath;
if (process.env.XENDIT_MODE === 'test' && dbPath === liveDbPath) {
  throw new Error('Xendit Test Mode requires a separate database');
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS performances (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    subtitle    TEXT NOT NULL DEFAULT '',
    image       TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
  );

  -- One row per checkout. Only confirmed paid orders count toward votes.
  CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,          -- also used as Xendit external_id
    performance_id     TEXT NOT NULL REFERENCES performances(id),
    votes              INTEGER NOT NULL CHECK (votes > 0),
    amount             INTEGER NOT NULL CHECK (amount > 0),
    voter_name         TEXT NOT NULL DEFAULT '',
    voter_email        TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | EXPIRED
    xendit_invoice_id  TEXT,
    invoice_url        TEXT,
    payment_method     TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at            TEXT,
    callback_payload   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_perf_status ON orders(performance_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice ON orders(xendit_invoice_id);

  CREATE TABLE IF NOT EXISTS payment_attempts (
    order_id TEXT PRIMARY KEY REFERENCES orders(id),
    checkout_hash TEXT NOT NULL UNIQUE,
    reference_id TEXT NOT NULL UNIQUE,
    payment_request_id TEXT UNIQUE,
    business_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    channel_code TEXT NOT NULL,
    va_number TEXT,
    qr_string TEXT,
    expires_at INTEGER NOT NULL,
    provider_status TEXT,
    state TEXT NOT NULL,
    issue TEXT,
    created_at INTEGER NOT NULL,
    next_check_at INTEGER NOT NULL,
    check_failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_attempt_checks ON payment_attempts(environment, business_id, next_check_at);

  CREATE TABLE IF NOT EXISTS xendit_payments (
    payment_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    payment_request_id TEXT NOT NULL,
    amount REAL,
    currency TEXT,
    captures TEXT NOT NULL,
    outcome TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_credit_per_order ON xendit_payments(order_id) WHERE outcome = 'CREDITED';

  CREATE TABLE IF NOT EXISTS xendit_inbox (
    event_key TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    business_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    received_at INTEGER NOT NULL,
    next_check_at INTEGER NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    issue TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_checks ON xendit_inbox(environment, business_id, state, next_check_at);
`);

// Add QRIS instructions to existing databases while retaining bank payment history.
if (!db.prepare('PRAGMA table_info(payment_attempts)').all().some(column => column.name === 'qr_string')) {
  db.exec('ALTER TABLE payment_attempts ADD COLUMN qr_string TEXT');
}
if (!db.prepare('PRAGMA table_info(payment_attempts)').all().some(column => column.name === 'payment_actions')) {
  db.exec("ALTER TABLE payment_attempts ADD COLUMN payment_actions TEXT NOT NULL DEFAULT '[]'");
}

// Sync performances from data/performances.json on startup (insert or update; never deletes,
// so paid votes keep their reference). Remove a performance by setting "active": false.
function syncPerformances(file) {
  if (!fs.existsSync(file)) return;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const upsert = db.prepare(`
    INSERT INTO performances (id, name, subtitle, image, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, subtitle = excluded.subtitle, image = excluded.image,
      sort_order = excluded.sort_order, active = excluded.active
  `);
  list.forEach((p, i) => {
    upsert.run(p.id, p.name, p.subtitle || '', p.image || '', i, p.active === false ? 0 : 1);
  });
}

const stmts = {
  listPerformances: db.prepare(`
    SELECT p.id, p.name, p.subtitle, p.image,
           COALESCE(SUM(o.votes), 0) AS votes
    FROM performances p
    LEFT JOIN orders o ON o.performance_id = p.id AND o.status = 'PAID'
      AND (? = 1 OR COALESCE(o.payment_method, '') <> 'MOCK')
    WHERE p.active = 1
    GROUP BY p.id
    ORDER BY p.sort_order
  `),
  getPerformance: db.prepare(`SELECT id, name, subtitle, image FROM performances WHERE id = ? AND active = 1`),
  insertOrder: db.prepare(`
    INSERT INTO orders (id, performance_id, votes, amount, voter_name, voter_email)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  attachInvoice: db.prepare(`UPDATE orders SET xendit_invoice_id = ?, invoice_url = ? WHERE id = ?`),
  getOrder: db.prepare(`
    SELECT o.*, p.name AS performance_name
    FROM orders o JOIN performances p ON p.id = o.performance_id
    WHERE o.id = ?
  `),
  // These updates are used only by the local mock checkout.
  markPaid: db.prepare(`
    UPDATE orders SET status = 'PAID', paid_at = datetime('now'), payment_method = ?, callback_payload = ?
    WHERE id = ? AND status = 'PENDING'
  `),
  markExpired: db.prepare(`
    UPDATE orders SET status = 'EXPIRED', callback_payload = ?
    WHERE id = ? AND status = 'PENDING'
  `),
  recentOrders: db.prepare(`
    SELECT o.id, o.performance_id, p.name AS performance_name, o.votes, o.amount, o.voter_name,
           o.voter_email, o.status, o.payment_method, o.created_at, o.paid_at
    FROM orders o JOIN performances p ON p.id = o.performance_id
    ORDER BY o.created_at DESC LIMIT ?
  `),
};

module.exports = { db, stmts, syncPerformances };
