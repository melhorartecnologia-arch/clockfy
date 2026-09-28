import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { api } from '../../api.js';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault(); setError(null);
    try { const r = await api.post('/auth/forgot-password', { email }); setDone(r); } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <AuthShell title="Recuperar senha" footer={<Link to="/login">Voltar para o login</Link>}>
      {done ? <Alert type="success">Se o e-mail existir, enviamos um link para redefinir a senha.{done.token && <div className="small mt">Ambiente de desenvolvimento: <Link to={`/reset-password?token=${done.token}`}>abrir link de redefinição</Link></div>}</Alert> : (
        <form onSubmit={submit}>
          <Alert type="error">{error}</Alert>
          <div className="field"><label>E-mail</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
          <button className="btn lg" style={{ width: '100%' }}>Enviar link</button>
        </form>
      )}
    </AuthShell>
  );
}
