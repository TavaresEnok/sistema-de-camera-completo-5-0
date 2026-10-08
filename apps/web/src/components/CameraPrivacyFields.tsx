import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Switch } from './ui/switch';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { type CameraPrivacyForm } from '../lib/camera-privacy';

type PrivacyUser = { id: string; name: string; username: string | null };

/** Minimal, identical privacy controls in RTSP, RTMP and editing. */
export function CameraPrivacyFields({ value, onChange }: { value: CameraPrivacyForm; onChange: (value: CameraPrivacyForm) => void }) {
  const fieldId = useId();
  const accessToken = useAuthStore(s => s.accessToken);
  const userId = useAuthStore(s => s.user?.id);
  const [search, setSearch] = useState('');
  const { data: users = [], isPending, isError, refetch } = useQuery({
    queryKey: ['camera-privacy-users', getApiBaseUrl(), userId],
    enabled: value.isPrivate && Boolean(accessToken), staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const { data } = await axios.get<PrivacyUser[]>(`${getApiBaseUrl()}/cameras/privacy-users`, { signal, headers: { Authorization: `Bearer ${accessToken}` } });
      return data;
    },
  });
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const visible = users.filter(user => user.id !== value.ownerUserId && (!term || `${user.name} ${user.username ?? ''}`.toLocaleLowerCase('pt-BR').includes(term)));
  const unavailable = value.privateViewerIds.filter(id => id !== value.ownerUserId && !users.some(user => user.id === id));
  const selectViewer = (id: string, checked: boolean) => onChange({ ...value, privateViewerIds: checked ? [...new Set([...value.privateViewerIds, id])] : value.privateViewerIds.filter(item => item !== id) });
  return <section aria-label="Privacidade da câmera" className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex items-center justify-between gap-3">
      <div><label htmlFor={`${fieldId}-private`} className="text-sm font-medium">Câmera privada</label>
        <p className="mt-1 text-xs text-muted-foreground">Só o proprietário e as pessoas autorizadas podem ver as imagens e gravações.</p></div>
      <Switch id={`${fieldId}-private`} checked={value.isPrivate} onCheckedChange={isPrivate => onChange({ ...value, isPrivate })} />
    </div>
    {value.isPrivate ? <>
      <p className="text-xs text-muted-foreground">Grupos e administradores não ganham acesso automático às imagens.</p>
      {isError ? <p role="alert" className="text-xs text-destructive">Não foi possível carregar os usuários. <button type="button" className="underline min-h-10" onClick={() => void refetch()}>Tentar novamente</button></p> : null}
      <div className="space-y-1.5">
        <label htmlFor={`${fieldId}-owner`} className="text-xs font-medium">Proprietário da câmera</label>
        <select id={`${fieldId}-owner`} className="w-full min-h-10 rounded-md border border-border bg-background px-3 text-sm" value={value.ownerUserId} disabled={isPending || isError}
          onChange={event => onChange({ ...value, ownerUserId: event.target.value, privateViewerIds: value.privateViewerIds.filter(id => id !== event.target.value) })}>
          <option value="">{isPending ? 'Carregando usuários…' : 'Escolha o proprietário'}</option>
          {value.ownerUserId && !users.some(user => user.id === value.ownerUserId) ? <option value={value.ownerUserId}>Proprietário indisponível — escolha outro</option> : null}
          {users.map(user => <option key={user.id} value={user.id}>{user.name}{user.username ? ` (${user.username})` : ''}</option>)}
        </select>
      </div>
      <details className="rounded-md border border-border px-3">
        <summary className="cursor-pointer min-h-10 py-2 text-xs font-medium">Outras pessoas que podem visualizar ({value.privateViewerIds.filter(id => id !== value.ownerUserId).length})</summary>
        <p className="mb-2 text-xs text-muted-foreground">Opcional. Novos acessos permitem apenas visualizar; permissões adicionais já existentes são preservadas.</p>
        <label htmlFor={`${fieldId}-search`} className="sr-only">Buscar usuário</label>
        <input id={`${fieldId}-search`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar pelo nome ou login" className="w-full min-h-10 rounded-md border border-border bg-background px-3 text-sm" />
        <div className="max-h-48 overflow-y-auto py-2">
          {visible.map(user => <label key={user.id} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={value.privateViewerIds.includes(user.id)} onChange={event => selectViewer(user.id, event.target.checked)} />
            <span className="min-w-0 break-words">{user.name}{user.username ? ` (${user.username})` : ''}</span>
          </label>)}
          {!isPending && !isError && !visible.length ? <p className="py-2 text-xs text-muted-foreground">Nenhum usuário encontrado.</p> : null}
          {!isPending && !isError ? unavailable.map(id => <label key={id} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked onChange={() => selectViewer(id, false)} /> Usuário indisponível — desmarque para retirar o acesso
          </label>) : null}
        </div>
      </details>
      <p className="text-xs text-muted-foreground">O cadastro ainda pode ser gerenciado pelos administradores. Isso não dá acesso às imagens.</p>
    </> : <p className="text-xs text-muted-foreground">Segue as permissões normais de grupos e usuários. Não é uma transmissão pública na internet.</p>}
  </section>;
}
