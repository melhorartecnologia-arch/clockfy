import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw badRequest(issues.join('; '), 400, r.error.issues);
  }
  return r.data;
}

export const idSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-char hex id');
export const dateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/));
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
export const rateSchema = z.object({ amount: z.number().int().nonnegative(), currency: z.string().optional(), since: z.string().optional() });

export function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes'].includes(String(v).toLowerCase());
}

export function int(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

export function list(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(list);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

export function paging(q, defaults = { page: 1, pageSize: 50, max: 5000 }) {
  const page = Math.max(1, int(q.page ?? q['page'], defaults.page));
  const pageSize = Math.min(defaults.max, Math.max(1, int(q['page-size'] ?? q.pageSize ?? q.size ?? q.limit, defaults.pageSize)));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function sort(q, allowed, def) {
  const col = String(q['sort-column'] || q.sortColumn || def || allowed[0]).toUpperCase();
  const order = String(q['sort-order'] || q.sortOrder || 'ASCENDING').toUpperCase() === 'DESCENDING' ? 'DESC' : 'ASC';
  return { column: allowed.includes(col) ? col : allowed[0], order };
}
