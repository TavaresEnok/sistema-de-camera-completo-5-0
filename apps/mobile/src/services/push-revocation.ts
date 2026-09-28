import * as SecureStore from 'expo-secure-store';

const KEY = 's2cam.push.revocations.v1';
type Pending = { apiUrl: string; receipt: string; queuedAt: number };
type State = { active: Record<string, { token: string; receipt: string }>; pending: Pending[] };
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = writes.catch(() => undefined).then(action);
  writes = next;
  return next;
}
async function read(): Promise<State> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? JSON.parse(raw) : { active: {}, pending: [] };
}
async function save(state: State) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(state), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export function rememberPushRegistration(apiUrl: string, token: string, receipt: string) {
  return serialized(async () => {
    const state = await read(); state.active[apiUrl] = { token, receipt }; await save(state);
  });
}

/** Guarda apenas capacidade de remoção, nunca senha/token de sessão após sair. */
export function queuePushRemoval(apiUrl: string, token?: string | null) {
  return serialized(async () => {
    const state = await read();
    const active = state.active[apiUrl];
    if (active && (!token || active.token === token)) {
      state.pending.push({ apiUrl, receipt: active.receipt, queuedAt: Date.now() });
      delete state.active[apiUrl];
      await save(state);
    }
  });
}

let flushing: Promise<void> | null = null;
export function flushPushRemovals(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const snapshot = await serialized(read);
    for (const item of snapshot.pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      let done = Date.now() - item.queuedAt > 7 * 24 * 60 * 60 * 1000;
      try {
        if (!done) {
          const result = await fetch(`${item.apiUrl}/notifications/devices/revoke`, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt: item.receipt }),
          });
          done = result.ok || result.status === 401;
        }
      } catch { /* permanece na fila até reconectar/expirar */ }
      finally { clearTimeout(timer); }
      if (done) await serialized(async () => {
        const state = await read(); state.pending = state.pending.filter(p => p.receipt !== item.receipt);
        await save(state);
      });
    }
  })().catch(() => undefined).finally(() => { flushing = null; });
  return flushing;
}
