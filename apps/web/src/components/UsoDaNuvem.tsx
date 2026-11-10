import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { formatarBytes } from '../lib/formato';
import { envioAtrasado, haQuantoTempo, pontosDoEnvio, type UsoDaNuvem as Uso } from '../lib/uso-da-nuvem';

/** Volumes, envio por dia e câmeras que mais ocupam a nuvem. */
export function UsoDaNuvem({ apiUrl, accessToken, versao }: { apiUrl: string; accessToken: string | null; versao?: number }) {
  const [uso, setUso] = useState<Uso | null>(null);
  useEffect(() => {
    if (!accessToken) return;
    axios.get<Uso>(`${apiUrl}/cloud-storage/usage`, { headers: { Authorization: `Bearer ${accessToken}` }, params: { days: 14 } })
      .then((r) => setUso(r.data))
      .catch(() => setUso(null));
  }, [apiUrl, accessToken, versao]);
  const pontos = useMemo(() => (uso?.enabled ? pontosDoEnvio(uso.daily) : []), [uso]);
  if (!uso?.enabled) return null;
  const t = uso.totals;
  const ultimo = haQuantoTempo(t.lastUploadAt);
  const atrasado = envioAtrasado(t);
  const enviouAlgo = pontos.some((p) => p.gb > 0 || p.gravacoes > 0);
  const maior = Math.max(1, ...uso.byCamera.map((c) => c.cloudBytes + c.localBytes));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Numero rotulo="Na nuvem" valor={formatarBytes(t.cloudBytes)} detalhe={`${t.cloudCount} gravações`} />
        <Numero rotulo="Aguardando envio" valor={formatarBytes(t.pendingBytes)} detalhe={`${t.pendingCount} gravações`} alerta={atrasado} />
        <Numero rotulo="Só na nuvem" valor={formatarBytes(t.cloudOnlyBytes)} detalhe="disco já liberado" />
        <Numero rotulo="Último envio" valor={ultimo ?? '—'} detalhe={ultimo ? '' : 'ainda nenhum'} />
      </div>

      <div className="rounded border border-border p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Enviado por dia · {uso.days} dias</span>
          <span>GB</span>
        </div>
        <div className="h-40">
          {enviouAlgo ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pontos} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <ReTooltip cursor={{ fillOpacity: 0.08 }} contentStyle={{ fontSize: 12 }}
                  formatter={(v: number, _n, item) => [`${v} GB · ${(item?.payload as { gravacoes: number })?.gravacoes ?? 0} gravações`, 'Enviado']} />
                <Bar dataKey="gb" fill="hsl(var(--status-online))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Nada enviado ainda. As gravações sobem a cada 15 min, depois de fechadas.
            </div>
          )}
        </div>
      </div>

      {uso.byCamera.length > 0 && (
        <div className="rounded border border-border p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Por câmera</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-[hsl(var(--status-online))]" /> nuvem</span>
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-[hsl(var(--primary))]" /> disco</span>
            </span>
          </div>
          <div className="space-y-2">
            {uso.byCamera.map((c) => (
              <div key={c.cameraId} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs">
                <span className="truncate" title={c.cameraName}>{c.cameraName}</span>
                <div className="flex h-2 overflow-hidden rounded bg-muted/40">
                  <div className="bg-[hsl(var(--status-online))]" style={{ width: `${(c.cloudBytes / maior) * 100}%` }} />
                  <div className="bg-[hsl(var(--primary))]" style={{ width: `${(c.localBytes / maior) * 100}%` }} />
                </div>
                <span className="tabular-nums text-muted-foreground">{formatarBytes(c.cloudBytes)} · {formatarBytes(c.localBytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Numero({ rotulo, valor, detalhe, alerta }: { rotulo: string; valor: string; detalhe?: string; alerta?: boolean }) {
  return (
    <div className={`rounded border p-3 ${alerta ? 'border-[hsl(var(--status-warning)_/_0.5)]' : 'border-border'} bg-background/55`}>
      <div className="text-[11px] text-muted-foreground">{rotulo}</div>
      <div className={`text-lg font-semibold ${alerta ? 'text-[hsl(var(--status-warning))]' : ''}`}>{valor}</div>
      {detalhe ? <div className="text-[11px] text-muted-foreground">{detalhe}</div> : null}
    </div>
  );
}

export default UsoDaNuvem;
