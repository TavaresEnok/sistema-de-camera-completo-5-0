import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const CACHE_VERSION = 1;
const writes = new Map<string, Promise<unknown>>();
async function serialized<T>(scope: string, action: () => Promise<T>): Promise<T> {
  const next = (writes.get(scope) ?? Promise.resolve()).catch(() => undefined).then(action);
  writes.set(scope, next);
  try { return await next; } finally { if (writes.get(scope) === next) writes.delete(scope); }
}
export const POSTER_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

type Entry = { uri: string; updatedAt: number };
type Index = { version: number; entries: Record<string, Entry> };

function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function indexKey(scope: string) { return `s2cam.poster-cache.${CACHE_VERSION}.${hash(scope)}`; }
function safeCameraId(cameraId: string) { return cameraId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 90); }

async function readIndex(scope: string): Promise<Index> {
  try {
    const raw = await AsyncStorage.getItem(indexKey(scope));
    if (!raw) return { version: CACHE_VERSION, entries: {} };
    const parsed = JSON.parse(raw) as Index;
    return parsed?.version === CACHE_VERSION && parsed.entries
      ? parsed
      : { version: CACHE_VERSION, entries: {} };
  } catch { return { version: CACHE_VERSION, entries: {} }; }
}

async function writeIndex(scope: string, index: Index) {
  await AsyncStorage.setItem(indexKey(scope), JSON.stringify(index));
}

export async function loadCachedPosters(scope: string, cameraIds: string[]) {
  return serialized(scope, () => loadCachedPostersInternal(scope, cameraIds));
}
async function loadCachedPostersInternal(scope: string, cameraIds: string[]) {
  const index = await readIndex(scope);
  const allowed = new Set(cameraIds);
  const posters: Record<string, string> = {};
  const staleIds: string[] = [];
  const now = Date.now();
  let changed = false;
  for (const [cameraId, entry] of Object.entries(index.entries)) {
    if (!allowed.has(cameraId)) {
      delete index.entries[cameraId];
      changed = true;
      void FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined);
      continue;
    }
    posters[cameraId] = entry.uri;
  }
  for (const cameraId of cameraIds) {
    const entry = index.entries[cameraId];
    if (!entry || now - entry.updatedAt >= POSTER_REFRESH_MS) staleIds.push(cameraId);
  }
  if (changed) await writeIndex(scope, index).catch(() => undefined);
  return { posters, staleIds };
}

export async function savePoster(scope: string, cameraId: string, sourceUrl: string): Promise<string> {
  return serialized(scope, () => savePosterInternal(scope, cameraId, sourceUrl));
}
async function savePosterInternal(scope: string, cameraId: string, sourceUrl: string): Promise<string> {
  // documentDirectory é persistente. cacheDirectory pode ser limpo pelo
  // Android justamente quando o aparelho está sob pressão de armazenamento.
  const root = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!root) throw new Error('Armazenamento local indisponível.');
  const index = await readIndex(scope);
  const previous = index.entries[cameraId];
  const target = `${root}s2cam-poster-${hash(scope)}-${safeCameraId(cameraId)}-${Date.now()}.jpg`;
  let result: FileSystem.FileSystemDownloadResult;
  try {
    result = await FileSystem.downloadAsync(sourceUrl, target);
    if (result.status && result.status >= 400) throw new Error(`Poster HTTP ${result.status}`);
    index.entries[cameraId] = { uri: result.uri, updatedAt: Date.now() };
    await writeIndex(scope, index);
  } catch (error) {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  if (previous?.uri && previous.uri !== result.uri) {
    void FileSystem.deleteAsync(previous.uri, { idempotent: true }).catch(() => undefined);
  }
  return result.uri;
}

export async function forgetCachedPoster(scope: string, cameraId: string) {
  return serialized(scope, () => forgetCachedPosterInternal(scope, cameraId));
}
async function forgetCachedPosterInternal(scope: string, cameraId: string) {
  const index = await readIndex(scope);
  const previous = index.entries[cameraId];
  if (!previous) return;
  delete index.entries[cameraId];
  await writeIndex(scope, index).catch(() => undefined);
  await FileSystem.deleteAsync(previous.uri, { idempotent: true }).catch(() => undefined);
}
