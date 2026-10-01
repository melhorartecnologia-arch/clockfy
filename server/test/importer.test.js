import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestApp } from './helpers.js';

// the mock Clockify server listens on 127.0.0.1 – outside *.clockify.me, so it must be allowed explicitly
process.env.CLOCKIFY_IMPORT_ALLOWED_HOSTS = '127.0.0.1';

// ---------------------------------------------------------------------------------------------------------------
// Mock of the Clockify API (fixtures with fixed 24-hex ids)
// ---------------------------------------------------------------------------------------------------------------

const OWNER_EMAIL = 'owner-import@test.dev';
const API_KEY = 'test-clockify-key';

function hex(seed, kind, n) { return `${seed}${kind}${String(n).padStart(20, '0')}`; }

function buildFixture(seed, { ownerEmail, name }) {
  const id = (kind, n) => hex(seed, kind, n);
  const WS = id('00', 1);
  const U_OWNER = id('a0', 1); const U_ALICE = id('a0', 2);
  const CLIENT1 = id('c0', 1); const PROJ1 = id('b0', 1); const PROJ2 = id('b0', 2);
  const TASK1 = id('d0', 1); const TASK2 = id('d0', 2);
  const TAG1 = id('e0', 1); const TAG2 = id('e0', 2);
  const CF1 = id('f0', 1); const GROUP1 = id('90', 1);
  const TE = (n) => id('10', n);
  const CAT1 = id('20', 1); const EXP1 = id('21', 1); const FILE1 = id('22', 1);
  const HOL1 = id('30', 1); const POL1 = id('40', 1); const BAL1 = id('41', 1); const TOR1 = id('42', 1);
  const APR1 = id('50', 1); const ASG1 = id('60', 1); const INV1 = id('70', 1); const PAY1 = id('71', 1); const WH1 = id('80', 1);
  const now = new Date();
  const runningStart = new Date(now.getTime() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const entries = [
    { id: TE(1), userId: U_OWNER, projectId: PROJ1, taskId: TASK1, tagIds: [TAG1], billable: true, description: 'Homepage', type: 'REGULAR', isLocked: false, timeInterval: { start: '2024-01-05T10:00:00Z', end: '2024-01-05T11:30:00Z', duration: 'PT1H30M' }, hourlyRate: { amount: 5000, currency: 'USD' }, costRate: { amount: 2000, currency: 'USD' }, customFieldValues: [{ customFieldId: CF1, timeEntryId: TE(1), value: 'PO-42', name: 'PO', type: 'TXT' }] },
    { id: TE(2), userId: U_OWNER, projectId: PROJ1, taskId: null, tagIds: [TAG1, TAG2], billable: false, description: 'Meeting', type: 'REGULAR', isLocked: true, timeInterval: { start: '2024-03-01T13:00:00Z', end: '2024-03-01T14:00:00Z', duration: 'PT1H' }, customFieldValues: [] },
    { id: TE(3), userId: U_OWNER, projectId: PROJ1, taskId: null, tagIds: [], billable: true, description: 'Running', type: 'REGULAR', isLocked: false, timeInterval: { start: runningStart, end: null, duration: null }, customFieldValues: [] },
    { id: TE(4), userId: U_ALICE, projectId: PROJ2, taskId: TASK2, tagIds: [TAG2], billable: true, description: 'Old work', type: 'REGULAR', isLocked: true, timeInterval: { start: '2023-06-01T08:00:00Z', end: '2023-06-01T12:00:00Z', duration: 'PT4H' }, hourlyRate: { amount: 3000, currency: 'USD' }, costRate: { amount: 1000, currency: 'USD' }, customFieldValues: [] },
    { id: TE(5), userId: U_ALICE, projectId: null, taskId: null, tagIds: [], billable: false, description: 'Break', type: 'BREAK', isLocked: false, timeInterval: { start: '2025-02-02T09:00:00Z', end: '2025-02-02T09:15:00Z', duration: 'PT15M' }, customFieldValues: [] },
  ];
  return {
    ids: { WS, U_OWNER, U_ALICE, CLIENT1, PROJ1, PROJ2, TASK1, TASK2, TAG1, TAG2, CF1, GROUP1, TE1: TE(1), TE2: TE(2), TE3: TE(3), TE4: TE(4), TE5: TE(5), CAT1, EXP1, FILE1, HOL1, POL1, TOR1, APR1, ASG1, INV1, WH1 },
    me: { id: U_OWNER, email: ownerEmail, name: 'Owner', activeWorkspace: WS, defaultWorkspace: WS, settings: { timeZone: 'America/Sao_Paulo', weekStart: 'MONDAY' }, status: 'ACTIVE' },
    workspace: {
      id: WS, name, hourlyRate: { amount: 4000, currency: 'USD' }, costRate: { amount: 1500, currency: 'USD' }, imageUrl: '',
      currencies: [{ id: id('cc', 1), code: 'USD', isDefault: true }, { id: id('cc', 2), code: 'BRL', isDefault: false }],
      memberships: [{ userId: U_OWNER, membershipType: 'WORKSPACE', membershipStatus: 'ACTIVE', targetId: WS }],
      workspaceSettings: { forceProjects: true, forceTasks: false, round: { round: 'Round to nearest', minutes: '15' }, timeTrackingMode: 'DEFAULT', projectLabel: 'projeto', workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] },
      features: ['TIME_OFF', 'EXPENSES'],
    },
    users: [
      { id: U_OWNER, email: ownerEmail, name: 'Owner', status: 'ACTIVE', settings: { timeZone: 'America/Sao_Paulo' }, memberships: [{ userId: U_OWNER, membershipType: 'WORKSPACE', membershipStatus: 'ACTIVE', targetId: WS, hourlyRate: { amount: 6000, currency: 'USD' }, costRate: { amount: 2500, currency: 'USD' } }], roles: [{ role: 'WORKSPACE_ADMIN', entities: [] }], customFields: [] },
      { id: U_ALICE, email: 'alice-import@test.dev', name: 'Alice', status: 'ACTIVE', settings: { timeZone: 'Europe/Lisbon' }, memberships: [{ userId: U_ALICE, membershipType: 'WORKSPACE', membershipStatus: 'INACTIVE', targetId: WS, hourlyRate: { amount: 3000, currency: 'USD' }, costRate: null }], roles: [{ role: 'PROJECT_MANAGER', entities: [{ id: PROJ2, name: 'Legacy' }] }], customFields: [] },
    ],
    groups: [{ id: GROUP1, name: 'Dev team', workspaceId: WS, userIds: [U_OWNER, U_ALICE], teamManagers: [{ id: U_OWNER, name: 'Owner' }] }],
    clients: [{ id: CLIENT1, name: 'ACME Corp', workspaceId: WS, archived: false, address: 'Rua 1', email: 'acme@example.com', ccEmails: ['cc@example.com'], note: 'vip', currencyId: id('cc', 1), currencyCode: 'USD' }],
    projects: [
      { id: PROJ1, name: 'Website', workspaceId: WS, clientId: CLIENT1, clientName: 'ACME Corp', color: '#FF5722', billable: true, public: true, archived: false, template: false, note: 'main project', hourlyRate: { amount: 5000, currency: 'USD' }, costRate: { amount: 2000, currency: 'USD' }, estimate: { estimate: 'PT100H', type: 'MANUAL' }, timeEstimate: { estimate: 'PT100H', type: 'MANUAL', active: true, includeNonBillable: true, resetOption: null }, budgetEstimate: { estimate: 1000000, type: 'MANUAL', active: true, includeExpenses: false, resetOption: null }, memberships: [{ userId: U_OWNER, membershipType: 'PROJECT', membershipStatus: 'ACTIVE', targetId: PROJ1, hourlyRate: { amount: 5500, currency: 'USD' }, costRate: null }, { userId: GROUP1, membershipType: 'USERGROUP', membershipStatus: 'ACTIVE', targetId: PROJ1 }], tasks: [] },
      { id: PROJ2, name: 'Legacy', workspaceId: WS, clientId: '', clientName: '', color: '#607D8B', billable: false, public: false, archived: true, template: false, note: '', hourlyRate: null, costRate: null, estimate: { estimate: 'PT0S', type: 'AUTO' }, timeEstimate: { estimate: 'PT0S', type: 'AUTO', active: false }, budgetEstimate: { estimate: 0, type: 'AUTO', active: false }, memberships: [{ userId: U_ALICE, membershipType: 'PROJECT', membershipStatus: 'ACTIVE', targetId: PROJ2 }] },
    ],
    tasks: {
      [PROJ1]: [{ id: TASK1, name: 'Design', projectId: PROJ1, status: 'ACTIVE', estimate: 'PT10H', budgetEstimate: 0, billable: true, hourlyRate: { amount: 7000, currency: 'USD' }, assigneeIds: [U_OWNER], userGroupIds: [] }],
      [PROJ2]: [{ id: TASK2, name: 'Cleanup', projectId: PROJ2, status: 'DONE', estimate: 'PT0S', assigneeIds: [], userGroupIds: [GROUP1] }],
    },
    tags: [{ id: TAG1, name: 'frontend', workspaceId: WS, archived: false }, { id: TAG2, name: 'old', workspaceId: WS, archived: true }],
    customFields: [{ id: CF1, name: 'PO', workspaceId: WS, type: 'TXT', entityType: 'TIMEENTRY', placeholder: 'PO number', description: '', allowedValues: [], workspaceDefaultValue: null, projectDefaultValues: [{ projectId: PROJ1, value: 'PO-DEFAULT', status: 'VISIBLE' }], status: 'VISIBLE', required: false, onlyAdminCanEdit: false }],
    entries,
    categories: [{ id: CAT1, name: 'Travel', workspaceId: WS, archived: false, hasUnitPrice: false, priceInCents: 0, unit: '' }],
    expenses: [{ id: EXP1, workspaceId: WS, userId: U_ALICE, date: '2024-02-10', project: { id: PROJ1, name: 'Website' }, task: null, category: { id: CAT1, name: 'Travel' }, notes: 'Taxi', quantity: 1, total: 42.5, billable: true, fileId: FILE1, fileName: 'taxi.pdf', locked: false }],
    holidays: [{ id: HOL1, name: 'Carnaval', workspaceId: WS, datePeriod: { startDate: '2025-03-03', endDate: '2025-03-04' }, occursAnnually: false, everyoneIncludingNew: true, automaticTimeEntryCreation: false, projectId: null, taskId: null, userIds: [U_OWNER], userGroupIds: [GROUP1] }],
    policies: [{ id: POL1, name: 'Férias', workspaceId: WS, color: '#4CAF50', timeUnit: 'DAYS', allowHalfDay: true, allowNegativeBalance: false, negativeBalance: null, approve: { requiresApproval: true, teamManagers: true, specificMembers: false, userIds: [] }, automaticAccrual: { amount: 2.5, period: 'MONTH', timeUnit: 'DAYS' }, automaticTimeEntryCreation: { enabled: true, defaultEntities: { projectId: PROJ1, taskId: null } }, everyoneIncludingNew: true, archived: false, userIds: [U_OWNER, U_ALICE], userGroupIds: [] }],
    balances: { [POL1]: [{ id: BAL1, policyId: POL1, userId: U_ALICE, total: 30, used: 5, balance: 25, workspaceId: WS }] },
    timeOffRequests: [{ id: TOR1, workspaceId: WS, policyId: POL1, userId: U_ALICE, requesterUserId: U_ALICE, status: { statusType: 'APPROVED', note: 'ok', changedAt: '2024-07-01T10:00:00Z', changedByUserId: U_OWNER }, timeOffPeriod: { period: { start: '2024-07-15T00:00:00Z', end: '2024-07-19T23:59:59Z' }, halfDay: false, halfDayPeriod: null }, balanceDiff: -5, note: 'praia', timeUnit: 'DAYS', createdAt: '2024-06-20T10:00:00Z' }],
    approvals: [{ approvalRequest: { id: APR1, workspaceId: WS, dateRange: { start: '2024-01-01T00:00:00Z', end: '2024-01-07T23:59:59Z' }, owner: { userId: U_OWNER, userName: 'Owner', timeZone: 'America/Sao_Paulo', startOfWeek: 'MONDAY' }, creator: { userId: U_OWNER }, status: { state: 'APPROVED', note: 'fine', updatedAt: '2024-01-08T10:00:00Z', updatedBy: U_OWNER } }, entries: [{ id: TE(1) }], expenses: [] }],
    assignments: [{ id: ASG1, workspaceId: WS, userId: U_OWNER, projectId: PROJ1, taskId: TASK1, period: { start: '2025-05-05T00:00:00Z', end: '2025-05-09T00:00:00Z' }, hoursPerDay: 6, startTime: '09:00', note: 'sprint', billable: true }],
    invoices: [{ id: INV1, number: 'INV-001', clientId: CLIENT1, clientName: 'ACME Corp', currency: 'USD', issuedDate: '2024-04-01T00:00:00Z', dueDate: '2024-04-30T00:00:00Z', status: 'SENT', amount: 150000, balance: 100000, paid: 50000 }],
    invoiceDetails: { [INV1]: { id: INV1, number: 'INV-001', clientId: CLIENT1, clientAddress: 'Rua 1', billFrom: 'Clockfy Ltda', currency: 'USD', issuedDate: '2024-04-01T00:00:00Z', dueDate: '2024-04-30T00:00:00Z', status: 'SENT', subject: 'April', note: 'thanks', discount: 0, tax: 10, tax2: 0, taxType: 'SIMPLE', calculationType: 'NET', userId: U_OWNER, visibleZeroFields: {}, items: [{ order: 0, itemType: 'Time', description: 'Homepage', quantity: 1, unitPrice: 150000, amount: 150000, applyTaxes: 'TAX1', importType: 'TIME_ENTRY_IMPORT', timeEntryIds: [TE(1)], expenseIds: [] }] } },
    payments: { [INV1]: [{ id: PAY1, amount: 50000, date: '2024-04-10T00:00:00Z', note: 'partial', author: U_OWNER }] },
    webhooks: [{ id: WH1, name: 'zap', url: 'https://hooks.example.com/x', webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [WS], triggerSourceType: 'WORKSPACE_ID', authToken: 'tok', enabled: true, deliveryEnabled: true, userId: U_OWNER, workspaceId: WS }],
  };
}

// A workspace with the cases that silently lose history when handled naively: a kiosk-only "limited" user without
// e-mail (left out of the default users listing), a deleted account, a person removed from the workspace (only the
// detailed report still shows their entries), an expense of another removed person, a user whose entries exceed the
// server's silent page-size cap, and a FREE plan (detailed report limited to 31-day periods).
function buildRealisticFixture(seed, { ownerEmail, ownerId, name }) {
  const id = (kind, n) => hex(seed, kind, n);
  const WS = id('00', 1);
  const U_OWNER = ownerId; const U_KIOSK = id('a0', 2); const U_BULK = id('a0', 3); const U_GONE = id('a0', 4); const U_EXP_ONLY = id('a0', 5); const U_DELETED = id('a0', 6);
  const PROJ = id('b0', 1);
  const entries = [];
  const add = (userId, start, minutes) => {
    const s = new Date(start); const e = new Date(s.getTime() + minutes * 60000);
    const n = entries.length + 1;
    entries.push({ id: id('10', n), userId, projectId: PROJ, taskId: null, tagIds: [], billable: true, description: `entry ${n}`, type: 'REGULAR', isLocked: false, timeInterval: { start: s.toISOString().replace('.000Z', 'Z'), end: e.toISOString().replace('.000Z', 'Z'), duration: `PT${minutes}M` }, customFieldValues: [] });
  };
  add(U_OWNER, '2023-03-01T10:00:00Z', 60); add(U_OWNER, '2024-03-01T10:00:00Z', 30);
  add(U_KIOSK, '2024-05-02T08:00:00Z', 240); add(U_KIOSK, '2024-05-03T08:00:00Z', 480);
  add(U_GONE, '2021-07-01T09:00:00Z', 90); add(U_GONE, '2021-07-02T09:00:00Z', 45); add(U_GONE, '2022-06-10T09:00:00Z', 120);
  add(U_DELETED, '2020-02-02T10:00:00Z', 60);
  for (let i = 0; i < 450; i++) add(U_BULK, new Date(Date.UTC(2022, 0, 1, 8) + i * 2 * 3600000), 30);
  const member = (userId, status = 'ACTIVE') => [{ userId, membershipType: 'WORKSPACE', membershipStatus: status, targetId: WS }];
  return {
    ids: { WS, U_OWNER, U_KIOSK, U_BULK, U_GONE, U_EXP_ONLY, U_DELETED, PROJ, EXP1: id('21', 1) },
    freePlan: true, pageCap: 200, reportCap: 200,
    me: null,
    workspace: { id: WS, name, hourlyRate: { amount: 0, currency: 'BRL' }, costRate: { amount: 0, currency: 'BRL' }, currencies: [{ id: id('cc', 1), code: 'BRL', isDefault: true }], memberships: member(U_OWNER), workspaceSettings: { forceProjects: false }, features: [] },
    users: [
      { id: U_OWNER, email: ownerEmail, name: 'Owner', status: 'ACTIVE', settings: { timeZone: 'America/Sao_Paulo' }, memberships: member(U_OWNER), roles: [{ role: { id: id('ff', 1), name: 'OWNER' } }, { role: { id: id('ff', 2), name: 'WORKSPACE_ADMIN' } }], customFields: [] },
      { id: U_KIOSK, email: null, name: 'Kiosk Kim', status: 'LIMITED', settings: {}, memberships: member(U_KIOSK), roles: [], customFields: [] },
      { id: U_BULK, email: 'bulk-c@test.dev', name: 'Bulk Bia', status: 'ACTIVE', settings: { timeZone: 'UTC' }, memberships: member(U_BULK), roles: [], customFields: [] },
      { id: U_DELETED, email: 'deleted-user@test.dev', name: 'Dora Deleted', status: 'DELETED', settings: {}, memberships: member(U_DELETED, 'INACTIVE'), roles: [], customFields: [] },
    ],
    removedUsers: [{ id: U_GONE, name: 'Gabriel Gone', email: 'gabriel-gone@test.dev' }],
    groups: [], clients: [],
    projects: [{ id: PROJ, name: 'Operação', workspaceId: WS, clientId: '', clientName: '', color: '#2196F3', billable: true, public: true, archived: false, template: false, note: '', hourlyRate: null, costRate: null, estimate: { estimate: 'PT0S', type: 'AUTO' }, memberships: [] }],
    tasks: {}, tags: [], customFields: [], entries, categories: [],
    expenses: [{ id: id('21', 1), workspaceId: WS, userId: U_EXP_ONLY, date: '2023-08-08', project: { id: PROJ, name: 'Operação' }, task: null, category: null, notes: 'Hotel', quantity: 1, total: 300, billable: false, locked: false }],
    holidays: [], policies: [], balances: {}, timeOffRequests: [], approvals: [], assignments: [], invoices: [], invoiceDetails: {}, payments: {}, webhooks: [],
  };
}

function startMockClockify(fixtures) {
  const state = { requests: 0, tagsRateLimited: false, log: [], reports: [] };
  // `cap` emulates a server that silently returns fewer items per page than requested
  const paginate = (list, q, cap = Infinity) => {
    const page = Math.max(1, parseInt(q.get('page') || '1', 10));
    const size = Math.min(cap, Math.max(1, parseInt(q.get('page-size') || q.get('pageSize') || '50', 10)));
    return list.slice((page - 1) * size, page * size);
  };
  const seconds = (e) => Math.round((new Date(e.timeInterval.end) - new Date(e.timeInterval.start)) / 1000);
  const detailedReport = (f, body) => {
    const start = new Date(body.dateRangeStart); const end = new Date(body.dateRangeEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !body.detailedFilter) return [400, { message: 'dateRangeStart, dateRangeEnd and detailedFilter are required', code: 501 }];
    if (f.freePlan && end - start > 31 * 86400000) return [400, { message: 'Detailed report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).', code: 501 }];
    const allUsers = body.users?.contains === 'DOES_NOT_CONTAIN' && !(body.users.ids || []).length && body.users.status === 'ALL';
    const listed = new Set(f.users.map((u) => u.id));
    const list = f.entries
      .filter((e) => e.timeInterval.end && new Date(e.timeInterval.start) >= start && new Date(e.timeInterval.start) <= end)
      .filter((e) => allUsers || listed.has(e.userId))
      .sort((a, b) => new Date(a.timeInterval.start) - new Date(b.timeInterval.start));
    const page = body.detailedFilter.page || 1;
    const size = Math.min(f.reportCap || 1000, body.detailedFilter.pageSize || 50);
    const person = (uid) => f.users.find((u) => u.id === uid) || (f.removedUsers || []).find((u) => u.id === uid) || {};
    return [200, {
      totals: body.detailedFilter.options?.totals === 'EXCLUDE' ? [] : [{ _id: '', totalTime: list.reduce((t, e) => t + seconds(e), 0), entriesCount: list.length }],
      timeEntries: list.slice((page - 1) * size, page * size).map((e) => ({
        _id: e.id, description: e.description, userId: e.userId, userName: person(e.userId).name || '', userEmail: person(e.userId).email || '',
        billable: e.billable, projectId: e.projectId, taskId: e.taskId, tags: (e.tagIds || []).map((t) => ({ id: t, name: t })), type: e.type, isLocked: e.isLocked,
        timeInterval: { start: e.timeInterval.start.replace('Z', '+00:00'), end: e.timeInterval.end.replace('Z', '+00:00'), duration: seconds(e) }, customFields: [],
      })),
    }];
  };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const url = new URL(req.url, 'http://mock');
    const q = url.searchParams;
    state.log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body))); };
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { message: 'Api key does not exist', code: 1000 });
    let bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      const body = bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) : {};
      const report = /^\/report\/v1\/workspaces\/([a-f0-9]{24})\/reports\/detailed$/.exec(url.pathname);
      if (report && req.method === 'POST') {
        const f = fixtures.find((x) => x.ids.WS === report[1]);
        if (!f) return send(403, { message: 'no access', code: 403 });
        state.reports.push({ ws: report[1], body });
        const [status, payload] = detailedReport(f, body);
        return send(status, payload);
      }
      const p = url.pathname.replace(/^\/api\/v1/, '');
      if (p === '/user') return send(200, fixtures[0].me);
      if (p === '/workspaces') return send(200, fixtures.map((f) => f.workspace));
      const m = /^\/workspaces\/([a-f0-9]{24})(\/.*)?$/.exec(p);
      if (!m) return send(404, { message: 'not found', code: 404 });
      const f = fixtures.find((x) => x.ids.WS === m[1]);
      if (!f) return send(403, { message: 'no access', code: 403 });
      const rest = m[2] || '';
      const bool = (v) => v === 'true';
      if (rest === '') return send(200, f.workspace);
      if (rest === '/users') {
        // like Clockify: without account-statuses only ACTIVE, PENDING_EMAIL_VERIFICATION and NOT_REGISTERED accounts
        const statuses = q.get('account-statuses') ? q.get('account-statuses').split(',') : ['ACTIVE', 'PENDING_EMAIL_VERIFICATION', 'NOT_REGISTERED'];
        return send(200, paginate(f.users.filter((u) => statuses.includes(u.status || 'ACTIVE')), q));
      }
      if (/^\/member-profile\//.test(rest)) return send(200, { weekStart: 'MONDAY', workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], workCapacity: 'PT8H' });
      if (rest === '/user-groups') return send(200, paginate(f.groups, q));
      if (rest === '/clients') return send(200, paginate(f.clients.filter((c) => c.archived === bool(q.get('archived'))), q));
      if (rest === '/projects') return send(200, paginate(f.projects.filter((x) => x.archived === bool(q.get('archived')) && !!x.template === bool(q.get('is-template'))), q));
      let mm;
      if ((mm = /^\/projects\/([a-f0-9]{24})\/tasks$/.exec(rest))) {
        const active = q.get('is-active') == null ? null : bool(q.get('is-active'));
        return send(200, paginate((f.tasks[mm[1]] || []).filter((t) => active == null || (t.status === 'ACTIVE') === active), q));
      }
      if (rest === '/tags') {
        if (!state.tagsRateLimited) { state.tagsRateLimited = true; return send(429, { message: 'Too many requests' }, { 'Retry-After': '0' }); }
        return send(200, paginate(f.tags.filter((t) => t.archived === bool(q.get('archived'))), q));
      }
      if (rest === '/custom-fields') return send(200, f.customFields);
      if ((mm = /^\/user\/([a-f0-9]{24})\/time-entries$/.exec(rest))) {
        let list = f.entries.filter((e) => e.userId === mm[1]);
        if (q.get('in-progress') === 'true') list = list.filter((e) => !e.timeInterval.end);
        else {
          if (q.get('start')) list = list.filter((e) => new Date(e.timeInterval.start) >= new Date(q.get('start')));
          if (q.get('end')) list = list.filter((e) => new Date(e.timeInterval.start) < new Date(q.get('end')));
        }
        return send(200, paginate(list, q, f.pageCap));
      }
      if (rest === '/expenses/categories') return send(200, { categories: paginate(f.categories.filter((c) => c.archived === bool(q.get('archived'))), q), count: f.categories.length });
      if (rest === '/expenses') { const list = f.expenses.filter((x) => !q.get('user-id') || x.userId === q.get('user-id')); return send(200, { expenses: { expenses: paginate(list, q), count: list.length }, dailyTotals: [], weeklyTotals: [] }); }
      if ((mm = /^\/expenses\/([a-f0-9]{24})\/files\/([a-f0-9]{24})$/.exec(rest))) return send(200, Buffer.from('%PDF-1.4 mock receipt'), { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="taxi.pdf"' });
      if (rest === '/holidays') return send(200, f.holidays);
      if (rest === '/time-off/policies') return send(200, paginate(f.policies, q));
      if ((mm = /^\/time-off\/balance\/policy\/([a-f0-9]{24})$/.exec(rest))) return send(200, { balances: paginate(f.balances[mm[1]] || [], q), count: (f.balances[mm[1]] || []).length });
      if (rest === '/time-off/requests' && req.method === 'POST') {
        const list = f.timeOffRequests.filter((r) => (!body.start || new Date(r.timeOffPeriod.period.start) >= new Date(body.start)) && (!body.end || new Date(r.timeOffPeriod.period.start) < new Date(body.end)));
        const page = body.page || 1; const size = body.pageSize || 50;
        return send(200, { requests: list.slice((page - 1) * size, page * size), count: list.length });
      }
      if (rest === '/approval-requests') return send(200, paginate(f.approvals.filter((a) => a.approvalRequest.status.state === q.get('status')), q));
      if (rest === '/scheduling/assignments/all') return send(200, paginate(f.assignments.filter((a) => new Date(a.period.start) >= new Date(q.get('start')) && new Date(a.period.start) < new Date(q.get('end'))), q));
      if (rest === '/invoices') return send(200, { invoices: paginate(f.invoices, q), total: f.invoices.length });
      if ((mm = /^\/invoices\/([a-f0-9]{24})\/payments$/.exec(rest))) return send(200, paginate(f.payments[mm[1]] || [], q));
      if ((mm = /^\/invoices\/([a-f0-9]{24})$/.exec(rest))) return send(200, f.invoiceDetails[mm[1]] || { message: 'not found' });
      if (rest === '/webhooks') return send(200, { webhooks: f.webhooks, workspaceWebhookCount: f.webhooks.length });
      return send(404, { message: `no route for ${req.method} ${p}`, code: 404 });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/api/v1` })));
}

// ---------------------------------------------------------------------------------------------------------------

let t; let owner; let mock; let A; let B; let C;
before(async () => {
  t = await setupTestApp('importer');
  owner = await t.register({ email: OWNER_EMAIL, name: 'Local Owner', workspaceName: 'Local WS' });
  A = buildFixture('a1', { ownerEmail: OWNER_EMAIL, name: 'Clockify WS A' });
  B = buildFixture('b2', { ownerEmail: OWNER_EMAIL, name: 'Clockify WS B' });
  C = buildRealisticFixture('c3', { ownerEmail: OWNER_EMAIL, ownerId: A.ids.U_OWNER, name: 'Clockify WS C (FREE)' });
  mock = await startMockClockify([A, B, C]);
});
after(async () => {
  const { waitForRunningJobs } = await import('../src/modules/importer/service.js');
  await waitForRunningJobs();
  await new Promise((resolve) => mock.server.close(resolve));
  await t.close();
});

async function waitJob(call, ws, jobId, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    const r = await call('GET', `/api/v1/workspaces/${ws}/import/jobs/${jobId}`);
    assert.equal(r.status, 200);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(r.data.status)) return r.data;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(r.data.progress)}\n${(r.data.log || []).join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const count = async (sql, params) => Number((await t.db.one(sql, params)).c);

test('lists Clockify workspaces for an API key and rejects bad keys', async () => {
  const ws = owner.workspaceId;
  const ok = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify/workspaces`, { apiKey: API_KEY, baseUrl: mock.baseUrl });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(Array.isArray(ok.data));
  assert.deepEqual(ok.data.map((w) => w.id), [A.ids.WS, B.ids.WS, C.ids.WS]);
  assert.equal(ok.data[0].name, 'Clockify WS A');
  assert.equal(ok.data[0].apiUser.email, OWNER_EMAIL);
  assert.equal(ok.data[0].access, 'ADMIN', 'the key owner is WORKSPACE_ADMIN in A');
  assert.equal(ok.data[2].access, 'ADMIN', 'roles in the { role: { name } } shape (OWNER)');
  assert.equal(ok.data[0].apiEndpoint.baseUrl, mock.baseUrl);
  const viaGet = await owner.call('GET', `/api/v1/workspaces/${ws}/import/clockify/workspaces?apiKey=${API_KEY}&baseUrl=${encodeURIComponent(mock.baseUrl)}`);
  assert.equal(viaGet.status, 200, viaGet.text);
  assert.equal(viaGet.data.length, 3);
  const bad = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify/workspaces`, { apiKey: 'wrong-key-1234', baseUrl: mock.baseUrl });
  assert.equal(bad.status, 400);
  const entities = await owner.call('GET', '/api/v1/import/entities');
  assert.equal(entities.status, 200);
  assert.ok(entities.data.entities.includes('timeEntries'));
});

test('non-admins cannot start imports', async () => {
  const ws = owner.workspaceId;
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member-import@test.dev' });
  const member = await t.register({ email: 'member-import@test.dev', name: 'Member' });
  const r = await member.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, ratePerSecond: 100 });
  assert.equal(r.status, 403);
});

test('dryRun counts everything without writing', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, dryRun: true, pageSize: 2, ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  assert.ok(r.data.jobId);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  assert.equal(job.progress.dryRun, true);
  assert.ok(job.progress.requests.retries >= 1, 'retry after the mocked 429 expected');
  assert.equal(job.progress.counts.projects, 2);
  assert.equal(job.progress.counts.timeEntries, 5);
  assert.equal(job.progress.counts.users, 2);
  assert.equal(job.progress.details.users.created, 1);
  assert.equal(job.progress.details.users.updated, 1);
  assert.equal(await count('SELECT count(*)::int AS c FROM projects WHERE workspace_id = $1', [ws]), 0);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [ws]), 0);
  assert.equal(await count("SELECT count(*)::int AS c FROM users WHERE email = 'alice-import@test.dev'"), 0);
  assert.equal(job.options.apiKey, undefined);
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/import/jobs`);
  assert.equal(list.status, 200);
  assert.ok(list.data.some((j) => j.id === r.data.jobId));
  assert.ok(list.data.every((j) => j.options.apiKey === undefined));
});

test('imports a Clockify workspace preserving ids and mapping the importer by e-mail', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, pageSize: 2, ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  const failed = Object.entries(job.progress.stages).filter(([, s]) => s.status === 'FAILED');
  assert.deepEqual(failed, [], job.log.join('\n'));

  // users mapped by e-mail / created with the same id
  assert.equal(job.progress.userMap[A.ids.U_OWNER], owner.user.id);
  assert.equal(job.progress.userMap[A.ids.U_ALICE], A.ids.U_ALICE);
  const alice = await t.db.one('SELECT * FROM users WHERE id = $1', [A.ids.U_ALICE]);
  assert.equal(alice.email, 'alice-import@test.dev');
  assert.equal(alice.status, 'PENDING_EMAIL_VERIFICATION');
  assert.equal(alice.password_hash, null);
  const aliceMember = await t.db.one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, A.ids.U_ALICE]);
  assert.equal(aliceMember.status, 'INACTIVE');
  assert.equal(aliceMember.hourly_rate_amount, 3000);
  const ownerMember = await t.db.one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, owner.user.id]);
  assert.equal(ownerMember.status, 'ACTIVE');
  assert.equal(ownerMember.hourly_rate_amount, 6000);
  const pmRole = await t.db.one("SELECT * FROM roles WHERE workspace_id = $1 AND user_id = $2 AND role = 'PROJECT_MANAGER'", [ws, A.ids.U_ALICE]);
  assert.equal(pmRole.entity_id, A.ids.PROJ2);

  // projects / tasks / tags / clients / custom fields with the same ids via the public API
  const project = await owner.call('GET', `/api/v1/workspaces/${ws}/projects/${A.ids.PROJ1}?hydrated=true`);
  assert.equal(project.status, 200, project.text);
  assert.equal(project.data.name, 'Website');
  assert.equal(project.data.clientId, A.ids.CLIENT1);
  assert.equal(project.data.hourlyRate.amount, 5000);
  assert.equal(project.data.timeEstimate.estimate, 'PT100H');
  assert.equal(project.data.budgetEstimate.estimate, 1000000);
  assert.ok(project.data.memberships.some((m) => m.userId === owner.user.id && m.hourlyRate.amount === 5500));
  assert.ok(project.data.memberships.some((m) => m.userId === A.ids.GROUP1 && m.membershipType === 'USERGROUP'));
  assert.ok(project.data.tasks.some((x) => x.id === A.ids.TASK1 && x.hourlyRate.amount === 7000 && x.assigneeIds.includes(owner.user.id)));
  const archived = await owner.call('GET', `/api/v1/workspaces/${ws}/projects/${A.ids.PROJ2}`);
  assert.equal(archived.status, 200);
  assert.equal(archived.data.archived, true);
  const tag = await owner.call('GET', `/api/v1/workspaces/${ws}/tags/${A.ids.TAG1}`);
  assert.equal(tag.status, 200);
  assert.equal(tag.data.name, 'frontend');
  const client = await owner.call('GET', `/api/v1/workspaces/${ws}/clients/${A.ids.CLIENT1}`);
  assert.equal(client.status, 200);
  assert.deepEqual(client.data.ccEmails, ['cc@example.com']);
  const cf = await owner.call('GET', `/api/v1/workspaces/${ws}/custom-fields/${A.ids.CF1}`);
  assert.equal(cf.status, 200);
  assert.equal(cf.data.projectDefaultValues[0].projectId, A.ids.PROJ1);
  const groups = await owner.call('GET', `/api/v1/workspaces/${ws}/user-groups`);
  assert.ok(groups.data.some((g) => g.id === A.ids.GROUP1 && g.userIds.includes(owner.user.id) && g.userIds.includes(A.ids.U_ALICE)));

  // time entries keep ids, user mapping, tags, custom fields and rates
  const te1 = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${A.ids.TE1}`);
  assert.equal(te1.status, 200, te1.text);
  assert.equal(te1.data.userId, owner.user.id);
  assert.equal(te1.data.projectId, A.ids.PROJ1);
  assert.equal(te1.data.taskId, A.ids.TASK1);
  assert.deepEqual(te1.data.tagIds, [A.ids.TAG1]);
  assert.equal(te1.data.timeInterval.duration, 'PT1H30M');
  assert.equal(te1.data.hourlyRate.amount, 5000);
  assert.equal(te1.data.customFieldValues[0].customFieldId, A.ids.CF1);
  assert.equal(te1.data.customFieldValues[0].value, 'PO-42');
  assert.equal(te1.data.approvalStatus, 'APPROVED');
  assert.equal(te1.data.invoiced, true);
  const te2 = await t.db.one('SELECT * FROM time_entries WHERE id = $1', [A.ids.TE2]);
  assert.equal(te2.locked, true);
  assert.equal(te2.origin, 'IMPORT');
  assert.equal(te2.hourly_rate_amount, 5500, 'rate resolved from project membership when Clockify sends none');
  const te3 = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${A.ids.TE3}`);
  assert.equal(te3.status, 200);
  assert.equal(te3.data.timeInterval.end, null, 'running timer imported');
  const te4 = await t.db.one('SELECT * FROM time_entries WHERE id = $1', [A.ids.TE4]);
  assert.equal(te4.user_id, A.ids.U_ALICE);
  assert.equal(te4.project_id, A.ids.PROJ2);
  const te5 = await t.db.one('SELECT * FROM time_entries WHERE id = $1', [A.ids.TE5]);
  assert.equal(te5.type, 'BREAK');
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [ws]), 5);

  // workspace settings applied
  const wsDto = await owner.call('GET', `/api/v1/workspaces/${ws}`);
  assert.equal(wsDto.data.workspaceSettings.forceProjects, true);
  assert.equal(wsDto.data.workspaceSettings.projectLabel, 'projeto');
  assert.equal(wsDto.data.hourlyRate.amount, 4000);
  assert.ok(wsDto.data.currencies.some((c) => c.code === 'BRL'));

  // other entities
  const exp = await t.db.one('SELECT * FROM expenses WHERE id = $1', [A.ids.EXP1]);
  assert.equal(exp.user_id, A.ids.U_ALICE);
  assert.equal(exp.category_id, A.ids.CAT1);
  assert.equal(exp.file_id, A.ids.FILE1);
  assert.equal(Number(exp.total), 42.5);
  const file = await t.db.one('SELECT name, mime_type, size FROM files WHERE id = $1', [A.ids.FILE1]);
  assert.equal(file.mime_type, 'application/pdf');
  assert.ok(file.size > 0);
  const hol = await t.db.one("SELECT *, to_char(start_date, 'YYYY-MM-DD') AS sd, to_char(end_date, 'YYYY-MM-DD') AS ed FROM holidays WHERE id = $1", [A.ids.HOL1]);
  assert.equal(hol.name, 'Carnaval');
  assert.equal(hol.sd, '2025-03-03');
  assert.equal(hol.ed, '2025-03-04');
  assert.equal(await count('SELECT count(*)::int AS c FROM holiday_users WHERE holiday_id = $1', [A.ids.HOL1]), 1);
  const pol = await t.db.one('SELECT * FROM time_off_policies WHERE id = $1', [A.ids.POL1]);
  assert.equal(pol.automatic_accrual.amount, 2.5);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_off_policy_users WHERE policy_id = $1', [A.ids.POL1]), 2);
  const bal = await t.db.one('SELECT * FROM time_off_balances WHERE policy_id = $1 AND user_id = $2', [A.ids.POL1, A.ids.U_ALICE]);
  assert.equal(Number(bal.total), 30);
  const tor = await t.db.one('SELECT * FROM time_off_requests WHERE id = $1', [A.ids.TOR1]);
  assert.equal(tor.status, 'APPROVED');
  assert.equal(tor.status_changed_by, owner.user.id);
  const apr = await t.db.one('SELECT * FROM approval_requests WHERE id = $1', [A.ids.APR1]);
  assert.equal(apr.owner_user_id, owner.user.id);
  assert.equal(apr.state, 'APPROVED');
  const asg = await t.db.one('SELECT * FROM scheduling_assignments WHERE id = $1', [A.ids.ASG1]);
  assert.equal(asg.user_id, owner.user.id);
  assert.equal(Number(asg.hours_per_day), 6);
  const inv = await t.db.one('SELECT * FROM invoices WHERE id = $1', [A.ids.INV1]);
  assert.equal(inv.number, 'INV-001');
  assert.equal(inv.client_id, A.ids.CLIENT1);
  assert.equal(await count('SELECT count(*)::int AS c FROM invoice_items WHERE invoice_id = $1', [A.ids.INV1]), 1);
  assert.equal(await count('SELECT count(*)::int AS c FROM invoice_payments WHERE invoice_id = $1', [A.ids.INV1]), 1);
  const wh = await t.db.one('SELECT * FROM webhooks WHERE id = $1', [A.ids.WH1]);
  assert.equal(wh.enabled, false);
  assert.equal(wh.user_id, owner.user.id);
  assert.ok(await count("SELECT count(*)::int AS c FROM audit_log WHERE workspace_id = $1 AND action = 'CREATE_TIME_IMPORT'", [ws]) >= 1);
  assert.ok(await count("SELECT count(*)::int AS c FROM audit_log WHERE workspace_id = $1 AND action = 'IMPORT_PROJECTS'", [ws]) >= 1);
});

test('re-running the import is idempotent (no duplicates)', async () => {
  const ws = owner.workspaceId;
  const before = {
    entries: await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [ws]),
    projects: await count('SELECT count(*)::int AS c FROM projects WHERE workspace_id = $1', [ws]),
    tags: await count('SELECT count(*)::int AS c FROM tags WHERE workspace_id = $1', [ws]),
    members: await count('SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1', [ws]),
    expenses: await count('SELECT count(*)::int AS c FROM expenses WHERE workspace_id = $1', [ws]),
    tagLinks: await count('SELECT count(*)::int AS c FROM time_entry_tags tt JOIN time_entries e ON e.id = tt.time_entry_id WHERE e.workspace_id = $1', [ws]),
  };
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  assert.equal(job.progress.details.timeEntries.created, 0);
  assert.equal(job.progress.details.timeEntries.updated, 5);
  assert.equal(job.progress.details.projects.created, 0);
  assert.equal(job.progress.details.users.created, 0);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [ws]), before.entries);
  assert.equal(await count('SELECT count(*)::int AS c FROM projects WHERE workspace_id = $1', [ws]), before.projects);
  assert.equal(await count('SELECT count(*)::int AS c FROM tags WHERE workspace_id = $1', [ws]), before.tags);
  assert.equal(await count('SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1', [ws]), before.members);
  assert.equal(await count('SELECT count(*)::int AS c FROM expenses WHERE workspace_id = $1', [ws]), before.expenses);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entry_tags tt JOIN time_entries e ON e.id = tt.time_entry_id WHERE e.workspace_id = $1', [ws]), before.tagLinks);
  const cancel = await owner.call('POST', `/api/v1/workspaces/${ws}/import/jobs/${r.data.jobId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.running, false);
});

test('incremental sync with since only fetches newer time entries and selected entities', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, since: "2025-01-01", entities: ["timeEntries"], ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  assert.equal(job.progress.stages.projects.status, 'SKIPPED');
  // TE5 (2025-02-02) and the running timer (now) are within the window
  assert.equal(job.progress.details.timeEntries.fetched, 2);
});

test('NEW_WORKSPACE mode creates a local workspace with the Clockify id', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: B.ids.WS, mode: "NEW_WORKSPACE", ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  assert.equal(job.progress.targetWorkspaceId, B.ids.WS);
  const newWs = await owner.call('GET', `/api/v1/workspaces/${B.ids.WS}`);
  assert.equal(newWs.status, 200, newWs.text);
  assert.equal(newWs.data.name, 'Clockify WS B');
  assert.equal(newWs.data.ownerId, owner.user.id);
  assert.equal(newWs.data.workspaceSettings.forceProjects, true);
  const te = await owner.call('GET', `/api/v1/workspaces/${B.ids.WS}/time-entries/${B.ids.TE1}`);
  assert.equal(te.status, 200, te.text);
  assert.equal(te.data.userId, owner.user.id);
  assert.equal(te.data.projectId, B.ids.PROJ1);
  // Alice already exists locally (created by the first import) → mapped by e-mail to that account
  assert.equal(job.progress.userMap[B.ids.U_ALICE], A.ids.U_ALICE);
  const users = await owner.call('GET', `/api/v1/workspaces/${B.ids.WS}/users?status=ALL`);
  assert.ok(users.data.some((u) => u.id === A.ids.U_ALICE && u.email === 'alice-import@test.dev'));
  assert.equal(await count("SELECT count(*)::int AS c FROM users WHERE email = 'alice-import@test.dev'"), 1);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [B.ids.WS]), 5);
  // the same id already exists in another workspace → refused
  const dup = await t.register({ email: 'other-import@test.dev', name: 'Other', workspaceName: 'Other WS' });
  const roleAdmin = await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'other-import@test.dev' });
  assert.equal(roleAdmin.status, 200);
  await owner.call('POST', `/api/v1/workspaces/${ws}/users/${dup.user.id}/roles`, { role: 'WORKSPACE_ADMIN' });
  const r2 = await dup.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: B.ids.WS, mode: "NEW_WORKSPACE", ratePerSecond: 100 });
  assert.equal(r2.status, 202, r2.text);
  const job2 = await waitJob(dup.call, ws, r2.data.jobId);
  assert.equal(job2.status, 'FAILED');
  assert.match(job2.error, /belongs to another user/);
});

test('a running import can be cancelled cooperatively', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, ratePerSecond: 1 });
  assert.equal(r.status, 202, r.text);
  const busy = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS });
  assert.equal(busy.status, 409, 'only one import per workspace at a time');
  const cancel = await owner.call('POST', `/api/v1/workspaces/${ws}/import/jobs/${r.data.jobId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.running, true);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'CANCELLED');
  assert.equal(job.progress.cancelled, true);
  assert.ok(job.log.some((l) => /cancelada/.test(l)));
});

test('keeps the history of limited, deleted and removed users and reconciles with the detailed report', async () => {
  const ws = owner.workspaceId;
  const start = () => owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: C.ids.WS, mode: 'NEW_WORKSPACE', ratePerSecond: 100 });
  const r = await start();
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId, 90000);
  const log = job.log.join('\n');
  assert.equal(job.status, 'DONE', log);
  const P = job.progress;
  assert.equal(P.sourceAccess, 'ADMIN');
  const entriesOf = (uid) => count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1 AND user_id = $2', [C.ids.WS, uid]);
  const memberStatus = async (uid) => (await t.db.one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [C.ids.WS, uid])).status;

  // kiosk-only "limited" user without e-mail (absent from Clockify's default users listing)
  const kiosk = await t.db.one('SELECT * FROM users WHERE id = $1', [C.ids.U_KIOSK]);
  assert.equal(kiosk.email, `clockify-${C.ids.U_KIOSK}@sem-email.invalid`);
  assert.equal(kiosk.status, 'NOT_REGISTERED');
  assert.equal(kiosk.name, 'Kiosk Kim');
  assert.equal(await memberStatus(C.ids.U_KIOSK), 'ACTIVE');
  assert.equal(await entriesOf(C.ids.U_KIOSK), 2);

  // deleted account: history kept under a placeholder address, the real e-mail stays free for a sign-up
  const dora = await t.db.one('SELECT * FROM users WHERE id = $1', [C.ids.U_DELETED]);
  assert.equal(dora.status, 'DELETED');
  assert.match(dora.email, /@sem-email\.invalid$/);
  assert.equal(await count("SELECT count(*)::int AS c FROM users WHERE lower(email) = 'deleted-user@test.dev'"), 0);
  assert.equal(await memberStatus(C.ids.U_DELETED), 'INACTIVE');
  assert.equal(await entriesOf(C.ids.U_DELETED), 1);

  // removed from the workspace: only the detailed report still has their entries
  const gabriel = await t.db.one('SELECT * FROM users WHERE id = $1', [C.ids.U_GONE]);
  assert.equal(gabriel.email, 'gabriel-gone@test.dev');
  assert.equal(gabriel.name, 'Gabriel Gone');
  assert.equal(await memberStatus(C.ids.U_GONE), 'INACTIVE');
  assert.equal(await entriesOf(C.ids.U_GONE), 3);
  assert.ok(P.warnings.some((w) => /Gabriel Gone/.test(w)), P.warnings.join('\n'));

  // more entries than the server's silent page-size cap (200 per page although 1000 were asked)
  assert.equal(await entriesOf(C.ids.U_BULK), 450);
  assert.match(log, /no máximo 200 itens por página/);

  // expense of someone known only through that expense
  const exp = await t.db.one('SELECT * FROM expenses WHERE id = $1', [C.ids.EXP1]);
  assert.equal(exp.user_id, C.ids.U_EXP_ONLY);
  assert.match((await t.db.one('SELECT email FROM users WHERE id = $1', [C.ids.U_EXP_ONLY])).email, /@sem-email\.invalid$/);

  // reconciliation, user by user (FREE plan: yearly periods refused → 31-day periods)
  const rec = P.reconciliation;
  assert.ok(rec && !rec.error, JSON.stringify(rec));
  assert.equal(rec.clockify.entries, C.entries.length);
  assert.equal(rec.local.entries, C.entries.length);
  assert.equal(rec.missing, 0);
  assert.equal(rec.recovered, 3);
  assert.equal(rec.windowDays, 31);
  assert.equal(rec.allUsersFilter, true);
  assert.ok(Math.abs(rec.clockify.seconds - rec.local.seconds) < 1);
  const gone = rec.users.find((u) => u.userId === C.ids.U_GONE);
  assert.deepEqual([gone.clockify.entries, gone.local.entries, gone.email], [3, 3, 'gabriel-gone@test.dev']);
  assert.match(log, /31 dias/);
  assert.match(log, /Conferência OK/);
  assert.ok(mock.state.reports.some((x) => x.ws === C.ids.WS && x.body.users?.status === 'ALL'));

  // running it again duplicates nothing
  const r2 = await start();
  assert.equal(r2.status, 202, r2.text);
  const job2 = await waitJob(owner.call, ws, r2.data.jobId, 90000);
  assert.equal(job2.status, 'DONE', job2.log.join('\n'));
  assert.equal(job2.progress.reconciliation.missing, 0);
  assert.equal(job2.progress.details.timeEntries.created, 0);
  assert.equal(job2.progress.details.users.created, 0);
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [C.ids.WS]), C.entries.length);
});

test('a dry run reports what Clockify has without writing', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, dryRun: true, entities: ['users', 'timeEntries'], ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  const rec = job.progress.reconciliation;
  assert.equal(rec.clockify.entries, 4, 'the running timer is not in reports');
  assert.equal(rec.local, null);
  assert.equal(rec.missing, null);
});

test('importing an already imported Clockify workspace into another local workspace explains why nothing is copied', async () => {
  const ws = owner.workspaceId;
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, mode: 'NEW_WORKSPACE', entities: ['workspace', 'users', 'projects', 'timeEntries'], ratePerSecond: 100 });
  assert.equal(r.status, 202, r.text);
  const job = await waitJob(owner.call, ws, r.data.jobId);
  assert.equal(job.status, 'DONE', job.log.join('\n'));
  const w = job.progress.warnings.join('\n');
  assert.match(w, /já foi importado para o workspace local “Local WS”/);
  assert.match(w, /2 projeto\(s\), 5 registro\(s\) de tempo deste workspace do Clockify já existem em outro workspace local \(“Local WS”/);
  assert.equal(job.progress.reconciliation.missing, 4);
  assert.ok(!job.log.some((l) => /pertence a outro workspace/.test(l)), 'no line per record');
  assert.equal(await count('SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1', [A.ids.WS]), 0);
});

test('only Clockify addresses are accepted as the source server', async () => {
  const ws = owner.workspaceId;
  for (const baseUrl of ['http://169.254.169.254/latest/meta-data', 'http://localhost:5432', 'https://clockify.me.evil.example']) {
    const list = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify/workspaces`, { apiKey: API_KEY, baseUrl });
    assert.equal(list.status, 400, `${baseUrl}: ${list.text}`);
    assert.match(list.text, /clockify\.me/);
    const run = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl, sourceWorkspaceId: A.ids.WS });
    assert.equal(run.status, 400, `${baseUrl}: ${run.text}`);
  }
  const reports = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, reportsUrl: 'http://10.0.0.1/report/v1', sourceWorkspaceId: A.ids.WS });
  assert.equal(reports.status, 400, reports.text);
  const region = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, region: 'mars1', sourceWorkspaceId: A.ids.WS });
  assert.equal(region.status, 400, region.text);
});

test('imports left running by a dead process are marked FAILED; live ones block a second import', async () => {
  const ws = owner.workspaceId;
  const { hostname } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const insert = async (progress) => (await t.db.one(
    `INSERT INTO import_jobs (id, workspace_id, user_id, source, status, options, progress, log, started_at) VALUES ($1,$2,$3,'CLOCKIFY_API','RUNNING','{}',$4,'[]', now() - interval '1 hour') RETURNING id`,
    [randomBytes(12).toString('hex'), ws, owner.user.id, JSON.stringify(progress)],
  )).id;
  const now = new Date().toISOString();
  const deadPid = await insert({ stage: 'timeEntries', runner: { pid: 2147483646, host: hostname() }, heartbeatAt: now });
  const silent = await insert({ stage: 'users', runner: { pid: 1234, host: 'another-host' }, heartbeatAt: new Date(Date.now() - 10 * 60000).toISOString() });
  const alive = await insert({ stage: 'projects', runner: { pid: 1234, host: 'another-host' }, heartbeatAt: now });
  for (const id of [deadPid, silent]) {
    const j = await owner.call('GET', `/api/v1/workspaces/${ws}/import/jobs/${id}`);
    assert.equal(j.status, 200);
    assert.equal(j.data.status, 'FAILED');
    assert.equal(j.data.progress.interrupted, true);
    assert.match(j.data.error, /Interrupted/);
    assert.ok(j.data.log.some((l) => /interrompida/.test(l)));
  }
  const live = await owner.call('GET', `/api/v1/workspaces/${ws}/import/jobs/${alive}`);
  assert.equal(live.data.status, 'RUNNING');
  const busy = await owner.call('POST', `/api/v1/workspaces/${ws}/import/clockify`, { apiKey: API_KEY, baseUrl: mock.baseUrl, sourceWorkspaceId: A.ids.WS, ratePerSecond: 100 });
  assert.equal(busy.status, 409, busy.text);
  await t.db.query("UPDATE import_jobs SET status = 'FAILED', finished_at = now() WHERE id = $1", [alive]);
});

// ---------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------

async function postCsv(user, ws, content, fields = {}, { encoding = 'utf8', bom = false, fileName = 'export.csv' } = {}) {
  let buf = Buffer.from(content, encoding);
  if (bom) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'text/csv' }), fileName);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const res = await fetch(`${t.base}/api/v1/workspaces/${ws}/import/csv`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: fd });
  const data = await res.json();
  return { status: res.status, data };
}

test('imports an English detailed report CSV (12h times, MM/DD/YYYY, time zone)', async () => {
  const ws = owner.workspaceId;
  const csv = [
    '"Project","Client","Description","Task","User","Group","Email","Tags","Billable","Start Date","Start Time","End Date","End Time","Duration (h)","Duration (decimal)","Billable Rate (USD)","Billable Amount (USD)"',
    `"CSV Project","CSV Client","Write docs","Docs","Local Owner","","${OWNER_EMAIL}","docs, csv","Yes","01/15/2024","09:00:00 AM","01/15/2024","10:30:00 AM","01:30:00","1.50","50.00","75.00"`,
    `"CSV Project","CSV Client","Review","","Local Owner","","${OWNER_EMAIL}","","No","01/15/2024","01:00:00 PM","01/15/2024","01:45:00 PM","00:45:00","0.75","0.00","0.00"`,
    '"CSV Project","CSV Client","Carol work","Docs","Carol","","carol-import@test.dev","docs","Yes","01/16/2024","08:00:00 AM","01/16/2024","09:00:00 AM","01:00:00","1.00","50.00","50.00"',
  ].join('\r\n');
  const r = await postCsv(owner, ws, csv, { timeZone: 'America/Sao_Paulo', dateFormat: 'MM/DD/YYYY' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.format, 'DETAILED_REPORT');
  assert.equal(r.data.delimiter, ',');
  assert.equal(r.data.created, 3, JSON.stringify(r.data.errors));
  assert.deepEqual(r.data.errors, []);
  assert.equal(r.data.counts.users, 1);
  assert.equal(r.data.counts.projects, 1);
  assert.equal(r.data.counts.clients, 1);
  assert.equal(r.data.counts.tasks, 1);
  assert.equal(r.data.counts.tags, 2);
  const entries = await owner.call('GET', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries?hydrated=true&start=2024-01-15T00:00:00Z&end=2024-01-16T00:00:00Z`);
  assert.equal(entries.status, 200);
  const docs = entries.data.find((e) => e.description === 'Write docs');
  assert.ok(docs, 'entry created');
  assert.equal(docs.timeInterval.start, '2024-01-15T12:00:00Z');
  assert.equal(docs.timeInterval.duration, 'PT1H30M');
  assert.equal(docs.project.name, 'CSV Project');
  assert.equal(docs.project.clientName, 'CSV Client');
  assert.equal(docs.task.name, 'Docs');
  assert.equal(docs.billable, true);
  assert.equal(docs.hourlyRate.amount, 5000);
  assert.equal(docs.tags.length, 2);
  const review = entries.data.find((e) => e.description === 'Review');
  assert.equal(review.timeInterval.start, '2024-01-15T16:00:00Z');
  assert.equal(review.billable, false);
  const carol = await t.db.one("SELECT u.*, m.status AS member_status FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1 WHERE u.email = 'carol-import@test.dev'", [ws]);
  assert.equal(carol.status, 'PENDING_EMAIL_VERIFICATION');
  assert.equal(carol.member_status, 'ACTIVE');
  assert.equal(await count("SELECT count(*)::int AS c FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND origin = 'IMPORT'", [ws, carol.id]), 1);
  // dedupe on re-import
  const again = await postCsv(owner, ws, csv, { timeZone: 'America/Sao_Paulo', dateFormat: 'MM/DD/YYYY' });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, 0);
  assert.equal(again.data.skipped, 3);
  const job = await t.db.one('SELECT * FROM import_jobs WHERE id = $1', [r.data.jobId]);
  assert.equal(job.source, 'CLOCKIFY_CSV');
  assert.equal(job.status, 'DONE');
});

test('imports a Portuguese detailed report CSV (semicolon, DD/MM/YYYY, 24h, windows-1252)', async () => {
  const ws = owner.workspaceId;
  const csv = [
    'Projeto;Cliente;Descrição;Tarefa;Usuário;Grupo;E-mail;Etiquetas;Faturável;Data de início;Hora de início;Data de término;Hora de término;Duração (h);Duração (decimal);Taxa faturável (BRL);Valor faturável (BRL)',
    `Projeto PT;Cliente PT;Reunião de alinhamento;Análise;Local Owner;;${OWNER_EMAIL};reunião;Sim;20/02/2024;14:00:00;20/02/2024;15:30:00;01:30:00;1,50;120,00;180,00`,
    `Projeto PT;Cliente PT;Sem fim informado;;Local Owner;;${OWNER_EMAIL};;Não;21/02/2024;09:00:00;;;02:00:00;2,00;0,00;0,00`,
  ].join('\n');
  const r = await postCsv(owner, ws, csv, { timeZone: 'America/Sao_Paulo' }, { encoding: 'latin1', fileName: 'relatorio.csv' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.delimiter, ';');
  assert.equal(r.data.encoding, 'windows-1252');
  assert.equal(r.data.dateFormat, 'DD/MM/YYYY');
  assert.equal(r.data.created, 2, JSON.stringify(r.data.errors));
  const entries = await owner.call('GET', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries?hydrated=true&start=2024-02-20T00:00:00Z&end=2024-02-22T00:00:00Z`);
  const reuniao = entries.data.find((e) => e.description === 'Reunião de alinhamento');
  assert.ok(reuniao, 'accented description decoded');
  assert.equal(reuniao.timeInterval.start, '2024-02-20T17:00:00Z');
  assert.equal(reuniao.timeInterval.duration, 'PT1H30M');
  assert.equal(reuniao.project.name, 'Projeto PT');
  assert.equal(reuniao.task.name, 'Análise');
  assert.equal(reuniao.tags[0].name, 'reunião');
  assert.equal(reuniao.billable, true);
  assert.equal(reuniao.hourlyRate.amount, 12000);
  assert.equal(reuniao.hourlyRate.currency, 'BRL');
  const semFim = entries.data.find((e) => e.description === 'Sem fim informado');
  assert.equal(semFim.timeInterval.duration, 'PT2H', 'end derived from duration');
});

test('imports the Clockify time entry template (BOM, ISO dates) and supports dryRun', async () => {
  const ws = owner.workspaceId;
  const csv = [
    'Email,Project,Task,Client,Description,Tags,Billable,Start date,Start time,End date,End time,Duration',
    `${OWNER_EMAIL},Template Project,,,"From template, with comma",,true,2024-05-05,08:00,2024-05-05,09:15,`,
    `${OWNER_EMAIL},Template Project,,,Only duration,,false,2024-05-06,08:00,,,0.5`,
    `${OWNER_EMAIL},Template Project,,,Broken row,,false,not-a-date,08:00,,,1`,
  ].join('\n');
  const dry = await postCsv(owner, ws, csv, { timeZone: 'UTC', dryRun: 'true' }, { bom: true, fileName: 'template.csv' });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.format, 'TIMESHEET_TEMPLATE');
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.created, 2);
  assert.equal(dry.data.errors.length, 1);
  assert.equal(dry.data.errors[0].line, 4);
  assert.equal(await count("SELECT count(*)::int AS c FROM projects WHERE workspace_id = $1 AND name = 'Template Project'", [ws]), 0);
  const real = await postCsv(owner, ws, csv, { timeZone: 'UTC' }, { bom: true, fileName: 'template.csv' });
  assert.equal(real.status, 200);
  assert.equal(real.data.created, 2);
  assert.equal(real.data.errors.length, 1);
  const entries = await owner.call('GET', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries?start=2024-05-05T00:00:00Z&end=2024-05-07T00:00:00Z`);
  const a = entries.data.find((e) => e.description === 'From template, with comma');
  assert.equal(a.timeInterval.start, '2024-05-05T08:00:00Z');
  assert.equal(a.timeInterval.duration, 'PT1H15M');
  const b = entries.data.find((e) => e.description === 'Only duration');
  assert.equal(b.timeInterval.duration, 'PT30M');
  const missing = await postCsv(owner, ws, 'Foo,Bar\n1,2', {});
  assert.equal(missing.status, 400);
  const noFile = await fetch(`${t.base}/api/v1/workspaces/${ws}/import/csv`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: new FormData() });
  assert.equal(noFile.status, 400);
});
