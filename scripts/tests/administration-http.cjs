/* Executar apenas dentro da API de laboratório, com banco descartável. */
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
if (process.env.ADMINISTRATION_TEST_ISOLATED !== 'true' || new URL(process.env.DATABASE_URL).hostname !== 'admin-audit-db') {
  throw new Error('Este teste exige o banco isolado admin-audit-db. Nunca executar em produção.');
}
const db = new PrismaClient();
const password = 'Synthetic-Administration-2026';
let checks = 0;
async function call(path, token, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:3000/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function main() {
  const hash = await bcrypt.hash(password, 4);
  const root = await db.user.create({ data: { username: 'audit-root', name: 'Audit root', passwordHash: hash, role: 'SUPER_ADMIN' } });
  const admin = await db.user.create({ data: { username: 'audit-admin', name: 'Audit admin', passwordHash: hash, role: 'ADMIN' } });
  const viewer = await db.user.create({ data: { username: 'audit-viewer', name: 'Audit viewer', passwordHash: hash, role: 'VIEWER' } });
  const group = await db.cameraGroup.create({ data: { name: 'Audit group A' } });
  const destination = await db.cameraGroup.create({ data: { name: 'Audit group B' } });
  const makeCamera = (name, extra = {}) => db.camera.create({ data: { name, ip: '127.0.0.1', username: 'synthetic', passwordEncrypted: 'synthetic-cipher', groupId: group.id, enabled: false, recordingEnabled: false, aiEnabled: false, alarmsEnabled: false, ...extra } });
  const allowed = await makeCamera('Permitida');
  await makeCamera('Não permitida');
  const privateCamera = await makeCamera('Particular', { isPrivate: true, ownerUserId: admin.id });
  await db.cameraPermission.create({ data: { userId: viewer.id, cameraId: allowed.id, level: 'VIEW' } });
  const login = async (username) => {
    const response = await call('auth/login', null, 'POST', { username, password });
    assert.equal(response.status, 201); return response.data.accessToken;
  };
  const rootToken = await login(root.username), adminToken = await login(admin.username), viewerToken = await login(viewer.username);
  const list = await call('camera-groups', viewerToken);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.deepEqual(list.data[0].cameras.map((c) => c.id), [allowed.id]);
  for (const c of list.data[0].cameras) assert.equal('passwordEncrypted' in c || 'username' in c || 'ip' in c, false);
  checks++;
  const detail = await call(`camera-groups/${group.id}`, viewerToken);
  assert.equal(detail.status, 200); assert.equal(detail.data.cameras.length, 1); checks++;
  const rootGroups = await call('camera-groups', rootToken);
  assert.equal(rootGroups.data.find((g) => g.id === group.id).cameras.some((c) => c.id === privateCamera.id), false); checks++;
  await db.cameraPermission.create({ data: { userId: viewer.id, groupId: group.id, level: 'VIEW' } });
  const own = await call(`camera-permissions?userId=${viewer.id}`, viewerToken);
  assert.equal(own.status, 200); assert.equal(own.data.some((p) => p.groupId === group.id), true); checks++;
  const foreign = await call(`camera-permissions?userId=${admin.id}`, viewerToken);
  assert.deepEqual(foreign.data, []); checks++;
  const settings = await call('settings', rootToken);
  const invalid = await call('settings', rootToken, 'PATCH', { facilityName: 'Não deve salvar', brandPrimaryColor: 'invalid' });
  assert.equal(invalid.status, 400); assert.equal((await call('settings', rootToken)).data.facilityName, settings.data.facilityName); checks++;
  const saved = await call('settings', rootToken, 'PATCH', { brandPrimaryColor: '#bb00aa', systemPrimaryColor: '#0055aa' });
  assert.equal(saved.status, 200); assert.equal(saved.data.brandPrimaryColor, '#bb00aa'); assert.equal(saved.data.systemPrimaryColor, '#0055aa'); checks++;
  const move = await call(`camera-groups/${destination.id}/cameras/${allowed.id}`, rootToken, 'POST');
  assert.equal(move.status, 409); checks++;
  const confirmed = await call(`camera-groups/${destination.id}/cameras/${allowed.id}`, rootToken, 'POST', { expectedGroupId: group.id });
  assert.equal(confirmed.status, 201); assert.equal((await db.camera.findUnique({ where: { id: allowed.id } })).groupId, destination.id); checks++;
  assert.equal((await call(`camera-groups/${destination.id}/cameras/${privateCamera.id}`, rootToken, 'POST', { expectedGroupId: group.id })).status, 409); checks++;
  const matrix = await call('role-permissions', rootToken);
  const restricted = { ...matrix.data.roles.ADMIN, userManage: false };
  assert.equal((await call('role-permissions/ADMIN', rootToken, 'PATCH', { permissions: restricted })).status, 200);
  assert.equal((await call(`users/${viewer.id}`, adminToken, 'PATCH', { name: 'Bloqueado' })).status, 403); checks++;
  assert.equal((await call('camera-permissions', adminToken, 'POST', { userId: viewer.id, groupId: destination.id, level: 'VIEW' })).status, 403); checks++;
  assert.equal((await call('role-permissions/SUPER_ADMIN', rootToken, 'PATCH', { permissions: matrix.data.roles.SUPER_ADMIN })).status, 400); checks++;
  console.log(JSON.stringify({ administrationHttpChecks: checks, result: 'passed', database: 'isolated' }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
