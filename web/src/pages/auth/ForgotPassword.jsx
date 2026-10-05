import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { api } from '../../api.js';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

// Same interval the server applies per account (one reset e-mail per minute)
const RESEND_SECONDS = 60;

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') || '');
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const sending = useRef(false); // blocks a second click before the button re-renders as disabled

  useEffect(() => {
    if (!wait) return undefined;
    const id = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function send(e) {
    e?.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { setDone(await api.post('/auth/forgot-password', { email })); setWait(RESEND_SECONDS); } catch (err) { setError(errorMessage(err)); } finally { sending.current = false; setBusy(false); }
  }

  return (
    <AuthShell title="Recuperar senha" footer={<Link to="/login">Voltar para o login</Link>}>
      {done ? (
        <>
          <Alert type="success">
            Se houver uma conta com o e-mail <b>{email}</b>, enviamos um link para redefinir a senha. O link vale por 1 hora.
            <div className="small mt">O e-mail pode levar alguns minutos para chegar. Confira também a caixa de spam antes de pedir outro.</div>
            {done.token && <div className="small mt">Ambiente de desenvolvimento: <Link to={`/reset-password?token=${done.token}`}>abrir link de redefinição</Link></div>}
          </Alert>
          <Alert type="error">{error}</Alert>
          <button type="button" className="btn secondary lg" style={{ width: '100%' }} disabled={busy || wait > 0} onClick={send}>
            {busy ? <><span className="spinner btn-spinner" /> Enviando…</> : wait > 0 ? `Reenviar link em ${wait} s` : 'Reenviar link'}
          </button>
          <div className="center mt"><button type="button" className="btn link small" disabled={busy} onClick={() => { setDone(null); setError(null); }}>Usar outro e-mail</button></div>
        </>
      ) : (
        <form onSubmit={send}>
          <Alert type="error">{error}</Alert>
          <div className="field"><label>E-mail</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus disabled={busy} /></div>
          <button className="btn lg" style={{ width: '100%' }} disabled={busy}>{busy ? <><span className="spinner btn-spinner" /> Enviando…</> : 'Enviar link'}</button>
        </form>
      )}
    </AuthShell>
  );
}
