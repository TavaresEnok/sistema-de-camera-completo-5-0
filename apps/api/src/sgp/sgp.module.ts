import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { SgpService } from './sgp.service';
import { SgpAdminController, SgpGatewayController } from './sgp.controller';
import { SgpRuntimeService } from './sgp-runtime.service';

@Module({ imports: [PrismaModule, AuditModule, AuthModule, AccessControlModule], providers: [SgpService, SgpRuntimeService], controllers: [SgpAdminController, SgpGatewayController] })
export class SgpModule {}
