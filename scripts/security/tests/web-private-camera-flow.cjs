// Runs only inside test-live-compat-runtime.py's fresh disposable API/database.
// Credentials are received through stdin and never printed or written to disk.
const fs = require('fs');
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = 'http://127.0.0.1:3000';
  const request = async (path, token, method = 'GET', body) => {
    const r = await fetch(root + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: r.status, data };
  };
  const expect = (condition, name) => { if (!condition) throw Error('private_flow_' + name); };
  const login = await request('/auth/login', null, 'POST', { username: 'labadmin', password: input.password });
  expect(login.status === 201, 'admin_login');
  const admin = login.data.accessToken;
  const users = {};
  for (const username of ['privacyowner', 'privacynewowner', 'privacydelegate', 'privacyoutsider']) {
    const created = await request('/users', admin, 'POST', { username, name: username, role: 'VIEWER', password: input.password });
    expect(created.status === 201, 'create_user_' + created.status);
    const auth = await request('/auth/login', null, 'POST', { username, password: input.password });
    expect(auth.status === 201, 'user_login');
    users[username] = { id: created.data.id, token: auth.data.accessToken };
  }
  const owner = users.privacyowner, nextOwner = users.privacynewowner, delegate = users.privacydelegate, outsider = users.privacyoutsider;
  const options = await request('/cameras/privacy-users', admin);
  expect(options.status === 200 && options.data.some(u => u.id === owner.id), 'user_options');
  expect(options.data.every(u => Object.keys(u).every(k => ['id', 'name', 'username'].includes(k))), 'minimal_user_options');
  expect((await request('/cameras/privacy-users', outsider.token)).status === 403, 'no_user_enumeration');
  const payload = { name: 'Browser private push', sourceMode: 'rtmp_push', isPrivate: true, ownerUserId: owner.id, privateViewerIds: [delegate.id], recordingEnabled: false, recordingMode: 'manual', aiEnabled: false };
  for (const isPrivate of ['true', 'false', null]) expect((await request('/cameras', admin, 'POST', { ...payload, isPrivate })).status === 400, 'strict_boolean');
  expect((await request('/cameras', admin, 'POST', { ...payload, ownerUserId: undefined })).status === 400, 'owner_required');
  expect((await request('/cameras', outsider.token, 'POST', payload)).status === 403, 'no_viewer_creation');
  const created = await request('/cameras', admin, 'POST', payload);
  expect(created.status === 201 && created.data.isPrivate && created.data.ownerUserId === owner.id, 'rtmp_creation_' + created.status);
  const id = created.data.id;
  const key = created.data.rtmpIngest.streamKey;
  const fromRtsp = await request('/cameras', admin, 'POST', { name: 'Browser private pull', ip: input.mediaIp, rtspPort: 8554, httpPort: 80, username: '', password: '', rtspPath: '/fixture-healthy', recordingMode: 'manual', recordingEnabled: false, aiEnabled: false, isPrivate: true, ownerUserId: owner.id });
  expect(fromRtsp.status === 201 && fromRtsp.data.isPrivate, 'rtsp_creation_' + fromRtsp.status);
  const snapshot = async cameraId => (await request('/cameras/' + cameraId, admin)).data;
  const privateState = await snapshot(id);
  expect(privateState.canView === false && privateState.privateViewerIds.includes(delegate.id), 'admin_metadata_not_content');
  for (const actor of [owner, delegate]) expect((await request('/camera-stream/' + id + '/token', actor.token, 'POST', {})).status === 201, 'authorized_stream_token');
  for (const token of [admin, outsider.token]) expect((await request('/camera-stream/' + id + '/token', token, 'POST', {})).status === 403, 'private_stream_denied');
  const oldToken = (await request('/camera-stream/' + id + '/token', delegate.token, 'POST', {})).data.streamToken;
  const mediaAuth = async (cameraId, token) => request('/camera-stream/mediamtx-auth?internalToken=' + encodeURIComponent(process.env.MEDIAMTX_AUTH_CALLBACK_TOKEN), null, 'POST', { action: 'read', path: 'cam_' + cameraId.replaceAll('-', '') + '_grid', token });
  expect((await mediaAuth(id, oldToken)).status === 200, 'current_delegate_media');
  const change = async (cameraId, body, previous) => {
    const state = previous || await snapshot(cameraId);
    return request('/cameras/' + cameraId, admin, 'PATCH', { ...body, privacyConfirmed: true, expectedUpdatedAt: state.updatedAt, expectedPrivacyRevision: state.privacyRevision });
  };
  const removed = await change(id, { privateViewerIds: [] });
  expect(removed.status === 200 && removed.data.privacyApplyStatus === 'applied', 'remove_delegate_' + removed.status);
  expect((await mediaAuth(id, oldToken)).status === 401, 'old_token_rejected');
  expect((await request('/camera-stream/' + id + '/poster?token=' + encodeURIComponent(oldToken), null)).status === 403, 'old_poster_token_rejected');
  // A group, even ADMIN, must not open private content.
  const group = await request('/camera-groups', admin, 'POST', { name: 'Privacy group' });
  expect(group.status === 201, 'group_created');
  expect((await request('/camera-permissions', admin, 'POST', { userId: outsider.id, groupId: group.data.id, level: 'ADMIN' })).status === 201, 'group_granted');
  expect((await request('/cameras/' + id, admin, 'PATCH', { groupId: group.data.id })).status === 200, 'group_linked');
  expect((await request('/camera-stream/' + id + '/token', outsider.token, 'POST', {})).status === 403, 'group_not_private_content');
  const common = (await request('/cameras', admin)).data.find(c => c.name === 'healthy');
  expect((await request('/camera-permissions', admin, 'POST', { userId: outsider.id, cameraId: common.id, level: 'VIEW' })).status === 201, 'common_individual_access');
  const commonToken = (await request('/camera-stream/' + common.id + '/token', outsider.token, 'POST', {})).data.streamToken;
  expect((await change(common.id, { isPrivate: true, ownerUserId: owner.id, privateViewerIds: [] })).status === 200, 'common_to_private');
  expect((await mediaAuth(common.id, commonToken)).status === 401, 'old_common_token_denied');
  const transferred = await change(id, { ownerUserId: nextOwner.id, privateViewerIds: [] });
  expect(transferred.status === 200 && transferred.data.ownerUserId === nextOwner.id, 'ownership_transfer');
  expect((await request('/camera-stream/' + id + '/token', owner.token, 'POST', {})).status === 403, 'former_owner_denied');
  expect((await request('/camera-stream/' + id + '/token', nextOwner.token, 'POST', {})).status === 201, 'next_owner_allowed');
  const stale = await snapshot(id);
  expect((await request('/camera-permissions', admin, 'POST', { userId: delegate.id, cameraId: id, level: 'VIEW' })).status === 201, 'concurrent_grant');
  expect((await change(id, { privateViewerIds: [] }, stale)).status === 409, 'stale_permissions_rejected');
  const liveState = await snapshot(id);
  expect((await request('/cameras/' + id, admin, 'PATCH', { isPrivate: false })).status === 400, 'confirmation_required');
  expect((await change(id, { isPrivate: false })).status === 200, 'restore_common');
  const after = await snapshot(id);
  const afterIngest = await request('/cameras/' + id + '/rtmp-ingest', admin);
  expect(after.ownerUserId === null && !after.isPrivate && after.recordingMode === 'manual' && after.recordingEnabled === false, 'recording_unchanged');
  expect(afterIngest.data.streamKey === key, 'ingest_key_unchanged');
  // Restore the fixture used by the six real compatibility probes below.
  expect((await change(common.id, { isPrivate: false })).status === 200, 'fixture_restored');
  console.log(JSON.stringify({ webPrivateFlow: true, rtspAndRtmp: true, minimalUserOptions: true, ownerAndSelectedViewerOnly: true, adminAndGroupContentDenied: true, oldStreamAndPosterTokensDenied: true, formerOwnerDenied: true, stalePermissionEditRejected: true, explicitConfirmationRequired: true, recordingAndIngestPreserved: true, realDatabaseAndHTTP: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
