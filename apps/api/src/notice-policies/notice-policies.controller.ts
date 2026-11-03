import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AccessControlService } from '../access-control/access-control.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { NoticePoliciesService } from './notice-policies.service';

@Controller('notice-policies')
export class NoticePoliciesController {
  constructor(private readonly policies:NoticePoliciesService,private readonly access:AccessControlService) {}
  @Roles(UserRole.VIEWER)
  @Get()
  async states(@CurrentUser() user:AuthUser){return {states:await this.policies.snapshot(await this.access.getAccessibleCameraIds(user))};}
  @Roles(UserRole.VIEWER)
  @Get('camera/:id')
  async camera(@CurrentUser() user:AuthUser,@Param('id')id:string){await this.access.assertCanViewCamera(user,id);return this.policies.get('camera',id);}
  @Roles(UserRole.OPERATOR)
  @RequirePermission('cameraConfig')
  @Patch('camera/:id')
  async saveCamera(@CurrentUser() user:AuthUser,@Param('id')id:string,@Body()body:unknown){await this.access.assertCanAdminCamera(user,id);return this.policies.save('camera',id,body,user.id);}
  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Get('group/:id')
  group(@Param('id')id:string){return this.policies.get('group',id);}
  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Patch('group/:id')
  saveGroup(@CurrentUser()user:AuthUser,@Param('id')id:string,@Body()body:unknown){return this.policies.save('group',id,body,user.id);}
}
