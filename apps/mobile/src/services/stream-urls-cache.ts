import { request } from './api';
// Cache for stream URLs to prevent duplicate requests during grid view load
const streamUrlsCache = new Map<string, { cameraId: string; data: unknown; expiresAt: number }>();
const inFlightRequests = new Map<string, { promise: Promise<unknown>; controller: AbortController; id: symbol }>();
const CACHE_TTL_MS = 8000; // 8 second cache

export function clearStreamUrlsCache(cameraId?: string) {
  if (cameraId) {
    for (const [key, entry] of streamUrlsCache) {
      if (entry.cameraId === cameraId) streamUrlsCache.delete(key);
    }
    for (const [key, pending] of inFlightRequests) {
      if (key.includes(`::${cameraId}::`)) {
        pending.controller.abort();
        inFlightRequests.delete(key);
      }
    }
  } else {
    for (const pending of inFlightRequests.values()) pending.controller.abort();
    streamUrlsCache.clear();
    inFlightRequests.clear();
  }
}

/**
 * Modos de entrega aceitos pelo servidor. Os terminados em `-audio` são os
 * ÚNICOS que trazem faixa de áudio tocável no celular: no caminho WebRTC o
 * servidor só converte o áudio para Opus quando ele é pedido. Sem isso o botão
 * de microfone liga e desliga um som que nunca chega.
 */
export type ModoDeEntrega = 'grid' | 'original' | 'grid-audio' | 'original-audio';

export async function requestCachedStreamUrls<T>(
  apiUrl: string,
  cameraId: string,
  token?: string,
  init?: RequestInit,
  viewMode?: ModoDeEntrega,
): Promise<T> {
  // A chave inclui o modo — 'original' (máxima qualidade/H.265) usa outro caminho
  // no MediaMTX e não pode compartilhar cache com Economia (grid/H.264).
  // Servidor e credencial fazem parte da chave para que uma troca de conta ou
  // instalação nunca reutilize URLs/tokens emitidos para outra sessão.
  const normalizedApiUrl = apiUrl.replace(/\/+$/, '');
  const mode = viewMode ?? 'original';
  const cacheKey = `${normalizedApiUrl}::${token ?? 'anonymous'}::${cameraId}::${mode}`;
  const cached = streamUrlsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data as T;
  }

  const pending = inFlightRequests.get(cacheKey);
  if (pending) return pending.promise as Promise<T>;

  // Make actual request
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const query = viewMode ? `?viewMode=${encodeURIComponent(viewMode)}` : '';
  const requestId = Symbol(cacheKey);

  const run = (async () => {
    try {
      const data = await request<T>(apiUrl, `/camera-stream/${encodeURIComponent(cameraId)}/urls${query}`, token, {
        ...init,
        signal: controller.signal,
      });

      // Se clearStreamUrlsCache abortou esta sessão, não repopula o cache.
      if (!controller.signal.aborted) {
        streamUrlsCache.set(cacheKey, {
          cameraId,
          data: data as T,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Tempo esgotado. Verifique a conexão.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      // Um clear seguido imediatamente de uma nova chamada pode criar outro
      // request com a mesma chave enquanto este ainda termina. O request antigo
      // não deve apagar a referência do novo no finally.
      if (inFlightRequests.get(cacheKey)?.id === requestId) inFlightRequests.delete(cacheKey);
    }
  })();
  inFlightRequests.set(cacheKey, { promise: run, controller, id: requestId });
  return run;
}
