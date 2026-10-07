import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SHA = /^[0-9a-f]{40}$/i;
function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error((result.stderr || 'Falha ao consultar a versão do aplicativo.').trim());
  return result.stdout.trim();
}

export function ensureApprovedCommit(repo, commit, vendorSource = '') {
  if (!SHA.test(commit)) throw new Error('Versão aprovada inválida.');
  try { git(repo, ['cat-file', '-e', `${commit}^{commit}`]); return; } catch { /* import below */ }
  // Production releases can be signed locally before their source is on GitHub.
  // Import ONLY the full commit requested by the Central, never vendor HEAD.
  if (vendorSource) {
    try {
      const source = fs.realpathSync(vendorSource);
      git(source, ['cat-file', '-e', `${commit}^{commit}`]);
      git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', source,
        `${commit}:refs/s2cam/vendor-runtime/${commit.toLowerCase()}`]);
      git(repo, ['cat-file', '-e', `${commit}^{commit}`]);
      return;
    } catch { /* remote fallback remains pinned to the requested commit */ }
  }
  git(repo, ['fetch', '--quiet', '--prune', 'origin']);
  git(repo, ['cat-file', '-e', `${commit}^{commit}`]);
}

// An OS flock held by an inherited pipe. Process death closes the pipe and
// automatically releases the lock; cleanup and builds cannot race.
export function acquireBuildLease(worktreesRoot, { nonBlocking = false } = {}) {
  fs.mkdirSync(worktreesRoot, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const holder = spawn('flock', [...(nonBlocking ? ['-n', '-E', '75'] : []), '-x', path.join(worktreesRoot, '.maintenance.lock'),
      'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let acquired = false;
    holder.stdin.on('error', () => undefined);
    holder.on('error', reject);
    holder.once('exit', code => {
      if (!acquired) {
        const error = new Error(code === 75 ? 'Compilação ativa; limpeza adiada.' : 'Não foi possível proteger a compilação.');
        error.cleanupBusy = code === 75;
        reject(error);
      }
    });
    holder.stdout.once('data', () => {
      acquired = true;
      resolve(() => new Promise(done => { holder.once('exit', done); holder.stdin.end(); }));
    });
  });
}

export function retainedCommits(jobs, approved, keep = 2) {
  const retained = new Set(approved.map(value => String(value).toLowerCase()));
  const successful = new Map();
  for (const job of [...jobs].reverse()) {
    const commit = String(job.sourceCommit || '').toLowerCase();
    if (!SHA.test(commit)) continue;
    if (['building', 'queued'].includes(job.status)) retained.add(commit);
    if (job.status !== 'done') continue;
    const list = successful.get(job.slug) || new Set();
    if (list.size < keep) { list.add(commit); retained.add(commit); }
    successful.set(job.slug, list);
  }
  return retained;
}

export function planCleanup({ repo, worktrees, jobs, approved, now = Date.now(), minAgeMs = 86400000 }) {
  const root = fs.realpathSync(worktrees);
  const repoPath = fs.realpathSync(repo);
  if (root !== path.resolve(worktrees) || root === '/' || root === repoPath || root === path.dirname(repoPath)) {
    throw new Error('Diretório de compilação inseguro.');
  }
  if (!approved.length || approved.some(value => !SHA.test(value))) throw new Error('Versão aprovada obrigatória.');
  const retained = retainedCommits(jobs, approved);
  const registered = new Map();
  for (const block of git(repo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const location = block.match(/^worktree (.+)$/m)?.[1];
    const head = block.match(/^HEAD ([0-9a-f]{40})$/m)?.[1];
    if (location && head && !/^locked/m.test(block)) registered.set(path.resolve(location), head);
  }
  const result = { candidates: [], preserved: [] };
  for (const name of fs.readdirSync(root)) {
    if (!SHA.test(name)) continue;
    const target = path.join(root, name);
    const stat = fs.lstatSync(target);
    let reason;
    if (!stat.isDirectory() || stat.isSymbolicLink() || registered.get(target) !== name.toLowerCase()) reason = 'not_registered_or_unsafe';
    else if (retained.has(name.toLowerCase())) reason = 'approved_recent_or_active';
    else {
      const recent = jobs.filter(job => String(job.sourceCommit).toLowerCase() === name.toLowerCase())
        .map(job => Date.parse(job.finishedAt || job.startedAt || job.queuedAt || '')).filter(Number.isFinite);
      const lastUsed = Math.max(stat.mtimeMs, ...recent);
      if (now - lastUsed < minAgeMs) reason = 'less_than_24_hours';
      else {
        // Keep any source edits. Only client copies are known build-generated
        // data, with their originals retained outside the disposable worktree.
        const dirty = git(target, ['status', '--porcelain', '--untracked-files=all', '--', '.',
          ':(exclude)apps/mobile/clients/**', ':(exclude)apps/mobile/android/**',
          ':(exclude)apps/mobile/.expo/**', ':(exclude)node_modules/**']);
        if (dirty) reason = 'source_changes_preserved';
      }
    }
    if (reason) result.preserved.push({ commit: name, reason });
    else result.candidates.push({ commit: name, path: target });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let release;
  try {
    const { values } = parseArgs({ options: {
      repo: { type: 'string' }, worktrees: { type: 'string' }, state: { type: 'string' },
      approved: { type: 'string', multiple: true, default: [] }, apply: { type: 'boolean', default: false },
    } });
    const { repo, worktrees, state, approved, apply } = values;
    if (!repo || !worktrees || !state) throw new Error('Argumentos obrigatórios ausentes.');
    if (apply) release = await acquireBuildLease(worktrees, { nonBlocking: true });
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (!Array.isArray(saved.jobs)) throw new Error('Histórico de compilação inválido; limpeza cancelada.');
    const plan = planCleanup({ repo, worktrees, jobs: saved.jobs, approved });
    console.log(JSON.stringify({ apply, ...plan }));
    if (apply) for (const candidate of plan.candidates) {
      git(repo, ['worktree', 'remove', '--force', candidate.path]);
      console.log(JSON.stringify({ removed: candidate.commit, recoverableFromGit: true }));
    }
  } catch (error) { console.error(error.message); process.exitCode = error.cleanupBusy ? 75 : 1; }
  finally { if (release) await release(); }
}
