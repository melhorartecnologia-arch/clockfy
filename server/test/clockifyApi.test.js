// Unit tests of the Clockify API client used by the importer (no database, no network: fetch is replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockifyClient, ClockifyApiError, normalizeBaseUrl, deriveReportsUrl, describeEndpoint } from '../src/modules/importer/clockifyApi.js';

const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const items = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(24, '0') }));
const client = (fetchImpl, opts = {}) => new ClockifyClient({ apiKey: 'test-key', fetchImpl, ratePerSecond: 1000, log: () => {}, ...opts });

// GET listing server: `cap` silently limits the page size, `ignorePage` always answers page 1
function pagedServer(list, { cap = Infinity, ignorePage = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.search);
    const page = ignorePage ? 1 : Number(u.searchParams.get('page') || 1);
    const size = Math.min(cap, Number(u.searchParams.get('page-size') || 50));
    return json(200, list.slice((page - 1) * size, page * size));
  };
  return { fetchImpl, calls };
}

test('normalizeBaseUrl accepts what people paste', () => {
  assert.equal(normalizeBaseUrl(''), 'https://api.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('https://app.clockify.me/tracker'), 'https://api.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('api.clockify.me'), 'https://api.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('https://api.clockify.me/api/v1/'), 'https://api.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('euc1.clockify.me'), 'https://euc1.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('https://empresa.clockify.me/tracker'), 'https://empresa.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('https://empresa.clockify.me/api/v1/workspaces'), 'https://empresa.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('https://use2.clockify.me/report/v1'), 'https://use2.clockify.me/api/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/api/v1'), 'http://127.0.0.1:8080/api/v1');
});

test('reports URL and region follow the API host', () => {
  assert.equal(deriveReportsUrl('https://api.clockify.me/api/v1'), 'https://reports.api.clockify.me/v1');
  assert.equal(deriveReportsUrl('https://euc1.clockify.me/api/v1'), 'https://euc1.clockify.me/report/v1');
  assert.equal(deriveReportsUrl('https://empresa.clockify.me/api/v1'), 'https://empresa.clockify.me/report/v1');
  assert.equal(deriveReportsUrl('http://127.0.0.1:9/mirror/api/v1'), 'http://127.0.0.1:9/mirror/report/v1');
  assert.deepEqual(describeEndpoint('https://euw2.clockify.me/api/v1'), { region: 'euw2', label: 'Reino Unido' });
  assert.equal(describeEndpoint('https://empresa.clockify.me/api/v1').region, 'subdomain');
  assert.equal(describeEndpoint('https://api.clockify.me/api/v1').region, 'global');
  const regional = client(undefined, { region: 'apse2' });
  assert.equal(regional.baseUrl, 'https://apse2.clockify.me/api/v1');
  assert.equal(regional.reportsUrl, 'https://apse2.clockify.me/report/v1');
  assert.equal(regional.explicitEndpoint, true);
  assert.equal(client().explicitEndpoint, false);
  assert.equal(client(undefined, { region: 'global' }).explicitEndpoint, true);
  assert.equal(client(undefined, { region: 'auto' }).explicitEndpoint, false);
});

test('pagination survives a silent page-size cap', async () => {
  const logs = [];
  const { fetchImpl, calls } = pagedServer(items(450), { cap: 200 });
  const out = await client(fetchImpl, { log: (m) => logs.push(m) }).getAll('/x', { pageSize: 1000 });
  assert.equal(out.length, 450);
  assert.equal(new Set(out.map((x) => x.id)).size, 450);
  assert.equal(calls.length, 3);
  assert.ok(logs.some((l) => /no máximo 200 itens/.test(l)), logs.join('\n'));
});

test('pagination: natural last pages, repeated pages and streaming', async () => {
  let s = pagedServer(items(1234));
  assert.equal((await client(s.fetchImpl).getAll('/x', { pageSize: 1000 })).length, 1234);
  assert.equal(s.calls.length, 2, '234 is not a typical cap: no extra request');

  s = pagedServer(items(200));
  assert.equal((await client(s.fetchImpl).getAll('/x', { pageSize: 1000 })).length, 200);
  assert.equal(s.calls.length, 2, '200 looks like a cap: one extra request to make sure');

  s = pagedServer(items(500), { ignorePage: true });
  assert.equal((await client(s.fetchImpl).getAll('/x', { pageSize: 100 })).length, 100);
  assert.equal(s.calls.length, 2, 'a page repeating the previous one ends the listing instead of looping');

  s = pagedServer(items(250));
  const pages = [];
  const out = await client(s.fetchImpl).getAll('/x', { pageSize: 100, collect: false, onPage: (list, page) => { pages.push([page, list.length]); } });
  assert.deepEqual(out, []);
  assert.deepEqual(pages, [[1, 100], [2, 100], [3, 50]]);
});

test('a page size refused by the server falls back to 50', async () => {
  const fetchImpl = async (url) => {
    const size = Number(new URL(url).searchParams.get('page-size'));
    if (size > 50) return json(400, { message: 'page-size must be less than or equal to 50', code: 501 });
    return json(200, items(30));
  };
  assert.equal((await client(fetchImpl).getAll('/x', { pageSize: 200 })).length, 30);
});

test('retries 429 (Retry-After), 5xx and network errors; other errors surface with their status', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return json(429, { message: 'Too many requests' }, { 'retry-after': '0' });
    if (n === 2) return json(503, { message: 'unavailable' });
    if (n === 3) throw new TypeError('fetch failed');
    return json(200, { ok: true });
  };
  const c = client(fetchImpl);
  assert.deepEqual(await c.get('/x'), { ok: true });
  assert.equal(c.stats.retries, 3);
  await assert.rejects(() => client(async () => json(403, { message: 'Forbidden', code: 403 })).get('/x'), (err) => err instanceof ClockifyApiError && err.status === 403 && /Forbidden/.test(err.message));
});

test('a request that hangs times out', async () => {
  // AbortSignal.timeout() timers do not keep the event loop alive (a real hanging socket does)
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason)); });
    await assert.rejects(() => client(fetchImpl, { timeoutMs: 50, maxRetries: 0 }).get('/x'), (err) => err instanceof ClockifyApiError && err.network && /tempo esgotado/.test(err.message));
  } finally { clearInterval(keepAlive); }
});

test('finds the data region of the account and of the workspace when no URL is given', async () => {
  const account = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/user') return u.host === 'euc1.clockify.me' ? json(200, { id: 'u1', email: 'a@b.c' }) : json(401, { message: 'Api key does not exist' });
    return json(404, {});
  };
  const c1 = client(account);
  assert.equal((await c1.locateAccount()).id, 'u1');
  assert.equal(c1.baseUrl, 'https://euc1.clockify.me/api/v1');
  assert.equal(c1.reportsUrl, 'https://euc1.clockify.me/report/v1');
  await assert.rejects(() => client(account, { baseUrl: 'https://empresa.clockify.me' }).locateAccount(), (err) => err.status === 401, 'an explicit server is never replaced');

  const data = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/tags')) return u.host === 'use2.clockify.me' ? json(200, []) : json(403, { message: 'Workspace is stored in another region' });
    return json(200, {});
  };
  const c2 = client(data);
  assert.deepEqual(await c2.locateWorkspace('5f0c0c0c0c0c0c0c0c0c0c0c'), { ok: true, switched: true });
  assert.equal(c2.baseUrl, 'https://use2.clockify.me/api/v1');
  const c3 = client(data, { baseUrl: 'https://empresa.clockify.me' });
  assert.equal((await c3.locateWorkspace('5f0c0c0c0c0c0c0c0c0c0c0c')).ok, false);
  assert.equal(c3.baseUrl, 'https://empresa.clockify.me/api/v1');
});

test('detailed report request: all users, UTC, paging inside detailedFilter, reports host', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push({ url, body });
    const all = items(3).map((x) => ({ _id: x.id, userId: 'u', timeInterval: { start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z', duration: 3600 } }));
    return json(200, { totals: [{ entriesCount: 3, totalTime: 10800 }], timeEntries: body.detailedFilter.page === 1 ? all : [] });
  };
  const got = []; let totals = null;
  await client(fetchImpl).detailedReport('5f0c0c0c0c0c0c0c0c0c0c0c', { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z'), onPage: (list) => { got.push(...list); }, onTotals: (t) => { totals = t; } });
  assert.equal(got.length, 3);
  assert.equal(totals.entriesCount, 3);
  assert.equal(bodies[0].url, 'https://reports.api.clockify.me/v1/workspaces/5f0c0c0c0c0c0c0c0c0c0c0c/reports/detailed');
  assert.equal(bodies[0].body.dateRangeStart, '2024-01-01T00:00:00.000Z');
  assert.equal(bodies[0].body.dateRangeEnd, '2024-01-31T23:59:59.999Z');
  assert.equal(bodies[0].body.timeZone, 'UTC');
  assert.deepEqual(bodies[0].body.users, { ids: [], contains: 'DOES_NOT_CONTAIN', status: 'ALL' });
  assert.equal(bodies[0].body.detailedFilter.page, 1);
});
