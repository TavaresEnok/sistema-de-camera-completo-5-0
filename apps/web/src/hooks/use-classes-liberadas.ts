import { useEffect, useState } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';

// As classes de objeto que a CENTRAL liberou para esta instalação.
//
// Existe como gancho porque o gatilho de gravação por objeto é editado em TRÊS
// telas — detalhe da câmera, edição rápida da lista e assistente de câmera nova
// — e as três escreviam o texto fixo "Pessoa ou veículo (IA)". Com a Central
// liberando somente "Pessoa", as três mentiam ao mesmo tempo (relatado em
// 14/08/2026 pelo dono).
//
// Uma tela que promete o que a instalação não tem é pior que uma tela sem a
// opção: o operador escolhe, a câmera nunca grava, e nada explica.

const API_URL = getApiBaseUrl();

/** Cache de módulo: as três telas podem coexistir e a lista muda por heartbeat,
 *  não por clique. Buscar uma vez por sessão de tela basta. */
let cache: { classes: string[]; motionAllowed: boolean; em: number } | null = null;
const VALIDADE_MS = 60_000;

export function useClassesLiberadas(): { classes: string[]; motionAllowed: boolean; carregando: boolean } {
  const accessToken = useAuthStore((state) => state.accessToken);
  const [classes, setClasses] = useState<string[]>(() => cache?.classes ?? []);
  const [motionAllowed, setMotionAllowed] = useState(() => cache?.motionAllowed ?? true);
  const [carregando, setCarregando] = useState(!cache);

  useEffect(() => {
    if (!accessToken) return;
    if (cache && Date.now() - cache.em < VALIDADE_MS) {
      setClasses(cache.classes);
      setMotionAllowed(cache.motionAllowed);
      setCarregando(false);
      return;
    }
    let cancelado = false;
    void axios
      .get<{ classes?: string[]; motionAllowed?: boolean }>(`${API_URL}/ai/simulation-capabilities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15_000,
      })
      .then((r) => {
        const lista = Array.isArray(r.data?.classes) ? r.data.classes : [];
        const movimento = r.data?.motionAllowed !== false;
        cache = { classes: lista, motionAllowed: movimento, em: Date.now() };
        if (!cancelado) { setClasses(lista); setMotionAllowed(movimento); }
      })
      .catch(() => {
        // Falha de rede NÃO pode virar "nada liberado": isso desabilitaria o
        // gatilho de objeto numa instalação que o tem, e o operador concluiria
        // que perdeu a funcionalidade. Sem notícia, mantém a última boa.
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => { cancelado = true; };
  }, [accessToken]);

  return { classes, motionAllowed, carregando };
}
