const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

for (const failure of ['fetch', 'build', 'dump', 'migration', 'none']) {
  test(`update: falha ${failure} preserva checkpoint e fronteira de mutação`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drac-p0-update-'));
    try {
      fs.mkdirSync(path.join(dir, 'infra'));
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'infra/.env'), `MEDIAMTX_AUTH_CALLBACK_TOKEN=${'a'.repeat(48)}\n`);
      for (const name of ['docker', 'git', 'curl']) {
        fs.writeFileSync(path.join(dir, 'bin', name), `#!/bin/bash
printf '%s %s\\n' '${name}' "$*" >> "$LAB_LOG"
case '${name}' in
git)
  case "$*" in
    *status*) exit 0 ;;
    *rev-parse*) echo 1111111111111111111111111111111111111111 ;;
    *fetch*) [ "$LAB_FAILURE" != fetch ] ;;
  esac ;;
docker)
  case "$*" in
    inspect*) exit 1 ;;
    *' build '*) if [ "$LAB_FAILURE" = build ] && [ ! -f "$LAB_MARKER" ]; then touch "$LAB_MARKER"; exit 1; fi ;;
    *pg_dump*) [ "$LAB_FAILURE" != dump ] || exit 1; echo checkpoint ;;
    *'prisma migrate deploy'*) [ "$LAB_FAILURE" != migration ] || exit 1 ;;
    *'SELECT'*) echo already_applied ;;
  esac ;;
esac
`, { mode: 0o700 });
      }
      const log = path.join(dir, 'commands');
      const result = spawnSync('bash', [path.join(root, 'scripts/update-drac.sh')], {
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, DRAC_ROOT_DIR: dir,
          LAB_LOG: log, LAB_FAILURE: failure, LAB_MARKER: path.join(dir, 'failed-once') },
        encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.ok(fs.existsSync(log), result.stderr + result.stdout);
      const calls = fs.readFileSync(log, 'utf8');
      assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr + result.stdout);
      const restored = calls.includes('--clean --if-exists');
      assert.equal(restored, failure === 'migration', calls);
      if (['fetch', 'build'].includes(failure)) {
        assert.ok(!calls.includes('pg_dump'), calls);
        assert.ok(!calls.includes(' stop '), calls);
      } else {
        assert.ok(calls.indexOf(' stop ') < calls.indexOf('pg_dump'), calls);
      }
      if (failure === 'dump') assert.ok(!calls.includes('prisma migrate deploy'), calls);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('restore captura segurança somente após quiesce, antes de marcar mutação', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/restore-drac.sh'), 'utf8');
  const stop = source.indexOf('\nstop_writers\n');
  const dump = source.indexOf('\n  pg_dump');
  const mutated = source.indexOf('\nRESTORE_MUTATED=true');
  assert.ok(stop > 0 && stop < dump && dump < mutated);
  assert.ok(source.includes('if [ "$RESTORE_MUTATED" != "true" ]; then'));
});
