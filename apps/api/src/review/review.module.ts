import { PersonPatternsController } from "./person-patterns.controller";
import { PersonPatternsService } from "./person-patterns.service";
import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [PrismaModule, AccessControlModule, RecordingsModule],
  controllers: [ReviewController, PersonPatternsController],
  providers: [ReviewService, PersonPatternsService],
})
export class ReviewModule {}
