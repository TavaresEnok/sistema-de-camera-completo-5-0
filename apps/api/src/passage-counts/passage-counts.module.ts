import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { PassageCountsController } from './passage-counts.controller';
import { PassageCountsService } from './passage-counts.service';

@Module({
  imports: [PrismaModule, AccessControlModule],
  controllers: [PassageCountsController],
  providers: [PassageCountsService],
})
export class PassageCountsModule {}
