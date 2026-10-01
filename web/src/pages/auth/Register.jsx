import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Alert } from '../../components/ui.jsx';
import { errorMessage } from '../../lib/format.js';

const CODE_EMAIL_INVITED = 1010;

export default function Register() {
  const { register } = useStore();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState(null);
  const [invited, setInvited] = useState(null); // e-mail of an account created by an administrator
  const [pending, setPending] = useState(null); // answer of a sign-up waiting for approval
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  useEffect(() => { api.get('/auth/signup-info').then((i) => setApprovalRequired(!!i?.approvalRequired)).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null); setInvited(null);
    try {
      const r = await register({ ...form, workspaceName: form.workspaceName || undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (r && !r.token) { setPending(r); return; }
      nav('/tracker', { replace: true });
    } catch (err) {
      if (err.data?.code === CODE_EMAIL_INVITED) setInvited(form.email);
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  }

  if (pending) {
    return (
      <AuthShell title="Cadastro recebido" footer={<Link to="/login">Voltar para o login</Link>}>
        <Alert type="success">
          <div className="bold">Sua conta foi criada e está aguardando aprovação.</div>
          <div className="mt">{pending.message}</div>
        </Alert>
        <p className="small muted">Conta: <b>{pending.email}</b>. Enquanto ela não for aprovada, o login mostrará este aviso. Se demorar, fale com o administrador do Clockfy da sua empresa.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Criar conta" footer={<>Já tem conta? <Link to="/login">Entrar</Link></>}>
      <form onSubmit={submit}>
        {approvalRequired && <Alert type="info">Por segurança, novas contas só podem entrar depois de <b>aprovadas por um administrador</b>. Você receberá um e-mail quando a sua for aprovada.</Alert>}
        <Alert type="error">{error}</Alert>
        {invited && (
          <Alert type="warning">
            <div><b>{invited}</b> já tem uma conta criada por um administrador (convite ou importação do Clockify).</div>
            <div className="mt">Para definir a sua senha, use <Link to={`/forgot-password?email=${encodeURIComponent(invited)}`}><b>Esqueci minha senha</b></Link>: enviaremos um link para este e-mail. Se recebeu um convite por e-mail, você também pode usar o link do convite.</div>
          </Alert>
        )}
        <div className="field"><label>Nome</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
        <div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} required /></div>
        <div className="field"><label>Senha (mín. 6 caracteres)</label><input type="password" value={form.password} onChange={set('password')} minLength={6} required /></div>
        <div className="field"><label>Nome do workspace (opcional)</label><input value={form.workspaceName} onChange={set('workspaceName')} placeholder="Minha empresa" /></div>
        <button className="btn lg" style={{ width: '100%' }} disabled={busy}>{busy ? 'Enviando…' : 'Criar conta'}</button>
      </form>
    </AuthShell>
  );
}
