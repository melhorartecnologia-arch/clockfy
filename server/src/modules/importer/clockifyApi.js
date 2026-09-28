// HTTP client for the official Clockify API used by the importer.
//  - token bucket (max `ratePerSecond` requests per second, default 8 – Clockify allows ~10/s per key)
//  - retries with exponential backoff on 429 (honouring Retry-After), 5xx and network errors (up to `maxRetries`)
//  - automatic pagination (page / page-size) for GET and POST based listings
//  - logging through a callback

export const DEFAULT_BASE_URL = 'https://api.clockify.me/api/v1';
export const DEFAULT_REPORTS_URL = 'https://reports.api.clockify.me/v1';

export class ClockifyApiError extends Error {
  constructor(message, { status, body, path, method } = {}) {
    super(message);
    this.name = 'ClockifyApiError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
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

export function normalizeBaseUrl(url, fallback = DEFAULT_BASE_URL) {
  let u = String(url || '').trim();
  if (!u) return fallback;
  u = u.replace(/\/+$/, '');
  // Accept "https://api.clockify.me" or a regional host without the /api/v1 suffix
  if (/^https?:\/\/[^/]+$/.test(u)) u += '/api/v1';
  return u;
}

export class ClockifyClient {
  constructor({ apiKey, baseUrl, reportsUrl, log, ratePerSecond = 8, maxRetries = 5, fetchImpl, shouldStop, userAgent = 'clockfy-importer/1.0' } = {}) {
    if (!apiKey) throw new Error('apiKey is required');
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.reportsUrl = (reportsUrl || DEFAULT_REPORTS_URL).replace(/\/+$/, '');
    this.log = typeof log === 'function' ? log : () => {};
    this.bucket = new TokenBucket(ratePerSecond);
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl || globalThis.fetch;
    this.shouldStop = typeof shouldStop === 'function' ? shouldStop : () => false;
    this.userAgent = userAgent;
    this.stats = { requests: 0, retries: 0 };
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

  // Performs one request with rate limiting and retries. Returns parsed JSON (or a Buffer with `raw: true`).
  async request(method, path, { query, body, base, raw = false, headers = {} } = {}) {
    const url = this.buildUrl(path, query, base);
    let attempt = 0;
    for (;;) {
      if (this.shouldStop()) throw new ImportCancelledError();
      await this.bucket.acquire();
      this.stats.requests += 1;
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: { 'X-Api-Key': this.apiKey, Accept: raw ? '*/*' : 'application/json', 'User-Agent': this.userAgent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw new ClockifyApiError(`Network error calling ${method} ${path}: ${err.message}`, { path, method });
        attempt += 1; this.stats.retries += 1;
        const wait = backoff(attempt);
        this.log(`Erro de rede em ${method} ${path} (${err.message}); nova tentativa ${attempt}/${this.maxRetries} em ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          const text = await safeText(res);
          throw new ClockifyApiError(`Clockify API ${method} ${path} failed with status ${res.status} after ${attempt + 1} attempts: ${truncate(text)}`, { status: res.status, body: text, path, method });
        }
        attempt += 1; this.stats.retries += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = res.status === 429 && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        this.log(`Clockify respondeu ${res.status} em ${method} ${path}; aguardando ${wait}ms (tentativa ${attempt}/${this.maxRetries})`);
        await safeText(res);
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
    }
  }

  get(path, query, opts = {}) { return this.request('GET', path, { ...opts, query }); }
  post(path, body, query, opts = {}) { return this.request('POST', path, { ...opts, body, query }); }
  download(path, query) { return this.request('GET', path, { query, raw: true }); }

  // Fetches every page of a GET listing. `extract` maps a page payload to its array of items.
  // With `collect: false` pages are only handed to `onPage` (streaming) and an empty array is returned.
  async getAll(path, { query = {}, pageSize = 200, extract = (r) => r, maxPages = 100000, pageParam = 'page', sizeParam = 'page-size', onPage, collect = true } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.get(path, { ...query, [pageParam]: page, [sizeParam]: pageSize });
      const items = toArray(extract(payload));
      if (collect) out.push(...items);
      if (onPage) await onPage(items, page);
      if (items.length < pageSize) break;
    }
    return out;
  }

  // Fetches every page of a POST based listing (body carries page/pageSize, e.g. POST /time-off/requests).
  async postAll(path, body = {}, { pageSize = 200, extract = (r) => r, maxPages = 100000, pageKey = 'page', sizeKey = 'pageSize', onPage, collect = true } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.post(path, { ...body, [pageKey]: page, [sizeKey]: pageSize });
      const items = toArray(extract(payload));
      if (collect) out.push(...items);
      if (onPage) await onPage(items, page);
      if (items.length < pageSize) break;
    }
    return out;
  }

  // Convenience wrappers ------------------------------------------------------
  me() { return this.get('/user'); }
  workspaces() { return this.get('/workspaces'); }
  workspace(id) { return this.get(`/workspaces/${id}`); }
}

function backoff(attempt) {
  const base = Math.min(30000, 500 * 2 ** (attempt - 1));
  return Math.round(base + Math.random() * 250);
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function truncate(s, n = 300) { const t = String(s || ''); return t.length > n ? `${t.slice(0, n)}…` : t; }
function toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function fileNameFromDisposition(header) {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]) : null;
}
