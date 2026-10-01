import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { CameraOff, Check, Hand, Loader2, RefreshCw, Trash2, Undo2, Maximize, Minimize } from 'lucide-react';
import { crossingArrow } from '../lib/perimeter-state';
import { describePerimeterPosition } from '../lib/perimeter-test';
import { LiveStreamPlayer } from './LiveStreamPlayer';
import { liveDetectionsPoller, type LiveDetection } from '../lib/live-detections-poller';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';

export type DetectionZone = {
  id: string;
  name: string;
  kind: 'include' | 'exclude' | 'line';
  points: number[][];
  /** Só em `line`: sentido PROIBIDO da travessia. */
  sentido?: 'ambos' | 'ab' | 'ba';
  /**
   * Quanto a região precisa "se mexer" para valer um alarme. Ausente = média
   * (o comportamento de sempre). Existe para resolver o dilema da árvore: com
   * liga/desliga só havia gravar folha o dia inteiro ou criar um ponto CEGO —
   * em `baixa`, a folha para de disparar e a pessoa continua sendo vista.
   */
  sensitivity?: 'alta' | 'media' | 'baixa';
  color?: string;
};

type Props = {
  cameraId: string;
  cameraName: string;
  configurationRevision?: string;
  initialZones?: DetectionZone[] | null;
  onSaved?: (zones: DetectionZone[], configurationRevision?: string, applyStatus?: string) => void;
  onDirtyChange?: (dirty: boolean, drawing: boolean) => void;
  readOnly?: boolean;
  testing?: boolean;
  simulationMode?: 'motion' | 'object';
  ignoredMotion?: { zone: string; at: number } | null;
};

const API_URL = getApiBaseUrl();
const MAX_ZONES = 12;
const MAX_POINTS = 40;

// Cores fixas por tipo: excluir = vermelho (não monitorado), incluir = verde.
const ZONE_COLOR = {
  exclude: { stroke: 'hsl(0,72%,55%)', fill: 'hsl(0,72%,55%,0.22)' },
  include: { stroke: 'hsl(150,60%,45%)', fill: 'hsl(150,60%,45%,0.20)' },
  // Âmbar para a linha: não é área monitorada nem ignorada — é um limite que
  // não se atravessa. Cor distinta evita confundir com as duas zonas de área.
  line: { stroke: 'hsl(38,92%,55%)', fill: 'none' },
} as const;

/**
 * Editor visual de zonas de detecção.
 *
 * O operador desenha polígonos SOBRE a imagem real da câmera (snapshot), e as
 * coordenadas são gravadas NORMALIZADAS (0..1) — assim a zona continua correta
 * se a resolução do stream de análise mudar.
 *
 * - Excluir: o movimento ali é ignorado (árvore, rua pública, céu).
 * - Incluir: havendo ao menos uma, só o interior delas é monitorado.
 */
export function DetectionZonesEditor({ cameraId, cameraName, configurationRevision, initialZones, onSaved, onDirtyChange, readOnly = false, testing = false, simulationMode = 'motion', ignoredMotion }: Props) {
  // BASE do "Desfazer alterações": o último estado CONFIRMADO pelo servidor.
  // Antes o botão revertia para `initialZones`, que vem do pai e não é
  // recarregado após salvar — desenhar 3 zonas, salvar e clicar em "Desfazer"
  // devolvia a tela a zero e desabilitava o Salvar, enquanto o servidor seguia
  // com as 3 zonas. O operador saía convencido de que havia revertido.
  const baseRef = useRef<DetectionZone[]>(initialZones ?? []);
  const accessToken = useAuthStore((state) => state.accessToken);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const panDrag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const [testMessage, setTestMessage] = useState('Arraste sobre a imagem para simular movimento.');
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const previousTracks = useRef(new Map<number, { point: number[]; at: number }>());
  const previousSimulation = useRef<number[] | null>(null);
  const lastMessage = useRef('');
  const lastMessageAt = useRef(0);
  const [zones, setZones] = useState<DetectionZone[]>(initialZones ?? []);
  const [drawing, setDrawing] = useState<number[][] | null>(null);
  // A ferramenta abre no MODO DAS ZONAS JÁ SALVAS. Antes ela nascia sempre em
  // 'exclude': quem salvava "Monitorar só aqui", saía e voltava, via "Ignorar
  // área" aceso e concluía — com razão — que o modo salvo tinha virado o
  // oposto (a zona no banco estava certa; o susto era só da ferramenta).
  const ferramentaInicial = (zs: DetectionZone[] | null | undefined): 'include' | 'exclude' | 'line' => {
    if (zs?.some((z) => z.kind === 'include')) return 'include';
    if (zs?.length && zs.every((z) => z.kind === 'line')) return 'line';
    return 'exclude';
  };
  const [drawKind, setDrawKind] = useState<'include' | 'exclude' | 'line'>(() => ferramentaInicial(initialZones));
  const [saving, setSaving] = useState(false);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [posterStatus, setPosterStatus] = useState<'loading' | 'retrying' | 'empty' | 'ready'>('loading');
  const posterRetryTimerRef = useRef<number | null>(null);
  const posterLoadTimeoutRef = useRef<number | null>(null);
  const posterRetryCountRef = useRef(0);
  const posterFreshRetryDoneRef = useRef(false);
  // ── A CAIXA TEM DE TER A PROPORÇÃO DA CÂMERA ─────────────────────────────
  //
  // A caixa era fixa em 16:9 e a imagem entrava com `object-cover`, que CORTA
  // para preencher. Só que as coordenadas do desenho são 0–100% DA CAIXA, e a
  // caixa mostrava um recorte da imagem: numa câmera 4:3, a linha desenhada no
  // meio da tela era gravada como "meio", mas o detector — que analisa o quadro
  // INTEIRO — encontrava esse "meio" em outro lugar da cena.
  //
  // Resultado: a linha de travessia não ficava onde o operador a desenhou, e
  // nada na tela indicava isso.
  //
  // Adotando a proporção real da imagem, ela preenche a caixa exatamente: sem
  // corte, sem tarja, e 0–100% da caixa passa a ser 0–100% da imagem.
  const [proporcao, setProporcao] = useState('16 / 9');
  const [dirty, setDirty] = useState(false);
  const announce = useCallback((message: string) => {
    if (message !== lastMessage.current || Date.now() - lastMessageAt.current > 2500) {
      setTestMessage(message);
      lastMessage.current = message;
      lastMessageAt.current = Date.now();
    }
  }, []);
  useEffect(() => {
    setZoom(1); setPan({ x: 0, y: 0 }); setPanMode(false); panDrag.current = null;
    previousTracks.current.clear(); previousSimulation.current = null;
  }, [cameraId, testing]);
  useEffect(() => {
    if (testing) setTestMessage(simulationMode === 'object' ? 'Simulando detecção de objeto.' : 'Arraste sobre a imagem para simular movimento.');
  }, [testing, simulationMode]);
  useEffect(() => {
    if (!testing || !ignoredMotion || Date.now() / 1000 - ignoredMotion.at > 5) return;
    announce(`Movimento ignorado em ${ignoredMotion.zone}`);
  }, [testing, ignoredMotion?.at, ignoredMotion?.zone, announce]);
  useEffect(() => {
    if (!testing) return;
    const timer = window.setInterval(() => {
      const video = sceneRef.current?.querySelector('video');
      if (video?.videoWidth && video.videoHeight) setProporcao(`${video.videoWidth} / ${video.videoHeight}`);
    }, 500);
    return () => window.clearInterval(timer);
  }, [testing]);
  useEffect(() => {
    if (!testing) { setDetections([]); return; }
    return liveDetectionsPoller.subscribe(cameraId, (items, recent = []) => {
      setDetections(items.length ? items : recent);
      const now = Date.now();
      for (const [id, value] of previousTracks.current) if (now - value.at > 2000) previousTracks.current.delete(id);
      for (const item of items) {
        if (!item.frameWidth || !item.frameHeight) continue;
        const point = [(item.bbox[0] + item.bbox[2]) / (2 * item.frameWidth), Math.max(item.bbox[1], item.bbox[3]) / item.frameHeight];
        const previous = item.trackId == null ? null : previousTracks.current.get(item.trackId)?.point ?? null;
        const message = describePerimeterPosition(previous, point, zones, item.type === 'MOTION_DETECTED' ? 'movimento' : 'objeto');
        announce(message);
        if (item.trackId != null) previousTracks.current.set(item.trackId, { point, at: now });
      }
    });
  }, [testing, cameraId, zones, announce]);
  useEffect(() => {
    if (!testing) return;
    const timer = window.setInterval(() => {
      setDetections(items => items.some(item => item.recent && (item.expiresAtMs ?? 0) <= Date.now())
        ? items.filter(item => !item.recent || (item.expiresAtMs ?? 0) > Date.now()) : items);
    }, 100);
    return () => window.clearInterval(timer);
  }, [testing]);
  useEffect(() => {
    if (!testing || !accessToken) return;
    const sessionId = `perimeter-test-${crypto.randomUUID()}`;
    const send = (action: 'start' | 'heartbeat' | 'stop') => axios.post<{ status?: string }>(
      `${API_URL}/ai/live-view/${action}/${cameraId}`,
      { sessionId, ttlSeconds: 20, viewMode: 'selected', simulationMode },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 8000 },
    ).then(({ data }) => {
      if (action !== 'stop' && data?.status !== 'started' && data?.status !== 'renewed') {
        announce('Não foi possível iniciar a detecção nesta câmera. Confira se a imagem está disponível.');
      }
    }).catch(() => {
      if (action !== 'stop') announce('Não foi possível iniciar a detecção. Você ainda pode testar o desenho das regras.');
    });
    void send('start');
    const timer = window.setInterval(() => { void send('heartbeat'); }, 7000);
    return () => { window.clearInterval(timer); void send('stop'); };
  }, [testing, accessToken, cameraId, simulationMode, announce]);
  const userId = useAuthStore((state) => state.user?.id);
  const draftKey = `perimeter-draft:${userId}:${cameraId}`;
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const history = useRef<DetectionZone[][]>([]);
  const drag = useRef<{ id: string; index: number } | null>(null);
  const posterObjectUrl = useRef<string | null>(null);
  const posterAbort = useRef<AbortController | null>(null);
  const remember = () => { history.current = [...history.current.slice(-29), structuredClone(zones)]; };
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    editorShellRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('keydown', close); previous?.focus(); };
  }, [expanded]);
  useEffect(() => { onDirtyChange?.(dirty || drawing !== null, drawing !== null); }, [dirty, drawing, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || drawing !== null) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, drawing]);
  useEffect(() => () => {
    posterAbort.current?.abort();
    if (posterObjectUrl.current) URL.revokeObjectURL(posterObjectUrl.current);
  }, []);

  useEffect(() => {
    if (dirty || drawing !== null) return;
    setZones(initialZones ?? []);
    baseRef.current = initialZones ?? [];
    setDirty(false);
    // Troca de câmera = editor renasce: a ferramenta acompanha o modo salvo
    // da câmera nova (mesma razão do estado inicial acima).
    setDrawKind(ferramentaInicial(initialZones));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialZones, cameraId]);

  useEffect(() => {
    if (readOnly) return;
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
      if (draft && Array.isArray(draft.zones) && Date.now() - draft.at < 86400000) {
        setZones(draft.zones); setDrawing(draft.drawing ?? null); setDirty(true);
        if (['line', 'include', 'exclude'].includes(draft.kind)) setDrawKind(draft.kind);
        toast({ title: 'Desenho recuperado', description: 'Suas alterações ainda não foram salvas. Confira antes de aplicar.' });
      }
    } catch { /* Armazenamento indisponível não impede a edição. */ }
  }, [draftKey]);
  useEffect(() => {
    if (readOnly || (!dirty && drawing === null)) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ zones, drawing, kind: drawKind, at: Date.now() })); } catch { /* Sem espaço: a proteção ao sair continua ativa. */ }
  }, [draftKey, zones, drawing, dirty, drawKind, readOnly]);

  // Snapshot da câmera como pano de fundo (mesmo poster usado no live).
  // O servidor devolve o último frame salvo em disco quando o RTSP recente
  // falha. Ainda assim a rede pode cair entre receber a URL e carregar a
  // imagem: neste caso não deixamos o ícone de imagem quebrada aparecer e
  // tentamos novamente com backoff, sem obrigar o operador a sair e voltar.
  const loadPoster = useCallback(async (fresh = false): Promise<boolean> => {
    if (!accessToken) return false;
    posterAbort.current?.abort();
    const controller = new AbortController();
    posterAbort.current = controller;
    try {
      const { data } = await axios.post<{ streamToken: string }>(`${API_URL}/camera-stream/${cameraId}/token`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000, signal: controller.signal,
      });
      if (!data?.streamToken) throw new Error('Token de imagem ausente');
      const params = new URLSearchParams({ token: data.streamToken, v: String(Date.now()) });
      if (fresh) params.set('fresh', '1');
      const response = await axios.get(`${API_URL}/camera-stream/${cameraId}/poster?${params.toString()}`, { responseType: 'blob', timeout: 10000, signal: controller.signal });
      if (controller.signal.aborted) return true;
      const url = URL.createObjectURL(response.data);
      if (posterObjectUrl.current) URL.revokeObjectURL(posterObjectUrl.current);
      posterObjectUrl.current = url;
      setCapturedAt(response.headers['x-poster-generated-at'] ?? null);
      setPosterUrl(url);
      return true;
    } catch {
      if (controller.signal.aborted) return true;
      return false;
    }
  }, [accessToken, cameraId]);

  const schedulePosterRetry = useCallback(() => {
    if (posterRetryTimerRef.current !== null) window.clearTimeout(posterRetryTimerRef.current);
    if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
    const attempt = posterRetryCountRef.current++;
    // O editor não pode manter o operador preso numa tela preta por quase um
    // minuto quando a câmera ou a rota do snapshot não responde. Uma segunda
    // tentativa já cobre uma falha transitória; depois mostramos um estado
    // claro e deixamos a nova tentativa sob controle do operador.
    if (attempt >= 1) {
      setPosterStatus('empty');
      return;
    }
    setPosterStatus('retrying');
    const delay = 1_500;
    posterRetryTimerRef.current = window.setTimeout(() => {
      void loadPoster(true).then((ok) => {
        if (!ok) schedulePosterRetry();
      });
    }, delay);
  }, [loadPoster]);

  useEffect(() => {
    posterRetryCountRef.current = 0;
    posterFreshRetryDoneRef.current = false;
    setPosterUrl(null);
    setPosterStatus('loading');
    void loadPoster(false).then((ok) => {
      if (!ok) schedulePosterRetry();
    });
    return () => {
      if (posterRetryTimerRef.current !== null) window.clearTimeout(posterRetryTimerRef.current);
      if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
    };
  }, [cameraId, loadPoster, schedulePosterRetry]);

  // Uma URL de <img> pode ficar pendurada em uma conexão intermediária sem
  // disparar `onerror`. Não deixamos o editor virar um retângulo preto eterno:
  // após 7 s ele solicita o poster novamente, com frame recente quando houver.
  useEffect(() => {
    if (!posterUrl || posterStatus === 'ready') return;
    if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
    posterLoadTimeoutRef.current = window.setTimeout(() => {
      setPosterUrl(null);
      schedulePosterRetry();
    }, 7_000);
    return () => {
      if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
    };
  }, [posterUrl, posterStatus, schedulePosterRetry]);

  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const el = sceneRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return [Number(x.toFixed(4)), Number(y.toFixed(4))];
  }, []);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!drawing || panMode || readOnly || posterStatus !== 'ready') return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    setDrawing((current) => {
      if (!current) return current;
      // A linha tem exatamente 2 pontos: fechar sozinha no segundo clique
      // evita o passo extra de "confirmar" algo que já está completo.
      if (drawKind === 'line' && current.length >= 2) return current;
      if (current.length >= MAX_POINTS) {
        toast({ title: 'Limite de pontos', description: `Máximo de ${MAX_POINTS} pontos por zona.`, variant: 'destructive' });
        return current;
      }
      return [...current, point];
    });
  }, [drawing, panMode, toNormalized, drawKind, readOnly, posterStatus]);

  const finishDrawing = useCallback(() => {
    if (!drawing) return;
    // Exigências OPOSTAS: área com 2 pontos tem espessura zero (nunca dispara);
    // linha com 3 não diz qual trecho é a travessia nem para onde aponta a seta.
    if (drawKind === 'line' && drawing.length !== 2) {
      toast({ title: 'Linha incompleta', description: 'Marque o início e o fim da linha (2 pontos).', variant: 'destructive' });
      return;
    }
    if (drawKind !== 'line' && drawing.length < 3) {
      toast({ title: 'Zona incompleta', description: 'Marque pelo menos 3 pontos para fechar a área.', variant: 'destructive' });
      return;
    }
    const kindLabel = drawKind === 'exclude' ? 'Ignorar' : drawKind === 'include' ? 'Monitorar' : 'Linha';
    const sameKind = zones.filter((z) => z.kind === drawKind).length + 1;
    remember();
    setZones((current) => [
      ...current,
      {
        id: `zone-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: `${kindLabel} ${sameKind}`,
        kind: drawKind,
        points: drawing,
        ...(drawKind === 'line' ? { sentido: 'ambos' as const } : {}),
      },
    ]);
    setDrawing(null);
    setDirty(true);
  }, [drawing, drawKind, zones]);

  const save = useCallback(async () => {
    if (!accessToken || readOnly) return;
    if (zones.some((z) => z.kind === 'line' && !crossingArrow(z.points))) {
      toast({ title: 'Ajuste a linha', description: 'Os dois pontos da linha precisam estar separados.' });
      return;
    }
    setSaving(true);
    try {
      const { data } = await axios.patch(`${API_URL}/cameras/${cameraId}/detection-zones`, {
        detectionZones: zones,
        expectedDetectionZones: baseRef.current,
      }, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setDirty(false);
      try { sessionStorage.removeItem(draftKey); } catch { /* Sem armazenamento local. */ }
      // O que acabou de ser gravado passa a ser a base do desfazer.
      baseRef.current = zones;
      history.current = [];
      onSaved?.(zones, typeof data?.updatedAt === 'string' ? data.updatedAt : undefined, typeof data?.aiApplyStatus === 'string' ? data.aiApplyStatus : undefined);
      const temArea = zones.some((z) => z.kind === 'include' || z.kind === 'exclude');
      toast({
        title: 'Regras salvas',
        description: zones.length
          ? `${zones.length} regra(s) salvas.${temArea ? ' As áreas também valem para movimento e linhas.' : ''}`
          : 'Desenhos removidos. A câmera inteira será considerada quando a detecção estiver ligada.',
      });
    } catch (error) {
      const conflict = axios.isAxiosError(error) && error.response?.status === 409;
      const serverMessage = axios.isAxiosError<{ message?: string | string[] }>(error) ? error.response?.data?.message : null;
      const detail = Array.isArray(serverMessage) ? serverMessage[0] : serverMessage;
      toast({
        title: conflict ? 'O perímetro mudou em outra sessão' : 'Falha ao salvar zonas',
        description: conflict
          ? 'Seu desenho foi preservado. Recarregue a página e confira as alterações antes de tentar novamente.'
          : detail || 'Não foi possível guardar as alterações. Seu desenho foi preservado; tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }, [accessToken, cameraId, onSaved, zones, readOnly, draftKey]);

  const polygonPoints = useCallback((points: number[][]) => (
    points.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' ')
  ), []);

  const hasInclude = useMemo(() => zones.some((z) => z.kind === 'include'), [zones]);
  const hasExclude = useMemo(() => zones.some((z) => z.kind === 'exclude'), [zones]);
  const startDrawing = (kind: DetectionZone['kind']) => {
    if (zones.length >= MAX_ZONES) {
      toast({ title: 'Limite de zonas', description: `Máximo de ${MAX_ZONES} zonas por câmera.`, variant: 'destructive' });
      return;
    }
    if (posterStatus !== 'ready') {
      toast({ title: 'Aguarde a imagem da câmera', description: 'O desenho estará disponível assim que a imagem carregar.' });
      return;
    }
    setDrawKind(kind);
    setPanMode(false);
    setDrawing([]);
  };

  return (
    <div ref={editorShellRef} tabIndex={expanded ? -1 : undefined} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `Editor ampliado de ${cameraName}` : undefined} className={expanded ? 'fixed inset-0 z-50 overflow-auto bg-background p-5 space-y-3 outline-none' : 'space-y-3 rounded-xl border border-border bg-card/50 p-3 sm:p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{testing ? `Vídeo ao vivo · teste de ${simulationMode === 'object' ? 'objeto' : 'movimento'}` : capturedAt && Number.isFinite(Date.parse(capturedAt)) ? `Imagem capturada em ${new Date(capturedAt).toLocaleString('pt-BR')}` : 'Horário da captura não informado'}</span>
        <div className="flex gap-2">
          {!testing && <button className="btn btn-secondary btn-sm" onClick={() => { posterRetryCountRef.current = 0; setPosterStatus('loading'); void loadPoster(true).then((ok) => { if (!ok) schedulePosterRetry(); }); }}><RefreshCw className="h-4 w-4" /> Atualizar imagem</button>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const next = Math.max(1, Number((zoom - 0.5).toFixed(1))); setZoom(next); setPanMode(next > 1); setPan({ x: 0, y: 0 }); }} disabled={zoom === 1} aria-label="Reduzir zoom">−</button>
          <span className="self-center tabular-nums">{zoom.toFixed(1)}×</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setZoom(Math.min(4, Number((zoom + 0.5).toFixed(1)))); setPan({ x: 0, y: 0 }); setPanMode(true); }} disabled={zoom === 4} aria-label="Ampliar zoom">+</button>
          {zoom > 1 && <button type="button" className={`btn btn-sm ${panMode ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={panMode} onClick={() => setPanMode((current) => !current)} title={panMode ? 'Arraste a imagem para mover; clique para voltar ao desenho' : 'Clique para mover a imagem ampliada'}><Hand className="h-4 w-4" /> Mover</button>}
          <button className="btn btn-secondary btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}{expanded ? 'Reduzir' : 'Ampliar'}</button>
        </div>
      </div>
      {!testing && <fieldset disabled={readOnly || saving} className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="segment flex-wrap" aria-label="Escolha o tipo de regra para desenhar">
          <button
            type="button"
            disabled={drawing !== null}
            onClick={() => startDrawing('exclude')}
            className={`seg-btn ${drawing !== null && drawKind === 'exclude' ? 'active' : ''}`}
            title="Área onde a detecção é DESCARTADA (rua movimentada, galhos, um outdoor)."
          >
            Ignorar movimento
          </button>
          <button
            type="button"
            disabled={drawing !== null}
            onClick={() => startDrawing('include')}
            className={`seg-btn ${drawing !== null && drawKind === 'include' ? 'active' : ''}`}
            title="A detecção passa a valer SÓ dentro desta área — todo o resto é ignorado."
          >
            Limitar movimento à área
          </button>
          <button
            type="button"
            disabled={drawing !== null}
            onClick={() => startDrawing('line')}
            className={`seg-btn ${drawing !== null && drawKind === 'line' ? 'active' : ''}`}
            title="Limite que não deve ser atravessado: dispara quando um objeto cruza a linha."
          >
            Criar linha
          </button>
        </div>

        {drawing ? (
          <>
            <button type="button" onClick={finishDrawing} className="btn btn-primary btn-sm">
              <Check className="h-3.5 w-3.5" />
              {drawKind === 'line' ? `Confirmar linha (${drawing.length}/2)` : `Fechar área (${drawing.length} pontos)`}
            </button>
            <button type="button" onClick={() => setDrawing(null)} className="btn btn-secondary btn-sm">
              Cancelar
            </button>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-[10px] text-[hsl(var(--status-warning))]">alterações não salvas</span>}
          <button type="button" onClick={() => { if (drawing?.length) setDrawing(drawing.slice(0, -1)); else { const previous = history.current.pop(); if (previous) { setZones(previous); setDirty(true); } } }} className="btn btn-secondary btn-sm"><Undo2 className="h-4 w-4" /> Desfazer ação</button>
          <button type="button" data-perimeter-save onClick={() => void save()} disabled={saving || !dirty || drawing !== null} className="btn btn-primary btn-sm disabled:opacity-45">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Salvar zonas
          </button>
        </div>
      </fieldset>}

      {/* Ajuda contextual: explica o modo selecionado na própria tela, para o
          operador não precisar adivinhar o que cada botão faz. */}
      {!testing && <div className="flex items-start gap-2 rounded-md bg-background/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <span
          className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ background: ZONE_COLOR[drawKind].stroke }}
        />
        <span>
          {drawing === null ? 'Escolha Ignorar movimento, Limitar movimento à área ou Criar linha para desenhar diretamente sobre a câmera.' : drawKind === 'exclude' && (
            <>
              <strong className="font-medium text-foreground">Área ignorada:</strong>{' '}
              O movimento dentro do desenho será ignorado. O restante da imagem continua monitorado.
            </>
          )}
          {drawing !== null && drawKind === 'include' && (
            <>
              <strong className="font-medium text-foreground">Área monitorada:</strong>{' '}
              Marque o espaço que importa. Com essa regra, somente as áreas marcadas serão consideradas.
            </>
          )}
          {drawing !== null && drawKind === 'line' && (
            <>
              <strong className="font-medium text-foreground">Linha de perímetro:</strong>{' '}
              Marque o início e o fim do limite. A seta mostra o sentido de passagem entre os lados A e B. Selecione um desenho para arrastar seus pontos.
            </>
          )}
        </span>
      </div>}

      <div
        ref={containerRef}
        onClick={handleClick}
        className={`relative mx-auto w-full ${expanded ? 'max-w-none' : 'max-w-[640px]'} overflow-hidden rounded-lg border border-border bg-black ${drawing ? 'cursor-crosshair' : 'cursor-default'}`}
        style={{ aspectRatio: proporcao }}
        aria-label={`Editor de zonas de ${cameraName}`}
      >
        <div ref={sceneRef} className="absolute inset-0" style={{ transform: zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : undefined, transformOrigin: 'center center' }}>
        {testing ? <LiveStreamPlayer cameraId={cameraId} cameraName={cameraName} className="h-full w-full" liveViewMode="selected" muted showOverlay={false} aiEnabled={false} /> : posterUrl ? (
          <img
            src={posterUrl}
            alt=""
            // `object-fill` é seguro AQUI e só aqui: a caixa já assumiu a
            // proporção da imagem, então não há deformação — e garante que não
            // sobre nem tarja nem corte entre a imagem e a área de desenho.
            className="absolute inset-0 h-full w-full object-fill opacity-80"
            draggable={false}
            onLoad={(e) => {
              if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setProporcao(`${img.naturalWidth} / ${img.naturalHeight}`);
              }
              setPosterStatus('ready');
              posterRetryCountRef.current = 0;
              // A primeira resposta pode ser o snapshot antigo salvo no disco
              // enquanto o servidor busca o frame recente. Uma nova consulta
              // curta troca automaticamente para o atual, sem recarregar a tela.
              if (!posterFreshRetryDoneRef.current) {
                posterFreshRetryDoneRef.current = true;
                posterRetryTimerRef.current = window.setTimeout(() => { void loadPoster(true); }, 2500);
              }
            }}
            onError={() => {
              if (posterLoadTimeoutRef.current !== null) window.clearTimeout(posterLoadTimeoutRef.current);
              setPosterUrl(null); // esconde o ícone nativo de imagem quebrada
              schedulePosterRetry();
            }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_35%,hsl(var(--muted)_/_0.38),transparent_55%)] px-5 text-center text-white/55">
            {posterStatus === 'loading' || posterStatus === 'retrying'
              ? <RefreshCw className="h-5 w-5 animate-spin text-white/45" aria-hidden="true" />
              : <CameraOff className="h-6 w-6 text-white/45" aria-hidden="true" />}
            <span className="text-xs">
              {posterStatus === 'loading' ? 'Carregando imagem da câmera…'
                : posterStatus === 'retrying' ? 'Reconectando à câmera…'
                  : 'Ainda não há imagem salva para esta câmera.'}
            </span>
            {posterStatus === 'empty' && (
              <button
                type="button"
                onClick={() => {
                  posterRetryCountRef.current = 0;
                  setPosterStatus('retrying');
                  void loadPoster(true).then((ok) => { if (!ok) schedulePosterRetry(); });
                }}
                className="rounded border border-white/20 bg-black/30 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/10"
              >
                Tentar novamente
              </button>
            )}
          </div>
        )}

        {!testing && posterUrl && posterStatus !== 'ready' && (
          <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-black/25">
            <span className="inline-flex items-center gap-2 rounded-md bg-black/65 px-3 py-1.5 text-xs text-white/80">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Carregando imagem da câmera…
            </span>
          </div>
        )}

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className={`absolute inset-0 z-10 h-full w-full transition-opacity ${testing || posterStatus === 'ready' ? 'opacity-100' : 'opacity-0'} ${zoom > 1 && panMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
          aria-hidden={!testing && posterStatus !== 'ready'}
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            if (zoom > 1 && panMode) {
              event.currentTarget.setPointerCapture(event.pointerId);
              panDrag.current = { x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y };
              return;
            }
            if (!testing) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            previousSimulation.current = null;
          }}
          onPointerMove={(event) => {
            if (panDrag.current) {
              const box = containerRef.current;
              if (!box) return;
              const limitX = (zoom - 1) * box.clientWidth / 2;
              const limitY = (zoom - 1) * box.clientHeight / 2;
              const drag = panDrag.current;
              setPan({
                x: Math.max(-limitX, Math.min(limitX, drag.startX + event.clientX - drag.x)),
                y: Math.max(-limitY, Math.min(limitY, drag.startY + event.clientY - drag.y)),
              });
              return;
            }
            if (testing && event.currentTarget.hasPointerCapture(event.pointerId)) {
              const point = toNormalized(event.clientX, event.clientY);
              if (point) {
                announce(describePerimeterPosition(previousSimulation.current, point, zones, 'simulação'));
                previousSimulation.current = point;
              }
              return;
            }
            if (!drag.current || readOnly || saving) return;
            const point = toNormalized(event.clientX, event.clientY);
            if (!point) return;
            const { id, index } = drag.current;
            setZones((current) => current.map((z) => z.id === id ? { ...z, points: z.points.map((p, i) => i === index ? point : p) } : z));
            setDirty(true);
          }}
          onPointerUp={() => { drag.current = null; panDrag.current = null; previousSimulation.current = null; }}
          onPointerCancel={() => { drag.current = null; panDrag.current = null; previousSimulation.current = null; }}
        >
          {/* A seta é o que torna o sentido COMPREENSÍVEL: "ab" e "ba" não
              significam nada sozinhos — a ponta na tela mostra qual é qual. */}
          <defs>
            <marker id="seta-linha" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={ZONE_COLOR.line.stroke} />
            </marker>
          </defs>
          {zones.map((zone) => (zone.kind === 'line' ? (
            <g key={zone.id} onClick={() => { if (!drawing) setSelectedZone(zone.id); }}>
              <line
                x1={zone.points[0][0] * 100} y1={zone.points[0][1] * 100}
                x2={zone.points[1][0] * 100} y2={zone.points[1][1] * 100}
                stroke={ZONE_COLOR.line.stroke}
                strokeWidth={selectedZone === zone.id ? 0.8 : 0.5}
              />
              {(() => { const arrow = crossingArrow(zone.points); return arrow ? <g pointerEvents="none">
                <line {...arrow} stroke={ZONE_COLOR.line.stroke} strokeWidth={0.4} markerEnd={zone.sentido !== 'ba' ? 'url(#seta-linha)' : undefined} markerStart={zone.sentido !== 'ab' ? 'url(#seta-linha)' : undefined} />
                <text x={arrow.x1} y={arrow.y1 - 1.5} fontSize="2.5" fill="white">A</text><text x={arrow.x2} y={arrow.y2 + 3} fontSize="2.5" fill="white">B</text>
                <text x={(zone.points[0][0] + zone.points[1][0]) * 50} y={(zone.points[0][1] + zone.points[1][1]) * 50 - 2.5} textAnchor="middle" fontSize="2.8" fill="white" stroke="black" strokeWidth="0.7" paintOrder="stroke">{zone.name}</text>
              </g> : null; })()}
              {zone.points.map(([x, y], i) => (
                <circle key={i} cx={x * 100} cy={y * 100} r={0.9} fill={ZONE_COLOR.line.stroke} />
              ))}
            </g>
          ) : (
            <g key={zone.id} onClick={() => { if (!drawing) setSelectedZone(zone.id); }}>
              <polygon points={polygonPoints(zone.points)} fill={ZONE_COLOR[zone.kind].fill} stroke={ZONE_COLOR[zone.kind].stroke} strokeWidth={selectedZone === zone.id ? 0.7 : 0.3} />
              <text x={zone.points.reduce((s, p) => s + p[0], 0) / zone.points.length * 100} y={zone.points.reduce((s, p) => s + p[1], 0) / zone.points.length * 100} textAnchor="middle" fontSize="2.8" fill="white" stroke="black" strokeWidth="0.7" paintOrder="stroke" pointerEvents="none">{zone.name}</text>
            </g>
          )))}
          {!drawing && !panMode && !readOnly && zones.filter((z) => z.id === selectedZone).flatMap((zone) => zone.points.map(([x, y], index) => (
            <g key={`${zone.id}-${index}`}>
              <circle cx={x * 100} cy={y * 100} r={2.4} fill="transparent" stroke="none" className="cursor-move" tabIndex={0} role="button" aria-label={`Mover ponto ${index + 1} de ${zone.name}`}
                onPointerDown={(event) => { if (saving) return; event.stopPropagation(); remember(); drag.current = { id: zone.id, index }; event.currentTarget.setPointerCapture(event.pointerId); }}
                onKeyDown={(event) => {
                  const delta = event.shiftKey ? 0.01 : 0.0025;
                  const movimento: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
                  const passo = movimento[event.key];
                  if (!passo || saving || readOnly) return;
                  event.preventDefault(); remember();
                  setZones((current) => current.map((item) => item.id === zone.id ? { ...item, points: item.points.map((p, i) => i === index ? [Math.max(0, Math.min(1, p[0] + passo[0])), Math.max(0, Math.min(1, p[1] + passo[1]))] : p) } : item));
                  setDirty(true);
                }} />
              <circle cx={x * 100} cy={y * 100} r={1.1} fill="white" stroke={ZONE_COLOR[zone.kind].stroke} strokeWidth={0.3} pointerEvents="none" />
            </g>
          )))}
          {drawing && drawing.length > 0 && (
            <>
              <polyline
                points={polygonPoints(drawing)}
                fill="none"
                stroke={ZONE_COLOR[drawKind].stroke}
                strokeWidth={0.4}
                strokeDasharray="2 1"
                vectorEffect="non-scaling-stroke"
              />
              {drawing.map(([x, y], index) => (
                <circle key={index} cx={x * 100} cy={y * 100} r={0.8} fill={ZONE_COLOR[drawKind].stroke} />
              ))}
            </>
          )}
          {testing && detections.filter((d) => d.frameWidth && d.frameHeight).map((d) => <rect key={d.id} x={d.bbox[0] / d.frameWidth! * 100} y={d.bbox[1] / d.frameHeight! * 100} width={(d.bbox[2] - d.bbox[0]) / d.frameWidth! * 100} height={(d.bbox[3] - d.bbox[1]) / d.frameHeight! * 100} fill="none" stroke={d.recent ? '#9ca3af' : '#38bdf8'} strokeDasharray={d.recent ? '1 .5' : undefined} strokeWidth=".4" pointerEvents="none" />)}
        </svg>
        </div>

        {drawing && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-[10px] text-white/80">
            {drawKind === 'line'
              ? 'Clique no INÍCIO e no FIM da linha · 2 pontos'
              : 'Clique para marcar os cantos da área · mínimo 3 pontos'}
          </div>
        )}
      </div>

      {testing && <div role="status" aria-live="polite" className="mx-auto max-w-[640px] rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <p className="font-medium">{testMessage}</p>
        {detections.some(item => item.recent) && <p className="mt-1 text-muted-foreground">O contorno cinza mostra onde houve movimento há pouco.</p>}
        <p className="mt-1 text-muted-foreground">{simulationMode === 'object' ? 'As caixas azuis mostram objetos reconhecidos nas classes liberadas pelo plano.' : 'Arraste sobre o vídeo para conferir a geometria; as caixas azuis mostram movimento detectado.'} Este teste é temporário, não muda o modo de gravação e não gera ações por si só.</p>
      </div>}

      {!testing && (zones.length || dirty || drawing !== null) ? (
        <fieldset disabled={readOnly || saving} className="space-y-1.5">
          {zones.map((zone) => (
            <div key={zone.id} onClick={() => setSelectedZone(zone.id)} className={`flex flex-wrap items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 ${selectedZone === zone.id ? 'border-primary' : 'border-border'}`}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ZONE_COLOR[zone.kind].stroke }} />
              <input
                value={zone.name}
                aria-label="Nome da regra"
                onFocus={remember}
                onChange={(event) => {
                  const name = event.target.value.slice(0, 64);
                  setZones((current) => current.map((z) => (z.id === zone.id ? { ...z, name } : z)));
                  setDirty(true);
                }}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
              {zone.kind === 'line' ? (
                /* O sentido só faz sentido junto da seta no desenho acima —
                   por isso os rótulos falam de "início" e "fim" da linha, não
                   de "entrar" e "sair", que dependeriam de como ela foi
                   desenhada. */
                <select
                  value={zone.sentido ?? 'ambos'}
                  onChange={(event) => {
                    remember();
                    const sentido = event.target.value as 'ambos' | 'ab' | 'ba';
                    setZones((current) => current.map((z) => (z.id === zone.id ? { ...z, sentido } : z)));
                    setDirty(true);
                  }}
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px]"
                  aria-label={`Sentido proibido da linha ${zone.name}`}
                >
                  <option value="ambos">Qualquer sentido</option>
                  <option value="ab">Do lado A para B →</option>
                  <option value="ba">Do lado B para A ←</option>
                </select>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                    {zone.kind === 'exclude' ? 'ignorada' : 'monitorada'} · {zone.points.length} pontos
                  </span>
                  {/* Sensibilidade da região monitorada. Resolve o dilema da árvore: em
                      "baixa", folha ao vento para de gravar mas quem passa ali
                      continua sendo visto — antes só havia vigiar ou cegar. */}
                  {zone.kind === 'include' && <select
                    value={zone.sensitivity ?? 'media'}
                    onChange={(e) => {
                      remember();
                      const valor = e.target.value as 'alta' | 'media' | 'baixa';
                      setZones((current) =>
                        current.map((z) => (z.id === zone.id ? { ...z, sensitivity: valor } : z)),
                      );
                      setDirty(true);
                    }}
                    title="Quanto a região precisa se mexer para valer um alarme"
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px]"
                  >
                    <option value="alta">Sensibilidade alta</option>
                    <option value="media">Sensibilidade média</option>
                    <option value="baixa">Sensibilidade baixa</option>
                  </select>}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  remember();
                  setZones((current) => current.filter((z) => z.id !== zone.id));
                  setDirty(true);
                }}
                className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--destructive)_/_0.12)] hover:text-[hsl(var(--destructive))]"
                title="Remover zona"
                aria-label={`Remover ${zone.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            data-perimeter-discard
            onClick={() => {
              setZones(baseRef.current);
              history.current = [];
              try { sessionStorage.removeItem(draftKey); } catch { /* Sem armazenamento local. */ }
              setDrawing(null);
              setDirty(false);
            }}
            className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
            Desfazer alterações
          </button>
        </fieldset>
      ) : !testing ? (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Sem zonas: a câmera inteira é monitorada. Use <strong>Ignorar movimento</strong> para excluir rua, árvores ou céu —
          áreas que costumam gerar alarme falso.
        </p>
      ) : null}

      {hasInclude && (
        <p className="rounded-md border border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.08)] px-2.5 py-1.5 text-[11px] text-[hsl(var(--status-warning))]">
          Há zona do tipo <strong>monitorar</strong>: as regras de perímetro e movimento consideram apenas o interior dela.
          {hasExclude ? ' As áreas vermelhas continuam excluídas mesmo quando se sobrepõem à área monitorada.' : ''}
        </p>
      )}
    </div>
  );
}
