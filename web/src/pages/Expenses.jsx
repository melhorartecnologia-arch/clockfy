import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, request, ws } from '../api.js';
import { ProjectPicker, useUsers, useProjects } from '../components/pickers.jsx';
import { Spinner, Empty, Alert, Modal, Confirm, Dropdown, Tabs, Switch, DateRangePicker, Pagination, Money, ProjectLabel, Avatar } from '../components/ui.jsx';
import { useAsync, useLocalState } from '../lib/hooks.js';
import { toLocalDateStr, addDays, startOfWeekStr, fmtDate, errorMessage, humanDate } from '../lib/format.js';
import { PERIODS, presetRange, shiftRange } from '../components/reportViews.jsx';

const TABS = [{ value: 'list', label: 'Despesas' }, { value: 'categories', label: 'Categorias' }];
const APPROVAL = { PENDING: ['Aguardando aprovação', 'warning'], APPROVED: ['Aprovada', 'success'], REJECTED: ['Rejeitada', 'danger'] };
const toCents = (v) => Math.round((Number(v) || 0) * 100);

export default function Expenses() {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const { isAdmin, settings, workspace } = useStore();
  const tab = sub === 'categories' && isAdmin ? 'categories' : 'list';
  if (!workspace) return <Spinner block />;
  if (settings.expensesEnabled === false) return <div className="card"><Empty icon="💳" title="Despesas desativadas">Ative as despesas nas configurações do workspace (Funcionalidades).</Empty></div>;
  return (
    <div>
      <div className="page-header"><h1>Despesas</h1></div>
      {isAdmin && <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(t === 'categories' ? '/expenses/categories' : '/expenses')} />}
      {tab === 'list' ? <ExpensesList /> : <CategoriesTab />}
    </div>
  );
}

function useCategories(wsId, archived = false) {
  return useAsync(() => api.get(`${ws(wsId)}/expenses/categories`, { archived, 'page-size': 500 }).then((r) => r.categories || []), [wsId, archived], { initial: [] });
}

// ---------------------------------------------------------------- list
const LIST_PERIODS = PERIODS.filter((p) => ['THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'THIS_YEAR', 'CUSTOM'].includes(p.value));

function ExpensesList() {
  const { workspace, user, isAdmin, toast, timeZone, weekStart, dateFormat } = useStore();
  const wsId = workspace.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [f, setF] = useLocalState('clockfy.expensesFilter', { period: 'THIS_MONTH', unit: 'month', start: null, end: null, userId: '', projectId: null, taskId: null, categoryId: '', billable: 'ALL', status: 'ALL' });
  const patch = (p) => setF((x) => ({ ...x, ...p }));
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [start, end] = useMemo(() => (f.period !== 'CUSTOM' && presetRange(f.period, today, weekStart)) || [f.start || today, f.end || today], [f.period, f.start, f.end, today, weekStart]);
  const users = useUsers(isAdmin ? wsId : null);
  const { data: categories } = useCategories(wsId);
  const params = useMemo(() => JSON.parse(JSON.stringify({
    start, end, 'user-id': f.userId || undefined, project: f.projectId || undefined, task: f.taskId || undefined, category: f.categoryId || undefined,
    billable: f.billable === 'ALL' ? undefined : f.billable === 'YES', status: f.status === 'ALL' ? undefined : f.status, page, 'page-size': pageSize,
  })), [start, end, f.userId, f.projectId, f.taskId, f.categoryId, f.billable, f.status, page]);
  useEffect(() => { setPage(1); }, [start, end, f.userId, f.projectId, f.taskId, f.categoryId, f.billable, f.status]);
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/expenses`, params), [wsId, JSON.stringify(params)]);
  const [modal, setModal] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const list = data?.expenses?.expenses || [];
  const count = data?.expenses?.count || 0;
  const daily = useMemo(() => new Map((data?.dailyTotals || []).map((d) => [d.date, d.total])), [data]);
  const weekly = useMemo(() => new Map((data?.weeklyTotals || []).map((w) => [w.date, w.total])), [data]);
  const grand = useMemo(() => (data?.dailyTotals || []).reduce((s, d) => s + (d.total || 0), 0), [data]);
  const weeks = useMemo(() => {
    const m = new Map();
    for (const e of list) { const wk = startOfWeekStr(e.date, weekStart); if (!m.has(wk)) m.set(wk, new Map()); const days = m.get(wk); if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([wk, days]) => [wk, [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))]);
  }, [list, weekStart]);
  const userOf = (id) => users.find((u) => u.id === id) || (id === user.id ? user : { name: '?' });
  const shift = (dir) => { const [s, e] = shiftRange(start, end, f.unit || 'range', dir); patch({ period: 'CUSTOM', start: s, end: e }); };
  const selectPeriod = (v) => (v === 'CUSTOM' ? patch({ period: 'CUSTOM', start, end, unit: 'range' }) : patch({ period: v, unit: PERIODS.find((p) => p.value === v)?.unit || 'range' }));

  async function download(e, inline = false) {
    try {
      if (!inline) { await api.download(`${ws(wsId)}/expenses/${e.id}/files/${e.fileId}`, undefined, e.fileName || 'recibo', 'GET'); return; }
      const w = window.open('', '_blank');
      const res = await request('GET', `${ws(wsId)}/expenses/${e.id}/files/${e.fileId}`, undefined, { raw: true, params: { inline: true } });
      const url = URL.createObjectURL(await res.blob());
      if (w) w.location = url; else window.open(url, '_blank');
    } catch (err) { toast(errorMessage(err), 'error'); }
  }
  const remove = (e) => setConfirm({ title: 'Excluir despesa', danger: true, confirmLabel: 'Excluir', message: `Excluir a despesa de ${fmtDate(e.date, dateFormat)}${e.notes ? ` (“${e.notes}”)` : ''}?`, onConfirm: async () => { try { await api.delete(`${ws(wsId)}/expenses/${e.id}`); toast('Despesa excluída', 'success'); reload(); } catch (err) { toast(errorMessage(err), 'error'); throw err; } } });
  const canEdit = (e) => isAdmin || e.userId === user.id;

  return (
    <div>
      <div className="card mb">
        <div className="filter-bar">
          <select value={f.period} onChange={(e) => selectPeriod(e.target.value)} style={{ minWidth: 140 }}>{LIST_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          <button type="button" className="btn ghost icon" onClick={() => shift(-1)} title="Período anterior">‹</button>
          <span className="bold nowrap" style={{ minWidth: 170, textAlign: 'center' }}>{fmtDate(start, dateFormat)} – {fmtDate(end, dateFormat)}</span>
          <button type="button" className="btn ghost icon" onClick={() => shift(1)} title="Próximo período">›</button>
          {f.period === 'CUSTOM' && <DateRangePicker start={start} end={end} onChange={(s, e) => patch({ period: 'CUSTOM', start: s || start, end: e || end, unit: 'range' })} />}
          {isAdmin && users.length > 0 && <select value={f.userId} onChange={(e) => patch({ userId: e.target.value })}><option value="">Todos os usuários</option>{users.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select>}
          <ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(p, t) => patch({ projectId: p, taskId: t })} allowCreate={false} placeholder="Todos os projetos" />
          <select value={f.categoryId} onChange={(e) => patch({ categoryId: e.target.value })}><option value="">Todas as categorias</option>{(categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select value={f.billable} onChange={(e) => patch({ billable: e.target.value })}><option value="ALL">Faturável: todas</option><option value="YES">Faturável</option><option value="NO">Não faturável</option></select>
          <select value={f.status} onChange={(e) => patch({ status: e.target.value })}><option value="ALL">Status: todos</option><option value="UNSUBMITTED">Não enviadas</option><option value="PENDING">Aguardando aprovação</option><option value="APPROVED">Aprovadas</option><option value="REJECTED">Rejeitadas</option></select>
          <button className="btn right" onClick={() => setModal({})}>+ Nova despesa</button>
        </div>
      </div>
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      <div className="row mb"><span className="muted">{count} despesa(s) · Total do período: <b><Money cents={toCents(grand)} /></b></span>{loading && <Spinner />}</div>
      {loading && !data ? <Spinner block /> : null}
      {data && list.length === 0 && <div className="card"><Empty icon="💳" title="Nenhuma despesa no período">Registre despesas com o botão “Nova despesa”.</Empty></div>}
      {weeks.map(([wk, days]) => (
        <div key={wk} className="day-group">
          <div className="day-head"><span className="bold">Semana de {fmtDate(wk, dateFormat)} – {fmtDate(addDays(wk, 6), dateFormat)}</span><span className="right muted">Total da semana: <b><Money cents={toCents(weekly.get(wk))} /></b></span></div>
          {days.map(([date, items]) => (
            <React.Fragment key={date}>
              <div className="entry-row" style={{ background: '#fbfcfd' }}><span className="small bold muted">{humanDate(date)}</span><span className="right small muted">Total do dia: <b className="mono"><Money cents={toCents(daily.get(date))} /></b></span></div>
              {items.map((e) => {
                const ap = APPROVAL[e.approvalStatus];
                return (
                  <div key={e.id} className={`entry-row ${e.locked ? 'locked' : ''}`}>
                    {isAdmin && <span className="row gap" style={{ width: 150 }}><Avatar user={userOf(e.userId)} size={22} /><span className="truncate small">{userOf(e.userId).name}</span></span>}
                    <div className="desc" onClick={() => canEdit(e) && setModal({ expense: e })} style={{ cursor: canEdit(e) ? 'pointer' : 'default' }}>
                      <span style={{ padding: '6px 8px', display: 'inline-block' }}>{e.notes || <span className="light">(sem observação)</span>}</span>
                    </div>
                    <span className="chip" title="Categoria">{e.category?.name || 'Sem categoria'}</span>
                    <ProjectLabel project={e.project} task={e.task} />
                    {e.category?.hasUnitPrice && <span className="muted small nowrap">{e.quantity} {e.category.unit} × <Money cents={e.category.priceInCents} currency={e.currency} /></span>}
                    {ap && <span className={`badge ${ap[1]}`}>{ap[0]}</span>}
                    {e.invoiced && <span className="badge primary" title="Faturada">Faturada</span>}
                    {e.locked && !ap && !e.invoiced && <span title="Bloqueada">🔒</span>}
                    {e.fileId && <button type="button" className="btn ghost icon" title={`Recibo: ${e.fileName || ''}`} onClick={() => download(e, true)}>📎</button>}
                    <span title={e.billable ? 'Faturável' : 'Não faturável'} style={{ fontSize: 16, fontWeight: 600, color: e.billable ? 'var(--primary)' : 'var(--text-light)', padding: '0 6px' }}>$</span>
                    <span className="dur mono" style={{ width: 'auto', minWidth: 90 }}><Money cents={toCents(e.total)} currency={e.currency} /></span>
                    <Dropdown>
                      {canEdit(e) && <button onClick={() => setModal({ expense: e })}>Editar</button>}
                      {e.fileId && <button onClick={() => download(e, true)}>Visualizar recibo</button>}
                      {e.fileId && <button onClick={() => download(e)}>Baixar recibo</button>}
                      {canEdit(e) && <button className="danger" onClick={() => remove(e)} disabled={e.locked && !isAdmin}>Excluir</button>}
                    </Dropdown>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      ))}
      {count > pageSize && <Pagination page={page} pageSize={pageSize} count={count} onChange={setPage} />}
      {modal && <ExpenseModal expense={modal.expense} categories={categories || []} users={users} onClose={() => setModal(null)} onSaved={() => reload()} onDeleted={() => reload()} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- create / edit
function ExpenseModal({ expense, categories, users, onClose, onSaved, onDeleted }) {
  const { workspace, user, isAdmin, timeZone, toast, currency } = useStore();
  const wsId = workspace.id;
  const projects = useProjects(wsId);
  const active = categories.filter((c) => !c.archived || c.id === expense?.categoryId);
  const [f, setF] = useState({
    userId: expense?.userId || user.id, date: expense?.date || toLocalDateStr(new Date(), timeZone), projectId: expense?.projectId || null, taskId: expense?.taskId || null,
    categoryId: expense?.categoryId || active[0]?.id || '', amount: expense ? String(expense.category?.hasUnitPrice ? expense.quantity : expense.total) : '', notes: expense?.notes || '',
    billable: expense ? !!expense.billable : false, file: null, removeFile: false,
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const cat = categories.find((c) => c.id === f.categoryId) || expense?.category;
  const amount = Number(String(f.amount).replace(',', '.')) || 0;
  const total = cat?.hasUnitPrice ? (amount * (cat.priceInCents || 0)) / 100 : amount;
  const blocked = !!expense && ((expense.approvalStatus === 'PENDING' || expense.approvalStatus === 'APPROVED') || (expense.locked && !isAdmin));

  useEffect(() => { // project default billable for new expenses
    if (expense || !f.projectId) return;
    const p = projects.find((x) => x.id === f.projectId);
    if (p) set('billable', !!p.billable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.projectId, projects]);

  async function save() {
    setError(null);
    if (!f.projectId) { setError('Selecione um projeto'); return; }
    if (!f.categoryId) { setError('Selecione uma categoria'); return; }
    if (f.amount === '' || amount < 0) { setError(cat?.hasUnitPrice ? 'Informe a quantidade' : 'Informe o valor'); return; }
    setBusy(true);
    try {
      const path = expense ? `${ws(wsId)}/expenses/${expense.id}` : `${ws(wsId)}/expenses`;
      const fields = { userId: f.userId, date: f.date, projectId: f.projectId, taskId: f.taskId || null, categoryId: f.categoryId, amount, notes: f.notes, billable: !!f.billable };
      let saved;
      if (f.file) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) fd.append(k, String(v));
        fd.append('file', f.file);
        saved = expense ? await api.patch(path, fd) : await api.post(path, fd);
      } else {
        const body = { ...fields, ...(f.removeFile ? { fileId: null } : {}) };
        saved = expense ? await api.patch(path, body) : await api.post(path, body);
      }
      toast(expense ? 'Despesa atualizada' : 'Despesa registrada', 'success');
      onSaved?.(saved); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api.delete(`${ws(wsId)}/expenses/${expense.id}`); toast('Despesa excluída', 'success'); onDeleted?.(expense); onClose(); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  const fileName = f.file ? f.file.name : (!f.removeFile && expense?.fileName) || null;

  return (
    <Modal title={expense ? 'Editar despesa' : 'Nova despesa'} onClose={onClose} footer={<>
      {expense && <button className="btn ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={() => setConfirm(true)} disabled={busy || blocked}>Excluir</button>}
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={save} disabled={busy || blocked}>{expense ? 'Salvar' : 'Adicionar'}</button>
    </>}>
      <Alert type="error">{error}</Alert>
      {blocked && <Alert type="warning">{expense.approvalStatus === 'PENDING' || expense.approvalStatus === 'APPROVED' ? 'Esta despesa faz parte de um pedido de aprovação e não pode ser alterada.' : 'Esta despesa está bloqueada (faturada ou anterior à data de bloqueio).'}</Alert>}
      <div className="grid cols-2">
        {isAdmin && users.length > 0 ? <div className="field"><label>Usuário</label><select value={f.userId} onChange={(e) => set('userId', e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select></div> : <div />}
        <div className="field"><label>Data</label><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
      </div>
      <div className="field"><label>Projeto / tarefa *</label><div style={{ border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)', padding: 2 }}><ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(p, t) => { set('projectId', p); set('taskId', t); }} allowCreate={false} placeholder="Selecionar projeto" /></div></div>
      <div className="grid cols-2">
        <div className="field"><label>Categoria *</label><select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">Selecionar…</option>{active.map((c) => <option key={c.id} value={c.id}>{c.name}{c.hasUnitPrice ? ` (${c.unit || 'un.'})` : ''}</option>)}</select></div>
        {cat?.hasUnitPrice ? (
          <div className="field"><label>Quantidade ({cat.unit || 'un.'}) × <Money cents={cat.priceInCents} currency={currency} /></label><input type="number" step="0.001" min="0" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" /></div>
        ) : (
          <div className="field"><label>Valor ({currency})</label><input type="number" step="0.01" min="0" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0,00" /></div>
        )}
      </div>
      <div className="row mb"><span className="muted">Total:</span><b className="mono"><Money cents={toCents(total)} currency={currency} /></b><label className="checkbox right" style={{ marginBottom: 0 }}><input type="checkbox" checked={!!f.billable} onChange={(e) => set('billable', e.target.checked)} /> Faturável</label></div>
      <div className="field"><label>Observações</label><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Descrição da despesa" /></div>
      <div className="field"><label>Recibo</label>
        <div className="row gap wrap">
          {fileName ? <span className="chip">📎 {fileName}</span> : <span className="light small">Nenhum arquivo</span>}
          <label className="btn secondary sm" style={{ cursor: 'pointer' }}>{fileName ? 'Trocar' : 'Anexar'}<input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => { set('file', e.target.files?.[0] || null); set('removeFile', false); }} /></label>
          {fileName && <button type="button" className="btn ghost sm" onClick={() => { set('file', null); set('removeFile', true); }}>Remover</button>}
        </div>
      </div>
      {confirm && <Confirm title="Excluir despesa" danger confirmLabel="Excluir" message="Excluir esta despesa? Esta ação não pode ser desfeita." onConfirm={remove} onClose={() => setConfirm(false)} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- categories (admin)
function CategoriesTab() {
  const { workspace, toast, currency } = useStore();
  const wsId = workspace.id;
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useCategories(wsId, showArchived);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const list = data || [];
  async function run(fn, msg) { try { await fn(); if (msg) toast(msg, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); throw e; } }
  const archive = (c, archived) => run(() => api.patch(`${ws(wsId)}/expenses/categories/${c.id}/status`, { archived }), archived ? 'Categoria arquivada' : 'Categoria restaurada');
  const remove = (c) => setConfirm({ title: 'Excluir categoria', danger: true, confirmLabel: 'Excluir', message: `Excluir a categoria “${c.name}”? Categorias usadas por despesas não podem ser excluídas – arquive-as.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/expenses/categories/${c.id}`), 'Categoria excluída') });
  return (
    <div className="card">
      <div className="filter-bar">
        <span className="switch-label" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Switch value={showArchived} onChange={setShowArchived} /> Mostrar arquivadas</span>
        <button className="btn right" onClick={() => setEditing({})}>+ Nova categoria</button>
      </div>
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      {loading && !list.length ? <Spinner block /> : list.length === 0 ? <Empty icon="🏷" title={showArchived ? 'Nenhuma categoria arquivada' : 'Nenhuma categoria'}>Crie categorias para classificar as despesas (ex.: Alimentação, Quilometragem).</Empty> : (
        <table className="table">
          <thead><tr><th>Nome</th><th>Preço unitário</th><th>Unidade</th><th>Status</th><th className="actions" /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td className="bold">{c.name}</td>
                <td>{c.hasUnitPrice ? <Money cents={c.priceInCents} currency={currency} /> : <span className="light">—</span>}</td>
                <td>{c.hasUnitPrice ? c.unit || '—' : <span className="light">—</span>}</td>
                <td>{c.archived ? <span className="badge">Arquivada</span> : <span className="badge success">Ativa</span>}</td>
                <td className="actions"><Dropdown>
                  <button onClick={() => setEditing(c)}>Editar</button>
                  <button onClick={() => archive(c, !c.archived)}>{c.archived ? 'Restaurar' : 'Arquivar'}</button>
                  <button className="danger" onClick={() => remove(c)}>Excluir</button>
                </Dropdown></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <CategoryModal category={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => reload()} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function CategoryModal({ category, onClose, onSaved }) {
  const { workspace, toast, currency } = useStore();
  const wsId = workspace.id;
  const [f, setF] = useState({ name: category?.name || '', hasUnitPrice: !!category?.hasUnitPrice, unit: category?.unit || '', price: category ? (category.priceInCents / 100).toFixed(2) : '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    if (!f.name.trim()) { setError('Informe o nome'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), hasUnitPrice: f.hasUnitPrice, unit: f.hasUnitPrice ? f.unit.trim() || null : null, priceInCents: f.hasUnitPrice ? toCents(String(f.price).replace(',', '.')) : 0 };
      if (category) await api.put(`${ws(wsId)}/expenses/categories/${category.id}`, body); else await api.post(`${ws(wsId)}/expenses/categories`, body);
      toast(category ? 'Categoria atualizada' : 'Categoria criada', 'success'); onSaved?.(); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={category ? 'Editar categoria' : 'Nova categoria'} onClose={onClose} size="sm" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" onClick={save} disabled={busy}>{category ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input type="text" value={f.name} autoFocus onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Quilometragem" /></div>
      <div className="row mb"><Switch value={f.hasUnitPrice} onChange={(v) => set('hasUnitPrice', v)} /><span>Tem preço unitário (valor = quantidade × preço)</span></div>
      {f.hasUnitPrice && (
        <div className="grid cols-2">
          <div className="field"><label>Unidade</label><input type="text" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="km, hora, un." /></div>
          <div className="field"><label>Preço por unidade ({currency})</label><input type="number" step="0.01" min="0" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="0,00" /></div>
        </div>
      )}
    </Modal>
  );
}
