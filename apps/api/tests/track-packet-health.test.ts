import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPacketHealth } from '../src/camera-stream/helpers/track-packet-health.helper';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

const packets = (kind: string, times: number[]) => times.map(x => ({ codec_type: kind, pts_time: String(x) }));
const check = (p: any[]) => trackPacketHealth(JSON.stringify({ packets: p }), ['H264', 'MPEG-4 Audio']);
test('timestamps prove progress independently of whether image or sound changes', () => {
  assert.deepEqual(check([...packets('video', [1, 2]), ...packets('audio', [1, 2])]),
    { video: 'progressing', audio: 'progressing' });
  assert.deepEqual(check(packets('audio', [1, 2])), { video: 'missing', audio: 'progressing' });
  assert.deepEqual(check(packets('video', [1, 2])), { video: 'progressing', audio: 'missing' });
  assert.equal(check([...packets('video', [1, 1]), ...packets('audio', [1, 2])]).video, 'stalled');
  assert.deepEqual(check([]), { video: 'unknown', audio: 'unknown' });
  assert.deepEqual(trackPacketHealth('not-json', ['H264']), { video: 'unknown', audio: 'unknown' });
  assert.equal(check([1, 2].map(x => ({ codec_type: 'video', pts_time: 'N/A', dts_time: String(x) }))).video, 'progressing');
});

function fixture(health: { video: string; audio: string }) {
  const service: any = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any);
  const name = `cam_${'a'.repeat(32)}_grid_audio`;
  let bytes = 0;
  const recovered: string[] = [];
  service.apiRequest = async () => JSON.stringify({ items: [{ name, ready: true, readers: [{}],
    bytesReceived: ++bytes, tracks: ['H264', 'MPEG-4 Audio'] }] });
  service.reconcileMissingPaths = async () => {};
  service.sampleTrackHealth = async () => health;
  service.recoverStuckPaths = async (items: any[]) => recovered.push(...items.map(x => x.name));
  return { service, recovered, name };
}
test('audio bytes cannot mask missing video; three confirmed samples recover the path', async () => {
  const { service, recovered, name } = fixture({ video: 'missing', audio: 'progressing' });
  await service.streamWatchdogTick();
  await service.streamWatchdogTick();
  assert.equal(recovered.length, 0);
  await service.streamWatchdogTick();
  assert.deepEqual(recovered, [name]);
});
test('inconclusive sampling never restarts an otherwise progressing source', async () => {
  const { service, recovered } = fixture({ video: 'unknown', audio: 'unknown' });
  for (let i = 0; i < 8; i++) await service.streamWatchdogTick();
  assert.equal(recovered.length, 0);
});
test('confirmed missing audio is recovered without classifying healthy video as absent', async () => {
  const { service, recovered } = fixture({ video: 'progressing', audio: 'missing' });
  for (let i = 0; i < 3; i++) await service.streamWatchdogTick();
  assert.equal(recovered.length, 1);
});
test('watchdog ticks cannot overlap', async () => {
  const { service } = fixture({ video: 'progressing', audio: 'progressing' });
  let release!: () => void;
  let probes = 0;
  service.sampleTrackHealth = async () => {
    probes++;
    await new Promise<void>(resolve => { release = resolve; });
    return { video: 'progressing', audio: 'progressing' };
  };
  const tick = service.streamWatchdogTick();
  await new Promise(resolve => setTimeout(resolve, 5));
  await service.streamWatchdogTick();
  release();
  await tick;
  assert.equal(probes, 1);
});
