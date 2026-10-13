import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';

type Integration = { id: string; name: string; enabled: boolean; keyPrefix: string | null; managedByCentral?: boolean; statusMap: Record<string, string>; planIds: string[]; utcOffsetMinutes: number; lastReceivedAt: string | null };
type Customer = { id: string; externalCustomerId: string; state: string; archivedAt: string | null; group: { name: string; _count: { cameras: number } }; user: { username: string; mustChangePassword: boolean } };
type Operation = { id: string; state: string; attempts: number; lastError: string | null; createdAt: string };
const stateName: Record<string, string> = { ACTIVE: 'Ativo', SUSPENDED: 'Suspenso', ARCHIVED: 'Arquivado', PENDING: 'Aguardando aplicação', COMPLETE: 'Concluído', IGNORED: 'Substituído ou antigo' };
const input = 'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm';
const button = 'min-h-11 rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50';

export default function IntegrationsPage() {
  const token = useAuthStore(s => s.accessToken);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('SGP');
  const [enabled, setEnabled] = useState(false);
  const [plans, setPlans] = useState('');
  const [offset, setOffset] = useState(-180);
  const [mapping, setMapping] = useState([{ name: 'ATIVO', state: 'ACTIVE' }]);
  const [key, setKey] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ label: string; action: () => Promise<void> } | null>(null);
  const [link, setLink] = useState({ externalCustomerId: '', cpf: '', groupId: '', userId: '' });
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string; username: string; role: string }>>([]);
  const request = useCallback(async (method: string, path: string, data?: unknown) => (await axios.request({ method, url: `${getApiBaseUrl()}/integrations/sgp${path}`, data, headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 })).data, [token]);
  const load = useCallback(async () => { setIntegrations(await request('GET', '')); }, [request]);
  const details = useCallback(async (id: string, next?: string) => {
    const [page, actions] = await Promise.all([request('GET', `/${id}/customers${next ? `?cursor=${encodeURIComponent(next)}` : ''}`), request('GET', `/${id}/operations`)]);
    setCustomers(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); setOperations(actions);
  }, [request]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (failure) { setError(axios.isAxiosError(failure) ? failure.response?.data?.error ?? 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load().catch(() => setError('Não foi possível carregar as integrações.')); }, [load]);
  useEffect(() => {
    if (!selected) { setCustomers([]); setOperations([]); return; }
    void details(selected).catch(() => setError('Não foi possível carregar os clientes.'));
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void details(selected).catch(() => undefined); }, 10_000);
    return () => clearInterval(timer);
  }, [selected, details]);
  function choose(id: string) {
    setSelected(id); setKey(''); setError(''); setMessage('');
    const value = integrations.find(item => item.id === id);
    setName(value?.name ?? 'SGP'); setEnabled(value?.enabled ?? false); setPlans(value?.planIds.join(', ') ?? ''); setOffset(value?.utcOffsetMinutes ?? -180);
    setMapping(value ? Object.entries(value.statusMap).map(([name, state]) => ({ name, state })) : [{ name: 'ATIVO', state: 'ACTIVE' }]);
  }
  async function save() {
    const names = mapping.map(row => row.name.trim().toUpperCase());
    if (names.some(value => !value) || new Set(names).size !== names.length) { setError('Preencha situações diferentes em cada linha.'); return; }
    await run(async () => {
      const result = await request(selected ? 'PATCH' : 'POST', selected ? `/${selected}` : '', { name, enabled, planIds: plans.split(',').map(value => value.trim()).filter(Boolean), utcOffsetMinutes: offset, statusMap: Object.fromEntries(mapping.map((row, index) => [names[index], row.state])) });
      await load(); setSelected(result.id); setMessage('Integração salva.');
    });
  }
  const base = new URL(getApiBaseUrl(), window.location.origin).href.replace(/\/$/, '');
  const centralManaged = integrations.find(value => value.id === selected)?.managedByCentral === true;
  return <div className="mx-auto max-w-6xl space-y-6 p-4 pb-12 text-foreground sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">Integrações</h1><p className="mt-2 text-sm text-muted-foreground">Conecte o SGP ao cadastro e à situação de acesso dos seus clientes.</p></div><a className={button} href="https://s2cam.com.br/developers/sgp" target="_blank" rel="noreferrer">Instruções da API para o SGP</a></header>
    {error && <p role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-border p-4 text-sm">{message}</p>}
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5"><label className="grid gap-2 text-sm">Integração SGP<select className={input} value={selected} onChange={e => choose(e.target.value)}><option value="">Criar integração</option>{integrations.map(value => <option key={value.id} value={value.id}>{value.name} · {value.enabled ? 'Ativada' : 'Desativada'}</option>)}</select></label>
      <form className="mt-5 space-y-5" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm">Nome<input className={input} value={name} required maxLength={80} onChange={e => setName(e.target.value)} /></label><label className="grid gap-2 text-sm">Planos do SGP permitidos<input className={input} value={plans} placeholder="IDs separados por vírgula" onChange={e => setPlans(e.target.value)} /><span className="text-xs text-muted-foreground">Vazio aceita todos os planos enviados por esta integração.</span></label></div>
        <div><h2 className="font-medium">Situações do SGP</h2><p className="mt-2 text-sm text-muted-foreground">Informe exatamente os nomes usados no SGP e escolha o que cada um faz aqui. Situações sem correspondência serão recusadas.</p><div className="mt-3 space-y-3">{mapping.map((row, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input aria-label={`Situação no SGP ${index + 1}`} className={input} value={row.name} required placeholder="Nome no SGP" onChange={e => setMapping(values => values.map((value, position) => position === index ? { ...value, name: e.target.value } : value))} /><select aria-label={`Ação no S2Cam ${index + 1}`} className={input} value={row.state} onChange={e => setMapping(values => values.map((value, position) => position === index ? { ...value, state: e.target.value } : value))}>{['ACTIVE', 'SUSPENDED', 'ARCHIVED'].map(value => <option key={value} value={value}>{stateName[value]}</option>)}</select><button type="button" className={button} disabled={mapping.length === 1} onClick={() => setMapping(values => values.filter((_, position) => index !== position))}>Remover</button></div>)}</div><button type="button" className={`${button} mt-3`} disabled={mapping.length >= 30} onClick={() => setMapping(values => [...values, { name: '', state: 'SUSPENDED' }])}>Adicionar situação</button></div>
        <label className="grid max-w-sm gap-2 text-sm">Fuso das datas enviadas pelo SGP<select className={input} value={offset} onChange={e => setOffset(Number(e.target.value))}>{[-300, -240, -180, -120, 0].map(value => <option key={value} value={value}>UTC{value < 0 ? '−' : '+'}{Math.abs(value / 60)}</option>)}</select></label>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Permitir que o SGP envie alterações para esta integração</label>
        <button className={`${button} bg-primary text-primary-foreground`} disabled={busy}>{busy ? 'Salvando…' : 'Salvar integração'}</button>
      </form>
    </section>
    {centralManaged && <p className="rounded-lg border border-border p-4 text-sm">Este token é gerenciado pela Central. Para gerar, substituir ou revogar, abra o cadastro desta instalação na Central. As situações do SGP e os planos permitidos continuam sendo configurados abaixo.</p>}
    {selected && <>
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-lg font-semibold">Chave e endereço</h2><p className="break-all rounded-lg bg-muted p-3 text-sm">{base}/integrations/v1/sgp/webhook</p><p className="text-sm text-muted-foreground">{integrations.find(value => value.id === selected)?.keyPrefix ? `Chave cadastrada, final …${integrations.find(value => value.id === selected)?.keyPrefix}.` : 'Nenhuma chave cadastrada.'} Gere a chave e entregue-a à equipe responsável pelo SGP.</p><div className="flex flex-wrap gap-3"><button disabled={busy || centralManaged} className={button} onClick={() => setConfirm({ label: 'Gerar uma nova chave? A chave anterior deixará de funcionar. Atualize-a também no SGP.', action: async () => { const value = await request('POST', `/${selected}/key`); setKey(value.key); await load(); } })}>Gerar nova chave</button><button disabled={busy || centralManaged} className={button} onClick={() => setConfirm({ label: 'Revogar a chave? O SGP deixará de enviar alterações até receber uma nova chave.', action: async () => { await request('DELETE', `/${selected}/key`); setKey(''); await load(); } })}>Revogar chave</button></div>{key && <div className="space-y-3 rounded-lg border border-primary/40 p-4"><p className="text-sm">Copie agora. Esta chave não será exibida novamente.</p><input className={input} value={key} readOnly aria-label="Nova chave da integração" autoComplete="off" /><button className={button} onClick={() => void navigator.clipboard.writeText(key).then(() => setMessage('Chave copiada.')).catch(() => setError('Selecione a chave e copie manualmente.'))}>Copiar chave</button><button className={`${button} ml-2`} onClick={() => setKey('')}>Ocultar</button></div>}</section>
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-lg font-semibold">Clientes vinculados</h2>{!customers.length && <p className="mt-3 text-sm text-muted-foreground">Os clientes aparecerão aqui quando o SGP enviar os cadastros.</p>}<div className="mt-4 grid gap-3">{customers.map(customer => <div key={customer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"><div><p className="font-medium">{customer.group.name}</p><p className="mt-1 text-sm text-muted-foreground">Cliente SGP {customer.externalCustomerId} · {stateName[customer.state]} · {customer.group._count.cameras} câmera(s)</p><p className="mt-1 text-xs text-muted-foreground">{customer.user.mustChangePassword ? 'Troca da senha inicial pendente' : 'Senha inicial já alterada'}</p></div><button className={button} disabled={busy} onClick={() => setConfirm({ label: customer.archivedAt ? 'Restaurar o vínculo? O acesso seguirá a última situação recebida do SGP.' : 'Arquivar este cliente? O acesso será bloqueado e as câmeras exclusivas serão pausadas. As gravações serão preservadas conforme a retenção.', action: async () => { await request(customer.archivedAt ? 'POST' : 'DELETE', `/${selected}/customers/${encodeURIComponent(customer.externalCustomerId)}${customer.archivedAt ? '/restore' : ''}`); await details(selected); } })}>{customer.archivedAt ? 'Restaurar vínculo' : 'Arquivar'}</button></div>)}</div>{cursor && <button disabled={busy} className={`${button} mt-4`} onClick={() => void run(() => details(selected, cursor))}>Carregar mais clientes</button>}</section>
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-lg font-semibold">Últimas solicitações</h2><p className="mt-2 text-sm text-muted-foreground">A confirmação só aparece depois que os serviços das câmeras são ajustados. A lista mostra as últimas 100 solicitações.</p><div className="mt-3 grid gap-3">{operations.map(operation => <div key={operation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="text-sm">{stateName[operation.state]} · {new Date(operation.createdAt).toLocaleString('pt-BR')}</p><p className="mt-1 break-all text-xs text-muted-foreground">{operation.id}</p>{operation.lastError && <p className="mt-2 text-sm text-muted-foreground">{operation.lastError}</p>}</div>{operation.state === 'PENDING' && <button disabled={busy} className={button} onClick={() => void run(async () => { await request('POST', `/${selected}/operations/${operation.id}/retry`); setMessage('Nova tentativa solicitada.'); })}>Tentar agora</button>}</div>)}</div></section>
      <details className="rounded-xl border border-border bg-card p-4 sm:p-5" onToggle={e => { if (!(e.currentTarget as HTMLDetailsElement).open || groups.length) return; void Promise.all([axios.get(`${getApiBaseUrl()}/camera-groups`, { headers: { Authorization: `Bearer ${token}` } }), axios.get(`${getApiBaseUrl()}/users`, { headers: { Authorization: `Bearer ${token}` } })]).then(([groupResult, userResult]) => { setGroups(groupResult.data); setUsers(userResult.data.filter((user: any) => user.role === 'VIEWER')); }).catch(() => setError('Não foi possível carregar grupos e usuários.')); }}><summary className="min-h-11 cursor-pointer font-medium">Vincular cadastro já existente</summary><p className="mt-3 text-sm text-muted-foreground">Use apenas para um cliente que já possui grupo e usuário de visualização com CPF. O usuário deve ter acesso exclusivo a esse grupo. O vínculo ficará suspenso até o SGP enviar um serviço ativo.</p><form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); setConfirm({ label: 'Confirma que este grupo e usuário pertencem ao cliente SGP informado? O acesso ficará suspenso até receber um serviço ativo.', action: async () => { await request('POST', `/${selected}/customers/link`, { ...link, confirm: true }); await details(selected); setMessage('Vínculo criado. Aguarde o cadastro do SGP.'); } }); }}><label className="grid gap-2 text-sm">ID do cliente no SGP<input className={input} required value={link.externalCustomerId} onChange={e => setLink(value => ({ ...value, externalCustomerId: e.target.value }))} /></label><label className="grid gap-2 text-sm">CPF do usuário<input className={input} required value={link.cpf} onChange={e => setLink(value => ({ ...value, cpf: e.target.value }))} /></label><label className="grid gap-2 text-sm">Grupo<select className={input} required value={link.groupId} onChange={e => setLink(value => ({ ...value, groupId: e.target.value }))}><option value="">Selecione</option>{groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label><label className="grid gap-2 text-sm">Usuário de visualização<select className={input} required value={link.userId} onChange={e => setLink(value => ({ ...value, userId: e.target.value }))}><option value="">Selecione</option>{users.map(user => <option value={user.id} key={user.id}>{user.name} · {user.username}</option>)}</select></label><button disabled={busy} className={button}>Vincular cadastro</button></form></details>
    </>}
    {confirm && <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="sgp-confirm-title"><div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"><h2 id="sgp-confirm-title" className="text-lg font-semibold">Confirmar alteração</h2><p className="mt-3 text-sm leading-6">{confirm.label}</p><div className="mt-5 flex flex-wrap justify-end gap-3"><button className={button} disabled={busy} onClick={() => setConfirm(null)}>Cancelar</button><button className={`${button} bg-primary text-primary-foreground`} disabled={busy} onClick={() => { const action = confirm.action; setConfirm(null); void run(action); }}>Confirmar</button></div></div></div>}
  </div>;
}
