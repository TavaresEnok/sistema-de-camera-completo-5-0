/**
 * Clipes do celular — salva o vídeo/foto DIRETO na galeria (sem folha de
 * compartilhamento) e mantém um índice local ("Minhas gravações") do que foi
 * gravado pelo app, por câmera, para listar/reproduzir dentro do app.
 *
 * O ARQUIVO fica na galeria (álbum "S2Cam") e também no diretório do app (para
 * reprodução in-app confiável). O ÍNDICE (metadados) fica em AsyncStorage — não
 * é uma pasta que o usuário gerencia, é só o app lembrando dos clipes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';

const ALBUM = 'S2Cam';
const LEGACY_KEY = '@drac:clips:v1';
const PENDING_KEY = '@drac:pending-clips:v1';
const mutations = new Map<string, Promise<unknown>>();

function keyFor(scope: string): string {
  return `${LEGACY_KEY}:${encodeURIComponent(scope)}`;
}

/** Salva um arquivo (vídeo/foto) na galeria do celular, no álbum "S2Cam". */
export async function saveToGallery(uri: string): Promise<boolean> {
  // O app apenas cria mídia própria; não precisa ler fotos, vídeos ou áudios do
  // usuário. `writeOnly` evita o pedido de acesso amplo no Android 13+ e usa a
  // permissão de adicionar itens no iOS.
  const perm = await MediaLibrary.requestPermissionsAsync(true, []);
  if (!perm.granted) return false;
  const asset = await MediaLibrary.createAssetAsync(uri);
  try {
    const album = await MediaLibrary.getAlbumAsync(ALBUM);
    if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    else await MediaLibrary.createAlbumAsync(ALBUM, asset, false);
  } catch {
    // O álbum é só organização; o asset já está salvo na galeria de qualquer forma.
  }
  return true;
}

export type SavedClip = {
  id: string;
  cameraId: string;
  cameraName: string;
  uri: string; // arquivo local (documentDirectory) p/ reprodução in-app
  thumbnailUri?: string | null;
  createdAt: string; // ISO
};

export type PendingClip = {
  id: string;
  cameraId: string;
  cameraName: string;
  createdAt: string;
  status?: 'recording' | 'stopped';
};

async function safelyDelete(uri?: string | null) {
  if (!uri) return;
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* best-effort */ }
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  mutations.set(key, next);
  try { return await next; } finally { if (mutations.get(key) === next) mutations.delete(key); }
}

/** Gera e move uma miniatura para o diretório persistente do app. */
export async function createClipThumbnail(uri: string, clipId: string): Promise<string | null> {
  let generatedUri: string | null = null;
  try {
    const generated = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000, quality: 0.72 });
    generatedUri = generated.uri;
    const safeId = clipId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = `${FileSystem.documentDirectory}clip-${safeId}.thumb.jpg`;
    await safelyDelete(target);
    await FileSystem.moveAsync({ from: generated.uri, to: target });
    generatedUri = null;
    return target;
  } catch {
    return null;
  } finally {
    await safelyDelete(generatedUri);
  }
}

async function readClips(scope: string): Promise<SavedClip[]> {
  const key = keyFor(scope);
  // Legado sem proprietário permanece intacto; nunca atribuí-lo à conta atual.
  const raw = await AsyncStorage.getItem(key);
  const arr = raw ? (JSON.parse(raw) as SavedClip[]) : [];
  return Array.isArray(arr) ? arr : [];
}

export async function listClips(scope: string): Promise<SavedClip[]> {
  return serialized(keyFor(scope), () => repairClipIndex(scope));
}

async function repairClipIndex(scope: string): Promise<SavedClip[]> {
  try {
    const arr = await readClips(scope);
    const checks = await Promise.all(arr.map(async (clip) => ({
      clip,
      exists: (await FileSystem.getInfoAsync(clip.uri)).exists,
    })));
    const missing = checks.filter((item) => !item.exists);
    await Promise.all(missing.map((item) => safelyDelete(item.clip.thumbnailUri)));
    const valid = checks.filter((item) => item.exists).map((item) => item.clip);

    // Migração transparente dos clipes antigos, que ainda não tinham poster.
    // Dois workers evitam abrir dezenas de decoders simultaneamente.
    let cursor = 0;
    let changed = valid.length !== arr.length;
    const worker = async () => {
      while (cursor < valid.length) {
        const index = cursor++;
        const clip = valid[index];
        const thumbnailExists = clip.thumbnailUri
          ? (await FileSystem.getInfoAsync(clip.thumbnailUri)).exists
          : false;
        if (!thumbnailExists) {
          const thumbnailUri = await createClipThumbnail(clip.uri, clip.id);
          if (thumbnailUri) {
            valid[index] = { ...clip, thumbnailUri };
            changed = true;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, valid.length) }, () => worker()));
    if (changed) await AsyncStorage.setItem(keyFor(scope), JSON.stringify(valid));
    return valid;
  } catch {
    return [];
  }
}

export async function addClip(scope: string, clip: SavedClip): Promise<SavedClip[]> {
  return serialized(keyFor(scope), async () => {
    const current = await readClips(scope);
    const replaced = current.find((item) => item.id === clip.id);
    const all = current.filter((item) => item.id !== clip.id);
    const next = [clip, ...all];
    const trimmed = next.slice(0, 300);
    await AsyncStorage.setItem(keyFor(scope), JSON.stringify(trimmed));
    if (replaced?.uri !== clip.uri) await safelyDelete(replaced?.uri);
    if (replaced?.thumbnailUri !== clip.thumbnailUri) await safelyDelete(replaced?.thumbnailUri);
    await Promise.all(next.slice(300).flatMap((item) => [safelyDelete(item.uri), safelyDelete(item.thumbnailUri)]));
    return trimmed;
  });
}

export async function removeClip(scope: string, id: string): Promise<SavedClip[]> {
  return serialized(keyFor(scope), async () => {
    const all = await readClips(scope);
    const removed = all.find((clip) => clip.id === id);
    const next = all.filter((clip) => clip.id !== id);
    await AsyncStorage.setItem(keyFor(scope), JSON.stringify(next));
    await Promise.all([safelyDelete(removed?.uri), safelyDelete(removed?.thumbnailUri)]);
    return next;
  });
}

function pendingKey(scope: string) { return `${PENDING_KEY}:${encodeURIComponent(scope)}`; }

export async function listPendingClips(scope: string): Promise<PendingClip[]> {
  try {
    const raw = await AsyncStorage.getItem(pendingKey(scope));
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

export async function savePendingClip(scope: string, pending: PendingClip): Promise<void> {
  const key = pendingKey(scope);
  await serialized(key, async () => {
    const current = await listPendingClips(scope);
    const next = [pending, ...current.filter((item) => item.id !== pending.id)].slice(0, 20);
    await AsyncStorage.setItem(key, JSON.stringify(next));
  });
}

export async function removePendingClip(scope: string, id: string): Promise<void> {
  const key = pendingKey(scope);
  await serialized(key, async () => {
    const current = await listPendingClips(scope);
    await AsyncStorage.setItem(key, JSON.stringify(current.filter((item) => item.id !== id)));
  });
}
