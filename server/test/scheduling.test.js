import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

let t; let owner; let member; let pm; let other; let ws; let project;

before(async () => {
  t = await setupTestApp('scheduling');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  const invite = async (email, name) => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email });
    assert.equal(r.status, 200);
    return t.register({ email, name });
  };
  member = await invite('member@test.dev', 'Member');
  pm = await invite('pm@test.dev', 'Project Manager');
  other = await invite('other@test.dev', 'Other');
  const p = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Platform', billable: true, tasks: [{ name: 'Build' }] });
  assert.equal(p.status, 201);
  project = p.data;
  const role = await owner.call('POST', `/api/v1/workspaces/${ws}/users/${pm.user.id}/roles`, { role: 'PROJECT_MANAGER', entityId: project.id });
  assert.equal(role.status, 201);
});
after(async () => { await t.close(); });

const api = (who) => (method, path, body) => who.call(method, `/api/v1/workspaces/${ws}${path}`, body);

test('holidays: CRUD, assigned-to filter and annual expansion in a period', async () => {
  const h = await api(owner)('POST', '/holidays', { name: 'Carnival', datePeriod: { startDate: '2026-03-03', endDate: '2026-03-03' }, color: '#ff0000' });
  assert.equal(h.status, 201, h.text);
  assert.equal(h.data.everyoneIncludingNew, true);
  assert.equal(h.data.datePeriod.startDate, '2026-03-03');
  assert.equal(h.data.color, '#ff0000');
  const ny = await api(owner)('POST', '/holidays', { name: 'New Year', datePeriod: { startDate: '2025-01-01', endDate: '2025-01-01' }, occursAnnually: true });
  assert.equal(ny.status, 201);
  const onlyOther = await api(owner)('POST', '/holidays', { name: 'Other only', datePeriod: { startDate: '2026-03-10', endDate: '2026-03-11' }, users: { ids: [other.user.id] } });
  assert.equal(onlyOther.status, 201);
  assert.equal(onlyOther.data.everyoneIncludingNew, false);
  assert.deepEqual(onlyOther.data.userIds, [other.user.id]);
  const deny = await api(member)('POST', '/holidays', { name: 'X', datePeriod: { startDate: '2026-03-03', endDate: '2026-03-03' } });
  assert.equal(deny.status, 403);

  const all = await api(member)('GET', '/holidays');
  assert.equal(all.status, 200);
  assert.equal(all.data.length, 3);
  const mine = await api(member)('GET', `/holidays?assigned-to=${member.user.id}`);
  assert.equal(mine.data.length, 2);
  const period = await api(member)('GET', `/holidays/in-period?assigned-to=${member.user.id}&start=2026-01-01&end=2027-12-31`);
  assert.equal(period.status, 200, period.text);
  assert.equal(period.data.length, 3);
  assert.ok(period.data.some((x) => x.name === 'New Year' && x.datePeriod.startDate === '2026-01-01'));
  assert.ok(period.data.some((x) => x.name === 'New Year' && x.datePeriod.startDate === '2027-01-01'));
  assert.ok(period.data.some((x) => x.name === 'Carnival'));

  const upd = await api(owner)('PUT', `/holidays/${h.data.id}`, { name: 'Carnival Tuesday', datePeriod: { startDate: '2026-03-03', endDate: '2026-03-03' }, occursAnnually: false });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.name, 'Carnival Tuesday');
  const del = await api(owner)('DELETE', `/holidays/${onlyOther.data.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.id, onlyOther.data.id);
  const after = await api(owner)('GET', '/holidays');
  assert.equal(after.data.length, 2);
});

test('holiday job creates HOLIDAY time entries once', async () => {
  const { runHolidayEntries } = await import('../src/modules/holidays/index.js');
  const auto = await api(owner)('POST', '/holidays', {
    name: 'Auto Day', datePeriod: { startDate: '2026-06-10', endDate: '2026-06-10' }, users: { ids: [member.user.id] },
    automaticTimeEntryCreation: { enabled: true, defaultEntities: { projectId: project.id, taskId: project.tasks[0].id } },
  });
  assert.equal(auto.status, 201, auto.text);
  assert.equal(auto.data.automaticTimeEntryCreation, true);
  assert.equal(auto.data.projectId, project.id);
  const n1 = await runHolidayEntries({ now: new Date('2026-06-01T00:00:00Z'), workspaceId: ws });
  assert.equal(n1, 1);
  const n2 = await runHolidayEntries({ now: new Date('2026-06-01T00:00:00Z'), workspaceId: ws });
  assert.equal(n2, 0);
  const entries = await api(member)('GET', `/user/${member.user.id}/time-entries?start=2026-06-10T00:00:00Z&end=2026-06-11T00:00:00Z`);
  assert.equal(entries.data.length, 1);
  assert.equal(entries.data[0].type, 'HOLIDAY');
  assert.equal(entries.data[0].projectId, project.id);
  assert.equal(entries.data[0].taskId, project.tasks[0].id);
  assert.equal(entries.data[0].timeInterval.start, '2026-06-10T09:00:00Z');
  assert.equal(entries.data[0].timeInterval.duration, 'PT8H');
  const none = await api(other)('GET', `/user/${other.user.id}/time-entries?start=2026-06-10T00:00:00Z&end=2026-06-11T00:00:00Z`);
  assert.equal(none.data.length, 0);
});

test('recurring assignments: exclude days, totals, publishing, series updates, copy and delete', async () => {
  const body = { projectId: project.id, userId: member.user.id, start: '2026-03-02T00:00:00Z', end: '2026-03-07T00:00:00Z', hoursPerDay: 4, note: 'sprint', recurringAssignment: { weeks: 3, repeat: true } };
  const deny = await api(member)('POST', '/scheduling/assignments/recurring', body);
  assert.equal(deny.status, 403);
  const rec = await api(pm)('POST', '/scheduling/assignments/recurring', body);
  assert.equal(rec.status, 201, rec.text);
  assert.equal(rec.data.length, 3);
  const first = rec.data[0];
  assert.equal(first.period.start, '2026-03-02T00:00:00Z');
  assert.equal(first.period.end, '2026-03-07T00:00:00Z');
  assert.equal(first.hoursPerDay, 4);
  assert.equal(first.published, false);
  assert.equal(first.recurring.weeks, 3);
  assert.equal(first.recurring.repeat, true);
  assert.ok(first.recurring.seriesId);
  assert.ok(rec.data.every((a) => a.recurring.seriesId === first.recurring.seriesId));
  assert.equal(rec.data[2].period.start, '2026-03-16T00:00:00Z');
  assert.deepEqual(first.excludeDays, [{ date: '2026-03-03T00:00:00Z', type: 'HOLIDAY' }, { date: '2026-03-07T00:00:00Z', type: 'WEEKEND' }]);
  assert.equal(first.projectName, 'Platform');
  assert.equal(first.userName, 'Member');

  // members only see published assignments
  const before = await api(member)('GET', '/scheduling/assignments/all?start=2026-03-01T00:00:00Z&end=2026-03-31T00:00:00Z');
  assert.equal(before.status, 200, before.text);
  assert.equal(before.data.length, 0);
  const adminAll = await api(owner)('GET', '/scheduling/assignments/all?start=2026-03-01T00:00:00Z&end=2026-03-31T00:00:00Z&sort-column=ID');
  assert.equal(adminAll.data.length, 3);

  // totals
  const pt = await api(owner)('POST', '/scheduling/assignments/projects/totals', { start: '2026-03-02T00:00:00Z', end: '2026-03-08T00:00:00Z' });
  assert.equal(pt.status, 200, pt.text);
  assert.equal(pt.data.length, 1);
  assert.equal(pt.data[0].projectId, project.id);
  assert.equal(pt.data[0].totalHours, 16);
  assert.equal(pt.data[0].assignments.length, 7);
  assert.equal(pt.data[0].assignments.find((d) => d.date === '2026-03-02T00:00:00Z').hasAssignment, true);
  assert.equal(pt.data[0].assignments.find((d) => d.date === '2026-03-03T00:00:00Z').hasAssignment, false);
  assert.equal(pt.data[0].assignments.find((d) => d.date === '2026-03-08T00:00:00Z').hasAssignment, false);
  const ptOne = await api(owner)('GET', `/scheduling/assignments/projects/totals/${project.id}?start=2026-03-02T00:00:00Z&end=2026-03-22T00:00:00Z`);
  assert.equal(ptOne.status, 200, ptOne.text);
  assert.equal(ptOne.data.totalHours, 56);
  const ut = await api(owner)('GET', `/scheduling/assignments/users/${member.user.id}/totals?start=2026-03-02T00:00:00Z&end=2026-03-04T00:00:00Z`);
  assert.equal(ut.status, 200, ut.text);
  assert.equal(ut.data.capacityPerDay, 8);
  assert.deepEqual(ut.data.totalHoursPerDay.map((d) => d.totalHours), [4, 0, 4]);
  assert.deepEqual(ut.data.workingDays, ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);
  const uts = await api(owner)('POST', '/scheduling/assignments/user-filter/totals', { start: '2026-03-02T00:00:00Z', end: '2026-03-02T00:00:00Z', userFilter: { ids: [member.user.id, other.user.id] } });
  assert.equal(uts.data.length, 2);
  assert.equal(uts.data.find((u) => u.userId === other.user.id).totalHoursPerDay[0].totalHours, 0);

  // publish
  const pub = await api(pm)('PUT', '/scheduling/assignments/publish', { start: '2026-03-01T00:00:00Z', end: '2026-03-31T00:00:00Z', notifyUsers: true });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.data.published, 3);
  const after = await api(member)('GET', '/scheduling/assignments/all?start=2026-03-01T00:00:00Z&end=2026-03-31T00:00:00Z');
  assert.equal(after.data.length, 3);
  assert.ok(after.data.every((a) => a.published));
  const notif = await member.call('GET', '/api/v1/user/notifications');
  assert.ok(notif.data.notifications.some((n) => n.type === 'SCHEDULE_PUBLISHED'));

  // update this and following
  const second = rec.data[1];
  const upd = await api(pm)('PATCH', `/scheduling/assignments/recurring/${second.id}`, { start: second.period.start, end: second.period.end, hoursPerDay: 6, seriesUpdateOption: 'THIS_AND_FOLLOWING' });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.length, 2);
  assert.ok(upd.data.every((a) => a.hoursPerDay === 6));
  const firstAgain = await api(owner)('GET', `/scheduling/assignments/${first.id}`);
  assert.equal(firstAgain.data.hoursPerDay, 4);

  // series size
  const smaller = await api(pm)('PUT', `/scheduling/assignments/series/${first.id}`, { weeks: 2, repeat: true });
  assert.equal(smaller.status, 200, smaller.text);
  assert.equal(smaller.data.length, 2);
  const bigger = await api(pm)('PUT', `/scheduling/assignments/series/${first.id}`, { weeks: 4 });
  assert.equal(bigger.data.length, 4);
  assert.equal(bigger.data[3].period.start, '2026-03-23T00:00:00Z');
  assert.ok(bigger.data.every((a) => a.recurring.weeks === 4));

  // copy the whole series to another user
  const copy = await api(pm)('POST', `/scheduling/assignments/${first.id}/copy`, { userId: other.user.id, seriesUpdateOption: 'ALL' });
  assert.equal(copy.status, 200, copy.text);
  assert.equal(copy.data.length, 4);
  assert.ok(copy.data.every((a) => a.userId === other.user.id && a.published === false));
  assert.notEqual(copy.data[0].recurring.seriesId, first.recurring.seriesId);

  // delete the member's series
  const del = await api(pm)('DELETE', `/scheduling/assignments/recurring/${first.id}?seriesUpdateOption=ALL`);
  assert.equal(del.status, 200, del.text);
  assert.equal(del.data.length, 4);
  const left = await api(owner)('GET', `/scheduling/assignments/all?start=2026-03-01T00:00:00Z&end=2026-04-30T00:00:00Z&users=${member.user.id}`);
  assert.equal(left.data.length, 0);
  const otherLeft = await api(owner)('GET', `/scheduling/assignments/all?start=2026-03-01T00:00:00Z&end=2026-04-30T00:00:00Z&users=${other.user.id}`);
  assert.equal(otherLeft.data.length, 4);
});

test('approved time off is excluded from assignments; milestones and single assignments', async () => {
  const pol = await api(owner)('POST', '/time-off/policies', { name: 'PTO', everyoneIncludingNew: true, approve: { requiresApproval: false } });
  assert.equal(pol.status, 201, pol.text);
  await api(owner)('PATCH', `/time-off/balance/policy/${pol.data.id}`, { userIds: [member.user.id], value: 5 });
  const off = await api(member)('POST', `/time-off/policies/${pol.data.id}/requests`, { timeOffPeriod: { period: { start: '2026-04-06', end: '2026-04-06' } } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.data.status.statusType, 'APPROVED');

  const single = await api(pm)('POST', '/scheduling/assignments', { projectId: project.id, userId: member.user.id, taskId: project.tasks[0].id, start: '2026-04-06', end: '2026-04-07', hoursPerDay: 8, startTime: '10:00' });
  assert.equal(single.status, 201, single.text);
  assert.equal(single.data.recurring.seriesId, null);
  assert.equal(single.data.startTime, '10:00:00');
  assert.equal(single.data.taskName, 'Build');
  assert.deepEqual(single.data.excludeDays, [{ date: '2026-04-06T00:00:00Z', type: 'TIME_OFF' }]);

  const m = await api(pm)('POST', '/scheduling/milestones', { projectId: project.id, name: 'Q1', date: '2026-04-07' });
  assert.equal(m.status, 201, m.text);
  assert.equal(m.data.date, '2026-04-07T00:00:00Z');
  const denyM = await api(member)('POST', '/scheduling/milestones', { projectId: project.id, name: 'X', date: '2026-04-07' });
  assert.equal(denyM.status, 403);
  const list = await api(member)('GET', `/scheduling/milestones?project-id=${project.id}`);
  assert.equal(list.data.length, 1);

  const totals = await api(owner)('GET', `/scheduling/assignments/projects/totals/${project.id}?start=2026-04-06T00:00:00Z&end=2026-04-07T00:00:00Z`);
  assert.equal(totals.data.totalHours, 8);
  assert.equal(totals.data.milestones.length, 1);
  assert.equal(totals.data.milestones[0].name, 'Q1');

  const updM = await api(pm)('PUT', `/scheduling/milestones/${m.data.id}`, { name: 'Q1 end' });
  assert.equal(updM.data.name, 'Q1 end');
  const delM = await api(pm)('DELETE', `/scheduling/milestones/${m.data.id}`);
  assert.equal(delM.status, 200);
  const updA = await api(pm)('PUT', `/scheduling/assignments/${single.data.id}`, { start: '2026-04-07', end: '2026-04-08', hoursPerDay: 5 });
  assert.equal(updA.status, 200, updA.text);
  assert.equal(updA.data.hoursPerDay, 5);
  assert.deepEqual(updA.data.excludeDays, []);
  const delA = await api(pm)('DELETE', `/scheduling/assignments/${single.data.id}`);
  assert.equal(delA.status, 204);
  const gone = await api(pm)('GET', `/scheduling/assignments/${single.data.id}`);
  assert.equal(gone.status, 404);
});
