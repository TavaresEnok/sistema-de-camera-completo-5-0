import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { LiveCompatibilityMemory, unsafeVideoTimestamps, compatibilityVideoArgs, audioDecodeErrors } from '../src/camera-stream/helpers/live-compatibility.helper';
import { isManagedLivePublisher } from '../src/camera-stream/helpers/transcode-admission.helper';

test('automatic original-quality adapters count against capacity, direct RTSP sources do not', () => {
  assert.equal(isManagedLivePublisher({name:'cam_test_orig',ready:true,source:{type:'rtspSession'}}),true);
  assert.equal(isManagedLivePublisher({name:'cam_test_orig',ready:true,source:{type:'rtspSource'}}),false);
  assert.equal(isManagedLivePublisher({name:'cam_test_orig',ready:false,source:{type:'rtspSession'}}),false);
});

test('initial compatibility probe is packet-bounded even when the camera clock resets', () => {
  const source=readFileSync(new URL('../src/camera-stream/mediamtx-proxy.service.ts',import.meta.url),'utf8');
  const initial=source.slice(source.indexOf('private runProbeStreamVideoMetadata('),source.indexOf('private async resolveLiveCompatibility('));
  assert.match(initial, /'-read_intervals', '%\+#64'/);
  assert.doesNotMatch(initial, /'-read_intervals', '%\+1'/);
});

test('B-frame/timestamp adaptations preserve maximum resolution and repair before fps', () => {
  const full = compatibilityVideoArgs({ fps: 10, original: true, width: 640, height: 360, bitrate: 4000 });
  assert.match(full, /-bf 0/);
  assert.match(full, /setpts=N\/\(10\*TB\),fps=10/);
  assert.doesNotMatch(full, /scale=/);
  const grid = compatibilityVideoArgs({ fps: 10, original: false, width: 640, height: 360, bitrate: 900 });
  assert.match(grid, /setpts=.*scale=.*fps=10/);
});

test('timestamp detection tolerates normal frame reordering but rejects clock resets', () => {
  assert.equal(unsafeVideoTimestamps([{ codec_type: 'video', dts_time: '1' }, { codec_type: 'video', dts_time: '1.1' }]), false);
  assert.equal(unsafeVideoTimestamps([{ codec_type: 'video', dts_time: '1' }, { codec_type: 'video', dts_time: '0.95' }]), false);
  assert.equal(unsafeVideoTimestamps([{ codec_type: 'video', dts_time: '1500' }, { codec_type: 'video', dts_time: '0' }]), true);
  assert.equal(unsafeVideoTimestamps([{ codec_type: 'video', dts_time: '0' }, { codec_type: 'video', dts_time: '1500' }]), true);
});

test('real Dguardian clock jump is detected even when the H264 header reports no B frames', () => {
  const packets=[2.4958,40179.583089,2.6958,2.7958].map(dts=>({codec_type:'video',dts_time:String(dts)}));
  assert.equal(unsafeVideoTimestamps(packets),true);
});

test('decisions survive restart without storing camera credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-compat-'));
  try {
    const file = join(directory, 'state.json');
    const key = LiveCompatibilityMemory.key('rtsp://admin:PRIVATE_PASS@camera/live?token=PRIVATE_TOKEN', 'tcp');
    new LiveCompatibilityMemory(file).set(key, { normalizeVideo: true, audio: 'invalid' });
    assert.deepEqual(new LiveCompatibilityMemory(file).get(key), { normalizeVideo: true, audio: 'invalid' });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /PRIVATE|rtsp:|admin/);
    assert.notEqual(key, LiveCompatibilityMemory.key('rtsp://admin:rotated@camera/live', 'tcp'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function proxy(decision: { normalizeVideo: boolean; audio: 'healthy' | 'invalid' | 'unknown' }) {
  const service: any = new MediamtxProxyService({ get: () => undefined } as any, {} as any, {} as any);
  const writes: any[] = [];
  Object.assign(service, {
    logger: { log() {}, warn() {}, debug() {} },
    resolvePushLiveSource: async () => ({ sourceUrl: 'rtsp://media:8554/input', codec: 'h264', isHevc: false,
      width: 1920, height: 1080, fps: 10, profile: null, audioCodec: 'aac' }),
    resolveLiveCompatibility: async () => decision,
    buildInternalPublishRtspUrl: () => 'rtsp://media:8554/cam_test_orig_audio',
    getPath: async () => { throw Object.assign(new Error('missing'), { status: 404 }); },
    apiRequest: async (method: string, _path: string, body: any) => { if (method === 'POST') writes.push(body); return '{}'; },
  });
  return { service, writes };
}

test('invalid audio is omitted without disabling the camera or changing recording configuration', async () => {
  const { service, writes } = proxy({ normalizeVideo: true, audio: 'invalid' });
  const camera = { id: 'test', sourceMode: 'rtmp_push', recordingMode: 'continuous', audioEnabled: true };
  const result = await service.configureResolvedPathForCamera(camera, 'original-audio');
  assert.equal(result.videoEncoded, true);
  assert.equal(result.audioEncoded, false);
  assert.equal(result.audioAvailable, false);
  assert.equal(result.compatibility.audioUnavailable, true);
  assert.match(writes[0].runOnDemand, /-an /);
  assert.doesNotMatch(writes[0].runOnDemand, /-map 0:a|scale=/);
  assert.equal(camera.audioEnabled, true);
  assert.equal(camera.recordingMode, 'continuous');
});

test('compatible H264 bypasses video encoding, healthy audio only encodes audio', async () => {
  const { service, writes } = proxy({ normalizeVideo: false, audio: 'healthy' });
  const result = await service.configureResolvedPathForCamera({ id: 'test', sourceMode: 'rtmp_push' }, 'original-audio');
  assert.equal(result.videoEncoded, false);
  assert.equal(result.audioEncoded, true);
  assert.match(writes[0].runOnDemand, /-c:v copy/);
});

test('normalization is automatically detected without the Dguardian manual flag', async () => {
  const { service } = proxy({ normalizeVideo: false, audio: 'unknown' });
  delete service.resolveLiveCompatibility;
  service.compatibilityMemory = new LiveCompatibilityMemory('/nonexistent/compat-test.json');
  service.probeStreamVideoMetadata = async () => ({ codec: 'h264', hasBFrames: true, audioCodec: 'aac' });
  service.probeAudioDecoding = async () => 'invalid';
  const result = await service.resolveLiveCompatibility('rtsp://camera/auto', 'tcp', true, 'aac');
  assert.equal(result.normalizeVideo, true);
  assert.equal(result.audio, 'invalid');
});

test('unknown probe does not switch healthy cameras into costly encoding', async () => {
  const { service } = proxy({ normalizeVideo: false, audio: 'unknown' });
  delete service.resolveLiveCompatibility;
  service.compatibilityMemory = new LiveCompatibilityMemory('/nonexistent/compat-test.json');
  service.probeStreamVideoMetadata = async () => null;
  const result = await service.resolveLiveCompatibility('rtsp://camera/unknown', 'tcp', false, null);
  assert.equal(result.normalizeVideo, false);
});

test('HEVC B frames alone do not force a compatible maximum-quality stream into H264', async () => {
  const { service } = proxy({ normalizeVideo: false, audio: 'unknown' });
  delete service.resolveLiveCompatibility;
  service.compatibilityMemory = new LiveCompatibilityMemory('/nonexistent/compat-test.json');
  service.probeStreamVideoMetadata = async () => ({ codec: 'hevc', hasBFrames: true, audioCodec: 'none' });
  const result = await service.resolveLiveCompatibility('rtsp://camera/hevc-compatible', 'tcp', false, 'none');
  assert.equal(result.normalizeVideo, false);
});

test('browser network and ICE errors never request video encoding', async () => {
  const { service } = proxy({ normalizeVideo: false, audio: 'unknown' });
  service.apiRequest = () => { throw new Error('network failure must not reach control plane'); };
  await service.noteClientMediaFailure('test', 'webrtc', 'ICE conexão sem rede');
  await service.noteClientMediaFailure('test', 'hls', 'fetch 401');
  assert.equal(service.compatibilityFailures.size, 0);
});

test('audio that becomes corrupt after startup is rechecked and does not prevent video recovery', async () => {
  const { service } = proxy({ normalizeVideo: true, audio: 'healthy' });
  const path = service.pathNameFromCameraId('test', 'original-audio');
  const url = 'rtsp://camera/later-audio';
  service.compatibilitySources.set(path, { url, transport: 'tcp' });
  service.compatibilityMemory = new LiveCompatibilityMemory('/nonexistent/compat-later.json');
  const key = LiveCompatibilityMemory.key(url, 'tcp');
  service.compatibilityMemory.set(key, { normalizeVideo: true, audio: 'healthy' });
  service.apiRequest = async () => JSON.stringify({ ready: false, bytesReceived: 0, readers: [] });
  service.probeAudioDecoding = async () => 'invalid';
  let recoveries = 0;
  service.recoverStuckPath = async () => { recoveries++; };
  await service.noteClientMediaFailure('test', 'webrtc', 'não entregou vídeo válido', 'original-audio');
  assert.equal(recoveries, 0);
  await service.noteClientMediaFailure('test', 'hls', 'erro fatal da mídia HLS', 'original-audio');
  assert.equal(recoveries, 1);
  assert.equal(service.compatibilityMemory.get(key).audio, 'invalid');
});

test('several decode errors distinguish corrupt audio from a single startup warning', () => {
  assert.equal(audioDecodeErrors('channel element 2.1 is not allocated'), 1);
  assert.equal(audioDecodeErrors('Error submitting packet to decoder: Invalid data found when processing input\n'.repeat(4)), 8);
});
