'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

class JsonInstanceLock {
  constructor(lockFile) {
    this.lockFile = path.resolve(lockFile);
    this.handle = null;
  }

  async acquire() {
    if (this.handle) return;
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    let handle;
    try {
      handle = await fs.open(this.lockFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // Só recupera automaticamente quando é possível provar que o dono era
        // deste mesmo host e o PID já não existe. Host diferente permanece
        // fail-closed, pois pode ser outra instância legítima em volume comum.
        try {
          const owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
          if (owner?.hostname === os.hostname() && Number.isInteger(owner?.pid)) {
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (probeError) {
              alive = probeError?.code !== 'ESRCH';
            }
            if (!alive) {
              await fs.rm(this.lockFile);
              handle = await fs.open(this.lockFile, 'wx', 0o600);
            }
          }
        } catch { /* lock ilegível permanece fail-closed */ }
        if (handle) {
          // Recuperação comprovada do lock órfão.
        } else {
        const lockError = new Error(
          `Outra instância da DRAC Central já possui ${this.lockFile}. ` +
          'Se o processo anterior terminou de forma não limpa, confirme que ele está parado antes de remover somente esse lock.',
        );
        lockError.code = 'CENTRAL_INSTANCE_LOCKED';
        throw lockError;
        }
      }
      if (!handle) throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      }), { encoding: 'utf8' });
      await handle.sync();
      this.handle = handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(this.lockFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async release() {
    if (!this.handle) return;
    const handle = this.handle;
    this.handle = null;
    await handle.close().catch(() => undefined);
    await fs.rm(this.lockFile, { force: true });
  }
}

module.exports = { JsonInstanceLock };
