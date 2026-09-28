import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmAction } from '../components/ActionConfirmation';
import { Clock, LoaderCircle, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { useAutoHideControls } from '../hooks/use-auto-hide-controls';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { lerCopiaLocal, lerMosaicoDaApi, meuParaMexer, preferirApi, type MosaicoSalvo } from '../lib/mosaicos-salvos';
import { LiveStreamPlayer, type LivePlayerStatus } from '../components/LiveStreamPlayer';
import { paradaNoInstante, proximaParada, type Parada } from '../lib/ronda-rotacao';

/**
 * RONDA — o mural passa de um mosaico para outro, sozinho.
 *
 * Substitui o antigo "Modo Mural", que apenas ligava o mural do /live e
 * redirecionava para lá: era um item de menu que não levava a lugar nenhum
 * próprio.
 *
 * O nome é o do ofício: o vigia faz a RONDA, passando de ponto em ponto. Cada
 * parada fica na tela pelo tempo que o operador definir.
 *
 * DUAS DECISÕES DE TELA
 * ---------------------
 * · Os mosaicos são os MESMOS do /live. Manter uma segunda lista aqui faria o
 *   operador montar tudo duas vezes e as duas divergirem no primeiro ajuste.
 * · Ao trocar de parada, os players NÃO são desmontados e remontados do zero
 *   quando a câmera se repete entre mosaicos — remontar faz a imagem piscar, e
 *   mural que pisca a cada troca cansa em minutos.
 */

type Ronda = {
  id: string;
  name: string;
  paradas: Parada[];
  duracaoDaVoltaSegundos: number;
  /** 'recebido' = o administrador me entregou; eu rodo, mas não altero. */
  origem?: 'meu' | 'recebido';
  podeEditar?: boolean;
};


const SEGUNDOS_SUGERIDOS = [10, 15, 30, 60, 120, 300];

export default function RondaPage() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const cameras = useVmsDataStore((s) => s.cameras);
  // ── OS MOSAICOS SÃO OS QUE O OPERADOR SALVOU EM AO VIVO ──────────────────
  //
  // Antes esta tela lia `vmsDataStore.layouts`, que NÃO é a lista do operador:
  // é UM mosaico gerado, com todas as câmeras, e com um identificador que não
  // existe no banco. O servidor valida a ronda contra os layouts reais, então
  // salvar daria erro — e enquanto isso a tela oferecia um mosaico que ninguém
  // montou. Foi o que o dono viu como "não está sincronizado".
  //
  // A API é a fonte da verdade porque é contra ela que o servidor valida. A
  // cópia local só evita a tela abrir vazia enquanto a rede responde.
  const [layouts, setLayouts] = useState<MosaicoSalvo[]>(() => lerCopiaLocal());

  const [rondas, setRondas] = useState<Ronda[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const requestBusy = useRef(false);
  const [removendo, setRemovendo] = useState(false);
  const [editando, setEditando] = useState<Ronda | null>(null);
  const [rodando, setRodando] = useState<Ronda | null>(null);
  // `null` = fechado; `{...}` = editando aquele mosaico; `false` = criando um novo.
  const [mosaicoEmEdicao, setMosaicoEmEdicao] = useState<MosaicoSalvo | null | false>(null);

  const cabecalho = useMemo(() => ({ Authorization: `Bearer ${accessToken}` }), [accessToken]);

  const carregar = useCallback(async () => {
    if (!accessToken) return;
    setCarregando(true);
    try {
      // Os dois juntos, de propósito: uma ronda sem a lista de mosaicos exibiria
      // "(mosaico apagado)" em paradas que existem, e o operador acharia que
      // perdeu o trabalho.
      const [rRondas, rLayouts] = await Promise.all([
        fetch(`${getApiBaseUrl()}/rondas`, { headers: cabecalho }),
        fetch(`${getApiBaseUrl()}/live-layouts`, { headers: cabecalho }),
      ]);
      const dRondas = await rRondas.json();
      if (!rRondas.ok || !rLayouts.ok) throw new Error('Falha ao carregar');
      setRondas(Array.isArray(dRondas?.items) ? dRondas.items : []);

      const brutos = await rLayouts.json().catch(() => []);
      const daApi = (Array.isArray(brutos) ? brutos : [])
        .map(lerMosaicoDaApi)
        .filter((m): m is MosaicoSalvo => Boolean(m));
      setLayouts(preferirApi(daApi, lerCopiaLocal()));
      setErro(null);
    } catch {
      setErro('Não consegui carregar as rondas.');
    } finally {
      setCarregando(false);
    }
  }, [accessToken, cabecalho]);

  useEffect(() => { void carregar(); }, [carregar]);

  const mutate = async (url: string, init: RequestInit): Promise<boolean> => {
    if (requestBusy.current) return false;
    requestBusy.current = true;
    setSalvando(true);
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        setErro(response.status === 403 ? 'Você não tem permissão para realizar esta ação.' : response.status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível concluir. Tente novamente em instantes.');
        return false;
      }
      setErro(null);
      return true;
    } catch {
      setErro('Não foi possível conectar. Verifique sua conexão e tente novamente.');
      return false;
    } finally { requestBusy.current = false; setSalvando(false); }
  };

  const salvar = async (ronda: Ronda) => {
    const novo = !ronda.id;
    const url = novo ? `${getApiBaseUrl()}/rondas` : `${getApiBaseUrl()}/rondas/${ronda.id}`;
    const ok = await mutate(url, {
      method: novo ? 'POST' : 'PATCH',
      headers: { ...cabecalho, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ronda.name, paradas: ronda.paradas }),
    });
    if (!ok) return;
    setEditando(null);
    setErro(null);
    await carregar();
  };

  /**
   * Salva o mosaico na MESMA lista do Ao Vivo.
   *
   * Não existe lista própria da Ronda: duas listas divergiriam no primeiro
   * ajuste e o operador montaria tudo duas vezes.
   */
  const salvarMosaico = async (m: { id?: string; name: string; gridSize: string; cameraIds: string[] }) => {
    const novo = !m.id;
    const ok = await mutate(
      novo ? `${getApiBaseUrl()}/live-layouts` : `${getApiBaseUrl()}/live-layouts/${m.id}`,
      {
        method: novo ? 'POST' : 'PATCH',
        headers: { ...cabecalho, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: m.name, gridSize: m.gridSize, cameraIds: m.cameraIds }),
      },
    );
    if (!ok) return;
    setMosaicoEmEdicao(null);
    setErro(null);
    await carregar();
  };

  const remover = async (id: string) => {
    if (removendo || !(await confirmAction({ title: 'Apagar ronda?', description: 'Os mosaicos usados por esta ronda serão mantidos.', confirmLabel: 'Apagar ronda', destructive: true }))) return;
    setRemovendo(true);
    try {
      if (await mutate(`${getApiBaseUrl()}/rondas/${id}`, { method: 'DELETE', headers: cabecalho })) await carregar();
    } finally { setRemovendo(false); }
  };

  // Cobrir a aplicação inteira não é o mesmo que tela cheia: o navegador ainda
  // deixa abas, barra de endereço e a janela visíveis. O pedido precisa nascer
  // diretamente do clique do operador (regra de segurança do navegador), por
  // isso ele fica aqui, no botão Iniciar — e não dentro do efeito da Ronda.
  const iniciarRonda = useCallback((ronda: Ronda) => {
    if (typeof document !== 'undefined' && document.fullscreenEnabled && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {
        // Caso o navegador/política corporativa negue, a Ronda continua no
        // mural interno em vez de simplesmente não abrir.
      });
    }
    setRodando(ronda);
  }, []);

  const sairDaRonda = useCallback(() => {
    setRodando(null);
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  // Esc também pode sair do fullscreen antes de chegar ao listener interno da
  // Ronda. Se isso ocorrer, fechamos a experiência para não deixar um mural
  // aparentemente "em execução" numa janela comum.
  useEffect(() => {
    if (!rodando || typeof document === 'undefined') return;
    const aoMudarTelaCheia = () => {
      if (!document.fullscreenElement) setRodando(null);
    };
    document.addEventListener('fullscreenchange', aoMudarTelaCheia);
    return () => document.removeEventListener('fullscreenchange', aoMudarTelaCheia);
  }, [rodando]);

  if (rodando) {
    // AppLayout anima a página com `transform`. Um `position: fixed` dentro
    // desse ancestral deixa de ser fixo à viewport e podia parecer apenas um
    // painel grande, com menu/cabeçalho ainda à vista. Portal para `body` é a
    // garantia de tela cheia real ao iniciar a ronda, como um mural de TV.
    const mural = <MuralDaRonda ronda={rodando} layouts={layouts} cameras={cameras} onSair={sairDaRonda} />;
    return typeof document === 'undefined' ? mural : createPortal(mural, document.body);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="page-hdr">
        <div>
          <p className="page-sub">
            O mural troca de mosaico sozinho. Você escolhe a ordem e quantos segundos
            cada um fica na tela.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMosaicoEmEdicao(false)}>
            <Plus className="h-3.5 w-3.5" /> Novo mosaico
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditando({ id: '', name: '', paradas: [], duracaoDaVoltaSegundos: 0 })}>
            <Plus className="h-3.5 w-3.5" /> Nova ronda
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {erro && (
          <div role="alert" className="mb-3 rounded-lg border border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.08)] px-3 py-2 text-xs text-[hsl(var(--destructive))]">
            {erro}
          </div>
        )}

        {carregando ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : rondas.length === 0 ? (
          <div className="ops-card mx-auto max-w-lg p-8 text-center">
            <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h2 className="text-[15px] font-semibold">Nenhuma ronda montada</h2>
            <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted-foreground">
              Uma ronda é uma sequência de mosaicos que o mural exibe em rodízio. Use os
              mesmos mosaicos que você já salvou em Ao Vivo e defina quanto tempo cada um
              fica na tela.
            </p>
            {/* Mandar o operador para outra tela logo depois de ele entrar
                nesta é o que fazia falta. O mosaico se monta aqui mesmo. */}
            <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => setMosaicoEmEdicao(false)}>
              <Plus className="h-3.5 w-3.5" /> {layouts.length === 0 ? 'Montar o primeiro mosaico' : 'Montar um mosaico'}
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rondas.map((r) => (
              <article key={r.id} className="ops-card flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{r.name}</h3>
                  {meuParaMexer(r) ? (
                    <button disabled={removendo || salvando} type="button" aria-label={`Apagar ${r.name}`} className="text-muted-foreground hover:text-[hsl(var(--destructive))]" onClick={() => void remover(r.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    // Ronda entregue pelo administrador. Sem este selo o
                    // operador clicaria em Editar e levaria um erro seco.
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                      Recebida
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] text-muted-foreground">
                  {r.paradas.length} parada{r.paradas.length === 1 ? '' : 's'} · volta de {formatarDuracao(r.duracaoDaVoltaSegundos)}
                </p>
                <div className="mt-1 flex gap-2">
                  <button type="button" className="btn btn-primary btn-sm flex-1" onClick={() => iniciarRonda(r)}>
                    <Play className="h-3.5 w-3.5" /> Iniciar
                  </button>
                  {meuParaMexer(r) && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditando(r)}>
                      Editar
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {mosaicoEmEdicao !== null && (
        <EditorDeMosaico
          mosaico={mosaicoEmEdicao === false ? null : mosaicoEmEdicao}
          cameras={cameras}
          onCancelar={() => { setMosaicoEmEdicao(null); setErro(null); }}
          onSalvar={salvarMosaico}
          salvando={salvando}
          erro={erro}
        />
      )}

      {editando && (
        <EditorDaRonda
          ronda={editando}
          layouts={layouts}
          onCancelar={() => { setEditando(null); setErro(null); }}
          onSalvar={salvar}
          salvando={salvando}
          erro={erro}
          onNovoMosaico={() => setMosaicoEmEdicao(false)}
          onEditarMosaico={(id) => {
            const m = layouts.find((l) => l.id === id);
            // Mosaico entregue pelo administrador é de leitura: abrir o editor
            // só levaria a um 403 na hora de salvar.
            if (m && !meuParaMexer(m)) return;
            setMosaicoEmEdicao(m ?? null);
          }}
        />
      )}
    </div>
  );
}

const GRADES = ['1x1', '2x2', '3x3', '4x4', '2x1', '3x2', '4x3'] as const;

/**
 * MONTAR UM MOSAICO SEM SAIR DAQUI.
 *
 * "não vi onde em rondas eu consigo criar novos mosaicos sem ir para a página
 *  live" (dono, 26/08/2026) — e ele tinha pedido isso desde o começo: "pode ser
 *  até as mesmas grids que ficam na tela de live, mas que também dá para
 *  modificar nessa tela".
 *
 * O mosaico é salvo na MESMA lista do Ao Vivo (`/live-layouts`), não numa lista
 * própria daqui. Duas listas divergiriam no primeiro ajuste, e o operador teria
 * de montar tudo duas vezes.
 */
function EditorDeMosaico({
  mosaico, cameras, onCancelar, onSalvar, salvando, erro,
}: {
  mosaico: MosaicoSalvo | null;
  salvando: boolean;
  erro: string | null;
  cameras: { id: string; name: string }[];
  onCancelar: () => void;
  onSalvar: (m: { id?: string; name: string; gridSize: string; cameraIds: string[] }) => void | Promise<void>;
}) {
  const [nome, setNome] = useState(mosaico?.name ?? '');
  const [grade, setGrade] = useState(mosaico?.gridSize ?? '2x2');
  const [posicoes, setPosicoes] = useState<string[]>(mosaico?.cameraIds ?? []);

  const colunas = Math.max(1, Number(grade.split('x')[0]) || 2);
  const linhas = Math.max(1, Number(grade.split('x')[1]) || 2);
  const total = colunas * linhas;

  // Trocar de grade PRESERVA o que já estava posicionado. Zerar faria o
  // operador refazer o trabalho por experimentar um formato.
  const slots = Array.from({ length: total }, (_, i) => posicoes[i] ?? '');

  const definir = (indice: number, cameraId: string) => {
    const novo = [...slots];
    novo[indice] = cameraId;
    setPosicoes(novo);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="ops-card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">{mosaico ? 'Editar mosaico' : 'Novo mosaico'}</h2>
          <button disabled={salvando} type="button" onClick={onCancelar} aria-label="Fechar"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground" htmlFor="mosaico-nome">Nome</label>
              <input id="mosaico-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Portaria" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground" htmlFor="mosaico-grade">Formato</label>
              <select id="mosaico-grade" value={grade} onChange={(e) => setGrade(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm">
                {GRADES.map((g) => <option key={g} value={g}>{g.replace('x', ' × ')}</option>)}
              </select>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Câmeras nas posições
            </p>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${colunas}, minmax(0, 1fr))` }}>
              {slots.map((atual, i) => (
                <select
                  key={i}
                  value={atual}
                  onChange={(e) => definir(i, e.target.value)}
                  aria-label={`Posição ${i + 1}`}
                  className="h-9 min-w-0 rounded-lg border border-border bg-background px-2 text-xs"
                >
                  <option value="">— vazio —</option>
                  {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Deixar posição vazia é válido: o espaço fica em branco no mural, na mesma ordem.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
          <button disabled={salvando} type="button" className="btn btn-secondary btn-sm" onClick={onCancelar}>Cancelar</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={salvando || !nome.trim() || !slots.some(Boolean)}
            onClick={() => void onSalvar({ id: mosaico?.id, name: nome.trim(), gridSize: grade, cameraIds: slots })}
          >
            {salvando ? 'Salvando...' : 'Salvar mosaico'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatarDuracao(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return s ? `${m}min ${s}s` : `${m}min`;
}

/** Montagem da ronda: escolher mosaicos, ordenar, dar tempo a cada um. */
function EditorDaRonda({
  ronda, layouts, onCancelar, onSalvar, onNovoMosaico, onEditarMosaico, salvando, erro,
}: {
  ronda: Ronda;
  salvando: boolean;
  erro: string | null;
  layouts: MosaicoSalvo[];
  onCancelar: () => void;
  onSalvar: (r: Ronda) => void | Promise<void>;
  /** Montar um mosaico sem sair da ronda que está sendo criada. */
  onNovoMosaico: () => void;
  onEditarMosaico: (layoutId: string) => void;
}) {
  const [nome, setNome] = useState(ronda.name);
  const [paradas, setParadas] = useState<Parada[]>(ronda.paradas);

  const nomeDoLayout = (id: string) => layouts.find((l) => l.id === id)?.name ?? '(mosaico apagado)';
  const total = paradas.reduce((s, p) => s + p.segundos, 0);

  const acrescentar = (layoutId: string) => {
    // O mesmo mosaico duas vezes SEGUIDAS não muda nada na tela — o servidor
    // recusa, e aqui a gente evita o operador chegar até lá.
    if (paradas.length && paradas[paradas.length - 1].layoutId === layoutId) return;
    setParadas([...paradas, { layoutId, segundos: 30 }]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="ops-card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">{ronda.id ? 'Editar ronda' : 'Nova ronda'}</h2>
          <button disabled={salvando} type="button" onClick={onCancelar} aria-label="Fechar"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground" htmlFor="ronda-nome">Nome</label>
            <input id="ronda-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ronda noturna" className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" />
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Acrescentar mosaico</p>
            {layouts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                <p className="text-xs text-muted-foreground">Nenhum mosaico salvo ainda.</p>
                <button type="button" className="btn btn-primary btn-sm mt-2" onClick={onNovoMosaico}>
                  <Plus className="h-3.5 w-3.5" /> Montar o primeiro
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={onNovoMosaico}
                  className="rounded-lg border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-[hsl(var(--accent))]"
                >
                  + Novo mosaico
                </button>
                {layouts.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => acrescentar(l.id)}
                    disabled={paradas.length > 0 && paradas[paradas.length - 1].layoutId === l.id}
                    title={paradas.length > 0 && paradas[paradas.length - 1].layoutId === l.id ? 'Já é a última parada — repetir seguido não muda a tela' : undefined}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Paradas, em ordem</p>
              {paradas.length > 0 && <p className="text-[11px] text-muted-foreground">volta de {formatarDuracao(total)}</p>}
            </div>
            {paradas.length === 0 ? (
              <p className="text-xs text-muted-foreground">Escolha ao menos um mosaico acima.</p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {paradas.map((p, i) => (
                  <li key={`${p.layoutId}-${i}`} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <span className="w-5 shrink-0 text-center text-[11px] text-muted-foreground">{i + 1}</span>
                    <button
                      type="button"
                      onClick={() => onEditarMosaico(p.layoutId)}
                      title="Editar este mosaico"
                      className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                    >
                      {nomeDoLayout(p.layoutId)}
                    </button>
                    <select
                      value={p.segundos}
                      onChange={(e) => setParadas(paradas.map((x, j) => (j === i ? { ...x, segundos: Number(e.target.value) } : x)))}
                      className="h-8 shrink-0 rounded-lg border border-border bg-background px-2 text-xs"
                      aria-label={`Tempo da parada ${i + 1}`}
                    >
                      {SEGUNDOS_SUGERIDOS.map((s) => <option key={s} value={s}>{formatarDuracao(s)}</option>)}
                    </select>
                    <button type="button" aria-label={`Remover parada ${i + 1}`} className="shrink-0 text-muted-foreground hover:text-[hsl(var(--destructive))]" onClick={() => setParadas(paradas.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
          <button disabled={salvando} type="button" className="btn btn-secondary btn-sm" onClick={onCancelar}>Cancelar</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={salvando || !nome.trim() || paradas.length === 0}
            onClick={() => void onSalvar({ ...ronda, name: nome.trim(), paradas })}
          >
            {salvando ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** O mural em si: tela cheia, trocando de mosaico sozinho. */
function MuralDaRonda({
  ronda, layouts, cameras, onSair,
}: {
  ronda: Ronda;
  layouts: MosaicoSalvo[];
  cameras: { id: string; name: string }[];
  onSair: () => void;
}) {
  // PARADAS COM CONTEÚDO — uma parada cujo mosaico foi APAGADO (layout não
  // existe mais) ou que está VAZIA (nenhuma câmera nas posições) não tem o que
  // exibir e viraria tela preta. A ronda PULA essas: o rodízio percorre só as
  // paradas válidas, e a numeração ("parada X de Y") reflete essa lista.
  const paradasValidas = useMemo(() => {
    return ronda.paradas.filter((p) => {
      const l = layouts.find((x) => x.id === p.layoutId);
      return !!l && (l.cameraIds?.some((id) => !!id) ?? false);
    });
  }, [ronda.paradas, layouts]);

  const [indice, setIndice] = useState(0);
  const [pausado, setPausado] = useState(false);
  const [restante, setRestante] = useState(paradasValidas[0]?.segundos ?? 30);
  const inicioRef = useRef<number>(Date.now());
  // A ronda não pode começar no instante em que os players montam. Cada
  // WebRTC/RTSP precisa negociar, pedir keyframe e desenhar o primeiro quadro;
  // trocar de mosaico enquanto isso acontece era exatamente o "preto, aparece,
  // preto de novo" que o operador viu.
  const [preparando, setPreparando] = useState(true);
  const preparoConcluidoRef = useRef(false);
  const [statusDosPlayers, setStatusDosPlayers] = useState<Record<string, LivePlayerStatus>>({});
  // Controles (cabeçalho/rodapé) somem sozinhos, como no Modo Mural: a ronda
  // fica horas numa TV e barras fixas roubam área das câmeras.
  const { visivel, propsDoControle } = useAutoHideControls(true);

  // Todas as telas são montadas durante a preparação e continuam montadas
  // durante a ronda. Assim, ao voltar da tela 2 para a 1, a conexão da tela 1
  // ainda existe — não há uma nova negociação WebRTC nem novo frame preto.
  const telas = useMemo(() => paradasValidas.map((parada, indiceDaParada) => {
    const layout = layouts.find((item) => item.id === parada.layoutId)!;
    const colunas = Math.max(1, Number(String(layout.gridSize ?? '2x2').split('x')[0]) || 2);
    const linhas = Math.max(1, Number(String(layout.gridSize ?? '2x2').split('x')[1]) || 2);
    const posicoes = Array.from({ length: colunas * linhas }, (_, posicao) => {
      const cameraId = layout.cameraIds?.[posicao];
      return cameraId ? String(cameraId) : null;
    });
    return { parada, layout, indiceDaParada, colunas, linhas, posicoes };
  }), [layouts, paradasValidas]);

  const chavesDosPlayers = useMemo(
    () => telas.flatMap((tela) => tela.posicoes.flatMap((cameraId, posicao) => cameraId ? [`${tela.indiceDaParada}:${posicao}`] : [])),
    [telas],
  );
  const prontosParaExibir = chavesDosPlayers.length > 0 && chavesDosPlayers.every((chave) => {
    const estado = statusDosPlayers[chave]?.state;
    // Um erro é um resultado terminal: o tile mostrará o aviso próprio, mas a
    // ronda não fica congelada para sempre por uma câmera offline.
    return estado === 'playing' || estado === 'fallback' || estado === 'error';
  });
  const quantidadePronta = chavesDosPlayers.filter((chave) => {
    const estado = statusDosPlayers[chave]?.state;
    return estado === 'playing' || estado === 'fallback' || estado === 'error';
  }).length;

  const registrarStatusDoPlayer = useCallback((chave: string, status: LivePlayerStatus) => {
    setStatusDosPlayers((atual) => {
      const anterior = atual[chave];
      if (anterior?.state === status.state && anterior?.activeProtocol === status.activeProtocol && anterior?.reason === status.reason) return atual;
      return { ...atual, [chave]: status };
    });
  }, []);

  const finalizarPreparo = useCallback(() => {
    if (preparoConcluidoRef.current) return;
    preparoConcluidoRef.current = true;
    inicioRef.current = Date.now();
    setIndice(0);
    setRestante(paradasValidas[0]?.segundos ?? 30);
    setPreparando(false);
  }, [paradasValidas]);

  useEffect(() => {
    if (prontosParaExibir) finalizarPreparo();
  }, [finalizarPreparo, prontosParaExibir]);

  useEffect(() => {
    // Há câmeras que podem estar realmente offline. Depois de uma janela ampla
    // de aquecimento, começamos com as disponíveis e deixamos o tile com erro
    // se recuperar sozinho, em vez de transformar uma câmera ruim em uma ronda
    // que nunca começa.
    const limite = window.setTimeout(finalizarPreparo, 28_000);
    return () => window.clearTimeout(limite);
  }, [finalizarPreparo]);

  // A posição é calculada pelo TEMPO DECORRIDO, não por contagem de trocas.
  // Assim a aba que ficou em segundo plano — onde o navegador estrangula o
  // temporizador — volta na parada certa em vez de ficar para trás.
  useEffect(() => {
    if (preparando || pausado || paradasValidas.length === 0) return;
    const t = setInterval(() => {
      const decorrido = (Date.now() - inicioRef.current) / 1000;
      const pos = paradaNoInstante(paradasValidas, decorrido);
      setIndice(pos.indice);
      setRestante(Math.max(0, Math.ceil((paradasValidas[pos.indice]?.segundos ?? 0) - pos.segundosNaParada)));
    }, 500);
    return () => clearInterval(t);
  }, [pausado, paradasValidas, preparando]);

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSair();
      if (e.key === ' ') { e.preventDefault(); setPausado((p) => !p); }
      if (e.key === 'ArrowRight' && paradasValidas.length > 0) {
        const proximo = proximaParada(indice, paradasValidas.length);
        setIndice(proximo);
        // Reposiciona o relógio para a parada escolhida continuar do começo.
        const antes = paradasValidas.slice(0, proximo).reduce((s, p) => s + p.segundos, 0);
        inicioRef.current = Date.now() - antes * 1000;
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [indice, onSair, paradasValidas]);

  // Nenhuma parada tem conteúdo (todos os mosaicos apagados/vazios): aviso
  // honesto em vez de tela preta muda, com saída à mão.
  if (paradasValidas.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black text-white">
        <p className="text-sm text-white/70">Esta ronda não tem nenhum mosaico com câmeras.</p>
        <p className="text-xs text-white/45">Os mosaicos podem ter sido apagados ou estão vazios.</p>
        <button type="button" onClick={onSair} className="mt-2 rounded-lg border border-white/20 px-4 py-1.5 text-sm hover:bg-white/10">
          Sair
        </button>
      </div>
    );
  }

  const telaAtual = telas[Math.min(indice, telas.length - 1)];
  const parada = telaAtual?.parada;
  const layout = telaAtual?.layout;

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Todas as grades ficam vivas em camadas. A camada inativa está invisível
          para o operador, mas não é desmontada: ao retornar a ela, o frame já
          está no vídeo em vez de reiniciar a trilha. */}
      {telas.map((tela) => {
        const ativa = tela.indiceDaParada === Math.min(indice, telas.length - 1);
        return (
          <div
            key={`${tela.layout.id}-${tela.indiceDaParada}`}
            aria-hidden={!ativa}
            className={`absolute inset-0 grid place-items-center p-0.5 transition-opacity duration-300 ${ativa && !preparando ? 'z-[1] opacity-100' : 'pointer-events-none z-0 opacity-0'}`}
          >
            <div
              className="grid max-h-full max-w-full gap-0.5"
              style={{
                gridTemplateColumns: `repeat(${tela.colunas}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${tela.linhas}, minmax(0, 1fr))`,
                aspectRatio: `${tela.colunas * 16} / ${tela.linhas * 9}`,
                width: '100%', maxWidth: '100%', maxHeight: '100%',
              }}
            >
              {tela.posicoes.map((cameraId, posicao) => (
                <div key={cameraId ? `${cameraId}-${posicao}` : `vazio-${posicao}`} className="relative min-h-0 bg-black">
                  {cameraId && (
                    <LiveStreamPlayer
                      cameraId={cameraId}
                      cameraName={cameras.find((camera) => camera.id === cameraId)?.name ?? ''}
                      liveViewMode="grid"
                      className="absolute inset-0 h-full w-full"
                      showOverlay={false}
                      startDelayMs={Math.min((tela.indiceDaParada * tela.posicoes.length + posicao) * 120, 3_000)}
                      onStatusChange={(status) => registrarStatusDoPlayer(`${tela.indiceDaParada}:${posicao}`, status)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {preparando && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black text-center text-white">
          <LoaderCircle className="h-7 w-7 animate-spin text-white/70" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Carregando ronda…</p>
            <p className="mt-1 text-xs text-white/55">
              Preparando {quantidadePronta} de {chavesDosPlayers.length} câmera{chavesDosPlayers.length === 1 ? '' : 's'} para iniciar a ronda.
            </p>
          </div>
          <button type="button" onClick={onSair} className="mt-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10">
            Cancelar
          </button>
        </div>
      )}

      {/* Cabeçalho flutuante (auto-hide), sobre a grade em tela cheia. */}
      <div {...propsDoControle} className={`absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-black/55 px-4 py-2 text-white backdrop-blur-sm transition-opacity duration-300 ${visivel ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        <span className="text-sm font-semibold">{ronda.name}</span>
        <span className="text-xs opacity-70">
          {layout?.name ?? '(mosaico apagado)'} · parada {Math.min(indice, paradasValidas.length - 1) + 1} de {paradasValidas.length}
        </span>
        <span className="ml-auto font-mono text-xs tabular-nums opacity-80">{restante}s</span>
        <button type="button" onClick={() => setPausado((p) => !p)} aria-label={pausado ? 'Retomar' : 'Pausar'} className="rounded p-1 hover:bg-white/10">
          {pausado ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </button>
        <button type="button" onClick={onSair} aria-label="Sair da ronda" className="rounded p-1 hover:bg-white/10">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Rodapé flutuante (auto-hide). */}
      <p className={`absolute inset-x-0 bottom-0 z-10 bg-black/55 px-4 py-1 text-[10.5px] text-white/60 backdrop-blur-sm transition-opacity duration-300 ${visivel ? 'opacity-100' : 'opacity-0'}`}>
        Espaço pausa · seta direita pula para a próxima · Esc sai
      </p>
    </div>
  );
}
