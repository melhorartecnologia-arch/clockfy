// HTTP client for the official Clockify API used by the importer.
//  - token bucket (max `ratePerSecond` requests per second, default 8 – Clockify allows ~10/s per key)
//  - retries with exponential backoff on 429 (honouring Retry-After), 5xx, network errors and timeouts
//  - safe automatic pagination (page / page-size) for GET and POST listings – see `paginate`
//  - data regions and subdomains (https://{region}.clockify.me/api/v1 and /report/v1), detected automatically
//    when no URL is given
//  - logging through a callback

export const DEFAULT_BASE_URL = 'https://api.clockify.me/api/v1';
export const DEFAULT_REPORTS_URL = 'https://reports.api.clockify.me/v1';

// Clockify data regions ("Regional server prefixes" in the API documentation).
export const REGIONS = { euc1: 'EU (Alemanha)', use2: 'EUA', euw2: 'Reino Unido', apse2: 'Austrália' };

export function regionEndpoints(region) {
  return { baseUrl: `https://${region}.clockify.me/api/v1`, reportsUrl: `https://${region}.clockify.me/report/v1` };
}

// A short page whose size is one of these may be a silent server-side cap rather than the last page.
const SUSPICIOUS_PAGE_SIZES = new Set([10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]);

export class ClockifyApiError extends Error {
  constructor(message, { status, body, path, method, network = false } = {}) {
    super(message);
    this.name = 'ClockifyApiError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
    this.network = network;
  }
}

export class ImportCancelledError extends Error {
  constructor(message = 'Import cancelled') {
    super(message);
    this.name = 'ImportCancelledError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Simple token bucket: `capacity` tokens, refilled at `ratePerSecond`.
class TokenBucket {
  constructor(ratePerSecond) {
    this.rate = Math.max(1, ratePerSecond);
    this.capacity = this.rate;
    this.tokens = this.rate;
    this.last = Date.now();
    this.queue = Promise.resolve();
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  acquire() {
    // Serialise acquisitions so concurrent callers are handed out tokens in order.
    const next = this.queue.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
        await sleep(Math.max(5, waitMs));
        this.refill();
      }
      this.tokens -= 1;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

// Accepts what people paste: blank (global cloud), the web app or API host, a regional or subdomain host
// ("euc1.clockify.me", "https://empresa.clockify.me/tracker") or a full ".../api/v1" URL of a mirror.
export function normalizeBaseUrl(url, fallback = DEFAULT_BASE_URL) {
  let u = String(url || '').trim();
  if (!u) return fallback;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  let parsed;
  try { parsed = new URL(u); } catch { return u.replace(/\/+$/, ''); }
  const host = parsed.hostname.toLowerCase();
  if (['clockify.me', 'www.clockify.me', 'app.clockify.me', 'api.clockify.me', 'reports.api.clockify.me'].includes(host)) return DEFAULT_BASE_URL;
  const path = parsed.pathname.replace(/\/+$/, '');
  const i = path.indexOf('/api/v1');
  if (i >= 0) return `${parsed.origin}${path.slice(0, i + 7)}`;
  if (/\/v1$/.test(path) && !/^\/report(\/|$)/.test(path)) return `${parsed.origin}${path}`;
  return `${parsed.origin}/api/v1`;
}

// Reports live on another host: reports.api.clockify.me for the global cloud, {host}/report/v1 for data regions and
// subdomains (and for mirrors, next to their /api/v1).
export function deriveReportsUrl(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return DEFAULT_REPORTS_URL; }
  if (parsed.hostname.toLowerCase() === 'api.clockify.me') return DEFAULT_REPORTS_URL;
  const path = parsed.pathname.replace(/\/+$/, '');
  const i = path.indexOf('/api/v1');
  return `${parsed.origin}${i >= 0 ? path.slice(0, i) : ''}/report/v1`;
}

// Human description of an API base URL: { region: 'global' | euc1… | 'subdomain' | 'custom', label }.
export function describeEndpoint(baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return { region: 'custom', label: String(baseUrl) }; }
  if (host === 'api.clockify.me') return { region: 'global', label: 'Global' };
  const m = /^([a-z0-9-]+)\.clockify\.me$/.exec(host);
  if (m && REGIONS[m[1]]) return { region: m[1], label: REGIONS[m[1]] };
  if (m) return { region: 'subdomain', label: `Subdomínio ${m[1]}.clockify.me` };
  return { region: 'custom', label: host };
}

const itemId = (x) => (x && typeof x === 'object' ? (x.id ?? x._id ?? x.approvalRequest?.id ?? null) : null);
const pathLabel = (path) => String(path).replace(/[a-f0-9]{24}/g, '{id}');

export class ClockifyClient {
  constructor({ apiKey, baseUrl, reportsUrl, region, log, ratePerSecond = 8, maxRetries = 5, timeoutMs = 60000, fetchImpl, shouldStop, userAgent = 'clockfy-importer/1.1' } = {}) {
    if (!apiKey) throw new Error('apiKey is required');
    this.apiKey = String(apiKey).trim();
    if (region && REGIONS[region]) this.useEndpoints(regionEndpoints(region));
    else this.useEndpoints({ baseUrl: normalizeBaseUrl(baseUrl), reportsUrl });
    // With an explicit URL or region the client never switches hosts on its own.
    this.explicitEndpoint = !!(String(baseUrl || '').trim() || (region && region !== 'auto'));
    this.log = typeof log === 'function' ? log : () => {};
    this.bucket = new TokenBucket(ratePerSecond);
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
    this.shouldStop = typeof shouldStop === 'function' ? shouldStop : () => false;
    this.userAgent = userAgent;
    this.stats = { requests: 0, retries: 0 };
  }

  useEndpoints({ baseUrl, reportsUrl }) {
    this.baseUrl = baseUrl;
    this.reportsUrl = String(reportsUrl || '').trim().replace(/\/+$/, '') || deriveReportsUrl(baseUrl);
    this.endpoint = describeEndpoint(baseUrl);
  }

  buildUrl(path, query, base) {
    const root = base || this.baseUrl;
    const url = new URL(path.startsWith('http') ? path : root + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  // Performs one request with rate limiting, a timeout and retries. Returns parsed JSON (or a Buffer with `raw: true`).
  async request(method, path, { query, body, base, raw = false, headers = {}, retries = this.maxRetries, timeoutMs = raw ? Math.max(this.timeoutMs, 120000) : this.timeoutMs } = {}) {
    const url = this.buildUrl(path, query, base);
    for (let attempt = 0; ; attempt++) {
      if (this.shouldStop()) throw new ImportCancelledError();
      await this.bucket.acquire();
      this.stats.requests += 1;
      try {
        const res = await this.fetch(url, {
          method,
          headers: { 'X-Api-Key': this.apiKey, Accept: raw ? '*/*' : 'application/json', 'User-Agent': this.userAgent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const text = await safeText(res);
          if (attempt >= retries) throw new ClockifyApiError(`Clockify API ${method} ${path} failed with status ${res.status} after ${attempt + 1} attempts: ${truncate(text)}`, { status: res.status, body: text, path, method });
          this.stats.retries += 1;
          const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after'), attempt + 1) : backoff(attempt + 1);
          this.log(`Clockify respondeu ${res.status} em ${method} ${pathLabel(path)}; aguardando ${wait}ms (tentativa ${attempt + 1}/${retries})`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) {
          const text = await safeText(res);
          let message = truncate(text);
          try { const j = JSON.parse(text); if (j && j.message) message = j.message; } catch { /* not json */ }
          throw new ClockifyApiError(`Clockify API ${method} ${path} failed with status ${res.status}: ${message}`, { status: res.status, body: text, path, method });
        }
        if (raw) {
          const buf = Buffer.from(await res.arrayBuffer());
          return { data: buf, contentType: res.headers.get('content-type') || 'application/octet-stream', fileName: fileNameFromDisposition(res.headers.get('content-disposition')) };
        }
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      } catch (err) {
        if (err instanceof ClockifyApiError || err instanceof ImportCancelledError) throw err;
        // network failure or timeout (while connecting or while reading the body)
        if (this.shouldStop()) throw new ImportCancelledError();
        const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `tempo esgotado após ${Math.round(timeoutMs / 1000)}s` : (err?.cause?.code || err?.message || String(err));
        if (attempt >= retries) throw new ClockifyApiError(`Network error calling ${method} ${path}: ${reason}`, { path, method, network: true });
        this.stats.retries += 1;
        const wait = backoff(attempt + 1);
        this.log(`Erro de rede em ${method} ${pathLabel(path)} (${reason}); nova tentativa ${attempt + 1}/${retries} em ${wait}ms`);
        await sleep(wait);
      }
    }
  }

  get(path, query, opts = {}) { return this.request('GET', path, { ...opts, query }); }
  post(path, body, query, opts = {}) { return this.request('POST', path, { ...opts, body, query }); }
  download(path, query) { return this.request('GET', path, { query, raw: true }); }

  // Walks a paged listing; `fetchPage(page)` returns the payload of one page and `extract` maps it to its items.
  // With `collect: false` pages are only handed to `onPage` (streaming) and an empty array is returned.
  // Safety nets against silently losing records:
  //  - items already returned by an earlier page are dropped, and a page that brings nothing new ends the walk
  //    (servers that ignore `page` would otherwise loop forever);
  //  - a short page whose size is a typical server-side cap (50, 200, 1000…) is not trusted as the last one: the next
  //    page is fetched and, when it brings new items, that size becomes the effective page size.
  async paginate(fetchPage, { pageSize, extract = (r) => r, maxPages = 100000, onPage, collect = true, label = 'Listagem' } = {}) {
    const out = [];
    const seen = new Set();
    let cap = null; let peekFrom = null; let lastFingerprint = null;
    for (let page = 1; page <= maxPages; page++) {
      const raw = toArray(extract(await fetchPage(page)));
      const items = [];
      let withId = 0;
      for (const item of raw) {
        const id = itemId(item);
        if (id != null) { withId += 1; if (seen.has(id)) continue; seen.add(id); }
        items.push(item);
      }
      if (raw.length && !withId) {
        const fingerprint = JSON.stringify(raw);
        if (fingerprint === lastFingerprint) break;
        lastFingerprint = fingerprint;
      }
      if (peekFrom != null) {
        if (!items.length) break; // the short page really was the last one
        cap = peekFrom; peekFrom = null;
        this.log(`${label}: o Clockify devolve no máximo ${cap} itens por página – paginação ajustada`);
      }
      if (items.length) {
        if (collect) out.push(...items);
        if (onPage) await onPage(items, page);
      }
      if (!raw.length) break;
      if (!items.length) {
        if (raw.length >= (cap || pageSize)) this.log(`${label}: a página ${page} repetiu itens já recebidos – listagem encerrada`);
        break;
      }
      if (raw.length >= (cap || pageSize)) continue;
      if (!cap && SUSPICIOUS_PAGE_SIZES.has(raw.length)) { peekFrom = raw.length; continue; }
      break;
    }
    return out;
  }

  // Fetches every page of a GET listing.
  async getAll(path, { query = {}, pageSize = 200, pageParam = 'page', sizeParam = 'page-size', ...opts } = {}) {
    const run = (size) => this.paginate((page) => this.get(path, { ...query, [pageParam]: page, [sizeParam]: size }), { pageSize: size, label: pathLabel(path), ...opts });
    try {
      return await run(pageSize);
    } catch (err) {
      // a server that rejects the page size outright (400 "page-size…") gets the conservative default instead
      if (pageSize > 50 && err instanceof ClockifyApiError && err.status === 400 && /page.?size/i.test(err.message)) {
        this.log(`${pathLabel(path)}: page-size ${pageSize} recusado pelo Clockify – usando 50`);
        return run(50);
      }
      throw err;
    }
  }

  // Fetches every page of a POST based listing (body carries page/pageSize, e.g. POST /time-off/requests).
  postAll(path, body = {}, { pageSize = 200, pageKey = 'page', sizeKey = 'pageSize', base, ...opts } = {}) {
    return this.paginate((page) => this.post(path, { ...body, [pageKey]: page, [sizeKey]: pageSize }, undefined, base ? { base } : {}), { pageSize, label: pathLabel(path), ...opts });
  }

  // Detailed report (reports API) of [start, end): every entry of the period – also those of people removed from the
  // workspace, which the per-user listing no longer returns. `allUsers` asks explicitly for every user status
  // ("does not contain: nobody"); without it Clockify applies its default users filter. `onTotals` receives the
  // report totals of the period (entriesCount, totalTime).
  detailedReport(workspaceId, { start, end, pageSize = 1000, onPage, onTotals, allUsers = true } = {}) {
    const body = (page) => ({
      dateRangeStart: start.toISOString(),
      dateRangeEnd: new Date(end.getTime() - 1).toISOString(),
      dateRangeType: 'ABSOLUTE',
      timeZone: 'UTC',
      sortOrder: 'ASCENDING',
      ...(allUsers ? { users: { ids: [], contains: 'DOES_NOT_CONTAIN', status: 'ALL' } } : {}),
      detailedFilter: { page, pageSize, sortColumn: 'DATE', options: { totals: page === 1 ? 'CALCULATE' : 'EXCLUDE' } },
    });
    return this.paginate(
      async (page) => {
        const r = await this.post(`/workspaces/${workspaceId}/reports/detailed`, body(page), undefined, { base: this.reportsUrl });
        if (page === 1 && onTotals) onTotals(Array.isArray(r?.totals) ? r.totals[0] || null : null);
        return r;
      },
      { pageSize, collect: false, onPage, label: 'Relatório detalhado', extract: (r) => (Array.isArray(r) ? r : r?.timeEntries) },
    );
  }

  // Convenience wrappers ------------------------------------------------------
  me() { return this.get('/user'); }
  workspaces() { return this.get('/workspaces'); }
  workspace(id) { return this.get(`/workspaces/${id}`); }

  // GET /user, also trying the data regions when the configured host rejects the key and no URL was given.
  async locateAccount() {
    try {
      return await this.me();
    } catch (err) {
      if (this.explicitEndpoint || !(err instanceof ClockifyApiError) || ![401, 403, 404].includes(err.status)) throw err;
      for (const region of Object.keys(REGIONS)) {
        const e = regionEndpoints(region);
        try {
          const me = await this.request('GET', '/user', { base: e.baseUrl, retries: 1, timeoutMs: 20000 });
          this.useEndpoints(e);
          this.log(`Conta encontrada no servidor regional ${REGIONS[region]} (${e.baseUrl})`);
          return me;
        } catch (probeErr) {
          if (probeErr instanceof ImportCancelledError) throw probeErr;
        }
      }
      throw err;
    }
  }

  // Makes sure the current host serves the workspace data; when it does not (workspace stored in another data region)
  // and no URL was given, switches to the region that does. Returns { ok, switched }.
  async locateWorkspace(workspaceId) {
    const probe = (base) => this.request('GET', `/workspaces/${workspaceId}/tags`, { base, query: { page: 1, 'page-size': 1 }, retries: 1, timeoutMs: 20000 });
    try {
      await probe();
      return { ok: true, switched: false };
    } catch (err) {
      if (err instanceof ImportCancelledError) throw err;
      if (this.explicitEndpoint || (err instanceof ClockifyApiError && (err.status === 401 || err.status === 429))) return { ok: false, switched: false, error: err };
      for (const region of Object.keys(REGIONS)) {
        const e = regionEndpoints(region);
        if (e.baseUrl === this.baseUrl) continue;
        try {
          await probe(e.baseUrl);
          this.useEndpoints(e);
          return { ok: true, switched: true };
        } catch (probeErr) {
          if (probeErr instanceof ImportCancelledError) throw probeErr;
        }
      }
      return { ok: false, switched: false, error: err };
    }
  }
}

function backoff(attempt) {
  const base = Math.min(30000, 500 * 2 ** (attempt - 1));
  return Math.round(base + Math.random() * 250);
}

function retryAfterMs(header, attempt) {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(120000, Math.max(secs * 1000, 100));
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(120000, Math.max(at - Date.now(), 100));
  }
  return backoff(attempt);
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function truncate(s, n = 300) { const t = String(s || ''); return t.length > n ? `${t.slice(0, n)}…` : t; }
function toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function fileNameFromDisposition(header) {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
