// Cria dados de demonstração: usuário admin, workspace, clientes, projetos, tarefas, tags e registros de tempo.
// Uso: npm run seed  (variáveis: SEED_EMAIL, SEED_PASSWORD, SEED_NAME, SEED_WORKSPACE)
import { migrate } from '../lib/migrate.js';
import { close, one, query, insert } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/auth.js';
import { createWorkspace, addUserToWorkspace } from '../modules/workspaces/service.js';
import { buildContext } from '../middleware/workspace.js';
import { createEntry } from '../modules/timeEntries/service.js';
import { createTask } from '../modules/projects/service.js';
import { DEFAULT_USER_SETTINGS } from '../lib/settings.js';

const email = (process.env.SEED_EMAIL || 'admin@clockfy.local').toLowerCase();
const password = process.env.SEED_PASSWORD || 'admin123';
const name = process.env.SEED_NAME || 'Administrador';
const wsName = process.env.SEED_WORKSPACE || 'Minha Empresa';

async function main() {
  await migrate({ log: () => {} });
  let user = await one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  if (!user) {
    user = await insert('users', { id: newId(), email, name, password_hash: await hashPassword(password), status: 'ACTIVE', settings: { ...DEFAULT_USER_SETTINGS, timeZone: process.env.SEED_TZ || 'America/Sao_Paulo' } });
    console.log(`[seed] usuário criado: ${email} / ${password}`);
  } else {
    console.log(`[seed] usuário já existe: ${email}`);
  }
  let ws = await one('SELECT * FROM workspaces WHERE owner_id = $1 AND name = $2', [user.id, wsName]);
  if (ws) { console.log('[seed] workspace já existe, nada a fazer'); return; }
  ws = await createWorkspace({ name: wsName, owner: user, currency: 'BRL' });
  await query('UPDATE users SET active_workspace_id = COALESCE(active_workspace_id, $2), default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [user.id, ws.id]);
  await query('UPDATE workspaces SET hourly_rate_amount = 15000 WHERE id = $1', [ws.id]);

  const members = [];
  for (const [n, e] of [['Ana Souza', 'ana@clockfy.local'], ['Carlos Lima', 'carlos@clockfy.local']]) {
    const r = await addUserToWorkspace({ workspace: ws, email: e, invitedBy: user, sendEmail: false, name: n });
    await query('UPDATE users SET password_hash = $2, status = $3 WHERE id = $1', [r.user.id, await hashPassword(password), 'ACTIVE']);
    await query("UPDATE workspace_members SET status = 'ACTIVE' WHERE workspace_id = $1 AND user_id = $2", [ws.id, r.user.id]);
    members.push(r.user);
  }
  const clients = [];
  for (const c of ['Cliente Alfa', 'Cliente Beta']) clients.push(await insert('clients', { id: newId(), workspace_id: ws.id, name: c }));
  const projects = [];
  const defs = [['Website institucional', clients[0].id, '#03A9F4', true], ['App mobile', clients[0].id, '#8BC34A', true], ['Suporte interno', clients[1].id, '#FF9800', false]];
  for (const [pn, cid, color, billable] of defs) {
    const p = await insert('projects', { id: newId(), workspace_id: ws.id, name: pn, client_id: cid, color, billable, is_public: true, hourly_rate_amount: billable ? 12000 : null, hourly_rate_currency: 'BRL', time_estimate: { estimate: 'PT80H', type: 'MANUAL', active: true, includeNonBillable: true, resetOption: null }, budget_estimate: { estimate: 0, type: 'AUTO', active: false, includeExpenses: false, resetOption: null } });
    for (const t of ['Planejamento', 'Desenvolvimento', 'Testes']) await createTask(ws.id, p.id, { name: t });
    projects.push(p);
  }
  const tags = [];
  for (const t of ['reunião', 'urgente', 'documentação']) tags.push(await insert('tags', { id: newId(), workspace_id: ws.id, name: t }));

  const wsRow = await one('SELECT * FROM workspaces WHERE id = $1', [ws.id]);
  for (const u of [user, ...members]) {
    const member = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, u.id]);
    const roleRows = u.id === user.id ? [{ role: 'OWNER' }, { role: 'WORKSPACE_ADMIN' }] : [];
    const ctx = buildContext({ workspace: wsRow, user: u, member, roleRows });
    for (let d = 1; d <= 14; d++) {
      const day = new Date(); day.setUTCDate(day.getUTCDate() - d);
      if ([0, 6].includes(day.getUTCDay())) continue;
      const p = projects[(d + u.id.charCodeAt(23)) % projects.length];
      const tasks = await one('SELECT id FROM tasks WHERE project_id = $1 LIMIT 1', [p.id]);
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0, 0));
      const dur = 3600 * (2 + (d % 4));
      await createEntry(ctx, u.id, { start: start.toISOString(), end: new Date(start.getTime() + dur * 1000).toISOString(), description: ['Reunião de alinhamento', 'Implementação de funcionalidade', 'Correção de bugs', 'Revisão de código'][d % 4], projectId: p.id, taskId: tasks?.id, tagIds: [tags[d % tags.length].id], billable: p.billable }, { origin: 'MANUAL' });
    }
  }
  console.log(`[seed] workspace "${wsName}" criado com ${projects.length} projetos, ${members.length + 1} membros e registros de tempo de exemplo.`);
  console.log(`[seed] login: ${email} / ${password}`);
}

main().then(() => close()).catch(async (e) => { console.error(e); await close(); process.exit(1); });
