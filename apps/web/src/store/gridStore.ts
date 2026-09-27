import { create } from 'zustand';

// Grade livre "colunas x linhas" (ex.: '4x4', '4x6', '6x4'). Os presets são só
// atalhos; qualquer CxL válido (1..8 cada) é aceito.
export type GridSize = `${number}x${number}`;

export type LiveDisplayId = 'main' | 'aux-1' | 'aux-2' | 'aux-3';

export function getLiveDisplayId(): LiveDisplayId {
  if (typeof window === 'undefined') return 'main';
  const value = new URLSearchParams(window.location.search).get('display');
  return value === 'aux-1' || value === 'aux-2' || value === 'aux-3' ? value : 'main';
}

export function liveDisplayLabel(id: LiveDisplayId) {
  return id === 'main' ? 'Tela principal' : `Tela auxiliar ${id.slice(-1)}`;
}

const LIVE_DISPLAY_ID = getLiveDisplayId();
const GRID_STORAGE_KEY = LIVE_DISPLAY_ID === 'main' ? 'drac.live.grid.v1' : `drac.live.grid.${LIVE_DISPLAY_ID}.v1`;
const PREV_LAYOUT_SESSION_KEY = `drac.live.prevLayout.${LIVE_DISPLAY_ID}.v1`;

type PersistedGrid = {
  gridSize?: GridSize;
  cameraIds?: string[];
};

/** Layout anterior salvo antes de zoom para 1x1 (duplo-clique). */
export type PrevLayout = { gridSize: GridSize; cameraIds: string[] };

function loadPersistedGrid(): PersistedGrid {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(GRID_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedGrid;
    const valid = typeof parsed.gridSize === 'string' && /^[1-8]x[1-8]$/.test(parsed.gridSize);
    return {
      gridSize: valid ? (parsed.gridSize as GridSize) : undefined,
      cameraIds: Array.isArray(parsed.cameraIds) ? parsed.cameraIds.filter((id) => typeof id === 'string') : undefined,
    };
  } catch {
    return {};
  }
}

function persistGrid(next: PersistedGrid) {
  if (typeof window === 'undefined') return;
  try {
    const current = loadPersistedGrid();
    window.localStorage.setItem(GRID_STORAGE_KEY, JSON.stringify({ ...current, ...next }));
  } catch {
    // A grade continua funcional em memória quando o armazenamento está indisponível.
  }
}

/** Persiste o layout anterior em sessionStorage (sobrevive refresh, não fecha de aba). */
function loadPrevLayout(): PrevLayout | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PREV_LAYOUT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrevLayout;
    if (typeof parsed.gridSize === 'string' && /^[1-8]x[1-8]$/.test(parsed.gridSize) && Array.isArray(parsed.cameraIds)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function persistPrevLayout(layout: PrevLayout | null) {
  if (typeof window === 'undefined') return;
  try {
    if (layout) {
      window.sessionStorage.setItem(PREV_LAYOUT_SESSION_KEY, JSON.stringify(layout));
    } else {
      window.sessionStorage.removeItem(PREV_LAYOUT_SESSION_KEY);
    }
  } catch {
    // A ausência de sessionStorage não deve impedir o retorno à grade.
  }
}

interface GridState {
  gridSize: GridSize;
  cameraIds: string[];
  wallMode: boolean;
  /** Layout anterior ao zoom 1x1 (para voltar com duplo-clique/Esc). */
  prevLayout: PrevLayout | null;
  setGridSize: (size: GridSize) => void;
  setCameraIds: (ids: string[]) => void;
  toggleWallMode: () => void;
  savePrevLayout: (layout: PrevLayout) => void;
  clearPrevLayout: () => void;
}

const persistedGrid = loadPersistedGrid();

export const useGridStore = create<GridState>((set) => ({
  gridSize: persistedGrid.gridSize ?? '2x2',
  cameraIds: persistedGrid.cameraIds ?? [],
  // A auxiliar abre em modo de configuração, com lista de câmeras disponível.
  // Depois o operador aciona o mural/tela cheia na própria janela.
  wallMode: false,
  prevLayout: loadPrevLayout(),
  setGridSize: (gridSize) => {
    persistGrid({ gridSize });
    set({ gridSize });
  },
  setCameraIds: (cameraIds) => {
    persistGrid({ cameraIds });
    set({ cameraIds });
  },
  toggleWallMode: () => set((state) => ({ wallMode: !state.wallMode })),
  savePrevLayout: (layout) => {
    persistPrevLayout(layout);
    set({ prevLayout: layout });
  },
  clearPrevLayout: () => {
    persistPrevLayout(null);
    set({ prevLayout: null });
  },
}));
