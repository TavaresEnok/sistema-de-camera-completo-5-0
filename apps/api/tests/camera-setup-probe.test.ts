import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Socket, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { boundedMap, checkSetupRtsp, probeCameraSetup, setupProfileTarget, setupRtspPorts, type SetupProbe } from '../src/cameras/helpers/camera-setup-probe.helper';

const failed: SetupProbe = { ok: false, port: null, path: null, error: 'not found', metadata: null, authDenied: false };
const success = (port: number, path: string): SetupProbe => ({ ok: true, port, path, error: null, metadata: { codec: 'h264', width: 1280, height: 720 }, authDenied: false });
const input = { port: 554, mode: 'automatic' as const, paths: ['/wrong', '/stream1'], deadline: Date.now() + 60_000 };

test('automatic includes 5540; manual tests only supplied port', () => {
  assert(setupRtspPorts(554).includes(5540));
  assert.deepEqual(setupRtspPorts(5540, 'manual'), [5540]);
});
test('automatic finds confirmed video on 5540, not open HTTP port', async () => {
  const tested: number[] = [];
  const result = await probeCameraSetup(input, {
    check: async port => port === 554 ? 'other' : port === 5540 ? 'rtsp' : 'closed', discover: async () => [],
    probe: async (port, paths) => { tested.push(port); return success(port, paths[1]); },
  });
  assert.deepEqual(tested, [5540]); assert.equal(result.probe?.port, 5540); assert.equal(result.failure, null);
});
test('manual custom path alone before ONVIF; supports one-session camera', async () => {
  let discovery = 0; const checked: number[] = [];
  const result = await probeCameraSetup({ ...input, port: 5540, mode: 'manual', customPath: '/my-video' }, {
    check: async port => { checked.push(port); return 'rtsp'; }, discover: async () => { discovery++; return []; },
    probe: async (port, paths, _deadline, concurrency) => { assert.deepEqual(paths, ['/my-video']); assert.equal(concurrency, 1); return success(port, paths[0]); },
  });
  assert.deepEqual(checked, [5540]); assert.equal(discovery, 0); assert.equal(result.probe?.ok, true);
});
test('ONVIF adds unusual port; discards embedded host and credentials', async () => {
  assert.deepEqual(setupProfileTarget({ rtspUri: 'rtsp://ignored:secret@192.168.1.7:12345/custom?channel=1' }), { port: 12345, path: '/custom?channel=1' });
  assert.equal(setupProfileTarget({ rtspUri: 'http://192.168.1.7/private' }), null);
  const result = await probeCameraSetup(input, {
    check: async port => port === 12345 ? 'rtsp' : 'closed', discover: async () => [{ rtspUri: 'rtsp://192.168.1.7:12345/custom' }],
    probe: async (port, paths) => { assert.equal(port, 12345); assert.deepEqual(paths, ['/custom']); return success(port, paths[0]); },
  });
  assert.equal(result.probe?.port, 12345);
});
test('ONVIF internal port does not replace manually forwarded external port', async () => {
  const checked: number[] = [];
  const result = await probeCameraSetup({ ...input, port: 5540, mode: 'manual' }, {
    check: async port => { checked.push(port); return 'rtsp'; }, discover: async () => [{ rtspUri: 'rtsp://192.168.1.2:554/custom' }],
    probe: async (port, paths) => success(port, paths[0]),
  });
  assert.deepEqual(checked, [5540]); assert.equal(result.probe?.path, '/custom');
});
test('password refusal stops without repeating all paths', async () => {
  let probes = 0;
  const result = await probeCameraSetup(input, {
    check: async port => port === 5540 ? 'rtsp' : 'closed', discover: async () => [],
    probe: async () => { probes++; return { ...failed, authDenied: true, error: '401 Unauthorized' }; },
  });
  assert.equal(probes, 1); assert.equal(result.failure, 'auth_denied');
});
test('unreachable, HTTP-only and unavailable video produce different errors', async () => {
  for (const [kind, expected] of [['closed', 'unreachable'], ['other', 'not_rtsp'], ['rtsp', 'video_unavailable']] as const) {
    const result = await probeCameraSetup({ ...input, mode: 'manual' }, { check: async () => kind, discover: async () => [], probe: async () => failed });
    assert.equal(result.failure, expected);
  }
});
test('camera ignoring OPTIONS still gets video test', async () => {
  const result = await probeCameraSetup({ ...input, mode: 'manual' }, { check: async () => 'unknown', discover: async () => [], probe: async (port, paths) => success(port, paths[0]) });
  assert.equal(result.probe?.ok, true);
});
test('deadline stops scheduling more work', async () => {
  let clock = 0; let probes = 0;
  const result = await probeCameraSetup({ ...input, mode: 'manual', deadline: 100 }, {
    now: () => clock, check: async () => 'rtsp', discover: async () => [],
    probe: async (_port, _paths, deadline) => { probes++; clock = deadline; return failed; },
  });
  assert.equal(probes, 1); assert.equal(result.failure, 'timeout');
});
test('TCP concurrency is bounded and preserves order', async () => {
  let active = 0; let peak = 0;
  const values = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(await boundedMap(values, 3, async value => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return value;
  }), values);
  assert.equal(peak, 3);
});
test('real sockets distinguish RTSP, HTTP and silent service; deadline closes sockets', async t => {
  const host = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
  assert(host);
  const previous = process.env.CAMERA_ALLOWED_CIDRS;
  process.env.CAMERA_ALLOWED_CIDRS = `${host}/32`;
  t.after(() => { if (previous === undefined) delete process.env.CAMERA_ALLOWED_CIDRS; else process.env.CAMERA_ALLOWED_CIDRS = previous; });
  for (const [response, expected] of [['RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n', 'rtsp'], ['HTTP/1.1 200 OK\r\n\r\n', 'other'], ['', 'unknown']] as const) {
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('data', () => { if (response) socket.write(response); }); });
    await new Promise<void>(resolve => server.listen(0, host, resolve));
    try { assert.equal(await checkSetupRtsp(host, (server.address() as AddressInfo).port, 100), expected); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
