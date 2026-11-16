import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PassageCountsService } from '../src/passage-counts/passage-counts.service';

test('PostgreSQL: monotonic ingestion, sessions, permissions, timezone and historical lines', { skip: !process.env.PASSAGE_TEST_DATABASE_URL }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.PASSAGE_TEST_DATABASE_URL! } } });
  const cameraId = randomUUID(), groupId = randomUUID();
  const line = { id: 'test-line', name: 'Entrada', kind: 'line', uso: 'contagem', points: [[0.2, 0.5], [0.8, 0.5]], classes: ['person'] };
  const user = { id: randomUUID(), role: 'ADMIN' } as any;
  let allowed = [cameraId];
  const service = new PassageCountsService(prisma as any, { getAccessibleCameraIds: async () => allowed } as any);
  try {
    await prisma.cameraGroup.create({ data: { id: groupId, name: 'Integration test' } });
    await prisma.camera.create({ data: { id: cameraId, name: 'Integration test', ip: '192.0.2.1', username: 'test', passwordEncrypted: 'dummy', groupId, detectionZones: [line] } });
    const base = { minuteStart: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), lineId: line.id, classLabel: 'person', direction: 'in' };
    const ingest = (count: number, session = 'integration-session') => service.ingest(cameraId, { session, buckets: [{ ...base, count }] });
    await ingest(2); await ingest(7); await ingest(4); await ingest(7);
    assert.equal((await prisma.passageCount.findFirstOrThrow({ where: { cameraId } })).count, 7);
    await service.ingest(cameraId, { session: 'integration-session', buckets: [{ ...base, count: 8 }, { ...base, count: 10 }] });
    await ingest(3, 'second-session');
    const query = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 60000).toISOString(), kind: 'person' };
    const report = await service.report(user, query);
    assert.equal(report.totals.in, 13);
    const time = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date(base.minuteStart));
    assert.ok(report.series[0].bucket.endsWith(`T${time}:00`));
    assert.equal((await service.report(user, { ...query, kind: 'vehicle' })).totals.in, 0);
    await prisma.camera.update({ where: { id: cameraId }, data: { detectionZones: [] } });
    const lines = await service.lines(user);
    assert.equal(lines[0].active, false);
    assert.equal(lines[0].lineId, line.id);
    assert.equal((await service.report(user, query)).totals.in, 13);
    allowed = [];
    assert.deepEqual(await service.lines(user), []);
    assert.equal((await service.report(user, query)).totals.in, 0);
  } finally {
    await prisma.camera.deleteMany({ where: { id: cameraId } });
    await prisma.cameraGroup.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});
