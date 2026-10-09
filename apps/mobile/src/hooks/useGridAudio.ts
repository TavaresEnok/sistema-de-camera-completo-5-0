import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { request } from '../services/api';
import { authenticatedMediaUrl } from '../services/media-urls';
import { showAppNotice } from '../services/app-notice';
import { userFacingError } from '../services/user-facing-error';
import type { StreamUrls } from '../types';

type Selection = { id: string; loading: boolean; uri: string | null; whepUri: string | null };

/** Only the chosen tile requests an audio-capable stream. Base grid URLs remain
 * untouched, so mute returns to the ordinary economical stream immediately. */
export function useGridAudio(apiUrl: string, token: string | null, liveIds: string[]) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const selected = useRef<Selection | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const session = useRef({ apiUrl, token });
  session.current = { apiUrl, token };
  const currentLiveIds = useRef(liveIds);
  currentLiveIds.current = liveIds;

  const stop = () => {
    generation.current += 1;
    controller.current?.abort(); controller.current = null;
    selected.current = null; setSelection(null);
  };

  const start = async (id: string) => {
    if (!currentLiveIds.current.includes(id)) return;
    controller.current?.abort();
    const current = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    const value = { id, loading: true, uri: null, whepUri: null };
    selected.current = value; setSelection(value);
    const credentials = session.current;
    try {
      if (!credentials.token) throw new Error('Entre novamente na sua conta.');
      const data = await request<StreamUrls>(credentials.apiUrl,
        `/camera-stream/${encodeURIComponent(id)}/urls?viewMode=grid-audio`, credentials.token, { signal: abort.signal });
      if (current !== generation.current || abort.signal.aborted) return;
      const uri = authenticatedMediaUrl(data.protocols?.hlsUrl, credentials.apiUrl, data.streamToken);
      const whep = data.protocols?.whepUrl ?? (data.protocols?.webrtcUrl ? data.protocols.webrtcUrl.replace(/\/+$/, '') + '/whep' : null);
      const whepUri = authenticatedMediaUrl(whep, credentials.apiUrl, data.streamToken);
      if (!uri && !whepUri) throw new Error('A transmissão com áudio não ficou disponível.');
      const ready = { id, loading: false, uri, whepUri };
      selected.current = ready; setSelection(ready);
    } catch (error) {
      if (current !== generation.current) return;
      selected.current = null; setSelection(null);
      showAppNotice('Não foi possível ligar o áudio', userFacingError(error, 'Tente novamente. O vídeo continua sem som.'), 'warning');
    }
  };

  useEffect(() => {
    if (selected.current && !liveIds.includes(selected.current.id)) stop();
  }, [liveIds.join('|')]);
  useEffect(() => { stop(); }, [apiUrl]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    return () => {
      generation.current += 1; controller.current?.abort(); selected.current = null;
      subscription.remove();
    };
  }, []);

  return {
    selection,
    toggle: (id: string) => { if (selected.current?.id === id) stop(); else void start(id); },
    refresh: (id: string) => { if (selected.current?.id === id) void start(id); },
    audioAvailable: (id: string, available: boolean) => {
      if (!available && selected.current?.id === id && !selected.current.loading) {
        stop(); showAppNotice('Áudio indisponível', 'Esta câmera não está enviando som. O vídeo continua disponível.', 'info');
      }
    },
  };
}
