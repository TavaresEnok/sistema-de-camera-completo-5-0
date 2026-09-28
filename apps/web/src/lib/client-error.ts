import axios from 'axios';

/** Não mostra detalhes de infraestrutura nem mensagens internas ao cliente. */
export function clientError(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (!error.response) return 'Não foi possível conectar. Verifique sua conexão e tente novamente.';
    if (status === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
    if (status === 403) return 'Você não tem permissão para realizar esta ação.';
    if (status === 404) return 'Este item não está mais disponível. Atualize a página.';
    if (status === 409) return 'Este item foi alterado. Atualize a página e tente novamente.';
    if (status === 429) return 'Aguarde alguns instantes antes de tentar novamente.';
    if (status === 413) return 'O arquivo é muito grande. Escolha uma imagem menor.';
    if (status === 400) {
      const message = String(error.response?.data?.message ?? '');
      if (/Senha fraca/i.test(message)) return 'Use uma senha com pelo menos 12 caracteres, incluindo maiúscula, minúscula e número.';
      if (/senha atual|senha incorreta/i.test(message)) return 'Confira sua senha atual e tente novamente.';
    }
    if (status && status >= 500) return 'O sistema não conseguiu concluir a ação. Tente novamente em instantes.';
  }
  return fallback;
}
