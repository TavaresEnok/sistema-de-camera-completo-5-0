import { Module } from '@nestjs/common';
import { CamerasModule } from '../cameras/cameras.module';
import { AuditModule } from '../audit/audit.module';
import { CommercialPolicyModule } from '../commercial-policy/commercial-policy.module';
import { RecordersController } from './recorders.controller';
import { RecordersService } from './recorders.service';
@Module({ imports: [CamerasModule, AuditModule, CommercialPolicyModule], controllers: [RecordersController], providers: [RecordersService] })
export class RecordersModule {}
