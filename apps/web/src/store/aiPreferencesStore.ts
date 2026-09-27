import axios from 'axios';
import { create } from 'zustand';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from './authStore';

let pendingLoad: Promise<void> | null = null;
let generation = 0;
let retryAfter = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Preferências de EXIBIÇÃO da IA, compartilhadas por toda a tela.
 *
 * Store e não prop porque o player é renderizado uma vez POR CÂMERA: num mural
 * de 17 tiles, ler a preferência dentro do componente viraria 17 requisições
 * idênticas a cada montagem. Aqui é uma só, e todos os tiles leem do mesmo
 * lugar.
 *
 * O padrão é MOSTRAR: quem nunca abriu a tela de IA continua vendo a marcação
 * exatamente como antes desta configuração existir.
 */
type AiPreferencesState = {
  showObjectBox: boolean;
  carregado: boolean;
  carregar: () => Promise<void>;
  definirCaixa: (valor: boolean) => void;
};

export const useAiPreferencesStore = create<AiPreferencesState>((set, get) => ({
  showObjectBox: true,
  carregado: false,

  carregar: async () => {
    if (get().carregado) return;
    if (pendingLoad) return pendingLoad;
    if (Date.now() < retryAfter) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    const requestGeneration = generation;
    pendingLoad = (async () => { try {
      const { data } = await axios.get<{ showObjectBox?: boolean }>(`${getApiBaseUrl()}/ai/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      // Ausente = instalação com API antiga: mantém o comportamento de mostrar.
      if (generation === requestGeneration) set({ showObjectBox: data?.showObjectBox !== false, carregado: true });
    } catch {
      if (generation === requestGeneration) {
        retryAfter = Date.now() + 30_000;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void useAiPreferencesStore.getState().carregar(); }, 30_000);
      }
    } finally {
      if (generation === requestGeneration) pendingLoad = null;
    } })();
    return pendingLoad;
  },

  /** Atualização otimista vinda da tela de IA, sem esperar o próximo ciclo. */
  definirCaixa: (valor: boolean) => set({ showObjectBox: valor }),
}));

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id === previous.user?.id) return;
  generation += 1;
  pendingLoad = null;
  retryAfter = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  useAiPreferencesStore.setState({ showObjectBox: true, carregado: false });
});
