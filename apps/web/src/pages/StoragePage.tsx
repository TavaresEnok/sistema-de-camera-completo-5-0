import { useEffect, useMemo, useState, type ReactNode } from 'react';
import axios from 'axios';
import { CheckCircle2, ChevronDown, Cloud, CloudOff, HardDrive, Info, RefreshCw, Settings2, Trash2, TriangleAlert } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';
import { formatarBytes } from '../lib/formato';
import { haQuantoTempo, pontosDoGrafico, resumoDaNuvem, rotuloDeRetencao, statusDoArmazenamento, type Tom, type Visao } from '../lib/armazenamento';
import { CloudStorageCard } from '../components/CloudStorageCard';
import { PreviousStoragesCard } from '../components/PreviousStoragesCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

// ── ARMAZENAMENTO ───────────────────────────────────────────────────────────
// Uma tela, de cima para baixo, respondendo o que o cliente pergunta:
//   1. Está tudo bem, e por quanto tempo guardo?  → frase de status + disco × nuvem
//   2. Quanto gravo por dia, e onde está?         → gráfico empilhado
//   3. Quem mais ocupa?                           → câmeras (ou grupos)
//   4. A nuvem está enviando?                     → uma linha + "Configurar"
// O que é técnico (volume, servidor, storages antigos) fica recolhido.

const COR_DISCO = 'hsl(var(--primary))';
const COR_NUVEM = 'hsl(var(--status-online))';

const TOM: Record<Tom, { icone: typeof CheckCircle2; cor: string }> = {
  ok: { icone: CheckCircle2, cor: 'text-[hsl(var(--status-online))]' },
  neutro: { icone: Info, cor: 'text-muted-foreground' },
  aviso: { icone: TriangleAlert, cor: 'text-[hsl(var(--status-warning))]' },
  perigo: { icone: TriangleAlert, cor: 'text-[hsl(var(--destructive))]' },
};

function Barra({ percentual, cor }: { percentual: number; cor: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--border))]">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, percentual))}%`, background: cor }} />
    </div>
  );
}

function Cartao({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-border bg-card p-5 ${className}`}>{children}</section>;
}

export default function ArmazenamentoPage() {
  const API_URL = getApiBaseUrl();
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === 'admin';
  const cameras = useVmsDataStore((state) => state.cameras);
  const system = useVmsDataStore((state) => state.system);
  const resumoDeCameras = useVmsDataStore((state) => state.overview);
  const load = useVmsDataStore((state) => state.load);

  const [visao, setVisao] = useState<Visao | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [versao, setVersao] = useState(0);
  const [porGrupo, setPorGrupo] = useState(false);
  const [configurarAberto, setConfigurarAberto] = useState(false);
  const [tecnicoAberto, setTecnicoAberto] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmApagarVideos, setConfirmApagarVideos] = useState('');
  const [deletingVideos, setDeletingVideos] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelado = false;
    axios.get<Visao>(`${API_URL}/cloud-storage/overview`, { headers: { Authorization: `Bearer ${accessToken}` }, params: { days: 14 } })
      .then(({ data }) => { if (!cancelado) { setVisao(data); setFalhou(false); } })
      .catch(() => { if (!cancelado) setFalhou(true); });
    return () => { cancelado = true; };
  }, [API_URL, accessToken, versao]);

  const atualizar = () => { setVersao((v) => v + 1); void load(); };

  const discoPercent = system?.disk.usagePercent ?? 0;
  const retencao = useMemo(
    () => rotuloDeRetencao(cameras.map((c) => c.effectiveRetentionDays ?? c.retentionDays)),
    [cameras],
  );
  const camerasGravando = resumoDeCameras?.recordingEnabled ?? 0;
  const nuvem = visao?.cloud ?? null;
  const status = statusDoArmazenamento({
    discoPercent,
    retencao,
    camerasGravando,
    nuvem,
    totais: { pendingCount: visao?.totals.pendingCount ?? 0, lastUploadAt: visao?.totals.lastUploadAt ?? null },
  });
  const IconeStatus = TOM[status.tom].icone;
  const pontos = useMemo(() => pontosDoGrafico(visao?.daily ?? []), [visao]);
  const temDados = pontos.some((p) => p.disco > 0 || p.nuvem > 0);
  const lista = porGrupo
    ? (visao?.byGroup ?? []).map((g) => ({ chave: g.groupName, nome: g.groupName, detalhe: `${g.cameras} câmera${g.cameras === 1 ? '' : 's'}`, disco: g.diskBytes, nuvem: g.cloudBytes }))
    : (visao?.byCamera ?? []).slice(0, 8).map((c) => ({ chave: c.cameraId, nome: c.cameraName, detalhe: c.groupName ?? '', disco: c.diskBytes, nuvem: c.cloudBytes }));
  const maior = Math.max(1, ...lista.map((l) => l.disco + l.nuvem));
  const ultimoEnvio = haQuantoTempo(visao?.totals.lastUploadAt ?? null);
  const nuvemBytes = visao?.totals.cloudBytes ?? 0;
  const totalGuardado = (visao?.totals.diskBytes ?? 0) + nuvemBytes;

  async function handleDeleteAllVideos() {
    setConfirmDeleteOpen(false);
    setDeletingVideos(true);
    try {
      await axios.delete(`${API_URL}/recordings`, { headers: { Authorization: `Bearer ${accessToken}` } });
      atualizar();
      toast({ title: 'Gravações apagadas', description: 'Todas as gravações e clipes exportados foram removidos.' });
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao apagar vídeos.';
      toast({ title: 'Falha ao apagar vídeos', description: Array.isArray(msg) ? msg.join(' | ') : String(msg), variant: 'destructive' });
    } finally {
      setDeletingVideos(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-6 py-3">
        <button type="button" onClick={atualizar} className="btn btn-secondary btn-sm"><RefreshCw className="h-3.5 w-3.5" /> Atualizar</button>
        {isAdmin && (
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deletingVideos}
            className="btn btn-sm border-[hsl(var(--destructive)_/_0.35)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> {deletingVideos ? 'Apagando…' : 'Apagar vídeos'}
          </button>
        )}
      </div>

      <div className="mx-auto w-full max-w-5xl flex-1 space-y-4 overflow-y-auto p-6">
        {/* 1. Resumo: está tudo bem? disco × nuvem */}
        <Cartao>
          <div className="mb-5 flex items-center gap-2 text-sm">
            <IconeStatus className={`h-5 w-5 shrink-0 ${TOM[status.tom].cor}`} />
            <span className={status.tom === 'perigo' || status.tom === 'aviso' ? TOM[status.tom].cor : ''}>{status.texto}</span>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" /> Disco</span>
                <span className="text-foreground">{formatarBytes(system?.disk.usedBytes)} de {formatarBytes(system?.disk.totalBytes)}</span>
              </div>
              <div className="my-2"><Barra percentual={discoPercent} cor={discoPercent >= 85 ? 'hsl(var(--status-warning))' : COR_DISCO} /></div>
              <div className="text-[11px] text-muted-foreground">
                {formatarBytes(system?.disk.freeBytes)} livres{nuvem?.policy?.enabled && !nuvem.policy.keepLocalCopy ? ` · cópia local de ${nuvem.localWindowHours} h` : ''}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {nuvem ? <Cloud className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />} Nuvem
                </span>
                <span className="text-foreground">{nuvem ? formatarBytes(nuvemBytes) : '—'}</span>
              </div>
              {/* Nuvem não tem "capacidade": a barra mostra quanto do que está
                  guardado já está lá (o resto ainda só existe no disco). */}
              <div className="my-2"><Barra percentual={nuvem && totalGuardado > 0 ? (nuvemBytes / totalGuardado) * 100 : 0} cor={COR_NUVEM} /></div>
              <div className="text-[11px] text-muted-foreground">
                {nuvem
                  ? `${visao?.totals.cloudCount ?? 0} gravações · ${ultimoEnvio ? `último envio ${ultimoEnvio}` : 'nenhum envio ainda'}${visao?.totals.pendingCount ? ` · ${visao.totals.pendingCount} aguardando` : ''}`
                  : 'Não configurada · contrate pela Central'}
              </div>
            </div>
          </div>
        </Cartao>

        {/* 2. Quanto gravo por dia, e onde está */}
        <Cartao>
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Gravado por dia · {visao?.days ?? 14} dias</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COR_DISCO }} /> só no disco</span>
              {nuvem ? <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COR_NUVEM }} /> na nuvem</span> : null}
            </span>
          </div>
          <div className="h-44">
            {temDados ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pontos} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                  <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} unit=" GB" width={56} />
                  <ReTooltip cursor={{ fillOpacity: 0.08 }} contentStyle={{ fontSize: 12 }} formatter={(v: number, nome) => [`${v} GB`, nome === 'disco' ? 'Só no disco' : 'Na nuvem']} />
                  <Bar dataKey="disco" stackId="a" fill={COR_DISCO} />
                  <Bar dataKey="nuvem" stackId="a" fill={COR_NUVEM} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {falhou ? 'Não foi possível carregar o uso.' : 'Nenhuma gravação nos últimos 14 dias.'}
              </div>
            )}
          </div>
        </Cartao>

        {/* 3. Quem mais ocupa */}
        {lista.length > 0 && (
          <Cartao>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{porGrupo ? 'Grupos' : 'Câmeras'} que mais ocupam</span>
              <div className="segment" aria-label="Agrupar por">
                <button type="button" className={`seg-btn ${!porGrupo ? 'active' : ''}`} aria-pressed={!porGrupo} onClick={() => setPorGrupo(false)}>Câmera</button>
                <button type="button" className={`seg-btn ${porGrupo ? 'active' : ''}`} aria-pressed={porGrupo} onClick={() => setPorGrupo(true)}>Grupo</button>
              </div>
            </div>
            <div className="space-y-2.5">
              {lista.map((l) => (
                <div key={l.chave} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-xs">
                  <span className="min-w-0">
                    <span className="block truncate" title={l.nome}>{l.nome}</span>
                    {l.detalhe ? <span className="block truncate text-[11px] text-muted-foreground">{l.detalhe}</span> : null}
                  </span>
                  <div className="flex h-2 overflow-hidden rounded-full bg-[hsl(var(--border))]">
                    <div style={{ width: `${(l.disco / maior) * 100}%`, background: COR_DISCO }} />
                    <div style={{ width: `${(l.nuvem / maior) * 100}%`, background: COR_NUVEM }} />
                  </div>
                  <span className="tabular-nums text-muted-foreground">{formatarBytes(l.disco + l.nuvem)}</span>
                </div>
              ))}
            </div>
          </Cartao>
        )}

        {/* 4. Nuvem: uma linha + Configurar */}
        <Cartao className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm">
            {nuvem ? <Cloud className="h-5 w-5 text-[hsl(var(--status-online))]" /> : <CloudOff className="h-5 w-5 text-muted-foreground" />}
            <span>{resumoDaNuvem(nuvem)}</span>
          </div>
          {isAdmin && nuvem ? (
            <button type="button" onClick={() => setConfigurarAberto(true)} className="btn btn-secondary btn-sm"><Settings2 className="h-3.5 w-3.5" /> Configurar</button>
          ) : null}
        </Cartao>

        {/* 5. Técnico, recolhido */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <button type="button" onClick={() => setTecnicoAberto((v) => !v)} className="flex w-full items-center justify-between px-5 py-3 text-left text-xs text-muted-foreground hover:bg-accent/45">
            <span>Detalhes técnicos</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${tecnicoAberto ? 'rotate-180' : ''}`} />
          </button>
          {tecnicoAberto && (
            <div className="space-y-3 border-t border-border px-5 py-4 text-xs">
              <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5">
                <dt className="text-muted-foreground">Servidor</dt><dd className="font-mono">{system?.server.hostname ?? '—'}</dd>
                <dt className="text-muted-foreground">Pasta de gravação</dt><dd className="font-mono">{system?.recordingsRoot ?? '—'}</dd>
                <dt className="text-muted-foreground">Uso do disco</dt><dd>{discoPercent}%</dd>
                <dt className="text-muted-foreground">Câmeras</dt><dd>{cameras.length} · retenção {retencao ?? '—'}</dd>
                {nuvem ? (<>
                  <dt className="text-muted-foreground">Nuvem</dt><dd>{nuvem.provider}{nuvem.bucket ? ` · ${nuvem.bucket}` : ''}{nuvem.endpoint ? <span className="font-mono"> · {nuvem.endpoint}</span> : null}</dd>
                  <dt className="text-muted-foreground">Só na nuvem</dt><dd>{formatarBytes(visao?.totals.cloudOnlyBytes ?? 0)} (disco já liberado)</dd>
                </>) : null}
              </dl>
              {isAdmin ? <PreviousStoragesCard apiUrl={API_URL} accessToken={accessToken} /> : null}
            </div>
          )}
        </section>
      </div>

      <Dialog open={configurarAberto} onOpenChange={setConfigurarAberto}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto p-0">
          <DialogHeader className="px-5 pt-5"><DialogTitle>Nuvem</DialogTitle></DialogHeader>
          <CloudStorageCard apiUrl={API_URL} accessToken={accessToken} onChange={() => setVersao((v) => v + 1)} />
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          {/* ATRITO PROPORCIONAL: apagar o acervo inteiro exige digitar APAGAR. */}
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar todas as gravações?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Isto remove <strong>todas</strong> as gravações e clipes exportados de{' '}
                  <strong>todas as câmeras</strong>. Não pode ser desfeito.
                </p>
                {visao ? (
                  <p className="rounded border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.08)] px-2 py-1.5 text-[hsl(var(--destructive))]">
                    Hoje são <strong>{visao.totals.recordings}</strong> gravação(ões), <strong>{formatarBytes(visao.totals.diskBytes)}</strong> no disco.
                  </p>
                ) : null}
                <p>
                  As cópias já enviadas para a <strong>nuvem não são apagadas</strong> por esta ação.
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
  );
}
