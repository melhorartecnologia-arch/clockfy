import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { Spinner, Alert, Empty, Avatar, DateRangePicker, Money } from '../components/ui.jsx';
import { useLocalState, useNow } from '../lib/hooks.js';
import { fmtDuration, toLocalDateStr, toLocalTimeStr, localToIso, addDays, startOfWeekStr, weekdayShort, fmtDate, errorMessage, entryDuration } from '../lib/format.js';

const PERIODS = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: 'Esta semana' },
  { value: 'lastWeek', label: 'Semana passada' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];

function periodRange(period, today, weekStart, custom) {
  if (period === 'today') return [today, today];
  if (period === 'week') { const s = startOfWeekStr(today, weekStart); return [s, addDays(s, 6)]; }
  if (period === 'lastWeek') { const s = addDays(startOfWeekStr(today, weekStart), -7); return [s, addDays(s, 6)]; }
  if (period === 'month') { const s = `${today.slice(0, 7)}-01`; const [y, m] = s.split('-').map(Number); const e = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); return [s, e]; }
  return [custom.start, custom.end];
}

// Client-side aggregation used when the dashboard endpoint is unavailable
function aggregate(entries, { timeZone, start, end, users = [] }) {
  const days = []; for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const byDay = Object.fromEntries(days.map((d) => [d, { date: d, duration: 0, billable: 0, nonBillable: 0 }]));
  const byProject = new Map(); const acts = new Map(); const team = new Map();
  let totalTime = 0; let billableTime = 0; let earned = 0;
  for (const e of entries) {
    if (e.type === 'BREAK') continue;
    const secs = entryDuration(e);
    const d = toLocalDateStr(e.timeInterval.start, timeZone);
    totalTime += secs; if (e.billable) billableTime += secs;
    const amount = e.billable && e.hourlyRate ? Math.round((secs / 3600) * e.hourlyRate.amount) : 0;
    earned += amount;
    if (byDay[d]) { byDay[d].duration += secs; if (e.billable) byDay[d].billable += secs; else byDay[d].nonBillable += secs; }
    const pk = e.projectId || '';
    if (!byProject.has(pk)) byProject.set(pk, { projectId: e.projectId, name: e.project?.name || 'Sem projeto', color: e.project?.color || '#9aa5ad', clientName: e.project?.clientName || '', duration: 0, amount: 0 });
    byProject.get(pk).duration += secs; byProject.get(pk).amount += amount;
    const ak = `${e.description}|${pk}`;
    if (!acts.has(ak)) acts.set(ak, { description: e.description, projectId: e.projectId, projectName: e.project?.name || '', duration: 0 });
    acts.get(ak).duration += secs;
    const uid = e.userId;
    if (!team.has(uid)) team.set(uid, { userId: uid, userName: e.user?.name || '', imageUrl: e.user?.profilePicture || null, running: null, totalTime: 0, lastActivity: null });
    const t = team.get(uid); t.totalTime += secs;
    if (!t.lastActivity || e.timeInterval.start > t.lastActivity) t.lastActivity = e.timeInterval.end || e.timeInterval.start;
    if (!e.timeInterval.end) t.running = { description: e.description, projectName: e.project?.name || '', start: e.timeInterval.start };
  }
  for (const u of users) if (!team.has(u.id)) team.set(u.id, { userId: u.id, userName: u.name, imageUrl: u.profilePicture, running: null, totalTime: 0, lastActivity: null });
  for (const u of users) { const t = team.get(u.id); if (t && !t.userName) { t.userName = u.name; t.imageUrl = u.profilePicture; } }
  return {
    totalTime, billableTime, nonBillableTime: totalTime - billableTime, earned,
    byDay: days.map((d) => byDay[d]),
    byProject: [...byProject.values()].sort((a, b) => b.duration - a.duration),
    topActivities: [...acts.values()].sort((a, b) => b.duration - a.duration).slice(0, 10),
    team: [...team.values()].sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.totalTime - a.totalTime),
  };
}

export default function Dashboard() {
  const { workspace, user, timeZone, weekStart, isAdmin, settings, userSettings, dateFormat, currency } = useStore();
  const wsId = workspace?.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [period, setPeriod] = useLocalState('clockfy.dashPeriod', 'week');
  const [custom, setCustom] = useState({ start: startOfWeekStr(today, weekStart), end: today });
  const [selection, setSelection] = useLocalState('clockfy.dashSelection', userSettings.dashboardSelection || 'ME');
  const [type, setType] = useLocalState('clockfy.dashType', userSettings.dashboardViewType || 'PROJECT');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const now = useNow(1000);
  const showRates = isAdmin || !settings.onlyAdminsSeeBillableRates;
  const canTeam = isAdmin;
  const sel = canTeam ? selection : 'ME';
  const [start, end] = periodRange(period, today, weekStart, custom);

  const load = useCallback(async () => {
    if (!wsId || !start || !end || start > end) return;
    setLoading(true); setError(null);
    const startIso = localToIso(start, '00:00', timeZone); const endIso = localToIso(addDays(end, 1), '00:00', timeZone);
    try {
      let d;
      try {
        d = await api.get(`${ws(wsId)}/dashboard`, { start: startIso, end: endIso, selection: sel, type });
      } catch (err) {
        if (err.status !== 404 && err.status !== 501) throw err;
        // Fallback: aggregate in the browser from time entries
        const params = { start: startIso, end: endIso, hydrated: true, 'page-size': 5000 };
        const [entries, users] = sel === 'TEAM'
          ? await Promise.all([api.get(`${ws(wsId)}/time-entries`, params), endpoints.users(wsId)])
          : await Promise.all([endpoints.timeEntries(wsId, user.id, params), Promise.resolve([{ id: user.id, name: user.name, profilePicture: user.profilePicture }])]);
        d = aggregate(entries, { timeZone, start, end, users });
      }
      setData(d);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, start, end, sel, type, timeZone, user.id, user.name, user.profilePicture]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(load, 120000); return () => clearInterval(id); }, [load]);

  const maxDay = useMemo(() => Math.max(1, ...(data?.byDay || []).map((d) => d.duration)), [data]);
  const projTotal = useMemo(() => Math.max(1, (data?.byProject || []).reduce((s, p) => s + p.duration, 0)), [data]);
  const manyDays = (data?.byDay || []).length > 14;

  return (
    <div>
      <div className="page-header">
        <h1>Painel</h1>
        <div className="right row gap wrap">
          {canTeam && <div className="btn-group"><button className={`btn sm ${sel === 'ME' ? '' : 'secondary'}`} onClick={() => setSelection('ME')}>Eu</button><button className={`btn sm ${sel === 'TEAM' ? '' : 'secondary'}`} onClick={() => setSelection('TEAM')}>Equipe</button></div>}
          <div className="btn-group"><button className={`btn sm ${type === 'PROJECT' ? '' : 'secondary'}`} onClick={() => setType('PROJECT')}>Projeto</button><button className={`btn sm ${type === 'BILLABILITY' ? '' : 'secondary'}`} onClick={() => setType('BILLABILITY')}>Faturabilidade</button></div>
          <select style={{ width: 'auto' }} value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          {period === 'custom' && <DateRangePicker start={custom.start} end={custom.end} onChange={(s, e) => setCustom({ start: s, end: e })} />}
        </div>
      </div>
      <Alert type="error">{error}</Alert>
      {loading && !data ? <Spinner block /> : data && (
        <>
          <div className="grid cols-4">
            <div className="card stat"><div className="label">Tempo total</div><div className="value mono">{fmtDuration(data.totalTime)}</div><div className="small muted">{fmtDate(start, dateFormat)} – {fmtDate(end, dateFormat)}</div></div>
            <div className="card stat"><div className="label">Faturável</div><div className="value mono" style={{ color: 'var(--primary-dark)' }}>{fmtDuration(data.billableTime)}</div><div className="small muted">{data.totalTime ? Math.round((data.billableTime / data.totalTime) * 100) : 0}% do total</div></div>
            <div className="card stat"><div className="label">Não faturável</div><div className="value mono">{fmtDuration(data.nonBillableTime)}</div><div className="small muted">{data.totalTime ? Math.round((data.nonBillableTime / data.totalTime) * 100) : 0}% do total</div></div>
            <div className="card stat"><div className="label">Valor</div><div className="value">{showRates ? <Money cents={data.earned} currency={currency} /> : <span className="light">—</span>}</div><div className="small muted">{showRates ? 'Horas faturáveis × taxa horária' : 'Visível apenas para administradores'}</div></div>
          </div>

          <div className="card mt">
            <div className="card-head"><h3 style={{ margin: 0 }}>Tempo por dia</h3>{type === 'BILLABILITY' && <span className="legend row gap right small" style={{ flexDirection: 'row' }}><span className="item"><span className="dot" style={{ background: 'var(--primary)' }} />Faturável</span><span className="item"><span className="dot" style={{ background: '#c6d0d7' }} />Não faturável</span></span>}</div>
            <div className="card-body" style={{ paddingBottom: 32 }}>
              {data.totalTime === 0 ? <Empty title="Nenhum registro no período">Registre tempo para ver o gráfico.</Empty> : (
                <div className="bar-chart" style={{ height: 180 }}>
                  {data.byDay.map((d) => {
                    const h = Math.round((d.duration / maxDay) * 100);
                    const bh = d.duration ? Math.round((d.billable / maxDay) * 100) : 0;
                    return (
                      <div key={d.date} className="bar" style={{ height: `${h}%`, background: type === 'BILLABILITY' ? '#c6d0d7' : 'var(--primary)', minHeight: d.duration ? 2 : 0, opacity: d.date === today ? 1 : .85 }} title={`${weekdayShort(d.date)} ${fmtDate(d.date, dateFormat)}: ${fmtDuration(d.duration)}${type === 'BILLABILITY' ? ` (faturável ${fmtDuration(d.billable)})` : ''}`}>
                        {type === 'BILLABILITY' && d.billable > 0 && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.round((bh / Math.max(h, 1)) * 100)}%`, background: 'var(--primary)', borderRadius: '3px 3px 0 0' }} />}
                        {d.duration > 0 && !manyDays && <span className="val mono">{fmtDuration(d.duration, { seconds: false })}</span>}
                        <span className="lbl">{manyDays ? d.date.slice(8) : `${weekdayShort(d.date)} ${d.date.slice(8)}`}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="grid cols-2 mt">
            <div className="card">
              <div className="card-head"><h3 style={{ margin: 0 }}>{type === 'BILLABILITY' ? 'Faturabilidade' : 'Por projeto'}</h3><span className="muted small right">{fmtDuration(data.totalTime)}</span></div>
              <div className="card-body">
                {type === 'BILLABILITY' ? (
                  <Breakdown items={[{ id: 'b', name: 'Faturável', color: 'var(--primary)', duration: data.billableTime }, { id: 'n', name: 'Não faturável', color: '#c6d0d7', duration: data.nonBillableTime }]} total={Math.max(1, data.totalTime)} showRates={false} />
                ) : (
                  data.byProject.length === 0 ? <Empty icon="▣" title="Sem projetos">Nenhum tempo registrado em projetos.</Empty>
                    : <Breakdown items={data.byProject.map((p) => ({ id: p.projectId || 'none', name: p.name, sub: p.clientName, color: p.color, duration: p.duration, amount: p.amount, link: p.projectId ? `/projects/${p.projectId}` : null }))} total={projTotal} showRates={showRates} currency={currency} />
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h3 style={{ margin: 0 }}>Principais atividades</h3></div>
              {data.topActivities.length === 0 ? <Empty icon="☰" title="Sem atividades">Nenhuma descrição registrada no período.</Empty> : (
                <table className="table compact">
                  <thead><tr><th>Descrição</th><th>Projeto</th><th className="num">Duração</th></tr></thead>
                  <tbody>{data.topActivities.map((a, i) => (
                    <tr key={i}><td className="truncate" style={{ maxWidth: 260 }}>{a.description || <span className="light">(sem descrição)</span>}</td><td className="muted small">{a.projectName || '—'}</td><td className="num mono">{fmtDuration(a.duration)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>

          {sel === 'TEAM' && (
            <div className="card mt">
              <div className="card-head"><h3 style={{ margin: 0 }}>Status da equipe</h3><span className="muted small right">{data.team.filter((t) => t.running).length} com timer em andamento</span></div>
              <table className="table">
                <thead><tr><th>Membro</th><th>Status</th><th>Atividade atual</th><th className="num">Tempo no período</th><th>Última atividade</th></tr></thead>
                <tbody>
                  {data.team.map((t) => (
                    <tr key={t.userId}>
                      <td><span className="row gap"><Avatar user={{ name: t.userName, profilePicture: t.imageUrl }} size={26} /><span>{t.userName}</span></span></td>
                      <td>{t.running ? <span className="badge success">● Rastreando</span> : <span className="badge">Parado</span>}</td>
                      <td>{t.running ? <span><span className="bold">{t.running.description || '(sem descrição)'}</span>{t.running.projectName && <span className="muted"> · {t.running.projectName}</span>}<span className="mono muted small"> · {fmtDuration(Math.round((now - new Date(t.running.start)) / 1000))}</span></span> : <span className="light">—</span>}</td>
                      <td className="num mono">{fmtDuration(t.totalTime)}</td>
                      <td className="muted small">{t.lastActivity ? `${fmtDate(toLocalDateStr(t.lastActivity, timeZone), dateFormat)} ${toLocalTimeStr(t.lastActivity, timeZone)}` : '—'}</td>
                    </tr>
                  ))}
                  {data.team.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 24 }}>Nenhum membro ativo.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Horizontal proportional bars (inline SVG) with a stacked share bar on top
function Breakdown({ items, total, showRates, currency }) {
  let acc = 0;
  return (
    <div>
      <svg width="100%" height="14" role="img" aria-label="Distribuição" style={{ display: 'block', borderRadius: 4, marginBottom: 14 }}>
        <rect x="0" y="0" width="100%" height="14" fill="#e8edf0" />
        {items.map((it) => { const w = (it.duration / total) * 100; const x = acc; acc += w; return w > 0 ? <rect key={it.id} x={`${x}%`} y="0" width={`${Math.max(0, w - .3)}%`} height="14" fill={it.color}><title>{it.name}: {fmtDuration(it.duration)}</title></rect> : null; })}
      </svg>
      <div className="legend">
        {items.map((it) => {
          const pct = Math.round((it.duration / total) * 100);
          return (
            <div key={it.id} className="item" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 2fr auto auto', gap: 10, alignItems: 'center' }}>
              <span className="row gap truncate"><span className="dot" style={{ background: it.color }} />{it.link ? <Link to={it.link} className="truncate" style={{ color: 'inherit' }}>{it.name}</Link> : <span className="truncate">{it.name}</span>}{it.sub && <span className="light small truncate">– {it.sub}</span>}</span>
              <svg width="100%" height="8" style={{ display: 'block' }}><rect x="0" y="0" width="100%" height="8" rx="4" fill="#eef2f4" /><rect x="0" y="0" width={`${pct}%`} height="8" rx="4" fill={it.color}><title>{pct}%</title></rect></svg>
              <span className="mono nowrap">{fmtDuration(it.duration)} <span className="light small">{pct}%</span></span>
              <span className="nowrap small muted" style={{ minWidth: 70, textAlign: 'right' }}>{showRates && it.amount != null ? <Money cents={it.amount} currency={currency} /> : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

