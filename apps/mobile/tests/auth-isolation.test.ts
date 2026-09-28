import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { authenticatedTransfer, invalidateAuthRequests, request, setTokenRefreshHandler, setUnauthorizedHandler } from '../src/services/api';
import { clearStreamUrlsCache, requestCachedStreamUrls } from '../src/services/stream-urls-cache';
beforeEach(() => invalidateAuthRequests());

test('resposta atrasada nunca usa a credencial da próxima conta', async () => {
  const original = global.fetch;
  let complete!: (r: Response) => void;
  let calls = 0;
  let renewed = 0;
  global.fetch = async () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  try {
    setTokenRefreshHandler(async () => { renewed++; return 'conta-A-nova'; });
    const old = request('https://a.invalid', '/private', 'conta-A');
    invalidateAuthRequests();
    setTokenRefreshHandler(async () => { renewed++; return 'conta-B'; });
    complete(new Response('{}', { status: 401 }));
    await assert.rejects(old, /cancelada/);
    assert.equal(calls, 1); assert.equal(renewed, 0);
  } finally { global.fetch = original; setTokenRefreshHandler(null); }
});

test('logout durante refresh impede retry e restauração da chamada antiga', async () => {
  const original = global.fetch;
  let complete!: (token: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('{}', { status: 401 }); };
  try {
    setTokenRefreshHandler(() => { started(); return new Promise(resolve => { complete = resolve; }); });
    const pending = request('https://a.invalid', '/private', 'old');
    await ready;
    invalidateAuthRequests(); complete('new');
    await assert.rejects(pending, /cancelada/); assert.equal(calls, 1);
  } finally { global.fetch = original; setTokenRefreshHandler(null); }
});

test('indisponibilidade na renovação preserva sessão', async () => {
  const original = global.fetch;
  let logouts = 0;
  global.fetch = async () => new Response('{}', { status: 401 });
  setUnauthorizedHandler(() => { logouts++; });
  setTokenRefreshHandler(async () => { throw new Error('offline'); });
  try {
    await assert.rejects(request('https://a.invalid', '/private', 'old'), /offline/);
    assert.equal(logouts, 0);
  } finally { global.fetch = original; setTokenRefreshHandler(null); setUnauthorizedHandler(null); }
});

test('URLs de vídeo renovam token e preservam erro HTTP', async () => {
  const original = global.fetch;
  const headers: string[] = [];
  global.fetch = async (_url, init) => {
    headers.push((init?.headers as Record<string, string>).Authorization);
    return headers.length === 1 ? new Response('{}', { status: 401 }) : new Response('{"ok":true}');
  };
  setTokenRefreshHandler(async () => 'new');
  try {
    const value = await requestCachedStreamUrls('https://a.invalid', 'camera', 'old');
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(headers, ['Bearer old', 'Bearer new']);
    global.fetch = async () => new Response('{}', { status: 403 });
    await assert.rejects(requestCachedStreamUrls('https://a.invalid', 'other', 'old'), { status: 403 });
  } finally { clearStreamUrlsCache(); global.fetch = original; setTokenRefreshHandler(null); }
});

test('download nativo renova uma vez e não continua após logout', async () => {
  setTokenRefreshHandler(async () => 'renewed');
  const tokens: string[] = [];
  try {
    const result = await authenticatedTransfer('https://a.invalid', 'old', async token => {
      tokens.push(token); return { status: token === 'old' ? 401 : 200 };
    });
    assert.equal(result.status, 200); assert.deepEqual(tokens, ['old', 'renewed']);
    await assert.rejects(authenticatedTransfer('https://a.invalid', 'old', async () => {
      invalidateAuthRequests(); return { status: 401 };
    }), /cancelada/);
  } finally { setTokenRefreshHandler(null); }
});
