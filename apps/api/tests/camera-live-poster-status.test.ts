import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CamerasService } from '../src/cameras/cameras.service';

test('poster capturado recentemente comprova vídeo sem abrir outra sessão RTSP', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'camera-poster-status-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true }); });
  const service = Object.create(CamerasService.prototype) as any;
  service.configService = { get: (key: string) => key === 'livePosterStorageRoot' ? root : undefined };
  service.ingestPathIsLive = async () => { throw new Error('poster recente deve evitar a consulta'); };
  const poster = join(root, 'camera-camera123.jpg');
  await writeFile(poster, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(await service.cameraTransmitindoAgora('camera123'), true);

  const old = new Date(Date.now() - 180_000);
  await utimes(poster, old, old);
  service.ingestPathIsLive = async () => false;
  assert.equal(await service.cameraTransmitindoAgora('camera123'), false, 'poster antigo não comprova sinal');
});
