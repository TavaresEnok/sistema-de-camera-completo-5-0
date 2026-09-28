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
    await this.ensureExists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.camera.updateMany({ where: { groupId: id }, data: { groupId: null } });
      return tx.cameraGroup.update({ where: { id }, data: { isActive: false }, include: { cameras: { select: cameraSummary } } });
    });
  }

  async setAlarmsForGroup(groupId: string, enabled: boolean) {
    await this.ensureExists(groupId);
    const result = await this.prisma.camera.updateMany({
      where: { groupId, isPrivate: false },
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

  async addCamera(groupId: string, cameraId: string, expectedGroupId?: string | null) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Grupo não encontrado.');

    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw new NotFoundException('Câmera não encontrada.');

    if (!group.isActive) throw new NotFoundException('Grupo não encontrado.');
    if (camera.isPrivate) throw new ConflictException('Câmeras particulares não podem ser transferidas para grupos.');
    if (camera.groupId && camera.groupId !== groupId && expectedGroupId !== camera.groupId) {
      throw new ConflictException('Esta câmera já pertence a outro grupo. Confirme a transferência.');
    }
    const changed = await this.prisma.camera.updateMany({ where: { id: cameraId, groupId: camera.groupId }, data: { groupId } });
    if (changed.count !== 1) throw new ConflictException('O grupo da câmera mudou. Atualize a página e tente novamente.');
    return this.prisma.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: { select: cameraSummary } } });
  }

  async removeCamera(groupId: string, cameraId: string) {
    const group = await this.prisma.cameraGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Grupo não encontrado.');

    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw new NotFoundException('Câmera não encontrada.');

    if (camera.groupId !== groupId) {
      throw new NotFoundException('Câmera não pertence ao grupo informado.');
    }

    const changed = await this.prisma.camera.updateMany({ where: { id: cameraId, groupId }, data: { groupId: null } });
    if (changed.count !== 1) throw new ConflictException('O grupo da câmera mudou. Atualize a página e tente novamente.');
    return this.prisma.cameraGroup.findUnique({ where: { id: groupId }, include: { cameras: { select: cameraSummary } } });
  }
}
