import { Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { timingSafeTextEquals } from '../common/security/timing-safe.helper';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';

@Injectable()
export class PushDevicesService {
  private readonly logger = new Logger(PushDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    @Optional() private readonly config?: ConfigService,
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
    // Capacidade restrita a remover ESTE cadastro, sem guardar login após sair.
    const secret = this.config?.get<string>('jwtSecret');
    const payload = Buffer.from(JSON.stringify({ userId, token, registeredAt: now.toISOString() })).toString('base64url');
    const revocationReceipt = secret ? `${payload}.${this.signReceipt(payload, secret)}` : undefined;
    return { ok: true, revocationReceipt };
  }

  private signReceipt(payload: string, secret: string) {
    return createHmac('sha256', secret).update(`push-unregister:${payload}`).digest('base64url');
  }

  async revokeReceipt(receipt: string) {
    const secret = this.config?.get<string>('jwtSecret');
    if (!secret || typeof receipt !== 'string' || receipt.length > 12000) throw new UnauthorizedException();
    const [payload, signature, extra] = receipt.split('.');
    if (!payload || !signature || extra || !timingSafeTextEquals(signature, this.signReceipt(payload, secret))) throw new UnauthorizedException();
    let data: { userId: string; token: string; registeredAt: string };
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new UnauthorizedException(); }
    const timestamp = new Date(data.registeredAt).getTime();
    if (typeof data.userId !== 'string' || typeof data.token !== 'string' || !Number.isFinite(timestamp)) throw new UnauthorizedException();
    // Um recibo anterior não remove um novo registro/uma conta diferente.
    await this.prisma.pushDevice.deleteMany({ where: { userId: data.userId, token: data.token, lastSeenAt: new Date(timestamp) } });
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
      where: { userId: { in: userIds }, lastSeenAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      select: { token: true },
    });
    return devices.map((d) => d.token);
  }
}
