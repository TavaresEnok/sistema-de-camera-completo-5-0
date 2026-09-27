// Fields that need an installer, kept separate from everyday camera settings.
export const equipmentFields = [
  ['channel', 'Canal principal', 1], ['subtype', 'Perfil principal', 0],
  ['liveChannel', 'Canal ao vivo', 1], ['liveSubtype', 'Perfil ao vivo', 0],
  ['recordingChannel', 'Canal de gravação', 1], ['recordingSubtype', 'Perfil de gravação', 0],
  ['analyticsChannel', 'Canal de análise', 1], ['analyticsSubtype', 'Perfil de análise', 0],
  ['streamBitrateKbps', 'Limite ao vivo (kbps)', 1],
  ['recordingWidth', 'Largura da gravação', 1], ['recordingHeight', 'Altura da gravação', 1],
  ['recordingFps', 'Quadros por segundo da gravação', 1],
  ['recordingBitrateKbps', 'Limite de gravação (kbps)', 1],
] as const;
export type EquipmentKey = typeof equipmentFields[number][0];
export type EquipmentForm = Record<EquipmentKey | 'onvifPath' | 'onvifProfileToken', string>;
export function readEquipment(data: Record<string, unknown>): EquipmentForm {
  return Object.fromEntries([
    ...equipmentFields.map(([key]) => [key, String(data[key] ?? (key === 'channel' ? 1 : key === 'subtype' ? 0 : ''))]),
    ['onvifPath', String(data.onvifPath ?? '')], ['onvifProfileToken', String(data.onvifProfileToken ?? '')],
  ]) as EquipmentForm;
}
export function equipmentError(form: EquipmentForm): string | null {
  for (const [key, label, min] of equipmentFields) {
    if (!form[key].trim() && key !== 'channel' && key !== 'subtype') continue;
    const n = Number(form[key]);
    if (!form[key].trim() || !Number.isInteger(n) || n < min) return `Confira o campo “${label}”.`;
  }
  if (Boolean(form.recordingWidth.trim()) !== Boolean(form.recordingHeight.trim())) return 'Informe largura e altura juntas, ou deixe ambas em branco.';
  return null;
}
export function equipmentPayload(form: EquipmentForm, push: boolean) {
  return Object.fromEntries([
    ...equipmentFields.filter(([key]) => !push || /^(streamBitrate|recording(?:Width|Height|Fps|Bitrate))/.test(key))
      .map(([key]) => [key, form[key].trim() ? Number(form[key]) : null]),
    ...(!push ? [['onvifPath', form.onvifPath.trim()], ['onvifProfileToken', form.onvifProfileToken.trim()]] : []),
  ]);
}
export function legacyCameraDestination(id: string, tab: string | null, canEdit: boolean) {
  const encoded = encodeURIComponent(id);
  const page = tab === 'ptz' ? 'ptz' : tab === 'playback' ? 'playback' : tab === 'zones' ? 'perimetro' : tab === 'events' ? 'alarms' : null;
  if (page) return `/${page}?cameraId=${encoded}`;
  return `/cameras?${tab === 'settings' && canEdit ? 'edit' : 'cameraId'}=${encoded}`;
}
