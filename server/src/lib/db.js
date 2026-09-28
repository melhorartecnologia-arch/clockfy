import pg from 'pg';
import { config } from '../config.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool, types } = pg;
// Return BIGINT/NUMERIC as numbers, and timestamps as Date
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

export const pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.PG_POOL_MAX || 10) });
pool.on('error', (err) => console.error('[pg] idle client error', err));

const txStorage = new AsyncLocalStorage();

function client() {
  const store = txStorage.getStore();
  return store ? store.client : pool;
}

// Runs `cb` after the current transaction commits (or immediately, on the next tick, when not in a transaction).
export function onCommit(cb) {
  const store = txStorage.getStore();
  if (store) store.afterCommit.push(cb);
  else setImmediate(cb);
}

// Runs fn outside of any transaction context (queries go to the pool)
export function outsideTransaction(fn) {
  return txStorage.exit(fn);
}

export async function query(text, params = []) {
  if (config.logSql) console.log('[sql]', text.replace(/\s+/g, ' ').trim(), params);
  return client().query(text, params);
}

export async function rows(text, params) {
  return (await query(text, params)).rows;
}

export async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0] || null;
}

export async function value(text, params) {
  const r = await query(text, params);
  const row = r.rows[0];
  return row ? Object.values(row)[0] : null;
}

// Runs fn inside a transaction; nested calls reuse the outer transaction.
export async function transaction(fn) {
  const existing = txStorage.getStore();
  if (existing) return fn(existing.client);
  const c = await pool.connect();
  const store = { client: c, afterCommit: [] };
  let result;
  try {
    await c.query('BEGIN');
    result = await txStorage.run(store, () => fn(c));
    await c.query('COMMIT');
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    c.release();
  }
  for (const cb of store.afterCommit) {
    try { txStorage.exit(cb); } catch (err) { console.error('[db] afterCommit callback failed', err); }
  }
  return result;
}

// Small SQL builder helpers ---------------------------------------------------
export function insert(table, data, returning = '*') {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const params = keys.map((k) => normalize(data[k]));
  return one(`INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING ${returning}`, params);
}

export function update(table, id, data, returning = '*', idColumn = 'id') {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return one(`SELECT ${returning} FROM ${table} WHERE "${idColumn}" = $1`, [id]);
  const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const params = [id, ...keys.map((k) => normalize(data[k]))];
  return one(`UPDATE ${table} SET ${sets} WHERE "${idColumn}" = $1 RETURNING ${returning}`, params);
}

// Objects and arrays are serialized as JSON (all list/object columns in the schema are JSONB).
function normalize(v) {
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

export function json(v) {
  return v === undefined ? undefined : JSON.stringify(v ?? null);
}

export async function close() {
  await pool.end();
}
