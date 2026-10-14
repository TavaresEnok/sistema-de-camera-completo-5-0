import test from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { GroupChatService } from '../src/group-chat/group-chat.service';
import { PushDevicesService } from '../src/notifications/push-devices.service';

const actor = (role: UserRole = UserRole.VIEWER) => ({ id: 'u1', username: 'u1', email: 'u1@example.invalid', name: 'Um', role });
function fixture(memberIds = ['u1', 'u2']) {
  const state = { active: true, status: 'ACTIVE', permission: true, ids: memberIds, last: null as Date | null, pushes: 0, messages: [] as any[], devices: [{ userId: 'u2', token: 'fcm:second' }], failure: false, lockCalls: 0 };
  const permissions = () => state.ids.map(userId => ({ userId, user: { integrationGroupId: null } }));
  const group = () => ({ id: 'g', name: 'Grupo', isActive: state.active, accessStatus: state.status, permissions: permissions() });
  const prisma: any = {
    cameraGroup: { findUnique: async () => group(), findMany: async (q: any) => {
      assert.equal(q.where.isActive, true); assert.equal(q.where.accessStatus, 'ACTIVE');
      if (q.where.permissions) assert.equal(q.where.permissions.some.userId, 'u1');
      assert.equal(q.select.permissions.where.user.isActive, true);
      assert.equal(q.select.permissions.where.user.integrationSuspended, false);
      return state.active && state.status === 'ACTIVE' ? [group()] : [];
    } },
    cameraPermission: { findFirst: async () => state.permission ? { id: 'permission' } : null, findMany: async () => state.ids.map(userId => ({ userId })) },
    user: { findMany: async () => [{ id: 'admin' }], findUnique: async () => ({ name: 'Um' }) },
    systemSetting: { findUnique: async () => null },
    camera: { findFirst: async (q: any) => { assert.equal(q.where.isPrivate, false); return null; } },
    groupMessage: {
      findMany: async () => state.messages,
      findFirst: async () => state.last ? { createdAt: state.last } : null,
      create: async ({ data, include }: any) => { assert.equal(include.user.select.name, true); const m = { id: `m${state.messages.length}`, ...data, createdAt: new Date(), user: { id: data.userId, name: 'Um' } }; state.messages.push(m); if (data.kind === 'ALERT') state.last = m.createdAt; return m; },
    },
    $queryRaw: async () => { state.lockCalls++; return []; },
  };
  let serial = Promise.resolve();
  prisma.$transaction = (fn: any) => { const next = serial.then(() => fn(prisma)); serial = next.catch(() => undefined); return next; };
  const push: any = { sendToTokens: async () => { state.pushes++; if (state.failure) throw Error('simulated failure'); return { invalidTokens: [], receiptIds: {} }; } };
  const devices: any = { aparelhosDeUsuarios: async (ids: string[]) => state.devices.filter(d => ids.includes(d.userId)), pruneInvalid: async () => {} };
  const service = new GroupChatService(prisma, push, devices, { log: async () => {} } as any);
  return { service, state };
}

test('um membro + administrador implícito não habilita chat nem pânico', async () => {
  const { service } = fixture(['u1']);
  assert.deepEqual(await service.listarGrupos(actor()), []);
  assert.deepEqual(await service.listarGrupos(actor(UserRole.ADMIN)), []);
  await assert.rejects(service.listar('g', actor()), /dois usuários/);
  await assert.rejects(service.dispararAlerta('g', actor(), {}), /dois usuários/);
});
test('conta pessoas distintas e não permissões duplicadas', async () => {
  assert.deepEqual(await fixture(['u1', 'u1']).service.listarGrupos(actor()), []);
  assert.deepEqual(await fixture(['u1', 'u1', 'u2']).service.listarGrupos(actor()), [{ id: 'g', name: 'Grupo', memberCount: 2 }]);
});
test('permissão revogada, grupo desativado e suspensão bloqueiam leitura e escrita', async () => {
  for (const change of [{ permission: false }, { active: false }, { status: 'SUSPENDED' }]) {
    const { service, state } = fixture(); Object.assign(state, change);
    await assert.rejects(service.listar('g', actor()));
    await assert.rejects(service.enviarTexto('g', actor(), 'teste'));
    await assert.rejects(service.dispararAlerta('g', actor(), {}));
    assert.equal(state.messages.length, 0); assert.equal(state.pushes, 0);
  }
});
test('usuário integrado não acessa outro grupo mesmo com permissão indevida', async () => {
  const { service } = fixture();
  await assert.rejects(service.listar('g', { ...actor(), integrationGroupId: 'other' }));
});
test('texto tem autor na resposta, limpa espaço e não envia push', async () => {
  const { service, state } = fixture(); const m = await service.enviarTexto('g', actor(), '  Olá   grupo  ');
  assert.equal(m.body, 'Olá grupo'); assert.equal(m.user.id, 'u1'); assert.equal(state.pushes, 0);
  await assert.rejects(service.enviarTexto('g', actor(), ' '));
});
test('pânico exclui autor, conta pessoas com vários aparelhos e mantém auditoria', async () => {
  const { service, state } = fixture(['u1', 'u2', 'u3']);
  state.devices = [{ userId: 'u1', token: 'fcm:self' }, { userId: 'u2', token: 'fcm:second' }, { userId: 'u2', token: 'fcm:second-device' }, { userId: 'u3', token: 'fcm:third' }];
  const r = await service.dispararAlerta('g', actor(), {});
  assert.equal(r.enviadoPara, 2); assert.equal(r.pushStatus, 'accepted'); assert.equal(r.mensagem.user.id, 'u1');
  assert.equal(r.semAparelho, 1); // admin implícito, não somado aos membros da interface
});
test('sem aparelho e falha de push nunca retornam sucesso de notificação', async () => {
  const empty = fixture(); empty.state.devices = [];
  assert.equal((await empty.service.dispararAlerta('g', actor(), {})).pushStatus, 'no_devices');
  const failed = fixture(); failed.state.failure = true; const r = await failed.service.dispararAlerta('g', actor(), {});
  assert.equal(r.pushStatus, 'failed'); assert.equal(r.enviadoPara, 0); assert.equal(failed.state.messages.length, 1);
});
test('pânico concorrente registra ambos os pedidos mas encaminha apenas um push', async () => {
  const { service, state } = fixture(); const r = await Promise.all([service.dispararAlerta('g', actor(), {}), service.dispararAlerta('g', actor(), {})]);
  assert.equal(state.messages.length, 2); assert.equal(state.lockCalls, 2); assert.equal(state.pushes, 1);
  assert.deepEqual(r.map(item => item.pushStatus).sort(), ['accepted', 'cooldown']);
});
test('contexto de câmera particular não é anunciado ao grupo', async () => {
  const { service, state } = fixture(); await assert.rejects(service.dispararAlerta('g', actor(), { cameraId: 'private' }), /Câmera não pertence/);
  assert.equal(state.messages.length, 0);
});
test('cadastro de aparelhos do grupo filtra contas inativas e tokens vencidos', async () => {
  let calls = 0;
  const service = new PushDevicesService({ pushDevice: { findMany: async (q: any) => { calls++; assert.equal(q.where.user.isActive, true); assert.deepEqual(q.where.userId.in, ['u2']); assert.ok(q.where.lastSeenAt.gte instanceof Date); return [{ userId: 'u2', token: 'synthetic' }]; } } } as any, {} as any);
  assert.deepEqual(await service.aparelhosDeUsuarios([]), []);
  assert.equal((await service.aparelhosDeUsuarios(['u2', 'u2'])).length, 1); assert.equal(calls, 1);
});
