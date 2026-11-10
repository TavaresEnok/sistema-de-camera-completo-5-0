import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Download, Loader2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { periodoDaContagem, somarPorBalde, csvDaContagem, type Periodo, type LinhaDaSerie } from '../lib/contagem-de-passagem';

type Linha = { cameraId: string; cameraName: string; lineId: string; lineName: string; classes: string[] };
type Relatorio = { groupBy: 'hour' | 'day'; series: LinhaDaSerie[]; totals: { in: number; out: number } };

const PERIODOS: Array<{ id: Periodo; label: string }> = [
  { id: 'hoje', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

const ENTRADA = 'hsl(205,85%,58%)';
const SAIDA = 'hsl(var(--muted-foreground))';

export function ContagemDePassagem() {
  const { accessToken } = useAuthStore();
  const client = useMemo(() => axios.create({
    baseURL: getApiBaseUrl(),
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  }), [accessToken]);

  const [linhas, setLinhas] = useState<Linha[] | null>(null);
  const [escolha, setEscolha] = useState('all');
  const [periodo, setPeriodo] = useState<Periodo>('hoje');
  const [mostrarSaidas, setMostrarSaidas] = useState(() => {
    try { return window.localStorage.getItem('drac:contagem-saidas') === '1'; } catch { return false; }
  });
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!accessToken) return;
    client.get<Linha[]>('/passage-counts/lines')
      .then((r) => setLinhas(r.data))
      .catch(() => setLinhas([]));
  }, [client, accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    const { from, to, groupBy } = periodoDaContagem(periodo, new Date());
    const [cameraId, lineId] = escolha === 'all' ? [undefined, undefined] : escolha.split('|');
    setCarregando(true);
    setErro('');
    client.get<Relatorio>('/passage-counts', { params: { from: from.toISOString(), to: to.toISOString(), groupBy, cameraId, lineId } })
      .then((r) => setRelatorio(r.data))
      .catch(() => setErro('Não foi possível carregar a contagem.'))
      .finally(() => setCarregando(false));
    // Hoje se atualiza sozinho a cada minuto.
    if (periodo !== 'hoje') return;
    const timer = window.setInterval(() => {
      const atual = periodoDaContagem(periodo, new Date());
      client.get<Relatorio>('/passage-counts', { params: { from: atual.from.toISOString(), to: atual.to.toISOString(), groupBy: atual.groupBy, cameraId, lineId } })
        .then((r) => setRelatorio(r.data))
        .catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [client, accessToken, periodo, escolha]);

  function alternarSaidas() {
    const proximo = !mostrarSaidas;
    setMostrarSaidas(proximo);
    try { window.localStorage.setItem('drac:contagem-saidas', proximo ? '1' : '0'); } catch { /* sem armazenamento local */ }
  }

  function exportar() {
    if (!relatorio) return;
    const blob = new Blob([csvDaContagem(relatorio.series, linhas ?? [], mostrarSaidas)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contagem-${periodo}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const grafico = useMemo(() => somarPorBalde(relatorio?.series ?? [], relatorio?.groupBy ?? 'hour'), [relatorio]);

  if (linhas && !linhas.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <p className="text-sm text-foreground">Nenhuma linha de contagem.</p>
        <p className="text-xs">Em Perímetro, desenhe uma linha e escolha <strong>Contagem</strong>.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5">
          {PERIODOS.map((p) => (
            <button key={p.id} onClick={() => setPeriodo(p.id)}
              className={`rounded px-3 py-1 text-xs ${periodo === p.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={escolha} onChange={(e) => setEscolha(e.target.value)}
          className="h-8 rounded border border-border bg-background px-2 text-xs" aria-label="Linha">
          <option value="all">Todas as linhas</option>
          {(linhas ?? []).map((l) => (
            <option key={`${l.cameraId}|${l.lineId}`} value={`${l.cameraId}|${l.lineId}`}>{l.cameraName} · {l.lineName}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={mostrarSaidas} onChange={alternarSaidas} />
          Mostrar saídas
        </label>
        <button onClick={exportar} disabled={!relatorio?.series.length} className="btn btn-secondary btn-sm ml-auto disabled:opacity-45">
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:max-w-md">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Entradas</p>
          <p className="text-2xl font-semibold tabular-nums">{relatorio ? relatorio.totals.in.toLocaleString('pt-BR') : '—'}</p>
        </div>
        {mostrarSaidas && (
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">Saídas</p>
            <p className="text-2xl font-semibold tabular-nums">{relatorio ? relatorio.totals.out.toLocaleString('pt-BR') : '—'}</p>
          </div>
        )}
      </div>

      <div className="h-64 rounded-xl border border-border bg-card p-3">
        {carregando && !relatorio ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : erro ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">{erro}</div>
        ) : !grafico.length ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Sem passagens no período.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={grafico} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
              <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
              <ReTooltip cursor={{ fillOpacity: 0.08 }} contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="in" name="Entradas" fill={ENTRADA} radius={[3, 3, 0, 0]} />
              {mostrarSaidas && <Bar dataKey="out" name="Saídas" fill={SAIDA} radius={[3, 3, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
