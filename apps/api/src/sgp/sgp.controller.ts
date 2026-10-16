import { ArgumentsHost, Body, CallHandler, Catch, Controller, Delete, ExceptionFilter, ExecutionContext, Get, Headers, HttpException, HttpCode, NestInterceptor, Param, ParseUUIDPipe, Patch, Post, Query, UseFilters, UseInterceptors } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { SgpService } from './sgp.service';
import { SGP_API_VERSION, sgpOpenApi } from './sgp.openapi';

export class SgpNoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

@Catch()
export class SgpErrorFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : exception?.code === 'P2002' ? 409 : exception?.code === 'P2025' ? 404 : 503;
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const error = typeof body === 'object' && body ? (body as any).error ?? (body as any).message : body;
    response.setHeader('Cache-Control', 'no-store');
    const code = typeof body === 'object' && body && typeof (body as any).code === 'string' ? (body as any).code : undefined;
    response.status(status).json({ error: typeof error === 'string' ? error : status === 409 ? 'Cadastro já vinculado. Revise o cliente, grupo e usuário.' : status === 404 ? 'Registro não encontrado.' : 'Não foi possível concluir agora. Reenvie a mesma solicitação.', ...(code ? { code } : {}) });
  }
}

@Public()
@UseFilters(SgpErrorFilter)
@UseInterceptors(SgpNoStoreInterceptor)
@Controller('integrations/v1/sgp')
export class SgpGatewayController {
  constructor(private readonly service: SgpService) {}
  @Get('openapi.json') specification() { return sgpOpenApi(); }
  @Get('capabilities') capabilities() { return { version: SGP_API_VERSION, actions: ['cadastrar', 'atualizar', 'alterar_plano', 'alterar_status'], limits: ['servico.limites.cameras_privadas', 'servico.limites.retencao_dias'], recording: ['continua', 'manual', 'movimento', 'objeto'], objectRecordingClasses: ['person'], initialPasswordChangeRequired: true, customerDocuments: ['CPF', 'CNPJ_NUMERIC'], sharedCameraPolicy: 'preserve_camera_settings', tokenManagement: 'central_when_managed' }; }
  @Post('webhook') @HttpCode(200)
  async webhook(@Headers('authorization') authorization: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.service.webhook(await this.service.authenticate(authorization), body, key);
  }
  @Get('customers/:externalId')
  async customer(@Headers('authorization') authorization: string, @Param('externalId') id: string) {
    return this.service.customers((await this.service.authenticate(authorization)).id, id);
  }
  @Delete('customers/:externalId')
  async archive(@Headers('authorization') authorization: string, @Param('externalId') id: string) {
    const credential = await this.service.authenticate(authorization);
    return this.service.archive(credential.id, id, false, credential);
  }
  @Post('customers/:externalId/restore') @HttpCode(200)
  async restore(@Headers('authorization') authorization: string, @Param('externalId') id: string) {
    const credential = await this.service.authenticate(authorization);
    return this.service.archive(credential.id, id, true, credential);
  }
  @Get('operations/:id')
  async operation(@Headers('authorization') authorization: string, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.service.operation((await this.service.authenticate(authorization)).id, id);
    return { operation_id: row.id, status: row.state, attempts: row.attempts, message: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
}

@Roles(UserRole.ADMIN)
@RequirePermission('serverConfig')
@UseFilters(SgpErrorFilter)
@UseInterceptors(SgpNoStoreInterceptor)
@Controller('integrations/sgp')
export class SgpAdminController {
  constructor(private readonly service: SgpService) {}
  @Get() list() { return this.service.list(); }
  @Post() save(@CurrentUser() actor: AuthUser, @Body() body: unknown) { return this.service.save(actor.id, null, body); }
  @Patch(':id') update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.service.save(actor.id, id, body); }
  @Post(':id/key') key(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.service.rotateKey(actor.id, id); }
  @Delete(':id/key') revoke(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.service.rotateKey(actor.id, id, true); }
  @Get(':id/customers') customers(@Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) { return this.service.customers(id, undefined, cursor); }
  @Post(':id/customers/link') link(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.service.link(actor.id, id, body); }
  @Delete(':id/customers/:externalId') async archive(@Param('id', ParseUUIDPipe) id: string, @Param('externalId') externalId: string) { return this.service.archive(id, externalId); }
  @Post(':id/customers/:externalId/restore') restore(@Param('id', ParseUUIDPipe) id: string, @Param('externalId') externalId: string) { return this.service.archive(id, externalId, true); }
  @Get(':id/operations') operations(@Param('id', ParseUUIDPipe) id: string) { return this.service.operations(id); }
  @Post(':id/operations/:operationId/retry') retry(@Param('id', ParseUUIDPipe) id: string, @Param('operationId', ParseUUIDPipe) operationId: string) { return this.service.retry(id, operationId); }
}
