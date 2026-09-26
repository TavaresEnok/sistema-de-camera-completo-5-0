import test from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { PushDevicesService } from '../src/notifications/push-devices.service';

test('push usa a decisão da ACL e exclui usuário inativo', async () => {
  const checked: string[] = [];
  const prisma: any = {
    camera: { findUnique: async () => ({ groupId: 'g1', ownerUserId: 'owner' }) },
    cameraPermission: { findMany: async () => [{ userId: 'viewer' }, { userId: 'inactive' }] },
    user: {
      findMany: async ({ where }: any) => where?.role
        ? [{ id: 'admin' }]
        : [
          { id: 'admin', username: 'admin', email: null, name: 'Admin', role: UserRole.ADMIN },
          { id: 'owner', username: 'owner', email: null, name: 'Owner', role: UserRole.VIEWER },
          { id: 'viewer', username: 'viewer', email: null, name: 'Viewer', role: UserRole.VIEWER },
          // `inactive` não volta desta consulta: o filtro isActive é obrigatório.
        ],
    },
    notificationMute: { findMany: async () => [] },
    pushDevice: {
      findMany: async ({ where }: any) => where.userId.in.map((id: string) => ({ token: `token-${id}` })),
    },
  };
  const accessControl: any = {
    canViewCamera: async (user: any) => {
      checked.push(user.id);
      return user.id === 'owner';
    },
  };
  const service = new PushDevicesService(prisma, accessControl);
  assert.deepEqual(await service.getTokensForCamera('private-camera'), ['token-owner']);
  assert.deepEqual(checked.sort(), ['admin', 'owner', 'viewer']);
});
