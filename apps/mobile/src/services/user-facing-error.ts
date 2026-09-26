/**
 * Mensagens entregues pela API podem conter nomes de serviços, protocolos,
 * códigos HTTP ou detalhes de implantação. No aplicativo do cliente, o aviso
 * deve explicar o que ele pode fazer, sem revelar a estrutura da operação.
 */
export function userFacingError(error: unknown, fallback: string): string {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;

  if (status === 401) return 'Sua sessão terminou. Entre novamente para continuar.';
  if (status === 403) return 'Seu usuário não tem permissão para realizar esta ação.';
  if (status === 404) return 'Este item não está mais disponível. Atualize a tela e tente novamente.';
  if (status === 409) return 'Esta informação foi alterada. Atualize a tela antes de tentar novamente.';
  if (status === 429) return 'Aguarde um momento antes de tentar novamente.';

  const message = error instanceof Error ? error.message.trim() : '';
  // A única mensagem de rede criada pelo próprio app já é útil e não revela
  // informação interna. As demais voltam ao texto específico da ação.
  if (message === 'Tempo esgotado. Verifique a conexão.') return message;
  return fallback;
}
