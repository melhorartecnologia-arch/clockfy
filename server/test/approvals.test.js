import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

let t; let owner; let member; let manager; let other; let ws;
const EXPENSE_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';

before(async () => {
  t = await setupTestApp('approvals');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  const invite = async (email, name) => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email });
    assert.equal(r.status, 200);
    return t.register({ email, name });
  };
  member = await invite('member@test.dev', 'Member');
  manager = await invite('manager@test.dev', 'Manager');
  other = await invite('other@test.dev', 'Other');
  const role = await owner.call('POST', `/api/v1/workspaces/${ws}/users/${manager.user.id}/roles`, { role: 'TEAM_MANAGER', entityId: member.user.id });
  assert.equal(role.status, 201);
});
after(async () => { await t.close(); });

const api = (who) => (method, path, body) => who.call(method, `/api/v1/workspaces/${ws}${path}`, body);

test('submit weekly timesheet, approve (entries locked), withdraw approval and resubmit', async () => {
  const m = api(member);
  const e1 = await m('POST', '/time-entries', { start: '2026-03-03T09:00:00Z', end: '2026-03-03T11:00:00Z', description: 'work', billable: true });
  assert.equal(e1.status, 201);
  const e2 = await m('POST', '/time-entries', { start: '2026-03-04T09:00:00Z', end: '2026-03-04T10:30:00Z', description: 'more' });
  assert.equal(e2.status, 201);
  await t.db.query("INSERT INTO expenses (id, workspace_id, user_id, date, notes, quantity, total, billable) VALUES ($1,$2,$3,'2026-03-05','taxi',1,25.5,true)", [EXPENSE_ID, ws, member.user.id]);

  // a running timer inside the period blocks the submission
  const timer = await m('POST', '/time-entries', { start: '2026-03-06T08:00:00Z', description: 'running' });
  assert.equal(timer.status, 201);
  const blocked = await m('POST', '/approval-requests', { periodStart: '2026-03-04T00:00:00Z' });
  assert.equal(blocked.status, 400);
  const stopped = await m('PATCH', `/user/${member.user.id}/time-entries`, { end: '2026-03-06T09:00:00Z' });
  assert.equal(stopped.status, 200);

  const sub = await m('POST', '/approval-requests', { periodStart: '2026-03-04T00:00:00Z' });
  assert.equal(sub.status, 201, sub.text);
  assert.equal(sub.data.status.state, 'PENDING');
  assert.equal(sub.data.dateRange.start, '2026-03-02T00:00:00Z');
  assert.equal(sub.data.dateRange.end, '2026-03-08T23:59:59Z');
  assert.equal(sub.data.owner.userId, member.user.id);
  assert.equal(sub.data.owner.startOfWeek, 'MONDAY');
  assert.equal(sub.data.creator.userEmail, 'member@test.dev');
  const id = sub.data.id;

  // entries are pending and cannot be edited
  const got = await m('GET', `/time-entries/${e1.data.id}`);
  assert.equal(got.data.approvalStatus, 'PENDING');
  assert.equal(got.data.approvalRequestId, id);
  assert.equal(got.data.isLocked, true);
  const edit = await m('PUT', `/time-entries/${e1.data.id}`, { start: '2026-03-03T09:00:00Z', end: '2026-03-03T12:00:00Z', description: 'x' });
  assert.equal(edit.status, 403);
  const dup = await m('POST', '/approval-requests', { periodStart: '2026-03-05T00:00:00Z' });
  assert.equal(dup.status, 400);

  const details = await m('GET', `/approval-requests/${id}`);
  assert.equal(details.status, 200);
  assert.equal(details.data.approvalRequest.id, id);
  assert.equal(details.data.entries.length, 3);
  assert.equal(details.data.trackedTime, 'PT4H30M');
  assert.equal(details.data.pendingTime, 'PT4H30M');
  assert.equal(details.data.billableTime, 'PT2H');
  assert.equal(details.data.approvedTime, 'PT0S');
  assert.equal(details.data.expenses.length, 1);
  assert.equal(details.data.expenses[0].date, '2026-03-05');
  assert.equal(details.data.expenseTotal, 25.5);

  // permissions: owner of the request cannot approve; unrelated members see nothing
  const deny = await m('PATCH', `/approval-requests/${id}`, { state: 'APPROVED' });
  assert.equal(deny.status, 403);
  const otherList = await api(other)('GET', '/approval-requests');
  assert.equal(otherList.status, 200);
  assert.equal(otherList.data.length, 0);
  const otherDetails = await api(other)('GET', `/approval-requests/${id}`);
  assert.equal(otherDetails.status, 404);

  // the team manager was notified, sees the request and approves it
  const notif = await manager.call('GET', '/api/v1/user/notifications');
  assert.ok(notif.data.notifications.some((n) => n.type === 'APPROVAL_SUBMITTED' && n.payload.approvalRequestId === id));
  const mList = await api(manager)('GET', '/approval-requests?status=PENDING');
  assert.equal(mList.data.length, 1);
  assert.equal(mList.data[0].approvalRequest.id, id);
  const appr = await api(manager)('PATCH', `/approval-requests/${id}`, { state: 'APPROVED', note: 'ok' });
  assert.equal(appr.status, 200, appr.text);
  assert.equal(appr.data.status.state, 'APPROVED');
  assert.equal(appr.data.status.note, 'ok');
  assert.equal(appr.data.status.updatedBy, manager.user.id);
  assert.equal(appr.data.status.updatedByUserName, 'Manager');

  const locked = await m('GET', `/time-entries/${e1.data.id}`);
  assert.equal(locked.data.approvalStatus, 'APPROVED');
  assert.equal(locked.data.isLocked, true);
  const dbRow = await t.db.one('SELECT locked, approval_status FROM time_entries WHERE id = $1', [e1.data.id]);
  assert.equal(dbRow.locked, true);
  const exp = await t.db.one('SELECT locked, approval_status FROM expenses WHERE id = $1', [EXPENSE_ID]);
  assert.equal(exp.approval_status, 'APPROVED');
  assert.equal(exp.locked, true);
  const approvedDetails = await api(manager)('GET', `/approval-requests/${id}`);
  assert.equal(approvedDetails.data.approvedTime, 'PT4H30M');
  assert.equal(approvedDetails.data.pendingTime, 'PT0S');
  const memberNotif = await member.call('GET', '/api/v1/user/notifications');
  assert.ok(memberNotif.data.notifications.some((n) => n.type === 'APPROVAL_APPROVED'));

  // invalid transition, then withdraw approval unlocks everything
  const bad = await api(manager)('PATCH', `/approval-requests/${id}`, { state: 'REJECTED' });
  assert.equal(bad.status, 400);
  const wd = await api(manager)('PATCH', `/approval-requests/${id}`, { state: 'WITHDRAWN_APPROVAL' });
  assert.equal(wd.status, 200);
  assert.equal(wd.data.status.state, 'WITHDRAWN_APPROVAL');
  const unlocked = await m('GET', `/time-entries/${e1.data.id}`);
  assert.equal(unlocked.data.approvalStatus, 'WITHDRAWN_APPROVAL');
  assert.equal(unlocked.data.isLocked, false);
  assert.equal(unlocked.data.approvalRequestId, null);
  const edit2 = await m('PATCH', `/time-entries/${e1.data.id}`, { description: 'edited' });
  assert.equal(edit2.status, 200);

  // resubmitting re-attaches the entries to the same request
  const re = await m('POST', '/approval-requests/resubmit-entries-for-approval', { periodStart: '2026-03-02T00:00:00Z' });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.data.id, id);
  assert.equal(re.data.status.state, 'PENDING');
  const pendingAgain = await m('GET', `/time-entries/${e1.data.id}`);
  assert.equal(pendingAgain.data.approvalStatus, 'PENDING');
  assert.equal(pendingAgain.data.approvalRequestId, id);
});

test('admin submits a monthly period for a user, rejects it and the member resubmits', async () => {
  const m = api(member);
  const e = await m('POST', '/time-entries', { start: '2026-04-15T09:00:00Z', end: '2026-04-15T12:00:00Z', description: 'april' });
  assert.equal(e.status, 201);
  const sub = await api(owner)('POST', `/approval-requests/users/${member.user.id}`, { period: 'MONTHLY', periodStart: '2026-04-10T00:00:00Z' });
  assert.equal(sub.status, 201, sub.text);
  assert.equal(sub.data.dateRange.start, '2026-04-01T00:00:00Z');
  assert.equal(sub.data.dateRange.end, '2026-04-30T23:59:59Z');
  assert.equal(sub.data.creator.userId, owner.user.id);
  assert.equal(sub.data.owner.userId, member.user.id);

  const deny = await m('POST', `/approval-requests/users/${other.user.id}`, { period: 'MONTHLY', periodStart: '2026-04-10T00:00:00Z' });
  assert.equal(deny.status, 403);

  const rej = await api(owner)('PATCH', `/approval-requests/${sub.data.id}`, { state: 'REJECTED', note: 'fix it' });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.status.state, 'REJECTED');
  assert.equal(rej.data.status.note, 'fix it');
  const entry = await m('GET', `/time-entries/${e.data.id}`);
  assert.equal(entry.data.approvalStatus, 'REJECTED');
  assert.equal(entry.data.isLocked, false);
  assert.equal(entry.data.approvalRequestId, sub.data.id);
  const memberNotif = await member.call('GET', '/api/v1/user/notifications');
  assert.ok(memberNotif.data.notifications.some((n) => n.type === 'APPROVAL_REJECTED'));

  const fix = await m('PATCH', `/time-entries/${e.data.id}`, { end: '2026-04-15T11:00:00Z' });
  assert.equal(fix.status, 200);
  const re = await m('PATCH', `/approval-requests/${sub.data.id}`, { state: 'PENDING' });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.data.status.state, 'PENDING');
  const entry2 = await m('GET', `/time-entries/${e.data.id}`);
  assert.equal(entry2.data.approvalStatus, 'PENDING');

  // semi-monthly period and withdrawal of a submission by its owner
  const e3 = await m('POST', '/time-entries', { start: '2026-05-20T09:00:00Z', end: '2026-05-20T10:00:00Z' });
  assert.equal(e3.status, 201);
  const semi = await m('POST', '/approval-requests', { period: 'SEMI_MONTHLY', periodStart: '2026-05-20T00:00:00Z' });
  assert.equal(semi.status, 201);
  assert.equal(semi.data.dateRange.start, '2026-05-16T00:00:00Z');
  assert.equal(semi.data.dateRange.end, '2026-05-31T23:59:59Z');
  const wd = await m('PATCH', `/approval-requests/${semi.data.id}`, { state: 'WITHDRAWN_SUBMISSION' });
  assert.equal(wd.status, 200);
  assert.equal(wd.data.status.state, 'WITHDRAWN_SUBMISSION');
  const e3After = await m('GET', `/time-entries/${e3.data.id}`);
  assert.equal(e3After.data.approvalStatus, 'WITHDRAWN_SUBMISSION');
  assert.equal(e3After.data.approvalRequestId, null);

  const empty = await m('POST', '/approval-requests', { period: 'WEEKLY', periodStart: '2027-01-05T00:00:00Z' });
  assert.equal(empty.status, 400);
});

test('pending summary and listing filters', async () => {
  const sum = await api(manager)('GET', '/approval-requests/pending-summary?start=2026-03-02T00:00:00Z&end=2026-03-09T00:00:00Z');
  assert.equal(sum.status, 200, sum.text);
  const row = sum.data.find((r) => r.userId === member.user.id);
  assert.ok(row);
  assert.equal(row.trackedTime, 'PT4H30M');
  assert.equal(row.pendingTime, 'PT4H30M');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.requests.length, 1);
  assert.ok(!sum.data.some((r) => r.userId === other.user.id));

  const all = await api(owner)('GET', '/approval-requests?sort-column=UPDATED_AT&sort-order=DESCENDING&page-size=10');
  assert.equal(all.status, 200);
  assert.equal(all.data.length, 3);
  const pending = await api(owner)('GET', `/approval-requests?status=PENDING&users=${member.user.id}`);
  assert.equal(pending.data.length, 2);
  const own = await api(member)('GET', '/approval-requests');
  assert.equal(own.data.length, 3);
});
