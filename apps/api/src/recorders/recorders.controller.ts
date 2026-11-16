import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { type Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { RecordersService } from './recorders.service';
import { CreateRecorderDto, ImportRecorderChannelDto, ImportRecorderChannelsDto, UpdateRecorderDto, LinkRecorderChannelDto } from './recorders.dto';
@Controller('recorders')
@Roles(UserRole.ADMIN)
@RequirePermission('cameraConfig')
export class RecordersController {
  constructor(private readonly service: RecordersService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: CreateRecorderDto, @CurrentUser() user: AuthUser, @Req() req: Request) { return this.service.create(dto, user, req); }
  @Get(':id') detail(@Param('id', ParseUUIDPipe) id: string) { return this.service.detail(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRecorderDto, @CurrentUser() user: AuthUser, @Req() req: Request) { return this.service.update(id, dto, user, req); }
  @Post(':id/link') link(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkRecorderChannelDto, @CurrentUser() user: AuthUser, @Req() req: Request) { return this.service.link(id, dto.cameraId, user, req); }
  @Post(':id/discover') @Throttle({ default: { limit: 3, ttl: 60000 } })
  discover(@Param('id', ParseUUIDPipe) id: string) { return this.service.discover(id); }
  @Post(':id/check') @Throttle({ default: { limit: 6, ttl: 60000 } })
  check(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportRecorderChannelDto, @CurrentUser() user: AuthUser) { return this.service.check(id, dto, user); }
  @Post(':id/import') @Throttle({ default: { limit: 3, ttl: 60000 } })
  import(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportRecorderChannelsDto, @CurrentUser() user: AuthUser, @Req() req: Request) { return this.service.import(id, dto, user, req); }
}
