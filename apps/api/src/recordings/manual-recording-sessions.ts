import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

type Session = { cameraId: string; expiresAt: Date; segmentSeconds: number; owner: string | null; leaseUntil: Date | null };
type Actions = {
  start: (cameraId: string, segmentSeconds: number) => Promise<unknown>;
  stop: (cameraId: string) => Promise<unknown>;
  protected: (cameraId: string) => Promise<boolean>;
  relinquish: (cameraId: string) => Promise<unknown>;
};

/** Durable intent plus a database lease: commands from other API replicas are queued for the owner. */
export class ManualRecordingSessions {
  readonly owner = randomUUID();
  private readonly running = new Set<string>();
  private reconciling = false;
  private closing = false;
  private inFlight = new Set<Promise<void>>();
  private fences = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly prisma: PrismaService, private readonly actions: Actions) {}

  private locked<T>(cameraId: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manual-recording:${cameraId}`}, 0))`;
      return run(tx);
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  async requestStart(cameraId: string, segmentSeconds: number, duration: number) {
    await this.locked(cameraId, async tx => {
      if (await this.actions.protected(cameraId)) return;
      await tx.$executeRaw`
        INSERT INTO "ManualRecordingSession" ("cameraId", "expiresAt", "segmentSeconds")
        VALUES (${cameraId}, NOW() + ${duration} * INTERVAL '1 second', ${segmentSeconds})
        ON CONFLICT ("cameraId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt",
          "segmentSeconds" = EXCLUDED."segmentSeconds", "updatedAt" = NOW()`;
    });
    await this.reconcileCamera(cameraId);
  }

  async requestStop(cameraId: string) {
    const count = await this.locked(cameraId, async tx => {
      return tx.$executeRaw`UPDATE "ManualRecordingSession" SET "expiresAt" = NOW(), "updatedAt" = NOW() WHERE "cameraId" = ${cameraId}`;
    });
    await this.reconcileCamera(cameraId);
    return count > 0;
  }

  async active(cameraIds: string[]): Promise<Set<string>> {
    if (!cameraIds.length) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ cameraId: string }>>`
      SELECT "cameraId" FROM "ManualRecordingSession"
      WHERE "cameraId" IN (${Prisma.join(cameraIds)}) AND "expiresAt" > NOW()`;
    return new Set(rows.map(row => row.cameraId));
  }

  async reconcile() {
    if (this.reconciling || this.closing) return;
    this.reconciling = true;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ cameraId: string }>>`SELECT "cameraId" FROM "ManualRecordingSession" ORDER BY "expiresAt"`;
      const errors: unknown[] = [];
      for (const row of rows) {
        try { await this.reconcileCamera(row.cameraId); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Falha ao recuperar sessões manuais');
    } finally { this.reconciling = false; }
  }

  async reconcileCamera(cameraId: string) {
    if (this.closing) return;
    const task = this.reconcileOne(cameraId);
    this.inFlight.add(task);
    try { await task; } finally { this.inFlight.delete(task); }
  }

  private async reconcileOne(cameraId: string) {
    try { await this.locked(cameraId, async tx => {
      const [session] = await tx.$queryRaw<Session[]>`SELECT * FROM "ManualRecordingSession" WHERE "cameraId" = ${cameraId}`;
      if (!session || this.closing) return;
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (session.owner && session.owner !== this.owner && session.leaseUntil && session.leaseUntil > now) return;
      if (await this.actions.protected(cameraId)) {
        this.clearFence(cameraId);
        await tx.$executeRaw`DELETE FROM "ManualRecordingSession" WHERE "cameraId" = ${cameraId}`;
        this.running.delete(cameraId);
        return;
      }
      if (session.expiresAt <= now) {
        await this.actions.stop(cameraId);
        this.clearFence(cameraId);
        await tx.$executeRaw`DELETE FROM "ManualRecordingSession" WHERE "cameraId" = ${cameraId}`;
        this.running.delete(cameraId);
        return;
      }
      if (!this.running.has(cameraId)) {
        await this.actions.start(cameraId, session.segmentSeconds);
        this.running.add(cameraId);
      }
      const [{ remainingMs }] = await tx.$queryRaw<Array<{ remainingMs: number }>>`UPDATE "ManualRecordingSession" SET "owner" = ${this.owner},
        "leaseUntil" = clock_timestamp() + INTERVAL '30 seconds', "updatedAt" = NOW() WHERE "cameraId" = ${cameraId}
        RETURNING (EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) * 1000)::double precision AS "remainingMs"`;
      this.clearFence(cameraId);
      // Encerra apenas o processo local antes de outra réplica poder assumir.
      const fence = setTimeout(() => {
        this.running.delete(cameraId);
        this.fences.delete(cameraId);
        void this.actions.relinquish(cameraId).catch(() => undefined);
      }, Math.max(1, Math.min(20_000, remainingMs)));
      fence.unref();
      this.fences.set(cameraId, fence);
    }); } catch (error) {
      // Efeitos externos não fazem rollback junto com a transação SQL.
      // Não mantenha FFmpeg rodando se a confirmação da posse falhar.
      if (this.running.delete(cameraId)) {
        this.clearFence(cameraId);
        await this.actions.relinquish(cameraId);
      }
      throw error;
    }
  }

  private clearFence(cameraId: string) {
    const timer = this.fences.get(cameraId);
    if (timer) clearTimeout(timer);
    this.fences.delete(cameraId);
  }

  async release() {
    await this.pause();
    await this.prisma.$executeRaw`UPDATE "ManualRecordingSession" SET "owner" = NULL, "leaseUntil" = NULL WHERE "owner" = ${this.owner}`;
  }

  async pause() {
    this.closing = true;
    await Promise.allSettled([...this.inFlight]);
    for (const cameraId of this.fences.keys()) this.clearFence(cameraId);
  }
}
