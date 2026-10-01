#!/usr/bin/env node
// CLI: migrates a Clockify workspace into this application using the same service as the UI.
//
//   npm run import:clockify -- --api-key KEY --list-workspaces
//   npm run import:clockify -- --api-key KEY --source-workspace ID --target-workspace LOCAL_ID --owner-email admin@empresa.com
//   npm run import:clockify -- --api-key KEY --source-workspace ID --new-workspace --owner-email admin@empresa.com
//
// Options: --since YYYY-MM-DD, --entities users,projects,timeEntries, --region auto|global|euc1|use2|euw2|apse2,
//          --base-url https://empresa.clockify.me, --dry-run, --page-size N, --rate-per-second N, --no-member-profiles,
//          --no-reconcile
import { parseArgs } from 'node:util';
import { migrate } from '../lib/migrate.js';
import { one, rows, close } from '../lib/db.js';
import { ClockifyClient } from '../modules/importer/clockifyApi.js';
import { ENTITIES, SOURCE_REGIONS, DEFAULT_SINCE, createImportJob, runClockifyImport, prepareNewWorkspace, listWorkspacesForKey, normalizeOptions } from '../modules/importer/service.js';

const HELP = `Uso: node src/cli/import-clockify.js [opções]

  --api-key KEY             chave da API do Clockify (ou variável CLOCKIFY_API_KEY). No Clockify: foto do perfil →
                            Preferências → Avançado → Gerenciar chaves de API → Gerar nova (use a conta do proprietário
                            ou de um administrador do workspace)
  --list-workspaces         lista os workspaces acessíveis pela chave (com região e se você é administrador) e sai
  --source-workspace ID     id do workspace no Clockify (opcional se a chave só acessa um)
  --target-workspace ID     id do workspace local de destino (modo INTO_CURRENT)
  --new-workspace           cria um workspace local com o MESMO id do workspace do Clockify (modo NEW_WORKSPACE)
  --owner-email EMAIL       e-mail do usuário local que executa a importação (admin do destino / dono do novo workspace)
  --since YYYY-MM-DD        importa registros de tempo/folgas/agenda a partir desta data (padrão ${DEFAULT_SINCE})
  --entities a,b,c          etapas a executar (${ENTITIES.join(', ')})
  --region R                servidor do Clockify: ${SOURCE_REGIONS.join(', ')} (padrão auto = detecta global ou região de dados)
  --base-url URL            endereço de workspace em subdomínio (https://empresa.clockify.me) ou de um espelho da API
  --page-size N             tamanho de página dos registros de tempo (1..1000, padrão 1000)
  --rate-per-second N       requisições por segundo à API (padrão 8; o Clockify permite ~10)
  --dry-run                 apenas conta, não grava nada
  --no-member-profiles      não consulta /member-profile (mais rápido)
  --no-reconcile            não confere os totais com o relatório detalhado do Clockify (não recupera registros de
                            pessoas removidas do workspace)
  -h, --help                esta ajuda
`;

const ACCESS = { ADMIN: 'administrador', NOT_ADMIN: 'NÃO é administrador – só os seus dados seriam importados', UNKNOWN: 'permissão não verificada' };
const hours = (s) => `${(Number(s || 0) / 3600).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;

function fail(msg, code = 1) {
  console.error(`Erro: ${msg}`);
  process.exit(code);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'api-key': { type: 'string' }, 'source-workspace': { type: 'string' }, 'target-workspace': { type: 'string' }, 'new-workspace': { type: 'boolean' },
      'owner-email': { type: 'string' }, since: { type: 'string' }, entities: { type: 'string' }, region: { type: 'string' }, 'base-url': { type: 'string' }, 'page-size': { type: 'string' }, 'rate-per-second': { type: 'string' },
      'dry-run': { type: 'boolean' }, 'no-member-profiles': { type: 'boolean' }, 'no-reconcile': { type: 'boolean' }, 'list-workspaces': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    allowNegative: false,
  });
  if (values.help) { console.log(HELP); return 0; }
  const apiKey = values['api-key'] || process.env.CLOCKIFY_API_KEY;
  if (!apiKey) fail('informe --api-key ou a variável CLOCKIFY_API_KEY');
  const baseUrl = values['base-url'] || process.env.CLOCKIFY_BASE_URL || undefined;
  const region = values.region || process.env.CLOCKIFY_REGION || undefined;
  if (region && !SOURCE_REGIONS.includes(region)) fail(`--region deve ser um de: ${SOURCE_REGIONS.join(', ')}`);

  await migrate({ log: () => {} });

  if (values['list-workspaces']) {
    const info = await listWorkspacesForKey({ apiKey, baseUrl, region });
    console.log(`Chave de ${info.user.name} <${info.user.email}> – servidor ${info.endpoint.label} (${info.endpoint.baseUrl})`);
    for (const w of info.workspaces) console.log(`  ${w.id}  ${w.name}  (${w.memberships} membro(s), região ${w.regionLabel}, ${ACCESS[w.access] || w.access})`);
    return 0;
  }

  const ownerEmail = String(values['owner-email'] || '').trim().toLowerCase();
  if (!ownerEmail) fail('informe --owner-email (usuário local que executa a importação)');
  const owner = await one('SELECT * FROM users WHERE lower(email) = $1', [ownerEmail]);
  if (!owner) fail(`usuário local ${ownerEmail} não encontrado – cadastre-o primeiro (registro na UI)`);

  const options = normalizeOptions({
    sourceWorkspaceId: values['source-workspace'] || undefined, baseUrl, region, since: values.since || undefined, entities: values.entities || undefined,
    dryRun: !!values['dry-run'], memberProfiles: values['no-member-profiles'] ? false : undefined, reconcile: values['no-reconcile'] ? false : undefined,
    pageSize: values['page-size'] || undefined, ratePerSecond: values['rate-per-second'] || undefined,
    mode: values['new-workspace'] ? 'NEW_WORKSPACE' : 'INTO_CURRENT',
  });

  let workspaceId;
  if (values['new-workspace']) {
    const client = new ClockifyClient({ apiKey, baseUrl: options.baseUrl, region: options.region, log: (m) => console.log(`[clockify] ${m}`) });
    await client.locateAccount();
    let sourceId = options.sourceWorkspaceId;
    if (!sourceId) {
      const list = await client.workspaces();
      if (list.length !== 1) fail(`informe --source-workspace; workspaces disponíveis: ${list.map((w) => `${w.id} (${w.name})`).join(', ')}`);
      sourceId = list[0].id;
      options.sourceWorkspaceId = sourceId;
    }
    await client.locateWorkspace(sourceId);
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
  const rec = progress.reconciliation;
  if (rec?.error) console.log(`\nConferência com o relatório detalhado: indisponível – ${rec.error}`);
  else if (rec) {
    console.log(`\nConferência com o relatório detalhado do Clockify (desde ${String(rec.from).slice(0, 10)}):`);
    console.log(`  Clockify: ${rec.clockify.entries} registro(s), ${hours(rec.clockify.seconds)}${rec.local ? `   Clockfy: ${rec.local.entries} registro(s), ${hours(rec.local.seconds)}` : ''}`);
    for (const u of rec.users || []) {
      const ok = !u.local || (u.local.entries === u.clockify.entries);
      console.log(`  ${ok ? 'OK ' : '!! '} ${String(u.name || u.userId).padEnd(28)} ${String(u.email || '').padEnd(34)} ${String(u.clockify.entries).padStart(6)} / ${hours(u.clockify.seconds).padStart(10)}${u.local ? `  →  ${String(u.local.entries).padStart(6)} / ${hours(u.local.seconds).padStart(10)}` : ''}`);
    }
    if (rec.missing) console.log(`  ${rec.missing} registro(s) não importado(s), p.ex.: ${(rec.missingSamples || []).slice(0, 5).map((m) => m.id).join(', ')}`);
  }
  if (progress.warnings?.length) {
    console.log('\nAvisos:');
    for (const w of progress.warnings) console.log(`  - ${w}`);
  }
  const status = result?.status || progress.stage;
  console.log(`\nStatus final: ${status}${result?.error ? ` – ${result.error}` : ''}`);
  // 0 = done and reconciled, 2 = done but Clockify has entries that are not here, 1 = failed/cancelled
  if (status !== 'DONE') return 1;
  return rec && !rec.error && rec.missing ? 2 : 0;
}

main()
  .then(async (code) => { await close(); process.exit(code); })
  .catch(async (err) => { console.error(err?.message || err); await close().catch(() => {}); process.exit(1); });
