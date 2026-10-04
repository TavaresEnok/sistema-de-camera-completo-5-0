import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user.type';
import { AccessControlService } from '../access-control/access-control.service';
import { CreateCameraGroupDto } from './dto/create-camera-group.dto';
import { UpdateCameraGroupDto } from './dto/update-camera-group.dto';

// Respostas de grupos nunca são uma segunda API de configuração de câmeras.
const cameraSummary = { id: true, name: true, groupId: true, retentionDays: true, retentionFollowsGroup: true } as const;

@Injectable()
export class CameraGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControlService: AccessControlService,
  ) {}

  async list(user: AuthUser) {
    const cameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    const includeCameras = { cameras: { where: { id: { in: cameraIds } }, select: cameraSummary } };
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.prisma.cameraGroup.findMany({ where: { isActive: true }, include: includeCameras, orderBy: { name: 'asc' } });
    }

    return this.prisma.cameraGroup.findMany({
      where: { cameras: { some: { id: { in: cameraIds } } }, isActive: true },
      include: includeCameras,
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string, user: AuthUser) {
    const cameraIds = new Set(await this.accessControlService.getAccessibleCameraIds(user));
    const group = await this.prisma.cameraGroup.findUnique({ where: { id }, include: { cameras: { where: { id: { in: [...cameraIds] } }, select: cameraSummary } } });
    if (!group) {
      throw new NotFoundException('Grupo não encontrado.');
    }
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return group;
    }

    if (!group.isActive || !group.cameras.some((camera) => cameraIds.has(camera.id))) {
      throw new NotFoundException('Grupo não encontrado.');
    }

    return group;
  }

  private async ensureExists(id: string) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id } });
    if (!group) {
      throw new NotFoundException('Grupo não encontrado.');
    }
    return group;
  }

  create(dto: CreateCameraGroupDto) {
    return this.prisma.cameraGroup.create({ data: dto, include: { cameras: { select: cameraSummary } } });
  }

  async update(id: string, dto: UpdateCameraGroupDto) {
    await this.ensureExists(id);
    return this.prisma.cameraGroup.update({ where: { id }, data: dto, include: { cameras: { select: cameraSummary } } });
  }

  async softDelete(id: string) {
    const group = await this.ensureExists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CameraGroup" WHERE "id" = ${id} FOR UPDATE`;
      await tx.camera.updateMany({ where: { groupId: id, retentionFollowsGroup: true }, data: { retentionDays: group.retentionDays, retentionFollowsGroup: false } });
      await tx.camera.updateMany({ where: { groupId: id }, data: { groupId: null } });
      return tx.cameraGroup.update({ where: { id }, data: { isActive: false, cameras: { set: [] } }, include: { cameras: { select: cameraSummary } } });
    });
  }

  async setAlarmsForGroup(groupId: string, enabled: boolean) {
    await this.ensureExists(groupId);
    const result = await this.prisma.camera.updateMany({
      where: { groups: { some: { id: groupId } }, isPrivate: false },
      data: { alarmsEnabled: enabled },
    });
    return { groupId, enabled, affected: result.count };
  }

  /**
   * Define a retenção (dias) de TODAS as câmeras do grupo de uma vez. Isto
   * SOBRESCREVE o valor individual de cada câmera — a UI avisa antes de aplicar.
   */
  async setRetentionForGroup(groupId: string, retentionDays: number, seguidores?: string[]) {
    await this.ensureExists(groupId);
    // Grava no GRUPO, não em cada câmera.
    //
    // Antes isto era um `updateMany` sobre `Camera`: aplicar a retenção do grupo
    // APAGAVA o número individual de todas elas. As exceções ajustadas à mão se
    // perdiam a cada mexida no grupo, sem volta — e o operador só descobria
    // quando o acervo de uma câmera específica encurtava sozinho.
    //
    // Agora o grupo guarda a política e cada câmera decide se a segue. Quem
    // segue passa a valer o número novo na hora; quem é exceção não é tocada.
    await this.prisma.cameraGroup.update({
      where: { id: groupId },
      data: { retentionDays },
    });

    // QUEM SEGUE, definido na mesma ação.
    //
    // Sem isto, escolher os seguidores exigia abrir câmera por câmera — e a tela
    // onde se define a política do grupo era justamente a única que não deixava
    // dizer a quem ela se aplica.
    //
    // `undefined` preserva o que está lá (mudar só o prazo não pode religar
    // exceção nenhuma); lista vazia é uma escolha legítima ("ninguém segue").
    if (Array.isArray(seguidores)) {
      const doGrupo = await this.prisma.camera.findMany({ where: { groupId }, select: { id: true } });
      const pedidos = new Set(seguidores);
      const seguem = doGrupo.filter((c) => pedidos.has(c.id)).map((c) => c.id);
      const naoSeguem = doGrupo.filter((c) => !pedidos.has(c.id)).map((c) => c.id);
      // Duas escritas em vez de uma por câmera: N chamadas viram N janelas em que
      // a varredura de retenção pode rodar com o estado pela metade.
      await this.prisma.$transaction([
        this.prisma.camera.updateMany({ where: { id: { in: seguem } }, data: { retentionFollowsGroup: true } }),
        this.prisma.camera.updateMany({ where: { id: { in: naoSeguem } }, data: { retentionFollowsGroup: false } }),
      ]);
    }

    const seguindo = await this.prisma.camera.count({ where: { groupId, retentionFollowsGroup: true } });
    const excecoes = await this.prisma.camera.count({ where: { groupId, retentionFollowsGroup: false } });
    return { groupId, retentionDays, affected: seguindo, excecoes };
  }

  async addCamera(groupId: string, cameraId: string, _expectedGroupId?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CameraGroup" WHERE "id" = ${groupId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Camera" WHERE "id" = ${cameraId} FOR UPDATE`;
      const group = await tx.cameraGroup.findUnique({ where: { id: groupId } });
      if (!group?.isActive) throw new NotFoundException('Grupo não encontrado.');
      const camera = await tx.camera.findUnique({ where: { id: cameraId }, include: { groups: { select: { id: true } } } });
      if (!camera) throw new NotFoundException('Câmera não encontrada.');
      if (camera.isPrivate) throw new ConflictException('Câmeras particulares não podem ser adicionadas a grupos.');
      const ids = new Set(camera.groups.map((g) => g.id));
      if (!ids.has(groupId)) {
        if (ids.size >= 4) throw new ConflictException('Esta câmera já está em 4 grupos. Remova-a de um grupo antes de adicionar outro.');
        await tx.camera.update({
          where: { id: cameraId },
          data: { groups: { connect: { id: groupId } }, ...(!camera.groupId ? { groupId } : {}) },
        });
      }
      return tx.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: { select: cameraSummary } } });
    });
  }

  async removeCamera(groupId: string, cameraId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CameraGroup" WHERE "id" = ${groupId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Camera" WHERE "id" = ${cameraId} FOR UPDATE`;
      const group = await tx.cameraGroup.findUnique({ where: { id: groupId } });
      if (!group) throw new NotFoundException('Grupo não encontrado.');
      const camera = await tx.camera.findUnique({ where: { id: cameraId }, include: { groups: { select: { id: true } } } });
      if (!camera) throw new NotFoundException('Câmera não encontrada.');
      if (!camera.groups.some((g) => g.id === groupId)) throw new NotFoundException('Câmera não pertence ao grupo informado.');
      await tx.camera.update({ where: { id: cameraId }, data: {
        groups: { disconnect: { id: groupId } },
        ...(camera.groupId === groupId ? {
          groupId: camera.groups.filter((g) => g.id !== groupId).map((g) => g.id).sort()[0] ?? null,
          // Removing an organizational link must not shorten existing recordings.
          ...(camera.retentionFollowsGroup ? { retentionDays: group.retentionDays, retentionFollowsGroup: false } : {}),
        } : {}),
      } });
      return tx.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: { select: cameraSummary } } });
    });
  }
}
