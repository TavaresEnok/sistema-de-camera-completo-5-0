import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { GroupChatService } from './group-chat.service';

/**
 * CONVERSA DO GRUPO E BOTÃO DE PÂNICO.
 *
 * Fica sob `/groups/:id` porque o grupo é o dono da conversa. Quem participa é
 * quem tem permissão no grupo — a mesma regra das câmeras, sem lista paralela
 * de participantes que divergiria no primeiro ajuste.
 */
@Controller('groups/:groupId')
@UseGuards(JwtAuthGuard)
export class GroupChatController {
  constructor(private readonly chat: GroupChatService) {}

  @Get('messages')
  async listar(
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @CurrentUser() user: AuthUser,
    @Query('limite') limite?: string,
  ) {
    const items = await this.chat.listar(groupId, user, Number(limite) || 100);
    return { items };
  }

  @Post('messages')
  async enviar(
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { texto?: string },
  ) {
    return this.chat.enviarTexto(groupId, user, body?.texto ?? '');
  }

  /**
   * O botão de pânico.
   *
   * Devolve quantas pessoas foram alcançadas e quantas não têm aparelho — quem
   * apertou precisa saber se o pedido saiu, e "enviado" sem número não diz nada.
   */
  @Post('alert')
  async alertar(
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { cameraId?: string; texto?: string },
  ) {
    return this.chat.dispararAlerta(groupId, user, {
      cameraId: body?.cameraId,
      texto: body?.texto,
    });
  }
}
