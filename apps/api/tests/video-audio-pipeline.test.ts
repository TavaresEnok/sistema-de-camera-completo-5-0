import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { isManagedLivePublisher, withTranscodeAdmission, liveConversionCost, withWeightedTranscodeAdmission } from '../src/camera-stream/helpers/transcode-admission.helper';
import { audioCodecFromTracks } from '../src/camera-stream/helpers/live-audio.helper';

test('audio capability comes from live tracks, unknown is not absence', () => {
  assert.equal(audioCodecFromTracks(['H264', 'Opus'], true), 'opus');
  assert.equal(audioCodecFromTracks(['H264', 'MPEG-4 Audio'], true), 'aac');
  assert.equal(audioCodecFromTracks(['H264'], true), 'none');
  assert.equal(audioCodecFromTracks(['H264', 'Generic'], true), null);
  assert.equal(audioCodecFromTracks([], false), null);
});

test('runtime counts delivery RTSP publishers but not ingest or passthrough', () => {
  assert.equal(isManagedLivePublisher({ name: 'cam_abc_grid_audio', ready: true, source: { type: 'rtspSession' } }), true);
  for (const path of [
    { name: 'cam_abc_grid', ready: true, source: { type: 'rtspSource' } },
    { name: 'secret_ingest', ready: true, source: { type: 'rtspSession' } },
    { name: 'cam_abc_grid', ready: false, source: { type: 'rtspSession' } },
  ]) assert.equal(isManagedLivePublisher(path), false);
});

test('conversion budget distinguishes audio copy, small encode and heavy decode', () => {
  assert.equal(liveConversionCost({ videoEncoded: false, width: 3840, height: 2160, fps: 60 }), 1);
  assert.equal(liveConversionCost({ videoEncoded: true, codec: 'h264', width: 640, height: 360, fps: 20 }), 2);
  assert.equal(liveConversionCost({ videoEncoded: true, codec: 'hevc', width: 1920, height: 1080, fps: 30 }), 4);
  assert.equal(liveConversionCost({ videoEncoded: true }), 4);
});

test('weighted admission holds all points atomically and releases after exit', async () => {
  const script = withWeightedTranscodeAdmission("sh -c 'echo ready; sleep 1'", 4, 4);
  assert.doesNotMatch(script, /\$/);
  const first = spawn('sh', ['-c', script]);
  const ended = new Promise(resolve => first.once('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    first.stdout.once('data', () => resolve());
    first.once('error', reject);
    first.once('exit', code => { if (code) reject(new Error(`weighted publisher exited ${code}`)); });
  });
  const run = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn('sh', ['-c', withWeightedTranscodeAdmission('true', 4, 1)]);
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(await run(), 75);
  await ended;
  assert.equal(await run(), 0);
  const oversized = spawn('sh', ['-c', withWeightedTranscodeAdmission('true', 1, 4)]);
  assert.equal(await new Promise(resolve => oversized.once('exit', resolve)), 75);
});

test('metadata probe coalesces modalities and isolates credentials and transport', async () => {
  const service: any = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any);
  let calls = 0;
  service.runProbeStreamVideoMetadata = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { codec: 'h264', width: 1920, height: 1080, hasDataTrack: false, audioCodec: 'aac' };
  };
  const source = 'rtsp://user:secret@camera:554/live';
  const [a, b] = await Promise.all([
    service.probeStreamVideoMetadata(source, 'tcp'), service.probeStreamVideoMetadata(source, 'tcp'),
  ]);
  assert.equal(a, b);
  assert.equal(a.audioCodec, 'aac');
  await service.probeStreamVideoMetadata(source, 'tcp');
  assert.equal(calls, 1);
  await service.probeStreamVideoMetadata(source.replace('secret', 'rotated'), 'tcp');
  await service.probeStreamVideoMetadata(source, 'udp');
  assert.equal(calls, 3);
  for (const key of service.streamMetadataCache.keys()) assert.match(key, /^[a-f0-9]{64}$/);
});

test('kernel admission rejects concurrent startup and releases on process exit', async () => {
  assert.doesNotMatch(withTranscodeAdmission('true', 10), /\$/,
    'MediaMTX substitutes dollar variables before shell evaluation');
  const first = spawn('sh', ['-c', withTranscodeAdmission("sh -c 'echo ready; sleep 1'", 1)]);
  await new Promise<void>((resolve, reject) => {
    first.stdout.once('data', () => resolve());
    first.once('error', reject);
    first.once('exit', code => { if (code) reject(new Error(`first publisher exited ${code}`)); });
  });
  const run = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn('sh', ['-c', withTranscodeAdmission('true', 1)]);
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const ended = new Promise(resolve => first.once('exit', resolve));
  assert.equal(await run(), 75);
  await ended;
  assert.equal(await run(), 0);
});

async function configure(codec: string, mode: 'grid-audio' | 'original-audio', current?: any, readers = 0) {
  const service: any = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any);
  const writes: any[] = [];
  Object.assign(service, {
    logger: { log() {}, warn() {}, debug() {} },
    resolvePushLiveSource: async () => ({ sourceUrl: 'rtsp://media:8554/input', codec, isHevc: codec === 'h265', width: 1920, height: 1080, fps: 20, profile: null }),
    buildInternalPublishRtspUrl: () => 'rtsp://media:8554/cam_test_grid_audio',
    getPath: async () => { if (current) return current; throw Object.assign(new Error('missing'), { status: 404 }); },
    apiRequest: async (method: string, _path: string, body: any) => {
      if (method !== 'GET') writes.push({ method, body });
      return JSON.stringify({ readers: Array(readers).fill({ type: 'webRTCSession' }) });
    },
  });
  const result = await service.configureResolvedPathForCamera({ id: 'test', sourceMode: 'rtmp_push' }, mode);
  return { result, writes, config: writes.find(x => x.method === 'POST')?.body };
}

test('1080p RTMP H264 with audio copies video and only encodes audio', async () => {
  const { result, config } = await configure('h264', 'grid-audio');
  assert.equal(result.videoEncoded, false);
  assert.equal(result.audioEncoded, true);
  assert.match(config.runOnDemand, /-c:v copy/);
  assert.doesNotMatch(config.runOnDemand, /-c:v libx264/);
  assert.match(config.runOnDemand, /flock -n 9/);
  assert.doesNotMatch(config.runOnUnDemand, /\$/,
    'MediaMTX must not expand cleanup shell variables before execution');
  const encoded = config.runOnUnDemand.match(/printf %s ([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(encoded);
  assert.match(Buffer.from(encoded, 'base64').toString(), /\$d\/comm/);
});

test('HEVC compatibility grid encodes video, original audio preserves codec', async () => {
  const grid = await configure('h265', 'grid-audio');
  assert.equal(grid.result.videoEncoded, true);
  assert.match(grid.config.runOnDemand, /-c:v libx264/);
  const original = await configure('h265', 'original-audio');
  assert.equal(original.result.videoEncoded, false);
  assert.match(original.config.runOnDemand, /-c:v copy/);
});

test('policy refresh drains active readers instead of deleting their path', async () => {
  const previous = (await configure('h264', 'grid-audio')).config;
  previous.runOnDemand = previous.runOnDemand.replace('-c:v copy', '-c:v libx264');
  const active = await configure('h264', 'grid-audio', previous, 1);
  assert.deepEqual(active.writes, []);
  assert.equal(active.result.videoEncoded, true, 'report actual old encoder until drained');
  const idle = await configure('h264', 'grid-audio', previous, 0);
  assert.ok(idle.config);
  assert.equal(idle.result.videoEncoded, false);
});

test('poster capture rejects disabled cameras before selecting a source', () => {
  const source = readFileSync('src/camera-stream/ffmpeg-mjpeg.service.ts', 'utf8');
  const start = source.indexOf('private async generateLivePosterFrame');
  assert.ok(source.indexOf('if (camera.enabled === false)', start) < source.indexOf('await this.getGridPosterSource', start));
});
