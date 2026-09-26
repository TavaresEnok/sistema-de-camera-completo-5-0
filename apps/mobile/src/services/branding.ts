/**
 * Branding em runtime — busca a identidade visual configurada no servidor
 * (Configurações → Aparência do web) e permite aplicá-la no app.
 *
 * Diferente do branding de build-time (src/branding.ts, embutido no APK), este
 * é lido do endpoint público `GET /settings/branding` da própria instalação, de
 * forma que o que o admin salvar nas Configurações reflita também no app.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { request } from './api';

const BRANDING_CACHE_PREFIX = '@drac:runtime-branding:v1:';

export interface BrandingPalette {
  primaryColor: string;
  backgroundColor: string;
  /** 2ª cor de fundo — se definida, o fundo vira gradiente (theme.bg2). */
  backgroundColor2: string;
  /** Cor do card/bloco (theme.surface). */
  secondaryColor: string;
  /** Cor do texto do card (theme.text). */
  primaryTextColor: string;
  /** Cor do subtexto do card (theme.textSub). */
  secondaryTextColor: string;
  /** Cor do texto sobre o fundo da tela (theme.bgText). */
  backgroundTextColor: string;
  /** Cor do fundo do menu inferior (theme.menu). */
  menuColor: string;
  /** Cor do texto/ícone de item inativo do menu (theme.menuText). */
  menuTextColor: string;
  /** Cor do texto sobre botões de destaque (theme.textOnAccent). */
  buttonTextColor: string;
  /** Cor das bordas (theme.border). */
  borderColor: string;
  /** Cores de status (theme.success/warning/danger). */
  successColor: string;
  warningColor: string;
  dangerColor: string;
}

export interface RuntimeBranding {
  facilityName: string;
  logoDataUrl: string;
  /** Multiplicador visual da logo no login (0,65–2), entregue em runtime. */
  logoScale: number;
  /** true = usa a paleta original do app e preserva as cores personalizadas. */
  useDefaultColors: boolean;
  /** Chaves históricas sem prefixo: tema escuro. */
  dark: BrandingPalette;
  /** Chaves brandLight*: tema claro. */
  light: BrandingPalette;
  /** Menor versionCode do app aceito por esta instalação; 0 = sem exigência. */
  minMobileVersionCode: number;
}

type BrandingResponse = {
  facilityName?: string;
  /** Menor versionCode aceito por esta instalação (ausente/0 = sem exigência). */
  minMobileVersionCode?: number | string;
  brandLogoDataUrl?: string;
  brandMobileLogoScale?: number | string;
  brandUseDefaultColors?: boolean;
  brandPrimaryColor?: string;
  brandBackgroundColor?: string;
  brandBackgroundColor2?: string;
  brandSecondaryColor?: string;
  brandPrimaryTextColor?: string;
  brandSecondaryTextColor?: string;
  brandBackgroundTextColor?: string;
  brandMenuColor?: string;
  brandMenuTextColor?: string;
  brandButtonTextColor?: string;
  brandBorderColor?: string;
  brandSuccessColor?: string;
  brandWarningColor?: string;
  brandDangerColor?: string;
  brandLightPrimaryColor?: string;
  brandLightBackgroundColor?: string;
  brandLightBackgroundColor2?: string;
  brandLightSecondaryColor?: string;
  brandLightPrimaryTextColor?: string;
  brandLightSecondaryTextColor?: string;
  brandLightBackgroundTextColor?: string;
  brandLightMenuColor?: string;
  brandLightMenuTextColor?: string;
  brandLightButtonTextColor?: string;
  brandLightBorderColor?: string;
  brandLightSuccessColor?: string;
  brandLightWarningColor?: string;
  brandLightDangerColor?: string;
};

export const EMPTY_PALETTE: BrandingPalette = {
  primaryColor: '',
  backgroundColor: '',
  backgroundColor2: '',
  secondaryColor: '',
  primaryTextColor: '',
  secondaryTextColor: '',
  backgroundTextColor: '',
  menuColor: '',
  menuTextColor: '',
  buttonTextColor: '',
  borderColor: '',
  successColor: '',
  warningColor: '',
  dangerColor: '',
};

export const EMPTY_BRANDING: RuntimeBranding = {
  facilityName: '',
  logoDataUrl: '',
  logoScale: 1,
  useDefaultColors: true,
  dark: EMPTY_PALETTE,
  light: EMPTY_PALETTE,
  minMobileVersionCode: 0,
};

function cacheKey(apiUrl: string) {
  // A marca pertence à instalação, não ao aparelho todo. Assim trocar o campo
  // "Servidor" não faz a identidade de um cliente aparecer no outro.
  return `${BRANDING_CACHE_PREFIX}${encodeURIComponent(apiUrl.trim().replace(/\/+$/, '').toLowerCase())}`;
}

function cachedPalette(value: unknown): BrandingPalette {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(EMPTY_PALETTE).map(([key, fallback]) => [key, typeof source[key] === 'string' ? source[key] : fallback]),
  ) as BrandingPalette;
}

/** Recupera a última marca válida desta instalação para uso sem rede. */
export async function loadCachedBranding(apiUrl: string): Promise<RuntimeBranding | null> {
  if (!apiUrl) return null;
  try {
    const raw = await AsyncStorage.getItem(cacheKey(apiUrl));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return null;
    return {
      facilityName: typeof value.facilityName === 'string' ? value.facilityName : '',
      logoDataUrl: typeof value.logoDataUrl === 'string' ? value.logoDataUrl : '',
      logoScale: Math.max(0.65, Math.min(2, Number(value.logoScale) || 1)),
      useDefaultColors: value.useDefaultColors === true,
      dark: cachedPalette(value.dark),
      light: cachedPalette(value.light),
      minMobileVersionCode: Math.max(0, Number(value.minMobileVersionCode) || 0),
    };
  } catch {
    return null;
  }
}

/** Salva somente uma resposta normalizada e recebida com sucesso da API. */
export async function saveCachedBranding(apiUrl: string, branding: RuntimeBranding): Promise<void> {
  if (!apiUrl) return;
  await AsyncStorage.setItem(cacheKey(apiUrl), JSON.stringify(branding));
}

export async function fetchBranding(apiUrl: string): Promise<RuntimeBranding> {
  if (!apiUrl) return EMPTY_BRANDING;
  const data = await request<BrandingResponse>(apiUrl, '/settings/branding');
  const t = (v?: string) => (v ?? '').trim();
  const palette = (prefix: '' | 'Light'): BrandingPalette => ({
    primaryColor: t(data[`brand${prefix}PrimaryColor`]),
    backgroundColor: t(data[`brand${prefix}BackgroundColor`]),
    backgroundColor2: t(data[`brand${prefix}BackgroundColor2`]),
    secondaryColor: t(data[`brand${prefix}SecondaryColor`]),
    primaryTextColor: t(data[`brand${prefix}PrimaryTextColor`]),
    secondaryTextColor: t(data[`brand${prefix}SecondaryTextColor`]),
    backgroundTextColor: t(data[`brand${prefix}BackgroundTextColor`]),
    menuColor: t(data[`brand${prefix}MenuColor`]),
    menuTextColor: t(data[`brand${prefix}MenuTextColor`]),
    buttonTextColor: t(data[`brand${prefix}ButtonTextColor`]),
    borderColor: t(data[`brand${prefix}BorderColor`]),
    successColor: t(data[`brand${prefix}SuccessColor`]),
    warningColor: t(data[`brand${prefix}WarningColor`]),
    dangerColor: t(data[`brand${prefix}DangerColor`]),
  });
  return {
    facilityName: t(data.facilityName),
    logoDataUrl: t(data.brandLogoDataUrl),
    logoScale: Math.max(0.65, Math.min(2, Number(data.brandMobileLogoScale ?? 1) || 1)),
    // Ausente mantém compatibilidade com servidores antigos, que sempre
    // aplicavam as cores personalizadas retornadas pelo endpoint.
    useDefaultColors: data.brandUseDefaultColors === true,
    dark: palette(''),
    light: palette('Light'),
    // Versão mínima exigida pela instalação (0 = sem exigência). Servidor antigo
    // não devolve o campo, e aí nada muda: o app segue como sempre seguiu.
    minMobileVersionCode: Number(data.minMobileVersionCode ?? 0) || 0,
  };
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/** Escurece um hex por um fator (0..1). Usado para o tom "accentDark" do botão. */
export function darkenHex(hex: string, amount = 0.16): string | null {
  const c = parseHex(hex);
  if (!c) return null;
  const f = 1 - amount;
  const to2 = (n: number) => Math.max(0, Math.min(255, Math.round(n * f))).toString(16).padStart(2, '0');
  return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
}

/**
 * Desloca um hex em direção ao branco (amount > 0) ou ao preto (amount < 0).
 * Usado para derivar tons próximos (ex.: surfaceAlt a partir da cor secundária:
 * clareia um pouco no tema escuro, escurece um pouco no claro).
 */
export function shiftHex(hex: string, amount: number): string | null {
  const c = parseHex(hex);
  if (!c) return null;
  const target = amount >= 0 ? 255 : 0;
  const f = Math.abs(amount);
  const mix = (n: number) => Math.max(0, Math.min(255, Math.round(n + (target - n) * f))).toString(16).padStart(2, '0');
  return `#${mix(c.r)}${mix(c.g)}${mix(c.b)}`;
}

/** Versão com transparência (rgba) — usada para fundos suaves de chips/ícones. */
export function withAlpha(hex: string, alpha: number): string | null {
  const c = parseHex(hex);
  if (!c) return null;
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

export function isValidHex(hex: string): boolean {
  return HEX.test(hex.trim());
}

function relativeLuminance(hex: string): number | null {
  const c = parseHex(hex);
  if (!c) return null;
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrastRatio(first: string, second: string): number | null {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  if (a == null || b == null) return null;
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mantém a cor pedida quando legível; caso contrário escolhe preto ou branco. */
export function ensureReadableText(foreground: string, backgrounds: string[], minimum = 4.5): string {
  const ratios = backgrounds.map((background) => contrastRatio(foreground, background));
  if (ratios.every((ratio) => ratio == null || ratio >= minimum)) return foreground;
  const candidates = ['#ffffff', '#0b0d12'];
  return candidates.sort((a, b) => {
    const score = (candidate: string) => Math.min(...backgrounds.map((bg) => contrastRatio(candidate, bg) ?? 0));
    return score(b) - score(a);
  })[0];
}

export function isLightColor(hex: string): boolean {
  return (relativeLuminance(hex) ?? 0) > 0.45;
}
