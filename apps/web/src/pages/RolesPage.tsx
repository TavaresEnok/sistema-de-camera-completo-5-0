import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Shield, Check, Edit2, LoaderCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { clientError } from '../lib/client-error';
import { confirmAction } from '../components/ActionConfirmation';
import { usePermissionsStore } from '../store/permissionsStore';

const API_URL = getApiBaseUrl();

const PERMISSION_LABELS: Record<string, { label: string; desc: string }> = {
  liveView: { label: 'Ao Vivo', desc: 'Acessar transmissões ao vivo das câmeras' },
  playback: { label: 'Reprodução', desc: 'Revisar gravações' },
  ptzControl: { label: 'Movimentar câmera (PTZ)', desc: 'Mover câmeras compatíveis e usar seus controles' },
  alarmAck: { label: 'Reconhecer alarmes', desc: 'Reconhecer e gerenciar alarmes' },
  cameraConfig: { label: 'Configuração de câmeras', desc: 'Criar, editar e remover câmeras' },
  userManage: { label: 'Gestão de usuários', desc: 'Criar e editar contas de usuário' },
  auditLogs: { label: 'Histórico de ações', desc: 'Consultar ações realizadas no sistema' },
  exportEvidence: { label: 'Exportar evidências', desc: 'Exportar clipes e pacotes de evidência' },
  serverConfig: { label: 'Configurações da instalação', desc: 'Alterar aparência, prazo das gravações e regras de acesso' },
  roleManage: { label: 'Gestão de funções', desc: 'Gerenciar funções e permissões' },
  reportGenerate: { label: 'Relatórios', desc: 'Gerar e exportar relatórios' },
};

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Administrador principal',
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Visualizador',
};

const ROLE_DESC: Record<string, string> = {
  SUPER_ADMIN: 'Função protegida para administrar a instalação. Câmeras particulares mantêm suas regras de acesso.',
  ADMIN: 'Administração da instalação conforme as permissões abaixo.',
  OPERATOR: 'Operação das câmeras autorizadas conforme as permissões abaixo.',
  VIEWER: 'Acesso às câmeras autorizadas conforme as permissões abaixo.',
};

type Matrix = Record<string, Record<string, boolean>>;

export default function PerfisPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const [keys, setKeys] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [loading, setLoading] = useState(true);
  const [editRole, setEditRole] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${accessToken}` }), [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const { data } = await axios.get<{ keys: string[]; roles: Matrix }>(`${API_URL}/role-permissions`, { headers: authHeaders });
      setKeys(data.keys ?? []);
      setMatrix(data.roles ?? {});
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      toast({
        title: 'Falha ao carregar funções',
        description: clientError(error, 'Não foi possível carregar as permissões.'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [accessToken, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const roles = useMemo(() => Object.keys(matrix), [matrix]);
  const [selRole, setSelRole] = useState<string>('');
  const activeRole = selRole || roles[0] || '';

  const openEdit = (role: string) => {
    setEditRole(role);
    setEditPerms({ ...(matrix[role] ?? {}) });
  };

  const saveEdit = async () => {
    if (!editRole || saving) return;
    setSaving(true);
    try {
      const { data } = await axios.patch<{ role: string; permissions: Record<string, boolean> }>(
        `${API_URL}/role-permissions/${editRole}`,
        { permissions: editPerms },
        { headers: authHeaders },
      );
      setMatrix((prev) => ({ ...prev, [data.role]: data.permissions }));
      setEditRole(null);
      if (accessToken) await usePermissionsStore.getState().load(accessToken);
      toast({ title: 'Permissões salvas', description: `Função ${ROLE_LABELS[data.role] ?? data.role} atualizado.` });
    } catch (error) {
      toast({
        title: 'Falha ao salvar permissões',
        description: clientError(error, 'Não foi possível salvar.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };
  const closeEdit = async () => {
    if (saving) return;
    if (JSON.stringify(editPerms) !== JSON.stringify(matrix[editRole ?? '']) && !(await confirmAction({ title: 'Descartar alterações?', description: 'As mudanças desta função não serão salvas.', confirmLabel: 'Descartar', destructive: true }))) return;
    setEditRole(null);
  };

  return (
    <div className="flex flex-col h-full">
      {loading && (
        <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end">
          <LoaderCircle className="h-4 w-4 animate-spin" style={{ color: 'var(--tx-4)' }} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-[22px] flex flex-col gap-[22px]">
        {loadError && <div role="alert" className="rounded-lg border border-border p-4 text-sm">Não foi possível carregar as funções. <button className="underline" onClick={() => void load()}>Tentar novamente</button></div>}
        <p className="text-sm text-muted-foreground">A função define as ações disponíveis. Os grupos e acessos individuais definem quais câmeras cada pessoa pode usar.</p>
        {/* Cards de papéis */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))' }}>
          {roles.map((role) => {
            const sel = activeRole === role;
            const allowed = keys.filter((k) => matrix[role]?.[k]).length;
            return (
              <div
                key={role}
                onClick={() => setSelRole(role)}
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelRole(role); } }}
                className="cursor-pointer transition-colors"
                style={{ background: 'var(--surf-1)', borderRadius: 12, padding: '16px 18px', border: `1px solid ${sel ? 'var(--acc-bdr)' : 'var(--bdr)'}` }}
              >
                <div className="flex items-center mb-2.5">
                  <div className="text-[13px] font-semibold" style={{ color: sel ? 'var(--tx)' : 'var(--tx-2)' }}>{ROLE_LABELS[role] ?? role}</div>
                  <span className="ml-auto font-mono text-xs" style={{ color: 'var(--tx-4)' }}>{allowed}/{keys.length}</span>
                </div>
                <div className="text-[11px] leading-relaxed" style={{ color: 'var(--tx-3)' }}>{ROLE_DESC[role] ?? ''}</div>
                {role !== 'SUPER_ADMIN' && (
                  <button onClick={(e) => { e.stopPropagation(); openEdit(role); }} className="btn btn-secondary btn-xs mt-3">
                    <Edit2 className="h-2.5 w-2.5" /> Editar
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Matriz de permissões */}
        <div>
          <div className="font-mono uppercase mb-3" style={{ fontSize: 10, letterSpacing: '.12em', color: 'var(--tx-4)' }}>Matriz de permissões</div>
          <div className="overflow-x-auto" style={{ background: 'var(--surf-1)', border: '1px solid var(--bdr)', borderRadius: 12 }}>
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '11px 16px', textAlign: 'left', fontSize: 10, color: 'var(--tx-4)', textTransform: 'uppercase', letterSpacing: '.08em', borderBottom: '1px solid var(--bdr)', minWidth: 160 }}>Permissão</th>
                  {roles.map((role) => (
                    <th key={role} onClick={() => setSelRole(role)} style={{ padding: '11px 14px', textAlign: 'center', fontSize: 11, fontWeight: 600, borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', cursor: 'pointer', color: activeRole === role ? 'var(--acc)' : 'var(--tx-3)' }}>
                      {ROLE_LABELS[role] ?? role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key}>
                    <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--tx-2)', borderBottom: '1px solid var(--bdr-lo)' }}>{PERMISSION_LABELS[key]?.label ?? key}</td>
                    {roles.map((role) => {
                      const on = matrix[role]?.[key];
                      const isSel = activeRole === role;
                      return (
                        <td key={role} style={{ padding: '10px 14px', textAlign: 'center', borderBottom: '1px solid var(--bdr-lo)', background: isSel ? 'var(--surf-2)' : 'transparent' }}>
                          {on
                            ? <Check size={14} style={{ color: isSel ? 'var(--acc)' : 'var(--tx-2)', display: 'inline' }} />
                            : <span className="font-mono" style={{ color: 'var(--tx-4)', fontSize: 13 }}>–</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Sheet open={!!editRole} onOpenChange={(o) => !o && void closeEdit()}>
        {/* CORPO ROLÁVEL + RODAPÉ FIXO. O SheetContent é `h-full` e não rolava:
            com as 11 permissões (~44px cada) mais cabeçalho e respiro, em
            notebook de 1366×768 o admin editava e NÃO ALCANÇAVA o botão Salvar
            — e piora a cada permissão nova vinda do backend. */}
        <SheetContent className="bg-card border-border w-80 flex flex-col p-0 gap-0">
          <SheetHeader className="shrink-0 border-b border-border p-5">
            <SheetTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              Editar função: {editRole ? (ROLE_LABELS[editRole] ?? editRole) : ''}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">
            {keys.map((key) => (
              <div
                key={key}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditPerms((prev) => ({ ...prev, [key]: !prev[key] })); } }}
                onClick={() => setEditPerms((prev) => ({ ...prev, [key]: !prev[key] }))}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg p-2 hover:bg-accent/40"
              >
                <div>
                  <p className="text-xs font-medium">{PERMISSION_LABELS[key]?.label ?? key}</p>
                  <p className="text-xs text-muted-foreground">{PERMISSION_LABELS[key]?.desc ?? ''}</p>
                </div>
                <Switch
                  aria-label={PERMISSION_LABELS[key]?.label ?? key}
                  checked={!!editPerms[key]}
                  onCheckedChange={(value) => setEditPerms((prev) => ({ ...prev, [key]: value }))}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t border-border p-4">
            <div className="flex justify-end gap-2">
              <button disabled={saving} onClick={() => void closeEdit()} className="h-8 px-4 rounded border border-border text-xs hover:bg-accent">Cancelar</button>
              <button
                onClick={() => void saveEdit()}
                disabled={saving}
                className="h-8 px-4 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {saving ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
                Salvar
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
