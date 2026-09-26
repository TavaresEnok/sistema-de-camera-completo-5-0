import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(__dirname, '../../..');
const updateScript = readFileSync(resolve(repositoryRoot, 'scripts/update-drac.sh'), 'utf8');
const restoreScript = readFileSync(resolve(repositoryRoot, 'scripts/restore-drac.sh'), 'utf8');
const apiDockerfile = readFileSync(resolve(repositoryRoot, 'apps/api/Dockerfile'), 'utf8');
const apiEntrypoint = readFileSync(resolve(repositoryRoot, 'apps/api/docker-entrypoint.sh'), 'utf8');
const compose = readFileSync(resolve(repositoryRoot, 'infra/docker-compose.yml'), 'utf8');
const readinessScript = readFileSync(resolve(repositoryRoot, 'scripts/production-readiness.sh'), 'utf8');
const promoteScript = readFileSync(resolve(repositoryRoot, 'scripts/promover-release.sh'), 'utf8');

test('API aplica migrações antes de iniciar mesmo fora do script oficial', () => {
  assert.match(apiDockerfile, /docker-entrypoint\.sh/);
  assert.match(apiEntrypoint, /prisma migrate deploy/);
  assert.ok(
    apiEntrypoint.indexOf('prisma migrate deploy') < apiEntrypoint.indexOf('exec node dist\/main\.js'),
    'migração precisa ocorrer antes do processo HTTP',
  );
  assert.match(compose, /3000\/health\/ready/);
});

test('update mantém writers quiescentes durante rollback transacional', () => {
  assert.match(updateScript, /stop "\$\{APP_SERVICES\[@\]\}"/);
  assert.match(updateScript, /--exit-on-error --single-transaction/);
  assert.doesNotMatch(updateScript, /pg_restore[^\n]*\|\| true/);
  assert.match(updateScript, /ROLLBACK INCOMPLETO/);
});

test('update reporta o commit implantado e não sobe a Central em tenants', () => {
  assert.match(updateScript, /DEPLOY_COMMIT="\$\(git -C "\$ROOT_DIR" rev-parse HEAD\)"/);
  assert.match(updateScript, /env_set DRAC_VERSION "\$DEPLOY_COMMIT"/);
  assert.match(updateScript, /APP_SERVICES=\(api web\)/);
  assert.match(updateScript, /APP_SERVICES\+=\(drac-central\)/);
  assert.doesNotMatch(updateScript, /(?:build|stop|up -d) api web drac-central/);
});

test('update aguarda API e Web iniciarem antes de considerar o deploy quebrado', () => {
  assert.match(updateScript, /wait_for_http\(\)/);
  assert.match(updateScript, /for attempt in \$\(seq 1 "\$attempts"\)/);
  assert.match(updateScript, /wait_for_http GET http:\/\/127\.0\.0\.1:3000\/health\/ready API/);
  assert.ok(updateScript.includes('wait_for_http HEAD "$(web_health_url)" Web'));
});

test('update não confunde readiness em Atenção com falha que exige rollback', () => {
  assert.match(
    updateScript,
    /readiness_status=0\s+"\$ROOT_DIR\/scripts\/production-readiness\.sh" \|\| readiness_status=\$\?/,
  );
  assert.match(updateScript, /if \[ "\$readiness_status" -ge 2 \]/);
  assert.doesNotMatch(
    updateScript,
    /set \+e\s+"\$ROOT_DIR\/scripts\/production-readiness\.sh"/,
    'ERR trap dispara mesmo com set +e; o comando deve estar protegido por ||',
  );
});

test('update bloqueia a migration histórica quando ainda existem gravações duplicadas', () => {
  assert.match(updateScript, /preflight_recording_duplicates/);
  assert.match(updateScript, /20260501042000_recordings_indexes/);
  assert.match(updateScript, /GROUP BY \\"filePath\\"/);
  assert.match(updateScript, /recusou a deleção arbitrária por ctid/);
});

test('readiness não transforma auto-start em gravação contínua para todas as câmeras', () => {
  assert.match(
    readinessScript,
    /enabled = true and "recordingMode" = '\\''continuous'\\''/,
    'o dimensionamento precisa considerar somente câmeras realmente contínuas',
  );
  assert.match(readinessScript, /nenhuma camera esta configurada em modo continuo/i);
  assert.doesNotMatch(
    readinessScript,
    /if \[ "\$\{RECORDING_AUTO_START_ENABLED:-false\}" = "true" \] \|\| \[ "\$\{continuous_count:-0\}" -gt 0 \]/,
    'auto-start sozinho não pode tornar obrigatório o storage de todas as câmeras',
  );
});

test('restore valida dump e archive antes de marcar o ambiente como mutado', () => {
  const scratch = restoreScript.indexOf('validate_dump_in_scratch_database /tmp/drac-restore-input.dump');
  const archive = restoreScript.indexOf('validate_storage_archive "$STORAGE_ARCHIVE"');
  const mutated = restoreScript.indexOf('RESTORE_MUTATED=true');
  assert.ok(scratch >= 0 && scratch < mutated);
  assert.ok(archive >= 0 && archive < mutated);
  assert.match(restoreScript, /--exit-on-error --single-transaction/);
});

test('restore recusa traversal/links e preserva banco e storage para rollback', () => {
  assert.match(restoreScript, /Archive de storage contém caminho absoluto ou traversal/);
  assert.match(restoreScript, /Archive de storage contém link ou arquivo especial/);
  assert.match(restoreScript, /postgres-before\.dump/);
  assert.match(restoreScript, /storage-before/);
  assert.match(restoreScript, /ROLLBACK INCOMPLETO/);
  assert.match(restoreScript, /api web drac-central ai-service camera-worker/);
});

test('promoção vincula o hash do instalador ao mesmo artefato aprovado', () => {
  assert.match(promoteScript, /DRAC_CENTRAL_INSTALLER_SHA256/);
  assert.match(promoteScript, /\^\[0-9a-fA-F\]\{64\}\$/);
  assert.match(promoteScript, /"installerSha256": installer_sha256/);
});
