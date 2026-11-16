import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Link } from 'wouter';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { periodoDaContagem, somarPorBalde, csvDaContagem, FUSO_DA_CONTAGEM, type Periodo, type LinhaDaSerie } from '../lib/contagem-de-passagem';

type Linha = { cameraId: string; cameraName: string; lineId: string; lineName: string; classes: string[]; active?: boolean; enabled?: boolean };
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
  const admin = useAuthStore(s => s.user?.role === 'admin');
  const client = useMemo(() => axios.create({
    baseURL: getApiBaseUrl(),
    timeout: 20000,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  }), [accessToken]);

  const [linhas, setLinhas] = useState<Linha[] | null>(null);
  const [escolha, setEscolha] = useState('all');
  const [periodo, setPeriodo] = useState<Periodo>('hoje');
  const [tipo, setTipo] = useState('person');
  const [atualizacao, setAtualizacao] = useState(0);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);
  const [erroLinhas, setErroLinhas] = useState(false);
  const [mostrarSaidas, setMostrarSaidas] = useState(() => {
    try { return window.localStorage.getItem('drac:contagem-saidas') === '1'; } catch { return false; }
  });
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setErroLinhas(false);
    client.get<Linha[]>('/passage-counts/lines', { signal: controller.signal })
      .then(r => { if (!controller.signal.aborted) setLinhas(r.data); })
      .catch(() => { if (!controller.signal.aborted) setErroLinhas(true); });
    return () => controller.abort();
  }, [client, accessToken, atualizacao]);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const [cameraId, lineId] = escolha === 'all' ? [undefined, undefined] : escolha.split('|');
    setCarregando(true); setErro(''); setRelatorio(null); setAtualizadoEm(null);
    const load = async () => {
      const { from, to, groupBy } = periodoDaContagem(periodo, new Date());
      try {
        const { data } = await client.get<Relatorio>('/passage-counts', { signal: controller.signal,
          params: { from: from.toISOString(), to: to.toISOString(), groupBy, cameraId, lineId, kind: tipo } });
        if (!controller.signal.aborted) { setRelatorio(data); setErro(''); setAtualizadoEm(new Date()); }
      } catch { if (!controller.signal.aborted) setErro('Não foi possível atualizar a contagem.'); }
      finally {
        if (!controller.signal.aborted) { setCarregando(false); if (periodo === 'hoje') timer = setTimeout(load, 60000); }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, accessToken, periodo, escolha, tipo, atualizacao]);

  function alternarSaidas() {
    const proximo = !mostrarSaidas;
    setMostrarSaidas(proximo);
    try { window.localStorage.setItem('drac:contagem-saidas', proximo ? '1' : '0'); } catch { /* sem armazenamento local */ }
  }

  function exportar() {
    if (!relatorio || erro || carregando) return;
    const blob = new Blob([csvDaContagem(relatorio.series, linhas ?? [], mostrarSaidas)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contagem-${tipo}-${periodo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const grafico = useMemo(() => somarPorBalde(relatorio?.series ?? [], relatorio?.groupBy ?? 'hour'), [relatorio]);

  const linha = linhas?.find(l => `${l.cameraId}|${l.lineId}` === escolha);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-5" aria-busy={carregando}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5">
          {PERIODOS.map((p) => (
            <button key={p.id} onClick={() => setPeriodo(p.id)} aria-pressed={periodo === p.id}
              className={`rounded px-3 py-1 text-xs ${periodo === p.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={escolha} onChange={(e) => setEscolha(e.target.value)}
          className="h-9 min-w-0 max-w-full rounded border border-border bg-background px-2 text-xs sm:max-w-xs" aria-label="Linha">
          <option value="all">Todas as linhas</option>
          {(linhas ?? []).map((l) => (
            <option key={`${l.cameraId}|${l.lineId}`} value={`${l.cameraId}|${l.lineId}`}>{l.cameraName} · {l.lineName}{l.active === false ? ' (histórico)' : ''}</option>
          ))}
        </select>
        <select aria-label="O que contar" value={tipo} onChange={e => setTipo(e.target.value)} className="h-9 rounded border border-border bg-background px-2 text-xs">
          <option value="person">Pessoas</option><option value="vehicle">Veículos</option><option value="all">Todos os tipos</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={mostrarSaidas} onChange={alternarSaidas} />
          Mostrar saídas
        </label>
        <button onClick={() => setAtualizacao(v => v + 1)} disabled={carregando} aria-label="Atualizar contagem" className="btn btn-secondary btn-sm ml-auto"><RefreshCw className={`h-3.5 w-3.5 ${carregando ? 'animate-spin' : ''}`} /></button>
        <button onClick={exportar} disabled={!relatorio?.series.length || !!erro || carregando} className="btn btn-secondary btn-sm disabled:opacity-45">
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>
      {(erroLinhas || erro) && <div role="alert" className="rounded border border-destructive/30 p-3 text-sm text-destructive">
        {erroLinhas ? 'Não foi possível carregar as linhas.' : erro}
        <button onClick={() => setAtualizacao(v => v + 1)} className="ml-3 underline">Tentar novamente</button>
      </div>}
      {linhas?.length === 0 && !erroLinhas && <div className="rounded-lg border border-border p-4 text-sm">
        <p>Nenhuma linha de contagem configurada.</p>
        {admin ? <Link href="/perimetro" className="mt-2 inline-block text-xs text-primary underline">Configurar linha no Perímetro</Link>
          : <p className="mt-1 text-xs text-muted-foreground">Peça ao administrador para configurar a linha de entrada da loja.</p>}
      </div>}
      {(linha?.active === false || linha?.enabled === false) && <p role="status" className="text-xs text-amber-500">Exibindo histórico. Esta linha não está ativa.</p>}

      <div className={`grid gap-3 ${mostrarSaidas ? 'grid-cols-2 md:max-w-md' : 'grid-cols-1 max-w-xs'}`} aria-live="polite">
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
        ) : !relatorio ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Contagem indisponível.</div>
        ) : !grafico.length ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Sem passagens no período e filtros selecionados.</div>
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
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
        <p>Horário de Brasília · {atualizadoEm ? `Atualizado às ${atualizadoEm.toLocaleTimeString('pt-BR', { timeZone: FUSO_DA_CONTAGEM, hour: '2-digit', minute: '2-digit' })}` : 'Aguardando dados'}{periodo === 'hoje' ? ' · Atualização a cada minuto' : ''}</p>
        {admin && <Link href={'/perimetro' + (linha ? `?cameraId=${encodeURIComponent(linha.cameraId)}` : '')} className="text-primary underline">Configurar linha</Link>}
      </div>
      <p className="text-[11px] text-muted-foreground">São passagens pela linha. A mesma pessoa pode entrar mais de uma vez.</p>
    </div>
  );
}
