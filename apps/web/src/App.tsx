import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { MotionConfig } from 'framer-motion';

import { AppLayout } from './layouts/AppLayout';

import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { useVmsDataStore } from './store/vmsDataStore';
import { useBrandingStore } from './store/brandingStore';
import { productPageTitle } from './lib/product-brand';

const queryClient = new QueryClient();

const CHUNK_RELOAD_KEY = 'drac:chunkReloaded';
// Navegar entre telas é muito comum durante operação. Um minuto preserva a
// negociação WebRTC de uma grade enquanto o operador consulta uma tela e volta,
// mas impede que sessões esquecidas consumam banda indefinidamente.
export const LIVE_ROUTE_GRACE_MS = 60_000;

/**
 * lazy() com recuperação de chunk obsoleto. Após um deploy novo, abas já abertas
 * referenciam arquivos JS com hash antigo que não existem mais no servidor; ao
 * navegar, o import dinâmico falha (ChunkLoadError) e a tela fica preta. Aqui,
 * na primeira falha recarregamos a página uma vez (puxa o index.html novo);
 * num carregamento bem-sucedido limpamos o marcador.
 */
function lazyWithReload<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await factory();
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch { /* ignore */ }
      return mod;
    } catch (err) {
      let alreadyReloaded = false;
      try { alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1'; } catch { /* ignore */ }
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(CHUNK_RELOAD_KEY, '1'); } catch { /* ignore */ }
        window.location.reload();
        // Trava o render enquanto a página recarrega.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}

const LoginPage       = lazyWithReload(() => import('./pages/LoginPage'));
const ResetPasswordPage = lazyWithReload(() => import('./pages/ResetPasswordPage'));
const LiveViewPage    = lazyWithReload(() => import('./pages/LiveViewPage'));
const PlaybackPage    = lazyWithReload(() => import('./pages/PlaybackPage'));
const ReviewPage      = lazyWithReload(() => import('./pages/ReviewPage'));
// Páginas que existiam sem rota nenhuma — 1.441 linhas inalcançáveis.
const PerformancePage = lazyWithReload(() => import('./pages/PerformancePage'));
const AuditLogsPage   = lazyWithReload(() => import('./pages/AuditLogsPage'));
const AlarmsPage      = lazyWithReload(() => import('./pages/AlarmsPage'));
const CamerasPage     = lazyWithReload(() => import('./pages/CamerasPage'));
const PTZPage         = lazyWithReload(() => import('./pages/PTZPage'));
const PerimetroPage   = lazyWithReload(() => import('./pages/PerimetroPage'));
const AiPage          = lazyWithReload(() => import('./pages/AiPage'));
const InvestigationPage = lazyWithReload(() => import('./pages/InvestigationPage'));
const StoragePage     = lazyWithReload(() => import('./pages/StoragePage'));
const SettingsPage    = lazyWithReload(() => import('./pages/SettingsPage'));
const CameraDetailPage = lazyWithReload(() => import('./pages/CameraDetailPage'));
const WallModePage    = lazyWithReload(() => import('./pages/WallModePage'));
const RondaPage       = lazyWithReload(() => import('./pages/RondaPage'));
const DistribuicaoPage = lazyWithReload(() => import('./pages/DistribuicaoPage'));
const UsersPage       = lazyWithReload(() => import('./pages/UsersPage'));
const GroupsPage      = lazyWithReload(() => import('./pages/GroupsPage'));
const RolesPage       = lazyWithReload(() => import('./pages/RolesPage'));
const ProfilePage     = lazyWithReload(() => import('./pages/ProfilePage'));
const MapPage         = lazyWithReload(() => import('./pages/MapPage'));
const UpdatesPage     = lazyWithReload(() => import('./pages/UpdatesPage'));

function AppFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Carregando...
    </div>
  );
}

/**
 * A antiga tela de "Eventos" misturava telemetria bruta, saúde de stream e
 * alarmes operacionais. Ocorrências que exigem ação vivem em /alarms; dados
 * históricos ficam em Reprodução/Investigação. Preservamos o endereço salvo
 * sem manter uma segunda fila com ações incompatíveis.
 */
function LegacyEventsRedirect() {
  return <Redirect to="/alarms" />;
}

/** Loading leve, só na área de conteúdo (mantém a sidebar/header fixos). */
function ContentFallback() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[hsl(var(--border))] border-t-[hsl(var(--primary))]" />
    </div>
  );
}

class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DRAC] Falha ao renderizar página', error, info.componentStack);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 text-center shadow-sm">
          <div className="text-sm font-semibold text-foreground">Esta página não conseguiu carregar</div>
          <div className="mt-2 text-xs text-muted-foreground">
            Não foi possível abrir esta página agora. Tente novamente.
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-xs font-medium hover:bg-accent"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
}

// Hierarquia de roles: viewer < operator < admin
// Cada rota declara o `minRole` mínimo necessário; quem não atingir é
// redirecionado para /live (já autenticado) ou /login (não autenticado).
type UiRole = 'viewer' | 'operator' | 'admin';
const ROLE_WEIGHT: Record<UiRole, number> = { viewer: 1, operator: 2, admin: 3 };

function ProtectedRoute({
  component: Page,
  minRole = 'viewer',
  active = true,
  layoutContentKey,
  pageActive,
  bare = false,
}: {
  component: React.ComponentType;
  minRole?: UiRole;
  active?: boolean;
  layoutContentKey?: string;
  /** Encaminhado somente às páginas que precisam pausar listeners invisíveis. */
  pageActive?: boolean;
  /** Janela operacional independente: não leva navegação/administração junto. */
  bare?: boolean;
}) {
  const { isAuthenticated, isBootstrapped, isLoading, user } = useAuthStore();
  const [, setLocation] = useLocation();

  const userWeight = ROLE_WEIGHT[(user?.role as UiRole) ?? 'viewer'] ?? 1;
  const hasAccess = userWeight >= ROLE_WEIGHT[minRole];

  useEffect(() => {
    if (isBootstrapped && !isAuthenticated) setLocation('/login');
    if (isBootstrapped && isAuthenticated && !hasAccess) setLocation('/live');
  }, [hasAccess, isAuthenticated, isBootstrapped, setLocation]);

  if (!isBootstrapped || isLoading) return <AppFallback />;
  if (!isAuthenticated) return null;
  if (!hasAccess) return null;

  const PageWithActivity = Page as React.ComponentType<{ pageActive?: boolean }>;

  const page = (
    <PageErrorBoundary resetKey={window.location.pathname}>
      <Suspense fallback={<ContentFallback />}>
        {pageActive === undefined ? <Page /> : <PageWithActivity pageActive={pageActive} />}
      </Suspense>
    </PageErrorBoundary>
  );

  // As telas auxiliares existem para outro monitor. Mantê-las dentro do
  // AppLayout carregava sidebar, cabeçalho, atalhos e itens administrativos
  // que não têm utilidade numa parede de vídeo e roubavam área da grade.
  if (bare) return <div className="h-[100dvh] w-full overflow-hidden bg-background">{page}</div>;

  return <AppLayout active={active} contentKey={layoutContentKey}>{page}</AppLayout>;
}

/**
 * Mantém a árvore de /live montada por uma janela curta depois que o operador
 * sai dela. Diferente de cache de dados, isto conserva os próprios players e
 * suas sessões WHEP/WebRTC. O wrapper `hidden` remove a interface da tela, e
 * `active={false}` impede que o layout retido capture atalhos ou abra diálogos.
 */
function LiveRouteWithGrace({ active }: { active: boolean }) {
  const [retained, setRetained] = useState(active);
  const releaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (releaseTimerRef.current != null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      setRetained(true);
      return;
    }
    if (!retained) return;
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      setRetained(false);
    }, LIVE_ROUTE_GRACE_MS);
    return () => {
      if (releaseTimerRef.current != null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };
  }, [active, retained]);

  useEffect(() => () => {
    if (releaseTimerRef.current != null) window.clearTimeout(releaseTimerRef.current);
  }, []);

  if (!retained) return null;
  const auxiliaryDisplay = new URLSearchParams(window.location.search).get('display');
  const isAuxiliary = auxiliaryDisplay === 'aux-1' || auxiliaryDisplay === 'aux-2' || auxiliaryDisplay === 'aux-3';
  return (
    <div hidden={!active} aria-hidden={!active}>
      <ProtectedRoute
        component={LiveViewPage}
        active={active}
        layoutContentKey="retained-live"
        pageActive={active}
        bare={isAuxiliary}
      />
    </div>
  );
}

function RootRedirect() {
  const { isAuthenticated } = useAuthStore();
  return isAuthenticated ? <Redirect to="/live" /> : <Redirect to="/login" />;
}

function ThemeSync() {
  const { theme } = useThemeStore();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'dim') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }
  }, [theme]);

  return null;
}

function BrandingSync() {
  const facilityName = useBrandingStore((state) => state.facilityName);
  const loadBranding = useBrandingStore((state) => state.load);

  useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  useEffect(() => {
    document.title = productPageTitle(facilityName);
  }, [facilityName]);

  return null;
}

function AppRoutes() {
  const [location] = useLocation();
  const isLiveRoute = location === '/live' || location.startsWith('/live?');

  return (
    <>
      <LiveRouteWithGrace active={isLiveRoute} />
      {!isLiveRoute && <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />

      {/* ── Rotas acessíveis a todos os usuários autenticados (viewer+) ── */}
      <Route path="/playback">
        {() => <ProtectedRoute component={PlaybackPage} />}
      </Route>
      <Route path="/map">
        {() => <ProtectedRoute component={MapPage} />}
      </Route>
      <Route path="/updates">
        {() => <ProtectedRoute component={UpdatesPage} />}
      </Route>
      <Route path="/review">
        {() => <ProtectedRoute component={ReviewPage} />}
      </Route>
      <Route path="/ptz">
        {() => <ProtectedRoute component={PTZPage} />}
      </Route>
      <Route path="/perimetro">
        {() => <ProtectedRoute component={PerimetroPage} />}
      </Route>
      {/* RONDA: rodízio de mosaicos no mural, cada parada com seu tempo. */}
      <Route path="/ronda">
        {() => <ProtectedRoute component={RondaPage} />}
      </Route>
      {/* Administração de mosaicos e rondas: quem monta ENTREGA à equipe. */}
      <Route path="/mosaicos">
        {() => <ProtectedRoute component={DistribuicaoPage} />}
      </Route>
      {/* `/wall` continua respondendo: quem tiver o endereço salvo ou na
          paleta de comandos não pode cair em "página não encontrada". */}
      <Route path="/wall">
        {() => <ProtectedRoute component={WallModePage} />}
      </Route>
      {/* Página de perfil: para viewer mostra seus grupos + criação de usuários
          se for group admin; para admin/operator mostra o mesmo + link para /users */}
      <Route path="/profile">
        {() => <ProtectedRoute component={ProfilePage} />}
      </Route>

      {/* ── Rotas exclusivas de operadores e admins ── */}
      <Route path="/cameras/:id">
        {() => <ProtectedRoute component={CameraDetailPage} minRole="operator" />}
      </Route>
      <Route path="/cameras">
        {() => <ProtectedRoute component={CamerasPage} minRole="operator" />}
      </Route>
      <Route path="/alarms">
        {() => <ProtectedRoute component={AlarmsPage} minRole="operator" />}
      </Route>
      <Route path="/investigation">
        {() => <ProtectedRoute component={InvestigationPage} minRole="operator" />}
      </Route>
      <Route path="/events">
        {() => <ProtectedRoute component={LegacyEventsRedirect} minRole="operator" />}
      </Route>
      <Route path="/performance">
        {() => <ProtectedRoute component={PerformancePage} minRole="operator" />}
      </Route>
      <Route path="/ia">
        {() => <ProtectedRoute component={AiPage} minRole="operator" />}
      </Route>
      <Route path="/storage">
        {() => <ProtectedRoute component={StoragePage} minRole="operator" />}
      </Route>
      <Route path="/users">
        {() => <ProtectedRoute component={UsersPage} minRole="operator" />}
      </Route>

      {/* ── Rotas exclusivas de admins ── */}
      <Route path="/settings">
        {() => <ProtectedRoute component={SettingsPage} minRole="admin" />}
      </Route>
      <Route path="/groups">
        {() => <ProtectedRoute component={GroupsPage} minRole="admin" />}
      </Route>
      <Route path="/roles">
        {() => <ProtectedRoute component={RolesPage} minRole="admin" />}
      </Route>
      <Route path="/audit-logs">
        {() => <ProtectedRoute component={AuditLogsPage} minRole="admin" />}
      </Route>
      {/* Geração de APK é exclusiva da DRAC Central — a instalação não tem
          mais a rota /app-builder, nem escondida por URL. */}

      <Route path="/" component={RootRedirect} />
      {/* URLs antigas salvas em favoritos (como /painel) e endereços que não
          existem não devem terminar numa tela morta. Para uma sessão válida,
          o destino seguro e útil é sempre o Ao Vivo; sem sessão, o login. */}
      <Route component={RootRedirect} />
      </Switch>}
    </>
  );
}

function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const revalidate = useAuthStore((state) => state.revalidate);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const loadData = useVmsDataStore((state) => state.load);
  const refreshOperational = useVmsDataStore((state) => state.refreshOperational);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Revalida o token da sessão periodicamente (a cada 5 min). Se o token expirou
  // com a aba aberta, isso detecta e redireciona para o login automaticamente.
  //
  // IMPORTANTE: usa `revalidate`, NÃO `bootstrap`. O `bootstrap` seta
  // `isLoading: true`, e o `ProtectedRoute` troca toda a árvore por <AppFallback/>
  // quando isLoading é true — desmontando todos os <LiveStreamPlayer/> e derrubando
  // as conexões WebRTC de TODAS as câmeras ao mesmo tempo (imagem piscando em lote
  // a cada 5 min). `revalidate` faz a checagem em segundo plano sem tocar isLoading.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (useAuthStore.getState().isAuthenticated) void revalidate();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [revalidate]);

  useEffect(() => {
    // Autenticado: carrega tudo. Desautenticado: cancela retentativas pendentes
    // e remove da memória os dados pertencentes à sessão anterior.
    void loadData();
  }, [isAuthenticated, loadData]);

  // A API ainda não expõe SSE/WebSocket para o estado operacional. Atualizamos
  // apenas os recursos leves em segundo plano, sem desmontar players ao vivo.
  useEffect(() => {
    if (!isAuthenticated) return;

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshOperational();
    };
    const interval = window.setInterval(refreshWhenVisible, 12_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [isAuthenticated, refreshOperational]);

  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <ThemeSync />
            <BrandingSync />
            <Suspense fallback={<AppFallback />}>
              <AppRoutes />
            </Suspense>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}

export default App;
