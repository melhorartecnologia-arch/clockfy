import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, ws } from '../api.js';
import { MultiPicker, useUsers } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Pagination, Avatar, DateRangePicker } from '../components/ui.jsx';
import { errorMessage, toLocalDateStr, addDays } from '../lib/format.js';

// Clockify-style audit actions grouped by area
export const ACTION_GROUPS = [
  { label: 'Registros de tempo', actions: [
    ['CREATE_TIME_PERSONAL_MANUAL', 'Criar registro manual'], ['CREATE_TIME_PERSONAL_TIMER', 'Iniciar timer'], ['CREATE_TIME_FOR_OTHER', 'Criar registro para outro usuário'],
    ['CREATE_TIME_KIOSK', 'Registro pelo quiosque'], ['CREATE_TIME_IMPORT', 'Registro importado'], ['UPDATE_TIME_PERSONAL', 'Editar registro'], ['UPDATE_TIME_FOR_OTHER', 'Editar registro de outro usuário'],
    ['DELETE_TIME_PERSONAL', 'Excluir registro'], ['DELETE_TIME_FOR_OTHER', 'Excluir registro de outro usuário'], ['RESTORE_TIME', 'Restaurar registro'],
  ] },
  { label: 'Projetos', actions: [['CREATE_PROJECT', 'Criar projeto'], ['UPDATE_PROJECT', 'Editar projeto'], ['DELETE_PROJECT', 'Excluir projeto'], ['CREATE_MILESTONE', 'Criar marco'], ['UPDATE_MILESTONE', 'Editar marco'], ['DELETE_MILESTONE', 'Excluir marco']] },
  { label: 'Tarefas', actions: [['CREATE_TASK', 'Criar tarefa'], ['UPDATE_TASK', 'Editar tarefa'], ['DELETE_TASK', 'Excluir tarefa']] },
  { label: 'Clientes', actions: [['CREATE_CLIENT', 'Criar cliente'], ['UPDATE_CLIENT', 'Editar cliente'], ['DELETE_CLIENT', 'Excluir cliente']] },
  { label: 'Etiquetas', actions: [['CREATE_TAG', 'Criar etiqueta'], ['UPDATE_TAG', 'Editar etiqueta'], ['DELETE_TAG', 'Excluir etiqueta']] },
  { label: 'Usuários', actions: [['INVITE_USER', 'Convidar usuário']] },
  { label: 'Despesas', actions: [
    ['CREATE_EXPENSE', 'Criar despesa'], ['CREATE_EXPENSE_FOR_OTHER', 'Criar despesa para outro usuário'], ['UPDATE_EXPENSE', 'Editar despesa'], ['UPDATE_EXPENSE_FOR_OTHER', 'Editar despesa de outro usuário'],
    ['DELETE_EXPENSE', 'Excluir despesa'], ['DELETE_EXPENSE_FOR_OTHER', 'Excluir despesa de outro usuário'], ['CREATE_EXPENSE_CATEGORY', 'Criar categoria de despesa'], ['UPDATE_EXPENSE_CATEGORY', 'Editar categoria de despesa'], ['DELETE_EXPENSE_CATEGORY', 'Excluir categoria de despesa'],
  ] },
  { label: 'Aprovações', actions: [['CREATE_APPROVAL_REQUEST', 'Enviar planilha para aprovação'], ['UPDATE_APPROVAL_REQUEST', 'Atualizar aprovação']] },
  { label: 'Folgas e feriados', actions: [
    ['CREATE_TIME_OFF_REQUEST', 'Solicitar folga'], ['UPDATE_TIME_OFF_REQUEST', 'Editar solicitação de folga'], ['APPROVE_TIME_OFF_REQUEST', 'Aprovar folga'], ['REJECT_TIME_OFF_REQUEST', 'Rejeitar folga'],
    ['WITHDRAW_TIME_OFF_REQUEST', 'Retirar solicitação de folga'], ['DELETE_TIME_OFF_REQUEST', 'Excluir solicitação de folga'], ['CREATE_TIME_OFF_POLICY', 'Criar política de folga'], ['UPDATE_TIME_OFF_POLICY', 'Editar política de folga'],
    ['DELETE_TIME_OFF_POLICY', 'Excluir política de folga'], ['UPDATE_TIME_OFF_BALANCE', 'Ajustar saldo de folga'], ['CREATE_HOLIDAY', 'Criar feriado'], ['UPDATE_HOLIDAY', 'Editar feriado'], ['DELETE_HOLIDAY', 'Excluir feriado'],
  ] },
  { label: 'Agenda', actions: [['CREATE_ASSIGNMENT', 'Criar atribuição'], ['UPDATE_ASSIGNMENT', 'Editar atribuição'], ['DELETE_ASSIGNMENT', 'Excluir atribuição'], ['PUBLISH_ASSIGNMENTS', 'Publicar atribuições']] },
  { label: 'Faturas', actions: [['CREATE_INVOICE', 'Criar fatura'], ['UPDATE_INVOICE', 'Editar fatura'], ['DELETE_INVOICE', 'Excluir fatura'], ['SEND_INVOICE', 'Enviar fatura'], ['CREATE_INVOICE_PAYMENT', 'Registrar pagamento'], ['DELETE_INVOICE_PAYMENT', 'Excluir pagamento'], ['UPDATE_INVOICE_SETTINGS', 'Editar configurações de fatura']] },
  { label: 'Relatórios', actions: [['CREATE_SHARED_REPORT', 'Criar relatório compartilhado'], ['UPDATE_SHARED_REPORT', 'Editar relatório compartilhado'], ['DELETE_SHARED_REPORT', 'Excluir relatório compartilhado'], ['CREATE_SCHEDULED_REPORT', 'Criar relatório agendado'], ['UPDATE_SCHEDULED_REPORT', 'Editar relatório agendado'], ['DELETE_SCHEDULED_REPORT', 'Excluir relatório agendado']] },
  { label: 'Workspace e integrações', actions: [
    ['UPDATE_WORKSPACE', 'Editar workspace'], ['CREATE_WEBHOOK', 'Criar webhook'], ['UPDATE_WEBHOOK', 'Editar webhook'], ['DELETE_WEBHOOK', 'Excluir webhook'],
    ['CREATE_ALERT', 'Criar alerta'], ['UPDATE_ALERT', 'Editar alerta'], ['DELETE_ALERT', 'Excluir alerta'], ['CREATE_REMINDER', 'Criar lembrete'], ['UPDATE_REMINDER', 'Editar lembrete'], ['DELETE_REMINDER', 'Excluir lembrete'],
    ['CREATE_KIOSK', 'Criar quiosque'], ['UPDATE_KIOSK', 'Editar quiosque'], ['DELETE_KIOSK', 'Excluir quiosque'], ['UPDATE_KIOSK_PIN', 'Definir PIN de quiosque'], ['KIOSK_LOGIN', 'Login no quiosque'],
  ] },
];
const ACTION_OPTIONS = ACTION_GROUPS.flatMap((g) => g.actions.map(([id, label]) => ({ id, label, group: g.label })));
const ACTION_LABEL = Object.fromEntries(ACTION_OPTIONS.map((a) => [a.id, a.label]));
const ENTITY_TYPES = [
  ['TIME_ENTRY', 'Registro de tempo'], ['PROJECT', 'Projeto'], ['TASK', 'Tarefa'], ['CLIENT', 'Cliente'], ['TAG', 'Etiqueta'], ['USER', 'Usuário'], ['PROJECT_USER', 'Membro do projeto'],
  ['EXPENSE', 'Despesa'], ['EXPENSE_CATEGORY', 'Categoria de despesa'], ['APPROVAL_REQUEST', 'Aprovação'], ['TIME_OFF_REQUEST', 'Solicitação de folga'], ['TIME_OFF_POLICY', 'Política de folga'], ['HOLIDAY', 'Feriado'],
  ['ASSIGNMENT', 'Atribuição'], ['MILESTONE', 'Marco'], ['INVOICE', 'Fatura'], ['INVOICE_SETTINGS', 'Configurações de fatura'], ['SHARED_REPORT', 'Relatório compartilhado'], ['SCHEDULED_REPORT', 'Relatório agendado'],
  ['WORKSPACE', 'Workspace'], ['WEBHOOK', 'Webhook'], ['ALERT', 'Alerta'], ['REMINDER', 'Lembrete'], ['KIOSK', 'Quiosque'], ['KIOSK_SESSION', 'Sessão de quiosque'], ['KIOSK_PIN_CODE', 'PIN de quiosque'], ['IMPORT_JOB', 'Importação'],
];
const ENTITY_LABEL = Object.fromEntries(ENTITY_TYPES);

const humanAction = (a) => ACTION_LABEL[a] || a.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const parseJson = (s) => { if (s == null || s === '') return null; try { return JSON.parse(s); } catch { return s; } };
const pretty = (s) => { const v = parseJson(s); return v == null ? '(vazio)' : typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
function summary(s) {
  const v = parseJson(s);
  if (v == null) return '';
  if (typeof v !== 'object') return String(v).slice(0, 120);
  const keys = ['name', 'description', 'email', 'start', 'end', 'projectId', 'status', 'archived', 'billable', 'enabled', 'percentage', 'url', 'webhookEvent'];
  const pairs = [];
  for (const k of [...keys.filter((k) => k in v), ...Object.keys(v).filter((k) => !keys.includes(k))]) {
    const val = v[k];
    if (val == null || typeof val === 'object') continue;
    pairs.push(`${k}: ${String(val).length > 40 ? `${String(val).slice(0, 40)}…` : String(val)}`);
    if (pairs.length >= 3) break;
  }
  return pairs.join(' · ') || `{${Object.keys(v).length} campos}`;
}

function csvCell(v) { const s = v == null ? '' : String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportCsv(rows, filename) {
  const head = ['Data/hora', 'Usuário', 'E-mail', 'Ação', 'Descrição', 'Tipo de entidade', 'ID da entidade', 'Conteúdo', 'Conteúdo anterior'];
  const lines = rows.map((r) => [new Date(r.timestamp).toLocaleString('pt-BR'), r.userName, r.userEmail, r.action, humanAction(r.action), r.entityType, r.entityId, r.content, r.previousContent].map(csvCell).join(';'));
  const blob = new Blob([`﻿${[head.join(';'), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function AuditLog() {
  const { workspace, timeZone, toast } = useStore();
  const wsId = workspace?.id;
  const users = useUsers(wsId, { status: 'ALL' });
  const authorOptions = useMemo(() => [{ id: 'SYSTEM', name: 'Sistema (automático)' }, ...users], [users]);
  const today = toLocalDateStr(new Date(), timeZone);
  const [filters, setFilters] = useState({ start: addDays(today, -7), end: today, actions: [], authors: [], entityType: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState({ response: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({});
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const body = { page, 'page-size': pageSize, actions: applied.actions, authors: { authorIds: applied.authors, contains: 'CONTAINS' } };
      if (applied.start) body.start = new Date(`${applied.start}T00:00:00`).toISOString();
      if (applied.end) body.end = new Date(`${applied.end}T23:59:59.999`).toISOString();
      if (applied.entityType) body.entityTypes = [applied.entityType];
      setData(await api.post(`${ws(wsId)}/audit-log`, body)); setOpen({});
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, page, pageSize, applied]);
  useEffect(() => { load(); }, [load]);

  function apply() { setPage(1); setApplied(filters); }
  function clear() { const f = { start: addDays(today, -7), end: today, actions: [], authors: [], entityType: '' }; setFilters(f); setPage(1); setApplied(f); }
  const rows = data.response || [];
  const doExport = () => { if (!rows.length) { toast('Nada para exportar', 'info'); return; } exportCsv(rows, `auditoria-${applied.start}-${applied.end}-p${page}.csv`); toast(`${rows.length} registros exportados`, 'success'); };

  return (
    <div>
      <div className="page-header">
        <h1>Log de auditoria</h1>
        <span className="muted small">Quem fez o quê e quando neste workspace</span>
        <button className="btn secondary right" onClick={doExport} disabled={!rows.length}>⇩ Exportar CSV</button>
      </div>
      <div className="card mb">
        <div className="filter-bar">
          <DateRangePicker start={filters.start} end={filters.end} onChange={(s, e) => setFilters((f) => ({ ...f, start: s, end: e }))} />
          <div style={{ minWidth: 220 }}><MultiPicker options={ACTION_OPTIONS} value={filters.actions} onChange={(v) => set('actions', v)} label="Todas as ações" getLabel={(o) => `${o.group}: ${o.label}`} /></div>
          <div style={{ minWidth: 200 }}><MultiPicker options={authorOptions} value={filters.authors} onChange={(v) => set('authors', v)} label="Todos os autores" /></div>
          <select value={filters.entityType} onChange={(e) => set('entityType', e.target.value)}><option value="">Todas as entidades</option>{ENTITY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn" onClick={apply} disabled={loading}>Filtrar</button>
          <button className="btn ghost" onClick={clear}>Limpar</button>
          <select className="right" value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }} title="Itens por página"><option value={25}>25 por página</option><option value={50}>50 por página</option><option value={100}>100 por página</option></select>
        </div>
      </div>
      <div className="card">
        <Alert type="error">{error}</Alert>
        {loading && !rows.length ? <Spinner block /> : !rows.length ? <Empty icon="📜" title="Nenhum evento encontrado">Ajuste o período ou os filtros para ver as ações registradas.</Empty> : (
          <table className="table compact">
            <thead><tr><th style={{ width: 28 }} /><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>Conteúdo</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = !!open[r.id];
                const kind = r.action.startsWith('DELETE') ? 'danger' : r.action.startsWith('CREATE') ? 'success' : r.action.startsWith('UPDATE') ? 'primary' : '';
                return (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))} style={{ cursor: 'pointer' }}>
                      <td className="light">{isOpen ? '▾' : '▸'}</td>
                      <td className="nowrap mono small">{new Date(r.timestamp).toLocaleString('pt-BR')}</td>
                      <td>{r.userId ? <span className="row gap"><Avatar user={{ name: r.userName || r.userEmail }} size={24} /><span><div>{r.userName || '—'}</div><div className="small light">{r.userEmail}</div></span></span> : <span className="badge">Sistema</span>}</td>
                      <td><span className={`badge ${kind}`}>{humanAction(r.action)}</span><div className="small light mono">{r.action}</div></td>
                      <td className="small nowrap"><div>{ENTITY_LABEL[r.entityType] || r.entityType}</div>{r.entityId && <div className="light mono" title={r.entityId}>{r.entityId.slice(0, 8)}…</div>}</td>
                      <td className="small muted" style={{ maxWidth: 360 }}><div className="truncate" title={summary(r.content)}>{summary(r.content) || <span className="light">—</span>}</div></td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={6} style={{ background: '#fafcfd' }}>
                        <div className={`grid ${r.previousContent ? 'cols-2' : ''}`}>
                          <div><div className="small bold mb">Conteúdo {r.previousContent ? '(novo)' : ''}</div><pre className="import-log" style={{ maxHeight: 320 }}>{pretty(r.content)}</pre></div>
                          {r.previousContent && <div><div className="small bold mb">Conteúdo anterior</div><pre className="import-log" style={{ maxHeight: 320 }}>{pretty(r.previousContent)}</pre></div>}
                        </div>
                        <div className="small light mt">ID do evento: <span className="mono">{r.id}</span>{r.entityId && <> · ID da entidade: <span className="mono">{r.entityId}</span></>}</div>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="row" style={{ padding: '0 14px' }}>
          <span className="small muted">{data.total ? `${data.total} evento${data.total > 1 ? 's' : ''}` : ''}</span>
          <div className="right"><Pagination page={page} pageSize={pageSize} count={data.total} onChange={setPage} /></div>
        </div>
      </div>
    </div>
  );
}
