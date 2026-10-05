// HTTP client for the Clockfy API (same shapes as the Clockify public API).
const BASE = '/api/v1';
const TOKEN_KEY = 'clockfy.token';

export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.message) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { if (v.length) p.set(k, v.join(',')); } else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function request(method, path, body, { params, headers, raw, token } = {}) {
  const h = { ...(headers || {}) };
  const t = token ?? getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${path.startsWith('/') && !path.startsWith(BASE) ? BASE + path : path}${qs(params)}`, { method, headers: h, body: payload });
  if (raw) {
    if (!res.ok) { let d = null; try { d = await res.json(); } catch { /* */ } throw new ApiError(res.status, d); }
    return res;
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    if (res.status === 401 && getToken()) { setToken(null); window.dispatchEvent(new Event('clockfy:unauthorized')); }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (path, params, opts) => request('GET', path, undefined, { ...opts, params }),
  post: (path, body, opts) => request('POST', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts),
  download: async (path, body, filename, method = 'POST') => {
    const res = await request(method, path, body, { raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const name = filename || (m ? decodeURIComponent(m[1]) : 'download');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

// Convenience wrappers for the most used resources ---------------------------------
export const ws = (id) => `/workspaces/${id}`;

// Reads a whole list, page by page. A single page used to hide whatever came after it in alphabetical order (e.g. tags
// imported from Clockify past the 500th). Passing `page` asks for that page only.
const PAGE_SIZE = 1000;
async function listAll(path, params = {}) {
  if (params.page !== undefined) return api.get(path, { 'page-size': PAGE_SIZE, ...params });
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const items = await api.get(path, { ...params, page, 'page-size': PAGE_SIZE });
    if (!Array.isArray(items)) return items;
    for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); all.push(it); }
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

export const endpoints = {
  me: () => api.get('/user'),
  login: (email, password) => api.post('/auth/login', { email, password }),
  register: (data) => api.post('/auth/register', data),
  workspaces: () => api.get('/workspaces'),
  workspace: (id) => api.get(ws(id)),
  projects: (id, params) => listAll(`${ws(id)}/projects`, params),
  project: (id, pid, params) => api.get(`${ws(id)}/projects/${pid}`, params),
  tasks: (id, pid, params) => listAll(`${ws(id)}/projects/${pid}/tasks`, params),
  clients: (id, params) => listAll(`${ws(id)}/clients`, params),
  tags: (id, params) => listAll(`${ws(id)}/tags`, params),
  users: (id, params) => listAll(`${ws(id)}/users`, params),
  groups: (id, params) => listAll(`${ws(id)}/user-groups`, params),
  customFields: (id, params) => api.get(`${ws(id)}/custom-fields`, params),
  timeEntries: (id, userId, params) => api.get(`${ws(id)}/user/${userId}/time-entries`, { hydrated: true, 'page-size': 200, ...params }),
  runningEntry: (id, userId) => api.get(`${ws(id)}/user/${userId}/time-entries/running`),
  createEntry: (id, body) => api.post(`${ws(id)}/time-entries`, body),
  createEntryFor: (id, userId, body) => api.post(`${ws(id)}/user/${userId}/time-entries`, body),
  updateEntry: (id, eid, body) => api.put(`${ws(id)}/time-entries/${eid}`, body),
  patchEntry: (id, eid, body) => api.patch(`${ws(id)}/time-entries/${eid}`, body),
  deleteEntry: (id, eid) => api.delete(`${ws(id)}/time-entries/${eid}`),
  stopTimer: (id, userId, end) => api.patch(`${ws(id)}/user/${userId}/time-entries`, { end: end || new Date().toISOString() }),
  continueEntry: (id, userId, eid) => api.post(`${ws(id)}/user/${userId}/time-entries/${eid}/continue`),
  duplicateEntry: (id, userId, eid) => api.post(`${ws(id)}/user/${userId}/time-entries/${eid}/duplicate`),
  notifications: (params) => api.get('/user/notifications', params),
};
