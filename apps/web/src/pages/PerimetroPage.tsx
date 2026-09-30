import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';
import { perimeterState, type PerimeterProcessor } from '../lib/perimeter-state';
import { CameraEditSheet } from '../components/CameraEditSheet';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '../components/ui/alert-dialog';
import { useLocation } from 'wouter';
import { ShieldAlert, EyeOff } from 'lucide-react';
import { SeletorDeCamera } from '../components/SeletorDeCamera';
import { IlustracaoPerimetro } from '../components/IlustracaoPerimetro';
import { DetectionZonesEditor, type DetectionZone } from '../components/DetectionZonesEditor';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useClassesLiberadas } from '../hooks/use-classes-liberadas';

// ── PÁGINA DE PERÍMETRO — linha e zona de detecção, por câmera ──────────────
//
// Você DESENHA aqui mesmo, sobre o SNAPSHOT da câmera (não o vídeo ao vivo): o
// snapshot é confiável (aparece mesmo com o streaming instável) e é a MESMA
// imagem que a detecção vê. Antes esta tela mostrava o player ao vivo, que
// ficava preto quando o stream falhava — e sem imagem não dá para desenhar.
//
// O que é cada coisa:
//   · Linha       — um limite que não se atravessa (tripwire), com sentido.
//   · Monitorar   — área onde a detecção vale.
//   · Ignorar     — área que a detecção descarta (galho, rua movimentada).

type ResumoPerimetro = { linhas: number; monitorar: number; ignorar: number };

function resumir(zones: Array<{ kind: string }> | undefined): ResumoPerimetro {
  const r: ResumoPerimetro = { linhas: 0, monitorar: 0, ignorar: 0 };
  for (const z of zones ?? []) {
    if (z.kind === 'line') r.linhas += 1;
    else if (z.kind === 'include') r.monitorar += 1;
    else if (z.kind === 'exclude') r.ignorar += 1;
  }
  return r;
}

const temPerimetro = (r: ResumoPerimetro) => r.linhas + r.monitorar + r.ignorar > 0;
export default function PerimetroPage() {
  const [location, setLocation] = useLocation();
  const userRole = useAuthStore((state) => state.user?.role ?? 'viewer');
  const cameras = useVmsDataStore((state) => state.cameras);
  const token = useAuthStore((state) => state.accessToken);
  const [processors, setProcessors] = useState<Record<string, PerimeterProcessor>>({});
  const [checked, setChecked] = useState(false);
  const [healthError, setHealthError] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(300);
  const [dirty, setDirty] = useState(false);
  const [drawingActive, setDrawingActive] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const saveThenLeave = useRef(false);
  const [testing, setTesting] = useState(false);
  const [simulationMode, setSimulationMode] = useState<'motion' | 'object'>('motion');
  const { classes: classesLiberadas, motionAllowed: podeSimularMovimento, carregando: carregandoClasses } = useClassesLiberadas();
  const podeSimularObjeto = classesLiberadas.length > 0;
  useEffect(() => {
    if (!podeSimularMovimento && podeSimularObjeto) setSimulationMode('object');
    else if (!podeSimularObjeto && simulationMode === 'object') setSimulationMode('motion');
  }, [podeSimularMovimento, podeSimularObjeto, simulationMode]);
  const [aplicacoes, setAplicacoes] = useState<Record<string, { revision: string; since: number }>>({});
  const [revisoesPorCamera, setRevisoesPorCamera] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const guard = (action: () => void) => {
    if (dirty) { pendingRef.current = action; setPending(() => action); }
    else { setTesting(false); action(); }
  };
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const { data } = await axios.get(`${getApiBaseUrl()}/ai/health`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000, signal: controller.signal });
        if (!cancelled) { setProcessors(data?.processors ?? {}); setChecked(true); setHealthError(false); }
      } catch { if (!cancelled) { setHealthError(true); setChecked(false); } }
      if (!cancelled) timer = setTimeout(poll, testing ? 2000 : 10000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [token, userRole, testing]);
  useEffect(() => {
    if (!dirty) return;
    const intercept = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || event.ctrlKey || event.metaKey || anchor.target === '_blank' || anchor.origin !== window.location.origin || anchor.pathname === window.location.pathname) return;
      event.preventDefault(); event.stopPropagation();
      const action = () => setLocation(anchor.pathname + anchor.search + anchor.hash);
      pendingRef.current = action; setPending(() => action);
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [dirty, setLocation]);

  // Estado local do resumo por câmera: começa do store e é atualizado quando o
  // editor salva, para a lista lateral refletir na hora sem recarregar tudo.
  const [zonasPorCamera, setZonasPorCamera] = useState<Record<string, DetectionZone[]>>({});
  const [groupFilter, setGroupFilter] = useState('__all__');
  useEffect(() => { setPage(0); }, [search, filter, groupFilter]);

  const lista = useMemo(
    () => cameras
      .filter((camera) => camera.enabled)
      .map((camera) => {
        const zonas = zonasPorCamera[camera.id]
          ?? (camera.detectionZones as DetectionZone[] | undefined)
          ?? [];
        return { camera, zonas, resumo: resumir(zonas) };
      })
      .sort((a, b) =>
        Number(temPerimetro(b.resumo)) - Number(temPerimetro(a.resumo))
        || Number(b.camera.isOnline) - Number(a.camera.isOnline)
        || a.camera.name.localeCompare(b.camera.name, 'pt-BR')),
    [cameras, zonasPorCamera],
  );
  const groupFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(lista.map((item) => item.camera.floor).filter((group) => group && group !== '-')))],
    [lista],
  );
  const listaFiltrada = useMemo(
    () => groupFilter === '__all__' ? lista : lista.filter((item) => item.camera.floor === groupFilter),
    [groupFilter, lista],
  );

  const [selectedCamId, setSelectedCamId] = useState(() => {
    try { return sessionStorage.getItem('perimeter-selected-camera') ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try { if (selectedCamId) sessionStorage.setItem('perimeter-selected-camera', selectedCamId); } catch { /* Preferência opcional. */ }
  }, [selectedCamId]);
  const appliedRequest = useRef<string | null>(null);

  const requestedCameraId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('cameraId');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  useEffect(() => {
    if (!listaFiltrada.length) { setSelectedCamId(''); return; }
    if (requestedCameraId && appliedRequest.current !== requestedCameraId && listaFiltrada.some((i) => i.camera.id === requestedCameraId)) {
      appliedRequest.current = requestedCameraId;
      setSelectedCamId((cur) => (cur === requestedCameraId ? cur : requestedCameraId));
      return;
    }
    if (!selectedCamId || !listaFiltrada.some((i) => i.camera.id === selectedCamId)) {
      setSelectedCamId(listaFiltrada[0].camera.id);
    }
  }, [listaFiltrada, requestedCameraId, selectedCamId]);

  const selecionada = listaFiltrada.find((i) => i.camera.id === selectedCamId) ?? null;
  const totalComPerimetro = listaFiltrada.filter((i) => temPerimetro(i.resumo)).length;
  const termo = search.toLocaleLowerCase('pt-BR').trim();
  const visible = listaFiltrada.filter(({ camera, resumo }) =>
    [camera.name, camera.code, camera.floor].some((valor) => String(valor ?? '').toLocaleLowerCase('pt-BR').includes(termo)) &&
    (filter === 'all' || (filter === 'empty'
      ? !temPerimetro(resumo)
      : !camera.aiEnabled || !camera.alarmsEnabled || Boolean(aplicacoes[camera.id]) || perimeterState(camera.isOnline, resumo.linhas > 0, processors[camera.id], checked).attention)));
  const pageCount = Math.max(1, Math.ceil(visible.length / 30));
  const currentPage = Math.min(page, pageCount - 1);
  const selectedState = selecionada ? !selecionada.camera.aiEnabled
    ? { label: 'Detecção desligada', attention: true, tone: 'warning' as const }
    : selecionada.camera.status === 'no_signal'
    ? { label: 'Verificando vídeo', attention: true, tone: 'checking' as const }
    : perimeterState(selecionada.camera.isOnline, selecionada.resumo.linhas > 0, processors[selecionada.camera.id], checked) : null;
  useEffect(() => {
    setAplicacoes((atuais) => {
      let mudou = false;
      const proximas = { ...atuais };
      for (const [cameraId, aplicacao] of Object.entries(atuais)) {
        if (processors[cameraId]?.configuration_revision === aplicacao.revision) {
          delete proximas[cameraId];
          mudou = true;
        }
      }
      return mudou ? proximas : atuais;
    });
  }, [processors]);
  const aplicacaoSelecionada = selecionada ? aplicacoes[selecionada.camera.id] : undefined;
  const aplicacaoDemorada = Boolean(aplicacaoSelecionada && Date.now() - aplicacaoSelecionada.since > 30_000);
  const estadoExibido = aplicacaoSelecionada
    ? { label: aplicacaoDemorada ? 'Salvo, mas ainda não atualizado' : 'Atualizando regras…', tone: aplicacaoDemorada ? 'warning' as const : 'checking' as const }
    : healthError
      ? { label: 'Não foi possível verificar a detecção', tone: 'checking' as const }
      : selecionada && !temPerimetro(selecionada.resumo)
        ? { label: 'Sem regra de perímetro', tone: 'warning' as const }
      : selectedState?.tone === 'ok' && selecionada && !selecionada.camera.alarmsEnabled
        ? { label: 'Detecção ligada · alertas desligados', tone: 'warning' as const }
        : selectedState?.tone === 'ok'
          ? { label: 'Detecção ligada · alertas ligados', tone: 'ok' as const }
          : { label: selectedState?.label ?? 'Verificando detecção', tone: selectedState?.tone ?? 'checking' as const };

  // ── Sem nenhuma câmera ativa ────────────────────────────────────────────
  if (!lista.length) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="ops-card w-full max-w-lg overflow-hidden">
          <div className="border-b border-border px-8 py-6 text-center">
            <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-[hsl(var(--muted-foreground))]" />
            <h1 className="text-[17px] font-semibold">Nenhuma câmera disponível para perímetro</h1>
            <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted-foreground">
              Não há câmera ativa acessível para configurar. Cadastre ou ative uma câmera para começar.
            </p>
            {/* Sem câmera, o lugar da imagem ficava vazio e ninguém entendia o
                que iria desenhar ali. O exemplo mostra o resultado antes de
                existir a primeira câmera. */}
            <div className="mx-auto mt-5 w-full max-w-sm overflow-hidden rounded-lg border border-border">
              <IlustracaoPerimetro className="block h-auto w-full" />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Assim ficará sobre a imagem da sua câmera.
            </p>
          </div>
          <div className="flex justify-center gap-2 px-8 py-4">
            <button type="button" onClick={() => setLocation('/live')} className="btn btn-secondary btn-sm">Voltar ao Ao Vivo</button>
            {userRole !== 'viewer' && (
              <button type="button" onClick={() => setLocation('/cameras')} className="btn btn-primary btn-sm">Ver câmeras</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Cabeçalho */}
      <div className="page-hdr flex-wrap gap-3">
        <div>
          <p className="page-sub">
            Defina travessias e áreas de detecção sobre a imagem da câmera ·{' '}
            {totalComPerimetro} de {listaFiltrada.length} configurada(s)
          </p>
        </div>
        <div className="w-[min(100%,320px)]">
          <SeletorDeCamera
            cameras={listaFiltrada.map((item) => item.camera)}
            value={selectedCamId}
            onChange={(id) => guard(() => setSelectedCamId(id))}
            placeholder="Selecione uma câmera"
            className="h-10 w-full"
            vazio="Nenhuma câmera ativa."
          />
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col gap-5 overflow-y-auto p-4 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--perimeter-sidebar)] lg:items-start lg:gap-5" style={{ '--perimeter-sidebar': `${width}px` } as CSSProperties}>
        {/* Editor: DESENHA aqui, sobre o snapshot da câmera */}
        <div className="mx-auto w-full max-w-[760px] min-w-0 shrink-0" ref={editorRef}>
          {selecionada && <div className="mb-4 rounded-xl border border-border bg-card/70 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Configuração de perímetro</p>
                <h1 className="truncate text-base font-semibold">{selecionada.camera.name}</h1>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] ${estadoExibido.tone === 'ok' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : estadoExibido.tone === 'warning' ? 'border-amber-500/25 bg-amber-500/10 text-amber-400' : 'border-border bg-muted/40 text-muted-foreground'}`}>{estadoExibido.label}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{selecionada.resumo.linhas + selecionada.resumo.monitorar + selecionada.resumo.ignorar} {selecionada.resumo.linhas + selecionada.resumo.monitorar + selecionada.resumo.ignorar === 1 ? 'regra' : 'regras'}</span>
              <span>Gravação {({ continuous: 'contínua', motion: 'por movimento', object: 'por objeto', schedule: 'programada', manual: 'manual' })[selecionada.camera.recordingMode]}</span>
              <span>Alertas {selecionada.camera.alarmsEnabled ? 'ligados' : 'desligados'}</span>
              {selecionada.resumo.linhas > 0 && <span>Objetos {selecionada.camera.aiObjectClasses.length ? selecionada.camera.aiObjectClasses.join(', ') : 'conforme licença'}</span>}
            </div>
            {temPerimetro(selecionada.resumo) && <div className="mt-3 rounded-lg border border-border bg-background/45 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {selecionada.resumo.linhas > 0 && <p><strong className="text-foreground">Travessia:</strong> usa objetos rastreados e o sentido definido em cada linha.</p>}
              {(selecionada.resumo.monitorar > 0 || selecionada.resumo.ignorar > 0) && <p><strong className="text-foreground">Áreas:</strong> limitam onde movimento e travessias podem valer.</p>}
              <p><strong className="text-foreground">Resposta:</strong> eventos são registrados; {selecionada.camera.alarmsEnabled ? 'esta câmera permite alarmes, sujeitos às regras e silenciamentos ativos.' : 'os alarmes desta câmera estão desligados.'}</p>
            </div>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className="btn btn-primary btn-sm" disabled={dirty || (!podeSimularMovimento && !podeSimularObjeto)} title={dirty ? 'Salve ou descarte o desenho antes de simular' : (!podeSimularMovimento && !podeSimularObjeto) ? 'O plano não possui detecção liberada' : undefined} onClick={() => setTesting(!testing)}>{testing ? 'Voltar ao desenho' : 'Simular regras nesta câmera'}</button>
              <div className="segment" aria-label="O que mostrar na simulação">
                <button type="button" className={`seg-btn ${simulationMode === 'motion' ? 'active' : ''}`} aria-pressed={simulationMode === 'motion'} disabled={!podeSimularMovimento} title={!podeSimularMovimento ? 'Detecção de movimento não disponível neste plano' : undefined} onClick={() => setSimulationMode('motion')}>Movimento</button>
                <button type="button" className={`seg-btn ${simulationMode === 'object' ? 'active' : ''}`} aria-pressed={simulationMode === 'object'} disabled={!podeSimularObjeto} title={!podeSimularObjeto ? (carregandoClasses ? 'Verificando os recursos do plano' : 'Detecção de objeto não disponível neste plano') : 'Simular caixas de pessoa, veículo e demais classes liberadas'} onClick={() => setSimulationMode('object')}>Objeto</button>
              </div>
              {userRole === 'admin' && <button className="btn btn-secondary btn-sm" onClick={() => guard(() => setEditing(true))}>Detecção e ações</button>}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Escolha Movimento ou Objeto e teste ao vivo. A gravação da câmera continua como está.</p>
          </div>}
          {selecionada && (
            <DetectionZonesEditor
              key={selecionada.camera.id}
              cameraId={selecionada.camera.id}
              cameraName={selecionada.camera.name}
              configurationRevision={revisoesPorCamera[selecionada.camera.id] ?? selecionada.camera.updatedAt}
              initialZones={selecionada.zonas}
              onDirtyChange={(hasChanges, drawingNow) => { setDirty(hasChanges); setDrawingActive(drawingNow); }}
              readOnly={userRole !== 'admin' || testing}
              testing={testing}
              simulationMode={simulationMode}
              ignoredMotion={processors[selecionada.camera.id]?.motion_detector?.perimeter_ignored_motion}
              onSaved={(zones, configurationRevision, applyStatus) => {
                setZonasPorCamera((prev) => ({ ...prev, [selecionada.camera.id]: zones }));
                if (configurationRevision) {
                  setRevisoesPorCamera((prev) => ({ ...prev, [selecionada.camera.id]: configurationRevision }));
                  if (selecionada.camera.aiEnabled) {
                    const falhou = applyStatus === 'failed' || applyStatus === 'disabled' || applyStatus === 'camera_disabled';
                    setAplicacoes((prev) => ({ ...prev, [selecionada.camera.id]: { revision: configurationRevision, since: falhou ? Date.now() - 31_000 : Date.now() } }));
                  }
                }
                setDirty(false);
                if (saveThenLeave.current) { saveThenLeave.current = false; setPending(null); setTesting(false); pendingRef.current?.(); pendingRef.current = null; }
              }}
            />
          )}
          {selecionada && !selecionada.camera.aiEnabled && !testing && (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              As regras desta câmera estão desligadas no dia a dia. Você pode testá-las acima sem mudar a câmera.
            </p>
          )}
        </div>

        {/* Frota: quem já tem perímetro, quem não tem */}
        <aside className="relative flex min-h-0 shrink-0 flex-col lg:sticky lg:top-0 lg:max-h-[calc(100vh-160px)]">
          <div role="separator" aria-label="Ajustar largura da lista de câmeras" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={520} aria-valuenow={width} tabIndex={0} className="absolute -left-3 top-0 bottom-0 hidden w-2 cursor-col-resize rounded bg-primary/30 hover:bg-primary/70 lg:block"
            onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setWidth((w) => Math.max(240, Math.min(520, w + (e.key === 'ArrowLeft' ? 20 : -20)))); } }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setWidth(Math.max(240, Math.min(520, e.currentTarget.parentElement!.getBoundingClientRect().right - e.clientX))); }} />
          <div className="mb-2 shrink-0 space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[hsl(var(--muted-foreground))]">Câmeras</div>
            <input aria-label="Buscar câmera" placeholder="Buscar câmera…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs" />
            <Select value={groupFilter} onValueChange={(value) => guard(() => setGroupFilter(value))}>
              <SelectTrigger aria-label="Filtrar por grupo" className="h-8 text-xs"><SelectValue placeholder="Todos os grupos" /></SelectTrigger>
              <SelectContent>
                {groupFilters.map((group) => <SelectItem key={group} value={group} className="text-xs">{group === '__all__' ? 'Todos os grupos' : group}</SelectItem>)}
              </SelectContent>
            </Select>
            <select aria-label="Filtrar por situação" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full rounded-lg border border-border bg-background p-2 text-xs"><option value="all">Todas as situações</option><option value="empty">Sem configuração</option><option value="attention">Precisam de atenção</option></select>
          </div>
          <div className="min-h-0 max-h-[420px] flex-1 space-y-1.5 overflow-y-auto pr-1 lg:max-h-none">
            {visible.slice(currentPage * 30, (currentPage + 1) * 30).map(({ camera, resumo }) => {
              const ativa = camera.id === selectedCamId;
              return (
                <button
                  key={camera.id}
                  type="button"
                  onClick={() => guard(() => setSelectedCamId(camera.id))}
                  aria-pressed={ativa}
                  title={camera.name}
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    ativa
                      ? 'border-[hsl(var(--primary)_/_0.5)] bg-[hsl(var(--primary)_/_0.08)]'
                      : 'border-border bg-background/55 hover:bg-background'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${camera.isOnline ? 'status-online' : 'status-offline'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">{camera.name}</span>
                    <span className="block text-[10px] text-muted-foreground">{!camera.aiEnabled ? 'Detecção desligada' : healthError ? 'Detecção não verificada' : camera.status === 'no_signal' ? 'Verificando vídeo' : perimeterState(camera.isOnline, resumo.linhas > 0, processors[camera.id], checked).label}</span>
                    <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                      {temPerimetro(resumo) ? <ResumoInline resumo={resumo} /> : 'sem perímetro'}
                    </span>
                  </span>
                  {!camera.aiEnabled && (
                    <span title="Detecção desligada nesta câmera">
                      <EyeOff className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    </span>
                  )}
                </button>
              );
            })}
            {!visible.length && <p className="p-3 text-xs text-muted-foreground">Nenhuma câmera corresponde aos filtros.</p>}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs"><button className="btn btn-secondary btn-sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Anterior</button><span>{currentPage + 1} / {pageCount} · {visible.length}</span><button className="btn btn-secondary btn-sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Próxima</button></div>

        </aside>
      </div>
      <CameraEditSheet camera={selecionada?.camera ?? null} open={editing} onClose={() => setEditing(false)} />
      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) { setPending(null); pendingRef.current = null; saveThenLeave.current = false; } }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Guardar seu desenho?</AlertDialogTitle><AlertDialogDescription>Há alterações não salvas. Se estiver desenhando uma área, conclua o desenho antes de salvar.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <button className="btn btn-secondary" onClick={() => { setPending(null); pendingRef.current = null; saveThenLeave.current = false; }}>Continuar editando</button>
            <button className="btn btn-secondary" onClick={() => { editorRef.current?.querySelector<HTMLButtonElement>('[data-perimeter-discard]')?.click(); setDirty(false); setPending(null); setTesting(false); pendingRef.current?.(); pendingRef.current = null; }}>Descartar</button>
            <button className="btn btn-primary" disabled={drawingActive} title={drawingActive ? 'Conclua ou cancele o desenho atual' : undefined} onClick={() => { const button = editorRef.current?.querySelector<HTMLButtonElement>('[data-perimeter-save]'); if (button && !button.disabled) { saveThenLeave.current = true; button.click(); } }}>Salvar e continuar</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResumoInline({ resumo }: { resumo: ResumoPerimetro }) {
  const partes: string[] = [];
  if (resumo.linhas) partes.push(`${resumo.linhas} linha${resumo.linhas > 1 ? 's' : ''}`);
  if (resumo.monitorar) partes.push(`${resumo.monitorar} monitorar`);
  if (resumo.ignorar) partes.push(`${resumo.ignorar} ignorar`);
  return <>{partes.join(' · ')}</>;
}
