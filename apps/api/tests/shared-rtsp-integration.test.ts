import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SharedRtspSourceService } from '../src/cameras/shared-rtsp-source.service';

// Run only on the isolated fixture network. Never points at production cameras.
test('real RTSP H264/AAC and HEVC/AAC share one upstream for multiple readers',
  { skip: process.env.RUN_SHARED_RTSP_INTEGRATION !== 'true', timeout: 60000 }, async () => {
  const service = new SharedRtspSourceService({ get: (key: string) => ({
    mediaMtxApiBaseUrl: 'http://raw-broker:9997', mediaMtxRtspInternalUrl: 'rtsp://raw-broker:8554',
  } as any)[key] } as any);
  const children: ReturnType<typeof spawn>[] = [];
  const poll = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate().catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('fixture did not become ready');
  };
  const get = async (host: string, path: string) => {
    const response = await fetch(`http://${host}:9997/v3/${path}`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('fixture control unavailable');
    return response.json() as Promise<any>;
  };
  try {
    for (const codec of ['libx264', 'libx265']) {
      const name = codec === 'libx264' ? 'h264' : 'hevc';
      const publisher = spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20',
        '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', codec, '-threads', '1',
        ...(codec === 'libx265' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error'] : []),
        '-preset', 'ultrafast', '-g', '20', '-c:a', 'aac', '-f', 'rtsp', '-rtsp_transport', 'tcp',
        `rtsp://raw-origin:8554/${name}`], { stdio: 'ignore' });
      children.push(publisher);
      await poll(async () => (await get('raw-origin', `paths/get/${name}`)).ready);
      const raw = await service.resolve('a'.repeat(32), `rtsp://raw-origin:8554/${name}`, 'tcp');
      assert.equal(raw.shared, true);
      const path = new URL(raw.url).pathname.slice(1);
      const readers = Array.from({ length: 3 }, () => spawn('ffmpeg', ['-v', 'error', '-rtsp_transport', 'tcp',
        '-i', raw.url, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { stdio: 'ignore' }));
      children.push(...readers);
      await poll(async () => (await get('raw-broker', `paths/get/${path}`)).readers.length === 3);
      const origin = await get('raw-origin', `paths/get/${name}`);
      const broker = await get('raw-broker', `paths/get/${path}`);
      assert.equal(origin.readers.length, 1, 'multiple downstream consumers must not open multiple camera sessions');
      assert.deepEqual(broker.tracks, origin.tracks, 'raw sharing must preserve video codec and audio');
      const probe = spawn('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-read_intervals', '%+3',
        '-show_packets', '-show_entries', 'packet=codec_type,pts_time', '-of', 'json', raw.url]);
      children.push(probe);
      let output = '';
      probe.stdout.on('data', chunk => { output += chunk.toString(); });
      probe.stderr.resume();
      assert.equal(await new Promise(resolve => probe.once('close', resolve)), 0);
      const packets = JSON.parse(output).packets;
      const video = packets.filter((x: any) => x.codec_type === 'video');
      assert.ok(video.length >= 45, `expected progressing 20 FPS stream, got ${video.length} packets`);
      assert.ok(packets.some((x: any) => x.codec_type === 'audio'));
      console.log(`${name}: 3 readers / 1 upstream; ${video.length} video packets in ~3s; audio preserved`);
      for (const child of [...readers, publisher]) child.kill('SIGKILL');
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});
