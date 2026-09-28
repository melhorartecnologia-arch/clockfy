// Runs a report by type and turns it into an export table. Used by the HTTP routes, shared reports and scheduled reports.
import { one, rows } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { buildContext } from '../../middleware/workspace.js';
import { summaryReport, detailedReport, weeklyReport } from './timeEntryReports.js';
import { attendanceReport } from './attendance.js';
import { expenseReport } from './expenses.js';
import { summaryTable, detailedTable, weeklyTable, attendanceTable, expensesTable } from './export.js';

export const REPORT_TYPES = {
  SUMMARY: { run: summaryReport, table: summaryTable },
  DETAILED: { run: detailedReport, table: detailedTable },
  WEEKLY: { run: weeklyReport, table: weeklyTable },
  ATTENDANCE: { run: attendanceReport, table: attendanceTable },
  EXPENSE_DETAILED: { run: expenseReport, table: expensesTable },
};

export function normalizeType(type) {
  const t = String(type || 'SUMMARY').toUpperCase();
  if (t === 'EXPENSE' || t === 'EXPENSES') return 'EXPENSE_DETAILED';
  if (!REPORT_TYPES[t]) throw badRequest(`Unsupported report type: ${type}`, 400);
  return t;
}

// Executes the report and returns {result, table} where table() lazily builds the export table
export async function runReport(ctx, type, body, opts = {}) {
  const t = normalizeType(type);
  const def = REPORT_TYPES[t];
  const out = await def.run(ctx, body, opts);
  return { type: t, result: out.result, filter: out.filter, table: () => def.table(out, ctx) };
}

// Builds a request-like context for `userId` in the workspace (reports run with their author's permissions)
export async function contextForUser(workspaceId, userId) {
  const workspace = await one('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) throw notFound('Workspace not found', 404);
  const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('User not found', 404);
  const member = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  const roleRows = await rows('SELECT role, entity_id, source_type FROM roles WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  return buildContext({ workspace, user, member, roleRows });
}
