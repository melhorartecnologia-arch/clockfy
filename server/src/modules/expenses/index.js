// Module "expenses" – Clockify-compatible expenses and expense categories API.
//   /api/v1/workspaces/:workspaceId/expenses[/categories]
// Extra (UI) routes: GET /expenses filters start,end,project,task,category,client,billable,status,invoiced,users;
//   PATCH /expenses/:expenseId (partial update); GET /expenses/:expenseId/files/:fileId?inline=true (preview).
import { Router } from 'express';
import multer from 'multer';
import { one, rows, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, list, paging, sort } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { visibleUserIds } from '../../middleware/workspace.js';
import {
  categoryDto, loadCategory, loadExpense, expenseDto, expensesDto, createExpense, updateExpense, deleteExpense, listExpenses, canViewExpense,
  assertCanEdit, storeReceipt, dateStr, normalizeDate, money, isExpenseLockedByDate,
} from './service.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/expenses

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

// Parses multipart/form-data (field "file" = receipt) when present; JSON bodies pass through untouched.
function receipt(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest(`File exceeds the maximum size of ${config.maxUploadBytes} bytes`, 400));
    next(badRequest(err.message || 'Invalid multipart body', 400));
  });
}

const CHANGE_FIELDS = ['USER', 'DATE', 'PROJECT', 'TASK', 'CATEGORY', 'NOTES', 'AMOUNT', 'BILLABLE', 'FILE'];
const optionalId = z.string().max(64).nullable().optional();
const expenseSchema = z.object({
  id: z.string().optional(),
  userId: optionalId,
  date: z.string().or(z.date()).optional(),
  projectId: optionalId,
  taskId: optionalId,
  categoryId: optionalId,
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  notes: z.string().max(3000).nullable().optional(),
  billable: z.boolean().optional(),
  fileId: optionalId,
  changeFields: z.array(z.enum(CHANGE_FIELDS)).optional(),
});

// Multipart fields arrive as strings; coerce them to the JSON types before validation.
function coerceBody(req) {
  const b = { ...(req.body || {}) };
  if (req.is('multipart/form-data')) {
    for (const k of Object.keys(b)) if (b[k] === '') delete b[k];
    if (b.billable !== undefined) b.billable = bool(b.billable, false);
    if (b.amount !== undefined) b.amount = Number(b.amount);
    if (b.changeFields !== undefined) b.changeFields = list(b.changeFields).map((s) => s.toUpperCase());
  } else if (typeof b.billable === 'string') {
    b.billable = bool(b.billable, false);
  }
  if (b.date instanceof Date) b.date = b.date.toISOString();
  return parse(expenseSchema, b);
}

// ---- Categories ------------------------------------------------------------------
const categorySchema = z.object({
  name: z.string().min(1).max(250),
  hasUnitPrice: z.boolean().optional(),
  unit: z.string().max(50).nullable().optional(),
  priceInCents: z.number().int().nonnegative().optional(),
});

router.get('/categories', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'ID'], 'NAME');
  const conds = ['workspace_id = $1']; const params = [req.workspace.id];
  if (req.query.archived !== undefined && req.query.archived !== '') { params.push(bool(req.query.archived, false)); conds.push(`archived = $${params.length}`); }
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(name) LIKE $${params.length}`); }
  const count = await one(`SELECT count(*)::int AS c FROM expense_categories WHERE ${conds.join(' AND ')}`, params);
  params.push(limit, offset);
  const l = await rows(`SELECT * FROM expense_categories WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 'id' : 'lower(name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ categories: l.map(categoryDto), count: count.c });
});

router.post('/categories', async (req, res) => {
  req.ctx.requireAdmin();
  const body = parse(categorySchema, req.body);
  const dup = await one('SELECT 1 FROM expense_categories WHERE workspace_id = $1 AND lower(name) = lower($2)', [req.workspace.id, body.name]);
  if (dup) throw badRequest('An expense category with this name already exists', 400);
  const c = await insert('expense_categories', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: body.name,
    has_unit_price: !!body.hasUnitPrice, unit: body.unit || null, price_in_cents: body.hasUnitPrice ? (body.priceInCents ?? 0) : 0,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_EXPENSE_CATEGORY', entityType: 'EXPENSE_CATEGORY', entityId: c.id, content: body });
  res.status(201).json(categoryDto(c));
});

router.put('/categories/:categoryId', async (req, res) => {
  req.ctx.requireAdmin();
  const prev = await loadCategory(req.workspace.id, req.params.categoryId);
  const body = parse(categorySchema.partial(), req.body);
  if (body.name && body.name.toLowerCase() !== prev.name.toLowerCase()) {
    const dup = await one('SELECT 1 FROM expense_categories WHERE workspace_id = $1 AND lower(name) = lower($2) AND id <> $3', [req.workspace.id, body.name, prev.id]);
    if (dup) throw badRequest('An expense category with this name already exists', 400);
  }
  const hasUnitPrice = body.hasUnitPrice ?? prev.has_unit_price;
  const c = await one(
    'UPDATE expense_categories SET name = COALESCE($2, name), has_unit_price = $3, unit = CASE WHEN $4::boolean THEN $5 ELSE unit END, price_in_cents = $6 WHERE id = $1 RETURNING *',
    [prev.id, body.name ?? null, hasUnitPrice, body.unit !== undefined, body.unit ?? null, hasUnitPrice ? (body.priceInCents ?? prev.price_in_cents) : 0],
  );
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_EXPENSE_CATEGORY', entityType: 'EXPENSE_CATEGORY', entityId: c.id, content: body, previous: categoryDto(prev) });
  res.json(categoryDto(c));
});

router.patch('/categories/:categoryId/status', async (req, res) => {
  req.ctx.requireAdmin();
  const prev = await loadCategory(req.workspace.id, req.params.categoryId);
  const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
  const c = await one('UPDATE expense_categories SET archived = $2 WHERE id = $1 RETURNING *', [prev.id, archived]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_EXPENSE_CATEGORY', entityType: 'EXPENSE_CATEGORY', entityId: c.id, content: { archived }, previous: categoryDto(prev) });
  res.json(categoryDto(c));
});

router.delete('/categories/:categoryId', async (req, res) => {
  req.ctx.requireAdmin();
  const c = await loadCategory(req.workspace.id, req.params.categoryId);
  const used = await one('SELECT 1 FROM expenses WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1', [c.id]);
  if (used) throw badRequest('Expense category is used by expenses; archive it instead', 400);
  await query('DELETE FROM expense_categories WHERE id = $1', [c.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_EXPENSE_CATEGORY', entityType: 'EXPENSE_CATEGORY', entityId: c.id, previous: categoryDto(c) });
  res.status(204).end();
});

// ---- Expenses ----------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const q = req.query;
  const visible = await visibleUserIds(req.ctx);
  const userIds = list(q['user-id'] || q.userId || q.users || q.user);
  if (visible && userIds.length && !userIds.every((u) => visible.includes(u))) throw forbidden("You can't see these users' expenses", 403);
  const out = await listExpenses(req.ctx, {
    userIds, visible, start: q.start, end: q.end, project: q.project, task: q.task, category: q.category, client: q.client, status: q.status,
    billable: q.billable === undefined || q.billable === '' ? undefined : bool(q.billable, false),
    invoiced: q.invoiced === undefined || q.invoiced === '' ? undefined : bool(q.invoiced, false),
    limit, offset,
  });
  res.json(out);
});

router.post('/', receipt, async (req, res) => {
  const b = coerceBody(req);
  const userId = b.userId || req.user.id;
  const e = await createExpense(req.ctx, userId, b, { file: req.file });
  res.status(201).json(expenseDto(e, { ctx: req.ctx }));
});

router.get('/:expenseId', async (req, res) => {
  const e = await loadExpense(req.workspace.id, req.params.expenseId);
  if (!(await canViewExpense(req.ctx, e))) throw notFound('Expense not found', 404);
  res.json(expenseDto(e, { ctx: req.ctx }));
});

// PUT applies only the fields listed in changeFields (UpdateExpenseV1Request); PATCH applies every field provided (UI).
async function putExpense(req, res) {
  const e = await loadExpense(req.workspace.id, req.params.expenseId);
  const b = coerceBody(req);
  let fields;
  if (req.method === 'PUT') {
    const listed = b.changeFields && b.changeFields.length ? b.changeFields : null;
    if (listed) fields = new Set(listed);
    else {
      fields = new Set(Object.keys(b).map((k) => ({ userId: 'USER', date: 'DATE', projectId: 'PROJECT', taskId: 'TASK', categoryId: 'CATEGORY', notes: 'NOTES', amount: 'AMOUNT', billable: 'BILLABLE', fileId: 'FILE' })[k]).filter(Boolean));
      if (req.file) fields.add('FILE');
    }
  }
  const updated = await updateExpense(req.ctx, e, b, { file: req.file, fields });
  res.json(expenseDto(updated, { ctx: req.ctx }));
}
router.put('/:expenseId', receipt, putExpense);
router.patch('/:expenseId', receipt, putExpense);

router.delete('/:expenseId', async (req, res) => {
  const e = await loadExpense(req.workspace.id, req.params.expenseId);
  const dto = await deleteExpense(req.ctx, e);
  res.status(200).json(dto);
});

// Receipt download
router.get('/:expenseId/files/:fileId', async (req, res) => {
  const e = await loadExpense(req.workspace.id, req.params.expenseId, { includeDeleted: true });
  if (!(await canViewExpense(req.ctx, e))) throw notFound('Expense not found', 404);
  if (!e.file_id || e.file_id !== req.params.fileId) throw notFound('File not found', 404);
  const f = await one('SELECT * FROM files WHERE id = $1', [e.file_id]);
  if (!f) throw notFound('File not found', 404);
  const disposition = bool(req.query.inline, false) ? 'inline' : 'attachment';
  res.set('Content-Type', f.mime_type);
  res.set('Content-Length', String(f.size));
  res.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(f.name)}"`);
  res.send(f.data);
});

export { expenseDto, expensesDto, loadExpense, assertCanEdit, storeReceipt, dateStr, normalizeDate, money, isExpenseLockedByDate };
export default {
  name: 'expenses',
  workspace(ws) { ws.use('/expenses', router); },
};
