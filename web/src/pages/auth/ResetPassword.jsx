import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const { acceptSession } = useStore();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  async function submit(e) {
    e.preventDefault(); setError(null);
    try {
      const r = await api.post('/auth/reset-password', { token: params.get('token'), password });
      if (!r?.token) { setNotice(`Senha salva. ${r?.message || ''}`); return; } // account waiting for approval
      await acceptSession(r.token); nav('/tracker');
    } catch (err) { setError(errorMessage(err)); }
  }
  if (notice) return <AuthShell title="Nova senha" footer={<Link to="/login">Voltar para o login</Link>}><Alert type="warning">{notice}</Alert></AuthShell>;
  return (
    <AuthShell title="Nova senha">
      <form onSubmit={submit}>
        <Alert type="error">{error}</Alert>
        <div className="field"><label>Nova senha</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required autoFocus /></div>
        <button className="btn lg" style={{ width: '100%' }}>Salvar</button>
      </form>
    </AuthShell>
  );
}
