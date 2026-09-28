// Shared test helpers. Each test file gets its own database (clockfy_test_<name>) so files can run in parallel.
// Requires a reachable PostgreSQL superuser connection in TEST_PG_ADMIN_URL (default: postgres://postgres@localhost:5433/postgres).
import pg from 'pg';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgres://postgres@localhost:5433/postgres';

export async function setupTestApp(name) {
  const dbName = `clockfy_test_${name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  process.env.DATABASE_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.NODE_ENV = 'test';
  const { migrate } = await import('../src/lib/migrate.js');
  await migrate({ log: () => {} });
  const { createApp } = await import('../src/app.js');
  await import('../src/subscribers.js');
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = await import('../src/lib/db.js');

  const api = (token, headers = {}) => async (method, path, body, opts = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers, ...(opts.headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body)) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, headers: res.headers, text };
  };

  async function register({ email, password = 'secret123', name, workspaceName, timeZone } = {}) {
    const r = await api()('POST', '/api/v1/auth/register', { email: email || `user${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.dev`, password, name, workspaceName, timeZone });
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
    return { token: r.data.token, user: r.data.user, workspaceId: r.data.user.activeWorkspace, call: api(r.data.token) };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }

  return { app, server, base, api, register, close, db };
}

export function iso(d) { return new Date(d).toISOString(); }
