import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Circle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  FolderOpen,
  Grid2X2,
  Grid3X3,
  LayoutGrid,
  Maximize2,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { CameraTile } from '../components/CameraTile';
import { LiveStreamPlayer, type LivePlayerStatus } from '../components/LiveStreamPlayer';
import { Camera, SavedLayout, useVmsDataStore } from '../store/vmsDataStore';
import { getLiveDisplayId, liveDisplayLabel, useGridStore, GridSize, type LiveDisplayId } from '../store/gridStore';
import { useLiveDisplays } from '../hooks/use-live-displays';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../hooks/use-toast';
import { useAutoHideControls } from '../hooks/use-auto-hide-controls';
import { countVisibleGridCameras } from '../lib/live-grid-count';
import { ToastAction } from '@/components/ui/toast';

// Grades aprovadas para operação. Manter os formatos previsíveis evita layouts
// improvisados que viram uma parede ilegível em monitores menores.
const GRID_PRESETS: { size: GridSize; icon: ReactNode }[] = [
  { size: '1x1', icon: <Monitor className="w-3.5 h-3.5" /> },
  { size: '2x2', icon: <Grid2X2 className="w-3.5 h-3.5" /> },
  { size: '3x3', icon: <Grid3X3 className="w-3.5 h-3.5" /> },
  { size: '4x4', icon: <Grid3X3 className="w-3.5 h-3.5" /> },
  { size: '5x5', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { size: '6x6', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
];

const GRID_MIN = 1;
const GRID_MAX = 8; // limite por dimensão
const GRID_CELL_WARN = 16; // acima disso, avisa sobre CPU (transcode H.265)
// Limite operacional deliberado. "Preencher" jamais abre todas as câmeras de
// uma instalação grande: abre no máximo 36, mesmo que existam centenas.
const FILL_GRID_MAX_CAMERAS = 36;
// A câmera única usa o perfil original, separado do perfil leve da grade.
// Aquecemos SOMENTE a última câmera que o operador selecionou e por uma janela
// curta: isso elimina a abertura RTSP fria no duplo clique sem transformar toda
// a grade em dezenas de conexões de máxima resolução.
const ORIGINAL_PREWARM_MS = 20_000;
// Se a origem não responder neste prazo, a tela única tenta por conta própria
// e mostra a falha normal do player. Até lá, o operador continua vendo o vídeo
// leve, em vez de uma tela vazia.
const ORIGINAL_PREWARM_MAX_WAIT_MS = 12_000;
const LIVE_PANEL_AUTO_COLLAPSE_WIDTH = 1100;
const LIVE_PANEL_WIDTH_STORAGE_KEY = 'drac.live.camera-panel-width.v1';
const LIVE_PANEL_MIN_WIDTH = 220;
const LIVE_PANEL_MAX_WIDTH = 480;

function loadLivePanelWidth() {
  try {
    const stored = Number(window.localStorage.getItem(LIVE_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored)
      ? Math.max(LIVE_PANEL_MIN_WIDTH, Math.min(LIVE_PANEL_MAX_WIDTH, Math.round(stored)))
      : 280;
  } catch {
    return 280;
  }
}

/** Colunas × linhas de uma grade "CxL", com limites (1..8). */
function gridDims(size: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/.exec(String(size));
  const clamp = (n: number) => Math.min(GRID_MAX, Math.max(GRID_MIN, n || GRID_MIN));
  return { cols: clamp(m ? parseInt(m[1], 10) : 2), rows: clamp(m ? parseInt(m[2], 10) : 2) };
}
const STATUS_FILTERS = ['all', 'online', 'recording', 'motion', 'alarm', 'offline', 'no_signal', 'maintenance'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'Todos',
  online: 'Online',
  recording: 'Gravando',
  motion: 'Movimento',
  alarm: 'Alarme',
  offline: 'Offline',
  no_signal: 'Sem sinal',
  maintenance: 'Manutenção',
};

const LIVE_LAYOUTS_STORAGE_KEY = 'drac.live.layouts.v1';
const streamStartDelay = (slotIndex: number, totalSlots: number) => {
  if (totalSlots < 4) return 0;
  // Distribui a emissão de tokens e os handshakes. O limite antigo de 1,5 s
  // fazia dezenas de câmeras iniciarem juntas em grades grandes.
  const stepMs = totalSlots >= 16 ? 200 : totalSlots >= 9 ? 150 : 100;
  return slotIndex * stepMs;
};

type ApiLiveLayout = {
  id: string;
  name: string;
  gridSize: string;
  cameraIds: unknown;
  lastUsedAt?: string;
  createdAt?: string;
};

type PosterTokenItem = { cameraId: string; streamToken: string; posterUrl: string };

function mapApiLiveLayout(layout: ApiLiveLayout): SavedLayout | null {
  if (!/^[1-8]x[1-8]$/.test(layout.gridSize) || !Array.isArray(layout.cameraIds)) return null;
  return {
    id: layout.id,
    name: layout.name,
    gridSize: layout.gridSize as GridSize,
    cameraIds: layout.cameraIds.map(String),
    createdBy: useAuthStore.getState().user?.name ?? 'Operador',
    lastUsed: layout.lastUsedAt ?? layout.createdAt ?? new Date().toISOString(),
  };
}

function loadSavedLayouts(): SavedLayout[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LIVE_LAYOUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedLayout[];
    return Array.isArray(parsed)
      ? parsed.filter((layout) => layout && typeof layout.id === 'string' && Array.isArray(layout.cameraIds))
      : [];
  } catch {
    return [];
  }
}

function persistSavedLayouts(layouts: SavedLayout[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIVE_LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // A operação atual continua disponível mesmo sem cache do navegador.
  }
}

export default function LiveViewPage({ pageActive = true }: { pageActive?: boolean }) {
  const API_URL = getApiBaseUrl();
  const { toast } = useToast();
  const accessToken = useAuthStore((state) => state.accessToken);
  const allCameras = useVmsDataStore((state) => state.cameras);
  // Câmeras desativadas não aparecem no ao vivo (continuam na página Câmeras p/ reativar).
  const cameras = useMemo(() => allCameras.filter((camera) => camera.enabled !== false), [allCameras]);
  const loadData = useVmsDataStore((state) => state.load);
  const generatedLayouts = useVmsDataStore((state) => state.layouts);
  const displayId = getLiveDisplayId();
  const displayIndex = displayId === 'main' ? 0 : Number(displayId.slice(-1));
  const {
    gridSize: storedGridSize,
    cameraIds: storedCameraIds,
    wallMode,
    prevLayout,
    setGridSize: storeGridSize,
    setCameraIds: storeCameraIds,
    toggleWallMode,
    clearPrevLayout,
  } = useGridStore();
  // A ampliação é um estado visual temporário. A grade persistida nunca é
  // substituída por 1x1, portanto voltar restaura os mesmos quadros e posições.
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null);
  const focusedCameraIdRef = useRef(focusedCameraId);
  focusedCameraIdRef.current = focusedCameraId;
  // A ampliação não pode depender do estado que a grade venha a receber depois
  // (sincronização, cache legado, clique acidental). Guardamos o retrato exato
  // do operador antes do zoom para o botão Voltar sempre restaurar aquela grade.
  const focusReturnLayoutRef = useRef<{ gridSize: GridSize; cameraIds: string[] } | null>(null);
  const gridSize = storedGridSize;
  const cameraIds = storedCameraIds;
  const setGridSize = useCallback((size: GridSize) => { setFocusedCameraId(null); storeGridSize(size); }, [storeGridSize]);
  const setCameraIds = useCallback((ids: string[]) => { setFocusedCameraId(null); storeCameraIds(ids); }, [storeCameraIds]);
  const removeCameraById = useCallback((cameraId: string) => {
    storeCameraIds(useGridStore.getState().cameraIds.map(id => id === cameraId ? '' : id));
  }, [storeCameraIds]);
  const displayCoordination = useLiveDisplays(displayId, storedCameraIds, removeCameraById);
  const openAuxiliaryDisplay = useCallback((target: Exclude<LiveDisplayId, 'main'>) => {
    const storageKey = `drac.live.grid.${target}.v1`;
    if (!window.localStorage.getItem(storageKey)) {
      window.localStorage.setItem(storageKey, JSON.stringify({ gridSize: '3x2', cameraIds: [] }));
    }
    const url = new URL('/live', window.location.origin);
    url.searchParams.set('display', target);
    const popup = window.open(url.toString(), `drac-${target}`, 'popup=yes,width=1280,height=720');
    if (!popup) {
      toast({ title: 'O navegador bloqueou a tela auxiliar', description: 'Permita pop-ups para este endereço e tente novamente.', variant: 'destructive' });
      return;
    }
    popup.focus();
  }, [toast]);
  const handleWallMode = useCallback(() => {
    if (wallMode && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
      return;
    }
    if (!wallMode) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
      toggleWallMode();
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    toggleWallMode();
  }, [wallMode, toggleWallMode]);
  const [, setLocation] = useLocation();
  // Selo e botão do mural somem sozinhos depois de 3s parado.
  const muralControles = useAutoHideControls(wallMode);
  const [selectedCam, setSelectedCam] = useState<string | null>(null);
  const [prewarmCameraId, setPrewarmCameraId] = useState<string | null>(null);
  const [originalReadyCameraId, setOriginalReadyCameraId] = useState<string | null>(null);
  const gridOriginalSourcesRef = useRef<Record<string, boolean>>({});
  const prewarmTimeoutRef = useRef<number | null>(null);
  const prewarmFallbackTimeoutRef = useRef<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(loadLivePanelWidth);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('__all__');
  const [zoneFilter, setZoneFilter] = useState('__all__');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [recordingOverrides, setRecordingOverrides] = useState<Record<string, boolean>>({});
  const recordingCommandsInFlight = useRef(new Set<string>());
  const [recordingBusyIds, setRecordingBusyIds] = useState<string[]>([]);
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>(() => loadSavedLayouts());
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
  const [layoutSelectValue, setLayoutSelectValue] = useState('');
  const [layoutDialog, setLayoutDialog] = useState<{ mode: 'save' | 'rename'; id?: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedLayout | null>(null);
  const [sidebarPosterUrls, setSidebarPosterUrls] = useState<Record<string, string>>({});
  const lastSidebarPosterRetryAtRef = useRef(0);

  const beginPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (moveEvent: PointerEvent) => {
      // A alça fica na borda esquerda: arrastar para a esquerda alarga o painel.
      const next = Math.max(LIVE_PANEL_MIN_WIDTH, Math.min(LIVE_PANEL_MAX_WIDTH, startWidth + startX - moveEvent.clientX));
      setPanelWidth(next);
    };
    // O valor final precisa ser lido no encerramento, não o capturado pelo hook.
    const onUp = (upEvent: PointerEvent) => {
      const finalWidth = Math.max(LIVE_PANEL_MIN_WIDTH, Math.min(LIVE_PANEL_MAX_WIDTH, startWidth + startX - upEvent.clientX));
      setPanelWidth(finalWidth);
      try { window.localStorage.setItem(LIVE_PANEL_WIDTH_STORAGE_KEY, String(finalWidth)); } catch { /* preferência local */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [panelWidth]);

  const sidebarPosterCameraIdsKey = useMemo(
    () => cameras
      .filter((camera) => camera.canViewContent !== false)
      .map((camera) => camera.id)
      .sort()
      .join(','),
    [cameras],
  );

  const loadSidebarPosters = useCallback(async () => {
    if (!accessToken) return;
    const cameraIds = useVmsDataStore.getState().cameras
      .filter((camera) => camera.enabled !== false && camera.canViewContent !== false)
      .map((camera) => camera.id);
    if (!cameraIds.length) {
      setSidebarPosterUrls({});
      return;
    }
    try {
      const { data } = await axios.post<{ items: PosterTokenItem[] }>(
        `${API_URL}/camera-stream/poster-tokens`,
        { cameraIds },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const next: Record<string, string> = {};
      const version = Date.now();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const separator = item.posterUrl.includes('?') ? '&' : '?';
        next[item.cameraId] = `${item.posterUrl}${separator}token=${encodeURIComponent(item.streamToken)}&v=${version}`;
      }
      setSidebarPosterUrls(next);
    } catch {
      // Mantém a última imagem válida quando a API ou uma câmera oscila.
    }
  }, [API_URL, accessToken]);

  useEffect(() => {
    // O painel recolhido não gera trabalho de snapshot. Ao abrir, os tokens são
    // emitidos em um único lote; o navegador baixa somente as imagens visíveis.
    if (!panelOpen) return;
    if (!pageActive) return;
    void loadSidebarPosters();
    const renew = () => {
      if (document.visibilityState === 'visible') void loadSidebarPosters();
    };
    const timer = window.setInterval(renew, 4 * 60 * 1000);
    window.addEventListener('focus', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [loadSidebarPosters, pageActive, panelOpen, sidebarPosterCameraIdsKey]);

  const retrySidebarPoster = useCallback((cameraId: string) => {
    setSidebarPosterUrls((current) => {
      if (!current[cameraId]) return current;
      const next = { ...current };
      delete next[cameraId];
      return next;
    });
    // Muitas câmeras podem falhar juntas; limita a renovação do lote para não
    // transformar uma oscilação em uma tempestade de requisições.
    const now = Date.now();
    if (now - lastSidebarPosterRetryAtRef.current < 5_000) return;
    lastSidebarPosterRetryAtRef.current = now;
    void loadSidebarPosters();
  }, [loadSidebarPosters]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${accessToken}` };

    void (async () => {
      try {
        const response = await axios.get<ApiLiveLayout[]>(`${API_URL}/live-layouts`, { headers });
        if (cancelled) return;
        const remoteLayouts = response.data.map(mapApiLiveLayout).filter((layout): layout is SavedLayout => Boolean(layout));
        if (remoteLayouts.length) {
          const pendingLocal = loadSavedLayouts().filter(layout => layout.id.startsWith('local-'));
          const merged = [...remoteLayouts, ...pendingLocal.filter(layout => !remoteLayouts.some(remote => remote.id === layout.id))];
          setSavedLayouts(merged);
          persistSavedLayouts(merged);
          return;
        }

        const localLayouts = loadSavedLayouts();
        if (!localLayouts.length) return;
        // Trava de migração ÚNICA (sessionStorage cobre duas abas do mesmo
        // navegador): sem ela, duas abas de /live abertas com o servidor ainda
        // vazio migravam as duas — layouts duplicados no servidor.
        const TRAVA = 'drac-live-layouts-migrando';
        if (window.sessionStorage.getItem(TRAVA)) return;
        window.sessionStorage.setItem(TRAVA, String(Date.now()));
        const migrated = await Promise.all(localLayouts.map(async (layout) => {
          const created = await axios.post<ApiLiveLayout>(`${API_URL}/live-layouts`, {
            name: layout.name,
            gridSize: layout.gridSize,
            cameraIds: layout.cameraIds,
          }, { headers });
          return mapApiLiveLayout(created.data);
        }));
        if (cancelled) return;
        const valid = migrated.filter((layout): layout is SavedLayout => Boolean(layout));
        setSavedLayouts(valid);
        persistSavedLayouts(valid);
      } catch {
        // O cache local continua funcional durante indisponibilidade da API.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [API_URL, accessToken]);

  const zoneFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(cameras.map((camera) => camera.zone)))],
    [cameras],
  );
  // `floor` é o nome do grupo operacional exposto pelo contrato de câmeras.
  // Filtrar antes da lista impede que uma instalação com centenas de ativos
  // obrigue o operador a percorrer a lista inteira para montar uma grade.
  const groupFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(cameras.map((camera) => camera.floor).filter((group) => group && group !== '-')))],
    [cameras],
  );
  const selectedCameraObj = useMemo(
    () => (selectedCam ? cameras.find((camera) => camera.id === selectedCam) ?? null : null),
    [cameras, selectedCam],
  );
  const prewarmCamera = useMemo(
    () => (prewarmCameraId
      ? cameras.find((camera) => camera.id === prewarmCameraId) ?? null
      : null),
    [cameras, prewarmCameraId],
  );
  const availableLayouts = savedLayouts.length ? savedLayouts : generatedLayouts;

  // Migra somente uma ampliação realmente antiga que tenha deixado a grade
  // persistida em 1x1. Um snapshot de sessão antigo não pode sobrescrever uma
  // grade manual que o operador já montou nesta versão.
  useEffect(() => {
    if (!prevLayout) return;
    const current = useGridStore.getState();
    const dims = gridDims(current.gridSize);
    const currentIds = current.cameraIds.slice(0, dims.cols * dims.rows).filter(Boolean);
    if (current.gridSize === '1x1' && currentIds.length <= 1) {
      storeGridSize(prevLayout.gridSize);
      storeCameraIds(prevLayout.cameraIds);
    }
    clearPrevLayout();
  }, [prevLayout, storeGridSize, storeCameraIds, clearPrevLayout]);

  useEffect(() => {
    if (!storedCameraIds.length && cameras.length) {
      const onlineFirst = [...cameras].sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
      const initialCount = displayId === 'main' ? 4 : 6;
      if (displayId === 'main') storeCameraIds(onlineFirst.slice(0, initialCount).map((camera) => camera.id));
    }
  }, [storedCameraIds.length, cameras, displayId, storeCameraIds]);

  useEffect(() => {
    // Colapsa só ao CRUZAR o limiar (largo→estreito). A versão anterior rodava
    // em todo resize e, com a janela já estreita, fechava o painel que o
    // operador tinha acabado de abrir para escolher câmera — abrir DevTools ou
    // girar a tela bastava para perder o painel no meio da ação.
    let estavaLargo = window.innerWidth >= LIVE_PANEL_AUTO_COLLAPSE_WIDTH;
    const collapseWhenTight = () => {
      const estreitoAgora = window.innerWidth < LIVE_PANEL_AUTO_COLLAPSE_WIDTH;
      if (estreitoAgora && estavaLargo) setPanelOpen(false);
      estavaLargo = !estreitoAgora;
    };
    if (window.innerWidth < LIVE_PANEL_AUTO_COLLAPSE_WIDTH) setPanelOpen(false);
    window.addEventListener('resize', collapseWhenTight);
    return () => window.removeEventListener('resize', collapseWhenTight);
  }, []);

  // Reconcilia o override otimista de gravação com o estado real do servidor: assim
  // que camera.status reflete o valor esperado, o override é removido. Sem isso, um
  // override antigo teria precedência permanente e mostraria "Gravando" para sempre.
  useEffect(() => {
    setRecordingOverrides((current) => {
      if (!Object.keys(current).length) return current;
      let changed = false;
      const next = { ...current };
      for (const camera of cameras) {
        if (camera.id in next && camera.recordingMode === 'manual' && next[camera.id] === (camera.status === 'recording')) {
          delete next[camera.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cameras]);

  const { cols: gridCols, rows: gridRows } = gridDims(gridSize);
  const count = gridCols * gridRows;
  const visibleGridCols = focusedCameraId ? 1 : gridCols;
  const visibleGridRows = focusedCameraId ? 1 : gridRows;
  const cameraById = useMemo(() => new Map(cameras.map((camera) => [camera.id, camera])), [cameras]);
  const displayedCams = useMemo<(Camera | null)[]>(() => {
    // Dedupe: layouts antigos podem repetir a mesma câmera; a 2ª ocorrência vira
    // slot vazio (as keys da grade são por id — duplicado quebraria o React).
    const seen = new Set<string>();
    const slots: (Camera | null)[] = cameraIds.slice(0, count).map((id) => {
      const cam = cameraById.get(id) ?? null;
      if (!cam || seen.has(cam.id)) return null;
      seen.add(cam.id);
      return cam;
    });
    while (slots.length < count) slots.push(null);
    return slots;
  }, [cameraIds, count, cameraById]);

  // "Preencher": escolhe a menor grade que cabe as câmeras disponíveis, mas
  // nunca passa de 6×6. Uma instalação pode ter 1.000 ativos sem abrir 1.000
  // players, saturar o navegador e derrubar a experiência do operador.
  const fillGrid = useCallback(() => {
    const usedOnOtherDisplays = new Set(Object.values(displayCoordination.displays)
      .filter(item => item.displayId !== displayId && Date.now() - item.updatedAt <= 8_000)
      .flatMap(item => item.cameraIds));
    const available = cameras.filter(camera => !usedOnOtherDisplays.has(camera.id));
    const ordered = [...available].sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
    const n = Math.min(ordered.length, FILL_GRID_MAX_CAMERAS);
    const size: GridSize = n <= 1 ? '1x1' : n <= 4 ? '2x2' : n <= 9 ? '3x3' : n <= 16 ? '4x4' : n <= 25 ? '5x5' : '6x6';
    const { cols, rows } = gridDims(size);
    setGridSize(size);
    setCameraIds(ordered.slice(0, Math.min(cols * rows, FILL_GRID_MAX_CAMERAS)).map((c) => c.id));
  }, [cameras, displayCoordination.displays, displayId, setGridSize, setCameraIds]);

  const gridCameraCount = useMemo(
    () => countVisibleGridCameras(displayedCams, focusedCameraId),
    [displayedCams, focusedCameraId],
  );
  const alarmCount = useMemo(() => cameras.filter((c) => c.status === 'alarm').length, [cameras]);

  const filteredList = useMemo(() => {
      const q = search.toLowerCase();
      return cameras.filter((c) => {
        const matchSearch = !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.ipAddress.includes(q);
      const matchGroup = groupFilter === '__all__' || c.floor === groupFilter;
      const matchZona = zoneFilter === '__all__' || c.zone === zoneFilter;
      const matchStatus = statusFilter === 'all' || c.status === statusFilter;
      return matchSearch && matchGroup && matchZona && matchStatus;
    });
  }, [cameras, search, groupFilter, zoneFilter, statusFilter]);

  const zoomToCamera = useCallback((cameraId: string) => {
    if (!focusedCameraId) {
      const current = useGridStore.getState();
      const dims = gridDims(current.gridSize);
      focusReturnLayoutRef.current = {
        gridSize: current.gridSize,
        cameraIds: current.cameraIds.slice(0, dims.cols * dims.rows),
      };
    }
    setFocusedCameraId(cameraId);
  }, [focusedCameraId]);

  const restoreLayout = useCallback(() => {
    const previous = focusReturnLayoutRef.current;
    focusReturnLayoutRef.current = null;
    setFocusedCameraId(null);
    if (previous) {
      storeGridSize(previous.gridSize);
      storeCameraIds(previous.cameraIds);
    }
  }, [storeGridSize, storeCameraIds]);

  useEffect(() => {
    if (focusedCameraId && !displayedCams.some(cam => cam?.id === focusedCameraId)) restoreLayout();
  }, [displayedCams, focusedCameraId, restoreLayout]);

  // Esc volta para a grade anterior — exceto digitando num campo ou com diálogo
  // aberto (nesses casos o Esc pertence ao campo/diálogo).
  useEffect(() => {
    if (!pageActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (layoutDialog || deleteTarget) return;
      // No mural em tela cheia, Esc é a primeira tecla que todo operador tenta
      // — e não fazia nada (o botão "Sair" é pequeno e fica no canto).
      if (focusedCameraId) { restoreLayout(); return; }
      if (wallMode) { toggleWallMode(); return; }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // Esc com um popover/menu/diálogo Radix aberto pertence a ELE (fechá-lo),
      // não à página: sem esta guarda, fechar o popover "Layouts" também tirava
      // o operador do zoom 1×1 — dois efeitos para uma tecla.
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]')) return;
      restoreLayout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageActive, restoreLayout, layoutDialog, deleteTarget, focusedCameraId, wallMode, toggleWallMode]);

  const handleCamAction = useCallback((action: string, camera: Camera) => {
    if (action === 'playback') setLocation(`/playback?cameraId=${encodeURIComponent(camera.id)}`);
    if (action === 'ptz') setLocation(`/ptz?cameraId=${encodeURIComponent(camera.id)}`);
    if (action === 'info') setLocation(`/cameras?cameraId=${encodeURIComponent(camera.id)}`);
    if ((action === 'record-start' || action === 'record-stop') && (!accessToken || recordingCommandsInFlight.current.has(camera.id))) return;
    if (action === 'record-start' && camera.recordingMode === 'continuous') {
      toast({ title: 'Esta câmera já grava continuamente', description: 'Use a reprodução para consultar ou salvar um trecho.' });
      return;
    }
    if (action === 'record-start' || action === 'record-stop') {
      recordingCommandsInFlight.current.add(camera.id);
      setRecordingBusyIds(Array.from(recordingCommandsInFlight.current));
    }
    if (action === 'record-start') {
      void (async () => {
        setRecordingOverrides((current) => ({ ...current, [camera.id]: true }));
        try {
          const { data } = await axios.post(`${API_URL}/cameras/${camera.id}/recording/start`, {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          void loadData();
          if (data.status === 'already_recording' && camera.recordingMode === 'continuous') {
            setRecordingOverrides(current => { const next = { ...current }; delete next[camera.id]; return next; });
            toast({ title: 'Gravação contínua preservada' });
          } else {
            toast({ title: 'Gravação manual iniciada', description: `${camera.name} · para automaticamente em até 10 minutos.` });
            window.setTimeout(() => setRecordingOverrides(current => { const next = { ...current }; delete next[camera.id]; return next; }), 600_000);
          }
        } catch (error) {
          setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
          toast({ title: 'Erro ao iniciar gravação', description: error instanceof Error ? error.message : 'Falha ao iniciar gravação manual.', variant: 'destructive' });
        } finally {
          recordingCommandsInFlight.current.delete(camera.id);
          setRecordingBusyIds(Array.from(recordingCommandsInFlight.current));
        }
      })();
    }
    if (action === 'record-stop') {
      void (async () => {
        setRecordingOverrides((current) => ({ ...current, [camera.id]: false }));
        try {
          await axios.post(`${API_URL}/cameras/${camera.id}/recording/stop`, {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          void loadData();
          toast({ title: 'Gravação parada', description: camera.name });
        } catch (error) {
          setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
          toast({ title: 'Erro ao parar gravação', description: error instanceof Error ? error.message : 'Falha ao parar gravação manual.', variant: 'destructive' });
        } finally {
          recordingCommandsInFlight.current.delete(camera.id);
          setRecordingBusyIds(Array.from(recordingCommandsInFlight.current));
        }
      })();
    }
    if (action === 'fullscreen') {
      zoomToCamera(camera.id);
    }
  }, [API_URL, accessToken, loadData, setLocation, zoomToCamera, toast]);

  const stopOriginalPrewarm = useCallback(() => {
    if (prewarmTimeoutRef.current != null) {
      window.clearTimeout(prewarmTimeoutRef.current);
      prewarmTimeoutRef.current = null;
    }
    if (prewarmFallbackTimeoutRef.current != null) {
      window.clearTimeout(prewarmFallbackTimeoutRef.current);
      prewarmFallbackTimeoutRef.current = null;
    }
    setPrewarmCameraId(null);
    setOriginalReadyCameraId(null);
  }, []);

  const markGridSourceIsOriginal = useCallback((cameraId: string, isOriginal: boolean) => {
    gridOriginalSourcesRef.current = { ...gridOriginalSourcesRef.current, [cameraId]: isOriginal };
    if (isOriginal && focusedCameraIdRef.current === cameraId) setOriginalReadyCameraId(cameraId);
  }, []);

  const prewarmOriginal = useCallback((cameraId: string) => {
    // Nesta câmera a grade já confirmou que está no perfil físico principal.
    // Não há RTSP nem WebRTC para abrir: o próprio player só amplia o stream
    // existente, mantendo a máxima qualidade verdadeira.
    if (gridOriginalSourcesRef.current[cameraId]) {
      stopOriginalPrewarm();
      setOriginalReadyCameraId(cameraId);
      return;
    }
    if (prewarmTimeoutRef.current != null) window.clearTimeout(prewarmTimeoutRef.current);
    if (prewarmFallbackTimeoutRef.current != null) window.clearTimeout(prewarmFallbackTimeoutRef.current);
    setPrewarmCameraId(cameraId);
    setOriginalReadyCameraId(null);
    prewarmTimeoutRef.current = window.setTimeout(() => {
      prewarmTimeoutRef.current = null;
      setPrewarmCameraId(null);
    }, ORIGINAL_PREWARM_MS);
    prewarmFallbackTimeoutRef.current = window.setTimeout(() => {
      prewarmFallbackTimeoutRef.current = null;
      setOriginalReadyCameraId(cameraId);
    }, ORIGINAL_PREWARM_MAX_WAIT_MS);
  }, [stopOriginalPrewarm]);

  useEffect(() => () => {
    if (prewarmTimeoutRef.current != null) window.clearTimeout(prewarmTimeoutRef.current);
    if (prewarmFallbackTimeoutRef.current != null) window.clearTimeout(prewarmFallbackTimeoutRef.current);
  }, []);

  const handleCamClick = useCallback((id: string) => {
    setSelectedCam((current) => {
      const next = current === id ? null : id;
      if (next) prewarmOriginal(id);
      else stopOriginalPrewarm();
      return next;
    });
  }, [prewarmOriginal, stopOriginalPrewarm]);

  const handleCamDoubleClick = useCallback((camera: Camera) => {
    if (focusedCameraId) { restoreLayout(); return; }
    // O primeiro clique do duplo clique já iniciou o aquecimento. Esta chamada
    // também cobre teclado/touch e qualquer caminho que amplie sem seleção.
    prewarmOriginal(camera.id);
    zoomToCamera(camera.id);
  }, [focusedCameraId, prewarmOriginal, restoreLayout, zoomToCamera]);

  const loadLayout = (layoutId: string) => {
    const layout = availableLayouts.find(l => l.id === layoutId);
    // Reseta o valor do Select para '' para que re-selecionar o mesmo layout
    // dispare onValueChange novamente (Radix não reemite o valor atual).
    setLayoutSelectValue('');
    if (!layout) return;
    setGridSize(layout.gridSize);
    setCameraIds(layout.cameraIds.slice(0, (() => { const d = gridDims(layout.gridSize); return d.cols * d.rows; })()));
    setSelectedSlotIndex(null);
  };

  // Trocar o tamanho da grade invalida o slot selecionado: o índice aponta
  // para outro quadro (ou para fora da grade) na geometria nova.
  useEffect(() => {
    setSelectedSlotIndex(null);
  }, [gridSize]);

  const placeCameraInGrid = useCallback((camId: string) => {
    const currentGridSize = useGridStore.getState().gridSize;
    const currentCount = (() => { const d = gridDims(currentGridSize); return d.cols * d.rows; })();
    const currentCameraIds = useGridStore.getState().cameraIds;
    const newIds = [...currentCameraIds.slice(0, currentCount)];
    while (newIds.length < currentCount) newIds.push('');
    const previousIdx = newIds.findIndex((id) => id === camId);
    if (previousIdx >= 0) newIds[previousIdx] = '';
    // O slot selecionado pode ter ficado FORA da grade (operador selecionou o
    // quadro 15 numa 5×5 e depois trocou para 2×2): escrever nele criaria um
    // array esparso e a câmera "sumia" sem nenhum feedback — o slice(0, count)
    // do render cortava o índice fantasma.
    const slotValido = selectedSlotIndex != null && selectedSlotIndex < currentCount ? selectedSlotIndex : null;
    const targetIdx = slotValido != null
      ? slotValido
      : newIds.findIndex(id => !id || !cameras.find(c => c.id === id));
    // GRADE CHEIA SEM QUADRO ESCOLHIDO: `targetIdx` vira -1 e o código escrevia
    // no ÚLTIMO quadro, apagando a câmera que estava lá sem aviso nem desfazer.
    // Agora o operador é avisado de quem saiu (e por quê), com como voltar.
    const indiceFinal = targetIdx >= 0 ? targetIdx : currentCount - 1;
    const substituida = targetIdx >= 0 ? null : newIds[indiceFinal];
    newIds[indiceFinal] = camId;
    storeCameraIds(newIds);
    setSelectedSlotIndex(null);
    if (substituida) {
      const anterior = cameras.find((camera) => camera.id === substituida);
      const idsAntes = [...currentCameraIds.slice(0, currentCount)];
      toast({
        title: 'A grade estava cheia',
        description: `"${anterior?.name ?? 'A câmera do último quadro'}" saiu para abrir espaço. Escolha um quadro antes de clicar para decidir onde entra.`,
        action: (
          <ToastAction altText="Desfazer" onClick={() => storeCameraIds(idsAntes)}>
            Desfazer
          </ToastAction>
        ),
      });
    }
  }, [cameras, selectedSlotIndex, storeCameraIds, toast]);

  const addCameraToGrid = (camId: string) => {
    const other = displayCoordination.findCameraDisplay(camId);
    if (!other) { placeCameraInGrid(camId); return; }
    toast({
      title: `Câmera já aberta na ${liveDisplayLabel(other.displayId)}`,
      description: 'Para evitar duas conexões iguais e travamentos, mova a câmera ou escolha outra.',
      action: (
        <ToastAction altText="Mover para esta tela" onClick={() => {
          displayCoordination.moveFromOtherDisplay(other.displayId, camId);
          window.setTimeout(() => placeCameraInGrid(camId), 150);
        }}>
          Mover para esta tela
        </ToastAction>
      ),
    });
  };

  const removeCameraFromSlot = (slotIndex: number) => {
    if (focusedCameraId) { restoreLayout(); return; }
    const newIds = [...cameraIds.slice(0, count)];
    while (newIds.length < count) newIds.push('');
    newIds[slotIndex] = '';
    setCameraIds(newIds);
    if (selectedSlotIndex === slotIndex) setSelectedSlotIndex(null);
  };

  const selectSlotForCamera = (slotIndex: number, camera?: Camera | null) => {
    setSelectedSlotIndex(slotIndex);
    setPanelOpen(true);
    setSelectedCam(camera?.id ?? null);
  };

  const saveCurrentLayout = () => {
    setLayoutDialog({ mode: 'save', name: `Layout ${savedLayouts.length + 1}` });
  };

  const renameLayout = (layoutId: string) => {
    const layout = savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    setLayoutDialog({ mode: 'rename', id: layoutId, name: layout.name });
  };

  const deleteLayout = (layoutId: string) => {
    const layout = savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    setDeleteTarget(layout);
  };

  const commitLayoutDialogRef = useRef(false);
  const commitLayoutDialog = async () => {
    if (!layoutDialog) return;
    // Reentrância: Enter duplo (ou Enter + clique em "Salvar") disparava dois
    // POSTs antes de o diálogo fechar — dois layouts idênticos no servidor.
    if (commitLayoutDialogRef.current) return;
    commitLayoutDialogRef.current = true;
    try {
    const name = layoutDialog.name.trim();
    if (!name) return;
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

    if (layoutDialog.mode === 'rename' && layoutDialog.id) {
      const previousLayouts = savedLayouts;
      const nextLayouts = savedLayouts.map((item) => (item.id === layoutDialog.id ? { ...item, name } : item));
      setSavedLayouts(nextLayouts);
      persistSavedLayouts(nextLayouts);
      try {
        // Layout salvo offline (id `local-...`) não existe no servidor: o PATCH
        // respondia 404 para sempre e o rename revertia — o delete já tinha
        // esta guarda, o rename não. Localmente, renomear é só persistir.
        if (!layoutDialog.id.startsWith('local-')) {
          if (!headers) throw new Error('Sessão inválida.');
          await axios.patch(`${API_URL}/live-layouts/${layoutDialog.id}`, { name }, { headers });
        }
        toast({ title: 'Layout renomeado', description: name });
      } catch {
        setSavedLayouts(previousLayouts);
        persistSavedLayouts(previousLayouts);
        toast({ title: 'Não foi possível renomear', description: 'O layout foi restaurado.', variant: 'destructive' });
        return;
      }
    } else {
      const draft: SavedLayout = {
        id: `local-live-layout-${Date.now()}`,
        name,
        gridSize,
        cameraIds: cameraIds.slice(0, count),
        createdBy: useAuthStore.getState().user?.name ?? 'Operador',
        lastUsed: new Date().toISOString(),
      };
      while (draft.cameraIds.length < count) draft.cameraIds.push('');
      let nextLayout = draft;
      try {
        if (!headers) throw new Error('Sessão inválida.');
        const response = await axios.post<ApiLiveLayout>(`${API_URL}/live-layouts`, {
          name: draft.name,
          gridSize: draft.gridSize,
          cameraIds: draft.cameraIds,
        }, { headers });
        nextLayout = mapApiLiveLayout(response.data) ?? draft;
      } catch {
        toast({
          title: 'Layout salvo somente neste navegador',
          description: 'A sincronização com o servidor falhou.',
          variant: 'destructive',
        });
      }
      const nextLayouts = [nextLayout, ...savedLayouts];
      setSavedLayouts(nextLayouts);
      persistSavedLayouts(nextLayouts);
      toast({ title: 'Layout salvo', description: name });
    }
    setLayoutDialog(null);
    } finally {
      commitLayoutDialogRef.current = false;
    }
  };

  const confirmDeleteLayout = async () => {
    if (!deleteTarget) return;
    const previousLayouts = savedLayouts;
    const nextLayouts = savedLayouts.filter((item) => item.id !== deleteTarget.id);
    setSavedLayouts(nextLayouts);
    persistSavedLayouts(nextLayouts);
    try {
      if (accessToken && !deleteTarget.id.startsWith('local-')) {
        await axios.delete(`${API_URL}/live-layouts/${deleteTarget.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      }
      toast({ title: 'Layout apagado', description: deleteTarget.name });
    } catch {
      setSavedLayouts(previousLayouts);
      persistSavedLayouts(previousLayouts);
      toast({ title: 'Não foi possível apagar', description: 'O layout foi restaurado.', variant: 'destructive' });
    }
    setDeleteTarget(null);
  };

  // ── MODO MURAL SEM DERRUBAR NENHUM PLAYER ─────────────────────────────────
  //
  // O mural era um `return` separado com uma árvore JSX própria. Alternar
  // desmontava a grade INTEIRA na reconciliação: todas as sessões WHEP eram
  // encerradas e renegociadas em rajada — a piscada em massa que o projeto
  // declara como invariante proibido ("live saudável nunca pisca"), além do
  // estresse no MediaMTX de cortar e reabrir ~30 leitores de uma vez.
  //
  // Agora o mural é a MESMA árvore com classes condicionais: o caminho do nó
  // raiz até cada <CameraTile> não muda, então o React só re-estiliza — nenhum
  // player desmonta, nenhum stream cai. Toolbar e painel ficam com `hidden`
  // (montados, invisíveis) para não deslocar os irmãos na reconciliação.
  if (displayCoordination.isSuperseded) {
    return <div className="flex h-full min-h-[360px] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-lg">
        <Monitor className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
        <h2 className="text-base font-semibold">{displayCoordination.label} já está aberta</h2>
        <p className="mt-2 text-sm text-muted-foreground">A janela mais recente assumiu esta tela. Os vídeos foram encerrados aqui para não duplicar conexões e causar travamentos.</p>
        <Button className="mt-4" onClick={() => window.location.reload()}>Usar esta janela</Button>
      </div>
    </div>;
  }

  return (
    <div className={wallMode ? 'fixed inset-0 z-50 flex bg-black' : 'live-workspace relative flex h-full min-h-0'}>
      {prewarmCamera ? (
        // Leitor invisível e temporário do perfil original. Não há segundo
        // player para toda a grade: somente a câmera recém-selecionada recebe
        // esta antecipação, por no máximo 20 segundos.
        <div aria-hidden="true" className="pointer-events-none fixed -left-px -top-px h-px w-px overflow-hidden opacity-0">
          <LiveStreamPlayer
            cameraId={prewarmCamera.id}
            cameraName={prewarmCamera.name}
            liveViewMode="selected"
            routeActive={pageActive}
            muted
            showOverlay={false}
            aiEnabled={false}
            className="h-px w-px"
            onStatusChange={(status: LivePlayerStatus) => {
              if (status.state !== 'playing') return;
              setOriginalReadyCameraId((current) => current === prewarmCamera.id ? current : prewarmCamera.id);
              if (prewarmFallbackTimeoutRef.current != null) {
                window.clearTimeout(prewarmFallbackTimeoutRef.current);
                prewarmFallbackTimeoutRef.current = null;
              }
            }}
          />
        </div>
      ) : null}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className={wallMode ? 'hidden' : 'toolbar'}>
          <div className="segment">
            {GRID_PRESETS.map(({ size, icon }) => (
              <Tooltip key={size} delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setGridSize(size)}
                    className={`seg-btn ${gridSize === size ? 'active' : ''}`}
                    data-testid={`button-grid-${size}`}
                  >
                    {icon}
                    <span className="grid-label">{size}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Grade {size}</TooltipContent>
              </Tooltip>
            ))}
          </div>

          {count > GRID_CELL_WARN ? (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-md bg-[hsl(var(--status-warning)_/_0.14)] px-2 py-1 text-[10px] font-semibold text-[hsl(var(--status-warning))]" data-testid="grid-cpu-warn">
                  ⚠ {count} câmeras
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs max-w-56">Muitas câmeras ao vivo ao mesmo tempo podem deixar a imagem mais lenta. Reduza a grade se necessário.</TooltipContent>
            </Tooltip>
          ) : null}

          {focusedCameraId ? (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button onClick={restoreLayout} className="btn btn-sm border-[hsl(var(--status-warning)_/_0.72)] bg-[hsl(var(--status-warning)_/_0.15)] text-[hsl(var(--status-warning))] hover:bg-[hsl(var(--status-warning)_/_0.25)]" data-testid="button-restore-grid">
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Voltar à grade
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Volta para a grade anterior (ou tecle Esc / dê duplo-clique)</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button onClick={fillGrid} className="btn btn-secondary btn-sm" data-testid="button-fill-grid">
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="toolbar-label">Preencher</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Preenche até 36 câmeras e ajusta a grade automaticamente</TooltipContent>
          </Tooltip>

          <Popover>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button className="btn btn-secondary btn-sm" data-testid="button-layouts">
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span className="toolbar-label">Layouts</span>
                    <ChevronDown className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Carregar e gerenciar layouts</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-72 p-2">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-[10px] font-mono uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Layouts
                </span>
                <button onClick={saveCurrentLayout} className="btn btn-secondary btn-xs">
                  <Save className="w-3 h-3" />
                  Salvar atual
                </button>
              </div>
              <Select value={layoutSelectValue} onValueChange={loadLayout}>
                <SelectTrigger className="mb-2 h-8 w-full text-xs">
                  <SelectValue placeholder="Carregar layout" />
                </SelectTrigger>
                <SelectContent>
                  {availableLayouts.map(l => (
                    <SelectItem key={l.id} value={l.id} className="text-xs">{l.name}</SelectItem>
                  ))}
                  {!availableLayouts.length && (
                    <SelectItem value="__empty__" disabled className="text-xs">Nenhum layout salvo</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <div className="max-h-64 overflow-y-auto border-t border-border pt-1">
                {savedLayouts.length ? savedLayouts.map((layout) => (
                  <div key={layout.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[hsl(var(--accent))]">
                    <button className="min-w-0 flex-1 text-left" onClick={() => loadLayout(layout.id)}>
                      <span className="block truncate text-xs font-medium">{layout.name}</span>
                      <span className="block font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                        {layout.gridSize} / {layout.cameraIds.filter(Boolean).length} câmeras
                      </span>
                    </button>
                    <button onClick={() => renameLayout(layout.id)} className="h-7 w-7 rounded border border-border inline-flex items-center justify-center hover:bg-background" title="Renomear">
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button onClick={() => deleteLayout(layout.id)} className="h-7 w-7 rounded border border-border inline-flex items-center justify-center hover:bg-[hsl(var(--destructive)_/_0.1)] hover:text-[hsl(var(--destructive))]" title="Apagar">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )) : (
                  <div className="px-2 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    Salve o layout atual para reutilizá-lo.
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>

          {displayId === 'main' ? (
            <Popover>
              <PopoverTrigger asChild>
                <button className="btn btn-secondary btn-sm" data-testid="button-live-displays">
                  <Monitor className="w-3.5 h-3.5" />
                  <span className="toolbar-label">Telas</span>
                  <ChevronDown className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2">
                <div className="px-2 py-1.5">
                  <p className="text-xs font-semibold">Central multi-monitor</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">Uma tela principal e até três auxiliares, cada uma com sua própria grade.</p>
                </div>
                {(['aux-1', 'aux-2', 'aux-3'] as const).map(target => {
                  const presence = displayCoordination.displays[target];
                  const active = presence && Date.now() - presence.updatedAt <= 8_000;
                  return <button key={target} onClick={() => openAuxiliaryDisplay(target)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-accent">
                    <span><span className="block text-xs font-medium">{liveDisplayLabel(target)}</span><span className="block text-[10px] text-muted-foreground">{active ? `${presence.cameraIds.length} câmeras abertas` : 'Abrir janela independente'}</span></span>
                    <span className={`h-2 w-2 rounded-full ${active ? 'bg-[hsl(var(--status-online))]' : 'bg-muted-foreground/35'}`} />
                  </button>;
                })}
              </PopoverContent>
            </Popover>
          ) : <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">{displayCoordination.label}</span>}

          <div className="live-status-summary ml-auto flex min-w-0 items-center gap-1.5">
            <span className="hdr-chip">
              <span className="hdr-chip-dot status-online" />
              {gridCameraCount.online}/{gridCameraCount.total} ao vivo
            </span>
            {alarmCount > 0 && (
              <span className="hdr-chip">
                <span className="hdr-chip-dot status-alarm alarm-glow" />
                {alarmCount} ALM
              </span>
            )}
          </div>

          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                onClick={handleWallMode}
                className="btn btn-secondary btn-sm btn-icon"
                data-testid="button-wall-mode"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Abrir modo mural</TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setPanelOpen(o => !o)}
                className="btn btn-secondary btn-sm btn-icon"
              >
                {panelOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{panelOpen ? 'Ocultar painel de câmeras' : 'Mostrar painel de câmeras'}</TooltipContent>
          </Tooltip>
        </div>

        {/* A grade inteira — normal ou mural — mantém a proporção combinada dos
            seus quadros 16:9. Antes a grade normal esticava as linhas para usar
            toda a altura disponível: cada célula virava, por exemplo, 1.60:1,
            e uma câmera 1080p (1.78:1) ganhava tarjas dentro do próprio tile.
            Agora a pequena sobra fica apenas na BORDA EXTERNA da grade. Assim
            todos os vídeos permanecem inteiros, alinhados e com o mesmo tamanho. */}
        <div className={`flex-1 min-h-0 grid place-items-center bg-black ${wallMode ? 'p-0.5' : 'p-1'}`}>
        <div
          className={`cam-grid-bg grid min-h-0 max-h-full max-w-full ${wallMode ? 'gap-0.5' : 'gap-1'}`}
          style={{
            gridTemplateColumns: `repeat(${visibleGridCols}, 1fr)`,
            gridTemplateRows: `repeat(${visibleGridRows}, 1fr)`,
            aspectRatio: `${visibleGridCols * 16} / ${visibleGridRows * 9}`,
            width: '100%',
            height: 'auto',
            maxWidth: '100%',
            maxHeight: '100%',
          }}
        >
          {displayedCams.map((cam, i) => (
            <div
              // Key por id de câmera: mover uma câmera de quadro MOVE o nó no DOM
              // (stream preservado) em vez de desmontar/remontar o player.
              key={cam ? `cam-${cam.id}` : `empty-${i}`}
              className={`group relative min-h-0 rounded-md ${focusedCameraId && cam?.id !== focusedCameraId ? 'hidden' : ''} ${!wallMode && selectedSlotIndex === i ? 'ring-2 ring-[hsl(var(--primary))]' : ''}`}
              style={{ minHeight: 80 }}
            >
              {cam ? (
                <>
                  <CameraTile
                    camera={{
                      ...cam,
                      // Só a ação manual do operador usa o estado visual vermelho.
                      // Gravação por movimento/objeto é uma política automática e
                      // não pode parecer que alguém apertou REC na grade.
                      manualRecordingActive: recordingOverrides[cam.id] ?? (cam.recordingMode === 'manual' && cam.status === 'recording'),
                      status: cam.status === 'recording' && cam.recordingMode !== 'manual' ? 'online' : cam.status,
                    }}
                    selected={selectedCam === cam.id}
                    showDetectionOverlay={!wallMode || selectedCam === cam.id}
                    // Full HD só quando há exatamente 1 câmera na tela.
                    // Em grade 2x2 ou maior, até a câmera selecionada permanece
                    // no perfil reduzido para preservar CPU/banda.
                    // Ao ampliar, mantém o vídeo leve vivo até o perfil
                    // original pré-aquecido realmente ter um frame. Assim o
                    // duplo clique nunca troca imagem por um spinner.
                    liveViewMode={
                      (focusedCameraId === cam.id && originalReadyCameraId === cam.id) || count === 1
                        ? 'selected'
                        : 'grid'
                    }
                    wallMode={wallMode}
                    onClick={() => {
                      handleCamClick(cam.id);
                      setSelectedSlotIndex(i);
                    }}
                    onDoubleClick={() => handleCamDoubleClick(cam)}
                    onAction={handleCamAction}
                    recordingBusy={recordingBusyIds.includes(cam.id)}
                    streamStartDelayMs={displayIndex * 700 + streamStartDelay(i, count)}
                    routeActive={pageActive}
                    onGridSourceIsOriginal={markGridSourceIsOriginal}
                  />
                  <div // Aparecem também quando o quadro está SELECIONADO: em tela sensível
                    // ao toque não existe hover, e "Trocar"/"Remover" ficavam
                    // inalcançáveis — montar a grade era impossível no hardware
                    // típico de sala de operação.
                    className={wallMode
                      ? 'hidden'
                      : `absolute top-9 right-1.5 z-40 flex items-center gap-1.5 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${
                          selectedCam === cam.id ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
                        }`}>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        selectSlotForCamera(i, cam);
                      }}
                      className="h-7 rounded-md border border-white/15 bg-black/70 px-2 text-[10px] font-mono text-white backdrop-blur hover:bg-black"
                      title="Trocar câmera deste quadrado"
                    >
                      Trocar
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        removeCameraFromSlot(i);
                      }}
                      className="h-7 w-7 rounded-md border border-white/15 bg-black/70 text-white backdrop-blur hover:bg-[hsl(var(--destructive)_/_0.8)]"
                      title="Remover câmera deste quadrado"
                    >
                      <X className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => selectSlotForCamera(i)}
                  className="cam-empty"
                  style={{ minHeight: 80 }}
                  aria-label={`Escolher câmera para o quadro ${i + 1}`}
                >
                  <Video className="w-4 h-4" />
                  <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 10 }}>
                    {selectedSlotIndex === i ? 'Escolha uma câmera' : 'Slot vazio'}
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
        </div>
      </div>

      <AnimatePresence>
        {panelOpen && !wallMode && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            className="relative border-l border-border bg-card flex flex-col overflow-hidden shrink-0"
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar painel de câmeras"
              title="Arraste para ajustar a largura do painel"
              onPointerDown={beginPanelResize}
              className="group absolute -left-1 top-0 z-50 flex h-full w-3 cursor-col-resize touch-none items-center justify-center"
            >
              <span className="h-20 w-1.5 rounded-full bg-[hsl(var(--primary)_/_0.82)] shadow-[0_0_8px_hsl(var(--primary)_/_0.3)] transition-all group-hover:h-24 group-hover:w-2 group-hover:bg-[hsl(var(--primary))] group-active:h-28 group-active:w-2 group-active:bg-[hsl(var(--primary))]" />
            </div>
            <div className="px-2 py-2.5 border-b border-border shrink-0 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[12px] font-semibold">Câmeras</h2>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                    {selectedSlotIndex != null ? `Quadro ${selectedSlotIndex + 1}` : 'Abrir na grade'}
                  </p>
                </div>
                <ShieldCheck className="w-4 h-4 text-[hsl(var(--status-online))]" />
              </div>

              <div className="input-wrap">
                <span className="input-icon"><Search className="w-3 h-3" /></span>
                <input
                  className="input"
                  style={{ height: 30, fontSize: 11 }}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar câmera..."
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger className="col-span-2 h-8 min-w-0 px-2 text-[10px]">
                    <Filter className="mr-1.5 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    <SelectValue placeholder="Todos os grupos" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupFilters.map(group => <SelectItem key={group} value={group} className="text-xs">{group === '__all__' ? 'Todos os grupos' : group}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={zoneFilter} onValueChange={setZoneFilter}>
                  <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]">
                    <Filter className="mr-1.5 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zoneFilters.map(z => <SelectItem key={z} value={z} className="text-xs">{z === '__all__' ? 'Todas as zonas' : z}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                  <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTERS.map((status) => (
                      <SelectItem key={status} value={status} className="text-xs">
                        {STATUS_FILTER_LABEL[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-border/80">
              {filteredList.map(cam => {
                const isInGrid = cameraIds.includes(cam.id);
                const statusClass =
                  cam.status === 'alarm' ? 'status-alarm rec-pulse' :
                  cam.status === 'motion' ? 'status-motion' :
                  cam.status === 'no_signal' ? 'status-warning' : cam.isOnline ? 'status-online' : 'status-offline';
                return (
                  <button
                    key={cam.id}
                    className={`group w-full text-left grid grid-cols-[56px_1fr_auto] items-center gap-2 px-2 py-1.5 hover:bg-[hsl(var(--accent)_/_0.7)] transition-colors ${
                      isInGrid ? 'bg-[hsl(var(--primary)_/_0.06)]' : ''
                    }`}
                    onClick={() => addCameraToGrid(cam.id)}
                    title={`Adicionar ${cam.name} à grade`}
                  >
                    <span className="relative block h-9 w-14 overflow-hidden rounded border border-white/10 bg-black">
                      {sidebarPosterUrls[cam.id] ? (
                        <img
                          src={sidebarPosterUrls[cam.id]}
                          alt=""
                          loading="lazy"
                          onError={() => retrySidebarPoster(cam.id)}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <Video className="absolute inset-0 m-auto h-3.5 w-3.5 text-white/25" aria-hidden="true" />
                      )}
                      <span className={`absolute bottom-1 left-1 h-2 w-2 rounded-full ring-2 ring-black/70 ${statusClass}`} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium truncate">{cam.name}</span>
                      <span className="block text-[9px] text-[hsl(var(--muted-foreground))] truncate">
                        {cam.code !== cam.name ? cam.code : `${cam.zone} · ${cam.ipAddress}`}
                      </span>
                    </span>
                    <span className={`max-w-[42px] truncate text-[9px] shrink-0 ${isInGrid ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground)_/_0.55)]'}`}>
                      {selectedSlotIndex != null ? 'Usar' : isInGrid ? 'Grade' : STATUS_FILTER_LABEL[cam.status as (typeof STATUS_FILTERS)[number]] ?? cam.status.replace('_', ' ')}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="px-2.5 py-2 border-t border-border shrink-0 flex items-center justify-between">
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{filteredList.length} câmeras</span>
              <button
                onClick={() => setPanelOpen(false)}
                className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:text-foreground transition-colors"
              >
                Recolher <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="btn btn-secondary btn-sm btn-icon absolute right-3 top-[104px] z-10"
          aria-label="Mostrar painel de câmeras"
          title="Mostrar painel de câmeras"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}

      <Dialog open={layoutDialog !== null} onOpenChange={(open) => { if (!open) setLayoutDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{layoutDialog?.mode === 'rename' ? 'Renomear layout' : 'Salvar layout'}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={layoutDialog?.name ?? ''}
            onChange={(e) => setLayoutDialog((current) => (current ? { ...current, name: e.target.value } : current))}
            onKeyDown={(e) => { if (e.key === 'Enter') commitLayoutDialog(); }}
            placeholder="Nome do layout"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLayoutDialog(null)}>Cancelar</Button>
            <Button onClick={commitLayoutDialog} disabled={!layoutDialog?.name.trim()}>
              {layoutDialog?.mode === 'rename' ? 'Renomear' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar layout</AlertDialogTitle>
            <AlertDialogDescription>
              Apagar o layout "{deleteTarget?.name}"? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteLayout}>Apagar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {wallMode && (
        <>
          {/* Somem após 3s sem interação e voltam ao primeiro movimento. O mural
              fica horas numa TV, e dois selos fixos por cima do vídeo são ruído
              permanente — em painel OLED, imagem parada sobre imagem parada é
              retenção de tela. Esconder não prende ninguém: Esc já sai do mural.
              `pointer-events-none` enquanto invisível para o botão não ser
              clicado às cegas. */}
          <div
            {...muralControles.propsDoControle}
            className={`absolute top-3 left-3 z-50 flex items-center gap-2 rounded-md border border-white/10 bg-black/72 px-3 py-1.5 text-xs font-medium text-white transition-opacity duration-300 motion-reduce:transition-none ${
              muralControles.visivel ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <Video className="w-3.5 h-3.5 text-[hsl(var(--status-online))]" />
            {displayCoordination.label} / Modo Mural
          </div>
          <button
            onClick={handleWallMode}
            {...muralControles.propsDoControle}
            className={`ops-button fixed top-3 right-3 z-50 flex items-center gap-1.5 border-white/10 bg-black/72 px-3 text-xs text-white transition-opacity duration-300 motion-reduce:transition-none ${
              muralControles.visivel ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            {wallMode && !document.fullscreenElement ? 'Usar tela cheia' : 'Sair do Modo Mural'}
          </button>
        </>
      )}
    </div>
  );
}
