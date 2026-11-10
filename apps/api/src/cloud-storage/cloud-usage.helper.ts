/** Regras puras do painel de uso da nuvem (testáveis sem banco). */

export const FUSO_DO_PAINEL = 'America/Sao_Paulo';

export function diasDoPainel(valor: unknown): number {
  const n = Number(valor);
  if (!Number.isInteger(n)) return 14;
  return Math.max(1, Math.min(90, n));
}

/** Lista contínua de dias (YYYY-MM-DD) terminando em `hoje`, preenchendo zeros. */
export function preencherDias(
  linhas: Array<{ day: string; bytes: number; count: number }>,
  dias: number,
  hoje: string,
): Array<{ day: string; uploadedBytes: number; uploadedCount: number }> {
  const porDia = new Map(linhas.map((l) => [l.day, l]));
  const [a, m, d] = hoje.split('-').map(Number);
  const saida: Array<{ day: string; uploadedBytes: number; uploadedCount: number }> = [];
  for (let i = dias - 1; i >= 0; i -= 1) {
    const data = new Date(Date.UTC(a, m - 1, d - i));
    const chave = data.toISOString().slice(0, 10);
    const linha = porDia.get(chave);
    saida.push({ day: chave, uploadedBytes: linha ? Number(linha.bytes) : 0, uploadedCount: linha ? Number(linha.count) : 0 });
  }
  return saida;
}
