import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';
import { PushDevicesService } from './push-devices.service';
import { AccessControlModule } from '../access-control/access-control.module';

@Module({
  imports: [AccessControlModule],
  controllers: [NotificationsController],
  providers: [PushService, PushDevicesService],
  exports: [PushService, PushDevicesService],
})
export class NotificationsModule {}
