import type { Camera } from '../types';

const address = (value: string) => value.trim().toLowerCase().replace(/^\[|\]$/g, '');
const path = (value?: string | null) => {
  const trimmed = (value ?? '').trim();
  return trimmed && !trimmed.startsWith('/') ? '/' + trimmed : trimmed || '/';
};
export function findOwnedCameraDuplicate(cameras: Camera[], candidate: { ip: string; rtspPort?: string | number; rtspPath?: string | null }) {
  // Different NVR channels are different cameras. Do not compare only the IP,
  // nor reveal cameras belonging to somebody else in a shared group.
  return cameras.find(camera => camera.canSelfManage === true && camera.sourceMode !== 'rtmp_push'
    && address(camera.ip ?? '') === address(candidate.ip)
    && Number(camera.rtspPort || 554) === Number(candidate.rtspPort || 554)
    && path(camera.rtspPath) === path(candidate.rtspPath)) ?? null;
}
