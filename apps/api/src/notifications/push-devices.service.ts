import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';

@Injectable()
export class PushDevicesService {
  private readonly logger = new Logger(PushDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  /** Registra (ou revalida) um token de push para o usuário. Idempotente. */
  async register(userId: string, token: string, platform?: string, deviceName?: string) {
    const now = new Date();
    // Um token pertence a UM aparelho; se ele reaparecer para outro usuário
    // (troca de login no mesmo device), migra o token para o usuário atual.
    await this.prisma.pushDevice.upsert({
      where: { token },
      create: { userId, token, platform: platform ?? null, deviceName: deviceName ?? null, lastSeenAt: now },
      update: { userId, platform: platform ?? undefined, deviceName: deviceName ?? undefined, lastSeenAt: now },
    });
    return { ok: true };
  }

  /** Remove um token (logout / permissão revogada no aparelho). */
  async unregister(userId: string, token: string) {
    await this.prisma.pushDevice.deleteMany({ where: { token, userId } });
    return { ok: true };
  }

  /** Remove tokens que o Expo reportou como inválidos (aparelho desregistrado). */
  async pruneInvalid(tokens: string[]) {
    if (!tokens.length) return;
    await this.prisma.pushDevice.deleteMany({ where: { token: { in: tokens } } });
    this.logger.log(`Removidos ${tokens.length} token(s) de push inválidos.`);
  }

  /**
   * Tokens de push de TODOS os usuários que podem VER a câmera:
   *  - SUPER_ADMIN / ADMIN veem todas;
   *  - demais: permissão direta na câmera OU no grupo dela.
   * Espelha o AccessControlService (sentido inverso: câmera → usuários).
   */
  async getTokensForCamera(cameraId: string | null | undefined): Promise<string[]> {
    if (!cameraId) {
      // Alarme sem câmera (ex.: saúde do sistema): só privilegiados.
      return this.tokensForPrivileged();
    }
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { groupId: true, ownerUserId: true },
    });

    const [privileged, perms] = await Promise.all([
      this.prisma.user.findMany({
        where: { isActive: true, role: { in: [UserRole.SUPER_ADMIN, UserRole.ADMIN] } },
        select: { id: true },
      }),
      this.prisma.cameraPermission.findMany({
        where: {
          OR: [{ cameraId }, ...(camera?.groupId ? [{ groupId: camera.groupId }] : [])],
        },
        select: { userId: true },
      }),
    ]);

    if (camera?.ownerUserId) privileged.push({ id: camera.ownerUserId });
    const candidateIds = Array.from(
      new Set([...privileged.map((u) => u.id), ...perms.map((p) => p.userId)]),
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: candidateIds }, isActive: true },
      select: { id: true, username: true, email: true, name: true, role: true },
    });
    const decisions = await Promise.all(users.map(async (user) => ({
      id: user.id,
      allowed: await this.accessControl.canViewCamera({ ...user, email: user.email ?? user.username }, cameraId),
    })));
    const userIds = decisions.filter((item) => item.allowed).map((item) => item.id);
    // Remove quem silenciou as notificações DESTA câmera (mute por usuário).
    const muted = await this.prisma.notificationMute.findMany({
      where: { cameraId, userId: { in: userIds } },
      select: { userId: true },
    });
    const mutedSet = new Set(muted.map((m) => m.userId));
    return this.tokensForUsers(userIds.filter((id) => !mutedSet.has(id)));
  }

  /** Este usuário silenciou as notificações desta câmera? */
  async isMuted(userId: string, cameraId: string): Promise<boolean> {
    const row = await this.prisma.notificationMute.findUnique({
      where: { userId_cameraId: { userId, cameraId } },
      select: { id: true },
    });
    return Boolean(row);
  }

  /** Liga/desliga o silenciamento de notificações desta câmera p/ o usuário. */
  async setMute(userId: string, cameraId: string, muted: boolean): Promise<{ muted: boolean }> {
    if (muted) {
      await this.prisma.notificationMute.upsert({
        where: { userId_cameraId: { userId, cameraId } },
        create: { userId, cameraId },
        update: {},
      });
    } else {
      await this.prisma.notificationMute.deleteMany({ where: { userId, cameraId } });
    }
    return { muted };
  }

  private async tokensForPrivileged(): Promise<string[]> {
    const privileged = await this.prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.SUPER_ADMIN, UserRole.ADMIN] } },
      select: { id: true },
    });
    return this.tokensForUsers(privileged.map((u) => u.id));
  }

  /**
   * Aparelhos de uma lista de usuários.
   *
   * Público porque o alerta de pânico do grupo precisa disto: lá o
   * destinatário é a PESSOA (todos do condomínio), não a câmera. O silenciar
   * por câmera não se aplica — silenciar movimento de rotina não pode silenciar
   * um pedido de socorro de vizinho.
   */
  async tokensDeUsuarios(userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    return this.tokensForUsers(userIds);
  }

  private async tokensForUsers(userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const devices = await this.prisma.pushDevice.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    return devices.map((d) => d.token);
  }
}
