import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user.type';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ServiceTokenGuard } from '../auth/guards/service-token.guard';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { PersonPatternsService } from './person-patterns.service';

@Controller('review')
export class PersonPatternsController {
  constructor(private readonly patterns: PersonPatternsService) {}

  @Public() @UseGuards(ServiceTokenGuard) @Get('internal/person-patterns')
  active() { return this.patterns.active(); }

  @Public() @UseGuards(ServiceTokenGuard) @Post('internal/person-example')
  capture(@Body() body: Record<string, unknown>) { return this.patterns.capture(body); }

  @Roles(UserRole.OPERATOR) @RequirePermission('playback') @Get('cameras/:camera/person-patterns')
  list(@CurrentUser() user: AuthUser, @Param('camera') camera: string) { return this.patterns.list(user,camera); }

  @Roles(UserRole.OPERATOR) @RequirePermission('playback') @Post('cameras/:camera/person-patterns/:id/report')
  report(@CurrentUser() user: AuthUser,@Param('camera') camera: string,@Param('id') id: string) {
    return this.patterns.report(user,camera,id);
  }

  @Roles(UserRole.OPERATOR) @RequirePermission('playback') @Get('cameras/:camera/person-patterns/:id/preview')
  preview(@CurrentUser() user: AuthUser,@Param('camera') camera: string,@Param('id') id: string) {
    return this.patterns.preview(user,camera,id);
  }

  @Roles(UserRole.ADMIN) @RequirePermission('cameraConfig') @Post('cameras/:camera/person-patterns/:id/enable')
  enable(@CurrentUser() user: AuthUser,@Param('camera') camera: string,@Param('id') id: string) {
    return this.patterns.change(user,camera,id,true);
  }

  @Roles(UserRole.ADMIN) @RequirePermission('cameraConfig') @Delete('cameras/:camera/person-patterns/:id')
  remove(@CurrentUser() user: AuthUser,@Param('camera') camera: string,@Param('id') id: string) {
    return this.patterns.change(user,camera,id,false);
  }
}
