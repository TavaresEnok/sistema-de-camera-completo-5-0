// Harness Node only: no native modules or real device storage in unit tests.
const Module = require('node:module');
const original = Module._load;
const entries = new Map();
const files = new Map();
const secureEntries = new Map();
const storage = {
  getItem: async key => entries.get(key) ?? null,
  setItem: async (key, value) => { entries.set(key, value); },
  removeItem: async key => { entries.delete(key); },
  multiGet: async keys => keys.map(key => [key, entries.get(key) ?? null]),
};
const fs = {
  documentDirectory: 'file:///test/', cacheDirectory: 'file:///cache/',
  downloadAsync: async (_url, target) => { files.set(target, true); return { uri: target, status: 200 }; },
  getInfoAsync: async uri => ({ exists: files.has(uri), size: 2048 }),
  deleteAsync: async uri => { files.delete(uri); },
  moveAsync: async ({ from, to }) => { files.delete(from); files.set(to, true); },
};
global.__nativeStorageMocks = { entries, files, secureEntries };
Module._load = function (id, ...args) {
  if (id === '@react-native-async-storage/async-storage') return storage;
  if (id === 'expo-secure-store') return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
    getItemAsync: async key => secureEntries.get(key) ?? null,
    setItemAsync: async (key, value) => { secureEntries.set(key, value); },
    deleteItemAsync: async key => { secureEntries.delete(key); },
  };
  if (id === 'expo-file-system/legacy') return fs;
  if (id === 'expo-video-thumbnails') return { getThumbnailAsync: async () => { throw new Error('no native thumbnail'); } };
  if (id === 'expo-media-library') return {};
  return original.call(this, id, ...args);
};
