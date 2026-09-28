import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { AccessControlService } from '../access-control/access-control.service';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { PushDevicesService } from './push-devices.service';
import { RegisterPushDeviceDto, UnregisterPushDeviceDto } from './dto/register-push-device.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly pushDevices: PushDevicesService, private readonly access: AccessControlService) {}

  /** App registra seu token de push (após conceder permissão). Idempotente. */
  @Post('devices')
  async registerDevice(@CurrentUser() user: AuthUser | null, @Body() dto: RegisterPushDeviceDto) {
    if (!user) throw new UnauthorizedException();
    return this.pushDevices.register(user.id, dto.token, dto.platform, dto.deviceName);
  }

  /** App remove o token (logout). */
  @Delete('devices')
  async unregisterDevice(@CurrentUser() user: AuthUser | null, @Body() dto: UnregisterPushDeviceDto) {
    if (!user) throw new UnauthorizedException();
    return this.pushDevices.unregister(user.id, dto.token);
  }

  @Public()
  @Post('devices/revoke')
  async revokeDevice(@Body() body: { receipt?: string }) {
    return this.pushDevices.revokeReceipt(body?.receipt ?? '');
  }

  /** Estado do silenciamento de notificações desta câmera P/ O USUÁRIO atual. */
  @Get('camera/:cameraId/mute')
  async getMute(@CurrentUser() user: AuthUser | null, @Param('cameraId') cameraId: string) {
    if (!user) throw new UnauthorizedException();
    await this.access.assertCanViewCamera(user, cameraId);
    return { muted: await this.pushDevices.isMuted(user.id, cameraId) };
  }

  /** Liga/desliga o silenciamento das notificações desta câmera p/ o usuário. */
  @Post('camera/:cameraId/mute')
  async setMute(
    @CurrentUser() user: AuthUser | null,
    @Param('cameraId') cameraId: string,
    @Body() body: { muted?: boolean },
  ) {
    if (!user) throw new UnauthorizedException();
    await this.access.assertCanViewCamera(user, cameraId);
    if (typeof body?.muted !== 'boolean') throw new BadRequestException('Informe se os avisos devem ser silenciados.');
    return this.pushDevices.setMute(user.id, cameraId, body?.muted !== false);
  }
}
