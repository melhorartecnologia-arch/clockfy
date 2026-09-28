import { secondsToIso } from './duration.js';
import { toIso } from './dates.js';
import { DEFAULT_USER_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, mergeSettings } from './settings.js';

export const rate = (amount, currency) => (amount == null ? null : { amount: Number(amount), currency: currency || 'USD' });

export function membershipDto(m, { type = 'WORKSPACE', targetId, currency } = {}) {
  return {
    userId: m.user_id ?? m.target_id,
    hourlyRate: rate(m.hourly_rate_amount, m.hourly_rate_currency || currency),
    costRate: rate(m.cost_rate_amount, m.hourly_rate_currency || currency),
    targetId: targetId ?? m.workspace_id ?? m.project_id,
    membershipType: type,
    membershipStatus: m.status || 'ACTIVE',
  };
}

export function userDto(u, { memberships = [], customFields = [], includeSettings = true } = {}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    memberships: memberships.map((m) => membershipDto(m)),
    profilePicture: u.profile_picture || null,
    activeWorkspace: u.active_workspace_id || null,
    defaultWorkspace: u.default_workspace_id || null,
    settings: includeSettings ? mergeSettings(DEFAULT_USER_SETTINGS, u.settings) : undefined,
    status: u.status,
    customFields,
    weekStart: u.week_start || undefined,
    workCapacity: u.work_capacity || undefined,
    workingDays: u.working_days || undefined,
    roles: u.roles || undefined,
  };
}

export function workspaceDto(w, { memberships = [], currencies = [] } = {}) {
  const settings = mergeSettings(DEFAULT_WORKSPACE_SETTINGS, w.settings);
  return {
    id: w.id,
    name: w.name,
    hourlyRate: rate(w.hourly_rate_amount, w.hourly_rate_currency),
    costRate: rate(w.cost_rate_amount, w.hourly_rate_currency),
    memberships: memberships.map((m) => membershipDto(m, { currency: w.hourly_rate_currency })),
    workspaceSettings: settings,
    imageUrl: w.image_url || '',
    featureSubscriptionType: w.feature_plan || 'ENTERPRISE',
    features: settings.features || [],
    currencies: currencies.map((c) => ({ id: c.id, code: c.code, isDefault: c.is_default })),
    subdomain: { name: w.subdomain || null, enabled: !!w.subdomain },
    ownerId: w.owner_id,
    createdAt: toIso(w.created_at),
  };
}

export function clientDto(c, { currencyCode } = {}) {
  return {
    id: c.id,
    name: c.name,
    workspaceId: c.workspace_id,
    archived: !!c.archived,
    address: c.address || '',
    email: c.email || null,
    ccEmails: c.cc_emails || [],
    note: c.note || '',
    currencyId: c.currency_id || null,
    currencyCode: currencyCode || c.currency_code || null,
  };
}

export function estimateDto(p) {
  const te = p.time_estimate || {};
  return { estimate: te.estimate || 'PT0S', type: te.type || 'AUTO' };
}

export function projectDto(p, { memberships = [], tasks, client, customFields, durationSeconds, currency } = {}) {
  const cur = p.hourly_rate_currency || currency || 'USD';
  const te = p.time_estimate || {};
  const be = p.budget_estimate || {};
  const dto = {
    id: p.id,
    name: p.name,
    hourlyRate: rate(p.hourly_rate_amount, cur),
    clientId: p.client_id || '',
    clientName: p.client_name || (client && client.name) || '',
    workspaceId: p.workspace_id,
    billable: !!p.billable,
    memberships: memberships.map((m) => membershipDto(m, { type: m.target_type === 'USERGROUP' ? 'USERGROUP' : 'PROJECT', targetId: p.id, currency: cur })),
    color: p.color,
    estimate: { estimate: te.estimate || 'PT0S', type: te.type || 'AUTO' },
    archived: !!p.archived,
    duration: secondsToIso(durationSeconds ?? p.duration_seconds ?? 0),
    note: p.note || '',
    costRate: rate(p.cost_rate_amount, cur),
    timeEstimate: { estimate: te.estimate || 'PT0S', type: te.type || 'AUTO', resetOption: te.resetOption || null, active: !!te.active, includeNonBillable: te.includeNonBillable !== false },
    budgetEstimate: { estimate: be.estimate || 0, type: be.type || 'AUTO', resetOption: be.resetOption || null, active: !!be.active, includeExpenses: !!be.includeExpenses },
    estimateReset: p.estimate_reset || null,
    template: !!p.is_template,
    isTemplate: !!p.is_template,
    public: !!p.is_public,
    isPublic: !!p.is_public,
    favorite: p.favorite ?? undefined,
    createdAt: toIso(p.created_at),
  };
  if (tasks) dto.tasks = tasks;
  if (client) dto.client = client;
  if (customFields) dto.customFields = customFields;
  return dto;
}

export function taskDto(t, { assigneeIds = [], userGroupIds = [], durationSeconds, currency } = {}) {
  return {
    id: t.id,
    name: t.name,
    projectId: t.project_id,
    workspaceId: t.workspace_id,
    assigneeIds,
    assigneeId: assigneeIds[0] || '',
    userGroupIds,
    estimate: t.estimate_seconds != null ? secondsToIso(t.estimate_seconds) : 'PT0S',
    budgetEstimate: t.budget_estimate ?? 0,
    status: t.status,
    duration: secondsToIso(durationSeconds ?? t.duration_seconds ?? 0),
    billable: t.billable,
    hourlyRate: rate(t.hourly_rate_amount, t.hourly_rate_currency || currency),
    costRate: rate(t.cost_rate_amount, t.hourly_rate_currency || currency),
  };
}

export function tagDto(t) {
  return { id: t.id, name: t.name, workspaceId: t.workspace_id, archived: !!t.archived };
}

export function customFieldDto(cf, projectDefaults = []) {
  return {
    id: cf.id,
    name: cf.name,
    workspaceId: cf.workspace_id,
    type: cf.type,
    entityType: cf.entity_type,
    placeholder: cf.placeholder || '',
    description: cf.description || '',
    allowedValues: cf.allowed_values || [],
    workspaceDefaultValue: cf.workspace_default_value ?? null,
    projectDefaultValues: projectDefaults.map((d) => ({ projectId: d.project_id, value: d.value, status: d.status })),
    status: cf.status,
    required: !!cf.required,
    onlyAdminCanEdit: !!cf.only_admin_can_edit,
  };
}

export function customFieldValueDto(v) {
  return {
    customFieldId: v.custom_field_id,
    timeEntryId: v.entity_id,
    value: v.value,
    name: v.name,
    type: v.type,
    sourceType: v.source_type || 'TIMEENTRY',
  };
}

export function timeIntervalDto(te) {
  const start = te.start_time;
  const end = te.end_time;
  const seconds = end ? Math.round((new Date(end) - new Date(start)) / 1000) : null;
  return { start: toIso(start), end: toIso(end), duration: end ? secondsToIso(seconds) : null };
}

export function timeEntryDto(te, { tagIds = [], customFieldValues = [], hydrated, showRates = true } = {}) {
  const dto = {
    id: te.id,
    description: te.description || '',
    tagIds,
    userId: te.user_id,
    billable: !!te.billable,
    taskId: te.task_id || null,
    projectId: te.project_id || null,
    workspaceId: te.workspace_id,
    timeInterval: timeIntervalDto(te),
    customFieldValues,
    type: te.type || 'REGULAR',
    kioskId: te.kiosk_id || null,
    hourlyRate: showRates ? rate(te.hourly_rate_amount, te.hourly_rate_currency) : null,
    costRate: showRates ? rate(te.cost_rate_amount, te.hourly_rate_currency) : null,
    isLocked: !!te.locked,
    invoiced: !!te.invoiced,
    invoiceId: te.invoice_id || null,
    approvalRequestId: te.approval_request_id || null,
    approvalStatus: te.approval_status || null,
  };
  if (hydrated) {
    dto.project = hydrated.project || null;
    dto.task = hydrated.task || null;
    dto.tags = hydrated.tags || [];
    dto.user = hydrated.user || null;
  }
  return dto;
}

export function userGroupDto(g, { userIds = [], teamManagers = [] } = {}) {
  return { id: g.id, name: g.name, workspaceId: g.workspace_id, userIds, teamManagers };
}
