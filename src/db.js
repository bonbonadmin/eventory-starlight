const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.DB_PATH || './data/starlight.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS performances (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    subtitle    TEXT NOT NULL DEFAULT '',
    image       TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
  );

  -- One row per checkout. Votes only count once status = 'PAID',
  -- which is set exclusively by the verified Xendit callback.
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
`);

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
           COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN o.votes END), 0) AS votes
    FROM performances p
    LEFT JOIN orders o ON o.performance_id = p.id
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
  deleteOrder: db.prepare(`DELETE FROM orders WHERE id = ? AND status = 'PENDING'`),
  getOrder: db.prepare(`
    SELECT o.*, p.name AS performance_name
    FROM orders o JOIN performances p ON p.id = o.performance_id
    WHERE o.id = ?
  `),
  // Status guard makes these idempotent: Xendit may deliver the same callback more than once.
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
