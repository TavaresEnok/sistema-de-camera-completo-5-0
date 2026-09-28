import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClipCaptureService } from '../src/camera-stream/clip-capture.service';

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-clip-test-'));
  const create = () => new ClipCaptureService({ get: (key: string) => key === 'recordingsRoot' ? root : undefined } as any, {} as any, {} as any, {} as any) as any;
  const service = create();
  const clipId = '11111111-1111-4111-8111-111111111111';
  const st = { clipId, cameraId: 'camera', userId: 'owner', startedAt: Date.now(), expiresAt: Date.now() + 86400000,
    filePath: path.join(root, '.mobile-clips', `${clipId}.mp4`), recordPath: path.join(root, '.mobile-clips', `${clipId}.ts`),
    exited: true, proc: null, stderrTail: '', exitCode: 0 };
  service.clips.set(clipId, st);
  return { root, create, service, st, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('remux falho preserva original e não promove arquivo parcial', async () => {
  const h = harness();
  try {
    fs.writeFileSync(h.st.recordPath, 'original');
    h.service.remux = async (_src: string, dest: string) => { fs.writeFileSync(dest, Buffer.alloc(2048)); return false; };
    await assert.rejects(h.service.stop(h.st.clipId, 'owner'), /preservado/);
    assert.equal(fs.readFileSync(h.st.recordPath, 'utf8'), 'original');
    assert.equal(fs.existsSync(h.st.filePath), false);
  } finally { h.cleanup(); }
});

test('stops simultâneos convertem uma vez; restart conserva arquivo e proprietário', async () => {
  const h = harness();
  try {
    fs.writeFileSync(h.st.recordPath, 'original');
    let conversions = 0;
    h.service.remux = async (_src: string, dest: string) => {
      conversions++; await new Promise(resolve => setTimeout(resolve, 10));
      fs.writeFileSync(dest, Buffer.alloc(2048)); return true;
    };
    const results = await Promise.all([h.service.stop(h.st.clipId, 'owner'), h.service.stop(h.st.clipId, 'owner')]);
    assert.equal(conversions, 1); assert.deepEqual(results[0], results[1]);
    assert.equal(fs.existsSync(h.st.recordPath), false);
    const restarted = h.create();
    assert.equal(restarted.getClipFile(h.st.clipId, 'owner'), h.st.filePath);
    assert.throws(() => restarted.getClipFile(h.st.clipId, 'other'));
    assert.deepEqual(await restarted.stop(h.st.clipId, 'owner'), results[0]);
  } finally { h.cleanup(); }
});

test('reserva de capacidade cobre awaits e é liberada quando a fonte falha', async () => {
  const h = harness();
  try {
    h.service.maxConcurrent = 1;
    h.service.checkFfmpeg = () => true;
    let fail!: (error: Error) => void;
    h.service.camerasService = { getCameraOrThrow: () => new Promise((_resolve, reject) => { fail = reject; }) };
    const first = h.service.start('camera', 'owner');
    await assert.rejects(h.service.start('camera', 'owner'), /Muitas gravações/);
    fail(new Error('camera offline'));
    await assert.rejects(first, /offline/);
    assert.equal(h.service.pendingStarts, 0);
  } finally { h.cleanup(); }
});
