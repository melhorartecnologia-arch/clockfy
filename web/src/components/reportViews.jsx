import React, { useMemo, useState } from 'react';
import { Avatar, Empty } from './ui.jsx';
import { fmtDuration, money, fmtDate, toLocalDateStr, toLocalTimeStr, weekdayShort, monthName, addDays, startOfWeekStr, pad } from '../lib/format.js';
import '../pages/Reports.css';

// Shared rendering of report results (used by the Reports page and by the public shared report page)

// ---------------------------------------------------------------- periods
export const PERIODS = [
  { value: 'TODAY', label: 'Hoje', unit: 'day' }, { value: 'YESTERDAY', label: 'Ontem', unit: 'day' },
  { value: 'THIS_WEEK', label: 'Esta semana', unit: 'week' }, { value: 'LAST_WEEK', label: 'Semana passada', unit: 'week' },
  { value: 'PAST_TWO_WEEKS', label: 'Últimas 2 semanas', unit: 'range' },
  { value: 'THIS_MONTH', label: 'Este mês', unit: 'month' }, { value: 'LAST_MONTH', label: 'Mês passado', unit: 'month' },
  { value: 'THIS_YEAR', label: 'Este ano', unit: 'year' }, { value: 'LAST_YEAR', label: 'Ano passado', unit: 'year' },
  { value: 'CUSTOM', label: 'Personalizado', unit: 'range' },
];
export const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const utcOf = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const dayDiff = (a, b) => Math.round((utcOf(b) - utcOf(a)) / 86400000);

// [start, end] (YYYY-MM-DD) for a preset, or null for CUSTOM
export function presetRange(p, today, weekStart) {
  const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7));
  switch (p) {
    case 'TODAY': return [today, today];
    case 'YESTERDAY': { const d = addDays(today, -1); return [d, d]; }
    case 'THIS_WEEK': { const s = startOfWeekStr(today, weekStart); return [s, addDays(s, 6)]; }
    case 'LAST_WEEK': { const s = addDays(startOfWeekStr(today, weekStart), -7); return [s, addDays(s, 6)]; }
    case 'PAST_TWO_WEEKS': { const s = addDays(startOfWeekStr(today, weekStart), -7); return [s, addDays(s, 13)]; }
    case 'THIS_MONTH': return [`${today.slice(0, 7)}-01`, monthEnd(y, m)];
    case 'LAST_MONTH': { const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1]; return [`${py}-${pad(pm)}-01`, monthEnd(py, pm)]; }
    case 'THIS_YEAR': return [`${y}-01-01`, `${y}-12-31`];
    case 'LAST_YEAR': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    default: return null;
  }
}
// Moves a range one unit (day/week/month/year or its own length) backwards (-1) or forwards (1)
export function shiftRange(start, end, unit, dir) {
  if (unit === 'month') { const [y, m] = start.split('-').map(Number); const nm = m + dir; const yy = y + Math.floor((nm - 1) / 12); const mm = ((((nm - 1) % 12) + 12) % 12) + 1; return [`${yy}-${pad(mm)}-01`, monthEnd(yy, mm)]; }
  if (unit === 'year') { const y = Number(start.slice(0, 4)) + dir; return [`${y}-01-01`, `${y}-12-31`]; }
  const len = dayDiff(start, end) + 1;
  return [addDays(start, dir * len), addDays(end, dir * len)];
}

export const REPORT_TYPES = { SUMMARY: 'Resumo', DETAILED: 'Detalhado', WEEKLY: 'Semanal', ATTENDANCE: 'Presença', EXPENSE_DETAILED: 'Despesas' };
export const REPORT_PATHS = { SUMMARY: 'summary', DETAILED: 'detailed', WEEKLY: 'weekly', ATTENDANCE: 'attendance', EXPENSE_DETAILED: 'expenses/detailed' };
export const GROUP_LABELS = { PROJECT: 'Projeto', CLIENT: 'Cliente', USER: 'Usuário', TASK: 'Tarefa', TAG: 'Etiqueta', DATE: 'Data', WEEK: 'Semana', MONTH: 'Mês', YEAR: 'Ano', USERGROUP: 'Grupo', USER_GROUP: 'Grupo', TIMEENTRY: 'Registro', BILLABILITY: 'Faturabilidade' };
export const AMOUNT_LABELS = { EARNED: 'Valor', COST: 'Custo', PROFIT: 'Lucro' };
export const PALETTE = ['#03A9F4', '#8BC34A', '#FF9800', '#9C27B0', '#F44336', '#3F51B5', '#009688', '#795548', '#E91E63', '#607D8B', '#FFC107', '#4CAF50', '#00BCD4', '#673AB7', '#CDDC39', '#FF5722'];
const NAME_PT = { 'Without project': 'Sem projeto', 'Without client': 'Sem cliente', 'Without task': 'Sem tarefa', 'Without tag': 'Sem etiqueta', 'Without group': 'Sem grupo', 'Without description': 'Sem descrição', 'Without value': 'Sem valor', Billable: 'Faturável', 'Non-billable': 'Não faturável' };

// Report amounts come in currency units (decimals) – Money/money() expect cents
export const fmtAmount = (v, currency) => money(Math.round((Number(v) || 0) * 100), currency || 'USD');
export const fmtHours = (s) => fmtDuration(s, { seconds: false });
export const amountOf = (obj, type) => (obj?.amounts || []).find((a) => a.type === type)?.value;

export function groupName(g, type, dateFormat = 'DD/MM/YYYY') {
  const name = g?.name ?? '';
  if (type === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(name)) return `${weekdayShort(name)} ${fmtDate(name, dateFormat)}`;
  if (type === 'WEEK' && /^\d{4}-\d{2}-\d{2}$/.test(name)) return `Semana de ${fmtDate(name, dateFormat)}`;
  if (type === 'MONTH' && /^\d{4}-\d{2}$/.test(name)) return monthName(`${name}-01`);
  return NAME_PT[name] || name || '—';
}

function niceStep(max, mode) {
  const base = mode === 'time' ? max / 3600 : max;
  if (base <= 0) return mode === 'time' ? 3600 : 1;
  const p = 10 ** Math.floor(Math.log10(base));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => base / s <= 5) || p * 10;
  return mode === 'time' ? step * 3600 : step;
}

// Simple inline SVG bar chart: items [{label, value, title?}]
export function BarChart({ items, mode = 'time', format, height = 210 }) {
  const fmt = format || (mode === 'time' ? fmtHours : (v) => String(v));
  if (!items || !items.length) return <div className="empty small">Sem dados</div>;
  const W = 960; const H = height; const padL = 64; const padR = 12; const padT = 12; const padB = 30;
  const max = Math.max(0, ...items.map((i) => i.value || 0));
  const step = niceStep(max, mode);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const innerW = W - padL - padR; const innerH = H - padT - padB;
  const n = items.length; const bw = innerW / n; const barW = Math.max(2, Math.min(bw * 0.7, 48));
  const every = Math.ceil(n / 16);
  const y = (v) => padT + innerH - (v / top) * innerH;
  const ticks = []; for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Gráfico de barras">
      {ticks.map((t) => <g key={t}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#e0e6ea" /><text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6f7c86">{fmt(t)}</text></g>)}
      {items.map((it, i) => {
        const v = it.value || 0; const h = (v / top) * innerH; const x = padL + i * bw + (bw - barW) / 2;
        return (
          <g key={it.key || i}>
            <rect className="bar" x={x} y={y(v)} width={barW} height={Math.max(0, h)} rx="2"><title>{it.title || `${it.label}: ${fmt(v)}`}</title></rect>
            {i % every === 0 && <text x={x + barW / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="#6f7c86">{it.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Donut chart with legend: slices [{name, value, color}]
export function Donut({ slices, format = fmtHours, max = 8 }) {
  const list = useMemo(() => {
    const sorted = [...(slices || [])].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= max) return sorted;
    const rest = sorted.slice(max - 1).reduce((s, x) => s + x.value, 0);
    return [...sorted.slice(0, max - 1), { name: 'Outros', value: rest, color: '#c6d0d7' }];
  }, [slices, max]);
  const total = list.reduce((s, x) => s + x.value, 0);
  if (!total) return <div className="empty small">Sem dados</div>;
  const r = 58; const c = 2 * Math.PI * r; let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="Gráfico de rosca">
        <circle cx="80" cy="80" r={r} fill="none" stroke="#eef2f4" strokeWidth="22" />
        {list.map((s, i) => {
          const len = (s.value / total) * c; const el = (
            <circle key={i} cx="80" cy="80" r={r} fill="none" stroke={s.color || PALETTE[i % PALETTE.length]} strokeWidth="22" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 80 80)"><title>{`${s.name}: ${format(s.value)} (${Math.round((s.value / total) * 100)}%)`}</title></circle>
          );
          offset += len; return el;
        })}
        <text x="80" y="85" textAnchor="middle" fontSize="15" fontWeight="600" fill="#333">{format(total)}</text>
      </svg>
      <div className="legend">
        {list.map((s, i) => (
          <div key={i} className="item small">
            <span className="dot" style={{ background: s.color || PALETTE[i % PALETTE.length] }} />
            <span className="name" title={s.name}>{s.name}</span>
            <span className="mono muted">{format(s.value)}</span>
            <span className="mono light" style={{ width: 36, textAlign: 'right' }}>{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Totals({ totals, currency, extra }) {
  if (!totals) return null;
  return (
    <div className="report-stats">
      <div className="stat"><div className="label">Total</div><div className="value mono">{fmtDuration(totals.totalTime || 0)}</div></div>
      <div className="stat"><div className="label">Faturável</div><div className="value mono">{fmtDuration(totals.totalBillableTime || 0)}</div></div>
      {(totals.amounts || []).map((a) => <div key={a.type} className="stat"><div className="label">{AMOUNT_LABELS[a.type] || a.type}</div><div className="value mono">{fmtAmount(a.value, currency)}</div></div>)}
      {totals.entriesCount != null && <div className="stat"><div className="label">Registros</div><div className="value mono">{totals.entriesCount}</div></div>}
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------- Summary
function TreeRows({ list, level, path, groups, expanded, toggle, amountTypes, total, currency, dateFormat, customFields }) {
  const type = groups[level];
  const label = (g) => {
    if (GROUP_LABELS[type]) return groupName(g, type, dateFormat);
    return NAME_PT[g.name] || g.name;
  };
  return list.map((g, i) => {
    const key = `${path}/${g._id || `${g.nameLowerCase}-${i}`}`;
    const has = Array.isArray(g.children) && g.children.length > 0;
    const open = expanded.has(key);
    const pct = total ? Math.round((g.duration / total) * 1000) / 10 : 0;
    return (
      <React.Fragment key={key}>
        <tr className={`lvl-${level}`}>
          <td>
            <span className="tree-name" style={{ paddingLeft: level * 22 }}>
              <span className={`chev ${has ? '' : 'empty'}`} onClick={() => has && toggle(key)}>{open ? '▼' : '▶'}</span>
              {g.color && <span className="dot" style={{ background: g.color }} />}
              <span className={`truncate ${level === 0 ? 'bold' : ''}`} title={label(g)}>{label(g)}</span>
              {g.clientName && <span className="light small truncate">– {g.clientName}</span>}
              {type === 'TIMEENTRY' && g.userName && <span className="light small">· {g.userName}</span>}
              {type === 'TIMEENTRY' && g.billable && <span className="small" style={{ color: 'var(--primary)' }} title="Faturável">$</span>}
            </span>
          </td>
          <td className="num mono">{fmtDuration(g.duration)}{level === 0 && <span className="pct">{pct}%</span>}</td>
          <td className="num mono muted">{fmtDuration(g.duration, { decimal: true })}</td>
          {amountTypes.map((t) => <td key={t} className="num mono">{fmtAmount(amountOf(g, t), currency)}</td>)}
        </tr>
        {has && open && <TreeRows list={g.children} level={level + 1} path={key} groups={groups} expanded={expanded} toggle={toggle} amountTypes={amountTypes} total={total} currency={currency} dateFormat={dateFormat} customFields={customFields} />}
      </React.Fragment>
    );
  });
}

export function SummaryView({ result, groups = [], currency, dateFormat, customFields = [], showChart = true }) {
  const totals = result?.totals?.[0];
  const amountTypes = (totals?.amounts || []).map((a) => a.type);
  const list = result?.groupOne || [];
  const [expanded, setExpanded] = useState(() => new Set());
  const [allOpen, setAllOpen] = useState(false);
  const toggle = (k) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allKeys = useMemo(() => {
    const keys = [];
    const walk = (l, path) => l.forEach((g, i) => { const k = `${path}/${g._id || `${g.nameLowerCase}-${i}`}`; if (g.children?.length) { keys.push(k); walk(g.children, k); } });
    walk(list, ''); return keys;
  }, [list]);
  const expandAll = () => { setExpanded(new Set(allKeys)); setAllOpen(true); };
  const collapseAll = () => { setExpanded(new Set()); setAllOpen(false); };
  const headerLabel = (t) => GROUP_LABELS[t] || customFields.find((c) => c.id === t)?.name || 'Campo personalizado';
  const chart = result?.chart || [];
  const perMonth = chart.length && /^\d{4}-\d{2}$/.test(chart[0].date);
  const bars = chart.map((d) => ({ key: d.date, label: perMonth ? monthName(`${d.date}-01`).slice(0, 3) : d.date.slice(8, 10) + '/' + d.date.slice(5, 7), value: d.totalTime, title: `${perMonth ? monthName(`${d.date}-01`) : fmtDate(d.date, dateFormat)}: ${fmtDuration(d.totalTime)}${amountTypes.length ? ` · ${fmtAmount(d.totalAmount, currency)}` : ''}` }));
  const slices = list.map((g, i) => ({ name: groups[0] && GROUP_LABELS[groups[0]] ? groupName(g, groups[0], dateFormat) : (NAME_PT[g.name] || g.name), value: g.duration, color: g.color || PALETTE[i % PALETTE.length] }));

  return (
    <div>
      <Totals totals={totals} currency={currency} />
      {showChart && list.length > 0 && (
        <div className="summary-charts" style={bars.length ? undefined : { gridTemplateColumns: '1fr' }}>
          {bars.length > 0 && <div><div className="chart-title">Tempo por {perMonth ? 'mês' : 'dia'}</div><BarChart items={bars} /></div>}
          <div><div className="chart-title">Por {headerLabel(groups[0]).toLowerCase()}</div><Donut slices={slices} /></div>
        </div>
      )}
      {list.length === 0 ? <Empty icon="▤" title="Nenhum registro no período">Ajuste o período ou os filtros para ver dados.</Empty> : (
        <div className="table-wrap">
          <table className="table tree-table">
            <thead><tr>
              <th>
                <span className="row gap">{groups.map(headerLabel).join(' › ')}
                  {allKeys.length > 0 && <button type="button" className="btn link small" style={{ textTransform: 'none' }} onClick={allOpen ? collapseAll : expandAll}>{allOpen ? 'Recolher tudo' : 'Expandir tudo'}</button>}
                </span>
              </th>
              <th className="num">Duração</th><th className="num">Decimal</th>
              {amountTypes.map((t) => <th key={t} className="num">{AMOUNT_LABELS[t] || t}</th>)}
            </tr></thead>
            <tbody>
              <TreeRows list={list} level={0} path="" groups={groups} expanded={expanded} toggle={toggle} amountTypes={amountTypes} total={totals?.totalTime || 0} currency={currency} dateFormat={dateFormat} customFields={customFields} />
            </tbody>
            {totals && <tfoot><tr><td>Total</td><td className="num mono">{fmtDuration(totals.totalTime)}</td><td className="num mono">{fmtDuration(totals.totalTime, { decimal: true })}</td>{amountTypes.map((t) => <td key={t} className="num mono">{fmtAmount(amountOf(totals, t), currency)}</td>)}</tr></tfoot>}
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Detailed
const TYPE_BADGE = { BREAK: ['Pausa', ''], TIME_OFF: ['Folga', 'warning'], HOLIDAY: ['Feriado', 'warning'] };

export function SortTh({ col, sortColumn, sortOrder, onSort, className = '', children }) {
  if (!onSort || !col) return <th className={className}>{children}</th>;
  return <th className={`${className} th-sort`} onClick={() => onSort(col)} title="Ordenar">{children}{sortColumn === col ? (sortOrder === 'DESCENDING' ? ' ▼' : ' ▲') : ''}</th>;
}

export function DetailedView({ result, currency, timeZone, hour12 = false, dateFormat, selectable, selected, onToggle, onToggleAll, onRowClick, sortColumn, sortOrder, onSort }) {
  const list = result?.timeEntries || result?.timeentries || [];
  const totals = result?.totals?.[0];
  const amountTypes = (totals?.amounts || list.find((e) => e.amounts?.length)?.amounts || []).map((a) => a.type);
  const allSelected = selectable && list.length > 0 && list.every((e) => selected?.has(e._id));
  const sortProps = { sortColumn, sortOrder, onSort };
  return (
    <div>
      <Totals totals={totals} currency={currency} />
      {list.length === 0 ? <Empty icon="▤" title="Nenhum registro no período">Ajuste o período ou os filtros para ver dados.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              {selectable && <th className="check"><input type="checkbox" checked={allSelected} onChange={() => onToggleAll?.(list)} /></th>}
              <SortTh col="DESCRIPTION" {...sortProps}>Descrição</SortTh>
              <SortTh col="USER" {...sortProps}>Usuário</SortTh>
              <th>Projeto / tarefa</th><th>Cliente</th><th>Etiquetas</th><th className="center">$</th>
              <SortTh col="DATE" {...sortProps}>Data</SortTh>
              <th>Início – término</th>
              <SortTh col="DURATION" className="num" {...sortProps}>Duração</SortTh>
              {amountTypes.map((t) => <th key={t} className="num">{AMOUNT_LABELS[t] || t}</th>)}
            </tr></thead>
            <tbody>
              {list.map((e) => {
                const start = e.timeInterval?.start; const end = e.timeInterval?.end;
                const badge = TYPE_BADGE[e.type];
                return (
                  <tr key={e._id} className={`${onRowClick ? 'clickable' : ''} ${selected?.has(e._id) ? 'selected' : ''}`} onClick={() => onRowClick?.(e)}>
                    {selectable && <td className="check" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={!!selected?.has(e._id)} onChange={() => onToggle?.(e)} /></td>}
                    <td>
                      <span style={{ maxWidth: 320, display: 'inline-block' }} className="truncate" title={e.description}>{e.description || <span className="light">(sem descrição)</span>}</span>
                      {badge && <span className={`badge ${badge[1]} entry-type-badge`}>{badge[0]}</span>}
                      {(e.isLocked || e.locked) && <span title="Bloqueado" className="ml">🔒</span>}
                      {e.approvalStatus === 'APPROVED' && <span className="badge success entry-type-badge" title="Aprovado">✓</span>}
                      {e.invoicingInfo && <span className="badge primary entry-type-badge" title="Faturado">Faturado</span>}
                    </td>
                    <td><span className="row gap nowrap"><Avatar user={{ name: e.userName }} size={22} /><span className="truncate" style={{ maxWidth: 160 }}>{e.userName}</span></span></td>
                    <td>{e.projectId ? <span className="proj-label"><span className="dot" style={{ background: e.projectColor || '#999' }} /><span className="truncate"><span className="name" style={{ color: e.projectColor }}>{e.projectName}</span>{e.taskName && <span>: {e.taskName}</span>}</span></span> : <span className="light">Sem projeto</span>}</td>
                    <td className="muted">{e.clientName || ''}</td>
                    <td>{e.tags?.length ? <span className="tag-list">{e.tags.map((t) => <span key={t._id} className="chip">{t.name}</span>)}</span> : ''}</td>
                    <td className="center" style={{ color: e.billable ? 'var(--primary)' : 'var(--text-light)', fontWeight: 600 }}>$</td>
                    <td className="nowrap">{start ? fmtDate(toLocalDateStr(start, timeZone), dateFormat) : ''}</td>
                    <td className="nowrap muted">{start ? toLocalTimeStr(start, timeZone, { hour12 }) : ''} – {end ? toLocalTimeStr(end, timeZone, { hour12 }) : <span className="badge primary">em andamento</span>}</td>
                    <td className="num mono bold">{fmtDuration(e.timeInterval?.duration || 0)}</td>
                    {amountTypes.map((t) => { const v = amountOf(e, t); return <td key={t} className="num mono">{v == null ? <span className="light">—</span> : fmtAmount(v, e.currency || currency)}</td>; })}
                  </tr>
                );
              })}
            </tbody>
            {totals && <tfoot><tr>
              {selectable && <td />}
              <td colSpan={8}>Total ({totals.entriesCount} registro{totals.entriesCount === 1 ? '' : 's'})</td>
              <td className="num mono">{fmtDuration(totals.totalTime)}</td>
              {amountTypes.map((t) => <td key={t} className="num mono">{fmtAmount(amountOf(totals, t), currency)}</td>)}
            </tr></tfoot>}
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Weekly
export function WeeklyView({ result, currency, dateFormat, today }) {
  const earnings = result?.subgroup === 'EARNINGS';
  const days = (result?.totalsByDay || []).map((d) => d.date);
  const list = result?.groupOne || [];
  const totals = result?.totals?.[0];
  const [open, setOpen] = useState(() => new Set());
  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cell = (d) => { const v = earnings ? d.amount : d.duration; return v ? (earnings ? fmtAmount(v, currency) : fmtDuration(v)) : '–'; };
  const zero = (d) => !(earnings ? d.amount : d.duration);
  const dayCls = (date) => { const dow = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].indexOf(weekdayShort(date)); return `day ${dow === 0 || dow === 6 ? 'weekend' : ''} ${date === today ? 'today' : ''}`; };
  const groupLabel = result?.group === 'USER' ? 'Usuário' : 'Projeto';
  return (
    <div>
      <Totals totals={totals} currency={currency} />
      {list.length === 0 ? <Empty icon="▦" title="Nenhum registro na semana">Ajuste o período ou os filtros para ver dados.</Empty> : (
        <div className="table-wrap">
          <table className="table weekly-grid compact">
            <thead><tr>
              <th>{groupLabel}</th>
              {days.map((d) => <th key={d} className={dayCls(d)}>{weekdayShort(d)}<br /><span className="light" style={{ fontWeight: 400 }}>{fmtDate(d, dateFormat).slice(0, 5)}</span></th>)}
              <th className="day">Total</th>
            </tr></thead>
            <tbody>
              {list.map((g, i) => {
                const key = g._id || `g${i}`; const has = g.children?.length > 0; const isOpen = open.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td><span className="tree-name"><span className={`chev ${has ? '' : 'empty'}`} onClick={() => has && toggle(key)}>{isOpen ? '▼' : '▶'}</span>{g.color && <span className="dot" style={{ background: g.color }} />}<span className="bold truncate">{NAME_PT[g.name] || g.name}</span>{g.clientName && <span className="light small">– {g.clientName}</span>}</span></td>
                      {(g.days || []).map((d) => <td key={d.date} className={`${dayCls(d.date)} mono ${zero(d) ? 'zero' : ''}`}>{cell(d)}</td>)}
                      <td className="day mono bold">{earnings ? fmtAmount(g.amount, currency) : fmtDuration(g.duration)}</td>
                    </tr>
                    {has && isOpen && g.children.map((c, j) => (
                      <tr key={c._id || `c${j}`} className="lvl-1">
                        <td><span className="tree-name" style={{ paddingLeft: 22 }}><span className="chev empty">▶</span>{c.color && <span className="dot" style={{ background: c.color }} />}<span className="truncate">{NAME_PT[c.name] || c.name}</span></span></td>
                        {(c.days || []).map((d) => <td key={d.date} className={`${dayCls(d.date)} mono ${zero(d) ? 'zero' : ''}`}>{cell(d)}</td>)}
                        <td className="day mono">{earnings ? fmtAmount(c.amount, currency) : fmtDuration(c.duration)}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot><tr>
              <td>Total</td>
              {(result?.totalsByDay || []).map((d) => <td key={d.date} className={`${dayCls(d.date)} mono`}>{cell(d)}</td>)}
              <td className="day mono">{earnings ? fmtAmount(totals?.totalAmount, currency) : fmtDuration(totals?.totalTime || 0)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
      {result?.usersWithoutTime?.length > 0 && <div className="card-body small muted">Sem registros na semana: {result.usersWithoutTime.map((u) => u.name).join(', ')}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Attendance
export function AttendanceView({ result, timeZone, hour12 = false, dateFormat, sortColumn, sortOrder, onSort }) {
  const list = result?.entities || [];
  const sum = (k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const sortProps = { sortColumn, sortOrder, onSort };
  return list.length === 0 ? <Empty icon="👥" title="Nenhuma presença no período">Ajuste o período ou os filtros para ver dados.</Empty> : (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <SortTh col="USER" {...sortProps}>Usuário</SortTh>
          <SortTh col="DATE" {...sortProps}>Data</SortTh>
          <SortTh col="START" {...sortProps}>Início</SortTh>
          <SortTh col="END" {...sortProps}>Fim</SortTh>
          <SortTh col="BREAK" className="num" {...sortProps}>Pausa</SortTh>
          <SortTh col="WORK" className="num" {...sortProps}>Trabalho</SortTh>
          <SortTh col="CAPACITY" className="num" {...sortProps}>Capacidade</SortTh>
          <th className="num">Restante</th>
          <SortTh col="OVERTIME" className="num" {...sortProps}>Horas extras</SortTh>
          <SortTh col="TIME_OFF" className="num" {...sortProps}>Folga</SortTh>
        </tr></thead>
        <tbody>
          {list.map((x, i) => (
            <tr key={`${x.userId}|${x.date}|${i}`}>
              <td><span className="row gap nowrap"><Avatar user={{ name: x.userName, profilePicture: x.imageUrl }} size={24} />{x.userName}</span></td>
              <td className="nowrap">{weekdayShort(x.date)} {fmtDate(x.date, dateFormat)}</td>
              <td className="mono">{x.startTime ? toLocalTimeStr(x.startTime, timeZone, { hour12 }) : '–'}</td>
              <td className="mono">{x.hasRunningEntry ? <span className="badge primary">em andamento</span> : x.endTime ? toLocalTimeStr(x.endTime, timeZone, { hour12 }) : '–'}</td>
              <td className="num mono">{fmtDuration(x.break)}</td>
              <td className="num mono bold">{fmtDuration(x.totalDuration)}</td>
              <td className="num mono">{fmtDuration(x.capacity)}</td>
              <td className="num mono muted">{fmtDuration(x.remainingCapacity)}</td>
              <td className="num mono" style={x.overtime ? { color: 'var(--warning)' } : undefined}>{fmtDuration(x.overtime)}</td>
              <td className="num mono">{fmtDuration(x.timeOff)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={4}>Total ({result.count ?? list.length} linha{(result.count ?? list.length) === 1 ? '' : 's'})</td><td className="num mono">{fmtDuration(sum('break'))}</td><td className="num mono">{fmtDuration(sum('totalDuration'))}</td><td className="num mono">{fmtDuration(sum('capacity'))}</td><td className="num mono">{fmtDuration(sum('remainingCapacity'))}</td><td className="num mono">{fmtDuration(sum('overtime'))}</td><td className="num mono">{fmtDuration(sum('timeOff'))}</td></tr></tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Expenses
export function ExpenseReportView({ result, currency, dateFormat, sortColumn, sortOrder, onSort }) {
  const list = result?.expenses || [];
  const t = result?.totals || {};
  const sortProps = { sortColumn, sortOrder, onSort };
  return (
    <div>
      <div className="report-stats">
        <div className="stat"><div className="label">Despesas</div><div className="value mono">{t.expensesCount ?? list.length}</div></div>
        <div className="stat"><div className="label">Total</div><div className="value mono">{fmtAmount(t.totalAmount, currency)}</div></div>
        <div className="stat"><div className="label">Faturável</div><div className="value mono">{fmtAmount(t.totalAmountBillable, currency)}</div></div>
      </div>
      {list.length === 0 ? <Empty icon="💳" title="Nenhuma despesa no período">Ajuste o período ou os filtros para ver dados.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <SortTh col="DATE" {...sortProps}>Data</SortTh>
              <SortTh col="USER" {...sortProps}>Usuário</SortTh>
              <SortTh col="PROJECT" {...sortProps}>Projeto</SortTh>
              <SortTh col="CATEGORY" {...sortProps}>Categoria</SortTh>
              <th>Observações</th><th className="num">Qtd.</th>
              <SortTh col="AMOUNT" className="num" {...sortProps}>Valor</SortTh>
              <th className="center">$</th><th>Faturado</th>
            </tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id}>
                  <td className="nowrap">{fmtDate(String(x.date).slice(0, 10), dateFormat)}</td>
                  <td>{x.userName}</td>
                  <td>{x.projectId ? <span className="proj-label"><span className="dot" style={{ background: x.projectColor || '#999' }} /><span className="truncate"><span className="name" style={{ color: x.projectColor }}>{x.projectName}</span>{x.taskName && <span>: {x.taskName}</span>}{x.clientName && <span className="client"> – {x.clientName}</span>}</span></span> : <span className="light">Sem projeto</span>}</td>
                  <td>{x.categoryName}</td>
                  <td className="muted"><span className="truncate" style={{ maxWidth: 260, display: 'inline-block' }} title={x.notes}>{x.notes}</span></td>
                  <td className="num mono">{x.categoryHasUnitPrice ? `${x.quantity} ${x.categoryUnit || ''}` : x.quantity}</td>
                  <td className="num mono bold">{fmtAmount(x.amount, x.currency || currency)}</td>
                  <td className="center" style={{ color: x.billable ? 'var(--primary)' : 'var(--text-light)', fontWeight: 600 }}>$</td>
                  <td>{x.invoicingInfo ? <span className="badge primary">Sim</span> : <span className="light">Não</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={6}>Total</td><td className="num mono">{fmtAmount(t.totalAmount, currency)}</td><td colSpan={2} /></tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// Renders any report result by type (public shared page)
export function ReportResult({ type, result, ...props }) {
  const t = String(type || 'SUMMARY').toUpperCase();
  if (t === 'DETAILED') return <DetailedView result={result} {...props} />;
  if (t === 'WEEKLY') return <WeeklyView result={result} {...props} />;
  if (t === 'ATTENDANCE') return <AttendanceView result={result} {...props} />;
  if (t === 'EXPENSE_DETAILED' || t === 'EXPENSE' || t === 'EXPENSES') return <ExpenseReportView result={result} {...props} />;
  return <SummaryView result={result} {...props} />;
}
