import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { CreateLiveLayoutDto } from './dto/create-live-layout.dto';
import { UpdateLiveLayoutDto } from './dto/update-live-layout.dto';
import {
  filtrarPosicoes,
  mosaicoTemAlgoAMostrar,
  normalizarDestinatarios,
  origemDe,
  pessoasAlcancadas,
  podeEditar,
  quadrosVisiveis,
  type Destinatarios,
} from './helpers/compartilhamento.helper';

/**
 * MOSAICOS (LiveLayout).
 *
 * Duas leituras da mesma coisa, como o operador espera:
 *   - `list`      = "Meus mosaicos": o que EU posso abrir (meus + os que me deram)
 *   - `listAdmin` = "Mosaicos": o que EU administro (só admin)
 *
 * Entregar é privilégio de administrador. Um operador criar mosaico para si é
 * normal; um operador empurrar mosaico para os colegas não é — viraria bagunça
 * na tela de todo mundo, sem ninguém responsável.
 */
@Injectable()
export class LiveLayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  private ehAdmin(user: AuthUser): boolean {
    return user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN;
  }

  /** Grupos a que a pessoa pertence — entrega para o grupo alcança todos eles. */
  private async gruposDoUsuario(userId: string): Promise<string[]> {
    const perms = await this.prisma.cameraPermission.findMany({
      where: { userId, groupId: { not: null } },
      select: { groupId: true },
      distinct: ['groupId'],
    });
    return perms.map((p) => p.groupId as string);
  }

  /**
   * Mosaicos que chegaram junto com uma RONDA recebida.
   *
   * Sem isto, o administrador entrega a ronda "Madrugada" ao porteiro e ele
   * abre uma volta de paradas vazias, porque os mosaicos de dentro nunca foram
   * entregues separadamente. O direito é DERIVADO: tirar o mosaico da ronda
   * tira o acesso junto, sem sobrar linha órfã no banco.
   */
  private async mosaicosVindosDeRondas(userId: string, grupoIds: string[]): Promise<string[]> {
    const rondas = await this.prisma.ronda.findMany({
      where: {
        active: true,
        OR: [
          { shares: { some: { userId } } },
          ...(grupoIds.length ? [{ shares: { some: { groupId: { in: grupoIds } } } }] : []),
        ],
      },
      select: { paradas: true },
    });
    const ids = new Set<string>();
    for (const r of rondas) {
      const paradas = Array.isArray(r.paradas) ? r.paradas : [];
      for (const p of paradas) {
        const id = String((p as { layoutId?: unknown })?.layoutId ?? '').trim();
        if (id) ids.add(id);
      }
    }
    return [...ids];
  }

  /** Os IDs de mosaico que esta pessoa pode ABRIR (não diz nada sobre câmeras). */
  async idsUtilizaveis(user: AuthUser): Promise<Set<string>> {
    const registros = await this.buscarUtilizaveis(user);
    return new Set(registros.map((l) => l.id));
  }

  private async buscarUtilizaveis(user: AuthUser) {
    const grupoIds = await this.gruposDoUsuario(user.id);
    const porRonda = await this.mosaicosVindosDeRondas(user.id, grupoIds);
    return this.prisma.liveLayout.findMany({
      where: {
        OR: [
          { userId: user.id },
          { active: true, shares: { some: { userId: user.id } } },
          ...(grupoIds.length
            ? [{ active: true, shares: { some: { groupId: { in: grupoIds } } } }]
            : []),
          ...(porRonda.length ? [{ active: true, id: { in: porRonda } }] : []),
        ],
      },
      orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  /**
   * "Meus mosaicos": o que posso abrir, já com as câmeras que não posso ver
   * removidas das posições. Ver a REGRA 1 em compartilhamento.helper.ts.
   */
  async list(user: AuthUser) {
    const [registros, visiveis] = await Promise.all([
      this.buscarUtilizaveis(user),
      this.accessControl.getAccessibleCameraIds(user),
    ]);
    const permitidas = new Set(visiveis);
    const ehAdmin = this.ehAdmin(user);

    const saida = [];
    for (const l of registros) {
      const posicoes = filtrarPosicoes(l.cameraIds, permitidas);
      const meu = origemDe({ donoId: l.userId, usuarioId: user.id });
      // Mosaico recebido do qual não sobrou nenhuma câmera seria só uma tela
      // preta com nome. O meu próprio eu sempre vejo — sumir sozinho da lista
      // pareceria que alguém o apagou.
      if (meu === 'recebido' && !mosaicoTemAlgoAMostrar(posicoes)) continue;
      saida.push({
        id: l.id,
        name: l.name,
        gridSize: l.gridSize,
        cameraIds: posicoes,
        active: l.active,
        showOnMobile: l.showOnMobile,
        origem: meu,
        podeEditar: podeEditar({ donoId: l.userId, usuarioId: user.id, ehAdmin }),
        quadrosComImagem: quadrosVisiveis(posicoes),
        lastUsedAt: l.lastUsedAt,
        updatedAt: l.updatedAt,
      });
    }
    return saida;
  }

  /** "Mosaicos": a tela de administração. Mostra de todo mundo, com contagens. */
  async listAdmin(user: AuthUser) {
    if (!this.ehAdmin(user)) throw new ForbiddenException('Só administradores gerenciam mosaicos.');
    const registros = await this.prisma.liveLayout.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, username: true, email: true } },
        shares: {
          include: {
            user: { select: { id: true, name: true, username: true, email: true } },
            group: { select: { id: true, name: true } },
          },
        },
      },
    });
    return Promise.all(registros.map((l) => this.enfeitarParaAdmin(l)));
  }

  private async enfeitarParaAdmin(l: {
    id: string;
    name: string;
    gridSize: string;
    cameraIds: unknown;
    active: boolean;
    showOnMobile: boolean;
    userId: string;
    updatedAt: Date;
    user: { id: string; name: string; username: string; email: string | null };
    shares: {
      userId: string | null;
      groupId: string | null;
      user: { id: string; name: string; username: string; email: string | null } | null;
      group: { id: string; name: string } | null;
    }[];
  }) {
    const posicoes = (Array.isArray(l.cameraIds) ? l.cameraIds : []).map((v) => String(v ?? '').trim());
    const usuariosDiretos = l.shares.filter((s) => s.userId).map((s) => s.userId as string);
    const grupos = l.shares.filter((s) => s.groupId).map((s) => s.groupId as string);
    const usuariosPorGrupo = grupos.length ? await this.usuariosDosGrupos(grupos) : [];
    return {
      id: l.id,
      name: l.name,
      gridSize: l.gridSize,
      capacidade: posicoes.length,
      cameras: posicoes.filter(Boolean).length,
      active: l.active,
      showOnMobile: l.showOnMobile,
      dono: l.user,
      destinatarios: {
        usuarios: l.shares.filter((s) => s.user).map((s) => s.user),
        grupos: l.shares.filter((s) => s.group).map((s) => s.group as { id: string; name: string }),
      },
      // O número que a lista mostra: gente que de fato recebeu, sem contar o
      // dono duas vezes.
      usuariosAlcancados: pessoasAlcancadas({
        donoId: l.userId,
        usuariosDiretos,
        usuariosPorGrupo,
      }).length,
      updatedAt: l.updatedAt,
    };
  }

  private async usuariosDosGrupos(grupoIds: string[]): Promise<string[]> {
    const perms = await this.prisma.cameraPermission.findMany({
      where: { groupId: { in: grupoIds } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return perms.map((p) => p.userId);
  }

  async create(user: AuthUser, dto: CreateLiveLayoutDto) {
    const destinatarios = await this.destinatariosValidados(user, dto.destinatarios);
    // Repetir a operação offline, inclusive em outra aba, devolve o mesmo layout.
    const hash = dto.clientRequestId ? createHash('sha256').update(`${user.id}:${dto.clientRequestId}`).digest('hex') : null;
    const id = hash ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}` : undefined;
    try {
    const criado = await this.prisma.liveLayout.create({
      data: {
        ...(id ? { id } : {}),
        userId: user.id,
        name: this.normalizeName(dto.name),
        gridSize: dto.gridSize,
        cameraIds: this.normalizeCameraIds(dto.cameraIds) as Prisma.InputJsonValue,
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.showOnMobile !== undefined ? { showOnMobile: dto.showOnMobile } : {}),
        shares: { create: this.linhasDeEntrega(destinatarios) },
      },
    });
    return criado;
    } catch (error) {
      if (id && (error as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.liveLayout.findUnique({ where: { id } });
        if (existing?.userId === user.id) return existing;
      }
      throw error;
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateLiveLayoutDto) {
    const atual = await this.exigirPoderDeEdicao(user, id);
    const trocaEntrega = dto.destinatarios !== undefined;
    const destinatarios = trocaEntrega
      ? await this.destinatariosValidados(user, dto.destinatarios)
      : null;

    return this.prisma.$transaction(async (tx) => {
      if (destinatarios) {
        // Substitui a lista inteira: a tela manda o estado final, não um delta.
        await tx.liveLayoutShare.deleteMany({ where: { layoutId: id } });
        await tx.liveLayoutShare.createMany({
          data: this.linhasDeEntrega(destinatarios).map((l) => ({ ...l, layoutId: id })),
        });
      }
      return tx.liveLayout.update({
        where: { id: atual.id },
        data: {
          ...(dto.name !== undefined ? { name: this.normalizeName(dto.name) } : {}),
          ...(dto.gridSize !== undefined ? { gridSize: dto.gridSize } : {}),
          ...(dto.cameraIds !== undefined
            ? { cameraIds: this.normalizeCameraIds(dto.cameraIds) as Prisma.InputJsonValue }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.showOnMobile !== undefined ? { showOnMobile: dto.showOnMobile } : {}),
          lastUsedAt: new Date(),
        },
      });
    });
  }

  async remove(user: AuthUser, id: string) {
    const atual = await this.exigirPoderDeEdicao(user, id);
    return this.prisma.liveLayout.delete({ where: { id: atual.id } });
  }

  /**
   * Quem recebeu o mosaico USA; não edita e não apaga.
   *
   * O erro é 404 e não 403 de propósito quando o mosaico nem existe — dizer
   * "existe, mas não é seu" já entrega informação de graça.
   */
  private async exigirPoderDeEdicao(user: AuthUser, id: string) {
    const layout = await this.prisma.liveLayout.findUnique({ where: { id } });
    if (!layout) throw new NotFoundException('Mosaico não encontrado.');
    if (!podeEditar({ donoId: layout.userId, usuarioId: user.id, ehAdmin: this.ehAdmin(user) })) {
      throw new ForbiddenException('Este mosaico é de outra pessoa. Você pode usá-lo, não alterá-lo.');
    }
    return layout;
  }

  /**
   * Confere que as pessoas e grupos existem de verdade antes de gravar.
   *
   * ID inventado gravaria uma entrega para ninguém, e a lista mostraria
   * "Usuários: 1" para um destinatário que não existe.
   */
  private async destinatariosValidados(user: AuthUser, bruto: unknown): Promise<Destinatarios> {
    const d = normalizarDestinatarios(bruto);
    if (!d.usuarios.length && !d.grupos.length) return d;
    if (!this.ehAdmin(user)) {
      throw new ForbiddenException('Somente administradores entregam mosaicos a outras pessoas.');
    }
    const [usuarios, grupos] = await Promise.all([
      d.usuarios.length
        ? this.prisma.user.findMany({ where: { id: { in: d.usuarios } }, select: { id: true } })
        : Promise.resolve([]),
      d.grupos.length
        ? this.prisma.cameraGroup.findMany({ where: { id: { in: d.grupos } }, select: { id: true } })
        : Promise.resolve([]),
    ]);
    if (usuarios.length !== d.usuarios.length || grupos.length !== d.grupos.length) {
      throw new BadRequestException('Há destinatário que não existe mais. Recarregue a lista.');
    }
    return d;
  }

  private linhasDeEntrega(d: Destinatarios) {
    return [
      ...d.usuarios.map((userId) => ({ userId, groupId: null as string | null })),
      ...d.grupos.map((groupId) => ({ userId: null as string | null, groupId })),
    ];
  }

  private normalizeName(value: string) {
    const name = value.trim();
    if (!name) throw new BadRequestException('Informe um nome para o layout.');
    return name;
  }

  private normalizeCameraIds(values: string[]) {
    return values.slice(0, 64).map((value) => String(value).trim());
  }
}
