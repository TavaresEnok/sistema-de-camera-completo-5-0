import axios from 'axios';

// Mensagens de serviços podem incluir endpoint, protocolo ou detalhe interno.
// O painel do cliente só recebe uma mensagem curta, segura e acionável.
const TERMOS_TECNICOS = /\b(api|http|https|docker|redis|postgres|rtsp|rtmp|webrtc|whep|hls|ffmpeg|mediamtx|stack|timeout|exception|socket|sql|token)\b|\b(?:4|5)\d\d\b/i;

function mensagemSegura(value: unknown): string | null {
  const message = Array.isArray(value) ? value.join(' ') : value;
  if (typeof message !== 'string') return null;
  const clean = message.trim().replace(/\s+/g, ' ');
  return clean && clean.length <= 220 && !TERMOS_TECNICOS.test(clean) ? clean : null;
}

export function getRequestErrorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401) return 'Sua sessão terminou. Entre novamente para continuar.';
    if (status === 403) return 'Seu usuário não tem permissão para realizar esta ação.';
    if (status === 404) return 'Este item não está mais disponível. Atualize a tela e tente novamente.';
    if (status === 409) return 'Esta informação foi alterada. Atualize a tela antes de tentar novamente.';
    if (status === 429) return 'Aguarde um momento antes de tentar novamente.';
    const message = mensagemSegura(error.response?.data?.message);
    if (message) return message;
    if (!error.response) return 'Não foi possível concluir a ação. Verifique a conexão e tente novamente.';
    return fallback;
  }
  return fallback;
}
