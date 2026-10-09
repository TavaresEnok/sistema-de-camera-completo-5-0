import { useCallback, useEffect, useRef, useState } from 'react';

/** Uma seleção só fica pronta quando a URL do perfil escolhido foi obtida.
 * Respostas atrasadas não podem restaurar a seleção anterior. */
export function useLiveQuality(cameraId: string, requestHd: () => Promise<boolean>, requestEconomy: () => Promise<boolean>, audioEnabled = false) {
  const [selection, setSelection] = useState({ cameraId, hdMode: true, loading: true, failed: false });
  const callbacks = useRef({ requestHd, requestEconomy });
  callbacks.current = { requestHd, requestEconomy };
  const generation = useRef(0);
  const selectedHd = useRef(true);
  const previousAudio = useRef(audioEnabled);

  const select = useCallback(async (hdMode: boolean) => {
    const current = ++generation.current;
    selectedHd.current = hdMode;
    setSelection({ cameraId, hdMode, loading: true, failed: false });
    let opened = false;
    try {
      opened = await (hdMode ? callbacks.current.requestHd() : callbacks.current.requestEconomy());
    } catch { /* A tela oferece nova tentativa, sem promessas rejeitadas soltas. */ }
    if (generation.current !== current) return;
    setSelection({ cameraId, hdMode, loading: false, failed: !opened });
  }, [cameraId]);

  useEffect(() => {
    void select(true);
    return () => { generation.current += 1; };
  }, [select]);

  useEffect(() => {
    const turningOn = audioEnabled && !previousAudio.current;
    previousAudio.current = audioEnabled;
    // O perfil com som passa pela mesma seleção: não disputa com uma troca
    // pendente nem transforma uma resposta substituída em erro na tela.
    if (turningOn) void select(selectedHd.current);
  }, [audioEnabled, select]);

  const sameCamera = selection.cameraId === cameraId;
  return {
    hdMode: sameCamera ? selection.hdMode : true,
    qualityLoading: !sameCamera || selection.loading,
    qualityFailed: sameCamera && selection.failed,
    toggleHd: () => { void select(!selectedHd.current); },
    retryQuality: () => { void select(selectedHd.current); },
  };
}
