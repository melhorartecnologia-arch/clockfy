import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Spinner, Alert, Modal, Confirm, Switch, SettingRow, Avatar } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { errorMessage, WEEKDAYS, WEEKDAY_LABELS } from '../lib/format.js';

export default function Profile() {
  const { user, userSettings, toast, refreshUser, logout } = useStore();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const fileRef = useRef(null);
  const timeZones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'America/Sao_Paulo']; } }, []);

  useEffect(() => { if (hash === '#api') setTimeout(() => document.getElementById('api')?.scrollIntoView({ behavior: 'smooth' }), 100); }, [hash]);
  useEffect(() => { setName(user.name); setEmail(user.email); }, [user.name, user.email]);

  async function saveProfile() {
    setBusy(true);
    try { await api.patch('/user', { name: name.trim(), email: email.trim().toLowerCase() }); await refreshUser(); toast('Perfil salvo', 'success'); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }
  async function savePref(patch, msg = 'Preferência salva') {
    try { await api.patch('/user/settings', patch); await refreshUser(); if (msg) toast(msg, 'success'); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/file/image', fd);
      await api.patch('/user', { profilePicture: r.url });
      await refreshUser(); toast('Foto atualizada', 'success');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function removePhoto() {
    try { await api.patch('/user', { profilePicture: null }); await refreshUser(); toast('Foto removida', 'success'); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function deleteAccount() {
    try { await api.delete('/user'); toast('Conta excluída'); logout(); navigate('/login'); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  const pref = (k) => userSettings[k];

  return (
    <div>
      <div className="page-header"><h1>Perfil e preferências</h1></div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Perfil</h3></div><div className="card-body">
            <div className="row gap mb">
              <Avatar user={user} size={64} />
              <div className="row gap wrap">
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />
                <button className="btn secondary sm" disabled={busy} onClick={() => fileRef.current?.click()}>Enviar foto</button>
                {user.profilePicture && <button className="btn ghost sm" onClick={removePhoto}>Remover</button>}
              </div>
            </div>
            <div className="field"><label>Nome</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label>E-mail</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="row"><button className="btn right" disabled={busy || !name.trim() || !email.trim()} onClick={saveProfile}>Salvar</button></div>
          </div></div>

          <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Preferências</h3></div><div className="card-body">
            <SettingRow title="Fuso horário" desc="Todas as datas e horas são exibidas neste fuso."><select style={{ width: 240 }} value={pref('timeZone') || 'UTC'} onChange={(e) => savePref({ timeZone: e.target.value })}>{timeZones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}</select></SettingRow>
            <SettingRow title="Início da semana"><select style={{ width: 200 }} value={pref('weekStart') || 'MONDAY'} onChange={(e) => savePref({ weekStart: e.target.value })}>{WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}</select></SettingRow>
            <SettingRow title="Formato de hora"><select style={{ width: 200 }} value={pref('timeFormat') || 'HOUR24'} onChange={(e) => savePref({ timeFormat: e.target.value })}><option value="HOUR24">24 horas (14:30)</option><option value="HOUR12">12 horas (2:30 PM)</option></select></SettingRow>
            <SettingRow title="Formato de data"><select style={{ width: 200 }} value={pref('dateFormat') || 'DD/MM/YYYY'} onChange={(e) => savePref({ dateFormat: e.target.value })}><option value="DD/MM/YYYY">DD/MM/AAAA</option><option value="MM/DD/YYYY">MM/DD/AAAA</option><option value="YYYY-MM-DD">AAAA-MM-DD</option></select></SettingRow>
            <SettingRow title="Idioma"><select style={{ width: 200 }} value={pref('lang') || 'PT_BR'} onChange={(e) => savePref({ lang: e.target.value })}><option value="PT_BR">Português (Brasil)</option><option value="EN">English</option><option value="ES">Español</option></select></SettingRow>
            <SettingRow title="Tema"><select style={{ width: 200 }} value={pref('theme') || 'DEFAULT'} onChange={(e) => savePref({ theme: e.target.value })}><option value="DEFAULT">Claro</option><option value="DARK">Escuro</option></select></SettingRow>
            <SettingRow title="Início do meu dia" desc="Horário padrão de início para registros manuais e na planilha de horas."><input type="time" value={pref('myStartOfDay') || '09:00'} onChange={(e) => e.target.value && savePref({ myStartOfDay: e.target.value })} style={{ width: 120 }} /></SettingRow>
            <SettingRow title="Agrupar registros semelhantes" desc="Registros com a mesma descrição, projeto e etiquetas aparecem agrupados no controle de tempo."><Switch value={!pref('groupSimilarEntriesDisabled')} onChange={(v) => savePref({ groupSimilarEntriesDisabled: !v })} /></SettingRow>
            <SettingRow title="Visualização compacta" desc="Menos espaçamento nas listas de registros."><Switch value={!!pref('isCompactViewOn')} onChange={(v) => savePref({ isCompactViewOn: v })} /></SettingRow>
            <SettingRow title="Alerta de timer longo" desc="Avisar quando um timer ficar rodando por mais de 8 horas."><Switch value={!!pref('longRunning')} onChange={(v) => savePref({ longRunning: v })} /></SettingRow>
          </div></div>

          <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Notificações por e-mail</h3></div><div className="card-body">
            <SettingRow title="Resumo semanal"><Switch value={!!pref('weeklyUpdates')} onChange={(v) => savePref({ weeklyUpdates: v })} /></SettingRow>
            <SettingRow title="Aprovações" desc="Quando planilhas forem enviadas, aprovadas ou rejeitadas."><Switch value={pref('approval') !== false} onChange={(v) => savePref({ approval: v })} /></SettingRow>
            <SettingRow title="Folgas" desc="Solicitações e decisões de folga."><Switch value={pref('pto') !== false} onChange={(v) => savePref({ pto: v })} /></SettingRow>
            <SettingRow title="Agenda" desc="Alterações nas suas alocações."><Switch value={pref('scheduling') !== false} onChange={(v) => savePref({ scheduling: v })} /></SettingRow>
            <SettingRow title="Alertas" desc="Alertas de projeto e horas."><Switch value={pref('alerts') !== false} onChange={(v) => savePref({ alerts: v })} /></SettingRow>
            <SettingRow title="Lembretes" desc="Lembretes para registrar horas."><Switch value={pref('reminders') !== false} onChange={(v) => savePref({ reminders: v })} /></SettingRow>
            <SettingRow title="Relatórios agendados"><Switch value={pref('scheduledReports') !== false} onChange={(v) => savePref({ scheduledReports: v })} /></SettingRow>
            <SettingRow title="Lembretes de faturas"><Switch value={pref('invoiceReminders') !== false} onChange={(v) => savePref({ invoiceReminders: v })} /></SettingRow>
            <SettingRow title="Novidades do produto"><Switch value={!!pref('sendNewsletter')} onChange={(v) => savePref({ sendNewsletter: v })} /></SettingRow>
          </div></div>
        </div>
        <div>
          <PasswordCard />
          <ApiKeysCard />
          <div className="card" style={{ borderColor: 'var(--danger)' }}><div className="card-head"><h3 style={{ margin: 0, color: 'var(--danger)' }}>Excluir conta</h3></div><div className="card-body">
            <p className="muted small">Sua conta será desativada permanentemente. Workspaces dos quais você é proprietário e que possuem outros membros precisam ter a propriedade transferida antes.</p>
            <button className="btn danger" onClick={() => setConfirm({ title: 'Excluir conta', danger: true, confirmLabel: 'Excluir minha conta', message: 'Tem certeza? Esta ação não pode ser desfeita.', onConfirm: deleteAccount })}>Excluir minha conta</button>
          </div></div>
        </div>
      </div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function PasswordCard() {
  const { toast } = useStore();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault();
    if (f.next.length < 6) { setError('A nova senha deve ter pelo menos 6 caracteres'); return; }
    if (f.next !== f.confirm) { setError('As senhas não conferem'); return; }
    setBusy(true); setError(null);
    try { await api.put('/auth/password', { currentPassword: f.current, newPassword: f.next }); toast('Senha alterada', 'success'); setF({ current: '', next: '', confirm: '' }); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Alterar senha</h3></div><form className="card-body" onSubmit={save}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Senha atual</label><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => set('current', e.target.value)} /></div>
      <div className="grid cols-2">
        <div className="field"><label>Nova senha</label><input type="password" autoComplete="new-password" value={f.next} onChange={(e) => set('next', e.target.value)} /></div>
        <div className="field"><label>Confirmar nova senha</label><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => set('confirm', e.target.value)} /></div>
      </div>
      <div className="row"><button className="btn right" disabled={busy || !f.next}>Alterar senha</button></div>
    </form></div>
  );
}

function ApiKeysCard() {
  const { toast } = useStore();
  const { data: keys, loading, reload } = useAsync(() => api.get('/auth/api-keys'), [], { initial: [] });
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const baseUrl = `${window.location.origin}/api/v1`;
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copiado', 'success')).catch(() => toast('Não foi possível copiar', 'error'));
  async function create() {
    setBusy(true);
    try { const k = await api.post('/auth/api-keys', { name: name.trim() || undefined }); setCreated(k); setName(''); reload(); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }
  const remove = (k) => setConfirm({ title: 'Revogar chave', danger: true, confirmLabel: 'Revogar', message: `Revogar a chave “${k.name}” (${k.prefix}…)? Integrações que a utilizam deixarão de funcionar.`, onConfirm: async () => { await api.delete(`/auth/api-keys/${k.id}`); toast('Chave revogada', 'success'); reload(); } });
  return (
    <div className="card" id="api"><div className="card-head"><h3 style={{ margin: 0 }}>Chaves de API</h3></div><div className="card-body">
      <p className="muted small">Use uma chave de API para integrar ferramentas externas. Envie-a no cabeçalho <span className="kbd">X-Api-Key</span> em requisições para <span className="kbd">{baseUrl}</span> – a API é compatível com a API pública do Clockify, então basta trocar a URL base nas integrações existentes.</p>
      <pre className="small" style={{ background: '#f5f7f8', padding: 10, borderRadius: 4, overflowX: 'auto' }}>{`curl -H "X-Api-Key: SUA_CHAVE" ${baseUrl}/user`}</pre>
      <div className="row gap mb"><input placeholder="Nome da chave (ex.: Integração Zapier)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /><button className="btn" disabled={busy} onClick={create}>Gerar chave</button></div>
      {loading && !keys?.length ? <Spinner /> : (keys || []).length === 0 ? <div className="light small">Nenhuma chave gerada.</div> : (
        <table className="table compact">
          <thead><tr><th>Nome</th><th>Prefixo</th><th>Criada em</th><th>Último uso</th><th /></tr></thead>
          <tbody>{keys.map((k) => <tr key={k.id}><td className="bold">{k.name}</td><td className="mono">{k.prefix}…</td><td className="small muted">{k.createdAt ? new Date(k.createdAt).toLocaleString('pt-BR') : '—'}</td><td className="small muted">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('pt-BR') : 'Nunca'}</td><td className="actions"><button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => remove(k)}>Revogar</button></td></tr>)}</tbody>
        </table>
      )}
      {created && (
        <Modal title="Chave de API gerada" size="sm" onClose={() => setCreated(null)} footer={<button className="btn" onClick={() => setCreated(null)}>Fechar</button>}>
          <Alert type="warning">Copie a chave agora – por segurança ela não será exibida novamente.</Alert>
          <div className="row gap"><input readOnly value={created.apiKey} onFocus={(e) => e.target.select()} className="mono" /><button className="btn secondary sm" onClick={() => copy(created.apiKey)}>Copiar</button></div>
          <p className="small muted mt">Exemplo: <span className="kbd">curl -H "X-Api-Key: {created.apiKey.slice(0, 6)}…" {baseUrl}/workspaces</span></p>
        </Modal>
      )}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div></div>
  );
}
