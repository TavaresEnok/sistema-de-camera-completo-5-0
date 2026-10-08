import { useEffect, useMemo, useState, type ReactNode } from 'react';
import axios from 'axios';
import { HardDrive, RefreshCw, Trash2, ChevronDown } from 'lucide-react';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';
import { formatarBytes } from '../lib/formato';
import { CloudStorageCard } from '../components/CloudStorageCard';
import { PreviousStoragesCard } from '../components/PreviousStoragesCard';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

function Ring({ value }: { value: number }) {
  return (
    <div className="relative h-40 w-40 rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${value}%, hsl(var(--border)) 0)` }}>
      <div className="absolute inset-4 rounded-full bg-card border border-border flex flex-col items-center justify-center">
        <div className="text-3xl font-semibold">{value}%</div>
        <div className="text-[11px] text-[hsl(var(--muted-foreground))]">Uso</div>
      </div>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  const tone = value >= 95 ? 'bg-[hsl(var(--destructive))]' : value >= 80 ? 'bg-[hsl(var(--chart-4))]' : 'bg-[hsl(var(--primary))]';
  return <div className="h-1.5 rounded-full bg-[hsl(var(--border))] overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${value}%` }} /></div>;
}

function StorageSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/45"
      >
        <span className="text-sm font-semibold">{title}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="border-t border-border">{children}</div> : null}
    </section>
  );
}

const USAGE_PAGE_SIZE = 20;

function UsagePagination({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / USAGE_PAGE_SIZE));
  if (pages <= 1) return null;
  const firstPage = Math.min(Math.max(1, page - 2), Math.max(1, pages - 5));
  const visible = Array.from({ length: Math.min(pages, 6) }, (_, index) => firstPage + index);
  return (
    <nav className="flex flex-wrap items-center justify-end gap-1.5 px-5 py-3" aria-label="Paginação do consumo de armazenamento">
      <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} className="h-7 rounded-md border border-border px-2 text-[11px] disabled:opacity-40">Anterior</button>
      {visible.map((item) => (
        <button key={item} type="button" onClick={() => onChange(item)} aria-current={page === item ? 'page' : undefined} className={`h-7 min-w-7 rounded-md border px-2 text-[11px] ${page === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent'}`}>{item}</button>
      ))}
      {pages > 6 ? <span className="px-1 text-[11px] text-muted-foreground">de {pages}</span> : null}
      <button type="button" onClick={() => onChange(Math.min(pages, page + 1))} disabled={page === pages} className="h-7 rounded-md border border-border px-2 text-[11px] disabled:opacity-40">Próxima</button>
    </nav>
  );
}

export default function MonitoramentoPage() {
  const API_URL = getApiBaseUrl();
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === 'admin';
  const cameras = useVmsDataStore((state) => state.cameras);
  const system = useVmsDataStore((state) => state.system);
  const load = useVmsDataStore((state) => state.load);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmApagarVideos, setConfirmApagarVideos] = useState('');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reloadNonce, setReloadNonce] = useState(0);
  const [deletingVideos, setDeletingVideos] = useState(false);
  const [analytics, setAnalytics] = useState<{
    summary: { rows: number; totalRecordingsBytes: string; totalClipsBytes: string; totalBytes: string };
    items: Array<{
      cameraId: string;
      cameraName: string;
      day: string;
      recordingsCount: number;
      clipsCount: number;
      recordingsBytes: string;
      clipsBytes: string;
      totalBytes: string;
    }>;
    byCamera?: Array<{
      cameraId: string; cameraName: string; groupId: string | null; groupName: string;
      recordingsCount: number; clipsCount: number; recordingsBytes: string; clipsBytes: string; totalBytes: string;
    }>;
    byGroup?: Array<{
      groupId: string | null; groupName: string; camerasCount: number;
      recordingsCount: number; clipsCount: number; recordingsBytes: string; clipsBytes: string; totalBytes: string;
    }>;
  } | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [usageView, setUsageView] = useState<'camera' | 'group'>('camera');
  const [cameraUsagePage, setCameraUsagePage] = useState(1);
  const [groupUsagePage, setGroupUsagePage] = useState(1);
  const [openStorageSections, setOpenStorageSections] = useState({
    volumes: true,
    cameras: true,
    cloud: true,
  });

  const toggleStorageSection = (key: keyof typeof openStorageSections) => {
    setOpenStorageSections((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    void axios.get(`${API_URL}/recordings/storage-usage`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        from: new Date(`${fromDate}T00:00:00.000Z`).toISOString(),
        to: new Date(`${toDate}T23:59:59.999Z`).toISOString(),
      },
    }).then(({ data }) => {
      if (cancelled) return;
      setAnalytics(data);
      setCameraUsagePage(1);
      setGroupUsagePage(1);
    }).catch((error) => {
      if (cancelled) return;
      setAnalytics(null);
      setAnalyticsError(error instanceof Error ? error.message : 'Falha ao carregar análise de armazenamento.');
    }).finally(() => {
      if (!cancelled) setAnalyticsLoading(false);
    });
    return () => { cancelled = true; };
  }, [API_URL, accessToken, fromDate, toDate, reloadNonce]);

  async function handleDeleteAllVideos() {
    if (!accessToken) return;
    setConfirmDeleteOpen(false);
    setDeletingVideos(true);
    try {
      await axios.delete(`${API_URL}/recordings`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setReloadNonce((value) => value + 1);
      await load();
      toast({ title: 'Gravações apagadas', description: 'Todas as gravações e clipes exportados foram removidos.' });
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao apagar vídeos.';
      toast({
        title: 'Falha ao apagar vídeos',
        description: Array.isArray(msg) ? msg.join(' | ') : String(msg),
        variant: 'destructive',
      });
    } finally {
      setDeletingVideos(false);
    }
  }

  // Formatador único (lib/formato): escolhe a unidade pelo tamanho e usa a
  // notação brasileira. O `toGB` local forçava GB sempre — uma câmera de 30 MB
  // aparecia como "0.03 GB" — com ponto decimal e sem separador de milhar.
  const toGB = (raw: string | number | bigint) => formatarBytes(Number(raw));
  const volumes = useMemo(() => system ? [
    {
      server: system.server.hostname,
      volume: system.recordingsRoot,
      type: 'Local FS',
      use: system.disk.usagePercent,
    },
  ] : [], [system]);
  const percent = system?.disk.usagePercent ?? 0;
  // Retenção real das câmeras acessíveis (antes era um "90 dias" fixo e falso).
  const retentionLabel = useMemo(() => {
    const days = Array.from(new Set(
      cameras.map((camera) => camera.retentionDays).filter((value): value is number => typeof value === 'number' && value > 0),
    ));
    if (!days.length) return '—';
    if (days.length === 1) return `${days[0]} dias`;
    return `${Math.min(...days)}–${Math.max(...days)} dias`;
  }, [cameras]);
  const cameraUsage = analytics?.byCamera ?? [];
  const groupUsage = analytics?.byGroup ?? [];
  const pagedCameraUsage = cameraUsage.slice((cameraUsagePage - 1) * USAGE_PAGE_SIZE, cameraUsagePage * USAGE_PAGE_SIZE);
  const pagedGroupUsage = groupUsage.slice((groupUsagePage - 1) * USAGE_PAGE_SIZE, groupUsagePage * USAGE_PAGE_SIZE);

  return (
    <div className="flex flex-col h-full min-h-0">
      {isAdmin && (
        <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end">
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deletingVideos}
            className="btn btn-sm border-[hsl(var(--destructive)_/_0.35)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> {deletingVideos ? 'Apagando...' : 'Apagar vídeos'}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="bg-card border border-border rounded-xl p-5 flex items-center justify-center">
          <Ring value={percent} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Capacidade total</div><div className="mt-2 text-2xl font-semibold">{formatarBytes(system?.disk.totalBytes)}</div></div>
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Em uso</div><div className="mt-2 text-2xl font-semibold">{formatarBytes(system?.disk.usedBytes)}</div></div>
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Disponível</div><div className="mt-2 text-2xl font-semibold">{formatarBytes(system?.disk.freeBytes)}</div></div>
        </div>
      </div>
      <StorageSection title="Volumes" aria-label="Volumes" open={openStorageSections.volumes} onToggle={() => toggleStorageSection('volumes')}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Detalhes de armazenamento</div>
          </div>
          <button onClick={() => { setReloadNonce((value) => value + 1); void load(); }} className="text-xs flex items-center gap-2 text-[hsl(var(--muted-foreground))] hover:text-foreground transition-colors"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-[10px] text-[hsl(var(--muted-foreground))]">
            <tr className="border-b border-border">
              <th className="text-left px-5 py-3">Servidor</th>
              <th className="text-left px-5 py-3">Volume</th>
              <th className="text-left px-5 py-3">Tipo</th>
              <th className="text-left px-5 py-3">Uso</th>
            </tr>
          </thead>
          <tbody>
            {volumes.map(row => (
              <tr key={row.volume} className="border-b border-border last:border-0">
                <td className="px-5 py-4 font-mono text-xs">{row.server}</td>
                <td className="px-5 py-4 flex items-center gap-2"><HardDrive className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />{row.volume}</td>
                <td className="px-5 py-4 text-xs text-[hsl(var(--muted-foreground))]">{row.type}</td>
                <td className="px-5 py-4 w-72"><div className="space-y-2"><Bar value={row.use} /><div className="text-xs text-[hsl(var(--muted-foreground))]">{row.use}%</div></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </StorageSection>
      <StorageSection title="Armazenamento em nuvem" aria-label="Armazenamento em nuvem" open={openStorageSections.cloud} onToggle={() => toggleStorageSection('cloud')}>
        <CloudStorageCard apiUrl={API_URL} accessToken={accessToken} />
        {/* Só aparece quando existe storage anterior — é o que sobra de uma
            troca de fornecedor, e continua sendo pago até alguém esvaziá-lo. */}
        <PreviousStoragesCard apiUrl={API_URL} accessToken={accessToken} />
      </StorageSection>

      <StorageSection title="Uso de armazenamento" aria-label="Uso de armazenamento" open={openStorageSections.cameras} onToggle={() => toggleStorageSection('cameras')}>
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Gravações e clipes exportados no período selecionado</div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input aria-label="Data inicial do uso de armazenamento" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 min-w-0 rounded border border-border bg-background px-2 text-xs" />
            <input aria-label="Data final do uso de armazenamento" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 min-w-0 rounded border border-border bg-background px-2 text-xs" />
          </div>
        </div>
        <div className="px-5 py-3 text-xs text-[hsl(var(--muted-foreground))]">
          {analyticsLoading && 'Carregando uso de armazenamento...'}
          {!analyticsLoading && analyticsError && analyticsError}
          {!analyticsLoading && analytics && (
            <span>
              {analytics.summary.rows} linha(s) · gravações: {toGB(analytics.summary.totalRecordingsBytes)} · clipes: {toGB(analytics.summary.totalClipsBytes)} · total: {toGB(analytics.summary.totalBytes)}
            </span>
          )}
        </div>
        <div className="flex gap-2 border-t border-border px-5 pt-3">
          <button type="button" onClick={() => setUsageView('camera')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${usageView === 'camera' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'}`}>Por câmera</button>
          <button type="button" onClick={() => setUsageView('group')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${usageView === 'group' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'}`}>Por grupo</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {usageView === 'camera' ? (
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3">Câmera</th>
                  <th className="text-left px-5 py-3">Grupo</th>
                  <th className="text-left px-5 py-3">Gravações</th>
                  <th className="text-left px-5 py-3">Clipes</th>
                  <th className="text-left px-5 py-3">Total</th>
                </tr>
              ) : (
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3">Grupo</th>
                  <th className="text-left px-5 py-3">Câmeras</th>
                  <th className="text-left px-5 py-3">Gravações</th>
                  <th className="text-left px-5 py-3">Clipes</th>
                  <th className="text-left px-5 py-3">Total</th>
                </tr>
              )}
            </thead>
            <tbody>
              {usageView === 'camera' ? pagedCameraUsage.map((row) => (
                <tr key={row.cameraId} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 text-xs font-medium">{row.cameraName}</td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">{row.groupName}</td>
                  <td className="px-5 py-3 text-xs">{row.recordingsCount} arquivo(s) · {toGB(row.recordingsBytes)}</td>
                  <td className="px-5 py-3 text-xs">{row.clipsCount} arquivo(s) · {toGB(row.clipsBytes)}</td>
                  <td className="px-5 py-3 text-xs font-semibold">{toGB(row.totalBytes)}</td>
                </tr>
              )) : pagedGroupUsage.map((row) => (
                <tr key={row.groupId ?? 'no-group'} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 text-xs font-medium">{row.groupName}</td>
                  <td className="px-5 py-3 text-xs">{row.camerasCount}</td>
                  <td className="px-5 py-3 text-xs">{row.recordingsCount} arquivo(s) · {toGB(row.recordingsBytes)}</td>
                  <td className="px-5 py-3 text-xs">{row.clipsCount} arquivo(s) · {toGB(row.clipsBytes)}</td>
                  <td className="px-5 py-3 text-xs font-semibold">{toGB(row.totalBytes)}</td>
                </tr>
              ))}
              {!analyticsLoading && ((usageView === 'camera' && cameraUsage.length === 0) || (usageView === 'group' && groupUsage.length === 0)) ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-xs text-muted-foreground">Nenhum uso encontrado no período selecionado.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <UsagePagination page={usageView === 'camera' ? cameraUsagePage : groupUsagePage} total={usageView === 'camera' ? cameraUsage.length : groupUsage.length} onChange={usageView === 'camera' ? setCameraUsagePage : setGroupUsagePage} />
      </StorageSection>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">Retenção</div>
          <div className="mt-3 text-2xl font-semibold">{retentionLabel}</div>
          <div className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Configurada por câmera (gravações e eventos).</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">Câmeras</div>
          <div className="mt-3 text-2xl font-semibold">{cameras.length}</div>
          <div className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Base para cálculo de retenção por carga.</div>
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          {/* ATRITO PROPORCIONAL. Esta é a ação mais destrutiva do sistema —
              apaga o acervo inteiro — e era um clique com texto genérico,
              enquanto esvaziar um bucket JÁ DESATIVADO exige digitar o nome do
              bucket. O atrito estava invertido. */}
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar todas as gravações?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Isto remove <strong>todas</strong> as gravações e clipes exportados de{' '}
                  <strong>todas as câmeras</strong>. Não pode ser desfeito.
                </p>
                {analytics?.summary ? (
                  <p className="rounded border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.08)] px-2 py-1.5 text-[hsl(var(--destructive))]">
                    No período consultado são <strong>{analytics.summary.rows}</strong> registro(s),{' '}
                    <strong>{toGB(analytics.summary.totalBytes)}</strong> de vídeo.
                  </p>
                ) : null}
                <p>
                  As cópias já enviadas para a <strong>nuvem não são apagadas</strong> por esta ação —
                  para removê-las, use “Esvaziar” no armazenamento correspondente.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6">
            <label className="block text-[11px] text-muted-foreground" htmlFor="confirmar-apagar-videos">
              Para confirmar, digite <b className="font-mono text-foreground">APAGAR</b>:
            </label>
            <input
              id="confirmar-apagar-videos"
              value={confirmApagarVideos}
              onChange={(event) => setConfirmApagarVideos(event.target.value)}
              className="input mt-1 w-full"
              placeholder="APAGAR"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmApagarVideos.trim().toUpperCase() !== 'APAGAR'}
              onClick={() => void handleDeleteAllVideos()}
              className="bg-[hsl(var(--destructive))] text-white hover:bg-[hsl(var(--destructive)_/_0.9)] disabled:opacity-40"
            >
              Apagar definitivamente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}
