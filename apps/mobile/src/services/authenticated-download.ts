import * as FileSystem from 'expo-file-system/legacy';
import { authenticatedTransfer } from './api';

export async function downloadAuthenticated(apiUrl: string, token: string, url: string, target: string) {
  if (new URL(url).origin !== new URL(apiUrl).origin) throw new Error('Endereço de download inválido.');
  return authenticatedTransfer(apiUrl, token, async (credential, signal) => {
    if (signal.aborted) throw new Error('Download cancelado.');
    const task = FileSystem.createDownloadResumable(url, target, { headers: { Authorization: `Bearer ${credential}` } });
    const abort = () => { void task.pauseAsync().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await task.downloadAsync();
      if (!result || signal.aborted) throw new Error('Download cancelado.');
      if (result.status >= 200 && result.status < 300) {
        const expected = Number(Object.entries(result.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1]);
        const info = await FileSystem.getInfoAsync(result.uri);
        if (!info.exists || info.isDirectory || info.size <= 0 || (expected > 0 && expected !== info.size)) throw new Error('O download ficou incompleto. Tente novamente.');
      }
      return result;
    } finally { signal.removeEventListener('abort', abort); }
  });
}
