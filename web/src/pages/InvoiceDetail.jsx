import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, ws } from '../api.js';
import { MultiPicker, useClients, useProjects } from '../components/pickers.jsx';
import { Spinner, Empty, Alert, Modal, Confirm, Dropdown, Switch, Money } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { toLocalDateStr, addDays, fmtDate, localToIso, errorMessage } from '../lib/format.js';
import { StatusBadge } from './Invoices.jsx';
import './Invoices.css';

const APPLY = { NONE: 'Nenhum', TAX1: 'Imposto 1', TAX2: 'Imposto 2', TAX1TAX2: 'Ambos' };
const toCents = (v) => Math.round((Number(String(v ?? '').replace(',', '.')) || 0) * 100);
const fromCents = (c) => (Number(c || 0) / 100).toFixed(2);
let seq = 0;
const rowOf = (it) => ({ key: `r${++seq}`, itemType: it.itemType, description: it.description || '', quantity: it.quantity ?? 1, unitPrice: it.unitPrice || 0, priceText: fromCents(it.unitPrice), applyTaxes: it.applyTaxes || 'NONE', importType: it.importType || 'NOT_IMPORTED', timeEntryIds: it.timeEntryIds || [], expenseIds: it.expenseIds || [] });
const formOf = (inv) => ({ number: inv.number || '', clientId: inv.clientId || '', clientAddress: inv.clientAddress || '', billFrom: inv.billFrom || '', currency: inv.currency || 'USD', issuedDate: String(inv.issuedDate || '').slice(0, 10), dueDate: String(inv.dueDate || '').slice(0, 10), subject: inv.subject || '', note: inv.note || '', discountPercent: inv.discount ?? 0, taxPercent: inv.tax ?? 0, tax2Percent: inv.tax2 ?? 0, taxType: inv.taxType || 'SIMPLE' });

// Same rules as the server (service.computeTotals): cents, per-item taxes after the discount, tax 2 compound or simple.
export function computeTotals(form, items, paid = 0) {
  const discount = Number(form.discountPercent) || 0;
  const taxType = form.taxType || 'SIMPLE';
  const tax = taxType === 'NONE' ? 0 : Number(form.taxPercent) || 0;
  const tax2 = taxType === 'NONE' ? 0 : Number(form.tax2Percent) || 0;
  let subtotal = 0; let t1 = 0; let t2 = 0;
  for (const it of items) {
    const amount = Math.round((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0));
    subtotal += amount;
    const net = amount * (1 - discount / 100);
    const a1 = it.applyTaxes === 'TAX1' || it.applyTaxes === 'TAX1TAX2';
    const a2 = it.applyTaxes === 'TAX2' || it.applyTaxes === 'TAX1TAX2';
    const x1 = a1 ? (net * tax) / 100 : 0;
    const x2 = a2 ? ((net + (taxType === 'COMPOUND' ? x1 : 0)) * tax2) / 100 : 0;
    t1 += x1; t2 += x2;
  }
  const discountAmount = Math.round((subtotal * discount) / 100);
  t1 = Math.round(t1); t2 = Math.round(t2);
  const amount = subtotal - discountAmount + t1 + t2;
  return { subtotal, discountAmount, taxAmount: t1, tax2Amount: t2, amount, paid, balance: amount - paid };
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { workspace, isAdmin, toast, timeZone, dateFormat } = useStore();
  const wsId = workspace?.id;
  const { data: inv, loading, error, setData } = useAsync(() => api.get(`${ws(wsId)}/invoices/${id}`), [wsId, id]);
  const { data: settings } = useAsync(() => api.get(`${ws(wsId)}/invoices/settings`), [wsId]);
  const { data: payments, reload: reloadPayments } = useAsync(() => api.get(`${ws(wsId)}/invoices/${id}/payments`, { 'page-size': 200 }), [wsId, id], { initial: [] });
  const clients = useClients(wsId);
  const [form, setForm] = useState(null);
  const [items, setItems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [itemsDirty, setItemsDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // 'import' | 'send'
  const [confirm, setConfirm] = useState(null);
  const [payment, setPayment] = useState({ amount: '', date: toLocalDateStr(new Date(), timeZone), note: '' });

  useEffect(() => { if (inv) { setForm(formOf(inv)); setItems(inv.items.map(rowOf)); setDirty(false); setItemsDirty(false); } }, [inv]);
  const setF = (k, v) => { setForm((x) => ({ ...x, [k]: v })); setDirty(true); };
  const setItem = (key, p) => { setItems((l) => l.map((it) => (it.key === key ? { ...it, ...p } : it))); setItemsDirty(true); };
  const totals = useMemo(() => (form ? computeTotals(form, items, inv?.paid || 0) : null), [form, items, inv]);
  const itemTypes = settings?.itemTypes || ['Service', 'Product', 'Time', 'Expense'];

  if (!isAdmin) return <div className="card"><Empty icon="🧾" title="Somente administradores">As faturas só podem ser acessadas por administradores do workspace.</Empty></div>;
  if (loading && !inv) return <Spinner block />;
  if (error && !inv) return <div><Alert type="error">{errorMessage(error)}</Alert><Link to="/invoices">← Voltar para faturas</Link></div>;
  if (!inv || !form) return null;

  const cur = form.currency;
  const itemsPayload = () => items.map((it) => ({ itemType: it.itemType, description: it.description, quantity: Number(it.quantity) || 0, unitPrice: Math.round(Number(it.unitPrice) || 0), applyTaxes: it.applyTaxes, importType: it.importType, timeEntryIds: it.timeEntryIds, expenseIds: it.expenseIds }));
  async function save({ silent = false } = {}) {
    setBusy(true);
    try {
      let r = inv;
      if (dirty) {
        if (form.dueDate < form.issuedDate) throw new Error('O vencimento deve ser igual ou posterior à emissão');
        r = await api.put(`${ws(wsId)}/invoices/${id}`, { number: form.number.trim() || undefined, clientId: form.clientId || undefined, clientAddress: form.clientAddress, billFrom: form.billFrom, currency: form.currency, issuedDate: form.issuedDate, dueDate: form.dueDate, subject: form.subject, note: form.note, discountPercent: Number(form.discountPercent) || 0, taxPercent: Number(form.taxPercent) || 0, tax2Percent: Number(form.tax2Percent) || 0, taxType: form.taxType });
      }
      if (itemsDirty) r = await api.put(`${ws(wsId)}/invoices/${id}/items`, { items: itemsPayload() });
      setData(r);
      if (!silent) toast('Fatura salva', 'success');
      return r;
    } catch (e) { toast(errorMessage(e), 'error'); throw e; } finally { setBusy(false); }
  }
  async function run(fn, msg) { setBusy(true); try { const r = await fn(); if (r && r.id === id) setData(r); if (msg) toast(msg, 'success'); return r; } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); } return undefined; }
  const setStatus = (status, msg) => run(() => api.patch(`${ws(wsId)}/invoices/${id}/status`, { invoiceStatus: status }), msg);
  const duplicate = () => run(async () => { const r = await api.post(`${ws(wsId)}/invoices/${id}/duplicate`); toast(`Fatura ${r.number} criada`, 'success'); navigate(`/invoices/${r.id}`); });
  const remove = () => setConfirm({ title: 'Excluir fatura', danger: true, confirmLabel: 'Excluir', message: `Excluir a fatura ${inv.number}? Os registros de tempo e despesas importados voltam a ficar disponíveis para faturamento.`, onConfirm: async () => { await api.delete(`${ws(wsId)}/invoices/${id}`); toast('Fatura excluída', 'success'); navigate('/invoices'); } });
  const pdf = () => run(() => api.download(`${ws(wsId)}/invoices/${id}/export?userLocale=pt-BR`, undefined, undefined, 'GET'));
  const openImport = async () => { if (dirty || itemsDirty) { try { await save({ silent: true }); } catch { return; } } setModal('import'); };
  const addItem = () => { setItems((l) => [...l, rowOf({ itemType: settings?.defaults?.itemType || itemTypes[0], quantity: 1, unitPrice: 0, applyTaxes: (form.taxType !== 'NONE' && (Number(form.taxPercent) || Number(form.tax2Percent))) ? 'TAX1TAX2' : 'NONE' })]); setItemsDirty(true); };
  const removeItem = (key) => { setItems((l) => l.filter((it) => it.key !== key)); setItemsDirty(true); };
  const move = (key, dir) => { setItems((l) => { const i = l.findIndex((it) => it.key === key); const j = i + dir; if (i < 0 || j < 0 || j >= l.length) return l; const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; }); setItemsDirty(true); };
  const pickClient = (cid) => { const c = clients.find((x) => x.id === cid); setForm((x) => ({ ...x, clientId: cid, clientAddress: c ? c.address || '' : x.clientAddress })); setDirty(true); };
  async function addPayment() {
    const cents = toCents(payment.amount);
    if (cents <= 0) { toast('Informe o valor do pagamento', 'error'); return; }
    await run(() => api.post(`${ws(wsId)}/invoices/${id}/payments`, { amount: cents, paymentDate: payment.date, note: payment.note || null }), 'Pagamento registrado');
    setPayment({ amount: '', date: toLocalDateStr(new Date(), timeZone), note: '' }); reloadPayments();
  }
  const removePayment = (p) => setConfirm({ title: 'Remover pagamento', danger: true, confirmLabel: 'Remover', message: `Remover o pagamento de ${fromCents(p.amount)} ${cur}?`, onConfirm: async () => { const r = await api.delete(`${ws(wsId)}/invoices/${id}/payments/${p.id}`); setData(r); reloadPayments(); toast('Pagamento removido', 'success'); } });
  const unsaved = dirty || itemsDirty;
  const client = clients.find((c) => c.id === form.clientId);

  return (
    <div>
      <div className="page-header">
        <Link to="/invoices" className="btn ghost sm">← Faturas</Link>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>Fatura <span className="inv-number">{inv.number}</span> <StatusBadge status={inv.status} />{inv.daysOverdue > 0 && <span className="overdue small">{inv.daysOverdue} dia(s) em atraso</span>}</h1>
        <span className="right row gap wrap">
          {busy && <Spinner />}
          {unsaved && <span className="badge warning">Alterações não salvas</span>}
          <button className="btn" onClick={() => save()} disabled={busy || !unsaved}>Salvar</button>
          <button className="btn secondary" onClick={pdf} disabled={busy}>Baixar PDF</button>
          <button className="btn secondary" onClick={() => setModal('send')} disabled={busy}>Enviar por e-mail</button>
          <Dropdown label="Mais ▾" className="secondary">
            {inv.status !== 'SENT' && inv.status !== 'PAID' && inv.status !== 'VOID' && <button onClick={() => setStatus('SENT', 'Marcada como enviada')}>Marcar como enviada</button>}
            {inv.status !== 'PAID' && inv.status !== 'VOID' && <button onClick={() => setStatus('PAID', 'Marcada como paga')}>Marcar como paga</button>}
            {inv.status === 'PAID' && <button onClick={() => setStatus('SENT', 'Marcada como não paga')}>Marcar como não paga</button>}
            {inv.status !== 'VOID' && <button onClick={() => setStatus('VOID', 'Fatura anulada')}>Anular (void)</button>}
            {inv.status === 'VOID' && <button onClick={() => setStatus('UNSENT', 'Fatura reativada')}>Reativar</button>}
            <hr />
            <button onClick={duplicate}>Duplicar</button>
            <button className="danger" onClick={remove}>Excluir</button>
          </Dropdown>
        </span>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="inv-head">
            <div>
              <div className="grid cols-2">
                <div className="field"><label>Número</label><input value={form.number} onChange={(e) => setF('number', e.target.value)} /></div>
                <div className="field"><label>Moeda</label><input value={form.currency} maxLength={10} onChange={(e) => setF('currency', e.target.value.toUpperCase())} /></div>
              </div>
              <div className="field"><label>Cliente</label><select value={form.clientId} onChange={(e) => pickClient(e.target.value)}><option value="">Selecionar…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}{form.clientId && !client && <option value={form.clientId}>{inv.clientName}</option>}</select></div>
              <div className="field"><label>Endereço do cliente</label><textarea value={form.clientAddress} onChange={(e) => setF('clientAddress', e.target.value)} /></div>
            </div>
            <div>
              <div className="grid cols-2">
                <div className="field"><label>Data de emissão</label><input type="date" value={form.issuedDate} onChange={(e) => setF('issuedDate', e.target.value)} /></div>
                <div className="field"><label>Vencimento</label><input type="date" value={form.dueDate} onChange={(e) => setF('dueDate', e.target.value)} /></div>
              </div>
              <div className="field"><label>Emitente (de)</label><textarea value={form.billFrom} onChange={(e) => setF('billFrom', e.target.value)} placeholder={workspace.name} /></div>
              <div className="field"><label>Assunto</label><input value={form.subject} onChange={(e) => setF('subject', e.target.value)} placeholder="Ex.: Serviços prestados em setembro" /></div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Itens</h3>
          <span className="right row gap">
            <button className="btn secondary sm" onClick={openImport} disabled={busy || !form.clientId} title={!form.clientId ? 'Selecione um cliente' : ''}>Importar registros de tempo e despesas</button>
            <button className="btn sm" onClick={addItem}>+ Adicionar item</button>
          </span>
        </div>
        {items.length === 0 ? <Empty icon="☰" title="Nenhum item">Adicione itens manualmente ou importe registros de tempo e despesas do cliente.</Empty> : (
          <div className="table-wrap">
            <table className="table compact inv-items">
              <thead><tr><th style={{ width: 40 }} /><th style={{ width: 130 }}>Tipo</th><th>Descrição</th><th className="num" style={{ width: 100 }}>Qtd.</th><th className="num" style={{ width: 130 }}>Preço unit. ({cur})</th><th style={{ width: 120 }}>Impostos</th><th className="num" style={{ width: 130 }}>Valor</th><th style={{ width: 40 }} /></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it.key} className={it.importType !== 'NOT_IMPORTED' ? 'imported' : ''}>
                    <td><span className="move"><button type="button" className="btn ghost" onClick={() => move(it.key, -1)} disabled={i === 0} title="Mover para cima">▲</button><button type="button" className="btn ghost" onClick={() => move(it.key, 1)} disabled={i === items.length - 1} title="Mover para baixo">▼</button></span></td>
                    <td><select value={it.itemType} onChange={(e) => setItem(it.key, { itemType: e.target.value })}>{[...new Set([...itemTypes, it.itemType])].map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                    <td><input value={it.description} onChange={(e) => setItem(it.key, { description: e.target.value })} placeholder="Descrição do item" />{it.importType !== 'NOT_IMPORTED' && <div className="small light">{it.importType === 'TIME_ENTRY_IMPORT' ? `${it.timeEntryIds.length} registro(s) de tempo` : `${it.expenseIds.length} despesa(s)`} importado(s)</div>}</td>
                    <td className="num"><input type="number" step="0.01" min="0" value={it.quantity} onChange={(e) => setItem(it.key, { quantity: e.target.value })} /></td>
                    <td className="num"><input type="number" step="0.01" value={it.priceText} onChange={(e) => setItem(it.key, { priceText: e.target.value, unitPrice: toCents(e.target.value) })} /></td>
                    <td><select value={it.applyTaxes} onChange={(e) => setItem(it.key, { applyTaxes: e.target.value })}>{Object.entries(APPLY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                    <td className="num mono"><Money cents={Math.round((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0))} currency={cur} /></td>
                    <td><button type="button" className="btn ghost icon" onClick={() => removeItem(it.key)} title="Remover item">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-body">
          <div className="inv-totals">
            <div className="line"><span className="lbl">Subtotal</span><b><Money cents={totals.subtotal} currency={cur} /></b></div>
            <div className="line"><span className="lbl">Desconto <input type="number" min="0" max="100" step="0.01" value={form.discountPercent} onChange={(e) => setF('discountPercent', e.target.value)} /> %</span><span className="mono">− <Money cents={totals.discountAmount} currency={cur} /></span></div>
            <div className="line"><span className="lbl">Tipo de imposto <select value={form.taxType} onChange={(e) => setF('taxType', e.target.value)}><option value="SIMPLE">Simples</option><option value="COMPOUND">Composto</option><option value="NONE">Sem impostos</option></select></span></div>
            {form.taxType !== 'NONE' && <div className="line"><span className="lbl">Imposto <input type="number" min="0" max="100" step="0.01" value={form.taxPercent} onChange={(e) => setF('taxPercent', e.target.value)} /> %</span><span className="mono"><Money cents={totals.taxAmount} currency={cur} /></span></div>}
            {form.taxType !== 'NONE' && <div className="line"><span className="lbl">Imposto 2 <input type="number" min="0" max="100" step="0.01" value={form.tax2Percent} onChange={(e) => setF('tax2Percent', e.target.value)} /> %</span><span className="mono"><Money cents={totals.tax2Amount} currency={cur} /></span></div>}
            <div className="line total"><span className="lbl" style={{ color: 'var(--text)' }}>Total</span><Money cents={totals.amount} currency={cur} /></div>
            <div className="line"><span className="lbl">Pago</span><span className="mono"><Money cents={totals.paid} currency={cur} /></span></div>
            <div className="line total"><span className="lbl" style={{ color: 'var(--text)' }}>Saldo</span><span style={totals.balance > 0 ? { color: 'var(--danger)' } : { color: 'var(--success)' }}><Money cents={totals.balance} currency={cur} /></span></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Observações</h3></div>
        <div className="card-body"><textarea value={form.note} onChange={(e) => setF('note', e.target.value)} placeholder="Condições de pagamento, dados bancários…" /></div>
      </div>

      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Pagamentos</h3><span className="right muted small">{inv.sentAt ? `Enviada em ${fmtDate(toLocalDateStr(inv.sentAt, timeZone), dateFormat)}` : 'Ainda não enviada'}</span></div>
        {(payments || []).length > 0 && (
          <table className="table compact">
            <thead><tr><th>Data</th><th className="num">Valor</th><th>Observação</th><th>Registrado por</th><th className="actions" /></tr></thead>
            <tbody>{payments.map((p) => <tr key={p.id}><td>{fmtDate(String(p.date).slice(0, 10), dateFormat)}</td><td className="num"><Money cents={p.amount} currency={cur} /></td><td className="muted">{p.note}</td><td className="muted">{p.author}</td><td className="actions"><button type="button" className="btn ghost sm" onClick={() => removePayment(p)}>Remover</button></td></tr>)}</tbody>
          </table>
        )}
        {inv.status !== 'VOID' && (
          <div className="card-body">
            <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Valor ({cur})</label><input type="number" step="0.01" min="0" value={payment.amount} placeholder={fromCents(Math.max(0, totals.balance))} onChange={(e) => setPayment((p) => ({ ...p, amount: e.target.value }))} style={{ width: 140 }} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Data</label><input type="date" value={payment.date} onChange={(e) => setPayment((p) => ({ ...p, date: e.target.value }))} style={{ width: 160 }} /></div>
              <div className="field grow" style={{ marginBottom: 0 }}><label>Observação</label><input value={payment.note} onChange={(e) => setPayment((p) => ({ ...p, note: e.target.value }))} placeholder="Ex.: transferência bancária" /></div>
              <button className="btn secondary" onClick={() => setPayment((p) => ({ ...p, amount: fromCents(Math.max(0, totals.balance)) }))} disabled={totals.balance <= 0}>Saldo total</button>
              <button className="btn" onClick={addPayment} disabled={busy}>Registrar pagamento</button>
            </div>
          </div>
        )}
      </div>

      {modal === 'import' && <ImportModal inv={inv} onClose={() => setModal(null)} onImported={(r) => { setData(r); setModal(null); }} />}
      {modal === 'send' && <SendModal inv={inv} client={client} settings={settings} onClose={() => setModal(null)} onSent={(r) => { setData(r); setModal(null); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- import time entries & expenses
function ImportModal({ inv, onClose, onImported }) {
  const { workspace, timeZone, settings: wsSettings, toast } = useStore();
  const wsId = workspace.id;
  const projects = useProjects(wsId).filter((p) => p.clientId === inv.clientId);
  const issued = String(inv.issuedDate || '').slice(0, 10) || toLocalDateStr(new Date(), timeZone);
  const [f, setF] = useState({ from: `${issued.slice(0, 7)}-01`, to: issued, projectIds: [], groupType: 'SINGLE_ITEM', primary: 'PROJECT', secondary: 'NONE', fields: ['DATE', 'PROJECT', 'DESCRIPTION'], round: false, importExpenses: true, expGroupType: 'GROUPED', expGroupBy: 'CATEGORY' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const FIELDS = { DATE: 'Data', PROJECT: 'Projeto', TASK: 'Tarefa', DESCRIPTION: 'Descrição', TAGS: 'Etiquetas', USER: 'Usuário' };
  async function run() {
    if (!f.from || !f.to || f.to < f.from) { setError('Período inválido'); return; }
    setBusy(true); setError(null);
    try {
      const body = {
        from: localToIso(f.from, '00:00', timeZone), to: localToIso(addDays(f.to, 1), '00:00', timeZone),
        projectFilter: { ids: f.projectIds, contains: 'CONTAINS', status: 'ALL' },
        timeEntryGroupType: f.groupType, timeEntryPrimaryGroupBy: f.primary, timeEntrySecondaryGroupBy: f.secondary, timeEntryFieldsForDetailedGroup: f.fields.length ? f.fields : undefined,
        roundTimeEntryDuration: !!f.round, importExpenses: !!f.importExpenses, expensesGroupType: f.expGroupType, expensesGroupBy: f.expGroupBy,
      };
      const r = await api.post(`${ws(wsId)}/invoices/${inv.id}/items/import`, JSON.parse(JSON.stringify(body)));
      const added = r.items.length - inv.items.length;
      toast(added > 0 ? `${added} item(ns) importado(s)` : 'Nada novo para importar no período', added > 0 ? 'success' : 'info');
      onImported(r);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Importar registros de tempo e despesas" onClose={onClose} size="lg" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" onClick={run} disabled={busy}>{busy ? 'Importando…' : 'Importar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <Alert type="info">Somente registros faturáveis, concluídos e ainda não faturados de projetos do cliente <b>{inv.clientName}</b> são importados.</Alert>
      <div className="grid cols-3">
        <div className="field"><label>De</label><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="field"><label>Até</label><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></div>
        <div className="field"><label>Projetos do cliente</label><MultiPicker options={projects} value={f.projectIds} onChange={(v) => set('projectIds', v)} label="Todos os projetos" /></div>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Registros de tempo</label><select value={f.groupType} onChange={(e) => set('groupType', e.target.value)}><option value="SINGLE_ITEM">Um único item</option><option value="GROUPED">Agrupados</option><option value="DETAILED">Um item por registro</option></select></div>
        {f.groupType === 'GROUPED' && <div className="field"><label>Agrupar por</label><select value={f.primary} onChange={(e) => set('primary', e.target.value)}><option value="PROJECT">Projeto</option><option value="USER">Usuário</option><option value="DATE">Data</option></select></div>}
        {f.groupType === 'GROUPED' && <div className="field"><label>E depois por</label><select value={f.secondary} onChange={(e) => set('secondary', e.target.value)}><option value="NONE">—</option><option value="PROJECT">Projeto</option><option value="USER">Usuário</option><option value="TASK">Tarefa</option><option value="DATE">Data</option><option value="DESCRIPTION">Descrição</option></select></div>}
        {f.groupType === 'DETAILED' && <div className="field" style={{ gridColumn: 'span 2' }}><label>Campos na descrição</label><div className="row gap wrap">{Object.entries(FIELDS).map(([k, v]) => <label key={k} className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={f.fields.includes(k)} onChange={(e) => set('fields', e.target.checked ? [...f.fields, k] : f.fields.filter((x) => x !== k))} /> {v}</label>)}</div></div>}
      </div>
      <div className="row mb"><Switch value={f.round} onChange={(v) => set('round', v)} /><span>Arredondar durações {wsSettings.round?.minutes ? `(${wsSettings.round.minutes} min)` : ''}</span></div>
      <div className="row mb"><Switch value={f.importExpenses} onChange={(v) => set('importExpenses', v)} /><span>Incluir despesas faturáveis</span></div>
      {f.importExpenses && (
        <div className="grid cols-2">
          <div className="field"><label>Despesas</label><select value={f.expGroupType} onChange={(e) => set('expGroupType', e.target.value)}><option value="GROUPED">Agrupadas</option><option value="DETAILED">Um item por despesa</option></select></div>
          {f.expGroupType === 'GROUPED' && <div className="field"><label>Agrupar despesas por</label><select value={f.expGroupBy} onChange={(e) => set('expGroupBy', e.target.value)}><option value="CATEGORY">Categoria</option><option value="PROJECT">Projeto</option><option value="USER">Usuário</option></select></div>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- send by e-mail
function SendModal({ inv, client, settings, onClose, onSent }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const company = settings?.company?.name || workspace.name;
  const [f, setF] = useState({ to: client?.email || '', cc: (client?.ccEmails || []).join(', '), subject: `Fatura ${inv.number} - ${company}`, message: `Olá ${inv.clientName},\n\nSegue em anexo a fatura ${inv.number} no valor de ${inv.currency} ${fromCents(inv.amount)}, com vencimento em ${String(inv.dueDate).slice(0, 10)}.\n\n${company}` });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const split = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  async function send() {
    const to = split(f.to);
    if (!to.length) { setError('Informe pelo menos um destinatário'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post(`${ws(wsId)}/invoices/${inv.id}/send`, { to, cc: split(f.cc), subject: f.subject, message: f.message, userLocale: 'pt-BR' });
      toast(`Fatura enviada para ${to.join(', ')}`, 'success'); onSent(r);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Enviar fatura por e-mail" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" onClick={send} disabled={busy}>{busy ? 'Enviando…' : 'Enviar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Para</label><input value={f.to} onChange={(e) => set('to', e.target.value)} placeholder="cliente@empresa.com" autoFocus /></div>
      <div className="field"><label>Cc</label><input value={f.cc} onChange={(e) => set('cc', e.target.value)} placeholder="opcional, separados por vírgula" /></div>
      <div className="field"><label>Assunto</label><input value={f.subject} onChange={(e) => set('subject', e.target.value)} /></div>
      <div className="field"><label>Mensagem</label><textarea rows={6} value={f.message} onChange={(e) => set('message', e.target.value)} /></div>
      <p className="small muted">O PDF da fatura vai em anexo. A fatura passa a “Enviada”.</p>
    </Modal>
  );
}
