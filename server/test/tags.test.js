import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

// Tag status: an inactive tag cannot be added to any record, but the records that already use it keep working
// (editing, timers, reports, exports, approvals).
let t; let owner; let member; let ws; let legado; let padrao; let e1; let e3; let timer;
const W = (p) => `/api/v1/workspaces/${ws}${p}`;
const RANGE = { dateRangeStart: '2026-03-02T00:00:00Z', dateRangeEnd: '2026-03-08T23:59:59Z' };
const tagIdsOf = async (who, id) => (await who.call('GET', W(`/time-entries/${id}`))).data.tagIds.sort();

before(async () => {
  process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '100000';
  t = await setupTestApp('tags');
  owner = await t.register({ name: 'Owner', workspaceName: 'Cervejaria' });
  ws = owner.workspaceId;
  await owner.call('POST', W('/users?send-email=false'), { email: 'member@test.dev' });
  member = await t.register({ email: 'member@test.dev', name: 'Member' });
  legado = (await owner.call('POST', W('/tags'), { name: 'Legado' })).data;
  padrao = (await owner.call('POST', W('/tags'), { name: 'Padrão' })).data;
  const create = async (body) => { const r = await member.call('POST', W('/time-entries'), body); assert.equal(r.status, 201, r.text); return r.data; };
  e1 = await create({ start: '2026-03-03T09:00:00Z', end: '2026-03-03T11:00:00Z', description: 'Envase', tagIds: [legado.id, padrao.id] });
  e3 = await create({ start: '2026-03-04T09:00:00Z', end: '2026-03-04T10:00:00Z', description: 'Rotulagem', tagIds: [legado.id] });
  timer = await create({ start: '2026-03-05T08:00:00Z', description: 'Turno', tagIds: [legado.id] }); // running
});
after(async () => { await t.close(); });

test('only administrators change the status; the list shows status and usage', async () => {
  assert.equal((await member.call('POST', W('/tags/bulk-status'), { tagIds: [legado.id], archived: true })).status, 403);
  assert.equal((await member.call('PUT', W(`/tags/${legado.id}`), { archived: true })).status, 403);

  const r = await owner.call('POST', W('/tags/bulk-status'), { tagIds: [legado.id], archived: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.updated.map((x) => [x.id, x.archived]), [[legado.id, true]]);
  const again = await owner.call('POST', W('/tags/bulk-status'), { tagIds: [legado.id], archived: true });
  assert.equal(again.data.updated.length, 0); // already inactive: nothing to change

  const inactive = await owner.call('GET', W('/tags?archived=true&include-usage=true'));
  assert.deepEqual(inactive.data.map((x) => x.name), ['Legado']);
  assert.equal(inactive.data[0].usage.entries, 3);
  assert.equal(inactive.data[0].usage.lastUsed.slice(0, 10), '2026-03-05');
  const active = await member.call('GET', W('/tags?archived=false'));
  assert.deepEqual(active.data.map((x) => x.name), ['Padrão']);
  const audit = await t.db.one("SELECT count(*)::int AS c FROM audit_log WHERE entity_id = $1 AND action = 'UPDATE_TAG'", [legado.id]);
  assert.equal(audit.c, 1);
});

test('an inactive tag cannot be added to any record, not even by administrators', async () => {
  const body = { start: '2026-03-06T09:00:00Z', end: '2026-03-06T10:00:00Z', tagIds: [legado.id] };
  const byMember = await member.call('POST', W('/time-entries'), body);
  assert.equal(byMember.status, 400);
  assert.match(byMember.data.message, /etiqueta “Legado” está inativa/);
  assert.equal((await owner.call('POST', W('/time-entries'), body)).status, 400);
  assert.equal((await owner.call('POST', W(`/user/${member.user.id}/time-entries`), body)).status, 400);
  // adding it to a record that does not have it
  const plain = (await member.call('POST', W('/time-entries'), { ...body, tagIds: [padrao.id] })).data;
  const add = await member.call('PUT', W(`/time-entries/${plain.id}`), { start: body.start, end: body.end, tagIds: [padrao.id, legado.id] });
  assert.equal(add.status, 400);
  assert.deepEqual(await tagIdsOf(member, plain.id), [padrao.id]);
  // removed by mistake from a record: it cannot come back while inactive
  const removed = await member.call('PUT', W(`/time-entries/${e3.id}`), { start: '2026-03-04T09:00:00Z', end: '2026-03-04T10:00:00Z', description: 'Rotulagem', tagIds: [] });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await member.call('PUT', W(`/time-entries/${e3.id}`), { start: '2026-03-04T09:00:00Z', end: '2026-03-04T10:00:00Z', tagIds: [legado.id] })).status, 400);
  // a new tag with the same name points to the inactive one
  const dup = await owner.call('POST', W('/tags'), { name: 'legado' });
  assert.equal(dup.status, 400);
  assert.match(dup.data.message, /etiqueta inativa chamada “Legado”/);
  await member.call('DELETE', W(`/time-entries/${plain.id}`));
});

test('records that already use the inactive tag keep working', async () => {
  const got = await member.call('GET', W(`/time-entries/${e1.id}?hydrated=true`));
  assert.deepEqual(got.data.tags.map((x) => [x.name, x.archived]).sort(), [['Legado', true], ['Padrão', false]]);

  // editing (the screen sends the tags it already has)
  const put = await member.call('PUT', W(`/time-entries/${e1.id}`), { start: '2026-03-03T09:00:00Z', end: '2026-03-03T11:30:00Z', description: 'Envase linha 2', tagIds: [legado.id, padrao.id] });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(await tagIdsOf(member, e1.id), [legado.id, padrao.id].sort());
  const patch = await member.call('PATCH', W(`/time-entries/${e1.id}`), { description: 'Envase linha 3' });
  assert.equal(patch.status, 200, patch.text);
  // an administrator editing someone else's record
  const byOwner = await owner.call('PUT', W(`/time-entries/${e1.id}`), { start: '2026-03-03T09:00:00Z', end: '2026-03-03T11:00:00Z', description: 'Envase', tagIds: [legado.id, padrao.id] });
  assert.equal(byOwner.status, 200, byOwner.text);

  // the timer started before the inactivation: tags can change around it, and it stops normally
  const timerTags = await member.call('PATCH', W(`/time-entries/${timer.id}`), { tagIds: [legado.id, padrao.id] });
  assert.equal(timerTags.status, 200, timerTags.text);
  const stop = await member.call('PATCH', W(`/user/${member.user.id}/time-entries`), { end: '2026-03-05T12:00:00Z' });
  assert.equal(stop.status, 200, stop.text);
  assert.deepEqual(await tagIdsOf(member, timer.id), [legado.id, padrao.id].sort());

  // continue / duplicate are new records: the inactive tag stays behind, the active ones go along
  const cont = await member.call('POST', W(`/user/${member.user.id}/time-entries/${e1.id}/continue`));
  assert.equal(cont.status, 201, cont.text);
  assert.deepEqual(cont.data.tagIds, [padrao.id]);
  await member.call('PATCH', W(`/user/${member.user.id}/time-entries`), { end: new Date(Date.now() + 60e3).toISOString() });
  await member.call('DELETE', W(`/time-entries/${cont.data.id}`));
  const dup = await member.call('POST', W(`/user/${member.user.id}/time-entries/${e1.id}/duplicate`));
  assert.equal(dup.status, 201, dup.text);
  assert.deepEqual(dup.data.tagIds, [padrao.id]);
  await member.call('DELETE', W(`/time-entries/${dup.data.id}`));

  // splitting divides the same work: both parts keep their tags
  const split = await member.call('POST', W(`/time-entries/${e1.id}/split`), { time: '2026-03-03T10:00:00Z' });
  assert.equal(split.status, 200, split.text);
  assert.ok(split.data.every((x) => x.tagIds.includes(legado.id)));
});

test('reports, exports and approvals still show the inactive tag', async () => {
  const byTag = await owner.call('POST', W('/reports/summary'), { ...RANGE, summaryFilter: { groups: ['TAG'] } });
  assert.equal(byTag.status, 200, byTag.text);
  assert.equal(byTag.data.groupOne.find((g) => g._id === legado.id).duration, 2 * 3600 + 4 * 3600); // e1 (split in two) + timer

  const filtered = await owner.call('POST', W('/reports/detailed'), { ...RANGE, tags: { ids: [legado.id], contains: 'CONTAINS' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(filtered.status, 200, filtered.text);
  assert.equal(filtered.data.timeentries.length, 3);
  const onlyInactive = await owner.call('POST', W('/reports/detailed'), { ...RANGE, tags: { status: 'ARCHIVED' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(onlyInactive.data.timeentries.length, 3);

  const csv = await owner.call('POST', W('/reports/detailed'), { ...RANGE, exportType: 'CSV', tags: { ids: [legado.id], contains: 'CONTAINS' } });
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.text, /Envase/);
  assert.match(csv.text, /Legado/);

  // the week with those records is submitted and approved normally
  const sub = await member.call('POST', W('/approval-requests'), { periodStart: '2026-03-02T00:00:00Z' });
  assert.equal(sub.status, 201, sub.text);
  const ok = await owner.call('PATCH', W(`/approval-requests/${sub.data.id}`), { state: 'APPROVED' });
  assert.equal(ok.status, 200, ok.text);
  const locked = await member.call('GET', W(`/time-entries/${e1.id}?hydrated=true`));
  assert.equal(locked.data.approvalStatus, 'APPROVED');
  assert.ok(locked.data.tags.some((x) => x.id === legado.id));
});

test('a reactivated tag can be used again', async () => {
  const r = await owner.call('PUT', W(`/tags/${legado.id}`), { archived: false });
  assert.equal(r.status, 200, r.text);
  const again = await member.call('POST', W('/time-entries'), { start: '2026-03-10T09:00:00Z', end: '2026-03-10T10:00:00Z', tagIds: [legado.id] });
  assert.equal(again.status, 201, again.text);
  const bulk = await owner.call('POST', W('/tags/bulk-status'), { tagIds: [legado.id, padrao.id], archived: true });
  assert.deepEqual(bulk.data.updated.map((x) => x.name).sort(), ['Legado', 'Padrão']);
  const back = await owner.call('POST', W('/tags/bulk-status'), { tagIds: [legado.id, padrao.id], archived: false });
  assert.equal(back.data.updated.length, 2);
});
