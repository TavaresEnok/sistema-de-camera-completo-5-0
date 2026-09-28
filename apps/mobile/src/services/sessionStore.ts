import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { DEFAULT_API_URL, SESSION_KEY } from '../config';
import type { Session } from '../types';
import { normalizeApiUrl } from '../utils/server-url';

const BIOMETRIC_LOGIN_KEY = `${SESSION_KEY}.biometric`;
let sessionWrites: Promise<unknown> = Promise.resolve();
function serializeSessionWrite(action: () => Promise<void>) {
  const next = sessionWrites.catch(() => undefined).then(action);
  sessionWrites = next;
  return next;
}
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Tokens não devem migrar para outro aparelho via backup/restauração do
  // sistema. Também ficam indisponíveis enquanto o dispositivo está bloqueado.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function cleanApiUrl(value: string) {
  return normalizeApiUrl(value, DEFAULT_API_URL);
}

export async function loadStoredSession() {
  const secureRaw = await SecureStore.getItemAsync(SESSION_KEY, SECURE_OPTIONS);
  if (secureRaw) return migrateStoredSession(secureRaw);

  const legacyRaw = await AsyncStorage.getItem(SESSION_KEY);
  if (legacyRaw) {
    await SecureStore.setItemAsync(SESSION_KEY, legacyRaw, SECURE_OPTIONS);
    await AsyncStorage.removeItem(SESSION_KEY);
  }
  return legacyRaw ? migrateStoredSession(legacyRaw) : legacyRaw;
}

async function migrateStoredSession(raw: string): Promise<string> {
  try {
    const session = JSON.parse(raw) as Session;
    const apiUrl = cleanApiUrl(session.apiUrl || '');
    if (apiUrl && apiUrl !== session.apiUrl) {
      const migrated = JSON.stringify({ ...session, apiUrl });
      await SecureStore.setItemAsync(SESSION_KEY, migrated, SECURE_OPTIONS);
      return migrated;
    }
  } catch {
    // A validação normal de sessão tratará conteúdo legado inválido.
  }
  return raw;
}

export async function saveStoredSession(session: Session) {
  return serializeSessionWrite(async () => {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), SECURE_OPTIONS);
  await AsyncStorage.removeItem(SESSION_KEY);
  });
}

export async function clearStoredSession() {
  return serializeSessionWrite(async () => {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await AsyncStorage.removeItem(SESSION_KEY);
  });
}

export async function isBiometricLoginEnabled() {
  return (await SecureStore.getItemAsync(BIOMETRIC_LOGIN_KEY, SECURE_OPTIONS)) === 'true';
}

export async function setBiometricLoginEnabled(enabled: boolean) {
  if (enabled) await SecureStore.setItemAsync(BIOMETRIC_LOGIN_KEY, 'true', SECURE_OPTIONS);
  else await SecureStore.deleteItemAsync(BIOMETRIC_LOGIN_KEY);
}
