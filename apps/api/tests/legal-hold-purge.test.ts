import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { RetentionService } from '../src/recordings/retention.service';

test('purge global é recusado quando existe retenção legal ativa', async () => {
  const prisma: any = {
    investigationItem: {
      findMany: async (args: any) => args.where?.type === 'legal_hold'
        ? [{ investigationId: 'case-1', metadata: { enabled: true, recordingIds: ['rec-1'] } }]
        : [],
    },
    exportedClip: { findMany: async () => [] },
  };
  const service = new RetentionService(prisma, {} as any, {} as any, {} as any, {} as any);
  await assert.rejects(() => service.assertGlobalPurgeAllowed(), ConflictException);
});

test('purge global segue quando não há evidência protegida', async () => {
  const prisma: any = {
    investigationItem: { findMany: async () => [] },
    exportedClip: { findMany: async () => [] },
  };
  const service = new RetentionService(prisma, {} as any, {} as any, {} as any, {} as any);
  await service.assertGlobalPurgeAllowed();
});
