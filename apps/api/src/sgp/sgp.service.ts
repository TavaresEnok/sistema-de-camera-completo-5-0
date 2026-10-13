import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, SgpIntegration } from '@prisma/client';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { AuditService } from '../audit/audit.service';
import { cpf, customerState, hash, object, parseEvent, statusMap, text } from './sgp-policy';

const safeConfig = { id: true, name: true, enabled: true, keyPrefix: true, statusMap: true, planIds: true, utcOffsetMinutes: true, lastReceivedAt: true, createdAt: true } as const;
@Injectable()
export class SgpService {
  constructor(private readonly prisma: PrismaService, private readonly commercial: CommercialPolicyService, private readonly audit: AuditService) {}

  async list() {
    const [rows, managed] = await Promise.all([
      this.prisma.sgpIntegration.findMany({ select: { ...safeConfig, _count: { select: { customers: true } } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'cloud.sgpManagedId' } }),
    ]);
    return rows.map(row => ({ ...row, managedByCentral: row.id === managed?.value }));
  }

  /** Authenticated outbound Central heartbeat only; no public provisioning route. */
  async applyCentralCredential(value: unknown) {
    const input = object(value);
    const id = text(input.integrationId, 'integração', 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
      || !Number.isSafeInteger(input.revision) || input.revision < 1
      || !(input.keyHash === null || /^[0-9a-f]{64}$/.test(input.keyHash))
      || !(input.keyHash === null ? input.keyPrefix === null : /^[A-Za-z0-9_-]{6}$/.test(input.keyPrefix))) {
      throw new BadRequestException('Configuração SGP recebida da Central inválida.');
    }
    return this.locked(async tx => {
      const managed = await tx.systemSetting.findUnique({ where: { key: 'cloud.sgpManagedId' } });
      const applied = await tx.systemSetting.findUnique({ where: { key: 'cloud.sgpAppliedRevision' } });
      if (managed?.value && managed.value !== id) throw new ConflictException('Vínculo SGP da Central diferente do cadastro local.');
      const current = await tx.sgpIntegration.findUnique({ where: { id } });
      if (current && managed?.value !== id) throw new ConflictException('Integração SGP local já existente.');
      const appliedRevision = Number(applied?.value || 0);
      if (input.revision < appliedRevision) return { revision: appliedRevision, ignored: true };
      const changed = !current || input.revision > appliedRevision || current.keyHash !== input.keyHash;
      const credential = { keyHash: input.keyHash, keyPrefix: input.keyPrefix, enabled: input.keyHash !== null };
      if (!current) await tx.sgpIntegration.create({ data: { id, name: 'SGP · Central', ...credential, statusMap: { ATIVO: 'ACTIVE' }, utcOffsetMinutes: -180, planIds: [] } });
      else if (changed) await tx.sgpIntegration.update({ where: { id }, data: credential });
      for (const [key, setting] of Object.entries({ 'cloud.sgpManagedId': id, 'cloud.sgpAppliedRevision': String(input.revision), 'cloud.sgpApplyStatus': 'APPLIED', 'cloud.sgpAttemptId': '', 'cloud.sgpAttemptRevision': '' })) {
        await tx.systemSetting.upsert({ where: { key }, create: { key, value: setting }, update: { value: setting } });
      }
      if (changed) await tx.auditLog.create({ data: { action: input.keyHash === null ? 'sgp.central.key.revoke' : 'sgp.central.key.apply', entityType: 'SgpIntegration', entityId: id, metadata: { revision: input.revision } } });
      return { revision: input.revision, changed };
    });
  }
  private config(body: unknown) {
    const value = object(body);
    if (typeof value.enabled !== 'boolean') throw new BadRequestException({ error: 'Informe se a integração está ativada.' });
    const offset = value.utcOffsetMinutes ?? -180;
    if (!Number.isInteger(offset) || offset < -720 || offset > 840) throw new BadRequestException({ error: 'Fuso horário inválido.' });
    if (!Array.isArray(value.planIds) || value.planIds.length > 100) throw new BadRequestException({ error: 'Lista de planos inválida.' });
    return { name: text(value.name, 'nome', 80), enabled: value.enabled, utcOffsetMinutes: offset, planIds: [...new Set<string>(value.planIds.map((id: unknown) => text(id, 'plano')))], statusMap: statusMap(value.statusMap) };
  }
  async save(actorId: string, id: string | null, body: unknown) {
    const data = this.config(body);
    const result = id ? await this.prisma.sgpIntegration.update({ where: { id }, data, select: safeConfig }) : await this.prisma.sgpIntegration.create({ data, select: safeConfig });
    await this.audit.log(actorId, 'sgp.configuration.save', 'SgpIntegration', result.id);
    return result;
  }
  async rotateKey(actorId: string, id: string, revoke = false) {
    const managed = await this.prisma.systemSetting.findUnique({ where: { key: 'cloud.sgpManagedId' } });
    if (managed?.value === id) throw new ConflictException({ error: 'Este token é gerenciado pela Central. Gere, substitua ou revogue o token no cadastro desta instalação na Central.' });
    const key = `s2sgp_${id}.${randomBytes(32).toString('base64url')}`;
    await this.prisma.sgpIntegration.update({ where: { id }, data: { keyHash: revoke ? null : hash(key), keyPrefix: revoke ? null : key.slice(-6) } });
    await this.audit.log(actorId, revoke ? 'sgp.key.revoke' : 'sgp.key.rotate', 'SgpIntegration', id);
    return revoke ? { revoked: true } : { key, message: 'Copie esta chave agora. Ela não será exibida novamente.' };
  }
  async authenticate(authorization?: string): Promise<SgpIntegration> {
    const match = /^Bearer (s2sgp_([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException({ error: 'Chave de integração inválida.' });
    const config = await this.prisma.sgpIntegration.findUnique({ where: { id: match[2] } });
    const expected = Buffer.from(config?.keyHash ?? '0'.repeat(64), 'hex');
    if (!config?.enabled || expected.length !== 32 || !timingSafeEqual(expected, Buffer.from(hash(match[1]), 'hex'))) throw new UnauthorizedException({ error: 'Chave inválida ou integração desativada.' });
    return config;
  }

  private async locked<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      // Serializes provisioning/quota decisions across API replicas; no network calls in this transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sgp-provisioning', 0))`;
      return run(tx);
    }, { timeout: 20_000, maxWait: 20_000 });
  }
  async applyCustomerState(tx: Prisma.TransactionClient, id: string) {
    const customer = await tx.sgpCustomer.findUniqueOrThrow({ where: { id }, include: { services: true } });
    const state = customerState(customer.services.map(service => service.state), Boolean(customer.archivedAt));
    const updated = await tx.sgpCustomer.update({ where: { id }, data: { state, revision: { increment: 1 } } });
    await tx.cameraGroup.update({ where: { id: customer.groupId }, data: { isActive: state !== 'ARCHIVED', accessStatus: state === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED', accessMessage: state === 'ACTIVE' ? null : 'Acesso suspenso. Entre em contato com seu provedor.' } });
    await tx.camera.updateMany({ where: { OR: [{ groupId: customer.groupId }, { groups: { some: { id: customer.groupId } } }] }, data: { integrationRuntimePending: true } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: customer.userId } });
    const suspended = state !== 'ACTIVE';
    await tx.user.update({ where: { id: user.id }, data: { integrationSuspended: suspended, integrationGroupId: customer.groupId, ...(user.integrationSuspended !== suspended ? { authVersion: { increment: 1 } } : {}) } });
    if (suspended) await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return updated;
  }
  async webhook(config: SgpIntegration, body: unknown, requestKey?: string) {
    const event = parseEvent(body, config);
    const eventId = requestKey ? text(requestKey, 'Idempotency-Key') : event.eventId;
    const dedupeKey = eventId ? hash(`id:${eventId}`) : event.payloadHash;
    // Hash outside the DB transaction; this value is never logged or returned.
    const knownCustomer = await this.prisma.sgpCustomer.findUnique({ where: { integrationId_externalCustomerId: { integrationId: config.id, externalCustomerId: event.customerId } }, select: { id: true } });
    const initialHash = event.action === 'cadastrar' && !knownCustomer ? await bcrypt.hash(event.username, 12) : null;
    const policy = await this.commercial.getPolicy();
    const result = await this.locked(async tx => {
      const currentConfig = await tx.sgpIntegration.findUniqueOrThrow({ where: { id: config.id } });
      if (!currentConfig.enabled || currentConfig.keyHash !== config.keyHash) throw new UnauthorizedException({ error: 'Integração desativada ou chave substituída.' });
      if (currentConfig.utcOffsetMinutes !== config.utcOffsetMinutes || JSON.stringify(currentConfig.planIds) !== JSON.stringify(config.planIds) || JSON.stringify(currentConfig.statusMap) !== JSON.stringify(config.statusMap)) throw new ConflictException({ error: 'A configuração da integração mudou. Reenvie a solicitação.' });
      const duplicate = await tx.sgpOperation.findUnique({ where: { integrationId_dedupeKey: { integrationId: config.id, dedupeKey } } });
      if (duplicate) {
        if (duplicate.requestHash !== event.payloadHash) throw new ConflictException({ error: 'Identificador de evento reutilizado com dados diferentes.' });
        // An explicit idempotency key cannot address a different client.
        const owner = await tx.sgpCustomer.findUniqueOrThrow({ where: { id: duplicate.customerId } });
        if (owner.externalCustomerId !== event.customerId) throw new ConflictException({ error: 'Identificador de evento reutilizado para outro cliente.' });
        return { operation: duplicate, customer: owner, repeated: true };
      }
      let customer = await tx.sgpCustomer.findUnique({ where: { integrationId_externalCustomerId: { integrationId: config.id, externalCustomerId: event.customerId } } });
      if (!customer) {
        if (event.action !== 'cadastrar' || !initialHash) throw new NotFoundException({ error: 'Cliente ainda não vinculado. Envie o cadastro primeiro.' });
        if (await tx.user.findUnique({ where: { username: event.username } })) throw new ConflictException({ error: 'Este login já existe. Confirme o vínculo na página Integrações.' });
        if (policy.maxUsers !== null && await tx.user.count({ where: { isActive: true } }) >= policy.maxUsers) throw new ConflictException({ error: 'Limite de usuários da instalação atingido.' });
        const group = await tx.cameraGroup.create({ data: { name: event.name, accessStatus: 'SUSPENDED', retentionDays: Math.min(3, policy.maxRetentionDays ?? 3) } });
        const user = await tx.user.create({ data: { name: event.name, username: event.username, passwordHash: initialHash, role: 'VIEWER', mustChangePassword: true, integrationGroupId: group.id, integrationSuspended: true } });
        await tx.cameraPermission.create({ data: { userId: user.id, groupId: group.id, level: 'VIEW' } });
        customer = await tx.sgpCustomer.create({ data: { integrationId: config.id, externalCustomerId: event.customerId, groupId: group.id, userId: user.id } });
      }
      if (customer.archivedAt) throw new ConflictException({ error: 'Vínculo arquivado pelo administrador. Restaure-o antes de receber novos eventos.' });
      const current = await tx.sgpService.findUnique({ where: { integrationId_externalServiceId: { integrationId: config.id, externalServiceId: event.serviceId } } });
      if (current && current.customerId !== customer.id) throw new ConflictException({ error: 'Este serviço já pertence a outro cliente.' });
      const stale = current && current.sourceOrder > event.sourceOrder;
      if (current && current.sourceOrder === event.sourceOrder && current.payloadHash !== event.payloadHash) throw new ConflictException({ error: 'Eventos diferentes têm a mesma data. Reenvie o estado atual com data atualizada.' });
      if (!stale) {
        const account = await tx.user.findUniqueOrThrow({ where: { id: customer.userId } });
        if (account.username !== event.username) throw new ConflictException({ error: 'CPF diferente do vínculo existente. Revise o cadastro com o administrador.' });
        const data = { customerId: customer.id, externalContractId: event.contractId, state: event.state, sourceAt: event.sourceAt, sourceOrder: event.sourceOrder, payloadHash: event.payloadHash };
        await tx.sgpService.upsert({ where: { integrationId_externalServiceId: { integrationId: config.id, externalServiceId: event.serviceId } }, create: { ...data, integrationId: config.id, externalServiceId: event.serviceId }, update: data });
        await tx.user.update({ where: { id: customer.userId }, data: { name: event.name } });
        await tx.cameraGroup.update({ where: { id: customer.groupId }, data: { name: event.name } });
        customer = await this.applyCustomerState(tx, customer.id);
      }
      const operation = await tx.sgpOperation.create({ data: { integrationId: config.id, customerId: customer.id, dedupeKey, requestHash: event.payloadHash, state: stale ? 'IGNORED' : 'PENDING', revision: customer.revision } });
      await tx.sgpIntegration.update({ where: { id: config.id }, data: { lastReceivedAt: new Date() } });
      return { operation, customer, repeated: false };
    });
    return { gateway_id: result.customer.id, gateway_params_extra: result.customer.groupId, operation_id: result.operation.id, status: result.operation.state, customer_status: result.customer.state, repeated: result.repeated };
  }
  async customers(integrationId: string, externalId?: string, cursor?: string) {
    const rows = await this.prisma.sgpCustomer.findMany({ where: { integrationId, ...(externalId ? { externalCustomerId: externalId } : {}) }, include: { group: { select: { name: true, _count: { select: { cameras: true } } } }, user: { select: { username: true, mustChangePassword: true } }, services: { select: { externalServiceId: true, externalContractId: true, state: true, sourceAt: true } } }, orderBy: { id: 'asc' }, take: 201, ...(cursor ? { cursor: { id: text(cursor, 'cursor') }, skip: 1 } : {}) });
    if (externalId && !rows.length) throw new NotFoundException({ error: 'Cliente não encontrado nesta integração.' });
    return externalId ? rows[0] : { items: rows.slice(0, 200), nextCursor: rows.length > 200 ? rows[199].id : null };
  }
  operations(integrationId: string) { return this.prisma.sgpOperation.findMany({ where: { integrationId }, orderBy: { createdAt: 'desc' }, take: 100 }); }
  async operation(integrationId: string, id: string) {
    const row = await this.prisma.sgpOperation.findFirst({ where: { id, integrationId } });
    if (!row) throw new NotFoundException({ error: 'Operação não encontrada nesta integração.' });
    return row;
  }
  async archive(integrationId: string, externalId: string, restore = false) {
    return this.locked(async tx => {
      const found = await tx.sgpCustomer.findUnique({ where: { integrationId_externalCustomerId: { integrationId, externalCustomerId: externalId } } });
      if (!found) throw new NotFoundException({ error: 'Cliente não encontrado nesta integração.' });
      if (Boolean(found.archivedAt) === !restore) {
        const operation = await tx.sgpOperation.findFirst({ where: { customerId: found.id }, orderBy: { createdAt: 'desc' } });
        return { operation_id: operation?.id ?? null, status: operation?.state ?? 'COMPLETE', customer_status: found.state, repeated: true };
      }
      await tx.sgpCustomer.update({ where: { id: found.id }, data: { archivedAt: restore ? null : new Date() } });
      const customer = await this.applyCustomerState(tx, found.id);
      const operation = await tx.sgpOperation.create({ data: { integrationId, customerId: customer.id, dedupeKey: randomUUID(), requestHash: hash(JSON.stringify({ externalId, restore })), revision: customer.revision } });
      return { operation_id: operation.id, status: operation.state, customer_status: customer.state };
    });
  }
  async link(actorId: string, integrationId: string, body: unknown) {
    const value = object(body);
    if (value.confirm !== true) throw new BadRequestException({ error: 'Confirme que este grupo e usuário pertencem ao cliente informado.' });
    const externalCustomerId = text(value.externalCustomerId, 'cliente SGP');
    const groupId = text(value.groupId, 'grupo'), userId = text(value.userId, 'usuário');
    const username = cpf(value.cpf);
    const result = await this.locked(async tx => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { cameraPermissions: true, _count: { select: { ownedCameras: true } } } });
      const group = await tx.cameraGroup.findUnique({ where: { id: groupId } });
      if (!user || user.username !== username || user.role !== 'VIEWER' || user.integrationGroupId || user._count.ownedCameras || user.cameraPermissions.some(permission => permission.groupId !== groupId || permission.level !== 'VIEW')) throw new ConflictException({ error: 'Escolha um usuário de visualização com este CPF, sem outros grupos ou câmeras particulares.' });
      if (!group?.isActive || await tx.sgpCustomer.findUnique({ where: { groupId } })) throw new ConflictException({ error: 'Grupo indisponível ou já vinculado.' });
      const customer = await tx.sgpCustomer.create({ data: { integrationId, externalCustomerId, groupId, userId } });
      if (!user.cameraPermissions.length) await tx.cameraPermission.create({ data: { userId, groupId, level: 'VIEW' } });
      await this.applyCustomerState(tx, customer.id);
      await tx.sgpOperation.create({ data: { integrationId, customerId: customer.id, dedupeKey: randomUUID(), requestHash: hash(JSON.stringify({ externalCustomerId, groupId, userId })), revision: 1 } });
      return customer;
    });
    await this.audit.log(actorId, 'sgp.customer.link', 'SgpCustomer', result.id);
    return result;
  }
  async retry(integrationId: string, id: string) {
    const operation = await this.operation(integrationId, id);
    if (operation.state !== 'PENDING') return operation;
    return this.prisma.sgpOperation.update({ where: { id }, data: { nextAttemptAt: new Date(), lastError: null } });
  }
}
