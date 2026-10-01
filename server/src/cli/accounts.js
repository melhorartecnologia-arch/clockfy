#!/usr/bin/env node
// CLI: approval of new accounts and system administrators, straight on the server (e.g. when no administrator can
// sign in). Same rules as Administração › Contas de usuário.
//
//   npm run accounts -- --list [--status PENDING_APPROVAL|REJECTED|ACTIVE|ALL]
//   npm run accounts -- --approve ana@empresa.com [--workspace ID | --workspace-name "Nome"]
//   npm run accounts -- --reject ana@empresa.com [--reason "motivo"]
//   npm run accounts -- --admins | --add-admin EMAIL | --remove-admin EMAIL
import { parseArgs } from 'node:util';
import { migrate } from '../lib/migrate.js';
import { one, close } from '../lib/db.js';
import { listAccounts, approveAccount, rejectAccount, setSystemAdmin, systemAdmins } from '../modules/accounts/service.js';

const HELP = `Uso: node src/cli/accounts.js <ação>

  --list [--status S]          lista contas (padrão PENDING_APPROVAL; também REJECTED, ACTIVE, ALL)
  --approve EMAIL              aprova o cadastro (cria o workspace pedido no cadastro)
      --workspace ID           … ou adiciona a pessoa a um workspace existente
      --workspace-name NOME    … ou cria o workspace com outro nome
  --reject EMAIL [--reason T]  recusa o cadastro
  --admins                     lista os administradores do sistema (aprovam novos cadastros)
  --add-admin EMAIL            torna a conta administradora do sistema
  --remove-admin EMAIL         remove o papel (sempre fica ao menos um)
  -h, --help                   esta ajuda
`;

async function byEmail(email) {
  const u = await one('SELECT * FROM users WHERE lower(email) = $1', [String(email).trim().toLowerCase()]);
  if (!u) throw new Error(`conta ${email} não encontrada`);
  return u;
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' }, status: { type: 'string' }, approve: { type: 'string' }, workspace: { type: 'string' }, 'workspace-name': { type: 'string' },
      reject: { type: 'string' }, reason: { type: 'string' }, admins: { type: 'boolean' }, 'add-admin': { type: 'string' }, 'remove-admin': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !Object.keys(values).length) { console.log(HELP); return 0; }
  await migrate({ log: () => {} });

  if (values.list) {
    const { total, accounts } = await listAccounts({ status: (values.status || 'PENDING_APPROVAL').toUpperCase(), limit: 500 });
    console.log(`${total} conta(s)`);
    for (const a of accounts) console.log(`  ${a.status.padEnd(26)} ${a.email.padEnd(36)} ${a.name}${a.systemAdmin ? '  [admin do sistema]' : ''}  (cadastro ${String(a.createdAt).slice(0, 10)}${a.requestedWorkspaceName ? `, workspace pedido: ${a.requestedWorkspaceName}` : ''})`);
  } else if (values.approve) {
    const u = await byEmail(values.approve);
    const { account, workspace } = await approveAccount({ userId: u.id, approver: null, workspaceId: values.workspace, workspaceName: values['workspace-name'] });
    console.log(`Aprovada: ${account.name} <${account.email}>${workspace ? ` – workspace ${workspace.name} (${workspace.id})` : ''}`);
  } else if (values.reject) {
    const u = await byEmail(values.reject);
    await rejectAccount({ userId: u.id, approver: null, reason: values.reason });
    console.log(`Recusada: ${u.name} <${u.email}>`);
  } else if (values.admins) {
    for (const a of await systemAdmins()) console.log(`  ${a.email}  ${a.name}`);
  } else if (values['add-admin'] || values['remove-admin']) {
    const u = await byEmail(values['add-admin'] || values['remove-admin']);
    const row = await setSystemAdmin({ userId: u.id, value: !!values['add-admin'] });
    console.log(`${row.name} <${row.email}>: ${row.is_super_admin ? 'agora é' : 'não é mais'} administrador do sistema`);
  } else {
    console.log(HELP);
  }
  return 0;
}

main()
  .then(async (code) => { await close(); process.exit(code); })
  .catch(async (err) => { console.error(`Erro: ${err.message}`); await close().catch(() => {}); process.exit(1); });
