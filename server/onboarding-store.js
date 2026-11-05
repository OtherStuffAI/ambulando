import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

// Server-only receipts. No private identities, card details, or webhook bodies.
export function openOnboardingStore(filename) {
  if (filename !== ':memory:' && !isAbsolute(filename)) throw new Error('Onboarding database must use an absolute persistent path');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS agent_orders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_auth (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
  const get = id => { const row = db.prepare('SELECT data FROM agent_orders WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; };
  const byOwner = owner => { const row = db.prepare('SELECT data FROM agent_orders WHERE owner=?').get(owner); return row ? JSON.parse(row.data) : null; };
  const save = order => {
    if (!get(order.id) && db.prepare('SELECT COUNT(*) AS count FROM agent_orders').get().count >= 50000) throw new Error('Order capacity reached');
    return db.prepare('INSERT INTO agent_orders(id,owner,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(order.id, order.owner, JSON.stringify(order));
  };
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get, byOwner, save, transaction, close: () => db.close(),
    pending: () => db.prepare('SELECT data FROM agent_orders').all().map(r => JSON.parse(r.data)).filter(o => o.paid && !o.agent),
    event: (id, orderId) => db.prepare('INSERT OR IGNORE INTO agent_events(id,order_id) VALUES(?,?)').run(id, orderId),
    authenticate(id, expires, now) {
      return transaction(() => {
        db.prepare('DELETE FROM agent_auth WHERE expires<?').run(now);
        if (db.prepare('SELECT id FROM agent_auth WHERE id=?').get(id)) return false;
        db.prepare('INSERT INTO agent_auth(id,expires) VALUES(?,?)').run(id, expires);
        return true;
      });
    },
  };
}
