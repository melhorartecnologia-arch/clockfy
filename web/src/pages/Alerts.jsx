import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { MultiPicker, useProjects, useUsers } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Switch, Tabs, Money } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { errorMessage, fmtDuration, WEEKDAYS, WEEKDAY_LABELS } from '../lib/format.js';

const TARGET_LABEL = { PROJECT: 'Projeto', TASK: 'Tarefa' };
const ESTIMATE_LABEL = { TIME: 'Tempo', BUDGET: 'Orçamento' };
const NOTIFY_OPTS = [['ADMINS', 'Administradores'], ['PROJECT_MANAGERS', 'Gerentes do projeto'], ['MEMBERS', 'Membros do projeto']];
const NOTIFY_LABEL = Object.fromEntries(NOTIFY_OPTS);
const REMINDER_TYPES = [['TARGET', 'Meta (avisa quem registrou menos que o esperado)'], ['LIMIT', 'Limite (avisa quem registrou mais que o permitido)'], ['TIMESHEET', 'Planilha (avisa quem não enviou a planilha para aprovação)']];
const TYPE_LABEL = { TARGET: 'Meta', LIMIT: 'Limite', TIMESHEET: 'Planilha' };
const PERIOD_LABEL = { DAY: 'Dia', WEEK: 'Semana', MONTH: 'Mês' };
const DAY_SHORT = { MONDAY: 'Seg', TUESDAY: 'Ter', WEDNESDAY: 'Qua', THURSDAY: 'Qui', FRIDAY: 'Sex', SATURDAY: 'Sáb', SUNDAY: 'Dom' };

function useGroups(wsId) {
  const [list, setList] = useState([]);
  useEffect(() => { if (!wsId) return; endpoints.groups(wsId).then(setList).catch(() => setList([])); }, [wsId]);
  return list;
}

export default function Alerts() {
  const [tab, setTab] = useState('alerts');
  return (
    <div>
      <div className="page-header"><h1>Alertas e lembretes</h1></div>
      <Tabs tabs={[{ value: 'alerts', label: 'Alertas' }, { value: 'reminders', label: 'Metas e lembretes' }]} value={tab} onChange={setTab} />
      {tab === 'alerts' ? <AlertsTab /> : <RemindersTab />}
    </div>
  );
}

// ---- Alerts ------------------------------------------------------------------------------------------------
function AlertsTab() {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const projects = useProjects(wsId);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const { data: list, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/alerts`), [wsId], { initial: [] });
  const status = useAsync(() => api.get(`${ws(wsId)}/alerts/status`), [wsId], { initial: [] });
  const projectName = (id) => projects.find((p) => p.id === id)?.name || id.slice(0, 8);

  async function run(fn, msg) { try { await fn(); if (msg) toast(msg, 'success'); await reload(); } catch (e) { toast(errorMessage(e), 'error'); } }
  const toggle = (a, enabled) => run(() => api.put(`${ws(wsId)}/alerts/${a.id}`, { enabled }), enabled ? 'Alerta habilitado' : 'Alerta desabilitado');
  const remove = (a) => setConfirm({ title: 'Excluir alerta', danger: true, confirmLabel: 'Excluir', message: 'Excluir este alerta? Os avisos já enviados não serão afetados.', onConfirm: () => run(() => api.delete(`${ws(wsId)}/alerts/${a.id}`), 'Alerta excluído') });
  async function evaluate() {
    try { const r = await api.post(`${ws(wsId)}/alerts/evaluate`); toast(r.fired ? `${r.fired} alerta(s) disparado(s)` : 'Nenhum alerta atingiu o limite', r.fired ? 'success' : 'info'); status.reload().catch(() => {}); } catch (e) { toast(errorMessage(e), 'error'); }
  }

  return (
    <div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Alertas de estimativa</h3><span className="muted small">Avisam quando um projeto ou tarefa atinge um percentual da estimativa de tempo ou do orçamento.</span><button className="btn right" onClick={() => setEditing({})}>+ Criar alerta</button></div>
        <Alert type="error">{error ? errorMessage(error) : null}</Alert>
        {loading && !list.length ? <Spinner block /> : !list.length ? <Empty icon="🔔" title="Nenhum alerta configurado">Crie um alerta para ser avisado quando um projeto se aproximar do limite de horas ou orçamento.</Empty> : (
          <table className="table">
            <thead><tr><th>Alvo</th><th>Estimativa</th><th>Limite</th><th>Notificar</th><th>Projetos</th><th>Habilitado</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} style={a.enabled ? undefined : { opacity: .65 }}>
                  <td className="bold">{TARGET_LABEL[a.target] || a.target}</td>
                  <td>{ESTIMATE_LABEL[a.estimateType] || a.estimateType}</td>
                  <td><span className="badge primary">{a.percentage}%</span></td>
                  <td className="small">{(a.notify || []).map((n) => NOTIFY_LABEL[n] || n).join(', ') || '—'}</td>
                  <td className="small">{a.projectIds?.length ? <span className="tag-list">{a.projectIds.slice(0, 3).map((id) => <span key={id} className="chip">{projectName(id)}</span>)}{a.projectIds.length > 3 && <span className="chip">+{a.projectIds.length - 3}</span>}</span> : <span className="muted">Todos os projetos</span>}</td>
                  <td><Switch value={a.enabled} onChange={(v) => toggle(a, v)} /></td>
                  <td className="actions"><Dropdown><button onClick={() => setEditing(a)}>Editar</button><hr /><button className="danger" onClick={() => remove(a)}>Excluir</button></Dropdown></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Status das estimativas</h3><span className="muted small">Projetos com estimativa de tempo ou orçamento ativa.</span>
          <div className="right row gap"><button className="btn ghost sm" onClick={() => status.reload().catch(() => {})} disabled={status.loading}>↻ Atualizar</button><button className="btn secondary sm" onClick={evaluate}>Avaliar alertas agora</button></div>
        </div>
        <Alert type="error">{status.error ? errorMessage(status.error) : null}</Alert>
        {status.loading && !status.data?.length ? <Spinner block /> : !status.data?.length ? <Empty icon="◔" title="Nenhum projeto com estimativa">Defina uma estimativa de tempo ou orçamento nas configurações do projeto para acompanhar o progresso aqui.</Empty> : (
          <table className="table">
            <thead><tr><th>Projeto</th><th style={{ width: '32%' }}>Tempo</th><th style={{ width: '32%' }}>Orçamento</th></tr></thead>
            <tbody>
              {status.data.map((p) => (
                <tr key={p.projectId}>
                  <td><span className="proj-label"><span className="dot" style={{ background: p.color || '#999' }} /><span className="truncate"><span className="name" style={{ color: p.color }}>{p.name}</span>{p.clientName && <span className="client"> – {p.clientName}</span>}</span></span>{p.archived && <span className="badge warning ml">Arquivado</span>}</td>
                  <td>{p.timeEstimate?.active ? <EstimateBar percent={p.timeEstimate.percent} used={fmtDuration(p.timeEstimate.trackedSeconds, { seconds: false })} total={p.timeEstimate.estimateSeconds != null ? fmtDuration(p.timeEstimate.estimateSeconds, { seconds: false }) : '—'} /> : <span className="light small">Sem estimativa de tempo</span>}</td>
                  <td>{p.budgetEstimate?.active ? <EstimateBar percent={p.budgetEstimate.percent} used={<Money cents={p.budgetEstimate.used} />} total={<Money cents={p.budgetEstimate.estimate} />} /> : <span className="light small">Sem orçamento</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && <AlertModal alert={editing.id ? editing : null} projects={projects} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function EstimateBar({ percent, used, total }) {
  const p = percent == null ? 0 : Math.max(0, percent);
  const color = p >= 100 ? 'var(--danger)' : p >= 80 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div>
      <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 4 }}><span className="mono">{used} / {total}</span><span className="bold" style={{ color }}>{percent == null ? '—' : `${percent}%`}</span></div>
      <div className="progress"><div style={{ width: `${Math.min(100, p)}%`, background: color }} /></div>
    </div>
  );
}

function AlertModal({ alert, projects, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [f, setF] = useState({ target: alert?.target || 'PROJECT', estimateType: alert?.estimateType || 'TIME', percentage: alert?.percentage ?? 80, notify: alert?.notify || ['ADMINS'], projectIds: alert?.projectIds || [], enabled: alert ? alert.enabled : true });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleNotify = (k) => set('notify', f.notify.includes(k) ? f.notify.filter((x) => x !== k) : [...f.notify, k]);
  async function save() {
    const pct = Number(f.percentage);
    if (!Number.isInteger(pct) || pct < 1 || pct > 1000) { setError('O percentual deve ser um número inteiro entre 1 e 1000'); return; }
    if (!f.notify.length) { setError('Escolha ao menos um grupo para notificar'); return; }
    setBusy(true); setError(null);
    try {
      const body = { ...f, percentage: pct };
      if (alert) await api.put(`${ws(workspace.id)}/alerts/${alert.id}`, body); else await api.post(`${ws(workspace.id)}/alerts`, body);
      toast(alert ? 'Alerta salvo' : 'Alerta criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={alert ? 'Editar alerta' : 'Criar alerta'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{alert ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-3">
        <div className="field"><label>Alvo</label><select value={f.target} onChange={(e) => set('target', e.target.value)}><option value="PROJECT">Projeto</option><option value="TASK">Tarefa</option></select></div>
        <div className="field"><label>Estimativa</label><select value={f.estimateType} onChange={(e) => set('estimateType', e.target.value)}><option value="TIME">Tempo</option><option value="BUDGET">Orçamento</option></select></div>
        <div className="field"><label>Quando atingir (%)</label><input type="number" min={1} max={1000} value={f.percentage} onChange={(e) => set('percentage', e.target.value)} /></div>
      </div>
      <div className="field"><label>Notificar</label>
        <div className="row wrap gap">{NOTIFY_OPTS.map(([k, l]) => <label key={k} className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={f.notify.includes(k)} onChange={() => toggleNotify(k)} /> {l}</label>)}</div>
      </div>
      <div className="field"><label>Projetos (vazio = todos os projetos ativos)</label><MultiPicker options={projects} value={f.projectIds} onChange={(v) => set('projectIds', v)} label="Todos os projetos" getLabel={(p) => (p.clientName ? `${p.name} – ${p.clientName}` : p.name)} /></div>
      <div className="row gap"><Switch value={f.enabled} onChange={(v) => set('enabled', v)} /><span>Alerta habilitado</span></div>
      <p className="small muted mt">O aviso é enviado uma vez por {f.target === 'TASK' ? 'tarefa' : 'projeto'} (e por período, quando a estimativa é redefinida periodicamente), como notificação no app e por e-mail.</p>
    </Modal>
  );
}

// ---- Reminders ----------------------------------------------------------------------------------------------
function RemindersTab() {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const users = useUsers(wsId);
  const groups = useGroups(wsId);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState({});
  const { data: list, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/reminders`), [wsId], { initial: [] });

  async function run(id, fn, msg) {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await fn(); if (msg) toast(msg, 'success'); await reload(); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy((b) => ({ ...b, [id]: false })); }
  }
  const toggle = (r, enabled) => run(r.id, () => api.put(`${ws(wsId)}/reminders/${r.id}`, { enabled }), enabled ? 'Lembrete habilitado' : 'Lembrete desabilitado');
  const remove = (r) => setConfirm({ title: 'Excluir lembrete', danger: true, confirmLabel: 'Excluir', message: `Excluir o lembrete “${r.name}”?`, onConfirm: () => run(r.id, () => api.delete(`${ws(wsId)}/reminders/${r.id}`), 'Lembrete excluído') });
  const runNow = (r) => run(r.id, async () => { const x = await api.post(`${ws(wsId)}/reminders/${r.id}/run`); toast(x.sent ? `${x.sent} lembrete(s) enviado(s)` : 'Nenhum lembrete enviado agora (fora do dia/horário, já enviado hoje ou ninguém abaixo/acima do limite)', x.sent ? 'success' : 'info', 6000); });

  const recipients = (r) => {
    if (r.everyone) return 'Todos os membros';
    const parts = [];
    if (r.userIds?.length) parts.push(`${r.userIds.length} usuário${r.userIds.length > 1 ? 's' : ''}`);
    if (r.groupIds?.length) parts.push(`${r.groupIds.length} grupo${r.groupIds.length > 1 ? 's' : ''}`);
    return parts.join(', ') || 'Ninguém';
  };

  return (
    <div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Metas e lembretes</h3><span className="muted small">Lembram os membros de registrar horas (meta), avisam quando excedem um limite ou quando não enviaram a planilha.</span><button className="btn right" onClick={() => setEditing({})}>+ Criar lembrete</button></div>
        <Alert type="error">{error ? errorMessage(error) : null}</Alert>
        {loading && !list.length ? <Spinner block /> : !list.length ? <Empty icon="⏰" title="Nenhum lembrete configurado">Crie um lembrete para ajudar a equipe a manter as horas em dia.</Empty> : (
          <table className="table">
            <thead><tr><th>Nome</th><th>Tipo</th><th>Período</th><th>Horas</th><th>Dias</th><th>Horário</th><th>Destinatários</th><th>Habilitado</th><th /></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} style={r.enabled ? undefined : { opacity: .65 }}>
                  <td className="bold">{r.name}</td>
                  <td><span className={`badge ${r.type === 'LIMIT' ? 'warning' : r.type === 'TIMESHEET' ? '' : 'primary'}`}>{TYPE_LABEL[r.type] || r.type}</span></td>
                  <td>{PERIOD_LABEL[r.period] || r.period}</td>
                  <td className="mono">{r.type === 'TIMESHEET' ? '—' : `${r.hours}h`}</td>
                  <td className="small">{WEEKDAYS.filter((d) => r.days.includes(d)).map((d) => DAY_SHORT[d]).join(', ') || '—'}</td>
                  <td className="mono">{r.sendTime}</td>
                  <td className="small">{recipients(r)}</td>
                  <td><Switch value={r.enabled} disabled={busy[r.id]} onChange={(v) => toggle(r, v)} /></td>
                  <td className="actions">{busy[r.id] && <Spinner />}<Dropdown><button onClick={() => runNow(r)}>Executar agora</button><button onClick={() => setEditing(r)}>Editar</button><hr /><button className="danger" onClick={() => remove(r)}>Excluir</button></Dropdown></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="small muted">Os lembretes são avaliados automaticamente no horário configurado (fuso horário de cada usuário) e enviados no máximo uma vez por dia para cada pessoa, como notificação no app e por e-mail.</p>
      {editing && <ReminderModal reminder={editing.id ? editing : null} users={users} groups={groups} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function ReminderModal({ reminder, users, groups, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [f, setF] = useState({
    name: reminder?.name || '', type: reminder?.type || 'TARGET', period: reminder?.period || 'DAY', hours: reminder?.hours ?? 8,
    days: reminder?.days || ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], sendTime: reminder?.sendTime || '17:00',
    everyone: reminder ? reminder.everyone : true, userIds: reminder?.userIds || [], groupIds: reminder?.groupIds || [], enabled: reminder ? reminder.enabled : true,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleDay = (d) => set('days', f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]);
  async function save() {
    if (!f.name.trim()) { setError('Informe o nome do lembrete'); return; }
    const hours = Number(String(f.hours).replace(',', '.'));
    if (f.type !== 'TIMESHEET' && (Number.isNaN(hours) || hours < 0 || hours > 744)) { setError('Informe as horas (0 a 744)'); return; }
    if (!f.days.length) { setError('Escolha ao menos um dia da semana'); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.sendTime)) { setError('Horário inválido'); return; }
    if (!f.everyone && !f.userIds.length && !f.groupIds.length) { setError('Escolha os usuários ou grupos que receberão o lembrete'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), type: f.type, period: f.period, hours: Number.isNaN(hours) ? 0 : hours, days: f.days, sendTime: f.sendTime, everyone: f.everyone, userIds: f.everyone ? [] : f.userIds, groupIds: f.everyone ? [] : f.groupIds, enabled: f.enabled };
      if (reminder) await api.put(`${ws(workspace.id)}/reminders/${reminder.id}`, body); else await api.post(`${ws(workspace.id)}/reminders`, body);
      toast(reminder ? 'Lembrete salvo' : 'Lembrete criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={reminder ? 'Editar lembrete' : 'Criar lembrete'} onClose={onClose} size="lg" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{reminder ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Meta diária de 8h" /></div>
      <div className="field"><label>Tipo</label><select value={f.type} onChange={(e) => set('type', e.target.value)}>{REMINDER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="grid cols-3">
        <div className="field"><label>Período</label><select value={f.period} onChange={(e) => set('period', e.target.value)}><option value="DAY">Dia</option><option value="WEEK">Semana</option><option value="MONTH">Mês</option></select></div>
        <div className="field"><label>{f.type === 'LIMIT' ? 'Limite de horas' : 'Meta de horas'}</label><input type="number" min={0} max={744} step="0.5" value={f.hours} disabled={f.type === 'TIMESHEET'} onChange={(e) => set('hours', e.target.value)} /></div>
        <div className="field"><label>Horário de envio</label><input type="time" value={f.sendTime} onChange={(e) => set('sendTime', e.target.value)} /></div>
      </div>
      <div className="field"><label>Dias da semana</label>
        <div className="row wrap gap">{WEEKDAYS.map((d) => <label key={d} className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={f.days.includes(d)} onChange={() => toggleDay(d)} /> {WEEKDAY_LABELS[d]}</label>)}</div>
      </div>
      <div className="field"><label>Destinatários</label>
        <div className="row wrap gap" style={{ marginBottom: 8 }}>
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="rem-target" checked={f.everyone} onChange={() => set('everyone', true)} /> Todos os membros</label>
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="rem-target" checked={!f.everyone} onChange={() => set('everyone', false)} /> Usuários ou grupos específicos</label>
        </div>
        {!f.everyone && (
          <div className="grid cols-2">
            <MultiPicker options={users} value={f.userIds} onChange={(v) => set('userIds', v)} label="Selecionar usuários…" />
            <MultiPicker options={groups} value={f.groupIds} onChange={(v) => set('groupIds', v)} label="Selecionar grupos…" />
          </div>
        )}
      </div>
      <div className="row gap"><Switch value={f.enabled} onChange={(v) => set('enabled', v)} /><span>Lembrete habilitado</span></div>
    </Modal>
  );
}
