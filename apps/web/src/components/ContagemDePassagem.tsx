import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Link } from 'wouter';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { usePermissionsStore } from '../store/permissionsStore';
import { periodoDaContagem, somarPorBalde, csvDaContagem, FUSO_DA_CONTAGEM, type Periodo, type LinhaDaSerie } from '../lib/contagem-de-passagem';

type Linha = { cameraId: string; cameraName: string; lineId: string; lineName: string; active?: boolean; enabled?: boolean; lastPassageAt?: string | null };
type Relatorio = { from: string; to: string; groupBy: 'hour' | 'day'; series: LinhaDaSerie[]; totals: { in: number; out: number } };

const PERIODOS: Array<{ id: Periodo; label: string }> = [
  { id: 'hoje', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

const ENTRADA = 'hsl(205,85%,58%)';
const SAIDA = 'hsl(var(--muted-foreground))';
const DATA_PASSAGEM = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_CONTAGEM, dateStyle: 'short', timeStyle: 'short',
});

export default function PaginaDeContagem() {
  const { accessToken } = useAuthStore();
  const { loaded, error, role, permissions } = usePermissionsStore();
  if (!loaded) return <p role="status" className="p-5 text-sm">Verificando acesso à contagem…</p>;
  if (error) return <p role="alert" className="p-5 text-sm">
    Não foi possível verificar seu acesso.{' '}
    <button className="underline" onClick={() => accessToken && void usePermissionsStore.getState().load(accessToken)}>Tentar novamente</button>
  </p>;
  if (role !== 'SUPER_ADMIN' && !permissions.playback) {
    return <p className="p-5 text-sm">A contagem requer permissão de reprodução.</p>;
  }
  return <ContagemDePassagem />;
}

function ContagemDePassagem() {
  const { accessToken, user } = useAuthStore();
  const podeConfigurar = usePermissionsStore(s => user?.role === 'admin' && (s.role === 'SUPER_ADMIN' || s.permissions.cameraConfig === true));
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
  const [recarregarLinhas, setRecarregarLinhas] = useState(0);
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
  }, [client, accessToken, atualizacao, recarregarLinhas]);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const [cameraId, lineId] = escolha === 'all' ? [undefined, undefined] : escolha.split('|');
    setCarregando(true); setErro(''); setRelatorio(null); setAtualizadoEm(null);
    const load = async (automatica = false) => {
      const { from, to, groupBy } = periodoDaContagem(periodo, new Date());
      try {
        const { data } = await client.get<Relatorio>('/passage-counts', { signal: controller.signal,
          params: { from: from.toISOString(), to: to.toISOString(), groupBy, cameraId, lineId, kind: tipo } });
        if (!controller.signal.aborted) {
          setRelatorio(data);
          setErro('');
          setAtualizadoEm(new Date());
          if (automatica) setRecarregarLinhas(v => v + 1);
        }
      } catch { if (!controller.signal.aborted) setErro('Não foi possível atualizar a contagem.'); }
      finally {
        if (!controller.signal.aborted) { setCarregando(false); if (periodo === 'hoje') timer = setTimeout(() => void load(true), 60000); }
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

  const grafico = useMemo(() => relatorio ? somarPorBalde(relatorio.series, relatorio.groupBy, relatorio) : [], [relatorio]);
  const totaisPorLinha = useMemo(() => {
    const totais = new Map<string, { in: number; out: number }>();
    for (const item of relatorio?.series ?? []) {
      const chave = `${item.cameraId}|${item.lineId}`;
      const total = totais.get(chave) ?? { in: 0, out: 0 };
      total.in += item.in;
      total.out += item.out;
      totais.set(chave, total);
    }
    return totais;
  }, [relatorio]);

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
        {podeConfigurar ? <Link href="/perimetro" className="mt-2 inline-block text-xs text-primary underline">Configurar linha no Perímetro</Link>
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
              <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: SAIDA }} minTickGap={14} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: SAIDA }} />
              <ReTooltip cursor={{ fillOpacity: 0.08 }} contentStyle={{ fontSize: 12, background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} />
              <Bar dataKey="in" name="Entradas" fill={ENTRADA} maxBarSize={32} radius={[3, 3, 0, 0]} />
              {mostrarSaidas && <Bar dataKey="out" name="Saídas" fill={SAIDA} maxBarSize={32} radius={[3, 3, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {relatorio && !erroLinhas && linhas && linhas.length > 0 && (
        <section className="rounded-xl border border-border bg-card" aria-labelledby="contagem-por-linha">
          <h2 id="contagem-por-linha" className="px-4 pt-4 text-sm font-semibold">Passagens por linha</h2>
          <ul className="divide-y divide-border px-4">
            {(linha ? [linha] : linhas).map(item => {
              const chave = `${item.cameraId}|${item.lineId}`;
              const totais = totaisPorLinha.get(chave);
              return (
                <li key={chave} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)] sm:items-center">
                  <div className="min-w-0 break-words">
                    <p className="text-sm font-medium">{item.cameraName}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.lineName}{item.active === false ? ' · Histórico' : item.enabled === false ? ' · Desativada' : ''}
                    </p>
                  </div>
                  <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                    <div><dt className="text-muted-foreground">Entradas</dt><dd className="mt-0.5 tabular-nums">{(totais?.in ?? 0).toLocaleString('pt-BR')}</dd></div>
                    {mostrarSaidas && <div><dt className="text-muted-foreground">Saídas</dt><dd className="mt-0.5 tabular-nums">{(totais?.out ?? 0).toLocaleString('pt-BR')}</dd></div>}
                    <div>
                      <dt className="text-muted-foreground">Última passagem na linha</dt>
                      <dd className="mt-0.5">{item.lastPassageAt ? <time dateTime={item.lastPassageAt}>{DATA_PASSAGEM.format(new Date(item.lastPassageAt))}</time> : 'Sem registro'}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
        <p>Horário de Brasília · {atualizadoEm ? `Atualizado às ${atualizadoEm.toLocaleTimeString('pt-BR', { timeZone: FUSO_DA_CONTAGEM, hour: '2-digit', minute: '2-digit' })}` : 'Aguardando dados'}{periodo === 'hoje' ? ' · Atualização a cada minuto' : ''}</p>
        {podeConfigurar && linhas && linhas.length > 0 && <Link href={'/perimetro' + (linha ? `?cameraId=${encodeURIComponent(linha.cameraId)}` : '')} className="text-primary underline">Configurar linha</Link>}
      </div>
      <p className="text-[11px] text-muted-foreground">São passagens pela linha. A mesma pessoa pode entrar mais de uma vez.</p>
    </div>
  );
}
