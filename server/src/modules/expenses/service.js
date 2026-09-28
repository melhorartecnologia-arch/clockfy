import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { addDaysLocal, dayOfWeekLocal, weekdayIndex } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { canManageEntriesOf, lockDateOf } from '../timeEntries/service.js';
import { canAccessProject } from '../projects/service.js';

// ---- helpers -----------------------------------------------------------------

// DATE columns come back from pg as a Date at local midnight; normalize to YYYY-MM-DD.
export function dateStr(v) {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

// Accepts "YYYY-MM-DD" or an ISO date-time ("2020-01-01T00:00:00Z") and returns the calendar date.
export function normalizeDate(value, field = 'date') {
  if (value == null || value === '') throw badRequest(`${field} is required`, 400);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) throw badRequest(`Invalid ${field}: ${value}`, 400);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw badRequest(`Invalid ${field}: ${value}`, 400);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function isExpenseLockedByDate(expense, lockDate) {
  const d = dateStr(expense.date);
  return !!(lockDate && d && new Date(`${d}T00:00:00Z`) < lockDate);
}

export const money = (v) => Math.round(Number(v || 0) * 100) / 100;

// ---- categories ----------------------------------------------------------------

export function categoryDto(c) {
  return {
    id: c.id,
    name: c.name,
    workspaceId: c.workspace_id,
    hasUnitPrice: !!c.has_unit_price,
    unit: c.unit || '',
    priceInCents: Number(c.price_in_cents || 0),
    archived: !!c.archived,
  };
}

export async function loadCategory(workspaceId, id) {
  const c = await one('SELECT * FROM expense_categories WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!c) throw notFound('Expense category not found', 404);
  return c;
}

// ---- expenses ------------------------------------------------------------------

const BASE_SELECT = `
  SELECT e.*, to_char(e.date, 'YYYY-MM-DD') AS date_str,
         p.name AS project_name, p.color AS project_color, p.client_id AS client_id, c.name AS client_name,
         t.name AS task_name,
         cat.name AS category_name, cat.has_unit_price AS category_has_unit_price, cat.unit AS category_unit, cat.price_in_cents AS category_price_in_cents, cat.archived AS category_archived,
         f.name AS file_name, f.mime_type AS file_mime_type, f.size AS file_size,
         w.hourly_rate_currency AS currency
  FROM expenses e
  LEFT JOIN projects p ON p.id = e.project_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN tasks t ON t.id = e.task_id
  LEFT JOIN expense_categories cat ON cat.id = e.category_id
  LEFT JOIN files f ON f.id = e.file_id
  JOIN workspaces w ON w.id = e.workspace_id`;

export async function loadExpense(workspaceId, id, { includeDeleted = false } = {}) {
  const e = await one(`${BASE_SELECT} WHERE e.id = $1 AND e.workspace_id = $2 ${includeDeleted ? '' : 'AND e.deleted_at IS NULL'}`, [id, workspaceId]);
  if (!e) throw notFound('Expense not found', 404);
  return e;
}

// Maps a row (from BASE_SELECT) to the Clockify ExpenseDtoV1/ExpenseHydratedDtoV1 shape (superset of both).
export function expenseDto(e, { ctx, lockDate } = {}) {
  const ld = lockDate !== undefined ? lockDate : (ctx ? lockDateOf(ctx) : null);
  const locked = !!(e.locked || e.invoiced || e.approval_status === 'APPROVED' || e.approval_status === 'PENDING' || isExpenseLockedByDate(e, ld));
  const date = e.date_str || dateStr(e.date);
  return {
    id: e.id,
    workspaceId: e.workspace_id,
    userId: e.user_id,
    date,
    projectId: e.project_id || null,
    taskId: e.task_id || null,
    categoryId: e.category_id || null,
    project: e.project_id ? { id: e.project_id, name: e.project_name || '', color: e.project_color || null, clientId: e.client_id || '', clientName: e.client_name || '' } : null,
    task: e.task_id ? { id: e.task_id, name: e.task_name || '' } : null,
    category: e.category_id ? { id: e.category_id, name: e.category_name || '', workspaceId: e.workspace_id, hasUnitPrice: !!e.category_has_unit_price, unit: e.category_unit || '', priceInCents: Number(e.category_price_in_cents || 0), archived: !!e.category_archived } : null,
    notes: e.notes || '',
    quantity: Number(e.quantity || 0),
    total: money(e.total),
    currency: e.currency || null,
    billable: !!e.billable,
    fileId: e.file_id || null,
    fileName: e.file_id ? (e.file_name || null) : null,
    fileUrl: e.file_id ? `${config.appUrl}/api/v1/workspaces/${e.workspace_id}/expenses/${e.id}/files/${e.file_id}` : null,
    locked,
    isLocked: locked,
    invoiced: !!e.invoiced,
    invoiceId: e.invoice_id || null,
    approvalRequestId: e.approval_request_id || null,
    approvalStatus: e.approval_status || null,
    createdAt: e.created_at ? new Date(e.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
  };
}

export function expensesDto(list, opts = {}) {
  const lockDate = opts.ctx ? lockDateOf(opts.ctx) : null;
  return list.map((e) => expenseDto(e, { ...opts, lockDate }));
}

// Can the caller see this expense? Same rule as time entries (admin, own, managed user/project).
export async function canViewExpense(ctx, expense) {
  return canManageEntriesOf(ctx, expense.user_id, expense.project_id);
}

export async function assertCanEdit(ctx, expense) {
  if (!(await canManageEntriesOf(ctx, expense.user_id, expense.project_id))) throw forbidden("You can't edit this expense", 403);
  if (expense.approval_status === 'APPROVED' || expense.approval_status === 'PENDING') throw forbidden('Expense is part of an approval request. Withdraw it first.', 403);
  if ((expense.locked || expense.invoiced || isExpenseLockedByDate(expense, lockDateOf(ctx))) && !ctx.isAdmin) throw forbidden('Expense is locked', 403);
}

// Stores an uploaded receipt (multer memory file) in the files table.
export async function storeReceipt(ctx, file) {
  if (!file || !file.buffer) throw badRequest('file is required', 400);
  if (file.size > config.maxUploadBytes) throw badRequest(`File exceeds the maximum size of ${config.maxUploadBytes} bytes`, 400);
  return insert('files', { id: newId(), workspace_id: ctx.workspace.id, user_id: ctx.user.id, name: file.originalname || 'receipt', mime_type: file.mimetype || 'application/octet-stream', size: file.size, data: file.buffer });
}

// Validates and normalizes an input payload into DB columns. `fields` limits which inputs are considered.
export async function normalizeInput(ctx, userId, input, { existing, fields } = {}) {
  const ws = ctx.workspace;
  const has = (f) => (fields ? fields.has(f) : true);
  const member = await one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, userId]);
  if (!member) throw badRequest('User is not a member of this workspace', 400);
  if (member.status !== 'ACTIVE' && !ctx.isAdmin) throw badRequest('User is not active in this workspace', 400);

  const out = {};
  if (has('DATE') && input.date !== undefined) out.date = normalizeDate(input.date, 'date');
  const date = out.date ?? (existing ? dateStr(existing.date) : null);
  if (!date) throw badRequest('date is required', 400);
  const lockDate = lockDateOf(ctx);
  if (lockDate && new Date(`${date}T00:00:00Z`) < lockDate && !ctx.isAdmin) throw forbidden(`Expenses before ${lockDate.toISOString()} are locked`, 403);

  if (has('NOTES') && input.notes !== undefined) out.notes = input.notes == null ? null : String(input.notes).slice(0, 3000);

  // Project (required, not archived, accessible by the target user)
  let project = null;
  const projectId = has('PROJECT') && input.projectId !== undefined ? (input.projectId || null) : (existing ? existing.project_id : null);
  if (!projectId) throw badRequest('projectId is required', 400);
  if (has('PROJECT') && input.projectId !== undefined) out.project_id = projectId;
  project = await one('SELECT * FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, ws.id]);
  if (!project) throw badRequest('Project not found', 400);
  if (project.archived && (!existing || existing.project_id !== projectId)) throw badRequest('Project is archived', 400);
  if (!project.is_public && !ctx.isAdmin && (!existing || existing.project_id !== projectId || existing.user_id !== userId)) {
    const targetCtx = userId === ctx.user.id ? ctx : { ...ctx, user: { id: userId }, isAdmin: false, managedProjects: new Set() };
    if (!(await canAccessProject(targetCtx, projectId))) throw forbidden('User is not a member of this private project', 403);
  }

  // Task (optional, must belong to the project)
  const taskId = has('TASK') && input.taskId !== undefined ? (input.taskId || null) : (existing ? existing.task_id : null);
  if ((has('TASK') && input.taskId !== undefined) || out.project_id !== undefined) out.task_id = taskId;
  if (taskId) {
    const task = await one('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (!task || task.project_id !== projectId) throw badRequest('Task does not belong to the selected project', 400);
    if (task.status === 'DONE' && !ctx.isAdmin && (!existing || existing.task_id !== taskId)) throw badRequest('Task is marked as done', 400);
  } else if (out.project_id !== undefined) {
    out.task_id = null;
  }

  // Category (required)
  const categoryId = has('CATEGORY') && input.categoryId !== undefined ? (input.categoryId || null) : (existing ? existing.category_id : null);
  if (!categoryId) throw badRequest('categoryId is required', 400);
  const category = await one('SELECT * FROM expense_categories WHERE id = $1 AND workspace_id = $2', [categoryId, ws.id]);
  if (!category) throw badRequest('Expense category not found', 400);
  if (category.archived && (!existing || existing.category_id !== categoryId)) throw badRequest('Expense category is archived', 400);
  if (has('CATEGORY') && input.categoryId !== undefined) out.category_id = categoryId;

  // Amount: for unit-price categories `amount` is the quantity, otherwise it is the total.
  const amountGiven = has('AMOUNT') && input.amount !== undefined && input.amount !== null && input.amount !== '';
  if (amountGiven || out.category_id !== undefined || !existing) {
    let amount;
    if (amountGiven) {
      amount = Number(input.amount);
      if (Number.isNaN(amount) || amount < 0) throw badRequest('amount must be a non-negative number', 400);
    } else if (existing) {
      // category changed without a new amount: keep the previous "amount" semantics
      amount = existing.category_has_unit_price ? Number(existing.quantity) : Number(existing.total);
    } else {
      throw badRequest('amount is required', 400);
    }
    if (category.has_unit_price) {
      out.quantity = Math.round(amount * 1000) / 1000;
      out.total = money((out.quantity * Number(category.price_in_cents || 0)) / 100);
    } else {
      out.quantity = 1;
      out.total = money(amount);
    }
  }

  if (has('BILLABLE') && input.billable !== undefined) {
    if (ctx.settings.onlyAdminsCanChangeBillableStatus && !ctx.isAdmin && !!input.billable !== !!project.billable) throw forbidden('Only admins can change billable status', 403);
    out.billable = !!input.billable;
  } else if (!existing) {
    out.billable = !!project.billable;
  }
  return out;
}

async function resolveFileId(ctx, input, file) {
  if (file) return (await storeReceipt(ctx, file)).id;
  if (input.fileId) {
    const f = await one('SELECT id FROM files WHERE id = $1 AND (workspace_id = $2 OR user_id = $3)', [input.fileId, ctx.workspace.id, ctx.user.id]);
    if (!f) throw badRequest('File not found', 400);
    return f.id;
  }
  return null;
}

export async function createExpense(ctx, userId, input, { file } = {}) {
  if (!(await canManageEntriesOf(ctx, userId, input.projectId))) throw forbidden("You can't add expenses for this user", 403);
  const norm = await normalizeInput(ctx, userId, input);
  const fileId = await resolveFileId(ctx, input, file);
  const row = await transaction(async () => insert('expenses', {
    id: input.id && /^[a-f0-9]{24}$/.test(input.id) ? input.id : newId(), workspace_id: ctx.workspace.id, user_id: userId,
    project_id: norm.project_id, task_id: norm.task_id ?? null, category_id: norm.category_id, date: norm.date, notes: norm.notes ?? null,
    quantity: norm.quantity, total: norm.total, billable: !!norm.billable, file_id: fileId,
  }));
  const expense = await loadExpense(ctx.workspace.id, row.id);
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: userId === ctx.user.id ? 'CREATE_EXPENSE' : 'CREATE_EXPENSE_FOR_OTHER', entityType: 'EXPENSE', entityId: expense.id, content: { ...input, file: file ? file.originalname : undefined } });
  events.emitAsync('expense.created', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, expenseId: expense.id, userId });
  return expense;
}

// `fields` = Set of USER|DATE|PROJECT|TASK|CATEGORY|NOTES|AMOUNT|BILLABLE|FILE to apply (undefined = everything provided)
export async function updateExpense(ctx, expense, input, { file, fields } = {}) {
  await assertCanEdit(ctx, expense);
  const has = (f) => (fields ? fields.has(f) : true);
  let userId = expense.user_id;
  if (has('USER') && input.userId && input.userId !== expense.user_id) {
    userId = input.userId;
    const projectId = has('PROJECT') && input.projectId !== undefined ? input.projectId : expense.project_id;
    if (!(await canManageEntriesOf(ctx, userId, projectId))) throw forbidden("You can't move expenses to this user", 403);
  }
  const norm = await normalizeInput(ctx, userId, input, { existing: expense, fields });
  const data = { ...norm };
  if (userId !== expense.user_id) data.user_id = userId;
  if (has('FILE') && (file || input.fileId !== undefined || (fields && fields.has('FILE')))) {
    data.file_id = await resolveFileId(ctx, input, file);
  }
  data.updated_at = new Date();
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  await query(`UPDATE expenses SET ${sets} WHERE id = $1`, [expense.id, ...keys.map((k) => data[k])]);
  const updated = await loadExpense(ctx.workspace.id, expense.id);
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: updated.user_id === ctx.user.id ? 'UPDATE_EXPENSE' : 'UPDATE_EXPENSE_FOR_OTHER', entityType: 'EXPENSE', entityId: expense.id, content: { ...input, file: file ? file.originalname : undefined }, previous: expenseDto(expense, { ctx }) });
  events.emitAsync('expense.updated', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, expenseId: expense.id, userId: updated.user_id });
  return updated;
}

export async function deleteExpense(ctx, expense) {
  await assertCanEdit(ctx, expense);
  const dto = expenseDto(expense, { ctx });
  await query('UPDATE expenses SET deleted_at = now(), updated_at = now() WHERE id = $1', [expense.id]);
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: expense.user_id === ctx.user.id ? 'DELETE_EXPENSE' : 'DELETE_EXPENSE_FOR_OTHER', entityType: 'EXPENSE', entityId: expense.id, previous: dto });
  events.emitAsync('expense.deleted', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, expenseId: expense.id, userId: expense.user_id, expense: dto });
  return dto;
}

// Builds WHERE conditions for listing; `q` fields: userIds, visible, start, end, project, task, category, billable, status, invoiced
export function listConditions(workspaceId, q) {
  const conds = ['e.workspace_id = $1', 'e.deleted_at IS NULL']; const params = [workspaceId];
  if (q.userIds && q.userIds.length) { params.push(q.userIds); conds.push(`e.user_id = ANY($${params.length})`); }
  if (q.visible) { params.push(q.visible); conds.push(`e.user_id = ANY($${params.length})`); }
  if (q.start) { params.push(normalizeDate(q.start, 'start')); conds.push(`e.date >= $${params.length}::date`); }
  if (q.end) { params.push(normalizeDate(q.end, 'end')); conds.push(`e.date <= $${params.length}::date`); }
  if (q.project) { params.push(q.project); conds.push(`e.project_id = $${params.length}`); }
  if (q.task) { params.push(q.task); conds.push(`e.task_id = $${params.length}`); }
  if (q.category) { params.push(q.category); conds.push(`e.category_id = $${params.length}`); }
  if (q.client) { params.push(q.client); conds.push(`p.client_id = $${params.length}`); }
  if (q.billable !== undefined) { params.push(!!q.billable); conds.push(`e.billable = $${params.length}`); }
  if (q.invoiced !== undefined) { params.push(!!q.invoiced); conds.push(`e.invoiced = $${params.length}`); }
  if (q.status) {
    const s = String(q.status).toUpperCase();
    if (s === 'UNSUBMITTED' || s === 'NONE') conds.push("(e.approval_status IS NULL OR e.approval_status IN ('REJECTED','WITHDRAWN_SUBMISSION','WITHDRAWN_APPROVAL'))");
    else { params.push(s); conds.push(`e.approval_status = $${params.length}`); }
  }
  return { conds, params };
}

export async function listExpenses(ctx, q) {
  const { conds, params } = listConditions(ctx.workspace.id, q);
  const where = conds.join(' AND ');
  const count = await one(`SELECT count(*)::int AS c FROM expenses e LEFT JOIN projects p ON p.id = e.project_id WHERE ${where}`, params);
  const list = await rows(`${BASE_SELECT} WHERE ${where} ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit || 50, q.offset || 0]);
  const daily = await rows(`SELECT to_char(e.date, 'YYYY-MM-DD') AS date, SUM(e.total) AS total FROM expenses e LEFT JOIN projects p ON p.id = e.project_id WHERE ${where} GROUP BY e.date ORDER BY e.date DESC`, params);
  const weekStart = weekdayIndex(ctx.user?.settings?.weekStart || 'MONDAY');
  const weekly = new Map();
  for (const d of daily) {
    const diff = (dayOfWeekLocal(d.date) - weekStart + 7) % 7;
    const ws = addDaysLocal(d.date, -diff);
    weekly.set(ws, money((weekly.get(ws) || 0) + Number(d.total)));
  }
  return {
    expenses: { count: count.c, expenses: expensesDto(list, { ctx }) },
    dailyTotals: daily.map((d) => ({ date: d.date, dateAsInstant: `${d.date}T00:00:00Z`, total: money(d.total) })),
    weeklyTotals: [...weekly.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, total]) => ({ date, total })),
  };
}
