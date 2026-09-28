import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  async function submit(e) {
    e.preventDefault(); setError(null);
    try { const r = await api.post('/auth/reset-password', { token: params.get('token'), password }); await acceptSession(r.token); nav('/tracker'); } catch (err) { setError(errorMessage(err)); }
  }
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
