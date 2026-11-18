import axios from 'axios';
import { create } from 'zustand';
import { getApiBaseUrl } from '../lib/api-base';
import { buildBrandColorCss } from '../lib/brand-colors';
import { normalizeFacilityName, PRODUCT_NAME } from '../lib/product-brand';

type PublicBranding = {
  recordersEnabled?: boolean;
  facilityName?: string;
  brandLogoDataUrl?: string;
  brandUseDefaultColors?: boolean;
  // ── APARÊNCIA DO SISTEMA (este painel), separada da do APLICATIVO ────────
  // Vazio = cai na chave `brand*` equivalente. Sem essa queda, subir esta
  // versão apagaria a identidade de toda instalação já personalizada.
  systemLogoDataUrl?: string;
  systemUseDefaultColors?: boolean;
  systemPrimaryColor?: string;
  systemBackgroundColor?: string;
  systemMenuActiveColor?: string;
  systemLightPrimaryColor?: string;
  systemLightBackgroundColor?: string;
  systemLightMenuActiveColor?: string;
  // Paleta escura (chaves sem prefixo).
  brandPrimaryColor?: string;
  brandButtonTextColor?: string;
  brandBackgroundColor?: string;
  brandBackgroundTextColor?: string;
  brandSecondaryColor?: string; // superfície de card/painel
  brandPrimaryTextColor?: string; // texto sobre a superfície
  brandSecondaryTextColor?: string; // subtexto sobre a superfície
  brandBorderColor?: string;
  // Paleta clara (chaves com prefixo Light).
  brandLightPrimaryColor?: string;
  brandLightButtonTextColor?: string;
  brandLightBackgroundColor?: string;
  brandLightBackgroundTextColor?: string;
  brandLightSecondaryColor?: string;
  brandLightPrimaryTextColor?: string;
  brandLightSecondaryTextColor?: string;
  brandLightBorderColor?: string;
  // Feature flag (não é marca): a página de IA aparece no menu? Por instalação.
  aiFeatureEnabled?: boolean;
  // Caminhos escondidos do menu NESTA instalação (separados por vírgula).
  hiddenNavPaths?: string;
};

type BrandingState = {
  recordersEnabled: boolean;
  facilityName: string;
  logoDataUrl: string;
  aiFeatureEnabled: boolean;
  hiddenNavPaths: string[];
  loaded: boolean;
  load: () => Promise<void>;
};

// A identidade visual não pode depender de a API estar disponível exatamente
// no instante em que a aba abre. Durante um deploy curto a primeira chamada
// pode falhar; antes disso deixava a instalação com logo vazia e cores padrão
// até o operador recarregar a página manualmente.
let brandingRetryTimer: ReturnType<typeof setTimeout> | null = null;
let brandingRetryDelayMs = 2_000;
const BRANDING_RETRY_MAX_MS = 60_000;

// Injeta/remove um <style> que sobrescreve o accent (primary/ring) do tema com a
// cor do cliente. Só age quando há cor válida e o cliente não usa a paleta padrão;
// caso contrário remove o override (DRAC padrão intocado).
/** Primeiro valor preenchido. É o que faz o sistema herdar a marca do app. */
function ou(...valores: Array<string | undefined>): string | undefined {
  for (const v of valores) if (v && v.trim()) return v;
  return undefined;
}

function applyBrandColors(data: PublicBranding) {
  if (typeof document === 'undefined') return;
  // A aparência do SISTEMA manda; onde ela estiver vazia, herda a do APP.
  // `systemUseDefaultColors` só desliga quando ele mesmo foi configurado —
  // instalação antiga (que só tem `brand*`) continua obedecendo ao flag antigo.
  const sistemaConfigurado = data.systemUseDefaultColors === false;
  const css = buildBrandColorCss({
    useDefaultColors: sistemaConfigurado ? false : data.brandUseDefaultColors,
    menuActiveColor: data.systemMenuActiveColor,
    lightMenuActiveColor: data.systemLightMenuActiveColor,
    // Escuro → bloco .dark
    primaryColor: ou(data.systemPrimaryColor, data.brandPrimaryColor),
    buttonTextColor: data.brandButtonTextColor,
    backgroundColor: ou(data.systemBackgroundColor, data.brandBackgroundColor),
    backgroundTextColor: data.brandBackgroundTextColor,
    surfaceColor: data.brandSecondaryColor,
    textColor: data.brandPrimaryTextColor,
    textSubColor: data.brandSecondaryTextColor,
    borderColor: data.brandBorderColor,
    // Claro → bloco :root
    lightPrimaryColor: ou(data.systemLightPrimaryColor, data.brandLightPrimaryColor),
    lightButtonTextColor: data.brandLightButtonTextColor,
    lightBackgroundColor: ou(data.systemLightBackgroundColor, data.brandLightBackgroundColor),
    lightBackgroundTextColor: data.brandLightBackgroundTextColor,
    lightSurfaceColor: data.brandLightSecondaryColor,
    lightTextColor: data.brandLightPrimaryTextColor,
    lightTextSubColor: data.brandLightSecondaryTextColor,
    lightBorderColor: data.brandLightBorderColor,
  });
  const id = 'drac-brand-colors';
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export const useBrandingStore = create<BrandingState>((set, get) => ({
  recordersEnabled: false,
  facilityName: PRODUCT_NAME,
  logoDataUrl: '',
  // Default FALSE: enquanto o servidor não responde, a página de IA fica
  // escondida. Uma instalação sem IA nunca deve piscar o item no menu.
  aiFeatureEnabled: false,
  hiddenNavPaths: [],
  loaded: false,
  load: async () => {
    try {
      const { data } = await axios.get<PublicBranding>(`${getApiBaseUrl()}/settings/branding`, { timeout: 8_000 });
      set({
        facilityName: normalizeFacilityName(data.facilityName),
        // Logo do SISTEMA (login e menu deste painel). Sem ele, herda o do app
        // — que é o que toda instalação anterior tem preenchido.
        logoDataUrl: ou(data.systemLogoDataUrl, data.brandLogoDataUrl)?.trim() || '',
        aiFeatureEnabled: data.aiFeatureEnabled === true,
        recordersEnabled: data.recordersEnabled === true,
        // "/alarms,/review" → ['/alarms','/review']. Vazio = nada escondido.
        hiddenNavPaths: String(data.hiddenNavPaths ?? '').split(',').map((p) => p.trim()).filter(Boolean),
        loaded: true,
      });
      applyBrandColors(data);
      if (brandingRetryTimer) {
        clearTimeout(brandingRetryTimer);
        brandingRetryTimer = null;
      }
      brandingRetryDelayMs = 2_000;
    } catch {
      set((state) => ({ ...state, loaded: true }));
      if (!brandingRetryTimer && typeof window !== 'undefined') {
        const delay = brandingRetryDelayMs;
        brandingRetryDelayMs = Math.min(BRANDING_RETRY_MAX_MS, brandingRetryDelayMs * 2);
        brandingRetryTimer = window.setTimeout(() => {
          brandingRetryTimer = null;
          void get().load();
        }, delay);
      }
    }
  },
}));
