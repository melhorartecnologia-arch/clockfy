#!/usr/bin/env node
// CLI: migrates a Clockify workspace into this application using the same service as the UI.
//
//   npm run import:clockify -- --api-key KEY --source-workspace ID --target-workspace LOCAL_ID --owner-email admin@empresa.com
//   npm run import:clockify -- --api-key KEY --source-workspace ID --new-workspace --owner-email admin@empresa.com
//
// Options: --since YYYY-MM-DD, --entities users,projects,timeEntries, --base-url https://api.clockify.me/api/v1,
//          --dry-run, --list-workspaces, --page-size N, --no-member-profiles
import { parseArgs } from 'node:util';
import { migrate } from '../lib/migrate.js';
import { one, rows, close } from '../lib/db.js';
import { ClockifyClient } from '../modules/importer/clockifyApi.js';
import { ENTITIES, createImportJob, runClockifyImport, prepareNewWorkspace, listWorkspacesForKey, normalizeOptions } from '../modules/importer/service.js';

const HELP = `Uso: node src/cli/import-clockify.js [opções]

  --api-key KEY             chave da API do Clockify (ou variável CLOCKIFY_API_KEY)
  --source-workspace ID     id do workspace no Clockify (opcional se a chave só acessa um)
  --target-workspace ID     id do workspace local de destino (modo INTO_CURRENT)
  --new-workspace           cria um workspace local com o MESMO id do workspace do Clockify (modo NEW_WORKSPACE)
  --owner-email EMAIL       e-mail do usuário local que executa a importação (admin do destino / dono do novo workspace)
  --since YYYY-MM-DD        importa registros de tempo/folgas/agenda a partir desta data (padrão 2010-01-01)
  --entities a,b,c          etapas a executar (${ENTITIES.join(', ')})
  --base-url URL            URL base da API (padrão https://api.clockify.me/api/v1; regional: https://<região>.api.clockify.me/api/v1)
  --page-size N             tamanho de página para registros de tempo (padrão 1000)
  --dry-run                 apenas conta, não grava nada
  --no-member-profiles      não consulta /member-profile (mais rápido)
  --list-workspaces         lista os workspaces acessíveis pela chave e sai
  -h, --help                esta ajuda
`;

function fail(msg, code = 1) {
  console.error(`Erro: ${msg}`);
  process.exit(code);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'api-key': { type: 'string' }, 'source-workspace': { type: 'string' }, 'target-workspace': { type: 'string' }, 'new-workspace': { type: 'boolean' },
      'owner-email': { type: 'string' }, since: { type: 'string' }, entities: { type: 'string' }, 'base-url': { type: 'string' }, 'page-size': { type: 'string' },
      'dry-run': { type: 'boolean' }, 'no-member-profiles': { type: 'boolean' }, 'list-workspaces': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    allowNegative: false,
  });
  if (values.help) { console.log(HELP); return 0; }
  const apiKey = values['api-key'] || process.env.CLOCKIFY_API_KEY;
  if (!apiKey) fail('informe --api-key ou a variável CLOCKIFY_API_KEY');
  const baseUrl = values['base-url'] || process.env.CLOCKIFY_BASE_URL || undefined;

  await migrate({ log: () => {} });

  if (values['list-workspaces']) {
    const info = await listWorkspacesForKey({ apiKey, baseUrl });
    console.log(`Chave de ${info.user.name} <${info.user.email}>`);
    for (const w of info.workspaces) console.log(`  ${w.id}  ${w.name}  (${w.memberships} membro(s))`);
    return 0;
  }

  const ownerEmail = String(values['owner-email'] || '').trim().toLowerCase();
  if (!ownerEmail) fail('informe --owner-email (usuário local que executa a importação)');
  const owner = await one('SELECT * FROM users WHERE lower(email) = $1', [ownerEmail]);
  if (!owner) fail(`usuário local ${ownerEmail} não encontrado – cadastre-o primeiro (registro na UI)`);

  const options = normalizeOptions({
    sourceWorkspaceId: values['source-workspace'] || undefined, baseUrl, since: values.since || undefined, entities: values.entities || undefined,
    dryRun: !!values['dry-run'], memberProfiles: values['no-member-profiles'] ? false : undefined, pageSize: values['page-size'] || undefined,
    mode: values['new-workspace'] ? 'NEW_WORKSPACE' : 'INTO_CURRENT',
  });

  let workspaceId;
  if (values['new-workspace']) {
    const client = new ClockifyClient({ apiKey, baseUrl, log: (m) => console.log(`[clockify] ${m}`) });
    let sourceId = options.sourceWorkspaceId;
    if (!sourceId) {
      const list = await client.workspaces();
      if (list.length !== 1) fail(`informe --source-workspace; workspaces disponíveis: ${list.map((w) => `${w.id} (${w.name})`).join(', ')}`);
      sourceId = list[0].id;
      options.sourceWorkspaceId = sourceId;
    }
    const src = await client.workspace(sourceId);
    const ws = await prepareNewWorkspace({ sourceWorkspace: src, owner, dryRun: options.dryRun });
    workspaceId = ws.id;
    console.log(`${options.dryRun ? '[simulação] ' : ''}Workspace local ${ws.name} (${ws.id}) – dono ${owner.email}`);
  } else {
    workspaceId = values['target-workspace'];
    if (!workspaceId) fail('informe --target-workspace <id local> ou --new-workspace');
    const ws = await one('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (!ws) fail(`workspace local ${workspaceId} não encontrado`);
    const adminRoles = await rows("SELECT 1 FROM roles WHERE workspace_id = $1 AND user_id = $2 AND role IN ('OWNER','WORKSPACE_ADMIN')", [ws.id, owner.id]);
    if (ws.owner_id !== owner.id && !adminRoles.length && !owner.is_super_admin) fail(`${owner.email} não é administrador do workspace ${ws.name}`);
    console.log(`Destino: ${ws.name} (${ws.id}) – executado por ${owner.email}`);
  }

  // In a dry run of NEW_WORKSPACE the target does not exist, so the job is kept in memory only.
  const persisted = !(values['new-workspace'] && options.dryRun);
  const job = persisted
    ? await createImportJob({ workspaceId, userId: owner.id, source: 'CLOCKIFY_API', options })
    : { id: null, workspace_id: workspaceId, user_id: owner.id, source: 'CLOCKIFY_API', options, progress: {}, log: [] };
  if (job.id) console.log(`Job ${job.id} criado. Acompanhe também em GET /api/v1/workspaces/${workspaceId}/import/jobs/${job.id}`);

  let lastLine = '';
  const result = await runClockifyImport(job, {
    apiKey,
    onLog: (message) => { process.stdout.write(`\r${' '.repeat(lastLine.length)}\r`); lastLine = ''; console.log(message); },
    onProgress: (p) => {
      const line = `  [${p.stage}] ${p.current || 0}${p.total ? `/${p.total}` : ''} ${p.detail || ''}`;
      if (line !== lastLine) { process.stdout.write(`\r${' '.repeat(lastLine.length)}\r${line}`); lastLine = line; }
    },
  });
  if (lastLine) process.stdout.write('\n');
  const progress = result?.progress || job.progress || {};
  console.log('\nResumo:');
  for (const [entity, d] of Object.entries(progress.details || {})) {
    console.log(`  ${entity.padEnd(20)} lidos ${String(d.fetched).padStart(6)}  criados ${String(d.created).padStart(6)}  atualizados ${String(d.updated).padStart(6)}  ignorados ${String(d.skipped).padStart(6)}  erros ${String(d.errors).padStart(4)}`);
  }
  const status = result?.status || progress.stage;
  console.log(`\nStatus final: ${status}${result?.error ? ` – ${result.error}` : ''}`);
  return status === 'DONE' ? 0 : 1;
}

main()
  .then(async (code) => { await close(); process.exit(code); })
  .catch(async (err) => { console.error(err?.message || err); await close().catch(() => {}); process.exit(1); });
