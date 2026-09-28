import assert from 'node:assert/strict';
import test from 'node:test';
import { PushDevicesService } from '../src/notifications/push-devices.service';

test('recibo de saída só remove cadastro original e nunca uma renovação', async () => {
  let row: any;
  const prisma: any = { pushDevice: {
    upsert: async ({ create }: any) => { row = create; return row; },
    deleteMany: async ({ where }: any) => {
      if (row?.userId === where.userId && row.token === where.token && row.lastSeenAt.getTime() === where.lastSeenAt.getTime()) row = null;
    },
  } };
  const service = new PushDevicesService(prisma, {} as any, { get: () => 'test-only-secret' } as any);
  const receipt = (await service.register('owner', 'device-token')).revocationReceipt!;
  await assert.rejects(service.revokeReceipt(`${receipt}x`));
  assert.ok(row);
  row.lastSeenAt = new Date(row.lastSeenAt.getTime() + 1);
  await service.revokeReceipt(receipt);
  assert.ok(row, 'recibo antigo não remove renovação');
  const fresh = (await service.register('owner', 'device-token')).revocationReceipt!;
  await service.revokeReceipt(fresh);
  assert.equal(row, null);
  await service.revokeReceipt(fresh); // repetição idempotente
});

test('cadastros push inativos têm validade limitada', async () => {
  let where: any;
  const service = new PushDevicesService({ pushDevice: { findMany: async (query: any) => { where = query.where; return []; } } } as any, {} as any);
  await service.tokensDeUsuarios(['owner']);
  assert.ok(where.lastSeenAt.gte instanceof Date);
  assert.ok(Date.now() - where.lastSeenAt.gte.getTime() <= 7 * 86400000 + 1000);
});
