'use strict';

const READY = 'DRAC_REMOTE_READY_20261002';
const SUDO_PROMPT = 'DRAC_REMOTE_SUDO_20261002';

// Only a static bootstrap goes into SSH exec/argv. Password and installer
// environment travel over the encrypted stream after privilege escalation.
function launchCommand(username) {
  const shell = `bash --noprofile --norc -c 'printf "${READY}\\n"; exec bash --noprofile --norc'`;
  return username === 'root' ? shell : `sudo -S -p '${SUDO_PROMPT}' ${shell}`;
}

function secretLog(write, secrets = []) {
  const values=secrets.filter(Boolean); const keep=Math.max(1,...values.map(x=>x.length))-1;
  let pending='';
  const redact=text=>values.reduce((out,key)=>out.split(key).join('••••••'),text);
  return {push(chunk){pending=redact(pending+String(chunk));if(pending.length>keep){write(pending.slice(0,pending.length-keep));pending=pending.slice(pending.length-keep);}},
    flush(){if(pending)write(redact(pending));pending='';}};
}

function deliverInstaller(stream, {username, password, script, onLog, onFailure, readyMs = 30000}) {
  let pending = '', started = false, supplied = false, closed = false;
  const timer = setTimeout(() => {
    if (!started && !closed) { onFailure('O acesso administrativo não respondeu em 30 segundos.'); stream.close(); }
  }, readyMs);
  timer.unref?.();
  function consume(chunk) {
    pending += String(chunk);
    if (!started) {
      if (pending.includes(SUDO_PROMPT)) {
        pending = pending.replaceAll(SUDO_PROMPT, '');
        if (supplied) { onFailure('A senha não foi aceita pelo sudo.'); stream.close(); return; }
        supplied = true;
        stream.write(password + '\n');
      }
      if (pending.includes(READY)) {
        pending = pending.replace(READY, '');
        started = true; clearTimeout(timer);
        onLog('>> acesso administrativo confirmado; executando instalador…\n');
        stream.end('set +x\nset -Eeuo pipefail\n' + script + '\n');
      }
    }
    // Keep a suffix so split bootstrap markers are never mistaken for output.
    const keep = started ? 0 : Math.max(READY.length, SUDO_PROMPT.length);
    if (pending.length > keep) { onLog(pending.slice(0, pending.length - keep)); pending = pending.slice(pending.length - keep); }
  }
  stream.on('data', consume);
  stream.stderr.on('data', consume);
  stream.on('close', () => { closed = true; clearTimeout(timer); if (pending) onLog(pending); });
  return {get started() {return started;}, get suppliedPassword() {return supplied;}};
}

module.exports = {launchCommand, deliverInstaller, secretLog, READY, SUDO_PROMPT};
