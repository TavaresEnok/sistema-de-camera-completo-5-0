import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireBuildLease, ensureApprovedCommit, retainedCommits, planCleanup } from '../scripts/build-maintenance.mjs';

const hash = number => number.toString(16).padStart(40, '0');
const runGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2cam-maintenance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); const worktrees = path.join(root, 'worktrees');
  fs.mkdirSync(repo); fs.mkdirSync(worktrees);
  runGit(repo, ['init', '-q']);
  runGit(repo, ['config', 'user.name', 'Maintenance Test']);
  runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  const commits = [];
  for (const n of [1, 2, 3, 4]) {
    fs.writeFileSync(path.join(repo, 'source.txt'), String(n));
    runGit(repo, ['add', 'source.txt']); runGit(repo, ['commit', '-qm', 'fixture ' + n]);
    commits.push(runGit(repo, ['rev-parse', 'HEAD']));
  }
  for (const commit of commits) runGit(repo, ['worktree', 'add', '-q', '--detach', path.join(worktrees, commit), commit]);
  return { root, repo, worktrees, commits };
}

test('retains approved, active and two distinct successful versions per customer', () => {
  const jobs = [
    { slug: 'vibe', sourceCommit: hash(1), status: 'done' },
    { slug: 'vibe', sourceCommit: hash(2), status: 'done' },
    { slug: 'vibe', sourceCommit: hash(3), status: 'done' },
    { slug: 'vibe', sourceCommit: hash(3), status: 'done' },
    { slug: 'ib', sourceCommit: hash(4), status: 'done' },
    { slug: 'ib', sourceCommit: hash(5), status: 'building' },
    { slug: 'dg', sourceCommit: hash(6), status: 'queued' },
  ];
  assert.deepEqual([...retainedCommits(jobs, [hash(7)])].sort(), [2, 3, 4, 5, 6, 7].map(hash));
});

test('dry-run preserves source edits, symlinks and approved directories', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.worktrees, f.commits[1], 'source.txt'), 'user edit');
  fs.symlinkSync(f.repo, path.join(f.worktrees, hash(99)));
  const plan = planCleanup({ ...f, jobs: [], approved: [f.commits[3]], minAgeMs: 0 });
  assert.deepEqual(plan.candidates.map(x => x.commit).sort(), [f.commits[0], f.commits[2]].sort());
  assert.ok(plan.preserved.some(x => x.reason === 'source_changes_preserved'));
  assert.ok(plan.preserved.some(x => x.reason === 'not_registered_or_unsafe'));
  assert.ok(fs.existsSync(path.join(f.worktrees, f.commits[0])));
});

test('recent worktrees and missing approval prevent deletion', t => {
  const f = fixture(t);
  assert.equal(planCleanup({ ...f, jobs: [], approved: [f.commits[3]] }).candidates.length, 0);
  assert.throws(() => planCleanup({ ...f, jobs: [], approved: [] }), /aprovada/);
  assert.throws(() => planCleanup({ ...f, worktrees: f.repo, jobs: [], approved: [f.commits[3]] }), /inseguro/);
});

test('approved commit is imported locally without moving the running agent HEAD', t => {
  const f = fixture(t); const target = path.join(f.root, 'target'); fs.mkdirSync(target);
  runGit(target, ['init', '-q']); runGit(target, ['fetch', '-q', f.repo, f.commits[0]]);
  runGit(target, ['checkout', '-q', '--detach', f.commits[0]]);
  ensureApprovedCommit(target, f.commits[3], f.repo);
  assert.equal(runGit(target, ['rev-parse', 'HEAD']), f.commits[0]);
  assert.equal(runGit(target, ['rev-parse', 'refs/s2cam/vendor-runtime/' + f.commits[3]]), f.commits[3]);
  assert.throws(() => ensureApprovedCommit(target, 'HEAD', f.repo), /inválida/);
});

test('OS lock skips cleanup during a build, then releases cleanly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2cam-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = await acquireBuildLease(root);
  try { await assert.rejects(acquireBuildLease(root, { nonBlocking: true }), /ativa/); }
  finally { await release(); }
  const again = await acquireBuildLease(root, { nonBlocking: true }); await again();
});

test('cleanup CLI removes only an old registered worktree and keeps external state', async t => {
  const f = fixture(t);
  for (const commit of f.commits) fs.utimesSync(path.join(f.worktrees, commit), new Date(0), new Date(0));
  const state = path.join(f.repo, 'state.json'); fs.writeFileSync(state, JSON.stringify({ jobs: [] }));
  const result = spawnSync(process.execPath, [new URL('../scripts/build-maintenance.mjs', import.meta.url).pathname,
    '--repo', f.repo, '--worktrees', f.worktrees, '--state', state, '--approved', f.commits[3], '--apply'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(state));
  assert.ok(fs.existsSync(path.join(f.worktrees, f.commits[3])));
  assert.ok(!fs.existsSync(path.join(f.worktrees, f.commits[0])));
});
