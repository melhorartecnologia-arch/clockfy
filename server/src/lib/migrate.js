import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate({ log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query('SELECT pg_advisory_lock(727272)');
    const applied = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      log(`[migrate] applying ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${err.message}`);
      }
    }
    await c.query('SELECT pg_advisory_unlock(727272)');
  } finally {
    c.release();
  }
}
