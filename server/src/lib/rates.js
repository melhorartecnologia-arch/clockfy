import { one, rows, query } from './db.js';

// Resolves billable (hourly) and cost rates for a time entry, following Clockify's hierarchy:
//  billable: task rate > project member rate > project rate > workspace member rate > workspace rate
//  cost:     project member cost rate > project cost rate > workspace member cost rate > workspace cost rate
export async function resolveRates({ workspaceId, userId, projectId, taskId }) {
  const ws = await one('SELECT hourly_rate_amount, hourly_rate_currency, cost_rate_amount FROM workspaces WHERE id = $1', [workspaceId]);
  const currency = ws?.hourly_rate_currency || 'USD';
  const member = await one('SELECT hourly_rate_amount, cost_rate_amount FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  let project = null; let pm = null; let task = null;
  if (projectId) {
    project = await one('SELECT hourly_rate_amount, hourly_rate_currency, cost_rate_amount, billable FROM projects WHERE id = $1', [projectId]);
    pm = await one("SELECT hourly_rate_amount, cost_rate_amount FROM project_members WHERE project_id = $1 AND target_type = 'USER' AND target_id = $2", [projectId, userId]);
  }
  if (taskId) task = await one('SELECT hourly_rate_amount, cost_rate_amount, billable FROM tasks WHERE id = $1', [taskId]);
  const pick = (...vals) => { for (const v of vals) if (v != null) return Number(v); return 0; };
  const hourly = pick(task?.hourly_rate_amount, pm?.hourly_rate_amount, project?.hourly_rate_amount, member?.hourly_rate_amount, ws?.hourly_rate_amount);
  const cost = pick(task?.cost_rate_amount, pm?.cost_rate_amount, project?.cost_rate_amount, member?.cost_rate_amount, ws?.cost_rate_amount);
  return { hourlyRate: { amount: hourly, currency: project?.hourly_rate_currency || currency }, costRate: { amount: cost, currency }, project, task };
}

// Recalculates snapshot rates of time entries that match the scope, from `since` onwards.
export async function reapplyRates({ workspaceId, userId, projectId, taskId, since }) {
  const conds = ['workspace_id = $1', 'deleted_at IS NULL', 'locked = false'];
  const params = [workspaceId];
  if (userId) { params.push(userId); conds.push(`user_id = $${params.length}`); }
  if (projectId) { params.push(projectId); conds.push(`project_id = $${params.length}`); }
  if (taskId) { params.push(taskId); conds.push(`task_id = $${params.length}`); }
  if (since) { params.push(since); conds.push(`start_time >= $${params.length}`); }
  const entries = await rows(`SELECT id, user_id, project_id, task_id FROM time_entries WHERE ${conds.join(' AND ')}`, params);
  const cache = new Map();
  for (const e of entries) {
    const key = `${e.user_id}|${e.project_id}|${e.task_id}`;
    if (!cache.has(key)) cache.set(key, await resolveRates({ workspaceId, userId: e.user_id, projectId: e.project_id, taskId: e.task_id }));
    const r = cache.get(key);
    await query('UPDATE time_entries SET hourly_rate_amount = $2, hourly_rate_currency = $3, cost_rate_amount = $4 WHERE id = $1', [e.id, r.hourlyRate.amount, r.hourlyRate.currency, r.costRate.amount]);
  }
  return entries.length;
}

export async function recordRateHistory({ workspaceId, entityType, entityId, userId, rateType, amount, currency, since, createdBy }) {
  const { newId } = await import('./ids.js');
  await query(
    `INSERT INTO rate_history (id, workspace_id, entity_type, entity_id, user_id, rate_type, amount, currency, since, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId(), workspaceId, entityType, entityId, userId || null, rateType, amount, currency || null, since || null, createdBy || null],
  );
}
