import test from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { CameraGroupsService } from '../src/camera-groups/camera-groups.service';
import { CameraPermissionsService } from '../src/camera-permissions/camera-permissions.service';
import { SettingsService } from '../src/settings/settings.service';
import { UsersService } from '../src/users/users.service';
import { RolePermissionsService } from '../src/role-permissions/role-permissions.service';
import { DEFAULT_PERMISSIONS } from '../src/role-permissions/role-permissions.constants';
import { validate } from 'class-validator';
import { LoginDto } from '../src/auth/dto/login.dto';

const actor = (role = UserRole.VIEWER) => ({ id: 'viewer', name: 'Teste', email: 'test@example.invalid', role });
test('login não rejeita senha legada permitida pela política da instalação', async () => {
  const dto = Object.assign(new LoginDto(), { username: 'viewer', password: '1234' });
  assert.deepEqual(await validate(dto), []);
  assert.notEqual((await validate(Object.assign(new LoginDto(), { username: 'viewer', password: '' }))).length, 0);
});
const cameras = [
  { id: 'allowed', name: 'Permitida', groupId: 'group', retentionDays: 3, retentionFollowsGroup: true, ip: 'private-ip', passwordEncrypted: 'fake-cipher' },
  { id: 'forbidden', name: 'Não permitida', groupId: 'group', retentionDays: 3, retentionFollowsGroup: true, passwordEncrypted: 'fake-cipher' },
];
function groupPrisma() {
  const selectGroup = (query: any) => {
    const scope = query.include.cameras;
    assert.notEqual(scope, true);
    const permitted = scope.where?.id.in ?? cameras.map((c) => c.id);
    return { id: 'group', isActive: true, cameras: cameras.filter((c) => permitted.includes(c.id)).map((c) => Object.fromEntries(Object.keys(scope.select).map((key) => [key, (c as any)[key]]))) };
  };
  return { cameraGroup: { findMany: async (q: any) => [selectGroup(q)], findUnique: async (q: any) => selectGroup(q) } };
}
for (const role of Object.values(UserRole)) {
  test(`grupos: resumo seguro e escopo de câmeras para ${role}`, async () => {
    const service = new CameraGroupsService(groupPrisma() as any, { getAccessibleCameraIds: async () => ['allowed'] } as any);
    const list = await service.list(actor(role));
    const detail = await service.getById('group', actor(role));
    for (const group of [list[0], detail]) {
      assert.deepEqual(group.cameras.map((c: any) => c.id), ['allowed']);
      assert.equal('passwordEncrypted' in group.cameras[0], false);
      assert.equal('ip' in group.cameras[0], false);
    }
  });
}
test('grupos: adicionar preserva os vínculos existentes e bloqueia o quinto', async () => {
  const ids = ['old'];
  const tx = {
    $queryRaw: async () => [],
    cameraGroup: { findUnique: async () => ({ id: 'new', isActive: true }) },
    camera: {
      findUnique: async () => ({ id: 'camera', groupId: 'old', groups: ids.map((id) => ({ id })) }),
      update: async ({ data }: any) => { assert.equal(data.groupId, undefined); ids.push(data.groups.connect.id); },
    },
  };
  const service = new CameraGroupsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
  await service.addCamera('second', 'camera');
  await service.addCamera('third', 'camera');
  await service.addCamera('fourth', 'camera');
  assert.deepEqual(ids, ['old', 'second', 'third', 'fourth']);
  await service.addCamera('second', 'camera');
  assert.equal(ids.length, 4);
  await assert.rejects(service.addCamera('fifth', 'camera'), /4 grupos/);
});
test('grupos: câmeras particulares não são transferidas', async () => {
  const tx = { $queryRaw: async () => [], cameraGroup: { findUnique: async () => ({ isActive: true }) }, camera: { findUnique: async () => ({ isPrivate: true }) } };
  const service = new CameraGroupsService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
  await assert.rejects(service.addCamera('group', 'camera'), /particulares/);
});
test('minha conta: usuário comum lê suas próprias permissões, não as de outra pessoa', async () => {
  const queries: any[] = [];
  const service = new CameraPermissionsService({ cameraPermission: { findMany: async (q: any) => { queries.push(q); return [{ userId: 'viewer', groupId: 'group' }]; } } } as any, { getAdminGroupIds: async () => [] } as any);
  assert.equal((await service.list(actor(), 'viewer')).length, 1);
  assert.deepEqual(queries[0].where, { userId: 'viewer' });
  assert.deepEqual(await service.list(actor(), 'another-user'), []);
  assert.deepEqual(await service.list(actor()), []);
});
test('gestão global: userManage negada impede escrita de usuários e acessos', async () => {
  const permissions = { hasPermission: async () => false };
  const users = new UsersService({} as any, {} as any, {} as any, {} as any, permissions as any);
  const admin = actor(UserRole.ADMIN);
  await assert.rejects(users.create(admin, {} as any), /gerenciar usuários/);
  await assert.rejects(users.update(admin, 'other', {}), /gerenciar usuários/);
  await assert.rejects(users.softDelete(admin, 'other'), /gerenciar usuários/);
  await assert.rejects(users.hardDelete(admin, 'other'), /gerenciar usuários/);
  const access = new CameraPermissionsService({} as any, {} as any, permissions as any);
  await assert.rejects(access.grant(admin, {} as any), /gerenciar acessos/);
  await assert.rejects(access.update(admin, 'permission', {} as any), /gerenciar acessos/);
  await assert.rejects(access.remove(admin, 'permission'), /gerenciar acessos/);
});
test('configurações: valida todos os campos antes de qualquer escrita', async () => {
  let writes = 0;
  const service = new SettingsService({ systemSetting: { upsert: () => { writes++; } } } as any);
  await assert.rejects(service.patch({ facilityName: 'Teste', brandPrimaryColor: 'invalid' }), /Cor inválida/);
  assert.equal(writes, 0);
});
test('configurações: grava todos os campos dentro de uma única transação', async () => {
  let transactions = 0;
  const changes: any[] = [];
  const prisma = { systemSetting: { upsert: (data: any) => { changes.push(data); return Promise.resolve(data); }, findMany: async () => [] }, $transaction: async (ops: Promise<unknown>[]) => { transactions++; return Promise.all(ops); } };
  await new SettingsService(prisma as any).patch({ facilityName: 'Teste', brandPrimaryColor: '#aa00aa' });
  assert.equal(transactions, 1);
  assert.deepEqual(changes.map((c) => c.where.key), ['facilityName', 'brandPrimaryColor']);
});
test('funções: rejeita matriz incompleta e alteração do administrador principal', async () => {
  const service = new RolePermissionsService({} as any);
  await assert.rejects(service.updateRole(UserRole.ADMIN, { liveView: true }), /todas as permissões/);
  await assert.rejects(service.updateRole(UserRole.ADMIN, null), /Informe as permissões/);
  await assert.rejects(service.updateRole(UserRole.SUPER_ADMIN, DEFAULT_PERMISSIONS.SUPER_ADMIN), /não podem ser alteradas/);
});
