import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ServiceTokenGuard } from '../auth/guards/service-token.guard';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { PassageCountsService } from './passage-counts.service';

@Controller('passage-counts')
export class PassageCountsController {
  constructor(private readonly service: PassageCountsService) {}

  /** Lote da IA (token interno de serviço). */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('internal/:cameraId')
  ingest(@Param('cameraId') cameraId: string, @Body() body: unknown) {
    return this.service.ingest(cameraId, body);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('lines')
  lines(@CurrentUser() user: AuthUser) {
    return this.service.lines(user);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get()
  report(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
    @Query('cameraId') cameraId?: string,
    @Query('lineId') lineId?: string,
  ) {
    return this.service.report(user, { from, to, groupBy, cameraId, lineId });
  }
}
