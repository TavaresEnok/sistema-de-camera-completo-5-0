import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ManualRecordingSessions } from '../src/recordings/manual-recording-sessions';

test('PostgreSQL isolado: prazo sobrevive reinício, duas réplicas não duplicam e stop remoto chega ao dono', async () => {
  assert.equal(process.env.MANUAL_SESSION_TEST_DATABASE, 'isolated', 'Nunca executar contra produção');
  const db = new PrismaService();
  await db.$executeRawUnsafe('CREATE TABLE "Camera" (id TEXT PRIMARY KEY)');
  for (const statement of readFileSync('prisma/migrations/20260927060000_manual_recording_sessions/migration.sql', 'utf8').split(';').filter(x => x.trim())) {
    await db.$executeRawUnsafe(statement);
  }
  await db.$executeRaw`INSERT INTO "Camera" (id) VALUES ('a'), ('continuous'), ('b'), ('deadline'), ('crash')`;
  const calls: string[] = [];
  const actions = (owner: string) => ({
    start: async (id: string) => { calls.push(`start:${owner}:${id}`); },
    stop: async (id: string) => { calls.push(`stop:${owner}:${id}`); },
    relinquish: async (id: string) => { calls.push(`release:${owner}:${id}`); },
    protected: async (id: string) => id === 'continuous',
  });
  const first = new ManualRecordingSessions(db, actions('first'));
  const second = new ManualRecordingSessions(db, actions('second'));
  const reboot = new ManualRecordingSessions(db, actions('reboot'));
  try {
    await Promise.all([first.requestStart('a', 60, 600), second.requestStart('a', 60, 600)]);
    assert.equal(calls.filter(x => x.startsWith('start:')).length, 1);
    assert.equal((await second.active(['a'])).has('a'), true);
    await first.requestStart('continuous', 60, 600);
    assert.equal((await first.active(['continuous'])).size, 0);
    const before = await db.$queryRaw<Array<{ expiresAt: Date }>>`SELECT "expiresAt" FROM "ManualRecordingSession" WHERE "cameraId" = 'a'`;
    await first.release();
    await second.release();
    await reboot.reconcile();
    assert.ok(calls.includes('start:reboot:a'));
    const after = await db.$queryRaw<Array<{ expiresAt: Date }>>`SELECT "expiresAt" FROM "ManualRecordingSession" WHERE "cameraId" = 'a'`;
    assert.equal(after[0].expiresAt.getTime(), before[0].expiresAt.getTime());
    const remote = new ManualRecordingSessions(db, actions('remote'));
    await remote.requestStop('a');
    assert.ok(!calls.includes('stop:remote:a'));
    await reboot.reconcile();
    assert.ok(calls.includes('stop:reboot:a'));
    assert.equal((await reboot.active(['a'])).size, 0);
    await remote.release();
    await reboot.requestStart('b', 60, 600);
    await db.$executeRaw`UPDATE "ManualRecordingSession" SET "expiresAt" = NOW() - INTERVAL '1 second' WHERE "cameraId" = 'b'`;
    await reboot.reconcile();
    assert.ok(calls.includes('stop:reboot:b'));
    assert.equal(await reboot.requestStop('missing'), false, 'parada sem sessão permite fallback legado');
    await reboot.requestStart('deadline', 60, 1);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.ok(calls.includes('release:reboot:deadline'), 'watchdog encerra processo mesmo sem novo polling SQL');
    await reboot.reconcile();
    assert.ok(calls.includes('stop:reboot:deadline'));
    await reboot.requestStart('crash', 60, 600);
    await reboot.pause(); // Simula processo encerrado sem liberar a posse no banco.
    const takeover = new ManualRecordingSessions(db, actions('takeover'));
    try {
      await takeover.reconcile();
      assert.ok(!calls.includes('start:takeover:crash'), 'lease válida não pode ser tomada');
      await db.$executeRaw`UPDATE "ManualRecordingSession" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "cameraId" = 'crash'`;
      await takeover.reconcile();
      assert.ok(calls.includes('start:takeover:crash'), 'lease expirada permite recuperação');
    } finally { await takeover.release(); }
  } finally {
    await first.release(); await second.release(); await reboot.release();
    await db.$disconnect();
  }
});
