// Shared reports: saved report filters that can be opened by a link (Clockify Shared Report API).
import { Router } from 'express';
import { one, rows, insert, query } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, paging, int } from '../../lib/validate.js';
import { forbidden, notFound, unauthorized, badRequest } from '../../lib/errors.js';
import { optionalAuth } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { toIso } from '../../lib/dates.js';
import { config } from '../../config.js';
import { runReport, contextForUser, normalizeType } from './run.js';
import { isFileExport, sendExport } from './export.js';

export const router = Router({ mergeParams: true });   // /workspaces/:workspaceId/shared-reports
export const publicRouter = Router();                    // /shared-reports/:id

export const SHARED_REPORT_TYPES = ['DETAILED', 'WEEKLY', 'SUMMARY', 'SCHEDULED', 'EXPENSE_DETAILED', 'EXPENSE_RECEIPT', 'PTO_REQUESTS', 'PTO_BALANCE', 'ATTENDANCE', 'INVOICE_EXPENSE', 'INVOICE_TIME', 'PROJECT', 'TEAM_FULL', 'TEAM_LIMITED', 'TEAM_GROUPS', 'INVOICES', 'KIOSK_PIN_LIST', 'KIOSK_ASSIGNEES', 'USER_DATA_EXPORT'];

const createSchema = z.object({
  name: z.string().min(1).max(250),
  type: z.enum(SHARED_REPORT_TYPES).optional(),
  filter: z.object({}).passthrough().optional(),
  fixedDate: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  visibleToUsers: z.array(z.string()).optional(),
  visibleToUserGroups: z.array(z.string()).optional(),
}).passthrough();
const updateSchema = createSchema.partial().extend({ name: z.string().min(1).max(250) });

export const sharedLink = (id) => `${config.appUrl}/shared/${id}`;

export function sharedReportV1(r) {
  return {
    id: r.id, workspaceId: r.workspace_id, userId: r.user_id, name: r.name, type: r.type, filter: r.filter || {},
    fixedDate: !!r.fixed_date, isPublic: !!r.is_public, visibleToUsers: r.visible_to_users || [], visibleToUserGroups: r.visible_to_user_groups || [],
    link: sharedLink(r.id), createdAt: toIso(r.created_at),
  };
}

async function sharedReportDtoV1(r) {
  const userIds = r.visible_to_users || []; const groupIds = r.visible_to_user_groups || [];
  const users = userIds.length ? await rows('SELECT id, name FROM users WHERE id = ANY($1)', [userIds]) : [];
  const groups = groupIds.length ? await rows('SELECT id, name FROM user_groups WHERE id = ANY($1)', [groupIds]) : [];
  return {
    id: r.id, name: r.name, type: r.type, fixedDate: !!r.fixed_date, isPublic: !!r.is_public, link: sharedLink(r.id), reportAuthor: r.user_id,
    visibleToUsers: userIds.map((id) => ({ id, name: users.find((u) => u.id === id)?.name || '' })),
    visibleToUserGroups: groupIds.map((id) => ({ id, name: groups.find((g) => g.id === id)?.name || '' })),
    filter: r.filter || {}, workspaceId: r.workspace_id, createdAt: toIso(r.created_at),
  };
}

async function getReport(workspaceId, id) {
  const r = await one('SELECT * FROM shared_reports WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!r) throw notFound('Shared report not found', 404);
  return r;
}

function assertOwner(ctx, r) {
  if (!ctx.isAdmin && r.user_id !== ctx.user.id) throw forbidden('Only the report author or an admin can change this shared report', 403);
}

const groupsOf = async (workspaceId, userId) => (await rows('SELECT g.id FROM user_groups g JOIN user_group_members m ON m.group_id = g.id WHERE g.workspace_id = $1 AND m.user_id = $2', [workspaceId, userId])).map((x) => x.id);

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 1000 });
  const mode = String(req.query.sharedReportsFilter || 'ALL').toUpperCase();
  const conds = ['workspace_id = $1']; const params = [req.workspace.id];
  const sharedWithMe = async () => {
    params.push(req.user.id, await groupsOf(req.workspace.id, req.user.id));
    return `(user_id <> $${params.length - 1} AND (visible_to_users ? $${params.length - 1}::text OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(visible_to_user_groups) g WHERE g = ANY($${params.length}))))`;
  };
  if (mode === 'CREATED_BY_ME') { params.push(req.user.id); conds.push(`user_id = $${params.length}`); }
  else if (mode === 'SHARED_WITH_ME') conds.push(await sharedWithMe());
  else if (!req.ctx.isAdmin) { params.push(req.user.id); const mine = `user_id = $${params.length}`; conds.push(`(${mine} OR ${await sharedWithMe()})`); }
  const count = await one(`SELECT count(*)::int AS c FROM shared_reports WHERE ${conds.join(' AND ')}`, params);
  params.push(limit, offset);
  const list = await rows(`SELECT * FROM shared_reports WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ count: count.c, reports: await Promise.all(list.map(sharedReportDtoV1)) });
});

router.get('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  res.json(sharedReportV1(r));
});

router.post('/', async (req, res) => {
  const b = parse(createSchema, req.body);
  const r = await insert('shared_reports', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, user_id: req.user.id, name: b.name, type: b.type || 'SUMMARY',
    filter: b.filter || {}, fixed_date: !!b.fixedDate, is_public: !!b.isPublic, visible_to_users: [...new Set(b.visibleToUsers || [])], visible_to_user_groups: [...new Set(b.visibleToUserGroups || [])],
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_SHARED_REPORT', entityType: 'SHARED_REPORT', entityId: r.id, content: b });
  res.status(200).json(sharedReportV1(r));
});

router.put('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  const b = parse(updateSchema, req.body);
  const updated = await one(
    `UPDATE shared_reports SET name = $2, type = COALESCE($3, type), filter = COALESCE($4::jsonb, filter), fixed_date = COALESCE($5, fixed_date), is_public = COALESCE($6, is_public),
       visible_to_users = COALESCE($7::jsonb, visible_to_users), visible_to_user_groups = COALESCE($8::jsonb, visible_to_user_groups) WHERE id = $1 RETURNING *`,
    [r.id, b.name, b.type || null, b.filter ? JSON.stringify(b.filter) : null, b.fixedDate ?? null, b.isPublic ?? null, b.visibleToUsers ? JSON.stringify([...new Set(b.visibleToUsers)]) : null, b.visibleToUserGroups ? JSON.stringify([...new Set(b.visibleToUserGroups)]) : null],
  );
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_SHARED_REPORT', entityType: 'SHARED_REPORT', entityId: r.id, content: b, previous: sharedReportV1(r) });
  res.json(sharedReportV1(updated));
});

router.delete('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  await query('DELETE FROM shared_reports WHERE id = $1', [r.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_SHARED_REPORT', entityType: 'SHARED_REPORT', entityId: r.id, previous: sharedReportV1(r) });
  res.status(204).end();
});

// Applies the query parameters of GET /shared-reports/:id on top of the saved filter
export function applySharedQuery(report, q = {}) {
  const type = normalizeType(report.type);
  const body = { ...(report.filter || {}) };
  if (!report.fixed_date && q.dateRangeStart && q.dateRangeEnd) {
    body.dateRangeStart = q.dateRangeStart; body.dateRangeEnd = q.dateRangeEnd; body.dateRangeType = 'ABSOLUTE';
  }
  if (q.sortOrder) body.sortOrder = String(q.sortOrder).toUpperCase();
  if (q.exportType) body.exportType = String(q.exportType).toUpperCase();
  const sub = { SUMMARY: 'summaryFilter', DETAILED: 'detailedFilter', ATTENDANCE: 'attendanceFilter', WEEKLY: 'weeklyFilter' }[type];
  if (sub) body[sub] = { ...(body[sub] || {}) };
  if (type === 'SUMMARY' && !body.summaryFilter.groups) body.summaryFilter.groups = ['PROJECT', 'TIMEENTRY'];
  if (q.sortColumn && sub && type !== 'WEEKLY') body[sub].sortColumn = String(q.sortColumn).toUpperCase();
  if (q.sortColumn && type === 'EXPENSE_DETAILED') body.sortColumn = String(q.sortColumn).toUpperCase();
  const page = int(q.page, undefined); const pageSize = int(q.pageSize ?? q['page-size'], undefined);
  const pagedSub = type === 'DETAILED' ? 'detailedFilter' : type === 'ATTENDANCE' ? 'attendanceFilter' : type === 'EXPENSE_DETAILED' ? null : undefined;
  if (pagedSub === null) { if (page) body.page = page; if (pageSize) body.pageSize = pageSize; }
  else if (pagedSub) { if (page) body[pagedSub].page = page; if (pageSize) body[pagedSub].pageSize = pageSize; }
  return { type, body };
}

// GET /shared-reports/:id – public when isPublic, otherwise requires an authenticated user allowed to see it
async function serveSharedReport(req, res) {
  const r = await one('SELECT * FROM shared_reports WHERE id = $1', [req.params.id]);
  if (!r) throw notFound('Shared report not found', 404);
  if (!r.is_public) {
    if (!req.user) throw unauthorized('Authentication required to open this shared report', 1000);
    const member = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [r.workspace_id, req.user.id]);
    if (!member && !req.user.is_super_admin) throw forbidden("You don't have access to this shared report", 403);
    const viewer = await contextForUser(r.workspace_id, req.user.id);
    const myGroups = await groupsOf(r.workspace_id, req.user.id);
    const allowed = viewer.isAdmin || r.user_id === req.user.id || (r.visible_to_users || []).includes(req.user.id) || (r.visible_to_user_groups || []).some((g) => myGroups.includes(g));
    if (!allowed) throw forbidden("You don't have access to this shared report", 403);
  }
  const author = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [r.workspace_id, r.user_id]);
  if (!author) throw badRequest('The author of this shared report is no longer a member of the workspace', 400);
  const ctx = await contextForUser(r.workspace_id, r.user_id);
  const { type, body } = applySharedQuery(r, req.query);
  const out = await runReport(ctx, type, body);
  if (isFileExport(out.filter.exportType)) return sendExport(res, out.table(), out.filter.exportType, out.filter);
  res.json({
    ...out.result,
    id: r.id, name: r.name, type: r.type, filter: r.filter || {}, fixedDate: !!r.fixed_date, isPublic: !!r.is_public,
    workspaceId: r.workspace_id, workspaceName: ctx.workspace.name, reportAuthor: r.user_id,
    dateRangeStart: toIso(out.filter.start), dateRangeEnd: toIso(out.filter.end), timeZone: out.filter.timeZone,
  });
}

publicRouter.get('/:id', (req, res, next) => (req.user ? next() : optionalAuth(req, res, next)), serveSharedReport);

export default router;
