// Detailed expense report (Clockify Expense Report API) reading the `expenses` table.
import { rows } from '../../lib/db.js';
import { parse, z } from '../../lib/validate.js';
import { parseCommonFilter, visibilityScope, round2, CONTAINS } from './filters.js';

const containsFilter = z.object({ ids: z.array(z.string()).nullable().optional(), contains: z.enum(CONTAINS).optional(), status: z.string().optional() }).passthrough();
const expenseSchema = z.object({
  categories: containsFilter.optional(),
  note: z.string().nullable().optional(),
  withoutNote: z.boolean().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(5000).optional(),
  sortColumn: z.enum(['ID', 'PROJECT', 'USER', 'CATEGORY', 'DATE', 'AMOUNT']).optional(),
}).passthrough();

const SORT = { ID: ['x.id'], PROJECT: ['lower(p.name)', 'x.date'], USER: ['lower(u.name)', 'x.date'], CATEGORY: ['lower(cat.name)', 'x.date'], DATE: ['x.date', 'x.created_at'], AMOUNT: ['x.total', 'x.date'] };

// DATE columns come back from pg as a local-time Date; rebuild the calendar date without any zone shift
function dateOnlyIso(d) {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00Z`;
  return `${String(d).slice(0, 10)}T00:00:00Z`;
}

function containsClause(conds, params, f, expr) {
  const ids = (f?.ids || []).filter(Boolean);
  if (!ids.length) return;
  params.push(ids);
  conds.push((f.contains || 'CONTAINS') === 'DOES_NOT_CONTAIN' ? `NOT COALESCE(${expr} = ANY($${params.length}), false)` : `${expr} = ANY($${params.length})`);
}

export function expenseDto(x, ctx) {
  return {
    id: x.id,
    workspaceId: x.workspace_id,
    userId: x.user_id,
    userName: x.user_name || '',
    userEmail: x.user_email || '',
    userStatus: x.user_status || 'ACTIVE',
    projectId: x.project_id || null,
    projectName: x.project_name || '',
    projectColor: x.project_color || null,
    clientId: x.client_id || null,
    clientName: x.client_name || '',
    taskId: x.task_id || null,
    taskName: x.task_name || '',
    categoryId: x.category_id || null,
    categoryName: x.category_name || '',
    categoryHasUnitPrice: !!x.category_has_unit_price,
    categoryUnit: x.category_unit || null,
    date: dateOnlyIso(x.date),
    time: null,
    notes: x.notes || '',
    quantity: Number(x.quantity) || 0,
    amount: round2(x.total),
    currency: ctx.workspace.hourly_rate_currency || 'USD',
    billable: !!x.billable,
    fileId: x.file_id || null,
    fileName: x.file_name || null,
    locked: !!x.locked,
    approvalRequestId: x.approval_request_id || null,
    approvalStatus: x.approval_status || null,
    invoicingInfo: x.invoiced || x.invoice_id ? { invoiceId: x.invoice_id || null, manuallyInvoiced: !!x.invoiced && !x.invoice_id } : null,
    reportName: x.notes || x.category_name || '',
  };
}

export async function expenseReport(ctx, body, { now, forExport = false } = {}) {
  const b = parse(expenseSchema, body || {});
  const f = parseCommonFilter(ctx, body, { now });
  const scope = await visibilityScope(ctx);
  const conds = ['x.workspace_id = $1', 'x.deleted_at IS NULL'];
  const params = [ctx.workspace.id];
  // expenses are dated (no time): compare local dates of the range
  params.push(f.timeZone);
  const tz = `$${params.length}::text`;
  params.push(f.start); conds.push(`x.date >= ($${params.length}::timestamptz AT TIME ZONE ${tz})::date`);
  params.push(f.end); conds.push(`x.date <= ($${params.length}::timestamptz AT TIME ZONE ${tz})::date`);
  if (scope.userIds) { params.push(scope.userIds); conds.push(`x.user_id = ANY($${params.length})`); }
  if (scope.projectIds) { params.push(ctx.user.id, scope.projectIds); conds.push(`(x.user_id = $${params.length - 1} OR x.project_id = ANY($${params.length}))`); }
  containsClause(conds, params, f.users, 'x.user_id');
  containsClause(conds, params, f.projects, 'x.project_id');
  containsClause(conds, params, f.clients, 'p.client_id');
  containsClause(conds, params, f.tasks, 'x.task_id');
  containsClause(conds, params, b.categories, 'x.category_id');
  if (f.userGroups?.ids?.length) {
    params.push(f.userGroups.ids);
    const sub = `EXISTS (SELECT 1 FROM user_group_members gm WHERE gm.user_id = x.user_id AND gm.group_id = ANY($${params.length}))`;
    conds.push((f.userGroups.contains || 'CONTAINS') === 'DOES_NOT_CONTAIN' ? `NOT ${sub}` : sub);
  }
  const projectStatus = String(f.projects?.status || 'ALL').toUpperCase();
  if (projectStatus === 'ACTIVE') conds.push('(p.id IS NULL OR p.archived = false)');
  if (projectStatus === 'ARCHIVED') conds.push('p.archived = true');
  const categoryStatus = String(b.categories?.status || 'ALL').toUpperCase();
  if (categoryStatus === 'ACTIVE') conds.push('(cat.id IS NULL OR cat.archived = false)');
  if (categoryStatus === 'ARCHIVED') conds.push('cat.archived = true');
  if (f.billable === true || f.billable === false) { params.push(f.billable); conds.push(`x.billable = $${params.length}`); }
  if (b.withoutNote) conds.push("COALESCE(x.notes, '') = ''");
  else if (b.note) { params.push(`%${String(b.note).toLowerCase()}%`); conds.push(`lower(COALESCE(x.notes, '')) LIKE $${params.length}`); }
  if (f.invoicingState === 'INVOICED') conds.push('x.invoiced = true');
  if (f.invoicingState === 'UNINVOICED') conds.push('x.invoiced = false');
  if (f.approvalState === 'APPROVED') conds.push("x.approval_status = 'APPROVED'");
  if (f.approvalState === 'UNAPPROVED') conds.push("(x.approval_status IS NULL OR x.approval_status <> 'APPROVED')");

  const from = `FROM expenses x JOIN users u ON u.id = x.user_id LEFT JOIN projects p ON p.id = x.project_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN tasks t ON t.id = x.task_id LEFT JOIN expense_categories cat ON cat.id = x.category_id LEFT JOIN files fl ON fl.id = x.file_id`;
  const where = conds.join(' AND ');
  const totals = (await rows(`SELECT count(*)::int AS c, COALESCE(SUM(x.total), 0) AS total, COALESCE(SUM(CASE WHEN x.billable THEN x.total ELSE 0 END), 0) AS billable ${from} WHERE ${where}`, params))[0];
  const dir = (f.sortOrder || 'DESCENDING') === 'DESCENDING' ? 'DESC' : 'ASC';
  const order = (SORT[b.sortColumn] || SORT.DATE).map((c) => `${c} ${dir}`).join(', ');
  const page = b.page || 1;
  const pageSize = forExport ? null : Math.min(b.pageSize || 50, 5000);
  let sql = `SELECT x.*, u.name AS user_name, u.email AS user_email, u.status AS user_status, p.name AS project_name, p.color AS project_color, p.client_id AS client_id, c.name AS client_name, t.name AS task_name,
      cat.name AS category_name, cat.has_unit_price AS category_has_unit_price, cat.unit AS category_unit, fl.name AS file_name ${from} WHERE ${where} ORDER BY ${order}`;
  if (pageSize) { params.push(pageSize, (page - 1) * pageSize); sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`; }
  const list = await rows(sql, params);
  const expenses = list.map((x) => expenseDto(x, ctx));
  return {
    result: { expenses, totals: { expensesCount: totals.c, totalAmount: round2(totals.total), totalAmountBillable: round2(totals.billable) }, page, pageSize: pageSize || expenses.length },
    filter: f, expenses,
  };
}
