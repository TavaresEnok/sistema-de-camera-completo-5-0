import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, Loader2, Power, RefreshCw, RotateCw, Spline, SquareDashed, EyeOff, Video } from 'lucide-react';
import { Link } from 'wouter';
import { DetectionZonesEditor, type DetectionZone } from './DetectionZonesEditor';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { toast } from '../hooks/use-toast';
import { getRequestErrorMessage } from '../lib/request-error';
import {
  estadoDaIa,
  resumoDaFrota,
  formatarAtrasoDoQuadro,
  type LinhaDeInteligencia,
  podeDesligarIa,
  type TomDoEstado,
} from '../lib/estado-da-ia';
import { custoTipico, custoTotal, formatarCusto, descreverCusto } from '../lib/custo-da-ia';
import { podeNuncaProcurarObjeto } from '../lib/gatilho-de-objeto';

// ── CÂMERAS: onde a IA roda, e se está mesmo rodando ────────────────────────
//
// Até 13/08/2026 esta informação existia inteira no backend e não tinha tela.
// `GET /ai/intelligence` já devolvia, por câmera, se o processador está de pé,
// os quadros por segundo REAIS de inferência, o último erro e o motivo de estar
// bloqueada — e a página de IA mostrava apenas "onde a detecção está
// configurada". A diferença entre as duas coisas é a diferença entre
// "esta câmera está marcada para detectar" e "esta câmera está detectando".
//
// Aqui também morre a duplicação: o desenho de linha e áreas era feito em duas
// telas (a página Perímetro e a aba Zonas da câmera), com o MESMO componente
// gravando no MESMO campo, sem nada indicar que eram a mesma coisa.

const API_URL = getApiBaseUrl();

export type EscopoDaCamera = {
  cameraId: string;
  nome: string;
  roda: boolean;
  explicacao: string;
  objectMode: 'auto' | 'sempre' | 'nunca';
  temLinha: boolean;
};

type LinhaComCamera = LinhaDeInteligencia & {
  camera?: { id?: string; name?: string | null; online?: boolean };
  performance?: { inferAvgMs?: number | null; processFpsReal?: number | null };
};

type Inteligencia = {
  service?: { online?: boolean };
  summary?: { runningProcessors?: number; expectedProcessors?: number };
  cameras?: LinhaComCamera[];
};

const CLASSE_DO_TOM: Record<TomDoEstado, string> = {
  ok: 'text-[hsl(var(--status-online))] border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.10)]',
  neutro: 'text-[hsl(var(--muted-foreground))] border-border bg-[hsl(var(--muted)_/_0.4)]',
  atencao: 'text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)_/_0.35)] bg-[hsl(var(--chart-4)_/_0.10)]',
  erro: 'text-[hsl(var(--destructive))] border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.10)]',
};

function resumirZonas(zonas: DetectionZone[] | undefined) {
  const r = { linhas: 0, monitorar: 0, ignorar: 0 };
  for (const z of zonas ?? []) {
    if (z.kind === 'line') r.linhas += 1;
    else if (z.kind === 'include') r.monitorar += 1;
    else if (z.kind === 'exclude') r.ignorar += 1;
  }
  return r;
}

export function PainelDeCamerasDaIa({
  escopo,
  objetoLiberado,
  onMudarModo,
  onRecarregarEscopo,
}: {
  escopo: EscopoDaCamera[];
  objetoLiberado: boolean;
  onMudarModo: (cameraId: string, modo: EscopoDaCamera['objectMode']) => Promise<void> | void;
  onRecarregarEscopo: () => Promise<void> | void;
}) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const cameras = useVmsDataStore((state) => state.cameras);
  const client = useMemo(
    () => axios.create({
      baseURL: API_URL,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      timeout: 20000,
    }),
    [accessToken],
  );

  const [inteligencia, setInteligencia] = useState<Inteligencia | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [reiniciando, setReiniciando] = useState<string | null>(null);
  const [alternando, setAlternando] = useState<string | null>(null);
  /** Câmera cuja cena está sendo desenhada. Null = lista. */
  const [desenhando, setDesenhando] = useState<string | null>(null);
  const [zonasPorCamera, setZonasPorCamera] = useState<Record<string, DetectionZone[]>>({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const { data } = await client.get<Inteligencia>('/ai/intelligence');
      setInteligencia(data);
      setErro(null);
    } catch (e) {
      // Não zera o que está na tela: um soluço de rede transformaria "6 câmeras
      // analisando" em "nenhuma informação", que se lê como falha da IA.
      setErro(getRequestErrorMessage(e, 'Não foi possível saber o estado da IA agora.'));
    } finally {
      setCarregando(false);
    }
  }, [client]);

  useEffect(() => { void carregar(); }, [carregar]);

  // O estado muda sozinho (câmera cai, detector reinicia). Sem atualização
  // periódica a tela mentiria em silêncio até alguém apertar Atualizar.
  useEffect(() => {
    const timer = window.setInterval(() => void carregar(), 30_000);
    return () => window.clearInterval(timer);
  }, [carregar]);

  const porCamera = useMemo(() => {
    const mapa = new Map<string, LinhaComCamera>();
    for (const linha of inteligencia?.cameras ?? []) {
      const id = linha.camera?.id;
      if (id) mapa.set(id, linha);
    }
    return mapa;
  }, [inteligencia]);

  const reiniciar = useCallback(async (cameraId: string, nome: string) => {
    setReiniciando(cameraId);
    try {
      await client.post(`/ai/intelligence/cameras/${cameraId}/restart`);
      toast({ title: 'IA reiniciada', description: `${nome} vai voltar a analisar em alguns segundos.` });
      // Dar tempo do processador subir antes de reler — reler na hora mostraria
      // "parada" e faria o operador clicar de novo.
      window.setTimeout(() => void carregar(), 4000);
    } catch (e) {
      toast({
        title: 'Não foi possível reiniciar',
        description: getRequestErrorMessage(e, 'Falha ao reiniciar a análise desta câmera.'),
        variant: 'destructive',
      });
    } finally {
      setReiniciando(null);
    }
  }, [client, carregar]);

  /** Liga/desliga a IA NESTA câmera. O portão de verdade é o do servidor; aqui
   *  só não oferecemos o que ele recusaria (ver `podeDesligarIa`). */
  const alternarIa = useCallback(async (cameraId: string, nome: string, ligar: boolean) => {
    setAlternando(cameraId);
    try {
      await client.patch(`/cameras/${cameraId}`, { aiEnabled: ligar });
      toast({
        title: ligar ? 'IA ligada' : 'IA desligada',
        description: `${nome} ${ligar ? 'volta a ser analisada' : 'deixa de ser analisada'} em alguns segundos.`,
      });
      window.setTimeout(() => void carregar(), 4000);
      void onRecarregarEscopo();
    } catch (e) {
      toast({
        title: 'Não foi possível mudar',
        description: getRequestErrorMessage(e, 'Falha ao mudar a IA desta câmera.'),
        variant: 'destructive',
      });
    } finally {
      setAlternando(null);
    }
  }, [client, carregar, onRecarregarEscopo]);

  const zonasDe = useCallback((cameraId: string): DetectionZone[] => {
    const local = zonasPorCamera[cameraId];
    if (local) return local;
    const camera = cameras.find((c) => c.id === cameraId);
    return (camera?.detectionZones as DetectionZone[] | undefined) ?? [];
  }, [cameras, zonasPorCamera]);

  const resumo = resumoDaFrota({
    servicoOnline: inteligencia?.service?.online,
    rodando: inteligencia?.summary?.runningProcessors,
    esperadas: inteligencia?.summary?.expectedProcessors,
  });

  // Custo MEDIDO da instalação e o custo TÍPICO por câmera — este último é o que
  // permite responder "ligar mais uma vai custar quanto?" antes do clique.
  const medidas = useMemo(
    () => (inteligencia?.cameras ?? [])
      .filter((l) => l.runtime?.running)
      .map((l) => l.performance ?? null),
    [inteligencia],
  );
  const tipico = custoTipico(medidas);
  const total = formatarCusto(custoTotal(medidas));

  // ── Desenhando a cena de uma câmera ───────────────────────────────────────
  if (desenhando) {
    const camera = cameras.find((c) => c.id === desenhando);
    if (!camera) {
      setDesenhando(null);
      return null;
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <button type="button" onClick={() => setDesenhando(null)} className="btn btn-secondary btn-sm">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Voltar
          </button>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">Onde olhar · {camera.name}</div>
            <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
              Desenhe sobre a imagem: linha de travessia, área monitorada e área ignorada.
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <DetectionZonesEditor
            key={camera.id}
            cameraId={camera.id}
            cameraName={camera.name}
            initialZones={zonasDe(camera.id)}
            onSaved={(zones) => {
              setZonasPorCamera((prev) => ({ ...prev, [camera.id]: zones }));
              // Desenhar linha liga a busca por objeto no modo automático —
              // então o escopo muda junto e precisa ser relido.
              void onRecarregarEscopo();
            }}
          />
        </div>
      </div>
    );
  }

  // ── Lista ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${CLASSE_DO_TOM[resumo.tom]}`}>
          {resumo.titulo}
        </span>
        {total && (
          <span className="text-[11px] text-[hsl(var(--muted-foreground))]" title="Soma medida do tempo de CPU gasto em inferência">
            Custo agora: <strong className="font-medium text-foreground">{total}</strong>
          </span>
        )}
        {erro && <span className="text-[11px] text-[hsl(var(--destructive))]">{erro}</span>}
        <button
          type="button"
          onClick={() => { void carregar(); void onRecarregarEscopo(); }}
          className="btn btn-secondary btn-sm ml-auto"
          disabled={carregando}
          aria-label="Atualizar estado da IA"
        >
          {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          Atualizar
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!escopo.length ? (
          <div className="px-4 py-10 text-center text-xs text-[hsl(var(--muted-foreground))]">
            {carregando ? 'Carregando…' : 'Nenhuma câmera cadastrada.'}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {escopo.map((cam) => {
              const linha = porCamera.get(cam.cameraId);
              const estado = estadoDaIa(linha);
              const zonas = resumirZonas(zonasDe(cam.cameraId));
              const atraso = formatarAtrasoDoQuadro(linha?.stream?.frameAgeAvgMs);
              const camera = cameras.find((c) => c.id === cam.cameraId);
              const gravaPorObjeto = camera?.recordingMode === 'object';
              const travaDoNunca = podeNuncaProcurarObjeto({ recordingMode: camera?.recordingMode });
              return (
                <div key={cam.cameraId} className="px-4 py-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-[180px] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-xs font-medium">{cam.nome}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${CLASSE_DO_TOM[estado.tom]}`}>
                          {estado.titulo}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]" title={linha?.runtime?.lastError ?? undefined}>
                        {estado.detalhe}
                        {atraso && estado.chave === 'analisando' ? ` · ${atraso}` : ''}
                      </p>
                      {/* O custo em número, antes do clique. A tela dizia "é caro"
                          e não dizia quanto — sem número, "Sempre ligado" é aposta.
                          Medido vem de latência × frequência reais; estimado vem da
                          mediana da instalação, e os dois são ditos com palavras
                          diferentes de propósito. */}
                      {(() => {
                        const custo = descreverCusto({
                          medida: linha?.performance ?? null,
                          tipicoDaInstalacao: tipico,
                          rodando: linha?.runtime?.running === true,
                        });
                        if (!custo) return null;
                        return (
                          <p className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                            {custo.texto}
                            {!custo.medido && <span className="opacity-70"> · estimativa</span>}
                          </p>
                        );
                      })()}
                      {/* O vínculo com gravação em TEXTO: o gatilho continua na
                          aba Gravação da câmera (é decisão de gravar), mas quem
                          está aqui precisa entender que as duas conversam. */}
                      {gravaPorObjeto && (
                        <Link href={`/cameras?cameraId=${encodeURIComponent(cam.cameraId)}`}>
                          <span className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[10px] text-[hsl(var(--primary))] hover:underline">
                            <Video className="h-3 w-3" aria-hidden />
                            Grava quando a IA confirma pessoa ou veículo
                          </span>
                        </Link>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]"
                        title={travaDoNunca.motivo ?? undefined}>
                        <span className="hidden sm:inline">Procurar objetos</span>
                        <select
                          value={cam.objectMode}
                          onChange={(e) => void onMudarModo(cam.cameraId, e.target.value as EscopoDaCamera['objectMode'])}
                          disabled={!objetoLiberado}
                          className="h-7 rounded border border-border bg-background px-2 text-[11px] disabled:opacity-45"
                          aria-label={`Quando procurar objetos na câmera ${cam.nome}`}
                        >
                          <option value="auto">Com linha desenhada</option>
                          <option value="sempre">Sempre</option>
                          {/* "Nunca" some na câmera que GRAVA por objeto: ali o
                              servidor ignora a escolha (senão a câmera ficaria
                              sem gravar nada), e mostrar uma opção que o
                              servidor descarta é pior que não mostrar. */}
                          <option value="nunca" disabled={!travaDoNunca.pode}>
                            {travaDoNunca.pode ? 'Nunca' : 'Nunca — indisponível: a gravação depende do objeto'}
                          </option>
                        </select>
                      </label>

                      <button
                        type="button"
                        onClick={() => setDesenhando(cam.cameraId)}
                        className="btn btn-secondary btn-sm"
                        title="Desenhar linha e áreas sobre a imagem desta câmera"
                      >
                        <Spline className="h-3.5 w-3.5" aria-hidden />
                        Onde olhar
                      </button>

                      {(() => {
                        const trava = podeDesligarIa({
                          recordingMode: camera?.recordingMode,
                          motionTrigger: (camera as { motionTrigger?: string } | undefined)?.motionTrigger,
                        });
                        const ligada = linha?.participation?.aiEnabled !== false;
                        // Câmera cuja IA é OBRIGATÓRIA não ganha botão: oferecer
                        // um controle que o servidor vai ignorar é pior que não
                        // oferecer — o operador desliga, vê ligado de novo, e
                        // conclui que o sistema está quebrado.
                        if (!trava.pode) {
                          return (
                            <span
                              className="text-[10px] text-[hsl(var(--muted-foreground))]"
                              title={trava.motivo ?? undefined}
                            >
                              IA obrigatória aqui
                            </span>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={() => void alternarIa(cam.cameraId, cam.nome, !ligada)}
                            disabled={alternando === cam.cameraId}
                            className={`btn btn-sm ${ligada ? 'btn-secondary' : 'btn-primary'}`}
                            title={ligada ? 'Desligar a IA nesta câmera' : 'Ligar a IA nesta câmera'}
                            aria-label={`${ligada ? 'Desligar' : 'Ligar'} a IA da câmera ${cam.nome}`}
                          >
                            {alternando === cam.cameraId
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              : <Power className="h-3.5 w-3.5" aria-hidden />}
                            {ligada ? 'Desligar' : 'Ligar'}
                          </button>
                        );
                      })()}

                      {estado.ofereceReiniciar && (
                        <button
                          type="button"
                          onClick={() => void reiniciar(cam.cameraId, cam.nome)}
                          disabled={reiniciando === cam.cameraId}
                          className="btn btn-secondary btn-sm"
                          title="Reiniciar a análise desta câmera"
                          aria-label={`Reiniciar a análise da câmera ${cam.nome}`}
                        >
                          {reiniciando === cam.cameraId
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
                        </button>
                      )}
                    </div>
                  </div>

                  {(zonas.linhas > 0 || zonas.monitorar > 0 || zonas.ignorar > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-[hsl(var(--muted-foreground))]">
                      {zonas.linhas > 0 && (
                        <span className="inline-flex items-center gap-1"><Spline className="h-3 w-3" aria-hidden /> {zonas.linhas} linha{zonas.linhas > 1 ? 's' : ''}</span>
                      )}
                      {zonas.monitorar > 0 && (
                        <span className="inline-flex items-center gap-1"><SquareDashed className="h-3 w-3" aria-hidden /> {zonas.monitorar} área{zonas.monitorar > 1 ? 's' : ''} monitorada{zonas.monitorar > 1 ? 's' : ''}</span>
                      )}
                      {zonas.ignorar > 0 && (
                        <span className="inline-flex items-center gap-1"><EyeOff className="h-3 w-3" aria-hidden /> {zonas.ignorar} área{zonas.ignorar > 1 ? 's' : ''} ignorada{zonas.ignorar > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
