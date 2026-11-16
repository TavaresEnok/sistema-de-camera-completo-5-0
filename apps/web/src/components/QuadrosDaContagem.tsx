import { useEffect, useState } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';
import { useVmsDataStore } from '../store/vmsDataStore';

const OPCOES = [5, 8, 12] as const;

/** Taxa de análise da câmera com linha de contagem. Salva ao clicar. */
export function QuadrosDaContagem({ cameraId, inicial, token, podeEditar, realFps }: { cameraId: string; inicial?: number | null; token?: string | null; podeEditar: boolean; realFps?: number }) {
  const [valor, setValor] = useState<number>(inicial ?? 8);
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState('');
  useEffect(() => { setValor(inicial ?? 8); }, [cameraId, inicial]);

  async function escolher(fps: number) {
    if (fps === valor || salvando) return;
    const anterior = valor;
    setValor(fps);
    setSalvando(true);
    setAviso('Aplicando…');
    try {
      const { data } = await axios.patch(`${getApiBaseUrl()}/cameras/${cameraId}`, { countingFps: fps }, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, timeout: 60000 });
      useVmsDataStore.setState(state => ({ cameras: state.cameras.map(c => c.id === cameraId ? { ...c, countingFps: fps } : c) }));
      setAviso(['started', 'running', 'already_running'].includes(data.aiApplyStatus)
        ? 'Aplicado' : 'Salvo. Verifique se a análise está ativa.');
    } catch {
      setValor(anterior);
      setAviso('Não foi possível aplicar. Tente novamente.');
      toast({ title: 'Não foi possível salvar', variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">Meta da contagem</span>
      <div className="segment" aria-label="Quadros por segundo da contagem">
        {OPCOES.map((fps) => (
          <button key={fps} type="button" disabled={!podeEditar || salvando} aria-pressed={valor === fps}
            className={`seg-btn ${valor === fps ? 'active' : ''}`} onClick={() => void escolher(fps)}>
            {fps} q/s
          </button>
        ))}
      </div>
      {Number.isFinite(realFps) && <span className={realFps! < valor * 0.7 ? 'text-amber-500' : 'text-muted-foreground'}>Real: {realFps!.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} q/s</span>}
      <span className="text-muted-foreground" aria-live="polite">{aviso || 'Mais quadros exigem mais processamento.'}</span>
    </div>
  );
}
