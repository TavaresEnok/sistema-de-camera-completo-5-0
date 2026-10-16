import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { SgpService } from '../src/sgp/sgp.service';
import { SgpRuntimeService } from '../src/sgp/sgp-runtime.service';
import { AccessControlService } from '../src/access-control/access-control.service';
import { hash, parseEvent } from '../src/sgp/sgp-policy';

// This suite may only target the isolated, named fixture. Never a production DB.
const url = process.env.DATABASE_URL ?? '';
assert.match(url, /^postgresql:\/\/[^@]+@s2cam-sgp-postgres-20261016:5432\/sgp_safety(?:\?|$)/);
const prisma = new PrismaClient();
const commercial: any = { getPolicy: async () => ({ maxUsers: null, maxRetentionDays: 90, aiObjectClasses: ['person'], restrictions: { aiMotion: true, aiObject: true } }) };
const service = new SgpService(prisma as any, commercial, { log: async () => {} } as any);
let sequence = 0;
const event = (customer = 'customer-1', overrides: any = {}) => ({
  acao: 'cadastrar', data: `2026-10-15T10:00:${String(sequence++).padStart(2, '0')}.123456-03:00`,
  cliente: { id: customer, cpfcnpj: '52998224725', nome: 'Cliente de teste' }, contrato: { id: 'contract' },
  servico: { id: `service-${customer}`, status: 'ATIVO', plano: { id: '10' }, limites: { cameras_privadas: 2, retencao_dias: 7 }, gravacao: { modo: 'continua' }, ...overrides },
});

test('SGP against isolated PostgreSQL: lifecycle, isolation, ownership, shared policy and credentials', async () => {
  try {
    const integration = await prisma.sgpIntegration.create({ data: { name: 'Fixture', enabled: true, keyHash: 'a'.repeat(64), statusMap: { ATIVO: 'ACTIVE', SUSPENSO: 'SUSPENDED', CANCELADO: 'ARCHIVED' }, planIds: ['10'] } });
    const body = event();
    const first: any = await service.webhook(integration, body, 'create-1');
    const customer = await prisma.sgpCustomer.findUniqueOrThrow({ where: { id: first.gateway_id } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    assert.equal(account.mustChangePassword, true);
    assert.equal(await bcrypt.compare('52998224725', account.passwordHash), true);
    const replay: any = await service.webhook(integration, body, 'create-1');
    assert.equal(replay.repeated, true);
    assert.equal(await prisma.sgpCustomer.count(), 1);
    assert.equal(await prisma.user.count(), 1);
    const newHash = await bcrypt.hash('SenhaEscolhidaPeloCliente!', 4);
    await prisma.user.update({ where: { id: account.id }, data: { passwordHash: newHash, mustChangePassword: false } });
    await service.webhook(integration, body, 'create-1');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).passwordHash, newHash);

    const otherGroup = await prisma.cameraGroup.create({ data: { name: 'Outro cliente', retentionDays: 30 } });
    const cameraBase = { ip: '192.0.2.10', username: 'fixture', passwordEncrypted: 'fixture', recordingMode: 'continuous', recordingEnabled: true, retentionDays: 7, retentionFollowsGroup: true, groupId: customer.groupId };
    const exclusive = await prisma.camera.create({ data: { ...cameraBase, name: 'Exclusiva', groups: { connect: { id: customer.groupId } } } });
    const shared = await prisma.camera.create({ data: { ...cameraBase, name: 'Compartilhada', groups: { connect: [{ id: customer.groupId }, { id: otherGroup.id }] } } });
    const owned = await prisma.camera.create({ data: { ...cameraBase, name: 'Privada do cliente', isPrivate: true, ownerUserId: account.id, groups: { connect: { id: customer.groupId } } } });
    const otherUser = await prisma.user.create({ data: { name: 'Outro usuário', username: 'other', passwordHash: 'fixture', role: 'VIEWER' } });
    const otherPrivate = await prisma.camera.create({ data: { ...cameraBase, name: 'Privada de terceiro', isPrivate: true, ownerUserId: otherUser.id, groups: { connect: { id: customer.groupId } } } });
    const access = new AccessControlService(prisma as any);
    const user: any = { id: account.id, role: 'VIEWER', integrationGroupId: customer.groupId, mustChangePassword: false };
    assert.equal(await access.canViewCamera(user, owned.id), true);
    assert.equal(await access.canViewCamera(user, otherPrivate.id), false);
    assert.equal(await access.canAdminGroup(user, customer.groupId), false);
    const ids = await access.getAccessibleCameraIds(user);
    assert.ok(ids.includes(owned.id)); assert.ok(!ids.includes(otherPrivate.id));
    assert.equal(await access.canViewCamera({ ...user, mustChangePassword: true }, owned.id), false);

    await service.webhook(integration, event(), 'same-policy-new-event');
    assert.equal((await prisma.camera.findUniqueOrThrow({ where: { id: exclusive.id } })).integrationRuntimePending, false);
    const changed = event('customer-1', { limites: { cameras_privadas: 3, retencao_dias: 3 }, gravacao: { modo: 'movimento' } });
    await service.webhook(integration, changed, 'change-policy');
    const [changedExclusive, unchangedShared] = await Promise.all([prisma.camera.findUniqueOrThrow({ where: { id: exclusive.id } }), prisma.camera.findUniqueOrThrow({ where: { id: shared.id } })]);
    assert.equal(changedExclusive.recordingMode, 'motion');
    assert.equal(changedExclusive.aiEnabled, true);
    assert.equal(changedExclusive.integrationRuntimePending, true);
    assert.equal(unchangedShared.recordingMode, 'continuous');
    assert.equal(unchangedShared.retentionDays, 7);
    assert.equal(unchangedShared.retentionFollowsGroup, false);
    assert.equal(unchangedShared.integrationRuntimePending, false);

    await service.webhook(integration, event('customer-1', { status: 'SUSPENSO', limites: { cameras_privadas: 3, retencao_dias: 3 }, gravacao: { modo: 'movimento' } }), 'suspend');
    assert.equal(await access.canViewCamera(user, owned.id), false);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).integrationSuspended, true);
    const runtime: any = new SgpRuntimeService(prisma as any, {} as any, {} as any, {} as any, access);
    await runtime.desired(exclusive.id); await runtime.desired(shared.id);
    assert.equal((await prisma.camera.findUniqueOrThrow({ where: { id: exclusive.id } })).enabled, false);
    assert.equal((await prisma.camera.findUniqueOrThrow({ where: { id: shared.id } })).enabled, true);

    const otherIntegration = await prisma.sgpIntegration.create({ data: { name: 'Outro provedor', enabled: true, statusMap: { ATIVO: 'ACTIVE' } } });
    await assert.rejects(() => service.customers(otherIntegration.id, 'customer-1'), (e: any) => e.getStatus() === 404);
    await assert.rejects(() => service.operation(otherIntegration.id, first.operation_id), (e: any) => e.getStatus() === 404);

    const credential = { ...integration, keyHash: 'a'.repeat(64) };
    // Hold provisioning lock so rotation wins before queued archive is allowed.
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve);
    const hold = new Promise<void>(resolve => release = resolve);
    const rotation = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sgp-provisioning', 0))`;
      entered(); await hold;
      await tx.sgpIntegration.update({ where: { id: integration.id }, data: { keyHash: null } });
    });
    await ready;
    const queued = service.archive(integration.id, 'customer-1', false, credential);
    const rejected = assert.rejects(() => queued, (e: any) => e.getStatus() === 401);
    release(); await rotation; await rejected;
    assert.equal((await prisma.sgpCustomer.findUniqueOrThrow({ where: { id: customer.id } })).archivedAt, null);
    await prisma.sgpIntegration.update({ where: { id: integration.id }, data: { keyHash: integration.keyHash } });

    await service.archive(integration.id, 'customer-1');
    await service.archive(integration.id, 'customer-1', true);
    assert.equal((await prisma.sgpCustomer.findUniqueOrThrow({ where: { id: customer.id } })).state, 'SUSPENDED');
    await service.webhook(integration, event('customer-1', { limites: { cameras_privadas: 3, retencao_dias: 3 }, gravacao: { modo: 'movimento' } }), 'reactivate');
    await runtime.desired(exclusive.id);
    assert.equal((await prisma.camera.findUniqueOrThrow({ where: { id: exclusive.id } })).enabled, true);
    assert.equal(await access.canViewCamera(user, owned.id), true);

    await service.webhook(integration, event('customer-1', { limites: { cameras_privadas: 3, retencao_dias: 30 }, gravacao: { modo: 'continua' } }), 'before-cancel');
    await service.webhook(integration, event('customer-1', { status: 'CANCELADO', limites: { cameras_privadas: 3, retencao_dias: 30 }, gravacao: { modo: 'continua' } }), 'cancel');
    const cancelled = await prisma.camera.findUniqueOrThrow({ where: { id: exclusive.id } });
    assert.equal(cancelled.retentionDays, 30);
    assert.equal(cancelled.recordingMode, 'continuous');

    // A reduced license must reject new object activation but still permit a
    // suspension with its original policy, without trapping the client active.
    const originalPolicy = commercial.getPolicy;
    commercial.getPolicy = async () => ({ maxUsers: null, maxRetentionDays: 3, restrictions: { aiMotion: false, aiObject: false } });
    await assert.rejects(() => service.webhook(integration, event('customer-1', { limites: { cameras_privadas: 3, retencao_dias: 3 }, gravacao: { modo: 'objeto' } }), 'restricted-object'), (e: any) => e.getStatus() === 423);
    await service.webhook(integration, event('customer-1', { status: 'SUSPENSO', limites: { cameras_privadas: 3, retencao_dias: 30 }, gravacao: { modo: 'objeto' } }), 'restricted-suspend');
    assert.equal((await prisma.sgpCustomer.findUniqueOrThrow({ where: { id: customer.id } })).state, 'SUSPENDED');
    commercial.getPolicy = originalPolicy;

    const managed = integration.id;
    await prisma.systemSetting.create({ data: { key: 'cloud.sgpManagedId', value: managed } });
    const extraToken = `s2sgp_${otherIntegration.id}.${randomBytes(32).toString('base64url')}`;
    await prisma.sgpIntegration.update({ where: { id: otherIntegration.id }, data: { keyHash: hash(extraToken) } });
    await assert.rejects(() => service.authenticate(`Bearer ${extraToken}`), (e: any) => e.getStatus() === 401);
    await assert.rejects(() => service.rotateKey(account.id, otherIntegration.id), (e: any) => e.getStatus() === 409);
    await assert.rejects(() => service.save(account.id, null, { name: 'Extra', enabled: true, planIds: [], statusMap: { ATIVO: 'ACTIVE' } }), (e: any) => e.getStatus() === 409);
  } finally { await prisma.$disconnect(); }
});

test('invalid inherited modes rejected; numeric CNPJ needs responsible CPF', () => {
  const config = { planIds: ['10'], statusMap: { ATIVO: 'ACTIVE' }, utcOffsetMinutes: -180 };
  for (const modo of ['constructor', '__proto__', 'toString']) assert.throws(() => parseEvent(event('parser', { gravacao: { modo } }), config));
  const body: any = event('company');
  body.cliente.cpfcnpj = '11.222.333/0001-81';
  assert.throws(() => parseEvent(body, config));
  body.cliente.responsavel = { cpf: '52998224725' };
  assert.equal(parseEvent(body, config).username, '52998224725');
  body.cliente.cpfcnpj = '11.222.333/0001-82';
  assert.throws(() => parseEvent(body, config));
});

test('failed AI start preserves pending state; manual recording requires no AI', async () => {
  let cleared = false;
  const runtime: any = new SgpRuntimeService({ camera: { updateMany: async () => { cleared = true; return { count: 1 }; } } } as any, {} as any, {} as any, {} as any, {} as any);
  let mode = 'object';
  runtime.desired = async () => ({ enabled: true, recordingEnabled: true, recordingMode: mode, motionTrigger: 'SYSTEM', integrationEnabledBeforeBlock: null, integrationRuntimePending: true, updatedAt: new Date() });
  runtime.get = () => ({ pauseForIntegration: async () => {}, resumeForIntegration: async () => {}, startCamera: async () => ({ status: 'disabled', reason: 'commercial_restriction' }) });
  await assert.rejects(() => runtime.reconcileCamera('fixture'));
  assert.equal(cleared, false);
  mode = 'manual';
  await runtime.reconcileCamera('fixture');
  assert.equal(cleared, true);
});
