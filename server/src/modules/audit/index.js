import { Router } from 'express';
import { one, rows } from '../../lib/db.js';
import { parse, z, list, int, bool } from '../../lib/validate.js';
import { badRequest } from '../../lib/errors.js';
import { parseDate, toIso, addDays } from '../../lib/dates.js';
import { projectDto, clientDto, tagDto } from '../../lib/dto.js';
import { entriesDto } from '../timeEntries/service.js';
import { singleTaskDto } from '../tasks/index.js';
import { expenseDto } from '../webhooks/service.js';

export const auditRouter = Router({ mergeParams: true });     // /workspaces/:workspaceId/audit-log
export const entitiesRouter = Router({ mergeParams: true });  // /workspaces/:workspaceId/entities

auditRouter.use((req, res, next) => { req.ctx.requireAdmin(); next(); });
entitiesRouter.use((req, res, next) => { req.ctx.requireAdmin(); next(); });

// ---- Audit log -----------------------------------------------------------------------------------------
const str = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

export function auditLogDto(r) {
  return {
    id: r.id,
    action: r.action,
    content: str(r.content),
    previousContent: str(r.previous_content),
    timestamp: toIso(r.created_at),
    userId: r.user_id || null,
    userName: r.user_id ? (r.user_name || '') : 'SYSTEM',
    userEmail: r.user_id ? (r.user_email || '') : '',
    workspaceId: r.workspace_id,
    entityType: r.entity_type,
    entityId: r.entity_id || null,
  };
}

export async function searchAuditLog(workspaceId, { actions = [], authorIds = [], contains = 'CONTAINS', start, end, entityTypes = [], entityId, limit = 20, offset = 0 } = {}) {
  const conds = ['a.workspace_id = $1']; const params = [workspaceId];
  if (actions.length) { params.push(actions); conds.push(`a.action = ANY($${params.length})`); }
  if (authorIds.length) {
    const ids = authorIds.filter((x) => x !== 'SYSTEM');
    const parts = [];
    if (ids.length) { params.push(ids); parts.push(`a.user_id = ANY($${params.length})`); }
    if (authorIds.includes('SYSTEM')) parts.push('a.user_id IS NULL');
    const expr = `(${parts.join(' OR ')})`;
    conds.push(String(contains).toUpperCase() === 'DOES_NOT_CONTAIN' ? `NOT ${expr}` : expr);
  }
  if (start) { params.push(start); conds.push(`a.created_at >= $${params.length}`); }
  if (end) { params.push(end); conds.push(`a.created_at <= $${params.length}`); }
  if (entityTypes.length) { params.push(entityTypes); conds.push(`a.entity_type = ANY($${params.length})`); }
  if (entityId) { params.push(entityId); conds.push(`a.entity_id = $${params.length}`); }
  const where = conds.join(' AND ');
  const total = (await one(`SELECT count(*)::int AS c FROM audit_log a WHERE ${where}`, params)).c;
  params.push(limit, offset);
  const l = await rows(
    `SELECT a.*, u.name AS user_name, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { response: l.map(auditLogDto), total };
}

function pageOf(page, size) {
  const p = Math.max(1, int(page, 1)); // Clockify: page 1 = first page (0 is treated as 1)
  const s = Math.min(200, Math.max(1, int(size, 20)));
  return { page: p, pageSize: s, limit: s, offset: (p - 1) * s };
}

const authorsSchema = z.union([
  z.array(z.string()),
  z.object({ authorIds: z.array(z.string()).optional(), ids: z.array(z.string()).optional(), contains: z.string().optional() }).passthrough(),
]);
const bodySchema = z.object({
  actions: z.array(z.string()).optional(),
  authors: authorsSchema.optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  page: z.union([z.number(), z.string()]).optional(),
  'page-size': z.union([z.number(), z.string()]).optional(),
  pageSize: z.union([z.number(), z.string()]).optional(),
  entityTypes: z.array(z.string()).optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
}).passthrough();

// POST /audit-log  body: AuditLogGetRequestV1 → PageableV1ListAuditLogDtoV1
auditRouter.post('/', async (req, res) => {
  const b = parse(bodySchema, req.body || {});
  const authors = Array.isArray(b.authors) ? { authorIds: b.authors } : (b.authors || {});
  const paging = pageOf(b.page, b['page-size'] ?? b.pageSize);
  const out = await searchAuditLog(req.workspace.id, {
    actions: (b.actions || []).map((a) => String(a).toUpperCase()), authorIds: authors.authorIds || authors.ids || [], contains: authors.contains || 'CONTAINS',
    start: b.start ? parseDate(b.start, 'start') : null, end: b.end ? parseDate(b.end, 'end') : null,
    entityTypes: (b.entityTypes || (b.entityType ? [b.entityType] : [])).map((t) => String(t).toUpperCase()), entityId: b.entityId, limit: paging.limit, offset: paging.offset,
  });
  res.json({ response: out.response, page: paging.page, pageSize: paging.pageSize, total: out.total });
});

// Extra (UI): the same filters as query parameters
auditRouter.get('/', async (req, res) => {
  const q = req.query;
  const paging = pageOf(q.page, q['page-size'] ?? q.pageSize);
  const out = await searchAuditLog(req.workspace.id, {
    actions: list(q.actions || q.action).map((a) => a.toUpperCase()), authorIds: list(q.authors || q.users || q.userId), contains: q.contains || 'CONTAINS',
    start: q.start ? parseDate(q.start, 'start') : null, end: q.end ? parseDate(q.end, 'end') : null,
    entityTypes: list(q.entityTypes || q.entityType).map((t) => t.toUpperCase()), entityId: q.entityId, limit: paging.limit, offset: paging.offset,
  });
  res.json({ response: out.response, page: paging.page, pageSize: paging.pageSize, total: out.total });
});

// ---- Entity changes (experimental) -------------------------------------------------------------------------
const TYPE_ALIASES = {
  TIMEENTRY: 'TIMEENTRY', TIME_ENTRY: 'TIMEENTRY', TIME_ENTRIES: 'TIMEENTRY', TIMEENTRIES: 'TIMEENTRY',
  PROJECT: 'PROJECT', PROJECTS: 'PROJECT', CLIENT: 'CLIENT', CLIENTS: 'CLIENT', TASK: 'TASK', TASKS: 'TASK',
  TAG: 'TAG', TAGS: 'TAG', EXPENSE: 'EXPENSE', EXPENSES: 'EXPENSE',
};

// table, select expression, soft-delete column, DTO mapper, audit action used for physical deletes
const ENTITIES = {
  TIMEENTRY: { table: 'time_entries', select: 'x.*', deletedCol: 'deleted_at', dto: (l, o) => entriesDto(l, { hydrated: o.hydrated, showRates: true }) },
  PROJECT: { table: 'projects', select: 'x.*, (SELECT c.name FROM clients c WHERE c.id = x.client_id) AS client_name', dto: (l) => l.map((p) => projectDto(p)), deleteAction: 'DELETE_PROJECT', updateAction: 'UPDATE_PROJECT' },
  CLIENT: { table: 'clients', select: 'x.*, (SELECT cur.code FROM workspace_currencies cur WHERE cur.id = x.currency_id) AS currency_code', dto: (l) => l.map((c) => clientDto(c)), deleteAction: 'DELETE_CLIENT', updateAction: 'UPDATE_CLIENT' },
  TASK: { table: 'tasks', select: 'x.*', dto: (l) => Promise.all(l.map(singleTaskDto)), deleteAction: 'DELETE_TASK', updateAction: 'UPDATE_TASK' },
  TAG: { table: 'tags', select: 'x.*', dto: (l) => l.map(tagDto), deleteAction: 'DELETE_TAG', updateAction: 'UPDATE_TAG', noUpdatedAt: true },
  EXPENSE: { table: 'expenses', select: 'x.*', deletedCol: 'deleted_at', dto: (l) => l.map(expenseDto) },
};

function entityQuery(req) {
  const types = [...new Set(list(req.query.type).map((t) => TYPE_ALIASES[t.toUpperCase()]).filter(Boolean))];
  if (!types.length) throw badRequest('type is required: TIMEENTRY, PROJECT, CLIENT, TASK, TAG or EXPENSE', 400);
  let start = req.query.start ? parseDate(req.query.start, 'start') : null;
  let end = req.query.end ? parseDate(req.query.end, 'end') : null;
  if (!start && !end) { end = new Date(); start = addDays(end, -30); } else if (!start) start = addDays(end, -30); else if (!end) end = addDays(start, 30);
  const page = Math.max(0, int(req.query.page, 0)); // 0-based, as documented by Clockify for this endpoint
  const limit = Math.min(1000, Math.max(1, int(req.query.limit ?? req.query['page-size'], 50)));
  return { types, start, end, page, limit, offset: page * limit, hydrated: bool(req.query.hydrated, false) };
}

async function selectRows(def, workspaceId, where, params, q) {
  return rows(`SELECT ${def.select} FROM ${def.table} x WHERE x.workspace_id = $1 AND ${where} ORDER BY x.created_at, x.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit, q.offset]);
}

entitiesRouter.get('/created', async (req, res) => {
  const q = entityQuery(req);
  const items = [];
  for (const type of q.types) {
    const def = ENTITIES[type];
    const where = `x.created_at >= $2 AND x.created_at <= $3${def.deletedCol ? ` AND x.${def.deletedCol} IS NULL` : ''}`;
    const l = await selectRows(def, req.workspace.id, where, [req.workspace.id, q.start, q.end], q);
    const dtos = await def.dto(l, q);
    dtos.forEach((d, i) => items.push({ ...d, entityType: type, createdAt: toIso(l[i].created_at) }));
  }
  res.json({ items, response: items, page: q.page, limit: q.limit, start: toIso(q.start), end: toIso(q.end) });
});

entitiesRouter.get('/updated', async (req, res) => {
  const q = entityQuery(req);
  const items = [];
  for (const type of q.types) {
    const def = ENTITIES[type];
    let l;
    if (def.noUpdatedAt) {
      // entities without updated_at: use the audit log to find what changed in the range
      l = await rows(
        `SELECT ${def.select}, (SELECT max(a.created_at) FROM audit_log a WHERE a.entity_id = x.id AND a.action = $4) AS updated_at FROM ${def.table} x
         WHERE x.workspace_id = $1 AND x.created_at < $2 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.workspace_id = $1 AND a.entity_id = x.id AND a.action = $4 AND a.created_at >= $2 AND a.created_at <= $3)
         ORDER BY x.created_at, x.id LIMIT $5 OFFSET $6`,
        [req.workspace.id, q.start, q.end, def.updateAction, q.limit, q.offset],
      );
    } else {
      // entities created inside the range are reported by /created only
      const where = `x.updated_at >= $2 AND x.updated_at <= $3 AND x.created_at < $2${def.deletedCol ? ` AND x.${def.deletedCol} IS NULL` : ''}`;
      l = await selectRows(def, req.workspace.id, where, [req.workspace.id, q.start, q.end], q);
    }
    const dtos = await def.dto(l, q);
    dtos.forEach((d, i) => items.push({ ...d, entityType: type, updatedAt: toIso(l[i].updated_at) }));
  }
  res.json({ items, response: items, page: q.page, limit: q.limit, start: toIso(q.start), end: toIso(q.end) });
});

entitiesRouter.get('/deleted', async (req, res) => {
  const q = entityQuery(req);
  const items = [];
  for (const type of q.types) {
    const def = ENTITIES[type];
    if (def.deletedCol) {
      // soft-deleted rows (time entries, expenses): the document is the current DTO
      const where = `x.${def.deletedCol} >= $2 AND x.${def.deletedCol} <= $3 AND x.created_at < $2`;
      const l = await rows(`SELECT ${def.select} FROM ${def.table} x WHERE x.workspace_id = $1 AND ${where} ORDER BY x.${def.deletedCol}, x.id LIMIT $4 OFFSET $5`, [req.workspace.id, q.start, q.end, q.limit, q.offset]);
      const dtos = await def.dto(l, q);
      dtos.forEach((d, i) => items.push({ id: l[i].id, documentCode: type, deletedAt: toIso(l[i][def.deletedCol]), document: d }));
    } else {
      // physically removed rows: the audit log keeps the previous document
      const l = await rows(
        `SELECT a.entity_id, a.created_at, a.previous_content FROM audit_log a WHERE a.workspace_id = $1 AND a.action = $2 AND a.created_at >= $3 AND a.created_at <= $4 ORDER BY a.created_at, a.id LIMIT $5 OFFSET $6`,
        [req.workspace.id, def.deleteAction, q.start, q.end, q.limit, q.offset],
      );
      l.forEach((a) => items.push({ id: a.entity_id, documentCode: type, deletedAt: toIso(a.created_at), document: a.previous_content || null }));
    }
  }
  res.json({ items, response: items, page: q.page, limit: q.limit, start: toIso(q.start), end: toIso(q.end) });
});

export default {
  name: 'audit',
  workspace(ws) {
    ws.use('/audit-log', auditRouter);
    ws.use('/entities', entitiesRouter);
  },
};
