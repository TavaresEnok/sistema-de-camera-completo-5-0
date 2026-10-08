export type CameraPrivacyForm = { isPrivate: boolean; ownerUserId: string; privateViewerIds: string[] };
export const emptyCameraPrivacy = (): CameraPrivacyForm => ({ isPrivate: false, ownerUserId: '', privateViewerIds: [] });
export const cameraPrivacyError = (value: CameraPrivacyForm) =>
  value.isPrivate && !value.ownerUserId ? 'Escolha quem será o proprietário da câmera privada.' : null;
export function cameraPrivacyPayload(value: CameraPrivacyForm) {
  return value.isPrivate
    ? { isPrivate: true, ownerUserId: value.ownerUserId, privateViewerIds: [...new Set(value.privateViewerIds)].filter(id => id !== value.ownerUserId).sort() }
    : { isPrivate: false };
}
export const cameraPrivacyChanged = (value: CameraPrivacyForm, previous: CameraPrivacyForm) =>
  JSON.stringify(cameraPrivacyPayload(value)) !== JSON.stringify(cameraPrivacyPayload(previous));
