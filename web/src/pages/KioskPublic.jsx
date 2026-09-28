import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { request } from '../api.js';
import { Avatar, Spinner } from '../components/ui.jsx';
import { useNow, useInterval } from '../lib/hooks.js';
import { fmtDuration } from '../lib/format.js';
import './KioskPublic.css';

// Public kiosk endpoints use the kiosk session token (never the user's API token). `raw` avoids the
// global 401 handling of api.js, which would sign the admin out of the regular app on an expired kiosk session.
async function kreq(method, path, body, token) {
  const res = await request(method, path, body, { token: token || '', raw: true });
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

const MESSAGES = {
  'Invalid PIN': 'PIN incorreto. Tente novamente.',
  'Kiosk PIN is not set for this user': 'Este membro ainda não tem PIN. Peça a um administrador para definir um.',
  'User is not allowed to use this kiosk': 'Este membro não tem permissão para usar este quiosque.',
  'Already clocked in': 'Você já registrou entrada.',
  'Not clocked in': 'Você não está com entrada registrada.',
  'Clock in before starting a break': 'Registre a entrada antes de iniciar uma pausa.',
  'Already on a break': 'Você já está em pausa.',
  'Not on a break': 'Você não está em pausa.',
  'Breaks are disabled in this workspace': 'Pausas estão desativadas neste workspace.',
  'Kiosk not found': 'Quiosque não encontrado ou desativado. Verifique o link com um administrador.',
  'Project not found': 'Projeto padrão não encontrado. Avise um administrador.',
};
function friendly(err) {
  const m = err?.data?.message || err?.message || '';
  if (MESSAGES[m]) return MESSAGES[m];
  if (err?.status === 401) return 'Sua sessão no quiosque expirou. Entre novamente.';
  if (err?.status === 404) return MESSAGES['Kiosk not found'];
  if (err?.status === 403) return 'Acesso negado. Verifique se você ainda é membro ativo do workspace.';
  if (!err?.status) return 'Sem conexão com o servidor. Verifique a rede e tente novamente.';
  return m || 'Ocorreu um erro. Tente novamente.';
}

const storageKey = (code) => `clockfy.kiosk.${code}`;
function loadSession(code) { try { const s = sessionStorage.getItem(storageKey(code)); return s ? JSON.parse(s) : null; } catch { return null; } }
function saveSession(code, s) { try { s ? sessionStorage.setItem(storageKey(code), JSON.stringify(s)) : sessionStorage.removeItem(storageKey(code)); } catch { /* ignore */ } }

export default function KioskPublic() {
  const { code: rawCode } = useParams();
  const code = String(rawCode || '').toUpperCase();
  const base = `/kiosk/${code}`;
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [session, setSession] = useState(() => loadSession(code));
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const now = useNow(1000);

  useEffect(() => { document.title = 'Quiosque – Clockfy'; return () => { document.title = 'Clockfy – Controle de horas'; }; }, []);

  const loadInfo = useCallback(async () => {
    try { setInfo(await kreq('GET', base)); setFatal(null); } catch (e) { setFatal(friendly(e)); } finally { setLoading(false); }
  }, [base]);
  useEffect(() => { loadInfo(); }, [loadInfo]);
  useInterval(loadInfo, session ? null : 60000); // keep the member list fresh while idle

  const endSession = useCallback((msg) => {
    setSession(null); saveSession(code, null); setSelected(null);
    if (msg) setNotice(msg);
  }, [code]);

  async function login(member, pin) {
    setError(null);
    try {
      const r = await kreq('POST', `${base}/login`, { userId: member.id, pin: pin || undefined });
      const s = { token: r.token, expiresAt: r.expiresAt, user: r.user, status: r.status };
      setSession(s); saveSession(code, s); setSelected(null); setNotice(null);
    } catch (e) { setError(friendly(e)); throw e; }
  }

  function pickMember(m) {
    setError(null); setNotice(null);
    if (info.pinRequired) setSelected(m); else login(m).catch(() => {});
  }

  const time = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const rawDate = new Date(now).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const date = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <div className="brand"><img src="/favicon.svg" alt="" /><div><div className="ws">{info?.workspaceName || 'Clockfy'}</div><div className="name">{info ? `Quiosque: ${info.name}` : 'Quiosque'}</div></div></div>
        <div className="kiosk-clock"><div className="time">{time}</div><div className="date">{date}</div></div>
      </header>
      <main className="kiosk-main">
        <div className="kiosk-panel">
          {loading ? <div className="kiosk-center"><Spinner /></div> : fatal ? (
            <div><div className="kiosk-error">{fatal}</div><div className="kiosk-center" style={{ padding: 20 }}><button className="kiosk-btn ghost" style={{ maxWidth: 240 }} onClick={() => { setLoading(true); loadInfo(); }}>Tentar novamente</button></div></div>
          ) : session ? (
            <StatusScreen base={base} session={session} info={info} now={now} onEnd={endSession} onSessionUpdate={(s) => { setSession(s); saveSession(code, s); }} />
          ) : selected ? (
            <PinScreen member={selected} error={error} onBack={() => { setSelected(null); setError(null); }} onSubmit={(pin) => login(selected, pin)} />
          ) : (
            <MembersScreen info={info} notice={notice} error={error} onPick={pickMember} />
          )}
        </div>
      </main>
      <footer className="kiosk-footer">Clockfy · quiosque {code}</footer>
    </div>
  );
}

function MembersScreen({ info, notice, error, onPick }) {
  const [q, setQ] = useState('');
  const members = useMemo(() => (info?.members || []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase())), [info, q]);
  return (
    <div>
      <div className="kiosk-title">Quem é você?</div>
      {notice && <div className="kiosk-info">{notice}</div>}
      {error && <div className="kiosk-error">{error}</div>}
      {(info?.members || []).length > 12 && <input className="kiosk-search" placeholder="Buscar pelo nome…" value={q} onChange={(e) => setQ(e.target.value)} />}
      {!info?.members?.length ? <div className="kiosk-center">Nenhum membro liberado para este quiosque.</div> : (
        <div className="kiosk-members">
          {members.map((m) => (
            <div key={m.id} className="kiosk-member" role="button" tabIndex={0} onClick={() => onPick(m)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(m)}>
              <Avatar user={m} size={64} />
              <div className="nm">{m.name}</div>
              {info.pinRequired && !m.hasPin && <div className="no-pin">sem PIN definido</div>}
            </div>
          ))}
          {!members.length && <div className="kiosk-center" style={{ gridColumn: '1 / -1' }}>Nenhum membro encontrado.</div>}
        </div>
      )}
      <div className="kiosk-sub" style={{ marginTop: 24 }}>{info?.pinRequired ? 'Toque no seu nome e digite o PIN para registrar entrada, pausa ou saída.' : 'Toque no seu nome para registrar entrada, pausa ou saída.'}</div>
    </div>
  );
}

function PinScreen({ member, error, onBack, onSubmit }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const pinRef = useRef(pin); pinRef.current = pin;

  const submit = useCallback(async (value) => {
    const v = value ?? pinRef.current;
    if (v.length < 4 || busy) return;
    setBusy(true);
    try { await onSubmit(v); } catch { setPin(''); } finally { setBusy(false); }
  }, [busy, onSubmit]);

  const push = useCallback((d) => setPin((p) => (p.length >= 6 ? p : p + d)), []);
  useEffect(() => {
    const h = (e) => {
      if (/^\d$/.test(e.key)) push(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [push, submit, onBack]);
  useEffect(() => { if (pin.length === 6) submit(pin); }, [pin, submit]);

  return (
    <div className="kiosk-pin">
      <div className="who"><Avatar user={member} size={44} /><span>{member.name}</span></div>
      <div className="kiosk-sub">Digite seu PIN</div>
      <div className="kiosk-dots">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} style={i >= 4 && pin.length <= 4 && i >= pin.length ? { opacity: .35 } : undefined} />)}</div>
      {error && <div className="kiosk-error">{error}</div>}
      <div className="kiosk-keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" className="kiosk-key" onClick={() => push(d)} disabled={busy}>{d}</button>)}
        <button type="button" className="kiosk-key muted" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} aria-label="Apagar">⌫</button>
        <button type="button" className="kiosk-key" onClick={() => push('0')} disabled={busy}>0</button>
        <button type="button" className="kiosk-key ok" onClick={() => submit()} disabled={busy || pin.length < 4} aria-label="Entrar">{busy ? <Spinner /> : '✓'}</button>
      </div>
      <div style={{ marginTop: 22 }}><button type="button" className="kiosk-back" onClick={onBack}>← Voltar para a lista</button></div>
    </div>
  );
}

function StatusScreen({ base, session, info, now, onEnd, onSessionUpdate }) {
  const [status, setStatus] = useState(session.status || null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const token = session.token;
  useEffect(() => { if (!flash) return undefined; const id = setTimeout(() => setFlash(null), 4000); return () => clearTimeout(id); }, [flash]);

  const fail = useCallback((e) => {
    if (e?.status === 401) { onEnd('Sua sessão no quiosque expirou. Entre novamente.'); return; }
    if (e?.status === 404 && /kiosk/i.test(e?.data?.message || '')) { onEnd(MESSAGES['Kiosk not found']); return; }
    setError(friendly(e));
  }, [onEnd]);

  const refresh = useCallback(async () => {
    if (new Date(session.expiresAt).getTime() <= Date.now()) { onEnd('Sua sessão no quiosque expirou. Entre novamente.'); return; }
    try { setStatus(await kreq('GET', `${base}/status`, undefined, token)); setFetchedAt(Date.now()); setError((er) => (er && /conexão/.test(er) ? null : er)); } catch (e) { fail(e); }
  }, [base, token, session.expiresAt, onEnd, fail]);
  useEffect(() => { refresh(); }, [refresh]);
  useInterval(refresh, 5000);

  async function act(path, okMsg) {
    setBusy(true); setError(null);
    try { setStatus(await kreq('POST', `${base}/${path}`, {}, token)); setFetchedAt(Date.now()); if (okMsg) setFlash(okMsg); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try { await kreq('POST', `${base}/logout`, {}, token); } catch { /* the session is dropped locally anyway */ } finally { setBusy(false); onEnd(null); }
  }

  // live counters between polls
  const elapsed = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const running = status?.running || null;
  const working = !!status?.clockedIn && !status?.onBreak;
  const today = (status?.todayTotalSeconds || 0) + (working ? elapsed : 0);
  const breakTotal = (status?.todayBreakSeconds || 0) + (status?.onBreak ? elapsed : 0);
  const since = running ? new Date(running.timeInterval.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
  const runningFor = running ? Math.max(0, Math.floor((now - new Date(running.timeInterval.start).getTime()) / 1000)) : 0;
  const expiresIn = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - now) / 1000));
  const breaksEnabled = info?.breaksEnabled !== false;

  useEffect(() => { if (status && session.status !== status) onSessionUpdate({ ...session, status }); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="kiosk-status">
      <div className="who"><Avatar user={session.user} size={56} /><span>{session.user?.name}</span></div>
      {!status ? <div className="kiosk-center"><Spinner /></div> : (
        <>
          <div className={`kiosk-state ${status.onBreak ? 'break' : working ? 'working' : ''}`}>{status.onBreak ? 'Em pausa' : working ? 'Trabalhando' : 'Fora do expediente'}</div>
          {running && <div className="kiosk-running">{status.onBreak ? 'Pausa iniciada' : 'Entrada registrada'} às <b>{since}</b> · há {fmtDuration(runningFor)}{!status.onBreak && running.project ? <> · projeto <b style={{ color: running.project.color || '#fff' }}>{running.project.name}</b></> : null}</div>}
          <div className="kiosk-stats">
            <div className="kiosk-stat"><div className="lbl">Trabalhado hoje</div><div className="val">{fmtDuration(today)}</div></div>
            {breakTotal > 0 && <div className="kiosk-stat"><div className="lbl">Pausas hoje</div><div className="val small">{fmtDuration(breakTotal)}</div></div>}
          </div>
          {flash && <div className="kiosk-info">{flash}</div>}
          {error && <div className="kiosk-error">{error}</div>}
          <div className="kiosk-actions">
            {!status.clockedIn && <button className="kiosk-btn in" disabled={busy} onClick={() => act('clock-in', 'Entrada registrada. Bom trabalho!')}>▶ Entrar</button>}
            {status.clockedIn && !status.onBreak && breaksEnabled && <button className="kiosk-btn break" disabled={busy} onClick={() => act('break-start', 'Pausa iniciada.')}>☕ Iniciar pausa</button>}
            {status.onBreak && <button className="kiosk-btn in" disabled={busy} onClick={() => act('break-end', 'Pausa encerrada. De volta ao trabalho!')}>▶ Encerrar pausa</button>}
            {status.clockedIn && <button className="kiosk-btn out" disabled={busy} onClick={() => act('clock-out', 'Saída registrada. Até logo!')}>■ Sair</button>}
            <button className="kiosk-btn ghost" disabled={busy} onClick={logout}>Encerrar sessão</button>
          </div>
          {info?.defaultProjectId && !status.clockedIn && <div className="kiosk-sub" style={{ marginTop: 16, fontSize: 13 }}>A entrada será registrada no projeto padrão do quiosque.</div>}
          <div className="kiosk-sub" style={{ marginTop: 16, fontSize: 12, opacity: .6 }}>Sessão expira em {expiresIn >= 3600 ? `${Math.floor(expiresIn / 3600)}h ${Math.floor((expiresIn % 3600) / 60)}min` : `${Math.floor(expiresIn / 60)}min`}</div>
        </>
      )}
    </div>
  );
}
