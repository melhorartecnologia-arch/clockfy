// Scheduled reports: saved reports e-mailed periodically (daily / weekly / monthly) as PDF, CSV or XLSX attachments.
import { Router } from 'express';
import { one, rows, insert, query } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, paging } from '../../lib/validate.js';
import { forbidden, notFound, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { toIso, zonedParts, zonedTime, localDateString, dayOfWeekLocal, WEEKDAY_NAMES, isValidTimeZone } from '../../lib/dates.js';
import { runReport, contextForUser, normalizeType } from './run.js';
import { renderTable, exportFileName } from './export.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/scheduled-reports

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];
const EXPORTS = ['PDF', 'CSV', 'XLSX'];

const schema = z.object({
  name: z.string().min(1).max(250),
  type: z.string().optional(),
  filter: z.object({}).passthrough().optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  dayOfWeek: z.enum(WEEKDAY_NAMES).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  recipients: z.array(z.string().email()).optional(),
  exportType: z.enum(EXPORTS).optional(),
  enabled: z.boolean().optional(),
}).passthrough();

export function scheduledReportDto(r) {
  return {
    id: r.id, workspaceId: r.workspace_id, userId: r.user_id, name: r.name, type: r.type, filter: r.filter || {},
    frequency: r.frequency, dayOfWeek: r.day_of_week || null, dayOfMonth: r.day_of_month ?? null, hour: r.hour,
    recipients: r.recipients || [], exportType: r.export_type, enabled: !!r.enabled, lastSentAt: toIso(r.last_sent_at), createdAt: toIso(r.created_at),
  };
}

async function getReport(workspaceId, id) {
  const r = await one('SELECT * FROM scheduled_reports WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!r) throw notFound('Scheduled report not found', 404);
  return r;
}

function assertOwner(ctx, r) {
  if (!ctx.isAdmin && r.user_id !== ctx.user.id) throw forbidden('Only the report author or an admin can change this scheduled report', 403);
}

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 1000 });
  const conds = ['workspace_id = $1']; const params = [req.workspace.id];
  if (!req.ctx.isAdmin) { params.push(req.user.id); conds.push(`user_id = $${params.length}`); }
  params.push(limit, offset);
  const list = await rows(`SELECT * FROM scheduled_reports WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(list.map(scheduledReportDto));
});

router.get('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  res.json(scheduledReportDto(r));
});

router.post('/', async (req, res) => {
  const b = parse(schema, req.body);
  const type = normalizeType(b.type || 'SUMMARY');
  const frequency = b.frequency || 'WEEKLY';
  const r = await insert('scheduled_reports', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, user_id: req.user.id, name: b.name, type, filter: b.filter || {},
    frequency, day_of_week: frequency === 'WEEKLY' ? b.dayOfWeek || 'MONDAY' : b.dayOfWeek || null, day_of_month: frequency === 'MONTHLY' ? b.dayOfMonth || 1 : b.dayOfMonth ?? null,
    hour: b.hour ?? 8, recipients: b.recipients?.length ? b.recipients : [req.user.email], export_type: b.exportType || 'PDF', enabled: b.enabled !== false,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_SCHEDULED_REPORT', entityType: 'SCHEDULED_REPORT', entityId: r.id, content: b });
  res.status(201).json(scheduledReportDto(r));
});

router.put('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  const b = parse(schema.partial(), req.body);
  const type = b.type ? normalizeType(b.type) : null;
  const updated = await one(
    `UPDATE scheduled_reports SET name = COALESCE($2, name), type = COALESCE($3, type), filter = COALESCE($4::jsonb, filter), frequency = COALESCE($5, frequency),
       day_of_week = CASE WHEN $6::boolean THEN $7 ELSE day_of_week END, day_of_month = CASE WHEN $8::boolean THEN $9 ELSE day_of_month END, hour = COALESCE($10, hour),
       recipients = COALESCE($11::jsonb, recipients), export_type = COALESCE($12, export_type), enabled = COALESCE($13, enabled) WHERE id = $1 RETURNING *`,
    [r.id, b.name ?? null, type, b.filter ? JSON.stringify(b.filter) : null, b.frequency ?? null, b.dayOfWeek !== undefined, b.dayOfWeek ?? null, b.dayOfMonth !== undefined, b.dayOfMonth ?? null,
      b.hour ?? null, b.recipients ? JSON.stringify(b.recipients) : null, b.exportType ?? null, b.enabled ?? null],
  );
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_SCHEDULED_REPORT', entityType: 'SCHEDULED_REPORT', entityId: r.id, content: b, previous: scheduledReportDto(r) });
  res.json(scheduledReportDto(updated));
});

router.delete('/:id', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  await query('DELETE FROM scheduled_reports WHERE id = $1', [r.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_SCHEDULED_REPORT', entityType: 'SCHEDULED_REPORT', entityId: r.id, previous: scheduledReportDto(r) });
  res.status(204).end();
});

// Sends the report right away (UI convenience)
router.post('/:id/send', async (req, res) => {
  const r = await getReport(req.workspace.id, req.params.id);
  assertOwner(req.ctx, r);
  const sent = await deliverScheduledReport(r);
  res.json({ sent: true, ...sent });
});

// ---- delivery ------------------------------------------------------------------
const DEFAULT_RANGE = { DAILY: 'YESTERDAY', WEEKLY: 'LAST_WEEK', MONTHLY: 'LAST_MONTH' };

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

// Whether the report should be sent now (in the author's time zone), considering the last delivery.
export function isDue(r, now, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const p = zonedParts(now, tz);
  const scheduled = zonedTime(tz, p.year, p.month, p.day, r.hour ?? 8);
  if (now < scheduled) return false;
  if (r.last_sent_at && new Date(r.last_sent_at) >= scheduled) return false;
  if (r.created_at && new Date(r.created_at) > scheduled) return false;
  const today = localDateString(now, tz);
  if (r.frequency === 'WEEKLY') return WEEKDAY_NAMES[dayOfWeekLocal(today)] === String(r.day_of_week || 'MONDAY').toUpperCase();
  if (r.frequency === 'MONTHLY') return p.day === Math.min(r.day_of_month || 1, daysInMonth(p.year, p.month));
  return true;
}

export async function deliverScheduledReport(r, { now = new Date() } = {}) {
  const ctx = await contextForUser(r.workspace_id, r.user_id);
  if (!ctx.member) throw badRequest('The author of this scheduled report is no longer a member of the workspace', 400);
  const body = { ...(r.filter || {}) };
  if (!body.dateRangeType && !(body.dateRangeStart && body.dateRangeEnd)) body.dateRangeType = DEFAULT_RANGE[r.frequency] || 'LAST_WEEK';
  if (body.dateRangeType && body.dateRangeType !== 'ABSOLUTE') { delete body.dateRangeStart; delete body.dateRangeEnd; }
  body.exportType = r.export_type || 'PDF';
  const out = await runReport(ctx, r.type, body, { now, forExport: true });
  const table = out.table();
  const { buffer, mime, ext } = await renderTable(table, body.exportType);
  const filename = exportFileName(table.title, out.filter, ext);
  const recipients = (r.recipients || []).length ? r.recipients : [ctx.user.email];
  await sendMail({
    to: recipients.join(', '),
    subject: `[Clockfy] ${r.name} – ${table.subtitle}`,
    text: `Hello,\n\nPlease find attached the scheduled report "${r.name}" (${table.title}, ${table.subtitle}) from workspace ${ctx.workspace.name}.\n\n— Clockfy`,
    attachments: [{ filename, content: buffer, contentType: mime }],
  });
  await query('UPDATE scheduled_reports SET last_sent_at = $2 WHERE id = $1', [r.id, now]);
  return { filename, recipients, sentAt: toIso(now) };
}

// Scheduler job: runs hourly and delivers every enabled report whose time has come in its author's time zone.
export async function runScheduledReports(now = new Date()) {
  const list = await rows('SELECT r.*, u.settings AS author_settings FROM scheduled_reports r JOIN users u ON u.id = r.user_id WHERE r.enabled = true');
  let sent = 0;
  for (const r of list) {
    if (!isDue(r, now, r.author_settings?.timeZone)) continue;
    try { await deliverScheduledReport(r, { now }); sent += 1; } catch (err) { console.error(`[scheduled-reports] ${r.id} failed:`, err.message); }
  }
  return sent;
}

export default router;
