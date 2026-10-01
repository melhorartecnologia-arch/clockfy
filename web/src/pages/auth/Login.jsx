import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { useStore } from '../../store.jsx';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

export default function Login() {
  const { login } = useStore();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // account waiting for approval / not approved
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try { await login(email, password); nav(loc.state?.from || '/tracker', { replace: true }); } catch (err) {
      if ([1011, 1012].includes(err.data?.code)) setNotice(errorMessage(err));
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Entrar" footer={<>Não tem conta? <Link to="/register">Criar conta</Link></>}>
      <form onSubmit={submit}>
        <Alert type="error">{error}</Alert>
        <Alert type="warning">{notice}</Alert>
        <div className="field"><label>E-mail</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
        <div className="field"><label>Senha</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        <button className="btn lg" style={{ width: '100%' }} disabled={busy}>Entrar</button>
        <div className="center mt"><Link to="/forgot-password" className="small">Esqueci minha senha</Link></div>
      </form>
    </AuthShell>
  );
}
