import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, request, ws } from '../api.js';
import { MultiPicker, useClients } from '../components/pickers.jsx';
import { Spinner, Empty, Alert, Modal, Tabs, Switch, DateRangePicker, Pagination, Money } from '../components/ui.jsx';
import { useAsync, useLocalState, useDebounce } from '../lib/hooks.js';
import { toLocalDateStr, addDays, fmtDate, errorMessage } from '../lib/format.js';
import { SortTh } from '../components/reportViews.jsx';
import './Invoices.css';

export const STATUS_LABEL = { UNSENT: ['Não enviada', ''], SENT: ['Enviada', 'primary'], PAID: ['Paga', 'success'], PARTIALLY_PAID: ['Parcialmente paga', 'warning'], VOID: ['Anulada', ''], OVERDUE: ['Vencida', 'danger'] };
export function StatusBadge({ status }) { const [l, c] = STATUS_LABEL[status] || [status, '']; return <span className={`badge ${c}`}>{l}</span>; }
export const pad4 = (n) => String(n ?? 1).padStart(4, '0');
export const LABEL_NAMES = {
  billFrom: 'De (emitente)', billTo: 'Para (cliente)', issueDate: 'Data de emissão', dueDate: 'Vencimento', itemType: 'Tipo de item', description: 'Descrição', quantity: 'Quantidade', unitPrice: 'Preço unitário',
  amount: 'Valor', subtotal: 'Subtotal', discount: 'Desconto', tax: 'Imposto', tax2: 'Imposto 2', total: 'Total', paid: 'Pago', totalAmountDue: 'Valor total devido', totalAmount: 'Valor total', notes: 'Observações',
};

// Image served by the API (needs the Authorization header, so it is fetched as a blob)
export function AuthImage({ fileId, className, style, alt = '' }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let u = null; let alive = true;
    if (!fileId) { setUrl(null); return undefined; }
    request('GET', `/files/${fileId}`, undefined, { raw: true }).then((r) => r.blob()).then((b) => { if (!alive) return; u = URL.createObjectURL(b); setUrl(u); }).catch(() => alive && setUrl(null));
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [fileId]);
  return url ? <img src={url} alt={alt} className={className} style={style} /> : null;
}

const TABS = [{ value: 'list', label: 'Faturas' }, { value: 'settings', label: 'Configurações' }];

export default function Invoices() {
  const { isAdmin, settings, workspace } = useStore();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'settings' ? 'settings' : 'list';
  if (!workspace) return <Spinner block />;
  if (!isAdmin) return <div className="card"><Empty icon="🧾" title="Somente administradores">As faturas só podem ser acessadas por administradores do workspace.</Empty></div>;
  if (settings.invoicingEnabled === false) return <div className="card"><Empty icon="🧾" title="Faturamento desativado">Ative o faturamento nas configurações do workspace (Funcionalidades).</Empty></div>;
  return (
    <div>
      <div className="page-header"><h1>Faturas</h1></div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => setSp(t === 'settings' ? { tab: 'settings' } : {})} />
      {tab === 'list' ? <InvoiceList /> : <InvoiceSettings />}
    </div>
  );
}

// ---------------------------------------------------------------- list
function InvoiceList() {
  const { workspace, toast, dateFormat, currency } = useStore();
  const wsId = workspace.id;
  const clients = useClients(wsId);
  const [f, setF] = useLocalState('clockfy.invoicesFilter', { statuses: [], clients: [], number: '', start: '', end: '', sortColumn: 'ID', sortOrder: 'DESCENDING' });
  const patch = (p) => setF((x) => ({ ...x, ...p }));
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const number = useDebounce(f.number, 300);
  const body = useMemo(() => JSON.parse(JSON.stringify({
    statuses: f.statuses?.length ? f.statuses : undefined, clients: f.clients?.length ? { ids: f.clients, contains: 'CONTAINS', status: 'ALL' } : undefined,
    invoiceNumber: (number || '').trim() || undefined, strictSearch: false, issueDate: f.start || f.end ? { start: f.start || undefined, end: f.end || undefined } : undefined,
    sortColumn: f.sortColumn || 'ID', sortOrder: f.sortOrder || 'DESCENDING', page, pageSize,
  })), [f.statuses, f.clients, number, f.start, f.end, f.sortColumn, f.sortOrder, page]);
  useEffect(() => { setPage(1); }, [f.statuses, f.clients, number, f.start, f.end]);
  const { data, loading, error } = useAsync(() => api.post(`${ws(wsId)}/invoices/info`, body), [wsId, JSON.stringify(body)]);
  const { data: settings } = useAsync(() => api.get(`${ws(wsId)}/invoices/settings`), [wsId]);
  const [creating, setCreating] = useState(false);
  const list = data?.invoices || [];
  const total = data?.total || 0;
  const onSort = (col) => patch({ sortColumn: col, sortOrder: f.sortColumn === col && f.sortOrder === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING' });
  const sortProps = { sortColumn: f.sortColumn, sortOrder: f.sortOrder, onSort };
  const statusOptions = Object.entries(STATUS_LABEL).map(([id, [name]]) => ({ id, name }));
  const sum = (k) => list.reduce((s, i) => s + (i[k] || 0), 0);
  return (
    <div className="card">
      <div className="filter-bar">
        <MultiPicker options={statusOptions} value={f.statuses || []} onChange={(v) => patch({ statuses: v })} label="Status: todos" width={170} />
        <MultiPicker options={clients} value={f.clients || []} onChange={(v) => patch({ clients: v })} label="Clientes: todos" width={190} />
        <input placeholder="Número da fatura…" value={f.number || ''} onChange={(e) => patch({ number: e.target.value })} style={{ width: 160 }} />
        <span className="muted small">Emissão</span>
        <DateRangePicker start={f.start || ''} end={f.end || ''} onChange={(s, e) => patch({ start: s, end: e })} />
        {(f.start || f.end || f.statuses?.length || f.clients?.length || f.number) ? <button type="button" className="btn link" onClick={() => patch({ statuses: [], clients: [], number: '', start: '', end: '' })}>Limpar</button> : null}
        <span className="right row gap">{loading && <Spinner />}<button className="btn" onClick={() => setCreating(true)}>+ Nova fatura</button></span>
      </div>
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      {loading && !data ? <Spinner block /> : list.length === 0 ? <Empty icon="🧾" title="Nenhuma fatura">Crie a primeira fatura com o botão “Nova fatura”.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <SortTh col="NUMBER" {...sortProps}>Número</SortTh>
              <SortTh col="CLIENT" {...sortProps}>Cliente</SortTh>
              <SortTh col="ISSUE_DATE" {...sortProps}>Emissão</SortTh>
              <SortTh col="DUE_ON" {...sortProps}>Vencimento</SortTh>
              <SortTh col="AMOUNT" className="num" {...sortProps}>Valor</SortTh>
              <SortTh col="BALANCE" className="num" {...sortProps}>Saldo</SortTh>
              <th>Status</th><th className="num">Atraso</th>
            </tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td className="bold"><Link to={`/invoices/${i.id}`}>{i.number}</Link>{i.subject && <div className="small muted truncate" style={{ maxWidth: 240 }}>{i.subject}</div>}</td>
                  <td>{i.clientName || <span className="light">—</span>}</td>
                  <td className="nowrap">{fmtDate(i.issuedDate, dateFormat)}</td>
                  <td className="nowrap">{fmtDate(i.dueDate, dateFormat)}</td>
                  <td className="num"><Money cents={i.amount} currency={i.currency} /></td>
                  <td className="num"><Money cents={i.balance} currency={i.currency} /></td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="num">{i.daysOverdue > 0 ? <span className="overdue">{i.daysOverdue} dia(s)</span> : <span className="light">—</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>Nesta página ({list.length} de {total})</td><td className="num"><Money cents={sum('amount')} currency={list[0]?.currency || currency} /></td><td className="num"><Money cents={sum('balance')} currency={list[0]?.currency || currency} /></td><td colSpan={2} /></tr></tfoot>
          </table>
        </div>
      )}
      {total > pageSize && <Pagination page={page} pageSize={pageSize} count={total} onChange={setPage} />}
      {creating && <NewInvoiceModal settings={settings} clients={clients} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewInvoiceModal({ settings, clients, onClose }) {
  const { workspace, timeZone, currency: wsCurrency, toast } = useStore();
  const wsId = workspace.id;
  const navigate = useNavigate();
  const { data: currencies } = useAsync(() => api.get(`${ws(wsId)}/currencies`).then((l) => (Array.isArray(l) ? l.map((c) => c.code || c).filter(Boolean) : [])), [wsId], { initial: [] });
  const today = toLocalDateStr(new Date(), timeZone);
  const dueDays = Number(settings?.defaults?.dueDays ?? 30);
  const [f, setF] = useState({ clientId: '', number: pad4(settings?.nextNumber), currency: wsCurrency, issuedDate: today, dueDate: addDays(today, dueDays) });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (settings?.nextNumber && !f.number) set('number', pad4(settings.nextNumber)); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickClient = (id) => { const c = clients.find((x) => x.id === id); setF((x) => ({ ...x, clientId: id, currency: c?.currencyCode || wsCurrency })); };
  const options = [...new Set([...(currencies || []), wsCurrency, f.currency].filter(Boolean))];
  async function save() {
    if (!f.clientId) { setError('Selecione o cliente'); return; }
    if (f.dueDate < f.issuedDate) { setError('O vencimento deve ser igual ou posterior à emissão'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post(`${ws(wsId)}/invoices`, { clientId: f.clientId, number: f.number.trim() || undefined, currency: f.currency, issuedDate: f.issuedDate, dueDate: f.dueDate });
      toast(`Fatura ${r.number} criada`, 'success'); onClose(); navigate(`/invoices/${r.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return (
    <Modal title="Nova fatura" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" onClick={save} disabled={busy}>Criar fatura</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Cliente *</label><select value={f.clientId} autoFocus onChange={(e) => pickClient(e.target.value)}><option value="">Selecionar…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="grid cols-2">
        <div className="field"><label>Número</label><input value={f.number} onChange={(e) => set('number', e.target.value)} placeholder={pad4(settings?.nextNumber)} /></div>
        <div className="field"><label>Moeda</label>{options.length > 1 ? <select value={f.currency} onChange={(e) => set('currency', e.target.value)}>{options.map((c) => <option key={c} value={c}>{c}</option>)}</select> : <input value={f.currency} maxLength={10} onChange={(e) => set('currency', e.target.value.toUpperCase())} />}</div>
      </div>
      <div className="grid cols-2">
        <div className="field"><label>Data de emissão</label><input type="date" value={f.issuedDate} onChange={(e) => { const d = e.target.value; setF((x) => ({ ...x, issuedDate: d, dueDate: d ? addDays(d, dueDays) : x.dueDate })); }} /></div>
        <div className="field"><label>Vencimento</label><input type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></div>
      </div>
      <p className="small muted">Os itens, impostos e observações são editados na página da fatura.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings
function InvoiceSettings() {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/invoices/settings`), [wsId]);
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newType, setNewType] = useState('');
  useEffect(() => { if (data) setS(JSON.parse(JSON.stringify(data))); }, [data]);
  if (loading && !s) return <Spinner block />;
  if (error && !s) return <Alert type="error">{errorMessage(error)}</Alert>;
  if (!s) return null;
  const setIn = (section, k, v) => setS((x) => ({ ...x, [section]: { ...x[section], [k]: v } }));
  async function uploadLogo(file) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/file/image', fd);
      const id = /files\/([a-f0-9]{24})/i.exec(r.url || '')?.[1];
      if (!id) throw new Error('Não foi possível identificar o arquivo enviado');
      setIn('company', 'logoFileId', id);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setUploading(false); }
  }
  async function save() {
    setSaving(true);
    try {
      const d = s.defaults || {};
      await api.put(`${ws(wsId)}/invoices/settings`, {
        defaults: { subject: d.subject || '', notes: d.notes || '', dueDays: Number(d.dueDays) || 0, taxPercent: Number(d.taxPercent) || 0, tax2Percent: Number(d.tax2Percent) || 0, taxType: d.taxType || 'SIMPLE', itemType: d.itemType || null, itemTypeId: d.itemType || null, defaultImportTimeItemTypeId: d.defaultImportTimeItemTypeId || null, defaultImportExpenseItemTypeId: d.defaultImportExpenseItemTypeId || null },
        exportFields: { itemType: !!s.exportFields.itemType, quantity: !!s.exportFields.quantity, unitPrice: !!s.exportFields.unitPrice, tax: !!s.exportFields.tax, tax2: !!s.exportFields.tax2, rtl: !!s.exportFields.rtl },
        labels: s.labels, company: { name: s.company.name || '', address: s.company.address || '', email: s.company.email || '', logoFileId: s.company.logoFileId || null },
        itemTypes: s.itemTypes, nextNumber: Math.max(1, Number(s.nextNumber) || 1),
      });
      toast('Configurações de faturamento salvas', 'success'); reload();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setSaving(false); }
  }
  const addType = () => { const t = newType.trim(); if (!t || s.itemTypes.includes(t)) return; setS((x) => ({ ...x, itemTypes: [...x.itemTypes, t] })); setNewType(''); };
  const EXPORT = { itemType: 'Tipo de item', quantity: 'Quantidade', unitPrice: 'Preço unitário', tax: 'Imposto', tax2: 'Imposto 2', rtl: 'Texto da direita para a esquerda (RTL)' };
  return (
    <div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Empresa (emitente)</h3></div><div className="card-body">
          <div className="field"><label>Nome</label><input value={s.company.name || ''} onChange={(e) => setIn('company', 'name', e.target.value)} placeholder={workspace.name} /></div>
          <div className="field"><label>Endereço</label><textarea value={s.company.address || ''} onChange={(e) => setIn('company', 'address', e.target.value)} /></div>
          <div className="field"><label>E-mail</label><input type="email" value={s.company.email || ''} onChange={(e) => setIn('company', 'email', e.target.value)} /></div>
          <div className="field"><label>Logo (PNG/JPG)</label>
            <div className="row gap wrap">
              {s.company.logoFileId && <AuthImage fileId={s.company.logoFileId} className="inv-logo" alt="Logo" />}
              <label className="btn secondary sm" style={{ cursor: 'pointer' }}>{uploading ? 'Enviando…' : s.company.logoFileId ? 'Trocar' : 'Enviar'}<input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={(e) => uploadLogo(e.target.files?.[0])} /></label>
              {s.company.logoFileId && <button type="button" className="btn ghost sm" onClick={() => setIn('company', 'logoFileId', null)}>Remover</button>}
            </div>
          </div>
        </div></div>
        <div className="card" style={{ marginTop: 0 }}><div className="card-head"><h3 style={{ margin: 0 }}>Padrões das novas faturas</h3></div><div className="card-body">
          <div className="grid cols-2">
            <div className="field"><label>Próximo número</label><input type="number" min="1" value={s.nextNumber} onChange={(e) => setS((x) => ({ ...x, nextNumber: e.target.value }))} /></div>
            <div className="field"><label>Dias para vencimento</label><input type="number" min="0" value={s.defaults.dueDays} onChange={(e) => setIn('defaults', 'dueDays', e.target.value)} /></div>
          </div>
          <div className="field"><label>Assunto</label><input value={s.defaults.subject || ''} onChange={(e) => setIn('defaults', 'subject', e.target.value)} /></div>
          <div className="field"><label>Observações</label><textarea value={s.defaults.notes || ''} onChange={(e) => setIn('defaults', 'notes', e.target.value)} placeholder="Ex.: dados bancários, condições de pagamento" /></div>
          <div className="grid cols-3">
            <div className="field"><label>Imposto (%)</label><input type="number" min="0" max="100" step="0.01" value={s.defaults.taxPercent} onChange={(e) => setIn('defaults', 'taxPercent', e.target.value)} /></div>
            <div className="field"><label>Imposto 2 (%)</label><input type="number" min="0" max="100" step="0.01" value={s.defaults.tax2Percent} onChange={(e) => setIn('defaults', 'tax2Percent', e.target.value)} /></div>
            <div className="field"><label>Tipo de imposto</label><select value={s.defaults.taxType} onChange={(e) => setIn('defaults', 'taxType', e.target.value)}><option value="SIMPLE">Simples</option><option value="COMPOUND">Composto</option><option value="NONE">Sem impostos</option></select></div>
          </div>
          <div className="grid cols-3">
            <div className="field"><label>Tipo padrão</label><select value={s.defaults.itemType || ''} onChange={(e) => setIn('defaults', 'itemType', e.target.value)}>{s.itemTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div className="field"><label>Tipo p/ tempo importado</label><select value={s.defaults.defaultImportTimeItemTypeId || ''} onChange={(e) => setIn('defaults', 'defaultImportTimeItemTypeId', e.target.value)}>{s.itemTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div className="field"><label>Tipo p/ despesas</label><select value={s.defaults.defaultImportExpenseItemTypeId || ''} onChange={(e) => setIn('defaults', 'defaultImportExpenseItemTypeId', e.target.value)}>{s.itemTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
          </div>
        </div></div>
        <div className="card" style={{ marginTop: 0 }}><div className="card-head"><h3 style={{ margin: 0 }}>Tipos de item</h3></div><div className="card-body">
          <div className="row gap wrap mb">{s.itemTypes.map((t) => <span key={t} className="chip">{t}{s.itemTypes.length > 1 && <span style={{ cursor: 'pointer', marginLeft: 4 }} className="muted" onClick={() => setS((x) => ({ ...x, itemTypes: x.itemTypes.filter((y) => y !== t) }))} title="Remover">✕</span>}</span>)}</div>
          <div className="row gap"><input value={newType} placeholder="Novo tipo (ex.: Consultoria)" onChange={(e) => setNewType(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addType()} /><button type="button" className="btn secondary" onClick={addType}>Adicionar</button></div>
        </div></div>
        <div className="card" style={{ marginTop: 0 }}><div className="card-head"><h3 style={{ margin: 0 }}>Campos exibidos no PDF</h3></div><div className="card-body">
          {Object.entries(EXPORT).map(([k, label]) => <div key={k} className="row mb"><Switch value={!!s.exportFields[k]} onChange={(v) => setIn('exportFields', k, v)} /><span>{label}</span></div>)}
        </div></div>
      </div>
      <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Rótulos do PDF</h3><span className="muted small">Deixe o valor padrão em inglês para usar a tradução automática em português.</span></div><div className="card-body">
        <div className="inv-labels">{Object.entries(LABEL_NAMES).map(([k, name]) => <div key={k} className="field"><label>{name}</label><input value={s.labels[k] ?? ''} onChange={(e) => setIn('labels', k, e.target.value)} /></div>)}</div>
      </div></div>
      <div className="row mt"><button className="btn" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar configurações'}</button><button className="btn ghost" onClick={() => setS(JSON.parse(JSON.stringify(data)))} disabled={saving}>Desfazer</button></div>
    </div>
  );
}
