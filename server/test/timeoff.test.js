import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

let t; let owner; let member; let manager; let ws; let project;

before(async () => {
  t = await setupTestApp('timeoff');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  const invite = async (email, name) => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email });
    assert.equal(r.status, 200);
    return t.register({ email, name });
  };
  member = await invite('member@test.dev', 'Member');
  manager = await invite('manager@test.dev', 'Manager');
  const role = await owner.call('POST', `/api/v1/workspaces/${ws}/users/${manager.user.id}/roles`, { role: 'TEAM_MANAGER', entityId: member.user.id });
  assert.equal(role.status, 201);
  const p = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Leave', billable: false });
  assert.equal(p.status, 201);
  project = p.data;
});
after(async () => { await t.close(); });

const api = (who) => (method, path, body) => who.call(method, `/api/v1/workspaces/${ws}${path}`, body);
let vacation;

test('policy with approval: balances, request, approval by team manager and withdrawal', async () => {
  const pol = await api(owner)('POST', '/time-off/policies', { name: 'Vacation', timeUnit: 'DAYS', allowHalfDay: true, everyoneIncludingNew: true, color: '#f00', approve: { requiresApproval: true, teamManagers: true } });
  assert.equal(pol.status, 201, pol.text);
  vacation = pol.data;
  assert.equal(vacation.approve.requiresApproval, true);
  assert.ok(vacation.userIds.includes(member.user.id));
  assert.equal(vacation.archived, false);
  const deny = await api(member)('POST', '/time-off/policies', { name: 'Nope', approve: {} });
  assert.equal(deny.status, 403);
  const list = await api(member)('GET', '/time-off/policies?status=ACTIVE');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].name, 'Vacation');

  // balances
  const bal0 = await api(owner)('GET', `/time-off/balance/policy/${vacation.id}`);
  assert.equal(bal0.status, 200);
  assert.ok(bal0.data.count >= 3);
  assert.equal(bal0.data.balances.find((b) => b.userId === member.user.id).total, 0);
  const patch = await api(owner)('PATCH', `/time-off/balance/policy/${vacation.id}`, { userIds: [member.user.id], value: 10, note: 'initial' });
  assert.equal(patch.status, 204);
  const balUser = await api(member)('GET', `/time-off/balance/user/${member.user.id}`);
  assert.equal(balUser.status, 200);
  assert.equal(balUser.data.count, 1);
  assert.equal(balUser.data.balances[0].policyName, 'Vacation');
  assert.equal(balUser.data.balances[0].total, 10);
  assert.equal(balUser.data.balances[0].balance, 10);
  const hist = await t.db.rows('SELECT delta, note FROM time_off_balance_history h JOIN time_off_balances b ON b.id = h.balance_id WHERE b.user_id = $1', [member.user.id]);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].delta, 10);

  // requests
  const big = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-02', end: '2026-03-20' } }, note: 'long' });
  assert.equal(big.status, 400); // 15 working days > 10
  const req1 = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-02', end: '2026-03-04' } }, note: 'trip' });
  assert.equal(req1.status, 200, req1.text);
  assert.equal(req1.data.status.statusType, 'PENDING');
  assert.equal(req1.data.balanceDiff, 3);
  assert.equal(req1.data.balance, 10);
  assert.equal(req1.data.timeUnit, 'DAYS');
  assert.equal(req1.data.policyName, 'Vacation');
  assert.equal(req1.data.userName, 'Member');
  assert.equal(req1.data.requesterUserId, member.user.id);
  assert.equal(req1.data.timeOffPeriod.period.start, '2026-03-02T00:00:00Z');
  assert.equal(req1.data.timeOffPeriod.period.end, '2026-03-04T23:59:59Z');
  assert.equal(req1.data.note, 'trip');
  const overlap = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-04', end: '2026-03-05' } } });
  assert.equal(overlap.status, 400);
  const managerNotif = await manager.call('GET', '/api/v1/user/notifications');
  assert.ok(managerNotif.data.notifications.some((n) => n.type === 'TIME_OFF_REQUESTED'));

  const denyApprove = await api(member)('PATCH', `/time-off/policies/${vacation.id}/requests/${req1.data.id}`, { status: 'APPROVED' });
  assert.equal(denyApprove.status, 403);
  const appr = await api(manager)('PATCH', `/time-off/policies/${vacation.id}/requests/${req1.data.id}`, { status: 'APPROVED', note: 'enjoy' });
  assert.equal(appr.status, 200, appr.text);
  assert.equal(appr.data.status.statusType, 'APPROVED');
  assert.equal(appr.data.status.changedByUserId, manager.user.id);
  assert.equal(appr.data.status.note, 'enjoy');
  assert.equal(appr.data.balance, 7);
  const balUser2 = await api(member)('GET', `/time-off/balance/user/${member.user.id}`);
  assert.equal(balUser2.data.balances[0].used, 3);
  assert.equal(balUser2.data.balances[0].balance, 7);
  const memberNotif = await member.call('GET', '/api/v1/user/notifications');
  assert.ok(memberNotif.data.notifications.some((n) => n.type === 'TIME_OFF_APPROVED'));

  const listed = await api(owner)('POST', '/time-off/requests', { statuses: ['APPROVED'], users: [member.user.id] });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.count, 1);
  assert.equal(listed.data.requests[0].id, req1.data.id);
  const inRange = await api(owner)('POST', '/time-off/requests', { start: '2026-03-04T00:00:00Z', end: '2026-03-10T00:00:00Z' });
  assert.equal(inRange.data.count, 1);
  const outOfRange = await api(owner)('POST', '/time-off/requests', { start: '2026-03-05T00:00:00Z', end: '2026-03-10T00:00:00Z' });
  assert.equal(outOfRange.data.count, 0);

  // half day
  const half = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-06', end: '2026-03-06' }, isHalfDay: true, halfDayPeriod: 'FIRST_HALF' } });
  assert.equal(half.status, 200, half.text);
  assert.equal(half.data.balanceDiff, 0.5);
  assert.equal(half.data.timeOffPeriod.halfDay, true);
  assert.equal(half.data.timeOffPeriod.halfDayPeriod, 'FIRST_HALF');
  assert.equal(half.data.timeOffPeriod.halfDayHours.start, '2026-03-06T09:00:00Z');
  assert.equal(half.data.timeOffPeriod.halfDayHours.end, '2026-03-06T13:00:00Z');

  // owner withdraws: pending one, then the approved one (balance returned)
  const wd = await api(member)('DELETE', `/time-off/policies/${vacation.id}/requests/${half.data.id}`);
  assert.equal(wd.status, 200);
  assert.equal(wd.data.status.statusType, 'WITHDRAWN');
  const wd2 = await api(member)('DELETE', `/time-off/policies/${vacation.id}/requests/${req1.data.id}`);
  assert.equal(wd2.status, 200);
  assert.equal(wd2.data.status.statusType, 'WITHDRAWN');
  const balUser3 = await api(member)('GET', `/time-off/balance/user/${member.user.id}`);
  assert.equal(balUser3.data.balances[0].used, 0);
  assert.equal(balUser3.data.balances[0].balance, 10);
});

test('holidays of the user are not counted as time off days', async () => {
  const hol = await api(owner)('POST', '/holidays', { name: 'Founders Day', datePeriod: { startDate: '2026-03-24', endDate: '2026-03-24' } });
  assert.equal(hol.status, 201, hol.text);
  const req = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-23', end: '2026-03-25' } } });
  assert.equal(req.status, 200, req.text);
  assert.equal(req.data.balanceDiff, 2);
  const onHoliday = await api(member)('POST', `/time-off/policies/${vacation.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-28', end: '2026-03-29' } } });
  assert.equal(onHoliday.status, 400); // weekend only
});

test('policy without approval in HOURS creates TIME_OFF entries and removes them when deleted', async () => {
  const pol = await api(owner)('POST', '/time-off/policies', {
    name: 'Sick leave', timeUnit: 'HOURS', everyoneIncludingNew: true, allowNegativeBalance: true, negativeBalance: { amount: 40, period: 'YEAR' },
    approve: { requiresApproval: false }, automaticTimeEntryCreation: { enabled: true, defaultEntities: { projectId: project.id } },
  });
  assert.equal(pol.status, 201, pol.text);
  assert.equal(pol.data.automaticTimeEntryCreation.enabled, true);
  assert.equal(pol.data.projectId, project.id);
  const r = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-16', end: '2026-03-17' } }, note: 'flu' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.status.statusType, 'APPROVED');
  assert.equal(r.data.timeUnit, 'HOURS');
  assert.equal(r.data.balanceDiff, 16);
  assert.equal(r.data.balance, -16);
  const entries = await api(member)('GET', `/user/${member.user.id}/time-entries?start=2026-03-16T00:00:00Z&end=2026-03-18T00:00:00Z&hydrated=true`);
  assert.equal(entries.status, 200);
  assert.equal(entries.data.length, 2);
  for (const e of entries.data) {
    assert.equal(e.type, 'TIME_OFF');
    assert.equal(e.projectId, project.id);
    assert.equal(e.timeInterval.duration, 'PT8H');
    assert.equal(e.billable, false);
  }
  assert.ok(entries.data.some((e) => e.timeInterval.start === '2026-03-16T09:00:00Z'));
  const balances = await api(owner)('GET', `/time-off/balance/policy/${pol.data.id}?sort=BALANCE&sort-order=ASCENDING`);
  assert.equal(balances.data.balances[0].userId, member.user.id);
  assert.equal(balances.data.balances[0].balance, -16);
  assert.equal(balances.data.balances[0].negativeBalanceAmount, 40);
  assert.equal(balances.data.balances[0].policyTimeUnit, 'HOURS');

  // negative balance limit: 16 + 32 = 48 > 40
  const over = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-03-30', end: '2026-04-02' } } });
  assert.equal(over.status, 400);

  // admin deletes the request: entries removed, balance returned
  const del = await api(owner)('DELETE', `/time-off/policies/${pol.data.id}/requests/${r.data.id}`);
  assert.equal(del.status, 200, del.text);
  const entriesAfter = await api(member)('GET', `/user/${member.user.id}/time-entries?start=2026-03-16T00:00:00Z&end=2026-03-18T00:00:00Z`);
  assert.equal(entriesAfter.data.length, 0);
  const balancesAfter = await api(owner)('GET', `/time-off/balance/policy/${pol.data.id}`);
  assert.equal(balancesAfter.data.balances.find((b) => b.userId === member.user.id).balance, 0);
  const gone = await api(owner)('POST', '/time-off/requests', { statuses: ['ALL'], users: [member.user.id] });
  assert.ok(!gone.data.requests.some((x) => x.id === r.data.id));
});

test('automatic accrual credits balances once per period', async () => {
  const { runAccrual } = await import('../src/modules/timeOff/index.js');
  const pol = await api(owner)('POST', '/time-off/policies', { name: 'Accrued', everyoneIncludingNew: true, approve: { requiresApproval: true }, automaticAccrual: { amount: 1.5, period: 'MONTH' } });
  assert.equal(pol.status, 201, pol.text);
  assert.equal(pol.data.automaticAccrual.amount, 1.5);
  const later = new Date(); later.setUTCDate(15); later.setUTCMonth(later.getUTCMonth() + 2);
  const later2 = new Date(later); later2.setUTCMonth(later2.getUTCMonth() + 1);
  const balance = async () => (await api(owner)('GET', `/time-off/balance/policy/${pol.data.id}`)).data.balances.find((b) => b.userId === member.user.id);
  assert.equal((await balance()).total, 0);
  assert.ok((await runAccrual({ now: later })) >= 3);
  assert.equal((await balance()).total, 1.5);
  assert.equal(await runAccrual({ now: later }), 0);
  assert.equal((await balance()).total, 1.5);
  await runAccrual({ now: later2 });
  assert.equal((await balance()).total, 3);
});

test('policy update, archive and delete', async () => {
  const pol = await api(owner)('POST', '/time-off/policies', { name: 'Temp', users: { ids: [member.user.id] }, approve: { requiresApproval: true, specificMembers: true, userIds: [manager.user.id] } });
  assert.equal(pol.status, 201, pol.text);
  assert.deepEqual(pol.data.userIds, [member.user.id]);
  assert.equal(pol.data.everyoneIncludingNew, false);
  const upd = await api(owner)('PUT', `/time-off/policies/${pol.data.id}`, { name: 'Temp 2', allowHalfDay: true });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.name, 'Temp 2');
  assert.equal(upd.data.allowHalfDay, true);
  assert.deepEqual(upd.data.approve.userIds, [manager.user.id]);
  // without balance the request is refused; grant one day first
  const noBalance = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-05-04', end: '2026-05-04' } } });
  assert.equal(noBalance.status, 400);
  const grant = await api(owner)('PATCH', `/time-off/balance/policy/${pol.data.id}`, { userIds: [member.user.id], value: 1 });
  assert.equal(grant.status, 204);
  const notEligible = await api(owner)('PATCH', `/time-off/balance/policy/${pol.data.id}`, { userIds: [manager.user.id], value: 1 });
  assert.equal(notEligible.status, 400);
  // specific member approver (manager) can approve even without team manager rights on the policy
  const r = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-05-04', end: '2026-05-04' } } });
  assert.equal(r.status, 200, r.text);
  const notMember = await api(manager)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-05-05', end: '2026-05-05' } } });
  assert.equal(notMember.status, 400);
  const rejected = await api(manager)('PATCH', `/time-off/policies/${pol.data.id}/requests/${r.data.id}`, { status: 'REJECTED', note: 'no' });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.data.status.statusType, 'REJECTED');
  const archived = await api(owner)('PATCH', `/time-off/policies/${pol.data.id}`, { status: 'ARCHIVED' });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.archived, true);
  const archivedList = await api(owner)('GET', '/time-off/policies?status=ARCHIVED');
  assert.equal(archivedList.data.length, 1);
  const onArchived = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-05-06', end: '2026-05-06' } } });
  assert.equal(onArchived.status, 400);
  const del = await api(owner)('DELETE', `/time-off/policies/${pol.data.id}`);
  assert.equal(del.status, 200);
  const gone = await api(owner)('GET', `/time-off/policies/${pol.data.id}`);
  assert.equal(gone.status, 404);
});
