import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { NoticePoliciesService } from './notice-policies.service';
import { NoticePoliciesController } from './notice-policies.controller';
@Module({imports:[PrismaModule,AccessControlModule],providers:[NoticePoliciesService],controllers:[NoticePoliciesController],exports:[NoticePoliciesService]})
export class NoticePoliciesModule {}
