import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isLoopbackMediaWorkerAuthorized } from '../src/camera-stream/camera-stream.controller';

test('versioned raw paths are readable only by local workers, never external clients', () => {
  const path = `cam_${'a'.repeat(32)}_raw_${'b'.repeat(24)}_source`;
  assert.equal(isLoopbackMediaWorkerAuthorized({ ip: '127.0.0.1', action: 'read', path }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({ ip: '10.10.0.20', action: 'read', path }), false);
  assert.equal(isLoopbackMediaWorkerAuthorized({ ip: '127.0.0.1', action: 'publish', path }), false);
});

const cameraHex = '0123456789abcdef0123456789abcdef';

test('worker interno só lê path oculto e publica no path público via loopback', () => {
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '127.0.0.1',
    action: 'read',
    path: `cam_${cameraHex}_grid_source`,
  }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '::1',
    action: 'publish',
    path: `cam_${cameraHex}`,
  }), true);
  // MediaMTX recente pode incluir a porta junto ao IP no callback. Continua
  // sendo loopback, não uma autorização para a rede Docker.
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '127.0.0.1:8554',
    action: 'publish',
    path: `cam_${cameraHex}_grid`,
  }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '[::1]:8554',
    action: 'publish',
    path: `cam_${cameraHex}_grid`,
  }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '127.0.0.1:8554',
    action: 'publish',
    path: `cam_${cameraHex}_grid_audio`,
  }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '::1',
    action: 'read',
    path: `cam_${cameraHex}_orig_audio_source`,
  }), true);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '10.0.0.20',
    action: 'publish',
    path: `cam_${cameraHex}`,
  }), false);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '127.0.0.1',
    action: 'publish',
    path: `cam_${cameraHex}_source`,
  }), false);
  assert.equal(isLoopbackMediaWorkerAuthorized({
    ip: '127.0.0.1',
    action: 'read',
    path: '../outro',
  }), false);
});

test('pipelines RTSP locais usam o canal privado em vez de spawn direto com URL', () => {
  const files = [
    'src/cameras/cameras.service.ts',
    'src/camera-stream/clip-capture.service.ts',
    'src/camera-stream/ffmpeg-mjpeg.service.ts',
    'src/camera-stream/mediamtx-proxy.service.ts',
    'src/recordings/recording-process-manager.service.ts',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.match(
      source,
      /spawnWithSecretUrl|execFileWithSecretUrl/,
      `${file} deve usar o canal privado`,
    );
  }

  const proxySource = readFileSync(
    'src/camera-stream/mediamtx-proxy.service.ts',
    'utf8',
  );
  assert.match(proxySource, /privateSourceUrl/);
  assert.doesNotMatch(
    proxySource,
    /-i \\"\$\{sourceUrl\}\\"/,
    'runOnDemand não pode inserir a URL autenticada da câmera no shell/argv',
  );
  assert.match(
    proxySource,
    /rtsp:\/\/127\.0\.0\.1:\$RTSP_PORT\/\$\{pathName\}/,
    'publish interno deve usar loopback sem credencial no argv',
  );
});
