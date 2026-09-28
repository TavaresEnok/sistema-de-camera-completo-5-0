import { Link, useLocation } from 'wouter';
import { motion } from 'framer-motion';
import {
  Monitor, PlaySquare, Sparkles,
  Camera, Settings,
  LogOut, Keyboard, Shield,
  Server, Users, Radar, FolderKey, ShieldCheck, Search, Sun, Moon,
  Bell, Crosshair, HardDrive, UserCircle, ShieldAlert, MapPinned, Newspaper,
  CircleHelp, LayoutGrid, Activity, FileSearch, ScrollText, Brain,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useIsMobile } from '../hooks/use-mobile';
import { useBrandingStore } from '../store/brandingStore';
import { ADMIN_PAGE_PERMISSION, hasPermission, usePermissionsStore } from '../store/permissionsStore';
import { useDeteccoesNaoVistas, formatarContador } from '../hooks/use-deteccoes-nao-vistas';

type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  roles?: string[];
};

type NavSection = {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Monitoramento',
    icon: Radar,
    items: [
      { path: '/live',     label: 'Ao Vivo',       icon: Monitor },
      { path: '/playback', label: 'Reprodução',     icon: PlaySquare },
      { path: '/map',      label: 'Mapa',           icon: MapPinned },
      { path: '/review',   label: 'Revisão',        icon: Sparkles },
      // Alertas requerem operador ou superior (viewers não têm acesso)
      { path: '/alarms',   label: 'Alarmes',        icon: Bell,     roles: ['admin', 'operator'] },
      { path: '/ptz',      label: 'Controle PTZ',   icon: Crosshair },
      { path: '/perimetro', label: 'Perímetro',     icon: ShieldAlert, roles: ['admin', 'operator'] },
      // "Modo Mural" apenas ligava o mural do /live e redirecionava — item de
      // menu que não levava a lugar nenhum próprio. Virou RONDA: rodízio de
      // mosaicos, cada parada com seu tempo. O nome é o do ofício — o vigia faz
      // a ronda, passando de ponto em ponto.
      { path: '/ronda',    label: 'Minhas rondas',  icon: LayoutGrid },
    ],
  },
  {
    label: 'Infraestrutura',
    icon: Server,
    items: [
      // Câmeras e Armazenamento são exclusivos de admin/operador
      { path: '/cameras', label: 'Câmeras',       icon: Camera,   roles: ['admin', 'operator'] },
      { path: '/storage', label: 'Armazenamento', icon: HardDrive, roles: ['admin', 'operator'] },
      { path: '/performance', label: 'Desempenho', icon: Activity,  roles: ['admin', 'operator'] },
      { path: '/ia',      label: 'Inteligência', icon: Brain,    roles: ['admin', 'operator'] },
    ],
  },
  {
    label: 'Investigação',
    icon: FileSearch,
    items: [
      { path: '/investigation', label: 'Investigação', icon: FileSearch, roles: ['admin', 'operator'] },
    ],
  },
  {
    label: 'Administração',
    icon: Users,
    items: [
      // Viewer vê "Minha conta" (perfil + gestão do próprio grupo se for group admin)
      { path: '/profile', label: 'Minha conta', icon: UserCircle },
      { path: '/updates', label: 'Novidades', icon: Newspaper },
      { path: '/users',   label: 'Usuários',    icon: Users,       roles: ['admin', 'operator'] },
      // Grupos: apenas admin global (Ajust Consulting gerencia grupos)
      { path: '/groups',  label: 'Grupos',      icon: FolderKey,   roles: ['admin'] },
      // O par de "Minhas rondas": lá o operador monta o que é dele, aqui o
      // administrador vê o de todo mundo e entrega à equipe.
      { path: '/mosaicos', label: 'Mosaicos e rondas', icon: LayoutGrid, roles: ['admin'] },
      { path: '/roles',   label: 'Funções',     icon: ShieldCheck, roles: ['admin'] },
      { path: '/settings',label: 'Configurações',icon: Settings,   roles: ['admin'] },
      { path: '/audit-logs', label: 'Auditoria', icon: ScrollText,  roles: ['admin'] },
      // Geração de APK é exclusiva da DRAC Central (painel mestre) — a
      // instalação não tem mais essa tela nem a rota.
    ],
  },
];

/**
 * Páginas SEMPRE escondidas do menu.
 *
 * A rota continua existindo e funcionando — quem tem o endereço direto entra
 * normalmente. É só a porta de entrada visível que sai do caminho do operador.
 *
 * A página de IA (/ia) NÃO entra aqui: ela é por-instalação, controlada pela
 * flag `aiFeatureEnabled` do servidor — visível onde a IA foi contratada
 * (a matriz), escondida onde não foi (um cliente sem IA). Ver mais abaixo.
 */
const PAGINAS_OCULTAS = new Set<string>([
  '/investigation',
  '/audit-logs',
  // A fila de detecções deixou de ser item de menu porque virou ABA da
  // Inteligência (13/08/2026) — não porque foi desativada. A rota segue de pé:
  // /review é o destino do link direto da notificação do aplicativo.
  '/review',
  // PERÍMETRO VOLTOU AO MENU (14/08/2026).
  //
  // Eu o escondi na reorganização da IA alegando que virara aba da
  // Inteligência. Errado, e o dono corrigiu: "em inteligencia não tem como eu
  // desenhar o perimetro!". Tirei do menu o único caminho para uma função que
  // NÃO tem substituto.
  //
  // E tirei de todas as instalações, quando o pedido era removê-la só do
  // D-GUARDIAN. Esconder página é decisão POR INSTALAÇÃO: para isso existe
  // `hiddenNavPaths` nas configurações de cada uma. É lá que o D-GUARDIAN
  // esconde — nunca aqui, no código que vale para todos.
]);

/* Role accent — no red for admin; steel blue hierarchy */
const ROLE_COLOR: Record<string, string> = {
  admin:    'text-[hsl(var(--primary))]',
  operator: 'text-[hsl(var(--chart-2))]',
  viewer:   'text-[hsl(var(--muted-foreground))]',
};

export function Sidebar({
  onAtalhosOpen,
  onSearchOpen,
}: {
  onAtalhosOpen?: () => void;
  onSearchOpen?: () => void;
}) {
  const isMobile = useIsMobile();
  // Desktop permanece sempre aberto. No celular a versão compacta continua
  // automática por responsividade, sem botão ou preferência de recolhimento.
  const isExpanded = !isMobile;
  const { user, logout } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const [location] = useLocation();
  const isDark = theme === 'dark' || theme === 'dim';
  const role = user?.role ?? 'operator';
  usePermissionsStore((s) => s.permissions);
  const facilityName = useBrandingStore((state) => state.facilityName);
  const logoDataUrl = useBrandingStore((state) => state.logoDataUrl);
  const aiFeatureEnabled = useBrandingStore((state) => state.aiFeatureEnabled);
  const hiddenNavPaths = useBrandingStore((state) => state.hiddenNavPaths);

  const roleColor = ROLE_COLOR[user?.role ?? 'operator'] ?? ROLE_COLOR.operator;
  // A página de IA só aparece onde a feature está ligada. Enquanto o servidor
  // não respondeu, `aiFeatureEnabled` é false — a IA não pisca no menu.
  // Escondida = fixa no código (todas as instalações), OU a IA sem feature, OU
  // na lista POR-INSTALAÇÃO que o servidor entrega (hiddenNavPaths). A rota
  // segue de pé nos três casos — some só do menu.
  const escondida = (path: string) =>
    PAGINAS_OCULTAS.has(path) || (path === '/ia' && !aiFeatureEnabled) || hiddenNavPaths.includes(path);

  // Só busca o contador se a IA estiver contratada — numa instalação sem IA a
  // chamada seria puro custo, a cada minuto, para um item que nem aparece.
  const naoVistas = useDeteccoesNaoVistas(aiFeatureEnabled);
  const contador = formatarContador(naoVistas);

  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => (!item.roles || item.roles.includes(role)) && !escondida(item.path)
          && (role !== 'admin' || !ADMIN_PAGE_PERMISSION[item.path] || hasPermission(ADMIN_PAGE_PERMISSION[item.path])),
      ),
    }))
    // Seção que ficou sem nenhum item some junto (é o que apaga "Investigação").
    .filter((section) => section.items.length > 0);

  return (
    <motion.aside
      animate={{ width: isExpanded ? 240 : 56 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="sidebar-shell relative flex flex-col h-full overflow-hidden shrink-0"
      style={{ minWidth: isExpanded ? 240 : 56 }}
    >
      {/* ── Brand header ── */}
      <div className="sidebar-brand flex items-center justify-center h-14 px-3 shrink-0">
        <div className="flex items-center justify-center min-w-0 flex-1">
          <div className={`sidebar-mark shrink-0 h-8 rounded-xl flex items-center justify-center overflow-hidden ${logoDataUrl ? 'w-fit min-w-8 max-w-[108px]' : 'w-8'}`}>
            {logoDataUrl ? <img src={logoDataUrl} alt={facilityName} className="h-full w-auto max-w-[108px] object-contain" /> : <Shield className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />}
          </div>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-5">
        {visibleSections.map(section => (
          <div key={section.label} className="sidebar-section space-y-1.5">
            {isExpanded && (
              <div className="sidebar-section-label flex items-center gap-2 px-3 text-[9px] font-mono uppercase tracking-[0.18em]">
                <section.icon className="w-3 h-3" />
                <span>{section.label}</span>
              </div>
            )}
            <div className="space-y-1.5">
              {section.items.map(({ path, label, icon: Icon }) => {
                const isActive = location === path || (path !== '/live' && location.startsWith(path));
                return isExpanded ? (
                  <Link key={path} href={path} aria-current={isActive ? 'page' : undefined}>
                    <div
                      data-testid={`nav-${label.toLowerCase().replace(/[^a-z]/g, '-')}`}
                      className={`sidebar-item relative flex items-center gap-3 h-10 px-3 rounded-lg cursor-pointer transition-colors duration-150 group
                        ${isActive
                          ? 'sidebar-item-active text-foreground bg-[hsl(var(--accent))]'
                          : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground'
                        }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="text-[12.5px] font-medium flex-1 truncate">{label}</span>
                      {path === '/ia' && contador && (
                        <span
                          className="shrink-0 rounded-full bg-[hsl(var(--primary))] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[hsl(var(--primary-foreground))] tabular-nums"
                          aria-label={`${naoVistas} detecção(ões) não vista(s)`}
                        >
                          {contador}
                        </span>
                      )}
                    </div>
                  </Link>
                ) : (
                  <Tooltip key={path} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Link href={path} aria-label={label} aria-current={isActive ? 'page' : undefined}>
                        <div
                          className={`relative flex items-center justify-center h-10 w-10 rounded-lg cursor-pointer transition-colors duration-150 mx-auto
                            ${isActive
                              ? 'sidebar-item-active text-foreground bg-[hsl(var(--accent))]'
                              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground'
                            }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          {/* Menu recolhido não tem espaço para o número: vira um
                              ponto. A contagem exata fica no tooltip, que já existe. */}
                          {path === '/ia' && contador && (
                            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[hsl(var(--primary))]" aria-hidden />
                          )}
                        </div>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">
                      {label}{path === '/ia' && contador ? ` · ${contador} não vista(s)` : ''}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Bottom controls ── */}
      <div className="sidebar-footer px-2 py-2 shrink-0 space-y-2">
        <div className={`grid gap-1.5 ${isExpanded ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            onClick={onSearchOpen}
            className="sidebar-footer-btn flex h-9 items-center justify-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
            title="Buscar"
            data-testid="button-command-palette"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            {isExpanded && <span className="text-[11px]">Buscar</span>}
          </button>
          <button
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className="sidebar-footer-btn flex h-9 items-center justify-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
            title={isDark ? 'Modo claro' : 'Modo escuro'}
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {isExpanded && <span className="text-[11px]">Tema</span>}
          </button>
        </div>
        {isExpanded && (
          <button
            onClick={onAtalhosOpen}
            className="sidebar-footer-btn flex h-8 w-full items-center gap-2 rounded-lg px-3 text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground"
          >
            <Keyboard className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[11px]">Atalhos</span>
            <span className="ml-auto font-mono text-[9px] opacity-60">?</span>
          </button>
        )}

        <a
          href="/ajuda/"
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir a Central de Ajuda"
          title="Central de Ajuda"
          className={`sidebar-footer-btn flex h-8 items-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:text-sidebar-foreground ${isExpanded ? 'w-full px-3' : 'w-9 mx-auto justify-center'}`}
        >
          <CircleHelp className="h-3.5 w-3.5 shrink-0" />
          {isExpanded && <span className="text-[11px]">Central de Ajuda</span>}
        </a>

        {/* User row */}
        {user && (
          <div className={`sidebar-user flex items-center gap-2.5 h-12 px-2.5 rounded-lg ${isExpanded ? 'pr-2' : 'justify-center'}`}>
            <div className="shrink-0 w-8 h-8 rounded-xl bg-[hsl(var(--primary)_/_0.12)] border border-[hsl(var(--primary)_/_0.18)] flex items-center justify-center">
              <span className="text-[10px] font-bold text-[hsl(var(--primary))]">
                {user.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </span>
            </div>
            {isExpanded && (
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-sidebar-foreground truncate leading-tight">{user.name}</div>
                <div className={`text-[9px] font-mono capitalize tracking-[0.12em] ${roleColor}`}>{user.role}</div>
              </div>
            )}
            {isExpanded && (
              <button
                onClick={logout}
                aria-label="Sair da conta"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-xl text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] transition-colors"
                data-testid="button-logout"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
        {user && !isExpanded && (
          <button
            type="button"
            onClick={logout}
            aria-label="Sair da conta"
            title="Sair"
            className="sidebar-footer-btn flex h-9 w-9 mx-auto items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </motion.aside>
  );
}
