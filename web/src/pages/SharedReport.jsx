import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Spinner, Alert, Empty, DateRangePicker, Dropdown, Pagination, Toasts } from '../components/ui.jsx';
import { toLocalDateStr, fmtDate, errorMessage } from '../lib/format.js';
import { ReportResult, REPORT_TYPES, PERIODS, presetRange, shiftRange } from '../components/reportViews.jsx';
import './Reports.css';

// Public page for a shared report (/shared/:id). Public reports need no login; private ones require an allowed user.
export default function SharedReport() {
  const { id } = useParams();
  const { user, loading: sessionLoading, dateFormat, timeFormat, weekStart, currency: storeCurrency, toast } = useStore();
  const [range, setRange] = useState(null);   // { start, end } (YYYY-MM-DD in the report's time zone)
  const [period, setPeriod] = useState('CUSTOM');
  const [unit, setUnit] = useState('range');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const loadedRef = useRef(null);

  useEffect(() => {
    if (sessionLoading) return undefined; // wait for the session so private reports get the token
    const key = `${id}|${range?.start || ''}|${range?.end || ''}|${page}`;
    if (loadedRef.current === key) return undefined;
    loadedRef.current = key;
    let alive = true;
    setLoading(true); setError(null);
    api.get(`/shared-reports/${id}`, { dateRangeStart: range?.start, dateRangeEnd: range?.end, page, pageSize: 50 })
      .then((r) => {
        if (!alive) return;
        setData(r);
        if (!range && r.dateRangeStart) {
          const tz = r.timeZone || 'UTC';
          const next = { start: toLocalDateStr(r.dateRangeStart, tz), end: toLocalDateStr(r.dateRangeEnd, tz) };
          loadedRef.current = `${id}|${next.start}|${next.end}|${page}`;
          setRange(next);
        }
      })
      .catch((e) => { if (alive) { setError(e); setData(null); } })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [id, range, page, sessionLoading]);

  const today = toLocalDateStr(new Date(), data?.timeZone || undefined);
  const selectPeriod = (p) => {
    setPeriod(p);
    const r = presetRange(p, today, weekStart);
    if (r) { setUnit(PERIODS.find((x) => x.value === p)?.unit || 'range'); setRange({ start: r[0], end: r[1] }); setPage(1); }
  };
  const shift = (dir) => { if (!range) return; const [s, e] = shiftRange(range.start, range.end, unit, dir); setPeriod('CUSTOM'); setRange({ start: s, end: e }); setPage(1); };
  async function exportAs(exportType) {
    setBusy(exportType);
    try {
      const q = new URLSearchParams({ exportType });
      if (range && !data?.fixedDate) { q.set('dateRangeStart', range.start); q.set('dateRangeEnd', range.end); }
      await api.download(`/shared-reports/${id}?${q}`, undefined, undefined, 'GET');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(null); }
  }

  const status = error?.status;
  const needsLogin = (status === 401 || status === 403) && !user;
  const type = String(data?.type || 'SUMMARY').toUpperCase();
  const currency = data?.timeEntries?.[0]?.currency || data?.timeentries?.[0]?.currency || data?.expenses?.[0]?.currency || storeCurrency;
  const count = type === 'EXPENSE_DETAILED' ? data?.totals?.expensesCount : data?.count;
  const pageSize = data?.pageSize || 50;

  return (
    <div className="shared-page">
      <header className="shared-head">
        <Link to={user ? '/reports' : '/login'} className="logo"><img src="/favicon.svg" alt="" />Clockfy</Link>
        <span className="muted">Relatório compartilhado</span>
        <span className="right row gap">
          {user ? <Link to="/reports" className="btn ghost sm">Ir para relatórios</Link> : <Link to="/login" state={{ from: `/shared/${id}` }} className="btn ghost sm">Entrar</Link>}
        </span>
      </header>
      <div className="shared-body">
        {sessionLoading || (loading && !data && !error) ? <Spinner block /> : null}
        {error && !loading && (
          <div className="card"><Empty icon={needsLogin ? '🔒' : '⚠'} title={status === 404 ? 'Relatório não encontrado' : needsLogin ? 'Este relatório é privado' : status === 403 ? 'Você não tem acesso a este relatório' : 'Não foi possível abrir o relatório'}>
            {needsLogin ? <>Faça login com uma conta autorizada para visualizá-lo. <Link to={`/login?next=${encodeURIComponent(`/shared/${id}`)}`} state={{ from: `/shared/${id}` }} className="btn mt" style={{ display: 'inline-flex' }}>Fazer login</Link></> : errorMessage(error)}
          </Empty></div>
        )}
        {data && (
          <>
            <div className="page-header">
              <div>
                <h1>{data.name}</h1>
                <div className="muted small">{data.workspaceName} · {REPORT_TYPES[type] || type}{range ? ` · ${fmtDate(range.start, dateFormat)} – ${fmtDate(range.end, dateFormat)}` : ''}{data.fixedDate ? ' · período fixo' : ''}</div>
              </div>
              <span className="right row gap wrap">
                {loading && <Spinner />}
                <Dropdown label={busy ? `Exportando ${busy}…` : 'Exportar ▾'} className="secondary">
                  <button onClick={() => exportAs('CSV')}>CSV</button><button onClick={() => exportAs('XLSX')}>Excel (XLSX)</button><button onClick={() => exportAs('PDF')}>PDF</button>
                </Dropdown>
              </span>
            </div>
            {!data.fixedDate && range && (
              <div className="card mb"><div className="filter-bar">
                <select value={period} onChange={(e) => selectPeriod(e.target.value)} style={{ minWidth: 150 }}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
                <button type="button" className="btn ghost icon" onClick={() => shift(-1)} title="Período anterior">‹</button>
                <span className="range-label">{fmtDate(range.start, dateFormat)} – {fmtDate(range.end, dateFormat)}</span>
                <button type="button" className="btn ghost icon" onClick={() => shift(1)} title="Próximo período">›</button>
                <DateRangePicker start={range.start} end={range.end} onChange={(s, e) => { if (s && e) { setPeriod('CUSTOM'); setUnit('range'); setRange({ start: s, end: e }); setPage(1); } }} />
              </div></div>
            )}
            <div className="card" style={loading ? { opacity: .55 } : undefined}>
              <Alert type="error">{error ? errorMessage(error) : null}</Alert>
              <ReportResult type={type} result={data} currency={currency} timeZone={data.timeZone} hour12={timeFormat === 'HOUR12'} dateFormat={dateFormat} today={today} groups={data.filter?.summaryFilter?.groups || ['PROJECT', 'TIMEENTRY']} />
              {count > pageSize && <Pagination page={page} pageSize={pageSize} count={count} onChange={setPage} />}
            </div>
          </>
        )}
      </div>
      <Toasts />
    </div>
  );
}
