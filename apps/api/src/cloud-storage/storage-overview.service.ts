import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { CloudOffloadService } from './cloud-offload.service';
import { diasDoPainel, FUSO_DO_PAINEL, preencherDias } from './cloud-usage.helper';

/**
 * Visão única da página de Armazenamento: disco e nuvem lado a lado, uso por
 * dia (onde cada gravação está agora), e quem mais ocupa — por câmera e por
 * grupo. Funciona com ou sem nuvem configurada e só soma câmeras que o usuário
 * pode assistir (mesma régua do histórico de gravações).
 */
@Injectable()
export class StorageOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    private readonly offload: CloudOffloadService,
  ) {}

  async overview(user: AuthUser, diasPedidos?: unknown) {
    const dias = diasDoPainel(diasPedidos);
    const admin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
    const ids = admin
      ? (await this.prisma.camera.findMany({ select: { id: true } })).map((c) => c.id)
      : await this.accessControl.getPlaybackCameraIds(user);
    const cfg = await this.offload.cloudConfig();
    const policy = cfg ? await this.offload.getPolicy() : null;
    const cloud = cfg
      ? {
        configured: true as const,
        provider: cfg.provider,
        mode: cfg.mode,
        localWindowHours: cfg.localWindowHours,
        // Endereço do fornecedor nunca sai daqui (é da revenda, não do cliente).
        ...(admin ? { bucket: cfg.bucket } : {}),
        policy,
      }
      : null;
    const vazio = {
      days: dias, timezone: FUSO_DO_PAINEL, cloud,
      totals: { diskBytes: 0, cloudBytes: 0, cloudOnlyBytes: 0, cloudCount: 0, pendingBytes: 0, pendingCount: 0, recordings: 0, lastUploadAt: null as string | null },
      daily: preencherDias([], dias, new Date().toISOString().slice(0, 10)).map((d) => ({ day: d.day, diskBytes: 0, cloudBytes: 0 })),
      byCamera: [] as Array<{ cameraId: string; cameraName: string; groupName: string | null; diskBytes: number; cloudBytes: number }>,
      byGroup: [] as Array<{ groupName: string; cameras: number; diskBytes: number; cloudBytes: number }>,
    };
    if (!ids.length) return vazio;
    const filtro = Prisma.sql`r."cameraId" IN (${Prisma.join(ids)})`;
    const n = (v: unknown) => Number(v ?? 0);

    const [t] = await this.prisma.$queryRaw<Array<Record<string, bigint | Date | null>>>`
      SELECT
        COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."localDeletedAt" IS NULL), 0) AS disk,
        COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NOT NULL), 0) AS cloud,
        COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NOT NULL AND r."localDeletedAt" IS NOT NULL), 0) AS "cloudOnly",
        COUNT(*) FILTER (WHERE r."cloudKey" IS NOT NULL) AS "cloudCount",
        COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NULL AND r."localDeletedAt" IS NULL AND r."endedAt" IS NOT NULL), 0) AS pending,
        COUNT(*) FILTER (WHERE r."cloudKey" IS NULL AND r."localDeletedAt" IS NULL AND r."endedAt" IS NOT NULL) AS "pendingCount",
        COUNT(*) AS recordings,
        MAX(r."cloudUploadedAt") AS "lastUploadAt"
      FROM "Recording" r WHERE ${filtro}`;

    const hoje = (await this.prisma.$queryRaw<Array<{ hoje: string }>>`
      SELECT to_char((NOW() AT TIME ZONE ${FUSO_DO_PAINEL})::date, 'YYYY-MM-DD') AS hoje`)[0].hoje;

    // Por dia de GRAVAÇÃO, separado por onde o vídeo está agora: na nuvem
    // (tem cloudKey) ou só no disco. É o que responde "quanto gravei e onde".
    const diarias = await this.prisma.$queryRaw<Array<{ day: string; disk: bigint; cloud: bigint }>>`
      SELECT to_char(((r."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${FUSO_DO_PAINEL})::date, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NULL AND r."localDeletedAt" IS NULL), 0) AS disk,
             COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NOT NULL), 0) AS cloud
        FROM "Recording" r
       WHERE ${filtro} AND r."startedAt" >= NOW() - make_interval(days => ${dias}::int + 1)
       GROUP BY 1`;
    const porDia = new Map(diarias.map((d) => [d.day, d]));
    const daily = preencherDias([], dias, hoje).map((d) => ({
      day: d.day, diskBytes: n(porDia.get(d.day)?.disk), cloudBytes: n(porDia.get(d.day)?.cloud),
    }));

    const porCamera = await this.prisma.$queryRaw<Array<{ cameraId: string; cameraName: string; groupName: string | null; disk: bigint; cloud: bigint }>>`
      SELECT r."cameraId", COALESCE(c.name, r."cameraId") AS "cameraName", g.name AS "groupName",
             COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NULL AND r."localDeletedAt" IS NULL), 0) AS disk,
             COALESCE(SUM(r."sizeBytes") FILTER (WHERE r."cloudKey" IS NOT NULL), 0) AS cloud
        FROM "Recording" r
        LEFT JOIN "Camera" c ON c.id = r."cameraId"
        LEFT JOIN "CameraGroup" g ON g.id = c."groupId"
       WHERE ${filtro}
       GROUP BY 1, 2, 3`;
    const byCamera = porCamera
      .map((c) => ({ cameraId: c.cameraId, cameraName: c.cameraName, groupName: c.groupName, diskBytes: n(c.disk), cloudBytes: n(c.cloud) }))
      .filter((c) => c.diskBytes + c.cloudBytes > 0)
      .sort((a, b) => (b.diskBytes + b.cloudBytes) - (a.diskBytes + a.cloudBytes));
    const grupos = new Map<string, { groupName: string; cameras: number; diskBytes: number; cloudBytes: number }>();
    for (const c of byCamera) {
      const nome = c.groupName ?? 'Sem grupo';
      const g = grupos.get(nome) ?? { groupName: nome, cameras: 0, diskBytes: 0, cloudBytes: 0 };
      g.cameras += 1; g.diskBytes += c.diskBytes; g.cloudBytes += c.cloudBytes;
      grupos.set(nome, g);
    }
    return {
      days: dias, timezone: FUSO_DO_PAINEL, cloud,
      totals: {
        diskBytes: n(t.disk), cloudBytes: n(t.cloud), cloudOnlyBytes: n(t.cloudOnly), cloudCount: n(t.cloudCount),
        pendingBytes: n(t.pending), pendingCount: n(t.pendingCount), recordings: n(t.recordings),
        lastUploadAt: t.lastUploadAt instanceof Date ? t.lastUploadAt.toISOString() : null,
      },
      daily,
      byCamera: byCamera.slice(0, 12),
      byGroup: [...grupos.values()].sort((a, b) => (b.diskBytes + b.cloudBytes) - (a.diskBytes + a.cloudBytes)).slice(0, 12),
    };
  }
}
