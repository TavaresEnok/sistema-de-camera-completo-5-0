import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraConnectionError, cameraConnectionPayload, cameraConnectionTestPayload, cameraSetupFailureMessage, validCameraIp } from '../src/services/camera-setup';
import { request } from '../src/services/api';

const draft = { ip: ' 192.168.0.10 ', username: ' admin ', password: ' pass with spaces ', rtspPort: '', httpPort: '80', onvifPort: '', rtspPath: '' };

test('test payload distinguishes manual from automatic without changing create payload', () => {
  const manual = { ...draft, rtspPort: '5540' };
  assert.equal(cameraConnectionTestPayload(manual, false).rtspPortMode, 'manual');
  assert.equal(cameraConnectionTestPayload(draft, true).rtspPortMode, 'automatic');
  assert.equal(cameraConnectionTestPayload(manual, false).rtspPort, 5540);
  assert(!('rtspPortMode' in cameraConnectionPayload(manual)));
});

test('simple error messages distinguish refused password from port/video/timeout', () => {
  assert.match(cameraSetupFailureMessage('auth_denied')!, /usuário e a senha/);
  assert.match(cameraSetupFailureMessage('not_rtsp')!, /porta não fornece vídeo/);
  assert.match(cameraSetupFailureMessage('timeout')!, /demorou/);
  assert.equal(cameraSetupFailureMessage(undefined), null);
});

test('automatic connection preserves password and does not send absent optional fields', () => {
  assert.equal(cameraConnectionError(draft), null);
  assert.deepEqual(cameraConnectionPayload(draft), { ip: '192.168.0.10', username: 'admin', password: ' pass with spaces ', rtspPort: 554, httpPort: 80 });
});

test('custom forwarded ports and path survive validation and the create payload', () => {
  const custom = { ...draft, rtspPort: '5540', httpPort: '8000', onvifPort: '8000', rtspPath: ' /cam/realmonitor?channel=1&subtype=0 ' };
  assert.equal(cameraConnectionError(custom), null);
  const value = cameraConnectionPayload(custom);
  assert.equal(value.rtspPort, 5540); assert.equal(value.httpPort, 8000); assert.equal(value.onvifPort, 8000);
  assert.equal(value.rtspPath, '/cam/realmonitor?channel=1&subtype=0');
});

test('invalid ports never fall back silently to a different camera port', () => {
  for (const field of ['rtspPort', 'httpPort', 'onvifPort']) {
    for (const value of ['0', '65536', '-1', '1.5', '80abc']) {
      assert.ok(cameraConnectionError({ ...draft, [field]: value }));
      assert.throws(() => cameraConnectionPayload({ ...draft, [field]: value }));
    }
  }
  assert.ok(cameraConnectionError({ ...draft, httpPort: '' }));
});

test('IP field rejects URLs, incomplete IPv4 and ambiguous zero prefixes', () => {
  for (const value of ['192.168.0.10', '100.64.113.255', '2001:db8::1', '::1']) assert.equal(validCameraIp(value), true, value);
  for (const value of ['', '192.168.0', '999.1.1.1', '01.2.3.4', 'rtsp://192.168.0.10/video', 'camera.local', '1:2:3']) assert.equal(validCameraIp(value), false, value);
  assert.ok(cameraConnectionError({ ...draft, rtspPath: 'rtsp://192.168.0.10/video' }));
});

test('diagnostic timeout is configurable without leaking options to fetch; closing aborts request', async () => {
  const original = global.fetch;
  let seen: RequestInit | undefined;
  global.fetch = async (_input, init) => { seen = init; return new Response('{"ok":true}'); };
  try {
    assert.deepEqual(await request('https://camera.test', '/test', undefined, { timeoutMs: 90_000 }), { ok: true });
    assert.equal('timeoutMs' in (seen ?? {}), false);
    global.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const controller = new AbortController();
    const pending = request('https://camera.test', '/test', undefined, { timeoutMs: 90_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    await assert.rejects(request('https://camera.test', '/test', undefined, { timeoutMs: 5 }), /Tempo esgotado/);
  } finally { global.fetch = original; }
});
