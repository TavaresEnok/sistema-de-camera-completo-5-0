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
