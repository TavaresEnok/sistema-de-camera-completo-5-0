// Runs inside the existing isolated browser/test container. Only temporary
// client credentials arrive on stdin; the shared TURN key never enters Chrome.
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const config = JSON.parse(input);
  const chrome = spawn('/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1',
    '--disable-gpu', '--user-data-dir=/tmp/drac-turn-ice-probe', 'about:blank'], { stdio: 'ignore' });
  let socket;
  let stage = 'launch';
  try {
    let target;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' });
        target = await response.json(); break;
      } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('browser unavailable');
    stage = 'debugger';
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error('browser protocol error')); else resolve(msg.result);
    }};
    const call = (method, params) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params }));
    });
    for (const url of config.urls) {
      stage = 'gather:' + url;
      const expression = `(async () => {
        const pc = new RTCPeerConnection({iceTransportPolicy:'relay',iceServers:[${JSON.stringify({ urls: url, username: config.username, credential: config.credential })}]});
        const candidates = []; const errors = [];
        const done = new Promise(resolve => { pc.onicecandidate = event => {
          if (!event.candidate) resolve(); else candidates.push({type:event.candidate.type,protocol:event.candidate.protocol});
        }; pc.onicecandidateerror = event => errors.push(event.errorCode); setTimeout(resolve, 10000); });
        try { pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer()); await done;
          return {relayCandidates:candidates.filter(c=>c.type==='relay').length,errors};
        } finally { pc.close(); }
      })()`;
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error('ICE probe evaluation failed');
      console.log(JSON.stringify({ url, ...result.result.value }));
      if (!result.result.value?.relayCandidates) process.exitCode = 1;
    }
  } catch (error) { console.error('TURN browser probe failed at ' + stage + ' (' + error.name + ')'); process.exitCode = 1; }
  finally { socket?.close(); chrome.kill('SIGTERM'); }
});
