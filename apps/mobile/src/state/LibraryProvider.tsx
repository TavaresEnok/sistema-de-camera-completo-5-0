/**
 * LibraryProvider — fonte de verdade de FAVORITAS e GRUPOS de câmeras no app.
 *
 * Dois eixos independentes, ambos persistidos por dispositivo em AsyncStorage
 * (decisão de produto: favoritas e grupos são organização PESSOAL do app, não
 * sincronizam com o backend — mesma natureza das antigas "mosaic areas"):
 *   - favorites: string[]   (ids de câmera fixadas na Central)
 *   - groups: CameraGroup[] (organização espacial; uma câmera pode estar em vários)
 *
 * Uso:
 *   <LibraryProvider><App /></LibraryProvider>
 *   const { favorites, isFavorite, toggleFavorite,
 *           groups, createGroup, updateGroup, deleteGroup } = useLibrary();
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { CameraGroup } from '../types';

const LEGACY_FAV_KEY = '@drac:favorites:v1';
const LEGACY_GROUP_KEY = '@drac:groups:v1';
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(key: string, value: unknown) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => AsyncStorage.setItem(key, JSON.stringify(value)));
  writeQueues.set(key, next);
  void next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key); });
}

function scopedKey(base: string, scope: string): string {
  return `${base}:${encodeURIComponent(scope)}`;
}

interface LibraryContextValue {
  setScope: (scope: string) => void;
  favorites: string[];
  isFavorite: (cameraId: string) => boolean;
  toggleFavorite: (cameraId: string) => void;

  groups: CameraGroup[];
  createGroup: (name: string, cameraIds: string[]) => CameraGroup;
  updateGroup: (id: string, patch: Partial<Omit<CameraGroup, 'id'>>) => void;
  deleteGroup: (id: string) => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [scope, setScopeState] = useState('anonymous');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [groups, setGroups] = useState<CameraGroup[]>([]);

  const favKey = scopedKey(LEGACY_FAV_KEY, scope);
  const groupKey = scopedKey(LEGACY_GROUP_KEY, scope);
  const setScope = useCallback((next: string) => setScopeState(next.trim() || 'anonymous'), []);

  // hidratar do storage
  useEffect(() => {
    let cancelled = false;
    setFavorites([]);
    setGroups([]);
    // Dados legados sem proprietário ficam preservados, mas não são exibidos.
    AsyncStorage.multiGet([favKey, groupKey])
      .then(([[, favRaw], [, grpRaw]]) => {
        if (cancelled) return;
        if (favRaw) {
          const parsed = JSON.parse(favRaw);
          if (Array.isArray(parsed)) setFavorites(parsed);
        }
        if (grpRaw) {
          const parsed = JSON.parse(grpRaw);
          if (Array.isArray(parsed)) setGroups(parsed);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [favKey, groupKey, scope]);

  const persistFav = useCallback((update: (current: string[]) => string[]) => {
    setFavorites((current) => {
      const next = update(current);
      enqueueWrite(favKey, next);
      return next;
    });
  }, [favKey]);
  const persistGroups = useCallback((update: (current: CameraGroup[]) => CameraGroup[]) => {
    setGroups((current) => {
      const next = update(current);
      enqueueWrite(groupKey, next);
      return next;
    });
  }, [groupKey]);

  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);

  const toggleFavorite = useCallback((id: string) => {
    persistFav((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }, [persistFav]);

  const createGroup = useCallback((name: string, cameraIds: string[]): CameraGroup => {
    const group: CameraGroup = { id: 'g' + Date.now(), name: name.trim() || 'Novo grupo', cameraIds };
    persistGroups((current) => [...current, group]);
    return group;
  }, [persistGroups]);

  const updateGroup = useCallback((id: string, patch: Partial<Omit<CameraGroup, 'id'>>) => {
    persistGroups((current) => current.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, [persistGroups]);

  const deleteGroup = useCallback((id: string) => {
    persistGroups((current) => current.filter((g) => g.id !== id));
  }, [persistGroups]);

  const value = useMemo<LibraryContextValue>(
    () => ({ setScope, favorites, isFavorite, toggleFavorite, groups, createGroup, updateGroup, deleteGroup }),
    [setScope, favorites, isFavorite, toggleFavorite, groups, createGroup, updateGroup, deleteGroup],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary deve ser usado dentro de <LibraryProvider>.');
  return ctx;
}
