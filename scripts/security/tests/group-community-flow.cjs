// Only run inside the disposable compatibility lab: no real devices or pushes.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');
const { randomBytes } = require('node:crypto');
const p = new PrismaClient(), ids = [], groupIds = [];
const root = 'http://127.0.0.1:3000';
let phase = 'setup';
const jwt = new JwtService({ secret: process.env.JWT_SECRET });
async function call(path, token, method = 'GET', body) {
  const r = await fetch(root + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
(async () => {
  const admin = await p.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } }).catch(() => p.user.findFirstOrThrow({ where: { role: 'ADMIN' } }));
  const users = [];
  for (const name of ['Alice', 'Bob', 'Outro']) {
    const user = await p.user.create({ data: { name, username: 'community-' + randomBytes(8).toString('hex'), passwordHash: 'synthetic-never-used-for-login', role: 'VIEWER' } });
    ids.push(user.id); users.push(user);
  }
  const sign = user => jwt.sign({ sub: user.id, username: user.username, email: user.email ?? user.username, role: user.role, ver: user.authVersion, type: 'access' }, { expiresIn: '180s' });
  const [a, b, outsider] = users.map(sign), adminToken = sign(admin);
  const shared = await p.cameraGroup.create({ data: { name: 'Lab community shared' } }); groupIds.push(shared.id);
  const single = await p.cameraGroup.create({ data: { name: 'Lab community single' } }); groupIds.push(single.id);
  await p.cameraPermission.createMany({ data: [{ userId: users[0].id, groupId: shared.id, level: 'VIEW' }, { userId: users[1].id, groupId: shared.id, level: 'VIEW' }, { userId: users[0].id, groupId: single.id, level: 'VIEW' }] });
  await assert.rejects(p.cameraPermission.create({ data: { userId: users[0].id, groupId: single.id, level: 'CONTROL' } }));
  for (const token of [a, adminToken]) {
    phase = 'eligible_group_list';
    const r = await call('/group-community', token); assert.equal(r.status, 200);
    assert.equal(r.data.items.some(g => g.id === single.id), false);
    const group = r.data.items.find(g => g.id === shared.id); assert.equal(group.memberCount, 2);
    assert.deepEqual(Object.keys(group).sort(), ['id', 'memberCount', 'name']);
  }
  phase = 'isolation';
  assert.equal((await call('/group-community', outsider)).data.items.some(g => groupIds.includes(g.id)), false);
  assert.equal((await call(`/groups/${shared.id}/messages`, outsider)).status, 403);
  assert.equal((await call(`/groups/${single.id}/messages`, a)).status, 403);
  assert.equal((await call('/groups/not-a-uuid/messages', a)).status, 400);
  phase = 'text';
  const text = await call(`/groups/${shared.id}/messages`, a, 'POST', { texto: ' Olá   grupo ' }); assert.equal(text.status, 201); assert.equal(text.data.body, 'Olá grupo'); assert.equal(text.data.user.id, users[0].id);
  const read = await call(`/groups/${shared.id}/messages`, b); assert.equal(read.data.items[0].id, text.data.id);
  assert.equal((await call(`/groups/${shared.id}/messages`, a, 'POST', { texto: ' ' })).status, 400);
  phase = 'concurrent_panic';
  const alerts = await Promise.all([call(`/groups/${shared.id}/alert`, a, 'POST', {}), call(`/groups/${shared.id}/alert`, b, 'POST', {})]);
  assert.ok(alerts.every(r => r.status === 201)); assert.deepEqual(alerts.map(r => r.data.pushStatus).sort(), ['cooldown', 'no_devices']);
  assert.ok(alerts.every(r => r.data.enviadoPara === 0)); assert.equal(await p.groupMessage.count({ where: { groupId: shared.id, kind: 'ALERT' } }), 2);
  phase = 'suspension';
  await p.cameraGroup.update({ where: { id: shared.id }, data: { accessStatus: 'SUSPENDED' } });
  for (const [method, path, body] of [['GET', 'messages'], ['POST', 'messages', { texto: 'não' }], ['POST', 'alert', {}]]) assert.equal((await call(`/groups/${shared.id}/${path}`, a, method, body)).status, 403);
  assert.equal((await call('/group-community', a)).data.items.some(g => g.id === shared.id), false);
  await p.cameraGroup.update({ where: { id: shared.id }, data: { accessStatus: 'ACTIVE' } });
  phase = 'inactive_and_revoked';
  await p.user.update({ where: { id: users[1].id }, data: { isActive: false } });
  assert.equal((await call('/group-community', a)).data.items.some(g => g.id === shared.id), false);
  await p.user.update({ where: { id: users[1].id }, data: { isActive: true } });
  await p.cameraPermission.deleteMany({ where: { groupId: shared.id, userId: users[1].id } });
  assert.equal((await call(`/groups/${shared.id}/messages`, a)).status, 403);
  assert.equal(await p.groupMessage.count({ where: { groupId: shared.id } }), 3);
  console.log(JSON.stringify({ realHttpAndPostgres: true, distinctActiveMembersOnly: true, implicitAdminNotCounted: true, groupIsolation: true, suspensionEnforced: true, inactiveUserNotCounted: true, membershipRevocationEnforced: true, authorReturned: true, concurrentPanicSerialized: true, noDevicesReportedHonestly: true, noRealPushSent: true }));
})().catch(e => { console.error(JSON.stringify({ phase, error: e.message })); process.exitCode = 1; }).finally(async () => {
  await p.groupMessage.deleteMany({ where: { groupId: { in: groupIds } } });
  await p.cameraPermission.deleteMany({ where: { groupId: { in: groupIds } } });
  await p.cameraGroup.deleteMany({ where: { id: { in: groupIds } } });
  await p.user.deleteMany({ where: { id: { in: ids } } });
  await p.$disconnect();
});
