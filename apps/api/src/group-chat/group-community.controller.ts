import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { GroupChatService } from './group-chat.service';

@Controller('group-community')
@UseGuards(JwtAuthGuard)
export class GroupCommunityController {
  constructor(private readonly chat: GroupChatService) {}

  @Get()
  async listar(@CurrentUser() user: AuthUser) {
    return { items: await this.chat.listarGrupos(user) };
  }
}
