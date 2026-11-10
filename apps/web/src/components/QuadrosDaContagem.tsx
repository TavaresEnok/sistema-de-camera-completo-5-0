import { useEffect, useState } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';

const OPCOES = [5, 8, 12] as const;

/** Taxa de análise da câmera com linha de contagem. Salva ao clicar. */
export function QuadrosDaContagem({ cameraId, inicial, token, podeEditar }: { cameraId: string; inicial?: number | null; token?: string | null; podeEditar: boolean }) {
  const [valor, setValor] = useState<number>(inicial ?? 8);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setValor(inicial ?? 8); }, [cameraId, inicial]);

  async function escolher(fps: number) {
    if (fps === valor || salvando) return;
    const anterior = valor;
    setValor(fps);
    setSalvando(true);
    try {
      await axios.patch(`${getApiBaseUrl()}/cameras/${cameraId}`, { countingFps: fps }, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    } catch {
      setValor(anterior);
      toast({ title: 'Não foi possível salvar', variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">Contagem</span>
      <div className="segment" aria-label="Quadros por segundo da contagem">
        {OPCOES.map((fps) => (
          <button key={fps} type="button" disabled={!podeEditar || salvando} aria-pressed={valor === fps}
            className={`seg-btn ${valor === fps ? 'active' : ''}`} onClick={() => void escolher(fps)}>
            {fps} q/s
          </button>
        ))}
      </div>
      <span className="text-amber-400">Esta opção consome mais recursos do servidor.</span>
    </div>
  );
}
