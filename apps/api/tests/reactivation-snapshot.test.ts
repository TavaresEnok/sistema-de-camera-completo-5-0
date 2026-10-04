import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReactivationSnapshot } from '../src/cloud-connector/reactivation-snapshot.helper';

test('arquivo de reativação preserva configuração e remove credenciais/conteúdo', () => {
  const snapshot = buildReactivationSnapshot({
    installationId: 'cliente-a',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    collections: {
      sites: [{ id: 's1', name: 'Casa', location: 'Rua A' }],
      siteMapLayouts: [{ id: 'm1', siteId: 's1', markers: [], svgDataUrl: 'data:image/png;base64,privado' }],
      areas: [], groups: [], cameraPermissions: [], liveLayouts: [], aiSettings: [], rolePermissions: [],
      users: [{ id: 'u1', name: 'Ana', email: 'ana@example.com', passwordHash: 'hash', resetTokenHash: 'token' }],
      cameras: [{ id: 'c1', name: 'Portão', ip: '192.168.1.2', username: 'admin', groupId: 'g1', groupIds: ['g1', 'g2', 'g3', 'g4'], passwordEncrypted: 'cipher', rtmpIngestKeyEncrypted: 'cipher2' }],
      systemSettings: [{ key: 'brand.name', value: 'Cliente' }, { key: 'cloud.storage', value: 'segredo' }, { key: 'smtp.password', value: 'segredo' }],
    },
  });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes('passwordHash'), false);
  assert.equal(text.includes('passwordEncrypted'), false);
  assert.equal(text.includes('rtmpIngestKey'), false);
  assert.equal(text.includes('svgDataUrl'), false);
  assert.deepEqual(snapshot.systemSettings.map((item) => item.key), ['brand.name']);
  assert.equal(snapshot.cameras[0].name, 'Portão');
  assert.deepEqual(snapshot.cameras[0].groupIds, ['g1', 'g2', 'g3', 'g4']);
});
