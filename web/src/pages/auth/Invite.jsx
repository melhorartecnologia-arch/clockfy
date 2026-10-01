import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { Alert, Spinner } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

export default function Invite() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { acceptSession } = useStore();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState(null);
  useEffect(() => { api.get(`/auth/invite/${token}`).then((i) => { setInfo(i); setName(i.name || ''); }).catch((e) => setError(errorMessage(e))); }, [token]);
  async function submit(e) {
    e.preventDefault(); setError(null);
    try {
      const r = await api.post('/auth/accept-invite', { token, name, password });
      if (!r?.token) { setInfo(null); setError(null); setNotice(r?.message || 'Sua conta ainda não pode entrar.'); return; } // sign-up waiting for approval
      await acceptSession(r.token); nav('/tracker');
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <AuthShell title="Aceitar convite">
      <Alert type="error">{error}</Alert>
      <Alert type="warning">{notice}</Alert>
      {!info && !error && !notice && <Spinner block />}
      {info && (
        <form onSubmit={submit}>
          <p>Você foi convidado para o workspace <b>{info.workspaceName}</b> como <b>{info.email}</b>. Defina seu nome e senha para entrar.</p>
          <div className="field"><label>Nome</label><input value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="field"><label>Senha</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required /></div>
          <button className="btn lg" style={{ width: '100%' }}>Entrar no workspace</button>
        </form>
      )}
    </AuthShell>
  );
}
