import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AccessControlService } from '../access-control/access-control.service';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { MediamtxProxyService } from '../camera-stream/mediamtx-proxy.service';
import { AiService } from '../ai/ai.service';
import { AiManagerService } from '../ai/ai-manager.service';
import { RtmpIngestSourceService } from '../cameras/rtmp-ingest-source.service';
import { isPushSourced } from '../cameras/helpers/rtmp-ingest.helper';

@Injectable()
export class SgpRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SgpRuntimeService.name);
  private timer?: ReturnType<typeof setInterval>;
  private redis?: Redis;
  private running = false;
  private closing = false;
  private cameraCursor?: string;
  private readerCursor?: { protocol: string; sessionId: string };
  private lastFailure = 0;
  private verified = new Map<string, number>();
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly modules: ModuleRef,
    private readonly auth: AuthService, private readonly access: AccessControlService) {}

  onModuleInit() {
    this.redis = new Redis({ host: this.config.get<string>('redisHost') ?? 'redis', port: this.config.get<number>('redisPort') ?? 6379,
      lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 5000 });
    this.redis.on('error', () => undefined);
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.redis?.disconnect();
  }
  private get<T>(type: new (...args: any[]) => T): T { return this.modules.get(type, { strict: false }); }

  /** Re-evaluate membership under a row lock, including primary and secondary groups. */
  private async desired(cameraId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Camera" WHERE "id" = ${cameraId} FOR UPDATE`;
      const camera = await tx.camera.findUnique({ where: { id: cameraId }, include: { groups: { include: { sgpCustomer: true } }, group: { include: { sgpCustomer: true } } } });
      if (!camera) return null;
      const groups = [...camera.groups, ...(camera.group ? [camera.group] : [])];
      const blocked = groups.length > 0 && groups.every(group => group.sgpCustomer && group.sgpCustomer.state !== 'ACTIVE');
      if (blocked && camera.integrationEnabledBeforeBlock === null) {
        return tx.camera.update({ where: { id: cameraId }, data: { enabled: false, integrationEnabledBeforeBlock: camera.enabled, integrationRuntimePending: true } });
      }
      if (!blocked && camera.integrationEnabledBeforeBlock !== null) {
        return tx.camera.update({ where: { id: cameraId }, data: { enabled: camera.integrationEnabledBeforeBlock, integrationEnabledBeforeBlock: null, integrationRuntimePending: true } });
      }
      return camera;
    });
  }

  private async reconcileCamera(id: string) {
    const camera = await this.desired(id);
    if (!camera) return;
    if (!camera.integrationRuntimePending && camera.integrationEnabledBeforeBlock !== null && Date.now() - (this.verified.get(id) ?? 0) < 30_000) return;
    if (camera.integrationEnabledBeforeBlock !== null || (camera.integrationRuntimePending && !camera.enabled)) {
      await this.get(RecordingProcessManagerService).pauseForIntegration(id);
      await this.get(AiService).stopAnalysis(id);
      await this.get(MediamtxProxyService).teardownPathsForCamera(id, true);
      if (isPushSourced(camera)) await this.get(RtmpIngestSourceService).pausePublishers(camera);
    } else if (camera.integrationRuntimePending) {
      await this.get(RecordingProcessManagerService).pauseForIntegration(id);
      await this.get(RecordingProcessManagerService).resumeForIntegration(id);
      await this.get(AiManagerService).startCamera(id);
    }
    if (camera.integrationRuntimePending) {
      // A simultaneous setting/membership change cannot lose its pending reconciliation.
      await this.prisma.camera.updateMany({ where: { id, updatedAt: camera.updatedAt }, data: { integrationRuntimePending: false } });
    }
    this.verified.set(id, Date.now());
  }

  private async reconcileReaders() {
    const rows = await this.prisma.mediaReaderIdentity.findMany({ orderBy: [{ protocol: 'asc' }, { sessionId: 'asc' }], take: 200,
      ...(this.readerCursor ? { cursor: { protocol_sessionId: this.readerCursor }, skip: 1 } : {}) });
    this.readerCursor = rows.length === 200 ? { protocol: rows[199].protocol, sessionId: rows[199].sessionId } : undefined;
    const media = this.get(MediamtxProxyService);
    const sessions = new Map<string, Set<string>>();
    for (const row of rows) {
      let allowed = false;
      try { const user = await this.auth.me(row.userId); allowed = await this.access.canViewCamera(user, row.cameraId); }
      catch (error: any) { if (![401, 403, 404].includes(error?.getStatus?.())) throw error; }
      if (!allowed) {
        await media.revokeReader(row.protocol, row.sessionId);
        await this.prisma.mediaReaderIdentity.deleteMany({ where: { protocol: row.protocol, sessionId: row.sessionId } });
      } else if (row.createdAt.getTime() < Date.now() - 30_000) {
        if (!sessions.has(row.protocol)) sessions.set(row.protocol, await media.readerSessions(row.protocol));
        if (!sessions.get(row.protocol)!.has(row.sessionId)) await this.prisma.mediaReaderIdentity.deleteMany({ where: { protocol: row.protocol, sessionId: row.sessionId } });
      }
    }
  }

  async tick() {
    if (this.running || this.closing || !this.redis) return;
    this.running = true;
    const token = randomUUID(), key = 's2cam:sgp:runtime:lease';
    let acquired = false, owned = true;
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      if (!await this.prisma.sgpCustomer.count() && !await this.prisma.mediaReaderIdentity.count()) return;
      acquired = await this.redis.set(key, token, 'PX', 60_000, 'NX') === 'OK';
      if (!acquired) return;
      renewal = setInterval(() => {
        void this.redis!.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],60000) else return 0 end', 1, key, token)
          .then(result => { if (result !== 1) owned = false; }).catch(() => { owned = false; });
      }, 10_000);
      renewal.unref();
      await this.reconcileReaders();
      const rows = await this.prisma.camera.findMany({ where: { OR: [{ integrationEnabledBeforeBlock: { not: null } }, { integrationRuntimePending: true }, { groups: { some: { sgpCustomer: { isNot: null } } } }, { group: { sgpCustomer: { isNot: null } } }] },
        select: { id: true, groupId: true, groups: { select: { id: true } } }, orderBy: { id: 'asc' }, take: 100, ...(this.cameraCursor ? { cursor: { id: this.cameraCursor }, skip: 1 } : {}) });
      this.cameraCursor = rows.length === 100 ? rows[99].id : undefined;
      let failure = false;
      for (const row of rows) {
        if (!owned || this.closing) return;
        try { await this.reconcileCamera(row.id); } catch {
          failure = true;
          const groupIds = [...row.groups.map(group => group.id), ...(row.groupId ? [row.groupId] : [])];
          await this.prisma.sgpOperation.updateMany({ where: { state: 'PENDING', customer: { groupId: { in: groupIds } } }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10_000), lastError: 'Aguardando confirmação dos serviços das câmeras. Nova tentativa automática.' } });
        }
      }
      // Completion is evaluated only after a full membership pass and successful revocation.
      if (failure || this.cameraCursor || !owned) return;
      const operations = await this.prisma.sgpOperation.findMany({ where: { state: 'PENDING', nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 100, include: { customer: true } });
      for (const operation of operations) {
        const pending = await this.prisma.camera.count({ where: { integrationRuntimePending: true, OR: [{ groupId: operation.customer.groupId }, { groups: { some: { id: operation.customer.groupId } } }] } });
        await this.prisma.sgpOperation.updateMany({ where: { id: operation.id, state: 'PENDING' }, data: pending ? {
          attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10_000), lastError: 'Aguardando confirmação dos serviços das câmeras.',
        } : { state: operation.revision < operation.customer.revision ? 'IGNORED' : 'COMPLETE', lastError: null } });
      }
    } catch {
      if (Date.now() - this.lastFailure > 60_000) { this.lastFailure = Date.now(); this.logger.warn('Integração SGP: reconciliação pendente; nova tentativa automática.'); }
    } finally {
      if (renewal) clearInterval(renewal);
      if (acquired) await this.redis.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end', 1, key, token).catch(() => undefined);
      this.running = false;
    }
  }
}
