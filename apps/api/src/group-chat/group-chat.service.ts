import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PushService } from '../notifications/push.service';
import { PushDevicesService } from '../notifications/push-devices.service';
import { AuditService } from '../audit/audit.service';
import { UserRole } from '@prisma/client';
import { type AuthUser } from '../common/types/auth-user.type';
import {
  DIAS_DE_CONVERSA_PADRAO,
  destinatariosDoAlerta,
  limparTexto,
  podeDispararAlerta,
  quandoExpira,
  textoDoAlerta,
} from './helpers/alerta-de-panico.helper';

/**
 * A CONVERSA DO GRUPO E O BOTÃO DE PÂNICO.
 *
 * Pedido em 25/08/2026, e as duas coisas foram feitas juntas de propósito:
 * alerta sem conversa é beco sem saída (dez pessoas recebem "atenção na câmera
 * 3" e ninguém consegue dizer "já vi, é o entregador"), e conversa sem alerta
 * ninguém abre. O alerta É uma mensagem marcada na mesma conversa.
 *
 * A REGRA DE ACESSO É A MESMA DAS CÂMERAS. Quem participa da conversa de um
 * grupo é quem tem permissão naquele grupo — nada de lista de participantes
 * separada, que divergiria da permissão real no primeiro ajuste e deixaria
 * ex-morador lendo o que se passa no condomínio.
 */
@Injectable()
export class GroupChatService {
  private readonly logger = new Logger(GroupChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly pushDevices: PushDevicesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Os usuários que participam deste grupo.
   *
   * Administrador entra em todos: ele já vê todas as câmeras, e num alerta é
   * exatamente quem precisa saber.
   */
  private async membrosDoGrupo(groupId: string) {
    const permissoes = await this.prisma.cameraPermission.findMany({
      where: { groupId },
      select: { userId: true },
    });
    const admins = await this.prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] } },
      select: { id: true },
    });
    return [...new Set([...permissoes.map((p) => p.userId), ...admins.map((a) => a.id)])];
  }

  /** Quem não participa não lê nem escreve. */
  private async exigirParticipacao(groupId: string, user: AuthUser) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) return;
    const tem = await this.prisma.cameraPermission.findFirst({
      where: { groupId, userId: user.id },
      select: { id: true },
    });
    if (!tem) throw new ForbiddenException('Você não participa deste grupo.');
  }

  async listar(groupId: string, user: AuthUser, limite = 100) {
    await this.exigirParticipacao(groupId, user);
    // Mensagem vencida não aparece nem que a varredura ainda não tenha passado:
    // o prazo prometido ao usuário vale a partir do relógio, não da faxina.
    return this.prisma.groupMessage.findMany({
      where: { groupId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limite)),
      include: {
        user: { select: { id: true, name: true } },
        camera: { select: { id: true, name: true } },
      },
    });
  }

  async enviarTexto(groupId: string, user: AuthUser, texto: string) {
    await this.exigirParticipacao(groupId, user);
    const body = limparTexto(texto);
    if (!body) throw new BadRequestException('Mensagem vazia.');
    const agora = new Date();
    return this.prisma.groupMessage.create({
      data: {
        groupId,
        userId: user.id,
        kind: 'TEXT',
        body,
        expiresAt: quandoExpira(agora, await this.diasDaConversa()),
      },
    });
  }

  /**
   * O BOTÃO DE PÂNICO.
   *
   * Grava a mensagem SEMPRE, mesmo quando o freio impede o push. O histórico
   * precisa ser honesto sobre quantas vezes foi pedido socorro — e um segundo
   * pedido em menos de um minuto é informação, não ruído.
   */
  async dispararAlerta(groupId: string, user: AuthUser, entrada: { cameraId?: string; texto?: string }) {
    await this.exigirParticipacao(groupId, user);

    const grupo = await this.prisma.cameraGroup.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });
    if (!grupo) throw new BadRequestException('Grupo não encontrado.');

    let camera: { id: string; name: string } | null = null;
    if (entrada.cameraId) {
      camera = await this.prisma.camera.findFirst({
        where: { id: entrada.cameraId, groups: { some: { id: groupId } } },
        select: { id: true, name: true },
      });
      // Câmera de OUTRO grupo não entra: seria vazar o nome dela para quem não
      // tem acesso a ela.
      if (!camera) throw new BadRequestException('Câmera não pertence a este grupo.');
    }

    const ultimo = await this.prisma.groupMessage.findFirst({
      where: { groupId, kind: 'ALERT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const freio = podeDispararAlerta(ultimo ? ultimo.createdAt.getTime() : null, Date.now());

    const agora = new Date();
    const quem = await this.prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
    const nome = quem?.name || 'Alguém';
    const corpo = limparTexto(entrada.texto) || `${nome} pediu atenção${camera ? ` — ${camera.name}` : ''}.`;

    const mensagem = await this.prisma.groupMessage.create({
      data: {
        groupId,
        userId: user.id,
        kind: 'ALERT',
        body: corpo,
        cameraId: camera?.id ?? null,
        expiresAt: quandoExpira(agora, await this.diasDaConversa()),
      },
    });

    if (!freio.pode) {
      this.logger.log(`Alerta em ${grupo.name} registrado SEM push (freio: faltam ${freio.faltamSegundos}s).`);
      // Registra IGUAL: repetição do botão é justamente o que interessa
      // investigar depois.
      await this.registrarNaAuditoria(grupo, camera, user, nome, corpo, false, 0);
      return { mensagem, enviadoPara: 0, freio };
    }

    const membros = await this.membrosDoGrupo(groupId);
    // O AUTOR sai da lista antes de buscar aparelho: receber o próprio alerta
    // assusta sem informar, e num botão de pânico o susto extra é o que menos
    // falta.
    const outros = membros.filter((id) => id !== user.id);
    const tokens = await this.pushDevices.tokensDeUsuarios(outros).catch(() => [] as string[]);
    const comAparelho = [
      { userId: user.id, ehAutor: true, tokens: [] as string[] },
      ...outros.map((userId) => ({ userId, ehAutor: false, tokens: [] as string[] })),
    ];
    // `destinatariosDoAlerta` continua sendo a regra: aqui só juntamos os
    // aparelhos que o serviço de push devolveu para o conjunto dos outros.
    if (comAparelho.length > 1) comAparelho[1].tokens = tokens;
    const destino = destinatariosDoAlerta(comAparelho);
    const texto = textoDoAlerta({ nomeDoGrupo: grupo.name, nomeDeQuemChamou: nome, nomeDaCamera: camera?.name });

    if (destino.tokens.length) {
      await this.push.sendToTokens(destino.tokens, {
        ...texto,
        // Canal PRÓPRIO: o alerta de pânico vibra três vezes e não pode ser
        // confundido com alarme de movimento, que é rotina.
        channelId: 'panico',
        priority: 'high',
        data: {
          tipo: 'alerta-de-grupo',
          groupId,
          grupoNome: grupo.name,
          cameraId: camera?.id ?? null,
          cameraNome: camera?.name ?? null,
          mensagemId: mensagem.id,
          // QUEM disparou, para o app mostrar sem precisar abrir a conversa —
          // e para o morador saber na hora se foi vizinho conhecido.
          autorId: user.id,
          autorNome: nome,
        },
      }).catch((e) => this.logger.error(`Falha ao enviar alerta: ${e?.message ?? e}`));
    }

    this.logger.warn(
      `ALERTA em ${grupo.name} por ${nome}${camera ? ` (${camera.name})` : ''}: `
      + `${destino.alcancados} avisados, ${destino.semAparelho} sem aparelho.`,
    );
    await this.registrarNaAuditoria(grupo, camera, user, nome, corpo, freio.pode, destino.alcancados);
    return { mensagem, enviadoPara: destino.alcancados, semAparelho: destino.semAparelho, freio };
  }

  /**
   * O RASTRO PERMANENTE de quem disparou o alerta.
   *
   * "seria bom também indicar qual usuário emitiu o alerta, para saber se tem
   *  alguém fazendo bagunça em algo sério" (dono, 25/08/2026)
   *
   * A mensagem da conversa some em 3 dias — e levaria junto o registro de quem
   * apertou. Quem estivesse abusando do botão seria descoberto depois de a
   * prova se apagar sozinha.
   *
   * A auditoria tem retenção própria, bem maior, e guarda também o IP e o
   * aparelho. É onde se apura repetição: dez alertas de um mesmo morador numa
   * semana aparecem aqui mesmo depois de a conversa esvaziar.
   */
  private async registrarNaAuditoria(
    grupo: { id: string; name: string },
    camera: { id: string; name: string } | null,
    user: AuthUser,
    nome: string,
    corpo: string,
    houvePush: boolean,
    alcancados: number,
  ) {
    await this.audit
      .log(user.id, 'group.panic_alert', 'CameraGroup', grupo.id, {
        grupo: grupo.name,
        autor: nome,
        camera: camera?.name ?? null,
        mensagem: corpo,
        // Distingue o alerta que TOCOU o aparelho de todos do que foi contido
        // pelo freio — repetição contida é o sinal de abuso.
        houvePush,
        alcancados,
      } as never)
      .catch((e) => this.logger.error(`Falha ao registrar o alerta na auditoria: ${e?.message ?? e}`));
  }

  /** Dias que a conversa guarda. Configurável, com o padrão pedido pelo dono. */
  private async diasDaConversa(): Promise<number> {
    const cfg = await this.prisma.systemSetting
      .findUnique({ where: { key: 'groupChatRetentionDays' } })
      .catch(() => null);
    return cfg?.value ? Number(cfg.value) : DIAS_DE_CONVERSA_PADRAO;
  }

  /** Faxina das vencidas. Chamada por rotina; nunca apaga o que ainda vale. */
  async limparVencidas() {
    const r = await this.prisma.groupMessage.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    if (r.count) this.logger.log(`Conversa de grupo: ${r.count} mensagem(ns) vencida(s) removida(s).`);
    return r.count;
  }
}
