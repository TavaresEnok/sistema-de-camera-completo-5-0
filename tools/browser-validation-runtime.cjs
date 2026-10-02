/** Close only the Chromium child owned by this diagnostic invocation. */
async function closeValidationBrowser(chrome, socket, options = {}) {
  const alive = () => chrome.exitCode === null && chrome.signalCode === null;
  const waitExit = ms => new Promise(resolve => {
    if (!alive()) return resolve();
    const done = () => { clearTimeout(timer); chrome.removeListener('exit', done); resolve(); };
    const timer = setTimeout(done, ms);
    chrome.once('exit', done);
  });
  if (alive() && socket?.readyState === 1) {
    try { socket.send(JSON.stringify({id:2147483647, method:'Browser.close'})); } catch {}
  }
  await waitExit(options.graceMs ?? 5000);
  if (alive()) chrome.kill('SIGTERM');
  await waitExit(options.termMs ?? 2000);
  if (alive()) chrome.kill('SIGKILL');
  await waitExit(options.killMs ?? 2000);
  socket?.close();
  // Let the invocation's tini subreaper collect exiting crashpad descendants.
  await new Promise(resolve => setTimeout(resolve, options.reapMs ?? 200));
  if (alive()) throw new Error('Owned diagnostic browser did not terminate');
}
module.exports = {closeValidationBrowser};
