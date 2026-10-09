const fs = require('node:fs');
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = [];
  const cases = [
    { name: 'manual_5540', payload: { rtspPort: 5540, rtspPortMode: 'manual', rtspPath: '/fixture-healthy' }, ok: true, port: 5540 },
    { name: 'automatic_5540_onvif', payload: { rtspPort: 554, rtspPortMode: 'automatic' }, ok: true, port: 5540 },
    { name: 'password_refused', payload: { rtspPort: 9554, rtspPortMode: 'manual', rtspPath: '/fixture-healthy' }, failure: 'auth_denied' },
    { name: 'http_is_not_video', payload: { rtspPort: 554, rtspPortMode: 'manual' }, failure: 'not_rtsp' },
    { name: 'closed_manual_port', payload: { rtspPort: 9555, rtspPortMode: 'manual' }, failure: 'unreachable' },
    { name: 'invalid_mode', payload: { rtspPort: 554, rtspPortMode: 'anything' }, status: 400 },
  ];
  for (const c of cases) {
    const started = Date.now();
    const r = await fetch('http://127.0.0.1:3000/cameras/mine/test-connection', {
      method: 'POST', headers: { Authorization: 'Bearer ' + input.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: input.fixtureIp, username: 'lab', password: 'lab', httpPort: 8000, ...c.payload }),
      signal: AbortSignal.timeout(70000),
    });
    const result = await r.json();
    const durationMs = Date.now() - started;
    if (r.status !== (c.status ?? 201) || (c.ok && (result.rtspAuthOk !== true || result.status !== 'ONLINE' || result.detectedRtspPort !== c.port || result.detectedStream?.width !== 640))
      || (c.failure && (result.failureCode !== c.failure || result.rtspAuthOk !== false)) || durationMs >= 65000) {
      console.error('camera_setup_' + c.name + '_failed_' + r.status + '_' + (result.failureCode ?? 'none'));
      process.exitCode = 1; return;
    }
    results.push({ name: c.name, status: r.status, durationMs, port: result.detectedRtspPort ?? null, failure: result.failureCode ?? null });
  }
  console.log(JSON.stringify({ actualHttpController: true, actualFfprobeVideo: true, syntheticVideo: true, cases: results }));
})().catch(() => { console.error('camera_setup_flow_failed'); process.exitCode = 1; });
