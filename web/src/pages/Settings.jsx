import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Tabs, Switch, SettingRow } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { fmtDuration, isoToSeconds, secondsToIso, parseDuration, errorMessage, WEEKDAYS, WEEKDAY_LABELS } from '../lib/format.js';

const TABS = [
  { value: 'general', label: 'Geral' }, { value: 'permissions', label: 'Permissões' }, { value: 'required', label: 'Campos obrigatórios' },
  { value: 'lock', label: 'Bloqueio de horas' }, { value: 'rounding', label: 'Arredondamento' }, { value: 'custom-fields', label: 'Campos personalizados' },
  { value: 'features', label: 'Funcionalidades' }, { value: 'danger', label: 'Zona de perigo' },
];
const centsToInput = (c) => (c == null ? '' : (Number(c) / 100).toFixed(2));
const inputToCents = (s) => { const n = parseFloat(String(s).replace(',', '.')); return Number.isNaN(n) ? null : Math.round(n * 100); };

export default function Settings() {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const tab = TABS.some((t) => t.value === sub) ? sub : 'general';
  const { workspace, settings, isAdmin, toast, refreshWorkspace } = useStore();
  const wsId = workspace?.id;
  const [saving, setSaving] = useState(false);

  // Saves a partial settings object and refreshes the workspace in the store
  async function save(patch, msg = 'Configuração salva') {
    setSaving(true);
    try { await api.put(`${ws(wsId)}/settings`, patch); await refreshWorkspace(); invalidateCache(wsId); if (msg) toast(msg, 'success'); } catch (e) { toast(errorMessage(e), 'error'); } finally { setSaving(false); }
  }

  if (!isAdmin) return <div className="card"><Empty icon="⚙" title="Somente administradores">As configurações do workspace só podem ser alteradas por administradores.</Empty></div>;
  const props = { settings, save, saving, workspace };
  return (
    <div>
      <div className="page-header"><h1>Configurações do workspace</h1>{saving && <Spinner />}</div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/settings/${t}`)} />
      {tab === 'general' && <GeneralTab {...props} />}
      {tab === 'permissions' && <PermissionsTab {...props} />}
      {tab === 'required' && <RequiredTab {...props} />}
      {tab === 'lock' && <LockTab {...props} />}
      {tab === 'rounding' && <RoundingTab {...props} />}
      {tab === 'custom-fields' && <CustomFieldsTab {...props} />}
      {tab === 'features' && <FeaturesTab {...props} />}
      {tab === 'danger' && <DangerTab {...props} />}
    </div>
  );
}

// Small helper: text input that saves on blur/Enter
function SaveInput({ value, onSave, type = 'text', style, ...rest }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return <input type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== (value ?? '') && onSave(v)} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} style={{ width: 200, ...style }} {...rest} />;
}

// ---------------------------------------------------------------- Geral
function GeneralTab({ settings, save, workspace }) {
  const { toast, refreshWorkspace } = useStore();
  const wsId = workspace.id;
  const { data: currencies, reload: reloadCurrencies } = useAsync(() => api.get(`${ws(wsId)}/currencies`), [wsId], { initial: [] });
  const [newCurrency, setNewCurrency] = useState('');
  const [capacity, setCapacity] = useState(fmtDuration(isoToSeconds(settings.workCapacity || 'PT8H'), { seconds: false }));
  useEffect(() => setCapacity(fmtDuration(isoToSeconds(settings.workCapacity || 'PT8H'), { seconds: false })), [settings.workCapacity]);

  async function run(fn, msg) { try { await fn(); await refreshWorkspace(); reloadCurrencies(); if (msg) toast(msg, 'success'); } catch (e) { toast(errorMessage(e), 'error'); } }
  const addCurrency = () => { const code = newCurrency.trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(code)) { toast('Informe um código ISO de 3 letras (ex.: BRL)', 'error'); return; } run(() => api.post(`${ws(wsId)}/currencies`, { code }).then(() => setNewCurrency('')), 'Moeda adicionada'); };
  const setDefault = (c) => run(() => api.put(`${ws(wsId)}/hourly-rate`, { amount: workspace.hourlyRate?.amount || 0, currency: c.code }), `Moeda padrão: ${c.code}`);
  const removeCurrency = (c) => run(() => api.delete(`${ws(wsId)}/currencies/${c.id}`), 'Moeda removida');
  const saveRate = (kind, v) => { const cents = inputToCents(v); if (cents == null || cents < 0) { toast('Valor inválido', 'error'); return; } run(() => api.put(`${ws(wsId)}/${kind}`, { amount: cents }), 'Taxa salva'); };
  const saveCapacity = () => { const s = parseDuration(capacity); if (s == null) { toast('Capacidade inválida', 'error'); return; } save({ workCapacity: secondsToIso(s) }); };
  const cur = workspace.hourlyRate?.currency || 'USD';

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Workspace</h3></div><div className="card-body">
          <SettingRow title="Nome do workspace"><SaveInput value={workspace.name} onSave={(v) => v.trim() && run(() => api.put(`${ws(wsId)}`, { name: v.trim() }), 'Nome salvo')} /></SettingRow>
          <SettingRow title="Taxa horária padrão" desc="Usada quando projeto, tarefa e membro não definem uma taxa."><span className="row gap"><SaveInput type="number" step="0.01" min="0" value={centsToInput(workspace.hourlyRate?.amount)} onSave={(v) => saveRate('hourly-rate', v)} style={{ width: 120 }} /><span className="muted">{cur}</span></span></SettingRow>
          <SettingRow title="Custo por hora padrão" desc="Usado para calcular custo e lucro."><span className="row gap"><SaveInput type="number" step="0.01" min="0" value={centsToInput(workspace.costRate?.amount)} onSave={(v) => saveRate('cost-rate', v)} style={{ width: 120 }} /><span className="muted">{cur}</span></span></SettingRow>
        </div></div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Moedas</h3></div><div className="card-body">
          <table className="table compact"><tbody>
            {(currencies || []).map((c) => <tr key={c.id}><td className="bold">{c.code}</td><td>{c.isDefault && <span className="badge primary">Padrão</span>}</td><td className="actions">{!c.isDefault && <><button className="btn ghost sm" onClick={() => setDefault(c)}>Tornar padrão</button><button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => removeCurrency(c)}>Remover</button></>}</td></tr>)}
          </tbody></table>
          <div className="row gap mt"><input placeholder="Código ISO (ex.: BRL)" value={newCurrency} maxLength={3} onChange={(e) => setNewCurrency(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && addCurrency()} style={{ width: 160 }} /><button className="btn secondary sm" onClick={addCurrency}>Adicionar moeda</button></div>
          <p className="small muted mt">Clientes podem usar moedas diferentes da padrão em faturas e taxas.</p>
        </div></div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Formatos</h3></div><div className="card-body">
          <SettingRow title="Formato de duração"><select style={{ width: 200 }} value={settings.durationFormat || 'FULL'} onChange={(e) => save({ durationFormat: e.target.value })}><option value="FULL">Completo (12:05:30)</option><option value="COMPACT">Compacto (12:05)</option><option value="DECIMAL">Decimal (12,09)</option></select></SettingRow>
          <SettingRow title="Formato de número"><select style={{ width: 200 }} value={settings.numberFormat || 'COMMA_PERIOD'} onChange={(e) => save({ numberFormat: e.target.value })}><option value="COMMA_PERIOD">1,234.56</option><option value="PERIOD_COMMA">1.234,56</option><option value="SPACE_COMMA">1 234,56</option></select></SettingRow>
          <SettingRow title="Formato de moeda"><select style={{ width: 200 }} value={settings.currencyFormat || 'CURRENCY_SPACE_VALUE'} onChange={(e) => save({ currencyFormat: e.target.value })}><option value="CURRENCY_SPACE_VALUE">R$ 1.234,56</option><option value="VALUE_SPACE_CURRENCY">1.234,56 R$</option><option value="CURRENCY_VALUE">R$1.234,56</option><option value="VALUE_CURRENCY">1.234,56R$</option></select></SettingRow>
        </div></div>
      </div>
      <div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Dias úteis e capacidade</h3></div><div className="card-body">
          <SettingRow title="Dias úteis" desc="Usados em relatórios de presença, agenda e folgas.">
            <div className="row gap wrap">{WEEKDAYS.map((d) => { const on = (settings.workingDays || []).includes(d); return <label key={d} className="checkbox"><input type="checkbox" checked={on} onChange={(e) => save({ workingDays: e.target.checked ? [...(settings.workingDays || []), d] : (settings.workingDays || []).filter((x) => x !== d) })} />{WEEKDAY_LABELS[d].slice(0, 3)}</label>; })}</div>
          </SettingRow>
          <SettingRow title="Capacidade diária" desc="Horas esperadas por dia útil (ex.: 8h)."><span className="row gap"><input value={capacity} onChange={(e) => setCapacity(e.target.value)} onBlur={saveCapacity} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} style={{ width: 100 }} /></span></SettingRow>
        </div></div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Rótulos</h3></div><div className="card-body">
          <SettingRow title="Rótulo de projeto" desc="Como “projeto” aparece na interface (ex.: “Caso”, “Cliente”)."><SaveInput value={settings.projectLabel || 'project'} onSave={(v) => save({ projectLabel: v.trim() || 'project' })} /></SettingRow>
          <SettingRow title="Rótulo de tarefa"><SaveInput value={settings.taskLabel || 'task'} onSave={(v) => save({ taskLabel: v.trim() || 'task' })} /></SettingRow>
          <SettingRow title="Rótulo de agrupamento" desc="Como os projetos são agrupados no seletor (padrão: cliente)."><SaveInput value={settings.projectGroupingLabel || 'client'} onSave={(v) => save({ projectGroupingLabel: v.trim() || 'client' })} /></SettingRow>
        </div></div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Registro de tempo</h3></div><div className="card-body">
          <SettingRow title="Modo de registro" desc="No modo somente cronômetro, membros não podem adicionar ou editar horas manualmente."><select style={{ width: 220 }} value={settings.timeTrackingMode || 'DEFAULT'} onChange={(e) => save({ timeTrackingMode: e.target.value })}><option value="DEFAULT">Padrão (timer e manual)</option><option value="STOPWATCH_ONLY">Somente cronômetro</option></select></SettingRow>
          <SettingRow title="Projetos públicos por padrão" desc="Novos projetos ficam visíveis para todos os membros."><Switch value={settings.isProjectPublicByDefault !== false} onChange={(v) => save({ isProjectPublicByDefault: v })} /></SettingRow>
          <SettingRow title="Faturável por padrão" desc="Novos projetos são criados como faturáveis."><Switch value={settings.defaultBillableProjects !== false} onChange={(v) => save({ defaultBillableProjects: v })} /></SettingRow>
          <SettingRow title="Registrar até o segundo" desc="Desligado: durações arredondadas ao minuto na interface."><Switch value={settings.trackTimeDownToSecond !== false} onChange={(v) => save({ trackTimeDownToSecond: v })} /></SettingRow>
        </div></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Permissões
function PermissionsTab({ settings, save }) {
  const ecp = settings.entityCreationPermissions || {};
  const setEcp = (k, v) => save({ entityCreationPermissions: { ...ecp, [k]: v }, ...(k === 'whoCanCreateProjectsAndClients' ? { onlyAdminsCreateProject: v !== 'EVERYONE' } : k === 'whoCanCreateTags' ? { onlyAdminsCreateTag: v !== 'EVERYONE' } : { onlyAdminsCreateTask: v !== 'EVERYONE' }) });
  const pages = new Set(settings.adminOnlyPages || []);
  const togglePage = (p, on) => { const s = new Set(pages); if (on) s.add(p); else s.delete(p); save({ adminOnlyPages: [...s] }); };
  const Who = ({ value, onChange }) => <select style={{ width: 200 }} value={value} onChange={(e) => onChange(e.target.value)}><option value="ADMINS">Somente administradores</option><option value="EVERYONE">Todos</option></select>;
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Quem pode criar</h3></div><div className="card-body">
        <SettingRow title="Projetos e clientes"><Who value={ecp.whoCanCreateProjectsAndClients || (settings.onlyAdminsCreateProject === false ? 'EVERYONE' : 'ADMINS')} onChange={(v) => setEcp('whoCanCreateProjectsAndClients', v)} /></SettingRow>
        <SettingRow title="Etiquetas"><Who value={ecp.whoCanCreateTags || (settings.onlyAdminsCreateTag === false ? 'EVERYONE' : 'ADMINS')} onChange={(v) => setEcp('whoCanCreateTags', v)} /></SettingRow>
        <SettingRow title="Tarefas" desc="Gerentes de projeto sempre podem criar tarefas em seus projetos."><Who value={ecp.whoCanCreateTasks || (settings.onlyAdminsCreateTask === false ? 'EVERYONE' : 'ADMINS')} onChange={(v) => setEcp('whoCanCreateTasks', v)} /></SettingRow>
        <SettingRow title="Alterar status faturável" desc="Ligado: somente administradores podem marcar registros como faturáveis."><Switch value={!!settings.onlyAdminsCanChangeBillableStatus} onChange={(v) => save({ onlyAdminsCanChangeBillableStatus: v })} /></SettingRow>
      </div></div>
      <div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Quem pode ver</h3></div><div className="card-body">
          <SettingRow title="Taxas e valores" desc="Ligado: somente administradores (e gerentes de projeto em seus projetos) veem taxas horárias, custos e valores."><Switch value={settings.onlyAdminsSeeBillableRates !== false} onChange={(v) => save({ onlyAdminsSeeBillableRates: v })} /></SettingRow>
          <SettingRow title="Todos os registros de tempo" desc="Ligado: membros veem apenas os próprios registros nos relatórios."><Switch value={!!settings.onlyAdminsSeeAllTimeEntries} onChange={(v) => save({ onlyAdminsSeeAllTimeEntries: v })} /></SettingRow>
          <SettingRow title="Registros de projetos públicos" desc="Ligado: membros não veem registros de outras pessoas em projetos públicos."><Switch value={!!settings.onlyAdminsSeePublicProjectsEntries} onChange={(v) => save({ onlyAdminsSeePublicProjectsEntries: v })} /></SettingRow>
          <SettingRow title="Painel" desc="Ligado: o painel fica disponível apenas para administradores."><Switch value={!!settings.onlyAdminsSeeDashboard} onChange={(v) => save({ onlyAdminsSeeDashboard: v })} /></SettingRow>
          <SettingRow title="Planilha de horas" desc="Membros podem usar a planilha de horas."><Switch value={settings.canSeeTimeSheet !== false} onChange={(v) => save({ canSeeTimeSheet: v })} /></SettingRow>
          <SettingRow title="Controle de tempo" desc="Membros podem usar a página de controle de tempo."><Switch value={settings.canSeeTracker !== false} onChange={(v) => save({ canSeeTracker: v })} /></SettingRow>
        </div></div>
        <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Páginas somente para administradores</h3></div><div className="card-body">
          {[['PROJECT', 'Projetos'], ['TEAM', 'Equipe'], ['REPORTS', 'Relatórios'], ['CLIENT', 'Clientes'], ['TAG', 'Etiquetas']].map(([k, label]) => <SettingRow key={k} title={label}><Switch value={pages.has(k)} onChange={(v) => togglePage(k, v)} /></SettingRow>)}
        </div></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Campos obrigatórios
function RequiredTab({ settings, save }) {
  return (
    <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Campos obrigatórios nos registros de tempo</h3></div><div className="card-body">
      <p className="muted small">Quando obrigatório, o timer não pode ser iniciado nem o registro salvo sem preencher o campo.</p>
      <SettingRow title="Projeto obrigatório" desc="Todo registro precisa ter um projeto."><Switch value={!!settings.forceProjects} onChange={(v) => save({ forceProjects: v })} /></SettingRow>
      <SettingRow title="Tarefa obrigatória" desc="Todo registro precisa ter uma tarefa."><Switch value={!!settings.forceTasks} onChange={(v) => save({ forceTasks: v })} /></SettingRow>
      <SettingRow title="Etiqueta obrigatória" desc="Todo registro precisa ter ao menos uma etiqueta."><Switch value={!!settings.forceTags} onChange={(v) => save({ forceTags: v })} /></SettingRow>
      <SettingRow title="Descrição obrigatória" desc="Todo registro precisa ter uma descrição."><Switch value={!!settings.forceDescription} onChange={(v) => save({ forceDescription: v })} /></SettingRow>
    </div></div>
  );
}

// ---------------------------------------------------------------- Bloqueio
function LockTab({ settings, save }) {
  const lock = settings.lockTimeEntries ? String(settings.lockTimeEntries).slice(0, 10) : '';
  const auto = settings.automaticLock || null;
  const [a, setA] = useState(auto || { type: 'WEEKLY', firstDay: 'MONDAY', dayOfMonth: 1, olderThanValue: 1, olderThanPeriod: 'MONTHS' });
  useEffect(() => { if (auto) setA(auto); }, [auto]);
  const setAuto = (patch) => { const next = { ...a, ...patch }; setA(next); save({ automaticLock: next }); };
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Bloqueio manual</h3></div><div className="card-body">
        <p className="muted small">Registros anteriores à data informada não podem ser criados, editados ou excluídos por membros (administradores continuam podendo).</p>
        <SettingRow title="Bloquear registros anteriores a"><span className="row gap"><input type="date" value={lock} onChange={(e) => save({ lockTimeEntries: e.target.value ? `${e.target.value}T00:00:00Z` : null }, e.target.value ? 'Bloqueio definido' : 'Bloqueio removido')} style={{ width: 160 }} />{lock && <button className="btn ghost sm" onClick={() => save({ lockTimeEntries: null }, 'Bloqueio removido')}>Limpar</button>}</span></SettingRow>
      </div></div>
      <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Bloqueio automático</h3><span className="right"><Switch value={!!auto} onChange={(v) => save({ automaticLock: v ? a : null }, v ? 'Bloqueio automático ativado' : 'Bloqueio automático desativado')} /></span></div><div className="card-body">
        <p className="muted small">A data de bloqueio avança automaticamente conforme a regra abaixo.</p>
        <SettingRow title="Regra"><select style={{ width: 220 }} value={a.type} onChange={(e) => setAuto({ type: e.target.value })} disabled={!auto}><option value="WEEKLY">Semanalmente</option><option value="MONTHLY">Mensalmente</option><option value="OLDER_THAN">Mais antigos que…</option></select></SettingRow>
        {a.type === 'WEEKLY' && <SettingRow title="Bloquear a semana anterior no dia"><select style={{ width: 220 }} value={a.firstDay || 'MONDAY'} onChange={(e) => setAuto({ firstDay: e.target.value })} disabled={!auto}>{WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}</select></SettingRow>}
        {a.type === 'MONTHLY' && <SettingRow title="Bloquear o mês anterior no dia"><input type="number" min="1" max="28" value={a.dayOfMonth || 1} onChange={(e) => setAuto({ dayOfMonth: Number(e.target.value) || 1 })} disabled={!auto} style={{ width: 100 }} /></SettingRow>}
        {a.type === 'OLDER_THAN' && <SettingRow title="Bloquear registros mais antigos que"><span className="row gap"><input type="number" min="1" value={a.olderThanValue || 1} onChange={(e) => setAuto({ olderThanValue: Number(e.target.value) || 1 })} disabled={!auto} style={{ width: 80 }} /><select style={{ width: 130 }} value={a.olderThanPeriod || 'MONTHS'} onChange={(e) => setAuto({ olderThanPeriod: e.target.value })} disabled={!auto}><option value="DAYS">dias</option><option value="WEEKS">semanas</option><option value="MONTHS">meses</option></select></span></SettingRow>}
      </div></div>
    </div>
  );
}

// ---------------------------------------------------------------- Arredondamento
function RoundingTab({ settings, save }) {
  const r = settings.round || { round: 'Round to nearest', minutes: '15' };
  return (
    <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Arredondamento de horas</h3></div><div className="card-body">
      <p className="muted small">O arredondamento é aplicado nos relatórios (e opcionalmente em faturas), sem alterar os registros originais.</p>
      <SettingRow title="Arredondar durações nos relatórios"><Switch value={!!settings.timeRoundingInReports} onChange={(v) => save({ timeRoundingInReports: v })} /></SettingRow>
      <SettingRow title="Modo"><select style={{ width: 220 }} value={r.round} onChange={(e) => save({ round: { ...r, round: e.target.value } })}><option value="Round to nearest">Para o mais próximo</option><option value="Round up to">Para cima</option><option value="Round down to">Para baixo</option></select></SettingRow>
      <SettingRow title="Intervalo (minutos)"><select style={{ width: 220 }} value={String(r.minutes)} onChange={(e) => save({ round: { ...r, minutes: e.target.value } })}>{['1', '5', '6', '10', '12', '15', '30', '60'].map((m) => <option key={m} value={m}>{m} min</option>)}</select></SettingRow>
    </div></div>
  );
}

// ---------------------------------------------------------------- Campos personalizados
const CF_TYPES = { TXT: 'Texto', NUMBER: 'Número', DROPDOWN_SINGLE: 'Lista (seleção única)', DROPDOWN_MULTIPLE: 'Lista (seleção múltipla)', CHECKBOX: 'Caixa de seleção', LINK: 'Link' };
function CustomFieldsTab({ workspace }) {
  const { toast } = useStore();
  const wsId = workspace.id;
  const { data: fields, loading, reload } = useAsync(() => endpoints.customFields(wsId), [wsId], { initial: [] });
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const remove = (cf) => setConfirm({ title: 'Excluir campo', danger: true, confirmLabel: 'Excluir', message: `Excluir o campo “${cf.name}” e todos os seus valores?`, onConfirm: async () => { try { await api.delete(`${ws(wsId)}/custom-fields/${cf.id}`); toast('Campo excluído', 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); } } });
  const setStatus = async (cf, status) => { try { await api.put(`${ws(wsId)}/custom-fields/${cf.id}`, { status }); reload(); } catch (e) { toast(errorMessage(e), 'error'); } };
  return (
    <div className="card">
      <div className="filter-bar"><span className="muted small">Campos adicionais em registros de tempo ou perfis de usuário.</span><button className="btn right" onClick={() => setEditing({})}>+ Criar campo</button></div>
      {loading && !fields?.length ? <Spinner block /> : (fields || []).length === 0 ? <Empty icon="⌗" title="Nenhum campo personalizado">Crie campos para capturar informações extras, como número do chamado ou centro de custo.</Empty> : (
        <table className="table">
          <thead><tr><th>Nome</th><th>Tipo</th><th>Entidade</th><th>Obrigatório</th><th>Somente admin edita</th><th>Status</th><th /></tr></thead>
          <tbody>{(fields || []).map((cf) => (
            <tr key={cf.id}>
              <td><div className="bold">{cf.name}</div>{cf.description && <div className="small muted">{cf.description}</div>}</td>
              <td>{CF_TYPES[cf.type] || cf.type}{cf.allowedValues?.length > 0 && <div className="small light truncate" style={{ maxWidth: 240 }}>{cf.allowedValues.join(', ')}</div>}</td>
              <td>{cf.entityType === 'USER' ? 'Usuário' : 'Registro de tempo'}</td>
              <td>{cf.required ? 'Sim' : '—'}</td>
              <td>{cf.onlyAdminCanEdit ? 'Sim' : '—'}</td>
              <td><select style={{ width: 'auto' }} value={cf.status} onChange={(e) => setStatus(cf, e.target.value)}><option value="VISIBLE">Visível</option><option value="INVISIBLE">Invisível</option><option value="INACTIVE">Inativo</option></select></td>
              <td className="actions"><Dropdown><button onClick={() => setEditing(cf)}>Editar</button><hr /><button className="danger" onClick={() => remove(cf)}>Excluir</button></Dropdown></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {editing && <CustomFieldModal field={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function CustomFieldModal({ field, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [f, setF] = useState({ name: field?.name || '', type: field?.type || 'TXT', entityType: field?.entityType || 'TIMEENTRY', placeholder: field?.placeholder || '', description: field?.description || '', allowedValues: (field?.allowedValues || []).join('\n'), required: !!field?.required, onlyAdminCanEdit: !!field?.onlyAdminCanEdit, status: field?.status || 'VISIBLE', defaultValue: field?.workspaceDefaultValue == null ? '' : (Array.isArray(field.workspaceDefaultValue) ? field.workspaceDefaultValue.join(', ') : String(field.workspaceDefaultValue)) });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const isList = f.type === 'DROPDOWN_SINGLE' || f.type === 'DROPDOWN_MULTIPLE';
  async function save() {
    if (!f.name.trim()) { setError('Informe o nome'); return; }
    setBusy(true); setError(null);
    try {
      let def = f.defaultValue.trim();
      if (def === '') def = null; else if (f.type === 'NUMBER') def = Number(def); else if (f.type === 'CHECKBOX') def = ['true', '1', 'sim'].includes(def.toLowerCase()); else if (f.type === 'DROPDOWN_MULTIPLE') def = def.split(',').map((s) => s.trim()).filter(Boolean);
      const body = { name: f.name.trim(), type: f.type, entityType: f.entityType, placeholder: f.placeholder || null, description: f.description || null, allowedValues: isList ? f.allowedValues.split('\n').map((s) => s.trim()).filter(Boolean) : [], required: f.required, onlyAdminCanEdit: f.onlyAdminCanEdit, status: f.status, workspaceDefaultValue: def };
      if (field) await api.put(`${ws(workspace.id)}/custom-fields/${field.id}`, body); else await api.post(`${ws(workspace.id)}/custom-fields`, body);
      toast(field ? 'Campo salvo' : 'Campo criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={field ? 'Editar campo personalizado' : 'Criar campo personalizado'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{field ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2">
        <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label>Tipo</label><select value={f.type} onChange={(e) => set('type', e.target.value)} disabled={!!field}>{Object.entries(CF_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Entidade</label><select value={f.entityType} onChange={(e) => set('entityType', e.target.value)} disabled={!!field}><option value="TIMEENTRY">Registro de tempo</option><option value="USER">Usuário (perfil do membro)</option></select></div>
        <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="VISIBLE">Visível</option><option value="INVISIBLE">Invisível</option><option value="INACTIVE">Inativo</option></select></div>
      </div>
      {isList && <div className="field"><label>Valores permitidos (um por linha)</label><textarea value={f.allowedValues} onChange={(e) => set('allowedValues', e.target.value)} /></div>}
      <div className="grid cols-2">
        <div className="field"><label>Placeholder</label><input value={f.placeholder} onChange={(e) => set('placeholder', e.target.value)} /></div>
        <div className="field"><label>Valor padrão{f.type === 'DROPDOWN_MULTIPLE' ? ' (separado por vírgula)' : f.type === 'CHECKBOX' ? ' (true/false)' : ''}</label><input value={f.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} /></div>
      </div>
      <div className="field"><label>Descrição</label><input value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
      <div className="row gap wrap">
        <label className="checkbox"><input type="checkbox" checked={f.required} onChange={(e) => set('required', e.target.checked)} /> Obrigatório</label>
        <label className="checkbox"><input type="checkbox" checked={f.onlyAdminCanEdit} onChange={(e) => set('onlyAdminCanEdit', e.target.checked)} /> Somente administradores editam</label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Funcionalidades
function FeaturesTab({ settings, save }) {
  const F = [
    ['approvalsEnabled', 'Aprovações', 'Membros enviam planilhas semanais/mensais para aprovação de gerentes.'],
    ['timeOffEnabled', 'Folgas', 'Políticas de folga, saldos e solicitações.'],
    ['schedulingEnabled', 'Agenda', 'Planejamento de alocação de pessoas em projetos.'],
    ['expensesEnabled', 'Despesas', 'Registro de despesas por projeto com recibos.'],
    ['invoicingEnabled', 'Faturas', 'Geração de faturas a partir de horas e despesas.'],
    ['breaks', 'Pausas', 'Permite registrar pausas no controle de tempo.'],
    ['favoriteEntries', 'Registros favoritos', 'Membros podem salvar combinações favoritas para iniciar rapidamente.'],
    ['projectFavorites', 'Projetos favoritos', 'Projetos favoritos aparecem no topo do seletor.'],
    ['kioskPinRequired', 'PIN obrigatório no quiosque', 'Exige PIN para registrar entrada/saída no modo quiosque.'],
    ['activeBillableHours', 'Horas faturáveis ativas', 'Considera apenas horas faturáveis nos totais de capacidade.'],
  ];
  return (
    <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Funcionalidades do workspace</h3></div><div className="card-body">
      {F.map(([k, title, desc]) => <SettingRow key={k} title={title} desc={desc}><Switch value={k === 'activeBillableHours' ? !!settings[k] : settings[k] !== false} onChange={(v) => save({ [k]: v })} /></SettingRow>)}
    </div></div>
  );
}

// ---------------------------------------------------------------- Zona de perigo
function DangerTab({ workspace }) {
  const { isOwner, toast, workspaces, switchWorkspace, refreshWorkspace, setWorkspaces } = useStore();
  const navigate = useNavigate();
  const wsId = workspace.id;
  const { data: users } = useAsync(() => endpoints.users(wsId), [wsId], { initial: [] });
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [typed, setTyped] = useState('');
  async function transfer() {
    try { await api.put(`${ws(wsId)}/transfer-ownership`, { userId: target }); await refreshWorkspace(); toast('Propriedade transferida', 'success'); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function remove() {
    try {
      await api.delete(`${ws(wsId)}`);
      const rest = workspaces.filter((w) => w.id !== wsId);
      setWorkspaces(rest);
      toast('Workspace excluído', 'success');
      if (rest[0]) { await switchWorkspace(rest[0].id); navigate('/tracker'); } else { window.location.reload(); }
    } catch (e) { toast(errorMessage(e), 'error'); }
  }
  if (!isOwner) return <div className="card"><Empty icon="⚠" title="Somente o proprietário">Apenas o proprietário do workspace pode transferir a propriedade ou excluir o workspace.</Empty></div>;
  const others = (users || []).filter((u) => u.id !== workspace.ownerId);
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card"><div className="card-head"><h3 style={{ margin: 0 }}>Transferir propriedade</h3></div><div className="card-body">
        <p className="muted small">O novo proprietário terá controle total. Você continuará como administrador.</p>
        <div className="row gap"><select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Selecione um membro ativo…</option>{others.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select><button className="btn secondary" disabled={!target} onClick={() => setConfirm({ title: 'Transferir propriedade', danger: true, confirmLabel: 'Transferir', message: 'Confirmar a transferência de propriedade do workspace? Esta ação não pode ser desfeita por você.', onConfirm: transfer })}>Transferir</button></div>
      </div></div>
      <div className="card" style={{ borderColor: 'var(--danger)' }}><div className="card-head"><h3 style={{ margin: 0, color: 'var(--danger)' }}>Excluir workspace</h3></div><div className="card-body">
        <p className="muted small">Todos os projetos, registros de tempo, relatórios, faturas e membros serão removidos permanentemente. Esta ação não pode ser desfeita.</p>
        <div className="field"><label>Digite o nome do workspace (“{workspace.name}”) para confirmar</label><input value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
        <button className="btn danger" disabled={typed !== workspace.name} onClick={() => setConfirm({ title: 'Excluir workspace', danger: true, confirmLabel: 'Excluir permanentemente', message: `Excluir o workspace “${workspace.name}” e todos os seus dados?`, onConfirm: remove })}>Excluir workspace</button>
      </div></div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

