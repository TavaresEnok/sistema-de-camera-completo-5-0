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
  const admin = input.adminToken;
  expect(typeof admin === 'string' && admin.length > 20, 'admin_login');
  const users = {};
  const testPassword = 'Aa1!' + input.password;
  for (const username of ['privacyowner', 'privacynewowner', 'privacydelegate', 'privacyoutsider']) {
    const created = await request('/users', admin, 'POST', { username, email: username + '@example.invalid', name: username, role: 'VIEWER', password: testPassword });
    if (created.status !== 201) {
      const detail = String(created.data?.message ?? '');
      const fields = ['username', 'email', 'name', 'role', 'password', 'group', 'limit'].filter(field => detail.toLowerCase().includes(field)).join('_') || 'other';
      throw Error('private_flow_create_user_' + created.status + '_' + fields);
    }
    const auth = await request('/auth/login', null, 'POST', { username, password: testPassword });
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
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  const recording = await db.recording.create({ data: { cameraId: id, startedAt: new Date(Date.now() - 60_000), endedAt: new Date(), filePath: '/storage/recordings/private-test.mp4', durationSeconds: 60, sizeBytes: 1n } });
  const event = await db.cameraEvent.create({ data: { cameraId: id, type: 'MOTION_DETECTED', severity: 'INFO', message: 'Controlled privacy fixture', occurredAt: new Date() } });
  await db.camera.update({ where: { id }, data: { motionNoticeEnabled: true } });
  const since = encodeURIComponent(new Date(Date.now() - 20_000).toISOString());
  expect((await request('/recordings/' + recording.id + '/play-token', owner.token, 'POST', {})).status === 201, 'owner_playback');
  const playToken = (await request('/recordings/' + recording.id + '/play-token', delegate.token, 'POST', {})).data.playToken;
  for (const token of [admin, outsider.token]) {
    expect((await request('/recordings/' + recording.id + '/play-token', token, 'POST', {})).status === 403, 'recording_denied');
    expect((await request('/cameras/events?cameraId=' + id, token)).status === 403, 'events_denied');
    const notices = await request('/cameras/detection-notices?since=' + since, token);
    expect(notices.status === 200 && !notices.data.items.some(item => item.cameraId === id), 'private_notice_hidden');
  }
  const ownerNotices = await request('/cameras/detection-notices?since=' + since, owner.token);
  expect(ownerNotices.status === 200 && ownerNotices.data.items.some(item => item.id === event.id), 'owner_notice_visible');
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
  expect((await request('/recordings/' + recording.id + '/play?token=' + encodeURIComponent(playToken), null)).status === 403, 'old_play_token_rejected');
  await db.camera.update({ where: { id }, data: { motionNoticeEnabled: false } });
  // A group, even ADMIN, must not open private content.
  const group = await request('/camera-groups', admin, 'POST', { name: 'Privacy group' });
  expect(group.status === 201, 'group_created');
  expect((await request('/camera-permissions', admin, 'POST', { userId: outsider.id, groupId: group.data.id, level: 'ADMIN' })).status === 201, 'group_granted');
  expect((await request('/cameras/' + id, admin, 'PATCH', { groupId: group.data.id })).status === 200, 'group_linked');
  expect((await request('/camera-stream/' + id + '/token', outsider.token, 'POST', {})).status === 403, 'group_not_private_content');
  const common = (await request('/cameras', admin)).data.find(c => c.name === 'healthy');
  expect((await request('/camera-permissions', admin, 'POST', { userId: outsider.id, cameraId: common.id, level: 'VIEW' })).status === 201, 'common_individual_access');
  const commonToken = (await request('/camera-stream/' + common.id + '/token', outsider.token, 'POST', {})).data.streamToken;
  expect((await request('/camera-stream/' + common.id + '/urls?viewMode=grid', outsider.token)).status === 200, 'common_live_prepared');
  const publicPath = 'cam_' + common.id.replaceAll('-', '') + '_grid';
  const { spawn } = require('child_process');
  const reader = spawn('ffmpeg', ['-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', 'rtsp://mediamtx:8554/' + publicPath, '-c', 'copy', '-t', '120', '-f', 'null', '-'], { stdio: 'ignore' });
  let readerClosed = false;
  reader.on('close', () => { readerClosed = true; });
  try {
    let active = false;
    for (let index = 0; index < 30; index++) {
      const r = await fetch('http://mediamtx:9997/v3/paths/get/' + publicPath);
      const path = await r.json();
      if ((path.readers ?? []).some(item => item.type === 'rtspSession')) { active = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(active, 'real_rtsp_viewer_connected');
  expect((await change(common.id, { isPrivate: true, ownerUserId: owner.id, privateViewerIds: [] })).status === 200, 'common_to_private');
    for (let index = 0; index < 20 && !readerClosed; index++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(readerClosed, 'real_rtsp_viewer_revoked');
  } finally { if (!readerClosed) reader.kill('SIGTERM'); }
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
  expect(await db.recording.count({ where: { id: recording.id } }) === 1, 'existing_recording_preserved');
  // Restore the fixture used by the six real compatibility probes below.
  expect((await change(common.id, { isPrivate: false })).status === 200, 'fixture_restored');
  await db.$disconnect();
  console.log(JSON.stringify({ webPrivateFlow: true, rtspAndRtmp: true, minimalUserOptions: true, ownerAndSelectedViewerOnly: true, adminAndGroupContentDenied: true, oldStreamAndPosterTokensDenied: true, playbackAndNoticesPrivate: true, oldPlaybackTokenDenied: true, realRtspViewerRevoked: true, formerOwnerDenied: true, stalePermissionEditRejected: true, explicitConfirmationRequired: true, recordingAndIngestPreserved: true, realDatabaseAndHTTP: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
