import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, ws } from '../api.js';
import { invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Confirm } from '../components/ui.jsx';
import { useAsync, useInterval } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

const ENTITIES = [
  ['workspace', 'Configurações do workspace'], ['users', 'Membros'], ['userGroups', 'Grupos'], ['clients', 'Clientes'], ['projects', 'Projetos'], ['tasks', 'Tarefas'],
  ['tags', 'Etiquetas'], ['customFields', 'Campos personalizados'], ['timeEntries', 'Registros de tempo'], ['expenses', 'Despesas'], ['holidays', 'Feriados'],
  ['timeOff', 'Folgas'], ['approvals', 'Aprovações'], ['scheduling', 'Agenda'], ['invoices', 'Faturas'], ['webhooks', 'Webhooks'],
];
const STATUS = { PENDING: ['Na fila', ''], RUNNING: ['Executando', 'primary'], DONE: ['Concluído', 'success'], FAILED: ['Falhou', 'danger'], CANCELLED: ['Cancelado', 'warning'] };
// Clockify servers: global cloud, data regions and subdomain workspaces (https://empresa.clockify.me)
const SERVERS = [
  ['auto', 'Detectar automaticamente (recomendado)'], ['global', 'Global – app.clockify.me'], ['euc1', 'União Europeia (Alemanha)'],
  ['use2', 'Estados Unidos'], ['euw2', 'Reino Unido'], ['apse2', 'Austrália'], ['custom', 'Subdomínio próprio (empresa.clockify.me)'],
];
const REGION_CODES = ['euc1', 'use2', 'euw2', 'apse2'];
const hours = (s) => `${(Number(s || 0) / 3600).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
const num = (n) => Number(n || 0).toLocaleString('pt-BR');

export default function Import() {
  const { workspace, isAdmin, toast } = useStore();
  const wsId = workspace?.id;
  const [source, setSource] = useState('api'); // api | csv
  const [step, setStep] = useState(1);
  const [jobId, setJobId] = useState(null);
  const { data: jobs, reload: reloadJobs } = useAsync(() => api.get(`${ws(wsId)}/import/jobs`).catch((e) => { if (e.status === 404) return []; throw e; }), [wsId], { initial: [] });

  if (!isAdmin) return <div className="card"><Empty icon="⇩" title="Somente administradores">A importação de dados só pode ser feita por administradores do workspace.</Empty></div>;
  return (
    <div>
      <div className="page-header"><h1>Importar do Clockify</h1></div>
      <div className="card">
        <div className="card-body">
          <div className="import-steps">
            {['Origem', source === 'api' ? 'Opções' : 'Arquivo e opções', 'Execução'].map((s, i) => <div key={s} className={`import-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}><span className="n">{i + 1}</span>{s}</div>)}
          </div>
          {step === 1 && (
            <div>
              <p className="muted">Escolha de onde os dados serão importados. A migração preserva os IDs originais do Clockify sempre que possível, permitindo sincronizações incrementais e mantendo integrações funcionando.</p>
              <div className="grid cols-2">
                <div className={`import-option ${source === 'api' ? 'on' : ''}`} onClick={() => setSource('api')}>
                  <div className="bold">API do Clockify</div>
                  <div className="small muted mt">Conecta diretamente à sua conta Clockify usando uma chave de API e importa clientes, projetos, tarefas, membros, etiquetas, campos personalizados e registros de tempo. Recomendado.</div>
                </div>
                <div className={`import-option ${source === 'csv' ? 'on' : ''}`} onClick={() => setSource('csv')}>
                  <div className="bold">Arquivo CSV exportado</div>
                  <div className="small muted mt">Importa registros de tempo a partir de um relatório detalhado exportado do Clockify (Reports → Detailed → Export → CSV) ou de um modelo de planilha.</div>
                </div>
              </div>
              <div className="row mt"><button className="btn right" onClick={() => setStep(2)}>Continuar</button></div>
            </div>
          )}
          {step === 2 && source === 'api' && <ApiWizard onBack={() => setStep(1)} onStarted={(id) => { setJobId(id); setStep(3); reloadJobs(); }} />}
          {step === 2 && source === 'csv' && <CsvWizard onBack={() => setStep(1)} onDone={() => { invalidateCache(wsId); reloadJobs(); }} />}
          {step === 3 && jobId && <JobMonitor jobId={jobId} onFinished={() => { invalidateCache(wsId); reloadJobs(); }} onNew={() => { setJobId(null); setStep(1); }} />}
        </div>
      </div>
      <JobHistory jobs={jobs || []} onOpen={(id) => { setJobId(id); setStep(3); }} onReload={reloadJobs} />
    </div>
  );
}

function ApiWizard({ onBack, onStarted }) {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const [apiKey, setApiKey] = useState('');
  const [server, setServer] = useState('auto');
  const [baseUrl, setBaseUrl] = useState('');
  const [remote, setRemote] = useState(null); // list of clockify workspaces
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');
  const [mode, setMode] = useState('INTO_CURRENT');
  const [entities, setEntities] = useState(ENTITIES.map(([k]) => k));
  const [since, setSince] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [reconcile, setReconcile] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  // where the key belongs: nothing (auto-detect), a data region, or the subdomain address
  const serverParams = () => (server === 'custom' ? { baseUrl: baseUrl.trim() || undefined } : server === 'auto' ? {} : { region: server });

  async function connect() {
    if (!apiKey.trim()) { setError('Informe a chave de API'); return; }
    if (server === 'custom' && !baseUrl.trim()) { setError('Informe o endereço do seu Clockify (ex.: https://empresa.clockify.me)'); return; }
    setBusy(true); setError(null); setRemote(null);
    try {
      const list = await api.post(`${ws(wsId)}/import/clockify/workspaces`, { apiKey: apiKey.trim(), ...serverParams() });
      setRemote(list);
      const preferred = list.find((w) => w.id === list[0]?.apiUser?.activeWorkspace) || list[0];
      setSourceWorkspaceId(preferred?.id || '');
      if (!list.length) setError('Nenhum workspace encontrado para esta chave.');
    } catch (e) { setError(e.status === 404 ? 'O módulo de importação não está disponível neste servidor.' : errorMessage(e)); } finally { setBusy(false); }
  }
  const selectedWs = remote?.find((w) => w.id === sourceWorkspaceId);
  async function start() {
    setBusy(true); setError(null);
    try {
      // with auto-detection, a workspace found in a data region is imported from that region directly
      const params = server === 'auto' && REGION_CODES.includes(selectedWs?.region) ? { region: selectedWs.region } : serverParams();
      const r = await api.post(`${ws(wsId)}/import/clockify`, {
        apiKey: apiKey.trim(), ...params, sourceWorkspaceId: sourceWorkspaceId || undefined, mode, entities, since: since ? `${since}T00:00:00Z` : undefined, dryRun, reconcile,
      });
      toast(dryRun ? 'Simulação iniciada' : 'Importação iniciada', 'success');
      onStarted(r.jobId || r.id);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const toggle = (k) => setEntities((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));
  const apiUser = remote?.[0]?.apiUser;
  const endpoint = remote?.[0]?.apiEndpoint;

  return (
    <div>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <h3>1. Conectar ao Clockify</h3>
          <div className="alert info small">
            <b>Como gerar a chave de API no Clockify:</b>
            <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Entre no Clockify com a conta do <b>proprietário</b> ou de um <b>administrador</b> do workspace (só eles enxergam os dados de toda a equipe).</li>
              <li>Clique na sua foto (canto superior direito) → <b>Preferências</b> → aba <b>Avançado</b>.</li>
              <li>Em <b>Gerenciar chaves de API</b>, clique em <b>Gerar nova</b> e copie a chave — ela só aparece uma vez.</li>
            </ol>
            <div className="mt">A chave fica só na memória durante a importação: não é gravada no banco nem aparece nos registros.</div>
          </div>
          <div className="field"><label>Chave de API do Clockify</label><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Cole aqui a chave gerada no Clockify" autoComplete="off" autoFocus /></div>
          <div className="field"><label>Servidor do Clockify</label>
            <select value={server} onChange={(e) => { setServer(e.target.value); setRemote(null); }}>{SERVERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <div className="small muted mt">Na dúvida deixe em “Detectar automaticamente”: a conta e o workspace são procurados no servidor global e nas regiões de dados (UE, EUA, Reino Unido, Austrália).</div>
          </div>
          {server === 'custom' && (
            <div className="field"><label>Endereço do seu Clockify</label><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://empresa.clockify.me" />
              <div className="small muted mt">Workspaces com subdomínio exigem uma chave gerada dentro do próprio subdomínio.</div>
            </div>
          )}
          <button className="btn secondary" disabled={busy} onClick={connect}>{busy && !remote ? 'Conectando…' : remote ? 'Reconectar' : 'Conectar e listar workspaces'}</button>
          {apiUser && (
            <div className="alert success small mt">
              Conectado como <b>{apiUser.name}</b> &lt;{apiUser.email}&gt;{endpoint?.label ? <> · servidor <b>{endpoint.label}</b></> : null}
            </div>
          )}
        </div>
        <div>
          <h3>2. O que importar</h3>
          {!remote ? <div className="light small">Conecte-se primeiro para escolher o workspace de origem.</div> : (
            <>
              <div className="field"><label>Workspace de origem</label><select value={sourceWorkspaceId} onChange={(e) => setSourceWorkspaceId(e.target.value)}>{remote.map((w) => <option key={w.id} value={w.id}>{w.name}{w.regionLabel && w.region !== 'global' ? ` (${w.regionLabel})` : ''}</option>)}</select></div>
              {selectedWs && <AccessNotice ws={selectedWs} />}
              <div className="field"><label>Destino</label>
                <label className="checkbox"><input type="radio" checked={mode === 'INTO_CURRENT'} onChange={() => setMode('INTO_CURRENT')} /> Importar para o workspace atual (<b>{workspace.name}</b>)</label>
                <label className="checkbox mt"><input type="radio" checked={mode === 'NEW_WORKSPACE'} onChange={() => setMode('NEW_WORKSPACE')} /> Criar um novo workspace com o mesmo ID do Clockify ({selectedWs?.id})</label>
                <div className="small muted mt">Criar com o mesmo ID permite que integrações existentes continuem funcionando apenas trocando a URL base.</div>
              </div>
              <div className="field"><label>Entidades</label><div className="row gap wrap">{ENTITIES.map(([k, label]) => <label key={k} className="checkbox"><input type="checkbox" checked={entities.includes(k)} onChange={() => toggle(k)} />{label}</label>)}</div></div>
              <div className="grid cols-2">
                <div className="field"><label>Importar registros desde (opcional)</label><input type="date" value={since} onChange={(e) => setSince(e.target.value)} /><div className="small muted mt">Deixe em branco para trazer todo o histórico. Para sincronizar de novo depois, informe a data da última importação: registros já existentes (mesmo ID) são atualizados, não duplicados.</div></div>
                <div className="field"><label>Opções</label>
                  <label className="checkbox"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Apenas simular (não grava nada)</label>
                  <label className="checkbox mt"><input type="checkbox" checked={reconcile} onChange={(e) => setReconcile(e.target.checked)} /> Conferir com o relatório detalhado do Clockify (recomendado)</label>
                  <div className="small muted mt">A conferência compara, pessoa por pessoa, os registros e as horas do Clockify com o que foi importado, e recupera o histórico de quem já saiu do workspace.</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="row mt">
        <button className="btn ghost" onClick={onBack}>← Voltar</button>
        <button className="btn right" disabled={busy || !remote || !sourceWorkspaceId || !entities.length} onClick={() => (dryRun ? start() : setConfirm({ title: 'Iniciar importação', message: `Importar ${entities.length} tipo(s) de dado do workspace “${selectedWs?.name}” ${mode === 'INTO_CURRENT' ? `para “${workspace.name}”` : 'para um novo workspace'}? A operação roda em segundo plano e pode levar de minutos a algumas horas em workspaces grandes. Pode fechar esta página: o andamento fica no histórico abaixo.`, confirmLabel: 'Importar', onConfirm: start }))}>{dryRun ? 'Simular importação' : 'Iniciar importação'}</button>
      </div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// Whether the key owner administers the chosen Clockify workspace (only admins see everybody's data).
function AccessNotice({ ws: w }) {
  if (w.access === 'ADMIN') return <div className="alert success small">Você é administrador deste workspace no Clockify: os dados de toda a equipe serão importados.</div>;
  if (w.access === 'NOT_ADMIN') {
    return <div className="alert warning small"><b>Você não é administrador deste workspace no Clockify.</b> Só os seus próprios registros seriam importados. Para migrar a equipe inteira, use a chave de API do proprietário ou de um administrador.</div>;
  }
  return <div className="alert info small">Não foi possível confirmar se você é administrador deste workspace no Clockify. Para migrar os dados de toda a equipe, a chave deve ser do proprietário ou de um administrador.</div>;
}

function CsvWizard({ onBack, onDone }) {
  const { workspace, timeZone, dateFormat, timeFormat, toast } = useStore();
  const wsId = workspace?.id;
  const [file, setFile] = useState(null);
  const [opts, setOpts] = useState({ format: 'AUTO', timeZone, dateFormat, timeFormat, createMissing: true, dryRun: false });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const timeZones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [timeZone]; } }, [timeZone]);

  async function upload() {
    if (!file) { setError('Selecione um arquivo CSV'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      for (const [k, v] of Object.entries(opts)) fd.append(k, String(v));
      const r = await api.post(`${ws(wsId)}/import/csv`, fd);
      setResult(r);
      toast(opts.dryRun ? 'Simulação concluída' : `${r.created ?? 0} registro(s) importado(s)`, 'success');
      if (!opts.dryRun) onDone();
    } catch (e) { setError(e.status === 404 ? 'O módulo de importação não está disponível neste servidor.' : errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <h3>Arquivo</h3>
          <div className="field"><label>Arquivo CSV</label><input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
          <div className="field"><label>Formato</label><select value={opts.format} onChange={(e) => set('format', e.target.value)}><option value="AUTO">Detectar automaticamente</option><option value="DETAILED_REPORT">Relatório detalhado do Clockify</option><option value="TIMESHEET_TEMPLATE">Modelo de planilha (Project, Client, Description, Task, User, Email, Tags, Billable, Start Date, Start Time, End Date, End Time, Duration)</option></select></div>
          <div className="alert info small">No Clockify: <b>Reports → Detailed</b>, escolha o período, clique em <b>Export → CSV</b>. Exporte com o fuso horário e os formatos de data/hora indicados ao lado. Relatórios com mais de alguns milhares de linhas podem ser divididos em vários arquivos.</div>
        </div>
        <div>
          <h3>Opções</h3>
          <div className="grid cols-2">
            <div className="field"><label>Fuso horário do arquivo</label><select value={opts.timeZone} onChange={(e) => set('timeZone', e.target.value)}>{timeZones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}</select></div>
            <div className="field"><label>Formato de data</label><select value={opts.dateFormat} onChange={(e) => set('dateFormat', e.target.value)}><option value="DD/MM/YYYY">DD/MM/AAAA</option><option value="MM/DD/YYYY">MM/DD/AAAA</option><option value="YYYY-MM-DD">AAAA-MM-DD</option></select></div>
            <div className="field"><label>Formato de hora</label><select value={opts.timeFormat} onChange={(e) => set('timeFormat', e.target.value)}><option value="HOUR24">24 horas</option><option value="HOUR12">12 horas (AM/PM)</option></select></div>
          </div>
          <label className="checkbox"><input type="checkbox" checked={opts.createMissing} onChange={(e) => set('createMissing', e.target.checked)} /> Criar projetos, clientes, tarefas e etiquetas ausentes</label>
          <label className="checkbox mt"><input type="checkbox" checked={opts.dryRun} onChange={(e) => set('dryRun', e.target.checked)} /> Apenas simular (validar sem gravar)</label>
        </div>
      </div>
      <div className="row mt">
        <button className="btn ghost" onClick={onBack}>← Voltar</button>
        <button className="btn right" disabled={busy || !file} onClick={upload}>{busy ? 'Processando…' : opts.dryRun ? 'Simular' : 'Importar'}</button>
      </div>
      {busy && <Spinner block />}
      {result && (
        <div className="mt">
          <div className="grid cols-3">
            <div className="card stat"><div className="label">{opts.dryRun ? 'Seriam criados' : 'Criados'}</div><div className="value">{result.created ?? 0}</div></div>
            <div className="card stat"><div className="label">Ignorados</div><div className="value">{result.skipped ?? 0}</div></div>
            <div className="card stat"><div className="label">Erros</div><div className="value" style={{ color: result.errors?.length ? 'var(--danger)' : undefined }}>{result.errors?.length ?? 0}</div></div>
          </div>
          {result.counts && <div className="row gap wrap mt">{Object.entries(result.counts).map(([k, v]) => <span key={k} className="chip">{k}: <b>{typeof v === 'object' ? JSON.stringify(v) : v}</b></span>)}</div>}
          {result.errors?.length > 0 && (
            <div className="card mt"><div className="card-head"><h3 style={{ margin: 0 }}>Erros por linha</h3></div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}><table className="table compact"><thead><tr><th style={{ width: 80 }}>Linha</th><th>Mensagem</th></tr></thead><tbody>{result.errors.map((e, i) => <tr key={i}><td className="mono">{e.line}</td><td>{e.message}</td></tr>)}</tbody></table></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JobMonitor({ jobId, onFinished, onNew }) {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const active = !job || job.status === 'PENDING' || job.status === 'RUNNING';
  const fetchJob = async () => {
    try { const j = await api.get(`${ws(wsId)}/import/jobs/${jobId}`); setJob(j); setError(null); if (j.status !== 'PENDING' && j.status !== 'RUNNING') onFinished(); } catch (e) { setError(errorMessage(e)); }
  };
  useEffect(() => { setJob(null); fetchJob(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobId]);
  useInterval(fetchJob, active ? 2000 : null);
  async function cancel() {
    try { await api.post(`${ws(wsId)}/import/jobs/${jobId}/cancel`); toast('Cancelamento solicitado'); fetchJob(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  if (error && !job) return <Alert type="error">{error}</Alert>;
  if (!job) return <Spinner block />;
  const p = job.progress || {}; const pct = p.total ? Math.min(100, Math.round((p.current / p.total) * 100)) : (job.status === 'DONE' ? 100 : null);
  const [label, cls] = STATUS[job.status] || [job.status, ''];
  return (
    <div>
      <div className="row gap wrap mb">
        <span className={`badge ${cls}`}>{label}</span>
        <span className="muted small">Job {job.id} · origem: {job.source || 'clockify'}{job.options?.dryRun ? ' · simulação' : ''}{job.options?.since ? ` · desde ${String(job.options.since).slice(0, 10)}` : ''}</span>
        <span className="muted small">{job.startedAt && `Início ${new Date(job.startedAt).toLocaleString('pt-BR')}`}{job.finishedAt && ` · Fim ${new Date(job.finishedAt).toLocaleString('pt-BR')}`}</span>
        {active && <button className="btn secondary sm right" onClick={() => setConfirm({ title: 'Cancelar importação', message: 'Cancelar a importação em andamento? Os dados já gravados serão mantidos.', confirmLabel: 'Cancelar importação', danger: true, onConfirm: cancel })}>Cancelar</button>}
        {!active && <button className="btn secondary sm right" onClick={onNew}>Nova importação</button>}
      </div>
      <div className="row gap"><span className="bold" style={{ minWidth: 160 }}>{p.stage ? stageLabel(p.stage) : (active ? 'Aguardando…' : '')}</span><div className="progress grow" style={{ height: 12 }}><div className={job.status === 'FAILED' ? 'over' : ''} style={{ width: `${pct ?? (active ? 15 : 0)}%`, transition: 'width .4s' }} /></div><span className="mono small" style={{ minWidth: 90, textAlign: 'right' }}>{p.total ? `${p.current} / ${p.total}` : pct != null ? `${pct}%` : ''}</span></div>
      {p.sourceWorkspaceName && <div className="small muted mt">Origem: <b>{p.sourceWorkspaceName}</b>{p.sourceUser?.email ? ` · chave de ${p.sourceUser.email}` : ''}{p.sourceEndpoint?.label ? ` · servidor ${p.sourceEndpoint.label}` : ''}</div>}
      {job.error && <Alert type="error">{job.error}</Alert>}
      {p.warnings?.length > 0 && (
        <div className="alert warning mt small"><b>Atenção</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
      {p.reconciliation && <Reconciliation rec={p.reconciliation} dryRun={!!job.options?.dryRun} />}
      {p.stages && Object.keys(p.stages).length > 0 && (
        <table className="table compact mt">
          <thead><tr><th>Etapa</th><th>Status</th><th className="num">Lidos</th><th className="num">Criados</th><th className="num">Atualizados</th><th className="num">Ignorados</th><th className="num">Erros</th></tr></thead>
          <tbody>{orderedStages(p.stages).map(([k, st]) => { const d = stageDetails(p.details, k); const sl = { DONE: ['Concluída', 'success'], FAILED: ['Falhou', 'danger'], SKIPPED: ['Ignorada', ''], RUNNING: ['Executando', 'primary'] }[st.status] || [st.status, '']; return (
            <tr key={k}><td>{stageLabel(k)}</td><td><span className={`badge ${sl[1]}`}>{sl[0]}</span>{st.error && <span className="small muted ml" title={st.error}>{String(st.error).slice(0, 80)}</span>}</td><td className="num mono">{d.fetched ?? '—'}</td><td className="num mono">{d.created ?? '—'}</td><td className="num mono">{d.updated ?? '—'}</td><td className="num mono">{d.skipped ?? '—'}</td><td className="num mono" style={d.errors ? { color: 'var(--danger)' } : undefined}>{d.errors ?? '—'}</td></tr>
          ); })}</tbody>
        </table>
      )}
      {!p.stages && p.counts && Object.keys(p.counts).length > 0 && (
        <div className="row gap wrap mt">{Object.entries(p.counts).map(([k, v]) => <span key={k} className="chip">{stageLabel(k)}: <b>{typeof v === 'object' ? JSON.stringify(v) : v}</b></span>)}</div>
      )}
      <div className="import-log mt">
        {(job.log || []).length === 0 ? <div className="light">Sem mensagens ainda…</div> : (job.log || []).map((l, i) => <div key={i} className={typeof l === 'object' && l.level === 'error' ? 'err' : ''}>{typeof l === 'string' ? l : `${l.at || l.time ? `[${new Date(l.at || l.time).toLocaleTimeString('pt-BR')}] ` : ''}${l.message || JSON.stringify(l)}`}</div>)}
      </div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// Clockify (detailed report) × Clockfy, person by person.
function Reconciliation({ rec, dryRun }) {
  if (rec.error) return <div className="alert warning mt small"><b>Conferência com o relatório detalhado indisponível:</b> {rec.error}</div>;
  const ok = !dryRun && rec.missing === 0 && rec.complete !== false;
  return (
    <div className="card mt">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>Conferência com o Clockify</h3>
        <span className="small muted ml">relatório detalhado desde {String(rec.from || '').slice(0, 10).split('-').reverse().join('/')}</span>
        <span className={`badge right ${dryRun ? '' : ok ? 'success' : 'warning'}`}>{dryRun ? 'Simulação' : ok ? 'Tudo conferido' : rec.missing ? `${num(rec.missing)} registro(s) faltando` : 'Conferência incompleta'}</span>
      </div>
      <div className="card-body">
        <div className="grid cols-3">
          <div className="card stat"><div className="label">No Clockify</div><div className="value">{num(rec.clockify?.entries)}</div><div className="small muted">{hours(rec.clockify?.seconds)}</div></div>
          <div className="card stat"><div className="label">{dryRun ? 'No Clockfy (simulação)' : 'No Clockfy'}</div><div className="value">{rec.local ? num(rec.local.entries) : '—'}</div><div className="small muted">{rec.local ? hours(rec.local.seconds) : 'nada é gravado na simulação'}</div></div>
          <div className="card stat"><div className="label">Recuperados pelo relatório</div><div className="value">{num(rec.recovered)}</div><div className="small muted">registros que a listagem por pessoa não trouxe</div></div>
        </div>
        {rec.removedUsers?.length > 0 && <div className="small muted mt">Pessoas fora do workspace no Clockify, incluídas como membros inativos: {rec.removedUsers.join(', ')}</div>}
        {rec.users?.length > 0 && (
          <div style={{ maxHeight: 320, overflowY: 'auto' }} className="mt">
            <table className="table compact">
              <thead><tr><th>Pessoa</th><th>E-mail</th><th className="num">Clockify</th><th className="num">Horas</th><th className="num">Clockfy</th><th className="num">Horas</th><th /></tr></thead>
              <tbody>{rec.users.map((u) => {
                const good = !u.local || (u.local.entries === u.clockify.entries && Math.abs(u.local.seconds - u.clockify.seconds) < 60);
                return (
                  <tr key={u.userId}>
                    <td>{u.name || u.userId}</td><td className="small muted">{u.email || 'sem e-mail'}</td>
                    <td className="num mono">{num(u.clockify.entries)}</td><td className="num mono">{hours(u.clockify.seconds)}</td>
                    <td className="num mono">{u.local ? num(u.local.entries) : '—'}</td><td className="num mono">{u.local ? hours(u.local.seconds) : '—'}</td>
                    <td>{u.local && <span className={`badge ${good ? 'success' : 'warning'}`}>{good ? 'OK' : 'Diferença'}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {rec.missingSamples?.length > 0 && (
          <div className="mt"><div className="small bold">Exemplos de registros não importados (veja os erros no log):</div>
            <table className="table compact"><tbody>{rec.missingSamples.slice(0, 10).map((m) => <tr key={m.id}><td className="mono small">{m.id}</td><td className="small">{m.userName}</td><td className="small">{m.start ? new Date(m.start).toLocaleString('pt-BR') : ''}</td><td className="small truncate">{m.description}</td></tr>)}</tbody></table>
          </div>
        )}
      </div>
    </div>
  );
}

// JSONB does not keep key order: show the stages in execution order.
const STAGE_ORDER = ENTITIES.map(([k]) => k);
function orderedStages(stages) {
  return Object.entries(stages || {}).sort(([a], [b]) => (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99));
}

// Some stages count their parts separately (time off: policies, balances and requests).
const STAGE_PARTS = { timeOff: ['timeOffPolicies', 'timeOffBalances', 'timeOffRequests'] };
function stageDetails(details = {}, k) {
  if (details[k] || !STAGE_PARTS[k]) return details[k] || {};
  const parts = STAGE_PARTS[k].map((x) => details[x]).filter(Boolean);
  if (!parts.length) return {};
  return parts.reduce((acc, d) => Object.fromEntries(['fetched', 'created', 'updated', 'skipped', 'errors'].map((f) => [f, (acc[f] || 0) + (d[f] || 0)])), {});
}

function stageLabel(k) {
  const map = { ...Object.fromEntries(ENTITIES), PENDING: 'Na fila', STARTING: 'Preparando', DONE: 'Concluído', rows: 'Linhas', created: 'Criados', skipped: 'Ignorados', errors: 'Erros' };
  return map[k] || k;
}

function JobHistory({ jobs, onOpen, onReload }) {
  if (!jobs.length) return null;
  return (
    <div className="card mt">
      <div className="card-head"><h3 style={{ margin: 0 }}>Histórico de importações</h3><button className="btn ghost sm right" onClick={onReload}>Atualizar</button></div>
      <table className="table compact">
        <thead><tr><th>Início</th><th>Origem</th><th>Status</th><th>Progresso</th><th>Resumo</th><th /></tr></thead>
        <tbody>{jobs.map((j) => { const [label, cls] = STATUS[j.status] || [j.status, '']; const c = j.progress?.counts || {}; return (
          <tr key={j.id}>
            <td className="small">{j.startedAt || j.createdAt ? new Date(j.startedAt || j.createdAt).toLocaleString('pt-BR') : '—'}</td>
            <td>{j.source || 'clockify'}{j.options?.dryRun && <span className="badge ml">Simulação</span>}{j.options?.mode === 'NEW_WORKSPACE' && <span className="badge ml">Novo workspace</span>}</td>
            <td><span className={`badge ${cls}`}>{label}</span></td>
            <td className="small muted">{j.progress?.stage ? `${stageLabel(j.progress.stage)} ${j.progress.total ? `${j.progress.current}/${j.progress.total}` : ''}` : '—'}</td>
            <td className="small muted truncate" style={{ maxWidth: 320 }}>{Object.entries(c).map(([k, v]) => `${stageLabel(k)}: ${typeof v === 'object' ? Object.values(v).join('/') : v}`).join(' · ') || j.error || '—'}</td>
            <td className="actions"><button className="btn ghost sm" onClick={() => onOpen(j.id)}>Detalhes</button></td>
          </tr>
        ); })}</tbody>
      </table>
    </div>
  );
}
