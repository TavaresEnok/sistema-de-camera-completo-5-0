import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRtspSourceService } from '../src/cameras/shared-rtsp-source.service';

function fixture() {
  const paths = new Map<string, any>();
  const writes: any[] = [];
  const service: any = new SharedRtspSourceService({ get: (key: string) => ({
    mediaMtxRtspInternalUrl: 'rtsp://media:8554', mediaMtxApiUser: 'internal', mediaMtxApiPass: 'private',
  } as any)[key] } as any);
  service.request = async (method: string, path: string, body: any) => {
    if (method === 'GET' && path.includes('/list?')) return { items: [...paths].map(([name, value]) => ({ name, ...value })) };
    const name = path.split('/').at(-1);
    if (method === 'GET') {
      if (!paths.has(name)) throw Object.assign(new Error('missing'), { status: 404 });
      return path.includes('/v3/paths/get/') ? { ...paths.get(name), readers: [] } : paths.get(name);
    }
    writes.push({ method, name, body });
    if (method === 'POST') paths.set(name, body);
    if (method === 'DELETE') paths.delete(name);
    return {};
  };
  return { service, paths, writes };
}

test('concurrent consumers share one exact raw source without video/audio conversion', async () => {
  const { service, writes } = fixture();
  const input = 'rtsp://user:password@camera:554/live?channel=1&subtype=0';
  const outputs = await Promise.all(Array.from({ length: 8 }, () => service.resolve('abc', input, 'tcp')));
  assert.ok(outputs.every(x => x.shared && x.url === outputs[0].url));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.source, input);
  assert.equal(writes[0].body.sourceOnDemand, true);
  assert.equal(writes[0].body.runOnDemand, undefined);
  assert.match(writes[0].name, /^cam_abc_raw_[a-f0-9]{24}_source$/);
});

test('main, sub, credential and transport changes create distinct generations', async () => {
  const { service, writes } = fixture();
  const url = 'rtsp://user:password@camera:554/live?channel=1&subtype=0';
  const a = await service.resolve('abc', url, 'tcp');
  const b = await service.resolve('abc', url.replace('subtype=0', 'subtype=1'), 'tcp');
  const c = await service.resolve('abc', url.replace('password', 'rotated'), 'tcp');
  const d = await service.resolve('abc', url, 'udp');
  assert.equal(new Set([a.url, b.url, c.url, d.url]).size, 4);
  assert.equal(writes.filter(x => x.method === 'DELETE').length, 0);
});

test('control-plane failure falls back without deleting a source', async () => {
  const { service, writes } = fixture();
  service.request = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
  const url = 'rtsp://camera/live';
  assert.deepEqual(await service.resolve('abc', url, 'tcp'), { url, shared: false });
  assert.equal(writes.length, 0);
});

test('source is re-created after MediaMTX loses its in-memory configuration', async () => {
  const { service, paths, writes } = fixture();
  await service.resolve('abc', 'rtsp://camera/live', 'tcp');
  paths.clear();
  for (const x of service.known.values()) x.at = 0;
  const result = await service.resolve('abc', 'rtsp://camera/live', 'tcp');
  assert.equal(result.shared, true);
  assert.equal(writes.filter(x => x.method === 'POST').length, 2);
});

test('cleanup preserves raw dependencies of idle on-demand public paths', async () => {
  const { service, paths, writes } = fixture();
  const raw = await service.resolve('abc', 'rtsp://camera/live', 'tcp');
  await new Promise(resolve => setTimeout(resolve, 5));
  for (const x of service.known.values()) x.touched = Date.now() - 700_000;
  paths.set('cam_abc_grid', { source: raw.url, sourceOnDemand: true });
  await service.cleanup();
  assert.equal(writes.filter(x => x.method === 'DELETE').length, 0);
  paths.delete('cam_abc_grid');
  await service.cleanup();
  assert.equal(writes.filter(x => x.method === 'DELETE').length, 1);
});

test('raw restart preserves the physical channel, credentials and transport', async () => {
  const { service, writes } = fixture();
  const source = 'rtsp://user:password@camera/live?channel=2&subtype=1';
  const raw = await service.resolve('abc', source, 'udp');
  await service.restart(new URL(raw.url).pathname.slice(1));
  const additions = writes.filter(x => x.method === 'POST');
  assert.equal(additions.length, 2);
  assert.deepEqual(additions[1].body, additions[0].body);
});
