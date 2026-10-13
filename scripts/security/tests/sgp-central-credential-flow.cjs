// Disposable lab only. Tokens remain in memory and never enter stdout/logs.
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { SgpService } = require('./dist/sgp/sgp.service');
const p = new PrismaClient();
const check = (ok, name) => { if (!ok) throw Error('sgp_failed_central_' + name); };
(async () => {
  const { adminToken } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const id = 'sgp-central-lab', root = 'http://central:9765';
  const api = 'http://127.0.0.1:3000';
  async function request(base, path, method, token, body, expected = 200) {
    const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    check(r.status === expected, path.replace(/[^a-z0-9]/gi, '_') + '_' + r.status);
    return r.json();
  }
  const central = (path, method = 'GET', body, expected = 200) => request(root, path, method, process.env.INTERNAL_SERVICE_TOKEN, body, expected);
  const local = (path, method = 'GET', body, expected = 200) => request(api, path, method, adminToken, body, expected);
  const heartbeat = () => local('/cloud-connector/heartbeat', 'POST', undefined, 201);
  const status = async () => (await central('/api/admin/installations')).items.find(item => item.id === id).sgpIntegration;
  const change = (revision, revoke = false) => central(`/api/admin/installations/${id}/sgp/token`, revoke ? 'DELETE' : 'POST', { confirmInstallationId: id, expectedRevision: revision, requestId: randomUUID() });
  const verify = (token, expected = 404) => request(api, '/integrations/v1/sgp/customers/unknown-fixture', 'GET', token, undefined, expected);
  for (let i = 0; i < 240; i++) {
    if (!await p.camera.count({ where: { integrationRuntimePending: true } }) && !await p.sgpOperation.count({ where: { state: 'PENDING' } })) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  check(!await p.camera.count({ where: { integrationRuntimePending: true } }), 'previous_operations_settled');
  const before = await p.camera.findMany({ orderBy: { id: 'asc' }, select: { id: true, enabled: true, recordingEnabled: true, recordingMode: true } });
  await heartbeat();
  const first = await change(0);
  check((await status()).status === 'PENDING', 'not_applied_before_delivery');
  await heartbeat();
  await verify(first.token);
  const managed = await p.sgpIntegration.findUniqueOrThrow({ where: { id: first.sgpIntegration.integrationId } });
  check(managed.keyHash === createHash('sha256').update(first.token).digest('hex'), 'hashed_at_installation');
  check((await local('/integrations/sgp')).find(row => row.id === managed.id).managedByCentral === true, 'managed_flag');
  await local(`/integrations/sgp/${managed.id}/key`, 'POST', undefined, 409);
  await heartbeat();
  check((await status()).status === 'APPLIED', 'acknowledged_application');
  check(!JSON.stringify(await central('/api/admin/installations')).includes(first.token), 'full_token_not_listed');
  await local(`/integrations/sgp/${managed.id}`, 'PATCH', { name: 'Central preserved fixture', enabled: true, statusMap: { ATIVO: 'ACTIVE', BLOQUEADO: 'SUSPENDED' }, utcOffsetMinutes: -180, planIds: ['10'] });
  const second = await change(1);
  check((await status()).status === 'PENDING', 'rotation_waits_for_ack');
  await heartbeat(); await verify(first.token, 401); await verify(second.token);
  const service = new SgpService(p, {}, {});
  await service.applyCentralCredential({ integrationId: managed.id, revision: 1, keyHash: createHash('sha256').update(first.token).digest('hex'), keyPrefix: first.token.slice(-6) });
  await verify(first.token, 401); await verify(second.token);
  const retained = await p.sgpIntegration.findUniqueOrThrow({ where: { id: managed.id } });
  check(retained.name === 'Central preserved fixture' && retained.planIds[0] === '10' && retained.statusMap.BLOQUEADO === 'SUSPENDED', 'settings_preserved');
  await heartbeat(); check((await status()).status === 'APPLIED', 'rotation_confirmed');
  await central('/api/admin/provision', 'POST', { customerName: 'Another lab', installationId: 'sgp-other-lab', serverAddress: 'https://other.example.invalid' }, 201);
  const other = await central('/api/admin/installations/sgp-other-lab/sgp/token', 'POST', { confirmInstallationId: 'sgp-other-lab', expectedRevision: 0, requestId: randomUUID() });
  await verify(other.token, 401);
  await heartbeat(); await verify(second.token);
  await change(2, true);
  check((await status()).status === 'PENDING', 'revocation_waits_for_ack');
  await heartbeat(); await verify(second.token, 401); await heartbeat();
  check((await status()).status === 'REVOKED', 'revocation_confirmed');
  const after = await p.camera.findMany({ orderBy: { id: 'asc' }, select: { id: true, enabled: true, recordingEnabled: true, recordingMode: true } });
  check(JSON.stringify(before) === JSON.stringify(after), 'camera_settings_preserved');
  console.log(JSON.stringify({ realCentralAndApiHttp: true, authenticatedOutboundHeartbeat: true, applicationAcknowledged: true, rotationAndRevocation: true, hashedAtInstallation: true, tokenNotListed: true, preservedIntegrationSettings: true, localRotationProtected: true, installationIsolation: true, staleDeliveryIgnored: true, cameraSettingsPreserved: true }));
})().catch(error => { console.error(/^sgp_failed_[a-z0-9_]+$/i.test(error.message) ? error.message : 'sgp_failed_central_unexpected'); process.exitCode = 1; }).finally(() => p.$disconnect());
