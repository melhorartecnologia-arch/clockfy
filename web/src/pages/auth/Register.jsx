import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { useStore } from '../../store.jsx';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

export default function Register() {
  const { register } = useStore();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await register({ ...form, workspaceName: form.workspaceName || undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      nav('/tracker', { replace: true });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Criar conta" footer={<>Já tem conta? <Link to="/login">Entrar</Link></>}>
      <form onSubmit={submit}>
        <Alert type="error">{error}</Alert>
        <div className="field"><label>Nome</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
        <div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} required /></div>
        <div className="field"><label>Senha (mín. 6 caracteres)</label><input type="password" value={form.password} onChange={set('password')} minLength={6} required /></div>
        <div className="field"><label>Nome do workspace (opcional)</label><input value={form.workspaceName} onChange={set('workspaceName')} placeholder="Minha empresa" /></div>
        <button className="btn lg" style={{ width: '100%' }} disabled={busy}>Criar conta</button>
      </form>
    </AuthShell>
  );
}
