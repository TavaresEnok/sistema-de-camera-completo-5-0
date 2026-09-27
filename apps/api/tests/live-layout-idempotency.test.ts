import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveLayoutsService } from '../src/live-layouts/live-layouts.service';

test('duas abas/retry criam somente um layout; outro usuário tem chave independente', async () => {
  const rows = new Map<string, any>();
  const service = new LiveLayoutsService({ liveLayout: {
    create: async ({ data }: any) => {
      if (rows.has(data.id)) throw Object.assign(new Error('duplicado'), { code: 'P2002' });
      rows.set(data.id, data);
      return data;
    },
    findUnique: async ({ where }: any) => rows.get(where.id),
  } } as any, {} as any);
  const draft = { name: 'Portaria', gridSize: '2x2', cameraIds: ['a'], clientRequestId: 'local-operation-1' };
  const user = { id: 'user-1', role: 'VIEWER' } as any;
  const [first, retry] = await Promise.all([service.create(user, draft), service.create(user, draft)]);
  assert.equal(first.id, retry.id);
  assert.equal(rows.size, 1);
  const other = await service.create({ ...user, id: 'user-2' }, draft);
  assert.notEqual(other.id, first.id);
  assert.equal(rows.size, 2);
  const replay = await service.create(user, { ...draft, name: 'Não deve sobrescrever' });
  assert.equal(replay.name, 'Portaria');
});
