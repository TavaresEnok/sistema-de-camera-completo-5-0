import * as os from 'node:os';

type Times = { idle: number; total: number };
export type CpuUsage = { percent: number | null; sampledAt: string; windowMs: number };

export function cpuBusyPercent(before: Times, after: Times): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function readTimes(): Times {
  return os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

/** Uma amostra compartilhada entre clientes. Sem FFmpeg/processo/loop permanente. */
export class CpuUsageSampler {
  private cached?: CpuUsage;
  private cachedAt = 0;
  private pending?: Promise<CpuUsage>;

  constructor(
    private readonly read = readTimes,
    private readonly wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly now = Date.now,
  ) {}

  sample(): Promise<CpuUsage> {
    if (this.pending) return this.pending;
    if (this.cached && this.now() - this.cachedAt < 2000) return Promise.resolve(this.cached);
    this.pending = (async () => {
      const start = this.now();
      const before = this.read();
      await this.wait(1000);
      const after = this.read();
      const end = this.now();
      this.cached = { percent: cpuBusyPercent(before, after), sampledAt: new Date(end).toISOString(), windowMs: end - start };
      this.cachedAt = end;
      return this.cached;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
