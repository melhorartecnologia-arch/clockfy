import crypto from 'node:crypto';
import { one, rows, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { config } from '../../config.js';
import { toIso } from '../../lib/dates.js';
import { notFound } from '../../lib/errors.js';
import { clientDto, tagDto } from '../../lib/dto.js';
import { entryDto } from '../timeEntries/service.js';
import { getProjectDto } from '../projects/service.js';
import { singleTaskDto } from '../tasks/index.js';
import { groupDto } from '../userGroups/index.js';
import { listWorkspaceUsers, getUserDto } from '../users/service.js';

// Clockify webhook event types (WebhookEventType) --------------------------------------------
export const WEBHOOK_EVENTS = [
  'NEW_PROJECT', 'NEW_TASK', 'NEW_CLIENT', 'NEW_TIMER_STARTED', 'TIMER_STOPPED', 'TIME_ENTRY_UPDATED', 'TIME_ENTRY_DELETED', 'TIME_ENTRY_SPLIT',
  'NEW_TIME_ENTRY', 'TIME_ENTRY_RESTORED', 'NEW_TAG', 'USER_DELETED_FROM_WORKSPACE', 'USER_JOINED_WORKSPACE', 'USER_DEACTIVATED_ON_WORKSPACE',
  'USER_ACTIVATED_ON_WORKSPACE', 'USER_EMAIL_CHANGED', 'USER_UPDATED', 'NEW_INVOICE', 'INVOICE_UPDATED', 'NEW_APPROVAL_REQUEST',
  'APPROVAL_REQUEST_STATUS_UPDATED', 'TIME_OFF_REQUESTED', 'TIME_OFF_REQUEST_UPDATED', 'TIME_OFF_REQUEST_APPROVED', 'TIME_OFF_REQUEST_REJECTED',
  'TIME_OFF_REQUEST_STARTED', 'TIME_OFF_REQUEST_WITHDRAWN', 'BALANCE_UPDATED', 'TAG_UPDATED', 'TAG_DELETED', 'TASK_UPDATED', 'CLIENT_UPDATED',
  'TASK_DELETED', 'CLIENT_DELETED', 'EXPENSE_RESTORED', 'ASSIGNMENT_CREATED', 'ASSIGNMENT_DELETED', 'ASSIGNMENT_PUBLISHED', 'ASSIGNMENT_UPDATED',
  'EXPENSE_CREATED', 'EXPENSE_DELETED', 'EXPENSE_UPDATED', 'PROJECT_UPDATED', 'PROJECT_DELETED', 'USER_GROUP_CREATED', 'USER_GROUP_UPDATED',
  'USER_GROUP_DELETED', 'USERS_INVITED_TO_WORKSPACE', 'LIMITED_USERS_ADDED_TO_WORKSPACE', 'COST_RATE_UPDATED', 'BILLABLE_RATE_UPDATED',
];
export const TRIGGER_SOURCE_TYPES = ['PROJECT_ID', 'USER_ID', 'TAG_ID', 'TASK_ID', 'WORKSPACE_ID', 'ASSIGNMENT_ID', 'EXPENSE_ID'];

// Retry schedule after a failed delivery: 1min, 5min, 30min, 2h, 6h (max 5 attempts per event)
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = 5;
export const MAX_CONSECUTIVE_FAILURES = 5;
const RESPONSE_BODY_LIMIT = 10_000;

export function generateAuthToken() {
  return crypto.randomBytes(48).toString('base64url'); // 64 chars
}

export function webhookDto(w) {
  return {
    id: w.id,
    name: w.name || '',
    url: w.url,
    webhookEvent: w.event,
    triggerSource: Array.isArray(w.trigger_source) ? w.trigger_source : [],
    triggerSourceType: w.trigger_source_type,
    authToken: w.auth_token,
    enabled: !!w.enabled,
    deliveryEnabled: !!w.delivery_enabled,
    planEnabled: true,
    userId: w.user_id,
    workspaceId: w.workspace_id,
    consecutiveFailures: w.consecutive_failures ?? 0,
    createdAt: toIso(w.created_at),
  };
}

export function deliveryDto(d) {
  return {
    id: d.id,
    webhookId: d.webhook_id,
    webhookEventStatusId: d.event_status_id,
    requestBody: d.request_body,
    responseBody: d.response_body ?? null,
    statusCode: d.status_code ?? null,
    respondedAt: toIso(d.responded_at || d.created_at),
    succeeded: !!d.succeeded,
    attempt: d.attempt,
    nextAttemptAt: toIso(d.next_attempt_at),
  };
}

export async function getWebhook(workspaceId, id) {
  const w = await one('SELECT * FROM webhooks WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!w) throw notFound('Webhook not found', 404);
  return w;
}

// Trigger-source filtering -----------------------------------------------------------------------
export function matchesTriggerSource(webhook, scope = {}) {
  const src = Array.isArray(webhook.trigger_source) ? webhook.trigger_source : [];
  switch (webhook.trigger_source_type) {
    case 'WORKSPACE_ID': return true;
    case 'PROJECT_ID': return !!scope.projectId && src.includes(scope.projectId);
    case 'USER_ID': return !!scope.userId && src.includes(scope.userId);
    case 'TAG_ID': return (scope.tagIds || []).some((t) => src.includes(t));
    case 'TASK_ID': return !!scope.taskId && src.includes(scope.taskId);
    case 'ASSIGNMENT_ID': return !!scope.assignmentId && src.includes(scope.assignmentId);
    case 'EXPENSE_ID': return !!scope.expenseId && src.includes(scope.expenseId);
    default: return false;
  }
}

// Delivery ------------------------------------------------------------------------------------------
async function postWebhook(webhook, eventType, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Clockify-Signature': webhook.auth_token,
        'Clockify-Webhook-Event-Type': eventType,
        'User-Agent': 'Clockfy-Webhooks',
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.status < 400, statusCode: res.status, responseBody: text.slice(0, RESPONSE_BODY_LIMIT) };
  } catch (err) {
    const message = err?.name === 'AbortError' ? `Timeout after ${config.webhookTimeoutMs}ms` : String(err?.cause?.message || err?.message || err);
    return { ok: false, statusCode: null, responseBody: message.slice(0, RESPONSE_BODY_LIMIT) };
  } finally {
    clearTimeout(timer);
  }
}

// Sends one attempt and records it in webhook_deliveries. Failures schedule a retry (next_attempt_at)
// until MAX_ATTEMPTS; MAX_CONSECUTIVE_FAILURES failures in a row disable delivery for the webhook.
export async function deliver(webhook, eventType, requestBody, { eventStatusId = newId(), attempt = 1 } = {}) {
  const result = await postWebhook(webhook, eventType, requestBody);
  const retry = !result.ok && attempt < MAX_ATTEMPTS;
  const nextAttemptAt = retry ? new Date(Date.now() + RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]) : null;
  const row = await insert('webhook_deliveries', {
    id: newId(), webhook_id: webhook.id, event_status_id: eventStatusId, request_body: requestBody, response_body: result.responseBody,
    status_code: result.statusCode, attempt, next_attempt_at: nextAttemptAt, succeeded: result.ok, responded_at: new Date(),
  });
  if (result.ok) {
    await query('UPDATE webhooks SET consecutive_failures = 0 WHERE id = $1', [webhook.id]);
  } else {
    await query(
      'UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, delivery_enabled = CASE WHEN consecutive_failures + 1 >= $2 THEN false ELSE delivery_enabled END WHERE id = $1',
      [webhook.id, MAX_CONSECUTIVE_FAILURES],
    );
  }
  return row;
}

// Dispatches a Clockify event to every enabled webhook of the workspace subscribed to it whose
// trigger source matches `scope` ({projectId, userId, tagIds, taskId, assignmentId, expenseId}).
export async function dispatchWebhookEvent(workspaceId, eventType, payload, scope = {}) {
  const hooks = await rows('SELECT * FROM webhooks WHERE workspace_id = $1 AND event = $2 AND enabled = true AND delivery_enabled = true', [workspaceId, eventType]);
  const matching = hooks.filter((w) => matchesTriggerSource(w, scope));
  if (!matching.length) return [];
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const results = await Promise.all(matching.map((w) => deliver(w, eventType, body).catch((err) => { console.error('[webhooks] delivery failed', w.id, err.message); return null; })));
  return results.filter(Boolean);
}

// Scheduler job: re-sends failed deliveries whose retry time has come.
export async function processPendingDeliveries(limit = 100) {
  const pending = await rows(
    `SELECT d.*, w.url, w.auth_token, w.event, w.enabled, w.delivery_enabled FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.succeeded = false AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at LIMIT $1`, [limit],
  );
  let retried = 0;
  for (const d of pending) {
    await query('UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE id = $1', [d.id]);
    if (!d.enabled || !d.delivery_enabled) continue;
    try {
      await deliver({ id: d.webhook_id, url: d.url, auth_token: d.auth_token }, d.event, d.request_body, { eventStatusId: d.event_status_id, attempt: d.attempt + 1 });
      retried++;
    } catch (err) {
      console.error('[webhooks] retry failed', d.id, err.message);
    }
  }
  return retried;
}

export async function searchDeliveries(webhookId, { from, to, status = 'ALL', sortByNewest = true, limit = 50, offset = 0 } = {}) {
  const conds = ['webhook_id = $1']; const params = [webhookId];
  if (from) { params.push(from); conds.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`created_at <= $${params.length}`); }
  if (status === 'SUCCEEDED') conds.push('succeeded = true');
  if (status === 'FAILED') conds.push('succeeded = false');
  params.push(limit, offset);
  const list = await rows(`SELECT * FROM webhook_deliveries WHERE ${conds.join(' AND ')} ORDER BY created_at ${sortByNewest ? 'DESC' : 'ASC'} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return list.map(deliveryDto);
}

// Payload builders ----------------------------------------------------------------------------------
// Each domain event handler returns a list of {workspaceId?, event, body, scope}.

function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

async function timeEntryPayload(p, event) {
  const row = await one('SELECT * FROM time_entries WHERE id = $1 AND workspace_id = $2', [p.entryId, p.workspaceId]);
  const dto = row ? await entryDto(row, { hydrated: true, showRates: true }) : (p.entry || null);
  if (!dto) return [];
  const body = { ...dto, currentlyRunning: !dto.timeInterval?.end };
  if (event === 'TIME_ENTRY_SPLIT' && p.newEntryId) {
    const copy = await one('SELECT * FROM time_entries WHERE id = $1 AND workspace_id = $2', [p.newEntryId, p.workspaceId]);
    body.newTimeEntry = copy ? await entryDto(copy, { hydrated: true, showRates: true }) : null;
  }
  return [{ event, body, scope: { projectId: dto.projectId, userId: dto.userId, taskId: dto.taskId, tagIds: dto.tagIds || [] } }];
}

async function projectPayload(p, event) {
  let dto = null;
  if (event !== 'PROJECT_DELETED') { try { dto = await getProjectDto(p.workspaceId, p.projectId, { hydrated: true }); } catch { dto = null; } }
  if (!dto) dto = p.project || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: { projectId: dto.id } }];
}

async function taskPayload(p, event) {
  let dto = null;
  if (event !== 'TASK_DELETED') {
    const t = await one('SELECT t.*, (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)))::bigint FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL) AS duration_seconds FROM tasks t WHERE t.id = $1 AND t.workspace_id = $2', [p.taskId, p.workspaceId]);
    if (t) dto = await singleTaskDto(t);
  }
  if (!dto) dto = p.task || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: { projectId: dto.projectId || p.projectId, taskId: dto.id } }];
}

async function clientPayload(p, event) {
  let dto = null;
  if (event !== 'CLIENT_DELETED') {
    const c = await one('SELECT c.*, cur.code AS currency_code FROM clients c LEFT JOIN workspace_currencies cur ON cur.id = c.currency_id WHERE c.id = $1 AND c.workspace_id = $2', [p.clientId, p.workspaceId]);
    if (c) dto = clientDto(c);
  }
  if (!dto) dto = p.client || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: {} }];
}

async function tagPayload(p, event) {
  let dto = null;
  if (event !== 'TAG_DELETED') {
    const t = await one('SELECT * FROM tags WHERE id = $1 AND workspace_id = $2', [p.tagId, p.workspaceId]);
    if (t) dto = tagDto(t);
  }
  if (!dto) dto = p.tag || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: { tagIds: [dto.id] } }];
}

async function userPayload(p, events) {
  const workspaceIds = p.workspaceId ? [p.workspaceId] : (await rows('SELECT workspace_id FROM workspace_members WHERE user_id = $1', [p.userId])).map((r) => r.workspace_id);
  const out = [];
  for (const wsId of workspaceIds) {
    let dto = (await listWorkspaceUsers(wsId, { userIds: [p.userId], status: 'ALL', includeRoles: true, limit: 1 }))[0] || null;
    if (!dto) dto = await getUserDto(p.userId, { includeMemberships: false });
    if (!dto) continue;
    const body = { ...dto, workspaceId: wsId };
    if (p.email) body.email = p.email;
    for (const event of events) {
      if (event === 'USERS_INVITED_TO_WORKSPACE') out.push({ workspaceId: wsId, event, body: { workspaceId: wsId, invitedUsers: [body], userIds: [dto.id], emails: [body.email] }, scope: { userId: dto.id } });
      else out.push({ workspaceId: wsId, event, body, scope: { userId: dto.id } });
    }
  }
  return out;
}

async function userGroupPayload(p, event) {
  let dto = null;
  if (event !== 'USER_GROUP_DELETED') {
    const g = await one('SELECT * FROM user_groups WHERE id = $1 AND workspace_id = $2', [p.groupId, p.workspaceId]);
    if (g) dto = await groupDto(p.workspaceId, g);
  }
  if (!dto) dto = p.group || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: {} }];
}

async function ratePayload(p) {
  const event = p.rateType === 'COST' ? 'COST_RATE_UPDATED' : 'BILLABLE_RATE_UPDATED';
  const col = p.rateType === 'COST' ? 'cost_rate_amount' : 'hourly_rate_amount';
  const ws = await one('SELECT hourly_rate_currency FROM workspaces WHERE id = $1', [p.workspaceId]);
  let row = null; let entityId = p.workspaceId;
  switch (p.entity) {
    case 'USER': row = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [p.workspaceId, p.userId]); entityId = p.userId; break;
    case 'PROJECT': row = await one('SELECT * FROM projects WHERE id = $1', [p.projectId]); entityId = p.projectId; break;
    case 'PROJECT_USER': row = await one("SELECT * FROM project_members WHERE project_id = $1 AND target_type = 'USER' AND target_id = $2", [p.projectId, p.userId]); entityId = p.userId; break;
    case 'TASK': row = await one('SELECT * FROM tasks WHERE id = $1', [p.taskId]); entityId = p.taskId; break;
    default: row = await one('SELECT * FROM workspaces WHERE id = $1', [p.workspaceId]);
  }
  const body = {
    workspaceId: p.workspaceId, rateType: p.rateType === 'COST' ? 'COST' : 'BILLABLE', entityType: p.entity || 'WORKSPACE', entityId,
    projectId: p.projectId || null, userId: p.userId || null, taskId: p.taskId || null,
    rate: { amount: row ? Number(row[col] ?? 0) : 0, currency: row?.hourly_rate_currency || ws?.hourly_rate_currency || 'USD' },
    updatedBy: p.actorId || null, updatedAt: toIso(new Date()),
  };
  return [{ event, body, scope: { projectId: p.projectId, userId: p.userId, taskId: p.taskId } }];
}

export async function approvalRequestDto(workspaceId, id) {
  const r = await one(
    `SELECT a.*, o.name AS owner_name, o.settings AS owner_settings, c.name AS creator_name, c.email AS creator_email, ub.name AS updated_by_name, wm.week_start
     FROM approval_requests a JOIN users o ON o.id = a.owner_user_id JOIN users c ON c.id = a.creator_user_id LEFT JOIN users ub ON ub.id = a.updated_by
     LEFT JOIN workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = a.owner_user_id WHERE a.id = $1 AND a.workspace_id = $2`, [id, workspaceId],
  );
  if (!r) return null;
  return {
    id: r.id, workspaceId: r.workspace_id, period: r.period,
    dateRange: { start: toIso(r.date_start), end: toIso(r.date_end) },
    owner: { userId: r.owner_user_id, userName: r.owner_name, timeZone: r.owner_settings?.timeZone || 'UTC', startOfWeek: r.week_start || r.owner_settings?.weekStart || 'MONDAY' },
    creator: { userId: r.creator_user_id, userName: r.creator_name, userEmail: r.creator_email },
    status: { state: r.state, note: r.note || '', updatedBy: r.updated_by || null, updatedByUserName: r.updated_by_name || null, updatedAt: toIso(r.updated_at) },
    createdAt: toIso(r.created_at),
  };
}

async function approvalPayload(p, event) {
  const id = p.approvalRequestId || p.requestId || p.approvalId || p.id;
  let dto = id ? await approvalRequestDto(p.workspaceId, id) : null;
  if (!dto) dto = p.approvalRequest || p.request || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: { userId: dto.owner?.userId || p.userId } }];
}

export async function timeOffRequestDto(workspaceId, id) {
  const r = await one(
    `SELECT t.*, u.name AS user_name, u.email AS user_email, u.settings AS user_settings, rq.name AS requester_name, p.name AS policy_name, cb.name AS changed_by_name
     FROM time_off_requests t JOIN users u ON u.id = t.user_id LEFT JOIN users rq ON rq.id = t.requester_user_id LEFT JOIN time_off_policies p ON p.id = t.policy_id LEFT JOIN users cb ON cb.id = t.status_changed_by
     WHERE t.id = $1 AND t.workspace_id = $2`, [id, workspaceId],
  );
  if (!r) return null;
  return {
    id: r.id, workspaceId: r.workspace_id, policyId: r.policy_id, policyName: r.policy_name || null,
    userId: r.user_id, userName: r.user_name, userEmail: r.user_email, userTimeZone: r.user_settings?.timeZone || 'UTC',
    requesterUserId: r.requester_user_id, requesterUserName: r.requester_name || null,
    timeOffPeriod: { period: { start: toIso(r.start_time), end: toIso(r.end_time) }, halfDay: !!r.half_day, halfDayPeriod: r.half_day_period || 'NOT_DEFINED', days: r.days == null ? null : Number(r.days) },
    status: { statusType: r.status, note: r.status_note || '', changedByUserId: r.status_changed_by || null, changedByUserName: r.changed_by_name || null, changedForUserName: r.user_name, changedAt: toIso(r.status_changed_at) },
    note: r.note || '', balanceDiff: Number(r.balance_diff || 0), timeUnit: r.time_unit || 'DAYS', createdAt: toIso(r.created_at),
  };
}

async function timeOffPayload(p, event) {
  const id = p.requestId || p.timeOffRequestId || p.timeOffId || p.id;
  let dto = id ? await timeOffRequestDto(p.workspaceId, id) : null;
  if (!dto) dto = p.request || p.timeOffRequest || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: { userId: dto.userId || p.userId } }];
}

export async function balanceDto(workspaceId, { balanceId, policyId, userId }) {
  const cond = balanceId ? 'b.id = $2' : 'b.policy_id = $2 AND b.user_id = $3';
  const params = balanceId ? [workspaceId, balanceId] : [workspaceId, policyId, userId];
  const b = await one(`SELECT b.*, u.name AS user_name, p.name AS policy_name, p.time_unit, p.archived AS policy_archived, p.allow_negative_balance, p.negative_balance FROM time_off_balances b JOIN users u ON u.id = b.user_id JOIN time_off_policies p ON p.id = b.policy_id WHERE b.workspace_id = $1 AND ${cond}`, params);
  if (!b) return null;
  return {
    id: b.id, workspaceId: b.workspace_id, userId: b.user_id, userName: b.user_name, policyId: b.policy_id, policyName: b.policy_name, policyTimeUnit: b.time_unit || 'DAYS',
    policyArchived: !!b.policy_archived, total: Number(b.total || 0), used: Number(b.used || 0), balance: Number(b.total || 0) - Number(b.used || 0),
    negativeBalanceLimit: !!b.allow_negative_balance, negativeBalanceAmount: Number(b.negative_balance?.amount || 0), updatedAt: toIso(b.updated_at),
  };
}

async function balancePayload(p) {
  let dto = (p.balanceId || (p.policyId && p.userId)) ? await balanceDto(p.workspaceId, p) : null;
  if (!dto) dto = p.balance || null;
  if (!dto) return [];
  return [{ event: 'BALANCE_UPDATED', body: dto, scope: { userId: dto.userId || p.userId } }];
}

export function assignmentDto(a) {
  return {
    id: a.id, workspaceId: a.workspace_id, projectId: a.project_id, taskId: a.task_id || null, userId: a.user_id,
    period: { start: `${dateStr(a.start_date)}T00:00:00Z`, end: `${dateStr(a.end_date)}T23:59:59Z` },
    hoursPerDay: Number(a.hours_per_day || 0), startTime: a.start_time || null, includeNonWorkingDays: !!a.include_non_working_days,
    note: a.note || '', billable: a.billable ?? null, published: !!a.published,
    recurring: a.series_id ? { seriesId: a.series_id, repeat: !!a.recurring_repeat, weeks: a.recurring_weeks ?? null } : null,
    excludeDays: [], createdAt: toIso(a.created_at),
  };
}

async function assignmentPayload(p, event) {
  const id = p.assignmentId || p.id;
  const row = id ? await one('SELECT * FROM scheduling_assignments WHERE id = $1 AND workspace_id = $2', [id, p.workspaceId]) : null;
  const dto = row ? assignmentDto(row) : (p.assignment || null);
  if (!dto) return [];
  return [{ event, body: dto, scope: { assignmentId: dto.id, projectId: dto.projectId, userId: dto.userId, taskId: dto.taskId } }];
}

export function expenseDto(e) {
  return {
    id: e.id, workspaceId: e.workspace_id, userId: e.user_id, projectId: e.project_id || null, taskId: e.task_id || null, categoryId: e.category_id || null,
    date: dateStr(e.date), notes: e.notes || '', quantity: Number(e.quantity ?? 1), total: Number(e.total || 0), billable: !!e.billable, fileId: e.file_id || null,
    locked: !!e.locked, isLocked: !!e.locked, invoiced: !!e.invoiced, approvalStatus: e.approval_status || null, createdAt: toIso(e.created_at),
  };
}

async function expensePayload(p, event) {
  const id = p.expenseId || p.id;
  const row = id ? await one('SELECT * FROM expenses WHERE id = $1 AND workspace_id = $2', [id, p.workspaceId]) : null;
  const dto = row ? expenseDto(row) : (p.expense || null);
  if (!dto) return [];
  return [{ event, body: dto, scope: { expenseId: dto.id, projectId: dto.projectId, userId: dto.userId, taskId: dto.taskId } }];
}

export async function invoiceDto(workspaceId, id) {
  const inv = await one('SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1 AND i.workspace_id = $2', [id, workspaceId]);
  if (!inv) return null;
  const items = await one('SELECT COALESCE(SUM(quantity * unit_price),0)::bigint AS amount FROM invoice_items WHERE invoice_id = $1', [id]);
  const payments = await one('SELECT COALESCE(SUM(amount),0)::bigint AS paid FROM invoice_payments WHERE invoice_id = $1', [id]);
  const amount = Number(items.amount || 0); const paid = Number(payments.paid || 0);
  return {
    id: inv.id, workspaceId: inv.workspace_id, number: inv.number, clientId: inv.client_id || null, clientName: inv.client_name || '', currency: inv.currency,
    issuedDate: `${dateStr(inv.issued_date)}T00:00:00Z`, dueDate: `${dateStr(inv.due_date)}T00:00:00Z`, status: inv.status, subject: inv.subject || '',
    amount, paid, balance: amount - paid, createdAt: toIso(inv.created_at),
  };
}

async function invoicePayload(p, event) {
  const id = p.invoiceId || p.id;
  let dto = id ? await invoiceDto(p.workspaceId, id) : null;
  if (!dto) dto = p.invoice || null;
  if (!dto) return [];
  return [{ event, body: dto, scope: {} }];
}

// Domain event → Clockify webhook event mapping ----------------------------------------------------
export const DOMAIN_EVENTS = {
  'time_entry.created': (p) => timeEntryPayload(p, 'NEW_TIME_ENTRY'),
  'timer.started': (p) => timeEntryPayload(p, 'NEW_TIMER_STARTED'),
  'timer.stopped': (p) => timeEntryPayload(p, 'TIMER_STOPPED'),
  'time_entry.updated': (p) => timeEntryPayload(p, 'TIME_ENTRY_UPDATED'),
  'time_entry.deleted': (p) => timeEntryPayload(p, 'TIME_ENTRY_DELETED'),
  'time_entry.restored': (p) => timeEntryPayload(p, 'TIME_ENTRY_RESTORED'),
  'time_entry.split': (p) => timeEntryPayload(p, 'TIME_ENTRY_SPLIT'),
  'project.created': (p) => projectPayload(p, 'NEW_PROJECT'),
  'project.updated': (p) => projectPayload(p, 'PROJECT_UPDATED'),
  'project.deleted': (p) => projectPayload(p, 'PROJECT_DELETED'),
  'task.created': (p) => taskPayload(p, 'NEW_TASK'),
  'task.updated': (p) => taskPayload(p, 'TASK_UPDATED'),
  'task.deleted': (p) => taskPayload(p, 'TASK_DELETED'),
  'client.created': (p) => clientPayload(p, 'NEW_CLIENT'),
  'client.updated': (p) => clientPayload(p, 'CLIENT_UPDATED'),
  'client.deleted': (p) => clientPayload(p, 'CLIENT_DELETED'),
  'tag.created': (p) => tagPayload(p, 'NEW_TAG'),
  'tag.updated': (p) => tagPayload(p, 'TAG_UPDATED'),
  'tag.deleted': (p) => tagPayload(p, 'TAG_DELETED'),
  'user.joined_workspace': (p) => userPayload(p, ['USER_JOINED_WORKSPACE', 'USERS_INVITED_TO_WORKSPACE']),
  'user.activated': (p) => userPayload(p, ['USER_ACTIVATED_ON_WORKSPACE']),
  'user.deactivated': (p) => userPayload(p, ['USER_DEACTIVATED_ON_WORKSPACE']),
  'user.removed': (p) => userPayload(p, ['USER_DELETED_FROM_WORKSPACE']),
  'user.updated': (p) => userPayload(p, ['USER_UPDATED']),
  'user.email_changed': (p) => userPayload(p, ['USER_EMAIL_CHANGED']),
  'user_group.created': (p) => userGroupPayload(p, 'USER_GROUP_CREATED'),
  'user_group.updated': (p) => userGroupPayload(p, 'USER_GROUP_UPDATED'),
  'user_group.deleted': (p) => userGroupPayload(p, 'USER_GROUP_DELETED'),
  'rate.updated': (p) => ratePayload(p),
  'approval.created': (p) => approvalPayload(p, 'NEW_APPROVAL_REQUEST'),
  'approval.status_updated': (p) => approvalPayload(p, 'APPROVAL_REQUEST_STATUS_UPDATED'),
  'time_off.requested': (p) => timeOffPayload(p, 'TIME_OFF_REQUESTED'),
  'time_off.updated': (p) => timeOffPayload(p, 'TIME_OFF_REQUEST_UPDATED'),
  'time_off.approved': (p) => timeOffPayload(p, 'TIME_OFF_REQUEST_APPROVED'),
  'time_off.rejected': (p) => timeOffPayload(p, 'TIME_OFF_REQUEST_REJECTED'),
  'time_off.withdrawn': (p) => timeOffPayload(p, 'TIME_OFF_REQUEST_WITHDRAWN'),
  'time_off.started': (p) => timeOffPayload(p, 'TIME_OFF_REQUEST_STARTED'),
  'balance.updated': (p) => balancePayload(p),
  'assignment.created': (p) => assignmentPayload(p, 'ASSIGNMENT_CREATED'),
  'assignment.updated': (p) => assignmentPayload(p, 'ASSIGNMENT_UPDATED'),
  'assignment.deleted': (p) => assignmentPayload(p, 'ASSIGNMENT_DELETED'),
  'assignment.published': (p) => assignmentPayload(p, 'ASSIGNMENT_PUBLISHED'),
  'expense.created': (p) => expensePayload(p, 'EXPENSE_CREATED'),
  'expense.updated': (p) => expensePayload(p, 'EXPENSE_UPDATED'),
  'expense.deleted': (p) => expensePayload(p, 'EXPENSE_DELETED'),
  'expense.restored': (p) => expensePayload(p, 'EXPENSE_RESTORED'),
  'invoice.created': (p) => invoicePayload(p, 'NEW_INVOICE'),
  'invoice.updated': (p) => invoicePayload(p, 'INVOICE_UPDATED'),
};

// Entry point used by subscribers.js: builds the Clockify payload(s) for a domain event and dispatches them.
export async function handleDomainEvent(name, payload = {}) {
  const build = DOMAIN_EVENTS[name];
  if (!build) return [];
  if (payload.workspaceId) {
    // cheap short-circuit: no webhooks at all in this workspace → skip building DTOs
    const any = await one('SELECT 1 FROM webhooks WHERE workspace_id = $1 AND enabled = true AND delivery_enabled = true LIMIT 1', [payload.workspaceId]);
    if (!any) return [];
  }
  const items = await build(payload);
  const out = [];
  for (const item of items) {
    const workspaceId = item.workspaceId || payload.workspaceId;
    if (!workspaceId) continue;
    const hasHooks = await one('SELECT 1 FROM webhooks WHERE workspace_id = $1 AND event = $2 AND enabled = true AND delivery_enabled = true LIMIT 1', [workspaceId, item.event]);
    if (!hasHooks) continue;
    out.push(...(await dispatchWebhookEvent(workspaceId, item.event, item.body, item.scope)));
  }
  return out;
}
