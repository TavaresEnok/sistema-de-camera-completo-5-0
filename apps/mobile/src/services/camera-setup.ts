/** Shared validation for discovery, manual setup and the final create request. */
export interface CameraConnectionDraft {
  ip: string; username: string; password: string; rtspPort: string;
  httpPort: string; onvifPort: string; rtspPath: string;
}

export function validCameraIp(value: string): boolean {
  const ip = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every(part => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
  }
  if (!ip.includes(':') || !/^[a-f\d:]+$/i.test(ip)) return false;
  try { return new URL(`http://[${ip}]/`).hostname.length > 0; } catch { return false; }
}

export function cameraConnectionError(draft: CameraConnectionDraft): string | null {
  if (!validCameraIp(draft.ip)) return 'Informe um endereço IP válido, como 192.168.0.100.';
  if (!draft.username.trim()) return 'Informe o usuário da câmera.';
  if (!draft.password) return 'Informe a senha da câmera.';
  for (const [label, value, optional] of [
    ['do vídeo', draft.rtspPort, true], ['de acesso', draft.httpPort, false], ['ONVIF', draft.onvifPort, true],
  ] as const) {
    if (optional && !value.trim()) continue;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return `A porta ${label} precisa estar entre 1 e 65535.`;
  }
  if (draft.rtspPath.trim() && !draft.rtspPath.trim().startsWith('/')) return 'O caminho do vídeo deve começar com /. Para um endereço RTSP completo, use Colar endereço do vídeo.';
  return null;
}

export function cameraConnectionPayload(draft: CameraConnectionDraft) {
  const error = cameraConnectionError(draft);
  if (error) throw new Error(error);
  return {
    ip: draft.ip.trim(), username: draft.username.trim(), password: draft.password,
    rtspPort: draft.rtspPort.trim() ? Number(draft.rtspPort) : 554,
    httpPort: Number(draft.httpPort),
    ...(draft.onvifPort.trim() ? { onvifPort: Number(draft.onvifPort) } : {}),
    ...(draft.rtspPath.trim() ? { rtspPath: draft.rtspPath.trim() } : {}),
  };
}

/** Search mode belongs only to the test, never to the camera create payload. */
export function cameraConnectionTestPayload(draft: CameraConnectionDraft, automatic: boolean) {
  return { ...cameraConnectionPayload(draft), rtspPortMode: automatic ? 'automatic' : 'manual' };
}

export function cameraSetupFailureMessage(code?: string | null): string | null {
  switch (code) {
    case 'auth_denied': return 'A câmera recusou o acesso. Confira o usuário e a senha da câmera.';
    case 'not_rtsp': return 'O endereço respondeu, mas essa porta não fornece vídeo RTSP. Confira a porta do vídeo com o instalador.';
    case 'unreachable': return 'O servidor não conseguiu acessar as portas testadas. Confira o endereço e a liberação de acesso à câmera.';
    case 'timeout': return 'A busca demorou mais que o esperado. Informe a porta do vídeo e, se tiver, o caminho RTSP.';
    case 'video_unavailable': return 'A porta respondeu, mas o vídeo não abriu. Confira o caminho RTSP e se a câmera permite outra conexão.';
    default: return null;
  }
}
