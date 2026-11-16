import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { groupRecorderProfiles, recorderPath } from '../src/recorders/recorder-channel.helper';
test('keeps all 32 sources and never pairs main/sub from different channels', () => {
  const profiles = Array.from({ length: 32 }, (_, index) => {
    const channel = index + 1;
    return [
      { token: `main${channel}`, sourceToken: `source${channel}`, width: 1920, height: 1080, rtspPath: `/Streaming/Channels/${channel}01` },
      { token: `sub${channel}`, sourceToken: `source${channel}`, width: 640, height: 360, rtspPath: `/Streaming/Channels/${channel}02` },
    ];
  }).flat();
  const rows = groupRecorderProfiles(profiles);
  assert.equal(rows.length, 32);
  for (const row of rows) { assert.equal(row.mainToken, `main${row.channel}`); assert.equal(row.profiles, 2); }
});
test('ambiguous profiles are not guessed as channels', () => {
  assert.deepEqual(groupRecorderProfiles([{ token: 'unknown', width: 1920, rtspPath: '/stream' }]), []);
});
test('manual paths cannot replace the registered network target', () => {
  for (const path of ['rtsp://elsewhere/stream', '//elsewhere/stream', '/stream\r\nHost: bad']) assert.throws(() => recorderPath('generic', 1, path));
  assert.throws(() => recorderPath('generic', 1));
  assert.equal(recorderPath('hikvision', 12), '/Streaming/Channels/1201');
  assert.equal(recorderPath('intelbras', 12), '/cam/realmonitor?channel=12&subtype=0');
});
