import { Module } from '@nestjs/common';
import { GroupChatService } from './group-chat.service';
import { GroupChatController } from './group-chat.controller';
import { GroupCommunityController } from './group-community.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [NotificationsModule, AuditModule],
  controllers: [GroupChatController, GroupCommunityController],
  providers: [GroupChatService],
  exports: [GroupChatService],
})
export class GroupChatModule {}
