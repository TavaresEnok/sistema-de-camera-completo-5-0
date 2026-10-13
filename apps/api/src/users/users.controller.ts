import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { type Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AllowInitialPassword } from '../auth/decorators/initial-password.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    private readonly commercialPolicy: CommercialPolicyService,
  ) {}

  @Roles(UserRole.VIEWER)
  @Get()
  list(@CurrentUser() actor: AuthUser) {
    return this.usersService.list(actor);
  }

  @Roles(UserRole.VIEWER)
  @Get(':id')
  getById(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.usersService.getById(id, actor);
  }

  @Roles(UserRole.VIEWER)
  @Post()
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto, @Req() req: Request) {
    await this.commercialPolicy.assertUserQuota(1);
    const user = await this.usersService.create(actor, dto);
    await this.auditService.log(actor.id, 'user.create', 'User', user.id, { role: user.role }, req);
    return user;
  }

  @Roles(UserRole.VIEWER)
  @Patch('me/password')
  @AllowInitialPassword()
  async changeOwnPassword(@CurrentUser() actor: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    const result = await this.usersService.changeOwnPassword(actor, dto);
    await this.auditService.log(actor.id, 'user.password.change_self', 'User', actor.id, undefined, req);
    return result;
  }

  @Roles(UserRole.VIEWER)
  @Patch(':id')
  async update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    if (dto.isActive === true) {
      const current = await this.usersService.getById(id, actor);
      if (!current.isActive) await this.commercialPolicy.assertUserQuota(1);
    }
    const user = await this.usersService.update(actor, id, dto);
    await this.auditService.log(actor.id, 'user.update', 'User', user.id, { role: user.role, isActive: user.isActive }, req);
    return user;
  }

  @Roles(UserRole.VIEWER)
  @Delete(':id')
  async softDelete(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const user = await this.usersService.softDelete(actor, id);
    await this.auditService.log(actor.id, 'user.deactivate', 'User', user.id, undefined, req);
    return user;
  }

  // Exclusão definitiva (diferente do soft-delete acima, que só desativa).
  @Roles(UserRole.OPERATOR)
  @Delete(':id/permanent')
  async hardDelete(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const result = await this.usersService.hardDelete(actor, id);
    await this.auditService.log(actor.id, 'user.delete', 'User', id, undefined, req);
    return result;
  }
}
