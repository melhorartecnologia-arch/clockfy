// Verifies that every endpoint of the public Clockify API (test/fixtures/clockify-endpoints.txt) is routed by Clockfy.
// A route is considered present when the server does not answer with the router's "Route not found" 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupTestApp } from './helpers.js';

let t; let owner;
before(async () => { t = await setupTestApp('compat'); owner = await t.register({ name: 'Owner', workspaceName: 'WS' }); });
after(async () => { await t.close(); });

const lines = fs.readFileSync(new URL('./fixtures/clockify-endpoints.txt', import.meta.url), 'utf8').split('\n')
  .map((l) => /^(GET|POST|PUT|PATCH|DELETE) (https?:\/\/[^/]+)(\/[^\s]+)/.exec(l)).filter(Boolean);

test('all Clockify public API routes are registered', async () => {
  const missing = [];
  const dummy = '000000000000000000000001';
  for (const [, method, host, rawPath] of lines) {
    const prefix = rawPath.startsWith('/api/') ? '' : '/reports';
    const path = prefix + rawPath.replace('{workspaceId}', owner.workspaceId).replace('{userId}', owner.user.id).replace(/\{[^}]+\}/g, dummy)
      .replace('/holidays/in-period', '/holidays/in-period?assigned-to=' + owner.user.id + '&start=2026-01-01&end=2026-01-31')
      .replace('/scheduling/assignments/all', '/scheduling/assignments/all?start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z')
      .replace(/\/totals\/([a-f0-9]{24})$/, '/totals/$1?start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z')
      .replace(/\/users\/([a-f0-9]{24})\/totals$/, '/users/$1/totals?start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z');
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined;
    const r = await owner.call(method, path, body);
    if (r.status === 404 && r.data && typeof r.data.message === 'string' && r.data.message.startsWith('Route not found')) missing.push(`${method} ${rawPath}`);
  }
  assert.deepEqual(missing, [], `Missing routes:\n${missing.join('\n')}`);
});
