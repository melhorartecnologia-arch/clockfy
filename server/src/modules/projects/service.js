import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { projectDto, taskDto, clientDto } from '../../lib/dto.js';
import { secondsToIso, isoToSeconds } from '../../lib/duration.js';
import { notFound } from '../../lib/errors.js';
import { fieldDto } from '../customFields/index.js';

export async function getProjectRow(workspaceId, id) {
  const p = await one('SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1 AND p.workspace_id = $2', [id, workspaceId]);
  if (!p) throw notFound('Project not found', 404);
  return p;
}

export async function projectDurations(projectIds) {
  if (!projectIds.length) return new Map();
  const r = await rows(
    `SELECT project_id, SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)))::bigint AS secs FROM time_entries WHERE project_id = ANY($1) AND deleted_at IS NULL AND type = 'REGULAR' GROUP BY project_id`,
    [projectIds],
  );
  return new Map(r.map((x) => [x.project_id, Number(x.secs)]));
}

export async function taskListDto(workspaceId, projectId, { status } = {}) {
  const conds = ['t.project_id = $1']; const params = [projectId];
  if (status && status !== 'ALL') { params.push(status); conds.push(`t.status = $${params.length}`); }
  const tasks = await rows(`SELECT t.*, (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)))::bigint FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL) AS duration_seconds FROM tasks t WHERE ${conds.join(' AND ')} ORDER BY t.created_at`, params);
  const ids = tasks.map((t) => t.id);
  const assignees = ids.length ? await rows('SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)', [ids]) : [];
  const groups = ids.length ? await rows('SELECT task_id, group_id FROM task_user_groups WHERE task_id = ANY($1)', [ids]) : [];
  return tasks.map((t) => taskDto(t, {
    assigneeIds: assignees.filter((a) => a.task_id === t.id).map((a) => a.user_id),
    userGroupIds: groups.filter((g) => g.task_id === t.id).map((g) => g.group_id),
  }));
}

export async function projectMemberships(projectId) {
  return rows('SELECT * FROM project_members WHERE project_id = $1 ORDER BY created_at', [projectId]);
}

export async function getProjectDto(workspaceId, id, { hydrated = false, userId, currency } = {}) {
  const p = await getProjectRow(workspaceId, id);
  const memberships = await projectMemberships(id);
  const durations = await projectDurations([id]);
  const extra = { memberships, durationSeconds: durations.get(id) || 0, currency };
  if (userId) {
    const fav = await one('SELECT 1 FROM project_favorites WHERE user_id = $1 AND project_id = $2', [userId, id]);
    p.favorite = !!fav;
  }
  if (hydrated) {
    extra.tasks = await taskListDto(workspaceId, id, { status: 'ALL' });
    if (p.client_id) {
      const c = await one('SELECT c.*, cur.code AS currency_code FROM clients c LEFT JOIN workspace_currencies cur ON cur.id = c.currency_id WHERE c.id = $1', [p.client_id]);
      extra.client = c ? clientDto(c) : null;
    }
    const cfs = await rows('SELECT f.*, d.value AS project_value, d.status AS project_status FROM custom_fields f LEFT JOIN custom_field_project_defaults d ON d.custom_field_id = f.id AND d.project_id = $2 WHERE f.workspace_id = $1 ORDER BY f.created_at', [workspaceId, id]);
    extra.customFields = await Promise.all(cfs.map(fieldDto));
  }
  return projectDto(p, extra);
}

// Whether the user can see/track time on the project (public, member, group member or manager)
export async function canAccessProject(ctx, projectId) {
  if (ctx.isAdmin || ctx.managedProjects.has(projectId)) return true;
  const p = await one('SELECT is_public FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, ctx.workspace.id]);
  if (!p) return false;
  if (p.is_public) return true;
  const m = await one(
    `SELECT 1 FROM project_members pm WHERE pm.project_id = $1 AND ((pm.target_type = 'USER' AND pm.target_id = $2) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = $2)))`,
    [projectId, ctx.user.id],
  );
  return !!m;
}

export async function setProjectMembers(projectId, { userIds = [], groupIds = [], remove = false, replace = false }) {
  return transaction(async () => {
    if (replace) await query('DELETE FROM project_members WHERE project_id = $1', [projectId]);
    for (const uid of userIds) {
      if (remove) await query("DELETE FROM project_members WHERE project_id = $1 AND target_type = 'USER' AND target_id = $2", [projectId, uid]);
      else await query("INSERT INTO project_members (project_id, target_type, target_id) VALUES ($1,'USER',$2) ON CONFLICT DO NOTHING", [projectId, uid]);
    }
    for (const gid of groupIds) {
      if (remove) await query("DELETE FROM project_members WHERE project_id = $1 AND target_type = 'USERGROUP' AND target_id = $2", [projectId, gid]);
      else await query("INSERT INTO project_members (project_id, target_type, target_id) VALUES ($1,'USERGROUP',$2) ON CONFLICT DO NOTHING", [projectId, gid]);
    }
  });
}

export function normalizeTimeEstimate(input, current = {}) {
  if (!input) return current;
  const out = { ...current };
  if (input.estimate !== undefined) out.estimate = typeof input.estimate === 'number' ? secondsToIso(input.estimate) : (input.estimate ? secondsToIso(isoToSeconds(input.estimate)) : 'PT0S');
  if (input.type) out.type = input.type;
  if (input.active !== undefined) out.active = !!input.active;
  if (input.includeNonBillable !== undefined) out.includeNonBillable = !!input.includeNonBillable;
  if (input.resetOption !== undefined) out.resetOption = input.resetOption || null;
  return out;
}

export function normalizeBudgetEstimate(input, current = {}) {
  if (!input) return current;
  const out = { ...current };
  if (input.estimate !== undefined) out.estimate = Number(input.estimate) || 0;
  if (input.type) out.type = input.type;
  if (input.active !== undefined) out.active = !!input.active;
  if (input.includeExpenses !== undefined) out.includeExpenses = !!input.includeExpenses;
  if (input.resetOption !== undefined) out.resetOption = input.resetOption || null;
  return out;
}

export async function createTask(workspaceId, projectId, t) {
  return transaction(async () => {
    const task = await insert('tasks', {
      id: t.id && /^[a-f0-9]{24}$/.test(t.id) ? t.id : newId(), workspace_id: workspaceId, project_id: projectId, name: t.name, status: t.status && t.status !== 'ALL' ? t.status : 'ACTIVE',
      estimate_seconds: t.estimate != null ? isoToSeconds(t.estimate) : null, budget_estimate: t.budgetEstimate ?? null, billable: t.billable ?? null,
      hourly_rate_amount: t.hourlyRate?.amount ?? null, hourly_rate_currency: t.hourlyRate?.currency ?? null, cost_rate_amount: t.costRate?.amount ?? null,
    });
    const assignees = t.assigneeIds || (t.assigneeId ? [t.assigneeId] : []);
    for (const uid of assignees) await query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, uid]);
    for (const gid of t.userGroupIds || []) await query('INSERT INTO task_user_groups (task_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, gid]);
    return task;
  });
}

// Project progress (tracked vs estimate) used by alerts and project status page
export async function projectStatus(workspaceId, projectId) {
  const p = await getProjectRow(workspaceId, projectId);
  const te = p.time_estimate || {}; const be = p.budget_estimate || {};
  const agg = await one(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))),0)::bigint AS total,
            COALESCE(SUM(CASE WHEN billable THEN EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)) ELSE 0 END),0)::bigint AS billable,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)) / 3600.0 * COALESCE(hourly_rate_amount,0)),0)::bigint AS earned,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)) / 3600.0 * COALESCE(cost_rate_amount,0)),0)::bigint AS cost
     FROM time_entries WHERE project_id = $1 AND deleted_at IS NULL AND type = 'REGULAR'`, [projectId]);
  const expenses = await one('SELECT COALESCE(SUM(total),0) AS total FROM expenses WHERE project_id = $1 AND deleted_at IS NULL', [projectId]);
  let estimateSeconds = te.type === 'MANUAL' ? isoToSeconds(te.estimate || 'PT0S') : null;
  if (te.type === 'AUTO') {
    const s = await one('SELECT COALESCE(SUM(estimate_seconds),0)::bigint AS s FROM tasks WHERE project_id = $1', [projectId]);
    estimateSeconds = Number(s.s);
  }
  const tracked = te.includeNonBillable === false ? Number(agg.billable) : Number(agg.total);
  const budgetEstimate = Number(be.estimate || 0);
  const budgetUsed = Number(agg.earned) + (be.includeExpenses ? Math.round(Number(expenses.total) * 100) : 0);
  return {
    projectId, trackedSeconds: Number(agg.total), billableSeconds: Number(agg.billable), earned: Number(agg.earned), cost: Number(agg.cost),
    timeEstimate: { active: !!te.active, type: te.type || 'AUTO', estimateSeconds, trackedSeconds: tracked, remainingSeconds: estimateSeconds != null ? estimateSeconds - tracked : null, percent: estimateSeconds ? Math.round((tracked / estimateSeconds) * 100) : null },
    budgetEstimate: { active: !!be.active, type: be.type || 'AUTO', estimate: budgetEstimate, used: budgetUsed, remaining: budgetEstimate ? budgetEstimate - budgetUsed : null, percent: budgetEstimate ? Math.round((budgetUsed / budgetEstimate) * 100) : null },
    expensesTotal: Number(expenses.total),
  };
}
