import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { timeEntryDto, projectDto, taskDto, tagDto, userDto, customFieldValueDto } from '../../lib/dto.js';
import { resolveRates } from '../../lib/rates.js';
import { parseDate } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { normalizeValue } from '../customFields/index.js';
import { canAccessProject } from '../projects/service.js';
import { userGroupIds } from '../../middleware/workspace.js';

export async function loadEntry(workspaceId, id, { includeDeleted = false } = {}) {
  const e = await one(`SELECT * FROM time_entries WHERE id = $1 AND workspace_id = $2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`, [id, workspaceId]);
  if (!e) throw notFound('Time entry not found', 404);
  return e;
}

export function lockDateOf(ctx) {
  const d = ctx?.settings?.lockTimeEntries;
  return d ? new Date(d) : null;
}

export function isLockedByDate(entry, lockDate) {
  return !!(lockDate && new Date(entry.start_time) < lockDate);
}

// Batch-hydrates DTOs for a list of entry rows
export async function entriesDto(list, { hydrated = false, ctx, showRates } = {}) {
  if (!list.length) return [];
  const ids = list.map((e) => e.id);
  const tagRows = await rows('SELECT time_entry_id, tag_id FROM time_entry_tags WHERE time_entry_id = ANY($1)', [ids]);
  const cfRows = await rows("SELECT v.entity_id, v.custom_field_id, v.value, v.source_type, f.name, f.type FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'TIMEENTRY' AND v.entity_id = ANY($1)", [ids]);
  const lockDate = ctx ? lockDateOf(ctx) : null;
  let projects = new Map(); let tasks = new Map(); let tags = new Map(); let users = new Map();
  if (hydrated) {
    const pids = [...new Set(list.map((e) => e.project_id).filter(Boolean))];
    const tids = [...new Set(list.map((e) => e.task_id).filter(Boolean))];
    const uids = [...new Set(list.map((e) => e.user_id))];
    const tagIds = [...new Set(tagRows.map((t) => t.tag_id))];
    if (pids.length) projects = new Map((await rows('SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ANY($1)', [pids])).map((p) => [p.id, projectDto(p)]));
    if (tids.length) tasks = new Map((await rows('SELECT * FROM tasks WHERE id = ANY($1)', [tids])).map((t) => [t.id, taskDto(t)]));
    if (uids.length) users = new Map((await rows('SELECT * FROM users WHERE id = ANY($1)', [uids])).map((u) => [u.id, userDto(u, { includeSettings: false })]));
    if (tagIds.length) tags = new Map((await rows('SELECT * FROM tags WHERE id = ANY($1)', [tagIds])).map((t) => [t.id, tagDto(t)]));
  }
  const rates = showRates ?? (ctx ? (ctx.isAdmin || !ctx.settings.onlyAdminsSeeBillableRates) : true);
  return list.map((e) => {
    const tagIds = tagRows.filter((t) => t.time_entry_id === e.id).map((t) => t.tag_id);
    const cfs = cfRows.filter((c) => c.entity_id === e.id).map(customFieldValueDto);
    const row = { ...e, locked: e.locked || isLockedByDate(e, lockDate) || e.approval_status === 'APPROVED' || e.approval_status === 'PENDING' || e.invoiced };
    const showThisRate = rates || (ctx && e.user_id === ctx.user.id && !ctx.settings.onlyAdminsSeeBillableRates);
    return timeEntryDto(row, {
      tagIds, customFieldValues: cfs, showRates: showThisRate,
      hydrated: hydrated ? { project: e.project_id ? projects.get(e.project_id) || null : null, task: e.task_id ? tasks.get(e.task_id) || null : null, tags: tagIds.map((id) => tags.get(id)).filter(Boolean), user: users.get(e.user_id) || null } : null,
    });
  });
}

export async function entryDto(e, opts = {}) {
  const [dto] = await entriesDto([e], opts);
  return dto;
}

// Permission: can `ctx.user` edit entries of `userId`?
export async function canManageEntriesOf(ctx, userId, projectId) {
  if (ctx.isAdmin || userId === ctx.user.id) return true;
  if (ctx.managedTargets.size) {
    if (ctx.managedTargets.has(userId)) return true;
    const groups = await userGroupIds(ctx.workspace.id, userId);
    if (groups.some((g) => ctx.managedTargets.has(g))) return true;
  }
  if (projectId && ctx.managedProjects.has(projectId)) return true;
  return false;
}

export async function assertCanEdit(ctx, entry) {
  if (!(await canManageEntriesOf(ctx, entry.user_id, entry.project_id))) throw forbidden("You can't edit this time entry", 403);
  if (entry.approval_status === 'APPROVED' || entry.approval_status === 'PENDING') throw forbidden('Time entry is part of an approval request. Withdraw it first.', 403);
  if ((entry.locked || entry.invoiced || isLockedByDate(entry, lockDateOf(ctx))) && !ctx.isAdmin) throw forbidden('Time entry is locked', 403);
}

// Validates and normalizes an input payload into DB columns.
export async function normalizeInput(ctx, userId, input, { existing } = {}) {
  const ws = ctx.workspace; const s = ctx.settings;
  const member = await one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, userId]);
  if (!member) throw badRequest('User is not a member of this workspace', 400);
  if (member.status !== 'ACTIVE' && !ctx.isAdmin) throw badRequest('User is not active in this workspace', 400);

  const out = {};
  if (input.description !== undefined) out.description = String(input.description ?? '').slice(0, 3000);
  if (input.start !== undefined) out.start_time = parseDate(input.start, 'start');
  if (input.end !== undefined) out.end_time = input.end == null ? null : parseDate(input.end, 'end');
  if (input.type !== undefined) out.type = ['REGULAR', 'BREAK', 'HOLIDAY', 'TIME_OFF'].includes(input.type) ? input.type : 'REGULAR';

  const start = out.start_time ?? (existing ? new Date(existing.start_time) : null);
  const end = out.end_time !== undefined ? out.end_time : (existing ? (existing.end_time ? new Date(existing.end_time) : null) : null);
  if (!start) throw badRequest('start is required', 400);
  if (end && end <= start) throw badRequest('end must be after start', 400);
  if (end && (end - start) > 1000 * 60 * 60 * 24 * 1000) throw badRequest('Duration too long', 400);
  const lockDate = lockDateOf(ctx);
  if (lockDate && start < lockDate && !ctx.isAdmin) throw forbidden(`Time entries before ${lockDate.toISOString()} are locked`, 403);

  let project = null;
  const projectId = input.projectId !== undefined ? (input.projectId || null) : (existing ? existing.project_id : null);
  if (input.projectId !== undefined) out.project_id = projectId;
  if (projectId) {
    project = await one('SELECT * FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, ws.id]);
    if (!project) throw badRequest('Project not found', 400);
    if (project.archived) throw badRequest('Project is archived', 400);
    if (!project.is_public && !ctx.isAdmin) {
      const targetCtx = userId === ctx.user.id ? ctx : { ...ctx, user: { id: userId }, isAdmin: false, managedProjects: new Set() };
      if (!(await canAccessProject(targetCtx, projectId))) throw forbidden('User is not a member of this private project', 403);
    }
  }
  const taskId = input.taskId !== undefined ? (input.taskId || null) : (existing ? existing.task_id : null);
  if (input.taskId !== undefined || input.projectId !== undefined) out.task_id = taskId;
  if (taskId) {
    const task = await one('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (!task || task.project_id !== projectId) throw badRequest('Task does not belong to the selected project', 400);
    if (task.status === 'DONE' && !ctx.isAdmin) throw badRequest('Task is marked as done', 400);
    if (task.billable != null && input.billable === undefined && !existing) out.billable = task.billable;
  }
  if (input.tagIds !== undefined) {
    const ids = [...new Set((input.tagIds || []).filter(Boolean))];
    if (ids.length) {
      const found = await rows('SELECT id, archived FROM tags WHERE workspace_id = $1 AND id = ANY($2)', [ws.id, ids]);
      if (found.length !== ids.length) throw badRequest('One or more tags do not exist', 400);
      if (found.some((t) => t.archived) && !ctx.isAdmin) throw badRequest('Cannot use archived tags', 400);
    }
    out.tagIds = ids;
  }
  if (input.billable !== undefined) {
    if (s.onlyAdminsCanChangeBillableStatus && !ctx.isAdmin && project && !!input.billable !== !!project.billable) throw forbidden('Only admins can change billable status', 403);
    out.billable = !!input.billable;
  } else if (!existing) {
    out.billable = project ? !!project.billable : false;
  }
  if (input.projectId !== undefined && existing && input.billable === undefined && project) out.billable = !!project.billable;

  // Required fields (workspace settings) apply to completed entries and to timers alike
  const type = out.type ?? existing?.type ?? 'REGULAR';
  if (type === 'REGULAR') {
    if (s.forceProjects && !projectId) throw badRequest('Project is required', 400);
    if (s.forceTasks && projectId && !taskId) throw badRequest('Task is required', 400);
    const desc = out.description ?? existing?.description ?? '';
    if (s.forceDescription && !desc.trim()) throw badRequest('Description is required', 400);
    const tagCount = out.tagIds ? out.tagIds.length : (existing ? (await one('SELECT count(*)::int AS c FROM time_entry_tags WHERE time_entry_id = $1', [existing.id])).c : 0);
    if (s.forceTags && tagCount === 0) throw badRequest('At least one tag is required', 400);
  }

  // Custom fields
  if (input.customFields !== undefined || input.customAttributes !== undefined) {
    const list = input.customFields || input.customAttributes || [];
    const fields = await rows("SELECT * FROM custom_fields WHERE workspace_id = $1 AND entity_type = 'TIMEENTRY'", [ws.id]);
    out.customFields = [];
    for (const item of list) {
      const cf = fields.find((f) => f.id === item.customFieldId);
      if (!cf) throw badRequest(`Custom field ${item.customFieldId} not found`, 400);
      if (cf.only_admin_can_edit && !ctx.isAdmin) throw forbidden(`Custom field "${cf.name}" can only be edited by admins`, 403);
      out.customFields.push({ customFieldId: cf.id, value: normalizeValue(cf, item.value), sourceType: item.sourceType || 'TIMEENTRY' });
    }
  }
  if (!existing || out.project_id !== undefined) {
    // required custom fields check on create (defaults may satisfy it)
    const fields = await rows("SELECT f.*, d.value AS project_value, d.status AS project_status FROM custom_fields f LEFT JOIN custom_field_project_defaults d ON d.custom_field_id = f.id AND d.project_id = $2 WHERE f.workspace_id = $1 AND f.entity_type = 'TIMEENTRY' AND f.status <> 'INACTIVE'", [ws.id, projectId]);
    out.applyDefaults = fields.map((f) => ({ id: f.id, required: f.required, defaultValue: f.project_value ?? f.workspace_default_value ?? null, status: f.project_status || f.status, name: f.name }));
  }
  return out;
}

async function writeTagsAndFields(entryId, workspaceId, norm, { replaceFields }) {
  if (norm.tagIds) {
    await query('DELETE FROM time_entry_tags WHERE time_entry_id = $1', [entryId]);
    for (const t of norm.tagIds) await query('INSERT INTO time_entry_tags (time_entry_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [entryId, t]);
  }
  if (norm.customFields) {
    if (replaceFields) await query("DELETE FROM custom_field_values WHERE entity_type = 'TIMEENTRY' AND entity_id = $1", [entryId]);
    for (const f of norm.customFields) {
      await query("INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('TIMEENTRY',$1,$2,$3,$4,$5) ON CONFLICT (entity_type, entity_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value, source_type = EXCLUDED.source_type", [entryId, f.customFieldId, workspaceId, JSON.stringify(f.value), f.sourceType]);
    }
  }
  if (norm.applyDefaults) {
    const provided = new Set((norm.customFields || []).map((f) => f.customFieldId));
    for (const d of norm.applyDefaults) {
      if (provided.has(d.id)) continue;
      const exists = await one("SELECT value FROM custom_field_values WHERE entity_type = 'TIMEENTRY' AND entity_id = $1 AND custom_field_id = $2", [entryId, d.id]);
      if (exists) continue;
      if (d.defaultValue != null && d.defaultValue !== '') {
        await query("INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('TIMEENTRY',$1,$2,$3,$4,'PROJECT') ON CONFLICT DO NOTHING", [entryId, d.id, workspaceId, JSON.stringify(d.defaultValue)]);
      } else if (d.required && d.status === 'VISIBLE') {
        throw badRequest(`Custom field "${d.name}" is required`, 400);
      }
    }
  }
}

export async function stopRunning(ctx, userId, end, { silent = false } = {}) {
  const running = await one('SELECT * FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND end_time IS NULL AND deleted_at IS NULL', [ctx.workspace.id, userId]);
  if (!running) return null;
  let endTime = end ? parseDate(end, 'end') : new Date();
  if (endTime <= new Date(running.start_time)) endTime = new Date(new Date(running.start_time).getTime() + 1000);
  const rates = await resolveRates({ workspaceId: ctx.workspace.id, userId, projectId: running.project_id, taskId: running.task_id });
  const updated = await one('UPDATE time_entries SET end_time = $2, hourly_rate_amount = $3, hourly_rate_currency = $4, cost_rate_amount = $5 WHERE id = $1 RETURNING *', [running.id, endTime, rates.hourlyRate.amount, rates.hourlyRate.currency, rates.costRate.amount]);
  if (!silent) {
    await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: userId === ctx.user.id ? 'UPDATE_TIME_PERSONAL' : 'UPDATE_TIME_FOR_OTHER', entityType: 'TIME_ENTRY', entityId: running.id, content: { end: endTime } });
    events.emitAsync('timer.stopped', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, userId, entryId: running.id });
  }
  return updated;
}

export async function createEntry(ctx, userId, input, { origin } = {}) {
  if (!(await canManageEntriesOf(ctx, userId, input.projectId))) throw forbidden("You can't add time entries for this user", 403);
  if (ctx.settings.timeTrackingMode === 'STOPWATCH_ONLY' && input.end && !ctx.isAdmin && !input.__allowManual) throw forbidden('Manual time entries are disabled in this workspace (stopwatch only)', 403);
  const norm = await normalizeInput(ctx, userId, { description: '', ...input, tagIds: input.tagIds ?? [] });
  const entry = await transaction(async () => {
    if (norm.end_time === null || norm.end_time === undefined) {
      await stopRunning(ctx, userId, norm.start_time ? norm.start_time.toISOString() : undefined);
    }
    const rates = await resolveRates({ workspaceId: ctx.workspace.id, userId, projectId: norm.project_id || null, taskId: norm.task_id || null });
    const e = await insert('time_entries', {
      id: input.id && /^[a-f0-9]{24}$/.test(input.id) ? input.id : newId(), workspace_id: ctx.workspace.id, user_id: userId, project_id: norm.project_id || null, task_id: norm.task_id || null,
      description: norm.description || '', start_time: norm.start_time, end_time: norm.end_time ?? null, billable: norm.billable ?? false, type: norm.type || 'REGULAR',
      hourly_rate_amount: rates.hourlyRate.amount, hourly_rate_currency: rates.hourlyRate.currency, cost_rate_amount: rates.costRate.amount,
      time_zone: input.timeZone || ctx.user.settings?.timeZone || null, origin: origin || (norm.end_time ? 'MANUAL' : 'TIMER'), kiosk_id: input.kioskId || null,
      invoiced: !!input.invoiced, locked: !!input.locked,
    });
    await writeTagsAndFields(e.id, ctx.workspace.id, norm, { replaceFields: false });
    return e;
  });
  const action = origin === 'IMPORT' ? 'CREATE_TIME_IMPORT' : origin === 'KIOSK' ? 'CREATE_TIME_KIOSK' : userId !== ctx.user.id ? 'CREATE_TIME_FOR_OTHER' : entry.end_time ? 'CREATE_TIME_PERSONAL_MANUAL' : 'CREATE_TIME_PERSONAL_TIMER';
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action, entityType: 'TIME_ENTRY', entityId: entry.id, content: input });
  events.emitAsync(entry.end_time ? 'time_entry.created' : 'timer.started', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, userId, entryId: entry.id });
  return entry;
}

export async function updateEntry(ctx, entry, input) {
  await assertCanEdit(ctx, entry);
  const norm = await normalizeInput(ctx, entry.user_id, input, { existing: entry });
  const updated = await transaction(async () => {
    const rates = await resolveRates({ workspaceId: ctx.workspace.id, userId: entry.user_id, projectId: norm.project_id !== undefined ? norm.project_id : entry.project_id, taskId: norm.task_id !== undefined ? norm.task_id : entry.task_id });
    const e = await one(
      `UPDATE time_entries SET description = COALESCE($2, description), start_time = COALESCE($3, start_time), end_time = CASE WHEN $4::boolean THEN $5 ELSE end_time END,
         project_id = CASE WHEN $6::boolean THEN $7 ELSE project_id END, task_id = CASE WHEN $8::boolean THEN $9 ELSE task_id END, billable = COALESCE($10, billable), type = COALESCE($11, type),
         hourly_rate_amount = $12, hourly_rate_currency = $13, cost_rate_amount = $14 WHERE id = $1 RETURNING *`,
      [entry.id, norm.description ?? null, norm.start_time ?? null, norm.end_time !== undefined, norm.end_time ?? null, norm.project_id !== undefined, norm.project_id ?? null, norm.task_id !== undefined, norm.task_id ?? null, norm.billable ?? null, norm.type ?? null, rates.hourlyRate.amount, rates.hourlyRate.currency, rates.costRate.amount],
    );
    await writeTagsAndFields(e.id, ctx.workspace.id, norm, { replaceFields: false });
    return e;
  });
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: entry.user_id === ctx.user.id ? 'UPDATE_TIME_PERSONAL' : 'UPDATE_TIME_FOR_OTHER', entityType: 'TIME_ENTRY', entityId: entry.id, content: input, previous: await entryDto(entry) });
  events.emitAsync('time_entry.updated', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, userId: entry.user_id, entryId: entry.id });
  return updated;
}

export async function deleteEntry(ctx, entry) {
  await assertCanEdit(ctx, entry);
  const dto = await entryDto(entry, { ctx });
  await query('UPDATE time_entries SET deleted_at = now() WHERE id = $1', [entry.id]);
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: entry.user_id === ctx.user.id ? 'DELETE_TIME_PERSONAL' : 'DELETE_TIME_FOR_OTHER', entityType: 'TIME_ENTRY', entityId: entry.id, previous: dto });
  events.emitAsync('time_entry.deleted', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, userId: entry.user_id, entryId: entry.id, entry: dto });
  return dto;
}

export async function listEntries(ctx, userId, q) {
  const conds = ['e.workspace_id = $1', 'e.user_id = $2', 'e.deleted_at IS NULL'];
  const params = [ctx.workspace.id, userId];
  let start = q.start ? parseDate(q.start, 'start') : null;
  const end = q.end ? parseDate(q.end, 'end') : null;
  if (start && q.getWeekBefore) start = new Date(start.getTime() - 7 * 86400000);
  if (start) { params.push(start); conds.push(`e.start_time >= $${params.length}`); }
  if (end) { params.push(end); conds.push(`e.start_time < $${params.length}`); }
  if (q.description) { params.push(`%${String(q.description).toLowerCase()}%`); conds.push(`lower(e.description) LIKE $${params.length}`); }
  if (q.project) { params.push(q.project); conds.push(`e.project_id = $${params.length}`); }
  if (q.task) { params.push(q.task); conds.push(`e.task_id = $${params.length}`); }
  if (q.projectRequired) conds.push('e.project_id IS NOT NULL');
  if (q.taskRequired) conds.push('e.task_id IS NOT NULL');
  if (q.inProgress === true) conds.push('e.end_time IS NULL');
  if (q.inProgress === false) conds.push('e.end_time IS NOT NULL');
  if (q.type) { params.push(q.type); conds.push(`e.type = $${params.length}`); }
  if (q.tags && q.tags.length) { params.push(q.tags); conds.push(`EXISTS (SELECT 1 FROM time_entry_tags tt WHERE tt.time_entry_id = e.id AND tt.tag_id = ANY($${params.length}))`); }
  params.push(q.limit || 50, q.offset || 0);
  const list = await rows(`SELECT e.* FROM time_entries e WHERE ${conds.join(' AND ')} ORDER BY e.start_time DESC, e.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return entriesDto(list, { hydrated: !!q.hydrated, ctx });
}
