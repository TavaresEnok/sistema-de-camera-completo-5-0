import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';

export interface CameraSetupDraft {
  sourceMode: 'rtsp_pull' | 'rtmp_push';
  name: string; ip: string; rtspPort: string; automaticPort: boolean;
  httpPort: string; onvifPort: string; username: string; password: string; rtspPath: string;
}
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const queues = new Map<string, Promise<unknown>>();
const scopeKey = (apiUrl: string, userId: string) => 'camera-draft.' + Buffer.from(JSON.stringify([apiUrl.replace(/\/+$/, ''), userId])).toString('hex');
const enqueue = <T>(key: string, action: () => Promise<T>): Promise<T> => {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
};

// Secrets never go to ordinary preferences. Separate values keep the password
// out of the metadata and bound each native keychain item to a small size.
export function saveCameraSetupDraft(apiUrl: string, userId: string, draft: CameraSetupDraft) {
  const key = scopeKey(apiUrl, userId);
  return enqueue(key, async () => {
    const { password, ...fields } = draft;
    await SecureStore.setItemAsync(key + '.password', password, options);
    await SecureStore.setItemAsync(key, JSON.stringify({ version: 1, savedAt: Date.now(), fields }), options);
  });
}
export function clearCameraSetupDraft(apiUrl: string, userId: string) {
  const key = scopeKey(apiUrl, userId);
  return enqueue(key, async () => {
    await SecureStore.deleteItemAsync(key, options);
    await SecureStore.deleteItemAsync(key + '.password', options);
  });
}
export function loadCameraSetupDraft(apiUrl: string, userId: string): Promise<CameraSetupDraft | null> {
  const key = scopeKey(apiUrl, userId);
  return enqueue(key, async () => {
    try {
      const raw = await SecureStore.getItemAsync(key, options);
      if (!raw) return null;
      const value = JSON.parse(raw);
      const fields = value.fields;
      const valid = value.version === 1 && Number.isFinite(value.savedAt)
        && Date.now() - value.savedAt < 24 * 60 * 60 * 1000 && value.savedAt <= Date.now()
        && fields && ['rtsp_pull', 'rtmp_push'].includes(fields.sourceMode)
        && typeof fields.automaticPort === 'boolean'
        && ['name', 'ip', 'rtspPort', 'httpPort', 'onvifPort', 'username', 'rtspPath'].every(k => typeof fields[k] === 'string' && fields[k].length <= 512);
      if (!valid) {
        await SecureStore.deleteItemAsync(key, options);
        await SecureStore.deleteItemAsync(key + '.password', options);
        return null;
      }
      return { ...fields, password: await SecureStore.getItemAsync(key + '.password', options) ?? '' };
    } catch { return null; }
  });
}
