// Run only inside the disposable compatibility lab. Tokens stay in process memory.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { CryptoService } = require('./dist/common/crypto/crypto.service');
const p = new PrismaClient();
const children = [];
let phase = 'configuration';
const check = (value, name) => { if (!value) throw new Error('sgp_failed_' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, name, seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) { if (await fn()) return; await delay(500); }
  throw new Error('sgp_failed_timeout_' + name);
}
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = 'http://127.0.0.1:3000';
  let loginAddress = 1;
  const headers = token => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
  async function call(path, method = 'GET', token = input.adminToken, body, expected = 200, extra = {}) {
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      response = await fetch(root + path, { method, headers: { ...headers(token), ...(path === '/auth/login' ? { 'X-Forwarded-For': `198.18.0.${loginAddress++}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (response.status !== 429 || [expected].flat().includes(429)) break;
      await response.text();
      await delay((Number(response.headers.get('retry-after')) || 60) * 1000 + 200);
    }
    let value;
    try { value = await response.json(); }
    catch { throw new Error('sgp_failed_nonjson_' + method.toLowerCase() + '_' + path.replace(/[^a-z0-9]/gi, '_') + '_' + response.status); }
    check([expected].flat().includes(response.status), method.toLowerCase() + '_' + path.replace(/[^a-z0-9]/gi, '_') + '_' + response.status);
    return value;
  }
  const docs = await call('/integrations/v1/sgp/openapi.json', 'GET', null);
  check(docs.openapi === '3.0.3' && docs.paths['/integrations/v1/sgp/webhook'].post.requestBody.required, 'openapi');
  const configuration = { name: 'SGP lab', enabled: true, statusMap: { ATIVO: 'ACTIVE', SUSPENSO: 'SUSPENDED', CANCELADO: 'ARCHIVED' }, utcOffsetMinutes: -180, planIds: ['10'] };
  const integration = await call('/integrations/sgp', 'POST', input.adminToken, configuration, 201);
  const secondIntegration = await call('/integrations/sgp', 'POST', input.adminToken, { ...configuration, name: 'SGP outro' }, 201);
  const key = (await call(`/integrations/sgp/${integration.id}/key`, 'POST', input.adminToken, undefined, 201)).key;
  const secondKey = (await call(`/integrations/sgp/${secondIntegration.id}/key`, 'POST', input.adminToken, undefined, 201)).key;
  const stored = await p.sgpIntegration.findUniqueOrThrow({ where: { id: integration.id } });
  check(stored.keyHash !== key && !JSON.stringify(await call('/integrations/sgp')).includes(key), 'key_not_exposed');
  let sequence = 0;
  const initialTime = Date.now() - 60_000;
  function event(status = 'ATIVO', extra = {}) {
    return { acao: 'cadastrar', data: new Date(initialTime + sequence++ * 10).toISOString(), cliente: { id: 'client-one', cpfcnpj: '52998224725', nome: 'Cliente lab SGP' }, contrato: { id: 'contract-one' }, servico: { id: 'service-one', status, plano: { id: '10' }, login_password: 'ignored-password' }, ...extra };
  }
  const webhook = (body, token = key, requestKey, expected = 200) => call('/integrations/v1/sgp/webhook', 'POST', token, body, expected, requestKey ? { 'Idempotency-Key': requestKey } : {});
  const createdEvent = event();
  await webhook(createdEvent, 'invalid', null, 401);
  const created = await webhook(createdEvent, key, 'event-create');
  const repeat = await webhook(createdEvent, key, 'event-create');
  check(repeat.operation_id === created.operation_id && repeat.repeated, 'deduplication');
  await webhook({ ...createdEvent, servico: { ...createdEvent.servico, status: 'SUSPENSO' } }, key, 'event-create', 409);
  await webhook(event('UNKNOWN'), key, null, 400);
  await webhook({ ...event(), servico: { ...createdEvent.servico, plano: { id: 'wrong' } } }, key, null, 400);
  await call('/integrations/v1/sgp/customers/client-one', 'GET', secondKey, undefined, 404);
  await call(`/integrations/v1/sgp/operations/${created.operation_id}`, 'GET', secondKey, undefined, 404);
  const customer = await p.sgpCustomer.findUniqueOrThrow({ where: { id: created.gateway_id } });
  const login = (username, password, expected = 201) => call('/auth/login', 'POST', null, { username, password }, expected);
  const initialLogin = await login('52998224725', '52998224725');
  check(initialLogin.user.mustChangePassword, 'initial_password_flag');
  await call('/cameras', 'GET', initialLogin.accessToken, undefined, 403);
  await call('/users/me/password', 'PATCH', initialLogin.accessToken, { currentPassword: '52998224725', newPassword: '52998224725' }, 400);
  const chosen = 'Lab-' + require('node:crypto').randomBytes(16).toString('hex');
  await call('/users/me/password', 'PATCH', initialLogin.accessToken, { currentPassword: '52998224725', newPassword: chosen });
  const activeLogin = await login('52998224725', chosen);
  check(!activeLogin.user.mustChangePassword, 'initial_password_cleared');
  await login('52998224725', '52998224725', 401);
  await webhook(createdEvent, key, 'event-create');
  check((await login('52998224725', chosen)).accessToken, 'retry_preserves_password');
  const otherEvent = event('ATIVO', { cliente: { id: 'client-two', cpfcnpj: '11144477735', nome: 'Outro cliente lab' }, contrato: { id: 'contract-two' }, servico: { id: 'service-two', status: 'ATIVO', plano: { id: '10' } } });
  const other = await webhook(otherEvent, secondKey);
  const otherInitial = await login('11144477735', '11144477735');
  const otherPassword = 'Lab-' + require('node:crypto').randomBytes(16).toString('hex');
  await call('/users/me/password', 'PATCH', otherInitial.accessToken, { currentPassword: '11144477735', newPassword: otherPassword });
  const otherLogin = await login('11144477735', otherPassword);
  const crypto = new CryptoService();
  phase = 'cameras';
  async function camera(name, enabled, mode, recordingEnabled, groups) {
    return p.camera.create({ data: { name, ip: input.mediaIp, rtspPort: 8554, username: 'lab', passwordEncrypted: crypto.encrypt(process.env.MEDIAMTX_API_PASS), rtspPath: '/fixture-healthy', sourceMode: 'rtsp_pull', detectedVideoCodec: 'h264', streamVideoCodec: 'h264', streamWidth: 640, streamHeight: 360, streamFps: 10, enabled, aiEnabled: false, recordingMode: mode, recordingEnabled, status: 'ONLINE', groupId: groups[0], groups: { connect: groups.map(id => ({ id })) } } });
  }
  const exclusive = await camera('sgp-exclusive', true, 'continuous', true, [customer.groupId]);
  const disabled = await camera('sgp-already-disabled', false, 'manual', false, [customer.groupId]);
  const shared = await camera('sgp-shared', true, 'manual', false, [customer.groupId, other.gateway_params_extra]);
  const outside = await camera('sgp-outside', true, 'manual', false, [other.gateway_params_extra]);
  await p.cameraPermission.create({ data: { userId: customer.userId, cameraId: outside.id, level: 'VIEW' } });
  await call(`/camera-stream/${outside.id}/token`, 'POST', activeLogin.accessToken, undefined, 403);
  await call(`/camera-stream/${exclusive.id}/token`, 'POST', initialLogin.accessToken, undefined, 401);
  const activeEvent = event('ATIVO', { acao: 'atualizar' });
  const activeOp = await webhook(activeEvent);
  await wait(async () => (await call(`/integrations/v1/sgp/operations/${activeOp.operation_id}`, 'GET', key)).status === 'COMPLETE', 'active_confirmation');
  await wait(async () => { const s = await call(`/cameras/${exclusive.id}/recording/status`); return s.isRecording && s.pid > 0; }, 'recording_started');
  const tokenOne = (await call(`/camera-stream/${shared.id}/token`, 'POST', activeLogin.accessToken, undefined, 201)).streamToken;
  const tokenTwo = (await call(`/camera-stream/${shared.id}/token`, 'POST', otherLogin.accessToken, undefined, 201)).streamToken;
  const sharedUrls = await call(`/camera-stream/${shared.id}/urls?viewMode=original`);
  phase = 'media_auth';
  const mediaAdmin = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('lab:' + process.env.MEDIAMTX_API_PASS).toString('base64') };
  const mediaRoot = 'http://mediamtx:9997';
  const callback = 'http://api:3000/camera-stream/mediamtx-auth?internalToken=' + process.env.MEDIAMTX_AUTH_CALLBACK_TOKEN;
  // MediaMTX may close the PATCH socket while applying its HTTP auth change.
  // Confirm the resulting configuration rather than treating that reset as success.
  try {
    const patch = await fetch(mediaRoot + '/v3/config/global/patch', { method: 'PATCH', headers: mediaAdmin, body: JSON.stringify({ authMethod: 'http', authHTTPAddress: callback, authHTTPExclude: [{ action: 'api' }, { action: 'metrics' }] }) });
    check(patch.ok, 'media_callback_enabled');
  } catch (e) { if (e.name !== 'TypeError') throw e; }
  await wait(async () => {
    try { const r = await fetch(mediaRoot + '/v3/config/global/get', { headers: mediaAdmin }); const c = await r.json(); return r.ok && c.authMethod === 'http' && c.authHTTPAddress === callback; }
    catch { return false; }
  }, 'media_callback_confirmed');
  // Changing MediaMTX authentication deliberately closes the disposable fixture
  // publishers. Restart only this synthetic source with the new lab credentials.
  const source = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://lab:${process.env.MEDIAMTX_API_PASS}@mediamtx:8554/fixture-healthy`], { stdio: 'ignore' });
  children.push(source);
  await wait(async () => { try { const r = await fetch(mediaRoot + '/v3/paths/get/fixture-healthy', { headers: mediaAdmin }); return r.ok && (await r.json()).ready; } catch { return false; } }, 'authenticated_fixture');
  function reader(token) {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://mediamtx:8554/${sharedUrls.protocols.pathName}?token=${token}`, '-c', 'copy', '-progress', 'pipe:1', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, samples: 0, stderr: '' };
    child.stdout.on('data', bytes => { state.samples += bytes.length; });
    child.stderr.on('data', () => undefined);
    children.push(child); return state;
  }
  const one = reader(tokenOne), two = reader(tokenTwo);
  phase = 'readers';
  await wait(async () => await p.mediaReaderIdentity.count({ where: { cameraId: shared.id } }) >= 2 && one.samples > 0 && two.samples > 0, 'real_readers');
  const before = await p.camera.findUniqueOrThrow({ where: { id: exclusive.id } });
  const previousRecording = await call(`/cameras/${exclusive.id}/recording/status`);
  const suspended = await webhook(event('SUSPENSO', { acao: 'alterar_status' }));
  phase = 'suspension';
  await call('/auth/me', 'GET', activeLogin.accessToken, undefined, 401);
  await call('/auth/refresh', 'POST', null, { refreshToken: activeLogin.refreshToken }, 401);
  await wait(async () => (await call(`/integrations/v1/sgp/operations/${suspended.operation_id}`, 'GET', key)).status === 'COMPLETE', 'suspension_confirmation');
  await wait(async () => await p.mediaReaderIdentity.count({ where: { userId: customer.userId } }) === 0 && one.child.exitCode !== null, 'exact_reader_revocation');
  const samples = two.samples;
  await delay(1500);
  check(two.child.exitCode === null && two.samples > samples, 'other_customer_video_preserved');
  const paused = await p.camera.findUniqueOrThrow({ where: { id: exclusive.id } });
  check(!paused.enabled && paused.integrationEnabledBeforeBlock === true && paused.recordingMode === before.recordingMode && paused.recordingEnabled === before.recordingEnabled, 'camera_policy_preserved');
  check(!(await call(`/cameras/${exclusive.id}/recording/status`)).isRecording, 'recording_stopped');
  if (previousRecording.pid) {
    let alive = true; try { process.kill(previousRecording.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    check(!alive, 'actual_recording_process_stopped');
  }
  check((await p.camera.findUniqueOrThrow({ where: { id: shared.id } })).enabled, 'shared_camera_not_stopped');
  const replay = await webhook(activeEvent);
  check(replay.repeated && (await p.sgpCustomer.findUniqueOrThrow({ where: { id: customer.id } })).state === 'SUSPENDED', 'old_duplicate_cannot_reactivate');
  const old = await webhook({ ...activeEvent, data: new Date(initialTime - 1000).toISOString() });
  check(old.status === 'IGNORED', 'older_event_ignored');
  const reactivated = await webhook(event('ATIVO', { acao: 'alterar_status' }));
  phase = 'reactivation';
  await wait(async () => (await call(`/integrations/v1/sgp/operations/${reactivated.operation_id}`, 'GET', key)).status === 'COMPLETE', 'reactivation_confirmation');
  check((await p.camera.findUniqueOrThrow({ where: { id: exclusive.id } })).enabled, 'exclusive_restored');
  check(!(await p.camera.findUniqueOrThrow({ where: { id: disabled.id } })).enabled, 'disabled_not_resurrected');
  await wait(async () => { const s = await call(`/cameras/${exclusive.id}/recording/status`); return s.isRecording && s.pid > 0; }, 'recording_resumed');
  check((await login('52998224725', chosen)).accessToken, 'reactivation_preserves_password');
  const concurrent = [event('ATIVO', { acao: 'atualizar' }), event('ATIVO', { acao: 'atualizar' })];
  phase = 'concurrent';
  const parallel = await Promise.all(concurrent.map(value => webhook(value)));
  check(parallel.every(value => value.customer_status === 'ACTIVE'), 'concurrent_events');
  const microTime = new Date(initialTime + sequence++ * 10).toISOString();
  const microOne = event('ATIVO', { acao: 'atualizar', data: microTime.replace(/(\.\d{3})Z$/, (_, fraction) => fraction + '001Z') });
  const microTwo = { ...microOne, data: microTime.replace(/(\.\d{3})Z$/, (_, fraction) => fraction + '002Z') };
  const firstMicro = await webhook(microOne), secondMicro = await webhook(microTwo);
  check(microOne.data !== microTwo.data && firstMicro.operation_id !== secondMicro.operation_id && !secondMicro.repeated, 'microseconds_distinct');
  const additional = event('ATIVO', { servico: { id: 'service-additional', status: 'ATIVO', plano: { id: '10' } }, contrato: { id: 'additional-contract' } });
  await webhook(additional);
  const partlySuspended = await webhook(event('SUSPENSO', { acao: 'alterar_status' }));
  check(partlySuspended.customer_status === 'ACTIVE', 'another_active_service_keeps_access');
  await webhook(event('ATIVO', { acao: 'alterar_status' }));
  const preservedCount = await p.recording.count({ where: { cameraId: exclusive.id } });
  await call('/integrations/v1/sgp/customers/client-one', 'DELETE', key);
  check((await call('/integrations/v1/sgp/customers/client-one', 'DELETE', key)).repeated, 'archive_idempotent');
  await webhook(event(), key, null, 409);
  await call('/integrations/v1/sgp/customers/client-one/restore', 'POST', key);
  check(await p.camera.count({ where: { id: { in: [exclusive.id, disabled.id, shared.id] } } }) === 3, 'archive_preserves_cameras');
  check(await p.recording.count({ where: { cameraId: exclusive.id } }) >= preservedCount, 'archive_preserves_recordings');
  const newestKey = (await call(`/integrations/sgp/${integration.id}/key`, 'POST', input.adminToken, undefined, 201)).key;
  await call('/integrations/v1/sgp/customers/client-one', 'GET', key, undefined, 401);
  await call('/integrations/v1/sgp/customers/client-one', 'GET', newestKey);
  await call(`/integrations/sgp/${integration.id}`, 'PATCH', input.adminToken, { ...configuration, enabled: false });
  await webhook(event(), newestKey, null, 401);
  console.log(JSON.stringify({ realHttpAndPostgres: true, initialPasswordRequired: true, passwordPreserved: true, deduplicationConflictRejected: true, staleEventsIgnored: true, integrationIsolation: true, liveReaderRevoked: true, sharedViewerPreserved: true, actualRecordingStoppedAndResumed: true, cameraSettingsRestored: true, disabledCameraPreserved: true, archivePreservesData: true, keyRotationAndDisable: true, publicOpenApi: true, concurrentEvents: true, microsecondOrdering: true, multipleServices: true }));
})().catch(error => { console.error(/^sgp_failed_[a-z0-9_]+$/i.test(error.message) ? error.message : 'sgp_failed_unexpected_' + phase + '_' + String(error.name).replace(/[^a-z0-9]/gi, '')); process.exitCode = 1; }).finally(async () => { for (const child of children) child.kill('SIGKILL'); await p.$disconnect(); });
