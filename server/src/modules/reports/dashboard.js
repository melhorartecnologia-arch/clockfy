// Dashboard data for the UI: totals, per-day / per-project breakdown, top activities and team activity.
import { Router } from 'express';
import { rows } from '../../lib/db.js';
import { forbidden } from '../../lib/errors.js';
import { resolveDateRange, toIso } from '../../lib/dates.js';
import { parseCommonFilter, parseReportDate, resolveTimeZone, resolveWeekStart, visibilityScope, loadEntries, localDate, rangeDays, round2 } from './filters.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/dashboard

router.get('/', async (req, res) => {
  const ctx = req.ctx;
  const timeZone = resolveTimeZone(ctx, req.query.timeZone);
  const weekStart = resolveWeekStart(ctx, req.query.weekStart);
  const selection = String(req.query.selection || ctx.user.settings?.dashboardSelection || 'ME').toUpperCase() === 'TEAM' ? 'TEAM' : 'ME';
  const type = String(req.query.type || ctx.user.settings?.dashboardViewType || 'PROJECT').toUpperCase() === 'BILLABILITY' ? 'BILLABILITY' : 'PROJECT';
  const now = new Date();
  let start; let end;
  if (req.query.start && req.query.end) {
    start = parseReportDate(req.query.start, timeZone, { field: 'start' });
    end = parseReportDate(req.query.end, timeZone, { endOfDay: true, field: 'end' });
  } else {
    [start, end] = resolveDateRange('THIS_WEEK', now, timeZone, weekStart);
    end = new Date(end.getTime() - 1);
  }
  const teamAllowed = ctx.isAdmin || !ctx.settings.onlyAdminsSeeDashboard || ctx.isTeamManager || ctx.isProjectManager;
  if (selection === 'TEAM' && !teamAllowed) throw forbidden('Only admins can see the team dashboard', 403);

  const f = parseCommonFilter(ctx, { dateRangeStart: start.toISOString(), dateRangeEnd: end.toISOString(), timeZone, weekStart, amounts: ['EARNED'] }, { now });
  const scope = selection === 'TEAM' ? await visibilityScope(ctx) : { userIds: [ctx.user.id], projectIds: null };
  const entries = await loadEntries(ctx, f, scope, { sortColumn: 'DATE', sortOrder: 'ASCENDING' });

  const sum = (list, fn) => list.reduce((s, e) => s + fn(e), 0);
  const isRegular = (e) => (e.type || 'REGULAR') === 'REGULAR';
  const totalTime = sum(entries, (e) => e.seconds);
  const billableTime = sum(entries, (e) => e.billableSeconds);
  const earned = round2(sum(entries, (e) => e.earned));

  const byDayMap = new Map();
  for (const e of entries) { const d = localDate(e, f); if (!byDayMap.has(d)) byDayMap.set(d, []); byDayMap.get(d).push(e); }
  const projectAgg = (list) => {
    const m = new Map();
    for (const e of list) {
      const key = e.project_id || '';
      if (!m.has(key)) m.set(key, { projectId: e.project_id || null, name: e.project_name || 'Without project', color: e.project_color || '#9E9E9E', clientName: e.client_name || '', duration: 0, amount: 0 });
      const p = m.get(key); p.duration += e.seconds; p.amount = round2(p.amount + e.earned);
    }
    return [...m.values()].sort((a, b) => b.duration - a.duration);
  };
  const byDay = rangeDays(f, 400).map((date) => {
    const list = byDayMap.get(date) || [];
    const item = { date, duration: sum(list, (e) => e.seconds), billable: sum(list, (e) => e.billableSeconds), nonBillable: sum(list, (e) => (isRegular(e) && e.billable ? 0 : e.seconds)) };
    if (type === 'PROJECT') item.projects = projectAgg(list).map((p) => ({ projectId: p.projectId, name: p.name, color: p.color, duration: p.duration }));
    return item;
  });

  const activities = new Map();
  for (const e of entries) {
    const key = `${e.description || ''}|${e.project_id || ''}`;
    if (!activities.has(key)) activities.set(key, { description: e.description || '', projectId: e.project_id || null, projectName: e.project_name || '', projectColor: e.project_color || null, duration: 0 });
    activities.get(key).duration += e.seconds;
  }
  const topActivities = [...activities.values()].sort((a, b) => b.duration - a.duration).slice(0, 10);

  const out = {
    start: toIso(start), end: toIso(end), timeZone, selection, type,
    totalTime, billableTime, nonBillableTime: totalTime - billableTime, earned, currency: ctx.workspace.hourly_rate_currency || 'USD',
    byDay, byProject: projectAgg(entries), topActivities, team: null,
  };

  if (selection === 'TEAM') {
    const params = [ctx.workspace.id];
    let cond = '';
    if (scope.userIds) { params.push(scope.userIds); cond = ' AND m.user_id = ANY($2)'; }
    const users = await rows(`SELECT u.id, u.name, u.profile_picture FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'${cond} ORDER BY lower(u.name)`, params);
    const ids = users.map((u) => u.id);
    const running = ids.length ? await rows('SELECT e.user_id, e.description, e.start_time, e.project_id, p.name AS project_name, p.color AS project_color FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id WHERE e.workspace_id = $1 AND e.user_id = ANY($2) AND e.end_time IS NULL AND e.deleted_at IS NULL', [ctx.workspace.id, ids]) : [];
    const last = ids.length ? await rows('SELECT user_id, MAX(COALESCE(end_time, now())) AS last FROM time_entries WHERE workspace_id = $1 AND user_id = ANY($2) AND deleted_at IS NULL GROUP BY user_id', [ctx.workspace.id, ids]) : [];
    const totals = new Map();
    for (const e of entries) totals.set(e.user_id, (totals.get(e.user_id) || 0) + e.seconds);
    out.team = users.map((u) => {
      const r = running.find((x) => x.user_id === u.id);
      return {
        userId: u.id, userName: u.name, imageUrl: u.profile_picture || '',
        running: r ? { description: r.description || '', projectId: r.project_id || null, projectName: r.project_name || '', projectColor: r.project_color || null, start: toIso(r.start_time) } : null,
        totalTime: totals.get(u.id) || 0,
        lastActivity: toIso(last.find((x) => x.user_id === u.id)?.last || null),
      };
    });
  }
  res.json(out);
});

export default router;
