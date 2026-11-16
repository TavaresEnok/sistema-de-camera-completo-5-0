import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { linhasDeContagem, RETENCAO_DIAS, validarConsulta, validarLote, validarTipoDeContagem } from './passage-count.helper';

const FUSO = 'America/Sao_Paulo';
const LIMPEZA_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class PassageCountsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PassageCountsService.name);
  private limpeza?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  onModuleInit() {
    this.limpeza = setInterval(() => void this.removerAntigos().catch(() => undefined), LIMPEZA_MS);
    this.limpeza.unref?.();
  }

  onModuleDestroy() {
    if (this.limpeza) clearInterval(this.limpeza);
  }

  async removerAntigos(): Promise<number> {
    const limite = new Date(Date.now() - RETENCAO_DIAS * 86_400_000);
    const { count } = await this.prisma.passageCount.deleteMany({ where: { minuteStart: { lt: limite } } });
    if (count) this.logger.log(`contagem: ${count} minutos com mais de ${RETENCAO_DIAS} dias removidos`);
    return count;
  }

  /** Lote da IA: grava os totais por minuto com SET (reenvio não duplica). */
  async ingest(cameraId: string, body: unknown) {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { id: true, detectionZones: true } });
    if (!camera) throw new NotFoundException('Câmera não encontrada.');
    let lote;
    try {
      lote = validarLote(body, linhasDeContagem(camera.detectionZones));
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Lote inválido.');
    }
    if (!lote.baldes.length) return { stored: 0 };
    const linhas = lote.baldes.map((b) => Prisma.sql`(
      ${randomUUID()}, ${cameraId}, ${b.lineId}, ${b.lineName}, ${b.classLabel}, ${b.direction},
      ${b.minuteStart}, ${lote.session}, ${b.count}, NOW()
    )`);
    await this.prisma.$executeRaw`
      INSERT INTO "PassageCount" ("id", "cameraId", "lineId", "lineName", "classLabel", "direction", "minuteStart", "session", "count", "updatedAt")
      VALUES ${Prisma.join(linhas)}
      ON CONFLICT ("cameraId", "lineId", "classLabel", "direction", "minuteStart", "session")
      DO UPDATE SET "count" = GREATEST("PassageCount"."count", EXCLUDED."count"), "lineName" = EXCLUDED."lineName", "updatedAt" = NOW()`;
    return { stored: lote.baldes.length };
  }

  private async cameraIdsDe(user: AuthUser): Promise<string[]> {
    // Contagem é histórico: mesma régua da linha do tempo histórica (playback).
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.accessControl.getAccessibleCameraIds(user);
    }
    return this.accessControl.getPlaybackCameraIds(user);
  }

  /** Linhas de contagem configuradas nas câmeras que o usuário pode ver. */
  async lines(user: AuthUser) {
    const ids = await this.cameraIdsDe(user);
    if (!ids.length) return [];
    const cameras = await this.prisma.camera.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, detectionZones: true, countingFps: true, enabled: true, aiEnabled: true, group: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    const configured = cameras.flatMap((c) => linhasDeContagem(c.detectionZones).map((l) => ({
      cameraId: c.id,
      cameraName: c.name,
      groupId: c.group?.id ?? null,
      groupName: c.group?.name ?? null,
      lineId: l.id,
      lineName: l.name,
      classes: l.classes,
      fps: c.countingFps ?? 8,
      active: true,
      enabled: c.enabled && c.aiEnabled,
    })));
    const keys = new Set(configured.map(l => JSON.stringify([l.cameraId, l.lineId])));
    const historical = await this.prisma.$queryRaw<Array<{ cameraId: string; lineId: string; lineName: string; classes: string[] }>>`
      SELECT "cameraId", "lineId", MAX("lineName") AS "lineName", array_agg(DISTINCT "classLabel") AS classes
      FROM "PassageCount" WHERE "cameraId" IN (${Prisma.join(ids)}) GROUP BY "cameraId", "lineId"`;
    for (const h of historical) {
      if (keys.has(JSON.stringify([h.cameraId, h.lineId]))) continue;
      const camera = cameras.find(c => c.id === h.cameraId);
      if (!camera) continue;
      configured.push({ ...h, cameraName: camera.name, groupId: camera.group?.id ?? null,
        groupName: camera.group?.name ?? null, fps: camera.countingFps ?? 8, active: false, enabled: false });
    }
    return configured;
  }

  async report(user: AuthUser, q: { from?: string; to?: string; groupBy?: string; cameraId?: string; lineId?: string; kind?: string }) {
    let consulta;
    let kind;
    try {
      consulta = validarConsulta(q);
      kind = validarTipoDeContagem(q.kind);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Consulta inválida.');
    }
    let ids = await this.cameraIdsDe(user);
    if (q.cameraId) ids = ids.includes(q.cameraId) ? [q.cameraId] : [];
    if (!ids.length) return { groupBy: consulta.groupBy, from: consulta.from, to: consulta.to, series: [], totals: { in: 0, out: 0 } };
    const unidade = consulta.groupBy === 'day' ? 'day' : 'hour';
    const filtroLinha = q.lineId ? Prisma.sql`AND "lineId" = ${q.lineId}` : Prisma.empty;
    const filtroClasse = kind === 'person' ? Prisma.sql`AND "classLabel" = 'person'`
      : kind === 'vehicle' ? Prisma.sql`AND "classLabel" IN ('car', 'motorcycle', 'bicycle', 'bus', 'truck')` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ bucket: string; cameraId: string; lineId: string; lineName: string; entradas: bigint; saidas: bigint }>>`
      SELECT to_char(date_trunc(${unidade}, ("minuteStart" AT TIME ZONE 'UTC') AT TIME ZONE ${FUSO}), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             "cameraId", "lineId", MAX("lineName") AS "lineName",
             COALESCE(SUM("count") FILTER (WHERE "direction" = 'in'), 0) AS entradas,
             COALESCE(SUM("count") FILTER (WHERE "direction" = 'out'), 0) AS saidas
        FROM "PassageCount"
       WHERE "cameraId" IN (${Prisma.join(ids)})
         AND "minuteStart" >= ${consulta.from} AND "minuteStart" < ${consulta.to}
         ${filtroLinha}
         ${filtroClasse}
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`;
    const series = rows.map((r) => ({
      bucket: r.bucket,
      cameraId: r.cameraId,
      lineId: r.lineId,
      lineName: r.lineName,
      in: Number(r.entradas),
      out: Number(r.saidas),
    }));
    const totals = series.reduce((t, s) => ({ in: t.in + s.in, out: t.out + s.out }), { in: 0, out: 0 });
    return { groupBy: consulta.groupBy, from: consulta.from, to: consulta.to, timezone: FUSO, series, totals };
  }
}
