import { ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { isManagedLivePublisher } from './transcode-admission.helper';

export class LiveCapacityException extends ServiceUnavailableException {
  constructor() {
    const message = 'Capacidade de visualização ocupada. Feche algumas câmeras para abrir esta. Tentaremos novamente em instantes.';
    super({
      error: 'live_capacity_reached',
      message,
      userMessage: message,
      retryAfterSeconds: 30,
    });
  }
}

/** Accounts for container quotas as well as the VM's available CPU affinity. */
export function effectiveLiveCpus(affinity: number, quota?: string): number {
  const [amount, period] = String(quota ?? '').trim().split(/\s+/).map(Number);
  const bounded = amount > 0 && period > 0 ? Math.min(affinity, amount / period) : affinity;
  return Math.max(0.25, Number.isFinite(bounded) ? bounded : 1);
}

export function liveCapacityDefaults() {
  let quota = '';
  try { quota = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8'); } catch { /* non-cgroup host */ }
  const cores = effectiveLiveCpus(os.availableParallelism(), quota);
  // Three weighted points per CPU allows a 6x6 grid of small H.265 streams on
  // a 30-core installation (36 × cost 2 = 72), while reserving headroom for
  // recording/AI. Runtime pressure still closes admission at 75% host load.
  return { cores, processes: Math.max(2, Math.floor(cores * 4)), points: Math.max(2, Math.floor(cores * 3)) };
}

export type LivePressure = { cpuPercent: number; availableMemory: number; totalMemory: number; loadRatio?: number };

/** Whole-host load includes recordings, AI and database, not just this API. */
export class LivePressureSampler {
  private readonly cores = liveCapacityDefaults().cores;
  private previous = this.cpuTimes();
  private current: LivePressure = { cpuPercent: 0, availableMemory: os.freemem(), totalMemory: os.totalmem() };

  private cpuTimes() {
    return os.cpus().reduce((sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }), { idle: 0, total: 0 });
  }

  sample(): LivePressure {
    const next = this.cpuTimes();
    const elapsed = next.total - this.previous.total;
    let availableMemory = os.freemem();
    try {
      const match = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (match) availableMemory = Number(match[1]) * 1024;
    } catch { /* portable conservative fallback */ }
    this.current = {
      cpuPercent: elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (next.idle - this.previous.idle) / elapsed))) : this.current.cpuPercent,
      availableMemory,
      totalMemory: os.totalmem(),
      loadRatio: os.loadavg()[0] / this.cores,
    };
    this.previous = next;
    return this.current;
  }

  snapshot(): LivePressure { return this.current; }
}

/** One reservation per source/output path, shared by all tabs and monitors.
 * reserve is synchronous: concurrent HTTP calls cannot oversubscribe a snapshot.
 * Kernel locks in the media container remain the final cross-process guard.
 */
export class LiveCapacityBudget {
  private readonly pending = new Map<string, { cost: number; expires: number }>();
  private readonly costs = new Map<string, number>();

  register(path: string, cost: number) { this.costs.set(path, cost); }
  costFor(path: string) { return this.costs.get(path) ?? 4; }

  reserve(path: string, cost: number, runtime: any[], limits: { processes: number; points: number }, pressure: LivePressure, now = Date.now()): void {
    for (const [key, value] of this.pending) if (value.expires <= now) this.pending.delete(key);
    const active = new Map(runtime.filter(isManagedLivePublisher).map((item) => [String(item.name), this.costs.get(item.name) ?? 4]));
    // An additional viewer never adds an encoder or evicts the existing viewer.
    if (runtime.some((item) => item.name === path && item.ready) || this.pending.has(path) || cost <= 0) return;
    for (const [key, value] of this.pending) if (!active.has(key)) active.set(key, value.cost);
    const usedPoints = [...active.values()].reduce((sum, value) => sum + value, 0);
    const memoryReserve = Math.max(512 * 1024 * 1024, pressure.totalMemory * 0.1);
    if (active.size >= limits.processes || usedPoints + cost > limits.points
      || pressure.cpuPercent >= 75 || (pressure.loadRatio ?? 0) >= 0.75 || pressure.availableMemory < memoryReserve) {
      throw new LiveCapacityException();
    }
    this.pending.set(path, { cost, expires: now + 30_000 });
  }
}
