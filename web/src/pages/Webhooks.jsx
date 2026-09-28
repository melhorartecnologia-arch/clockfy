import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { MultiPicker, useProjects, useTags, useUsers, useTasks } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Switch, Pagination } from '../components/ui.jsx';
import { errorMessage } from '../lib/format.js';

// Clockify webhook events grouped by category (labels in pt-BR)
export const EVENT_GROUPS = [
  { label: 'Registros de tempo', events: [
    ['NEW_TIME_ENTRY', 'Novo registro de tempo'], ['NEW_TIMER_STARTED', 'Timer iniciado'], ['TIMER_STOPPED', 'Timer parado'],
    ['TIME_ENTRY_UPDATED', 'Registro de tempo atualizado'], ['TIME_ENTRY_DELETED', 'Registro de tempo excluído'],
    ['TIME_ENTRY_RESTORED', 'Registro de tempo restaurado'], ['TIME_ENTRY_SPLIT', 'Registro de tempo dividido'],
  ] },
  { label: 'Projetos', events: [['NEW_PROJECT', 'Novo projeto'], ['PROJECT_UPDATED', 'Projeto atualizado'], ['PROJECT_DELETED', 'Projeto excluído']] },
  { label: 'Tarefas', events: [['NEW_TASK', 'Nova tarefa'], ['TASK_UPDATED', 'Tarefa atualizada'], ['TASK_DELETED', 'Tarefa excluída']] },
  { label: 'Clientes', events: [['NEW_CLIENT', 'Novo cliente'], ['CLIENT_UPDATED', 'Cliente atualizado'], ['CLIENT_DELETED', 'Cliente excluído']] },
  { label: 'Etiquetas', events: [['NEW_TAG', 'Nova etiqueta'], ['TAG_UPDATED', 'Etiqueta atualizada'], ['TAG_DELETED', 'Etiqueta excluída']] },
  { label: 'Usuários e grupos', events: [
    ['USER_JOINED_WORKSPACE', 'Usuário entrou no workspace'], ['USERS_INVITED_TO_WORKSPACE', 'Usuários convidados'], ['LIMITED_USERS_ADDED_TO_WORKSPACE', 'Usuários limitados adicionados'],
    ['USER_ACTIVATED_ON_WORKSPACE', 'Usuário ativado'], ['USER_DEACTIVATED_ON_WORKSPACE', 'Usuário desativado'], ['USER_DELETED_FROM_WORKSPACE', 'Usuário removido do workspace'],
    ['USER_UPDATED', 'Usuário atualizado'], ['USER_EMAIL_CHANGED', 'E-mail do usuário alterado'],
    ['USER_GROUP_CREATED', 'Grupo criado'], ['USER_GROUP_UPDATED', 'Grupo atualizado'], ['USER_GROUP_DELETED', 'Grupo excluído'],
  ] },
  { label: 'Aprovações', events: [['NEW_APPROVAL_REQUEST', 'Nova solicitação de aprovação'], ['APPROVAL_REQUEST_STATUS_UPDATED', 'Status da aprovação atualizado']] },
  { label: 'Folgas', events: [
    ['TIME_OFF_REQUESTED', 'Folga solicitada'], ['TIME_OFF_REQUEST_UPDATED', 'Solicitação de folga atualizada'], ['TIME_OFF_REQUEST_APPROVED', 'Folga aprovada'],
    ['TIME_OFF_REQUEST_REJECTED', 'Folga rejeitada'], ['TIME_OFF_REQUEST_STARTED', 'Folga iniciada'], ['TIME_OFF_REQUEST_WITHDRAWN', 'Folga retirada'], ['BALANCE_UPDATED', 'Saldo de folgas atualizado'],
  ] },
  { label: 'Agenda', events: [['ASSIGNMENT_CREATED', 'Atribuição criada'], ['ASSIGNMENT_UPDATED', 'Atribuição atualizada'], ['ASSIGNMENT_DELETED', 'Atribuição excluída'], ['ASSIGNMENT_PUBLISHED', 'Atribuição publicada']] },
  { label: 'Despesas', events: [['EXPENSE_CREATED', 'Despesa criada'], ['EXPENSE_UPDATED', 'Despesa atualizada'], ['EXPENSE_DELETED', 'Despesa excluída'], ['EXPENSE_RESTORED', 'Despesa restaurada']] },
  { label: 'Faturas', events: [['NEW_INVOICE', 'Nova fatura'], ['INVOICE_UPDATED', 'Fatura atualizada']] },
  { label: 'Taxas', events: [['BILLABLE_RATE_UPDATED', 'Taxa faturável atualizada'], ['COST_RATE_UPDATED', 'Taxa de custo atualizada']] },
];
const EVENT_LABEL = Object.fromEntries(EVENT_GROUPS.flatMap((g) => g.events));
const EVENT_GROUP = Object.fromEntries(EVENT_GROUPS.flatMap((g) => g.events.map(([k]) => [k, g.label])));

const SOURCE_TYPES = [
  ['WORKSPACE_ID', 'Todo o workspace'], ['PROJECT_ID', 'Projetos específicos'], ['USER_ID', 'Usuários específicos'], ['TAG_ID', 'Etiquetas específicas'],
  ['TASK_ID', 'Tarefas específicas'], ['ASSIGNMENT_ID', 'Atribuições específicas (IDs)'], ['EXPENSE_ID', 'Despesas específicas (IDs)'],
];
const SOURCE_LABEL = Object.fromEntries(SOURCE_TYPES);

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

// Lazily loads the tasks of every project (only needed to show names of TASK_ID filters)
function useAllTasks(wsId, projects, enabled) {
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!enabled || !wsId || !projects.length) return;
    let alive = true;
    Promise.all(projects.map((p) => endpoints.tasks(wsId, p.id, { 'is-active': undefined }).then((l) => l.map((t) => [t.id, { ...t, projectName: p.name }])).catch(() => [])))
      .then((all) => { if (alive) setMap(Object.fromEntries(all.flat())); });
    return () => { alive = false; };
  }, [wsId, projects, enabled]);
  return map;
}

export default function Webhooks() {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} | webhook
  const [logsOf, setLogsOf] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState({});
  const projects = useProjects(wsId);
  const users = useUsers(wsId, { status: 'ALL' });
  const tags = useTags(wsId);
  const needTasks = list.some((w) => w.triggerSourceType === 'TASK_ID');
  const tasks = useAllTasks(wsId, projects, needTasks);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try { const r = await api.get(`${ws(wsId)}/webhooks`); setList(r.webhooks || []); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId]);
  useEffect(() => { load(); }, [load]);

  const names = useMemo(() => ({
    PROJECT_ID: Object.fromEntries(projects.map((p) => [p.id, p.name])),
    USER_ID: Object.fromEntries(users.map((u) => [u.id, u.name])),
    TAG_ID: Object.fromEntries(tags.map((t) => [t.id, t.name])),
    TASK_ID: Object.fromEntries(Object.values(tasks).map((t) => [t.id, `${t.projectName}: ${t.name}`])),
  }), [projects, users, tags, tasks]);

  function filterText(w) {
    if (w.triggerSourceType === 'WORKSPACE_ID') return null;
    const m = names[w.triggerSourceType] || {};
    return (w.triggerSource || []).map((id) => m[id] || shortId(id));
  }

  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Token copiado', 'success')).catch(() => toast('Não foi possível copiar', 'error'));

  async function run(id, fn, msg) {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await fn(); if (msg) toast(msg, 'success'); await load(); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy((b) => ({ ...b, [id]: false })); }
  }
  const toggle = (w, enabled) => run(w.id, () => api.put(`${ws(wsId)}/webhooks/${w.id}`, { enabled }), enabled ? 'Webhook habilitado' : 'Webhook desabilitado');
  const regenerate = (w) => setConfirm({ title: 'Regenerar token', confirmLabel: 'Regenerar', message: 'Um novo token de assinatura será gerado e o anterior deixará de ser válido. Atualize a verificação do cabeçalho Clockify-Signature no seu sistema.', onConfirm: () => run(w.id, () => api.patch(`${ws(wsId)}/webhooks/${w.id}/token`), 'Token regenerado') });
  const remove = (w) => setConfirm({ title: 'Excluir webhook', danger: true, confirmLabel: 'Excluir', message: `Excluir o webhook “${w.name || w.url}”? Os logs de entrega também serão removidos.`, onConfirm: () => run(w.id, () => api.delete(`${ws(wsId)}/webhooks/${w.id}`), 'Webhook excluído') });
  async function test(w) {
    setBusy((b) => ({ ...b, [w.id]: true }));
    try {
      const d = await api.post(`${ws(wsId)}/webhooks/${w.id}/test`);
      if (d.succeeded) toast(`Teste entregue com sucesso (HTTP ${d.statusCode})`, 'success');
      else toast(`Falha no teste: ${d.statusCode ? `HTTP ${d.statusCode}` : (d.responseBody || 'sem resposta')}`, 'error', 6000);
      await load();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy((b) => ({ ...b, [w.id]: false })); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Webhooks</h1>
        <span className="muted small">{list.length} webhook{list.length === 1 ? '' : 's'}</span>
        <button className="btn right" onClick={() => setEditing({})}>+ Criar webhook</button>
      </div>

      <div className="card mb">
        <div className="card-body small">
          <p style={{ margin: '0 0 6px' }}>Webhooks enviam uma requisição <b>POST</b> com JSON (<span className="kbd">Content-Type: application/json</span>) para a URL configurada sempre que o evento escolhido acontece no workspace. Os cabeçalhos enviados são:</p>
          <ul style={{ margin: '0 0 6px 18px', padding: 0 }}>
            <li><span className="kbd">Clockify-Signature</span> – o token de assinatura do webhook (coluna “Token”). Compare-o com o valor guardado no seu sistema para garantir que a requisição veio do Clockfy; regenere o token se ele for exposto.</li>
            <li><span className="kbd">Clockify-Webhook-Event-Type</span> – o tipo do evento (ex.: <span className="kbd">NEW_TIME_ENTRY</span>), útil quando a mesma URL recebe vários eventos.</li>
          </ul>
          <p className="muted" style={{ margin: 0 }}>Respostas com status 4xx/5xx ou sem resposta em 10s são consideradas falhas: a entrega é repetida até 5 vezes (1 min, 5 min, 30 min, 2 h e 6 h). Após 5 falhas consecutivas a entrega é suspensa automaticamente; reabilite o webhook para retomá-la.</p>
        </div>
      </div>

      <div className="card">
        <Alert type="error">{error}</Alert>
        {loading && list.length === 0 ? <Spinner block /> : list.length === 0 ? (
          <Empty icon="🔗" title="Nenhum webhook">Crie um webhook para integrar o Clockfy com outros sistemas em tempo real.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Nome</th><th>URL</th><th>Evento</th><th>Filtro</th><th>Status</th><th>Token</th><th /></tr></thead>
            <tbody>
              {list.map((w) => {
                const filter = filterText(w);
                return (
                  <tr key={w.id} style={w.enabled ? undefined : { opacity: .65 }}>
                    <td><div className="bold">{w.name || <span className="light">(sem nome)</span>}</div><div className="small light">criado em {fmtDateTime(w.createdAt)}</div></td>
                    <td><span className="mono small truncate" style={{ display: 'inline-block', maxWidth: 260 }} title={w.url}>{w.url}</span></td>
                    <td><div>{EVENT_LABEL[w.webhookEvent] || w.webhookEvent}</div><div className="small light">{EVENT_GROUP[w.webhookEvent]} · <span className="mono">{w.webhookEvent}</span></div></td>
                    <td>
                      <div className="small">{SOURCE_LABEL[w.triggerSourceType] || w.triggerSourceType}</div>
                      {filter && <div className="tag-list mt" style={{ marginTop: 4 }}>{filter.slice(0, 4).map((n, i) => <span key={i} className="chip" title={w.triggerSource[i]}>{n}</span>)}{filter.length > 4 && <span className="chip" title={filter.slice(4).join(', ')}>+{filter.length - 4}</span>}</div>}
                    </td>
                    <td>
                      <div className="row gap"><Switch value={w.enabled} disabled={busy[w.id]} onChange={(v) => toggle(w, v)} /><span className="small">{w.enabled ? 'Habilitado' : 'Desabilitado'}</span></div>
                      {w.enabled && !w.deliveryEnabled && <div className="mt" style={{ marginTop: 4 }}><span className="badge danger" title="Reabilite o webhook para retomar as entregas">Entrega suspensa</span></div>}
                      {w.deliveryEnabled && w.consecutiveFailures > 0 && <div style={{ marginTop: 4 }}><span className="badge warning">{w.consecutiveFailures} falha{w.consecutiveFailures > 1 ? 's' : ''} seguida{w.consecutiveFailures > 1 ? 's' : ''}</span></div>}
                    </td>
                    <td className="nowrap">
                      <span className="mono small" title="Valor do cabeçalho Clockify-Signature">{w.authToken.slice(0, 6)}••••{w.authToken.slice(-4)}</span>
                      <button className="btn ghost icon sm ml" title="Copiar token" onClick={() => copy(w.authToken)}>⧉</button>
                      <button className="btn ghost icon sm" title="Regenerar token" disabled={busy[w.id]} onClick={() => regenerate(w)}>↻</button>
                    </td>
                    <td className="actions">
                      {busy[w.id] && <Spinner />}
                      <Dropdown>
                        <button onClick={() => setEditing(w)}>Editar</button>
                        <button onClick={() => test(w)}>Testar (enviar payload de teste)</button>
                        <button onClick={() => setLogsOf(w)}>Ver logs de entrega</button>
                        <button onClick={() => toggle(w, !w.enabled)}>{w.enabled ? 'Desabilitar' : 'Habilitar'}</button>
                        <hr />
                        <button className="danger" onClick={() => remove(w)}>Excluir</button>
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && <WebhookModal webhook={editing.id ? editing : null} projects={projects} users={users} tags={tags} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {logsOf && <LogsModal webhook={logsOf} onClose={() => setLogsOf(null)} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function WebhookModal({ webhook, projects, users, tags, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const [f, setF] = useState({
    name: webhook?.name || '', url: webhook?.url || '', webhookEvent: webhook?.webhookEvent || 'NEW_TIME_ENTRY',
    triggerSourceType: webhook?.triggerSourceType || 'WORKSPACE_ID', triggerSource: webhook && webhook.triggerSourceType !== 'WORKSPACE_ID' ? webhook.triggerSource || [] : [],
    enabled: webhook ? webhook.enabled : true,
  });
  const [idsText, setIdsText] = useState((webhook && ['ASSIGNMENT_ID', 'EXPENSE_ID'].includes(webhook.triggerSourceType) ? webhook.triggerSource : []).join('\n'));
  const [taskProject, setTaskProject] = useState('');
  const projectTasks = useTasks(wsId, taskProject);
  const [taskNames, setTaskNames] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => { if (projectTasks.length) setTaskNames((m) => ({ ...m, ...Object.fromEntries(projectTasks.map((t) => [t.id, t.name])) })); }, [projectTasks]);

  function changeType(t) { setF((x) => ({ ...x, triggerSourceType: t, triggerSource: [] })); setIdsText(''); }
  const projectTaskIds = projectTasks.map((t) => t.id);
  const selectedOfProject = f.triggerSource.filter((id) => projectTaskIds.includes(id));
  const setProjectTasks = (ids) => set('triggerSource', [...f.triggerSource.filter((id) => !projectTaskIds.includes(id)), ...ids]);

  async function save() {
    const url = f.url.trim();
    if (!url) { setError('Informe a URL de destino'); return; }
    if (!/^https?:\/\//i.test(url)) { setError('A URL deve começar com http:// ou https://'); return; }
    let triggerSource = f.triggerSource;
    if (['ASSIGNMENT_ID', 'EXPENSE_ID'].includes(f.triggerSourceType)) triggerSource = idsText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (f.triggerSourceType === 'WORKSPACE_ID') triggerSource = [wsId];
    if (!triggerSource.length) { setError('Selecione ao menos um item para o filtro escolhido'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim() || undefined, url, webhookEvent: f.webhookEvent, triggerSourceType: f.triggerSourceType, triggerSource, enabled: f.enabled };
      if (webhook) await api.put(`${ws(wsId)}/webhooks/${webhook.id}`, body); else await api.post(`${ws(wsId)}/webhooks`, body);
      toast(webhook ? 'Webhook salvo' : 'Webhook criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={webhook ? 'Editar webhook' : 'Criar webhook'} onClose={onClose} size="lg" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{webhook ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2">
        <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Integração com o ERP" /></div>
        <div className="field"><label>Evento</label>
          <select value={f.webhookEvent} onChange={(e) => set('webhookEvent', e.target.value)}>
            {EVENT_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.events.map(([k, l]) => <option key={k} value={k}>{l} ({k})</option>)}</optgroup>)}
          </select>
        </div>
      </div>
      <div className="field"><label>URL de destino</label><input type="url" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://exemplo.com/webhooks/clockfy" /></div>
      <div className="grid cols-2">
        <div className="field"><label>Gatilho (filtro)</label>
          <select value={f.triggerSourceType} onChange={(e) => changeType(e.target.value)}>{SOURCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <div className="small muted mt" style={{ marginTop: 6 }}>{f.triggerSourceType === 'WORKSPACE_ID' ? 'O webhook é disparado para todos os eventos deste tipo no workspace.' : 'O webhook só é disparado quando o evento envolve um dos itens selecionados.'}</div>
        </div>
        <div className="field">
          {f.triggerSourceType === 'PROJECT_ID' && <><label>Projetos</label><MultiPicker options={projects} value={f.triggerSource} onChange={(v) => set('triggerSource', v)} label="Selecionar projetos…" getLabel={(p) => (p.clientName ? `${p.name} – ${p.clientName}` : p.name)} /></>}
          {f.triggerSourceType === 'USER_ID' && <><label>Usuários</label><MultiPicker options={users} value={f.triggerSource} onChange={(v) => set('triggerSource', v)} label="Selecionar usuários…" /></>}
          {f.triggerSourceType === 'TAG_ID' && <><label>Etiquetas</label><MultiPicker options={tags} value={f.triggerSource} onChange={(v) => set('triggerSource', v)} label="Selecionar etiquetas…" /></>}
          {f.triggerSourceType === 'TASK_ID' && (
            <>
              <label>Tarefas</label>
              <div className="row gap">
                <select value={taskProject} onChange={(e) => setTaskProject(e.target.value)} style={{ width: '50%' }}><option value="">Projeto…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                <div className="grow">{taskProject ? <MultiPicker options={projectTasks} value={selectedOfProject} onChange={setProjectTasks} label="Tarefas do projeto…" /> : <span className="light small">Escolha um projeto para listar as tarefas</span>}</div>
              </div>
              {f.triggerSource.length > 0 && <div className="tag-list" style={{ marginTop: 8 }}>{f.triggerSource.map((id) => <span key={id} className="chip">{taskNames[id] || shortId(id)}<button type="button" className="btn link" style={{ fontSize: 12 }} onClick={() => set('triggerSource', f.triggerSource.filter((x) => x !== id))}>✕</button></span>)}</div>}
            </>
          )}
          {['ASSIGNMENT_ID', 'EXPENSE_ID'].includes(f.triggerSourceType) && <><label>IDs (um por linha ou separados por vírgula)</label><textarea value={idsText} onChange={(e) => setIdsText(e.target.value)} placeholder="5f1c2b3a4d5e6f7a8b9c0d1e" style={{ fontFamily: 'monospace' }} /></>}
        </div>
      </div>
      <div className="row gap"><Switch value={f.enabled} onChange={(v) => set('enabled', v)} /><span>Webhook habilitado</span></div>
      {webhook && !webhook.deliveryEnabled && f.enabled && <div className="small muted mt">A entrega está suspensa por falhas consecutivas; salvar com o webhook habilitado reinicia a contagem de falhas e retoma as entregas.</div>}
    </Modal>
  );
}

const STATUS_OPTS = [['ALL', 'Todas'], ['SUCCEEDED', 'Bem-sucedidas'], ['FAILED', 'Com falha']];
const PAGE_SIZE = 25;

function LogsModal({ webhook, onClose }) {
  const { workspace } = useStore();
  const wsId = workspace.id;
  const [filter, setFilter] = useState({ status: 'ALL', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const body = { status: filter.status, sortByNewest: true };
      if (filter.from) body.from = new Date(`${filter.from}T00:00:00`).toISOString();
      if (filter.to) body.to = new Date(`${filter.to}T23:59:59.999`).toISOString();
      setLogs(await api.post(`${ws(wsId)}/webhooks/${webhook.id}/logs`, body, { params: { page, size: PAGE_SIZE } }));
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, webhook.id, filter, page]);
  useEffect(() => { load(); }, [load]);

  const pretty = (s) => { if (s == null || s === '') return '(vazio)'; try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s); } };

  return (
    <Modal title={`Logs de entrega – ${webhook.name || webhook.url}`} onClose={onClose} size="xl" footer={<button className="btn ghost" onClick={onClose}>Fechar</button>}>
      <div className="filter-bar" style={{ padding: '0 0 12px' }}>
        <select value={filter.status} onChange={(e) => { setPage(1); setFilter((x) => ({ ...x, status: e.target.value })); }}>{STATUS_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input type="date" value={filter.from} onChange={(e) => { setPage(1); setFilter((x) => ({ ...x, from: e.target.value })); }} title="De" />
        <span className="muted">–</span>
        <input type="date" value={filter.to} onChange={(e) => { setPage(1); setFilter((x) => ({ ...x, to: e.target.value })); }} title="Até" />
        <button className="btn ghost sm right" onClick={load} disabled={loading}>↻ Atualizar</button>
      </div>
      <Alert type="error">{error}</Alert>
      {loading && logs.length === 0 ? <Spinner block /> : logs.length === 0 ? <Empty icon="📭" title="Nenhuma entrega registrada">Use “Testar” para enviar um payload de teste ou aguarde o próximo evento.</Empty> : (
        <table className="table compact">
          <thead><tr><th style={{ width: 28 }} /><th>Data</th><th>Status</th><th>Tentativa</th><th>Próxima tentativa</th><th>Evento</th></tr></thead>
          <tbody>
            {logs.map((d) => (
              <React.Fragment key={d.id}>
                <tr onClick={() => setOpen((o) => ({ ...o, [d.id]: !o[d.id] }))} style={{ cursor: 'pointer' }}>
                  <td className="light">{open[d.id] ? '▾' : '▸'}</td>
                  <td className="nowrap">{fmtDateTime(d.respondedAt)}</td>
                  <td>{d.statusCode != null ? <span className={`badge ${d.succeeded ? 'success' : 'danger'}`}>HTTP {d.statusCode}</span> : <span className="badge danger">Sem resposta</span>}</td>
                  <td>{d.attempt}</td>
                  <td className="small muted">{d.nextAttemptAt ? fmtDateTime(d.nextAttemptAt) : (d.succeeded ? '—' : 'não haverá')}</td>
                  <td className="small light mono">{d.webhookEventStatusId ? shortId(d.webhookEventStatusId) : ''}</td>
                </tr>
                {open[d.id] && (
                  <tr><td colSpan={6} style={{ background: '#fafcfd' }}>
                    <div className="grid cols-2">
                      <div><div className="small bold mb">Corpo da requisição</div><pre className="import-log" style={{ maxHeight: 300 }}>{pretty(d.requestBody)}</pre></div>
                      <div><div className="small bold mb">Resposta</div><pre className="import-log" style={{ maxHeight: 300 }}>{pretty(d.responseBody)}</pre></div>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} count={logs.length < PAGE_SIZE ? (page - 1) * PAGE_SIZE + logs.length : null} onChange={setPage} />
    </Modal>
  );
}
