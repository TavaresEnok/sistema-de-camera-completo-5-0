import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SgpService } from '../src/sgp/sgp.service';

const id = '11111111-1111-4111-8111-111111111111';
const valid = { integrationId: id, revision: 2, keyHash: 'a'.repeat(64), keyPrefix: 'abc123' };
function serviceWith(settings: Record<string, string>, integration: any = null) {
  const writes: any[] = [];
  const tx: any = {
    systemSetting: { findUnique: async ({ where }: any) => settings[where.key] === undefined ? null : { value: settings[where.key] }, upsert: async (value: any) => { writes.push(value); } },
    sgpIntegration: { findUnique: async () => integration, create: async (value: any) => { writes.push(value); }, update: async (value: any) => { writes.push(value); } },
    auditLog: { create: async (value: any) => { writes.push(value); } },
  };
  const service: any = new SgpService(tx, {} as any, {} as any);
  service.locked = async (run: any) => run(tx);
  return { service, writes };
}
test('Central credentials validate identifier, revision, digest and suffix before writing', async () => {
  for (const value of [{ ...valid, integrationId: '../other' }, { ...valid, revision: 0 }, { ...valid, revision: 1.5 }, { ...valid, keyHash: 'raw-token' }, { ...valid, keyPrefix: null }, { ...valid, keyHash: null, keyPrefix: 'abc123' }]) {
    const { service, writes } = serviceWith({});
    await assert.rejects(() => service.applyCentralCredential(value));
    assert.equal(writes.length, 0);
  }
});
test('older delivery cannot restore a superseded or revoked key', async () => {
  const { service, writes } = serviceWith({ 'cloud.sgpManagedId': id, 'cloud.sgpAppliedRevision': '3' }, { id, keyHash: null });
  assert.equal((await service.applyCentralCredential(valid)).ignored, true);
  assert.equal(writes.length, 0);
});
test('Central never adopts an existing local integration implicitly', async () => {
  const { service, writes } = serviceWith({}, { id, keyHash: 'b'.repeat(64) });
  await assert.rejects(() => service.applyCentralCredential(valid));
  assert.equal(writes.length, 0);
});
test('bound installation rejects a different integration identifier', async () => {
  const { service, writes } = serviceWith({ 'cloud.sgpManagedId': id });
  await assert.rejects(() => service.applyCentralCredential({ ...valid, integrationId: '22222222-2222-4222-8222-222222222222' }));
  assert.equal(writes.length, 0);
});
test('local key rotation cannot bypass a Central-managed token', async () => {
  const { service, writes } = serviceWith({ 'cloud.sgpManagedId': id });
  await assert.rejects(() => service.rotateKey('actor', id));
  assert.equal(writes.length, 0);
});
