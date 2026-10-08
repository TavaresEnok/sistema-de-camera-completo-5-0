/** Só controla o desenho do texto; caixas, acompanhamento e IA não mudam. */
export function shouldShowDetectorLabel(mode: 'selected' | 'grid', enabled?: boolean): boolean {
  return mode !== 'grid' || enabled === true;
}
