'use strict';

const path = require('node:path');
const { PgStore } = require('./pg-store');
const { mergeDb } = require('./dual-read');
const { writeSigningBackup } = require('./signing-backup');
const { TimeseriesStore, NoopTimeseriesStore } = require('./timeseries-store');
const { JsonInstanceLock } = require('./singleton-lock');
const { DEFAULT_RAW_RETENTION_HOURS, DEFAULT_HOURLY_RETENTION_DAYS, toNumber } = require('./timeseries');

// Orquestrador do datastore da Central. Escolhe o backend por env e expõe a MESMA
// interface load()/save(db) do server.js legado, para trocar de backend sem mexer
// na lógica de rotas (hardening de corrupção/atômico/.bak do JSON fica intacto e
// é reusado como fonte legada read-only).
//
// Modos (item 2.10):
//   json  → só JSON (comportamento atual; DEFAULT sem DATABASE_URL).
//   dual  → modo transitório explícito; pode ressuscitar exclusões do legado.
//   pg    → só Postgres (DEFAULT seguro após a reconciliação automática).

function resolveConfig(env = process.env) {
  // SOMENTE a variável específica da Central. Aceitar o `DATABASE_URL` genérico era
  // perigoso: a stack DRAC exporta DATABASE_URL para a API, então a Central subindo
  // nesse ambiente trocaria de datastore SOZINHA (modo dual) apontando para o banco
  // do VMS — troca silenciosa do painel mestre. Migração para Postgres é decisão
  // explícita: exige DRAC_CENTRAL_DATABASE_URL.
  const databaseUrl = String(env.DRAC_CENTRAL_DATABASE_URL || '').trim();
  let mode = String(env.DRAC_CENTRAL_STORE_MODE || '').trim().toLowerCase();
  if (!databaseUrl) {
    // Sem URL, só há o JSON. Um modo pg/dual pedido sem URL cai p/ json (com aviso).
    if (mode === 'pg' || mode === 'dual') {
      console.warn('[central] DRAC_CENTRAL_STORE_MODE pede Postgres mas DRAC_CENTRAL_DATABASE_URL está vazio — usando JSON.');
    }
    mode = 'json';
  } else if (!['json', 'dual', 'pg'].includes(mode)) {
    mode = 'pg';
  }
  if (databaseUrl && mode === 'dual' && String(env.DRAC_CENTRAL_ALLOW_DUAL_READ || '').toLowerCase() !== 'true') {
    console.warn('[central] modo dual recusado sem DRAC_CENTRAL_ALLOW_DUAL_READ=true — usando pg para preservar exclusões.');
    mode = 'pg';
  }
  const dataFile = path.resolve(process.cwd(), env.DRAC_CENTRAL_DATA_FILE || './data/installations.json');
  const backupDir = String(env.DRAC_CENTRAL_BACKUP_DIR || '').trim()
    ? path.resolve(process.cwd(), env.DRAC_CENTRAL_BACKUP_DIR)
    : path.join(path.dirname(dataFile), 'backups');
  return { databaseUrl, mode, dataFile, backupDir, timeseries: resolveTimeseriesConfig(env, mode) };
}

// Série temporal: só existe COM Postgres. O arquivo JSON não pode receber uma
// amostra a cada 60s (é o mesmo arquivo que já corrompeu e derrubou a Central),
// então em modo json o histórico longo fica DESLIGADO e a Central segue com o
// histórico curto de sempre. Com Postgres liga por padrão; `=false` desliga.
function resolveTimeseriesConfig(env = process.env, mode = 'json') {
  const flag = String(env.DRAC_CENTRAL_TIMESERIES_ENABLED || '').trim().toLowerCase();
  const usesPg = mode === 'dual' || mode === 'pg';
  const enabled = usesPg && flag !== 'false' && flag !== '0' && flag !== 'off';
  const positive = (value, fallback) => {
    const n = toNumber(value);
    return n !== null && n > 0 ? n : fallback;
  };
  return {
    enabled,
    rawRetentionHours: positive(env.DRAC_CENTRAL_TIMESERIES_RAW_HOURS, DEFAULT_RAW_RETENTION_HOURS),
    hourlyRetentionDays: positive(env.DRAC_CENTRAL_TIMESERIES_HOURLY_DAYS, DEFAULT_HOURLY_RETENTION_DAYS),
    maintenanceIntervalMs: positive(env.DRAC_CENTRAL_TIMESERIES_MAINTENANCE_MINUTES, 30) * 60 * 1000,
  };
}

// legacy = { load, save } (o loadDb/saveDb do server.js). store = PgStore (injetável
// para teste). config = resolveConfig(). Em modo json, é um passthrough puro.
function createDatastore({ legacy, config, store } = {}) {
  const cfg = config || resolveConfig();
  const usesPg = cfg.mode === 'dual' || cfg.mode === 'pg';
  const pg = usesPg ? (store || new PgStore({ connectionString: cfg.databaseUrl })) : null;
  const jsonLock = !usesPg ? new JsonInstanceLock(`${cfg.dataFile}.instance.lock`) : null;
  // Série temporal: real só quando há Postgres E a flag não foi desligada.
  // Sem isso (o DEFAULT), é o NO-OP silencioso — nenhuma consulta, nenhum log.
  const tsConfig = cfg.timeseries || resolveTimeseriesConfig(process.env, cfg.mode);
  const timeseries = pg && tsConfig.enabled
    ? new TimeseriesStore({
      pgStore: pg,
      rawRetentionHours: tsConfig.rawRetentionHours,
      hourlyRetentionDays: tsConfig.hourlyRetentionDays,
    })
    : new NoopTimeseriesStore();
  if (timeseries.enabled) timeseries.maintenanceIntervalMs = tsConfig.maintenanceIntervalMs;

  let initPromise = null;
  let cachedPgDb = null;
  async function ensureInit() {
    if (!usesPg) return;
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  // Roda UMA vez: cria schema, faz BACKUP das identidades de assinatura ANTES de
  // migrar, então reconcilia (backfill do legado). O marker `migration` no meta
  // impede repetir backup/migração a cada start.
  async function doInit() {
    await pg.initSchema();
    const already = await pg.getMeta('migration');
    if (already) return already;
    const legacyDb = legacy ? await legacy.load() : { installations: {}, users: {}, sessions: {}, auditEvents: [] };
    const backup = await writeSigningBackup(legacyDb, cfg.backupDir);
    const result = await pg.migrateFromLegacy(legacyDb);
    const marker = {
      at: new Date().toISOString(),
      inserted: result.inserted,
      backupFile: backup.file,
      backupCounts: backup.payload.counts,
    };
    await pg.setMeta('migration', marker);
    console.log(`[central] migração JSON→Postgres: ${result.inserted} registros reconciliados; backup de assinatura em ${backup.file}`);
    return marker;
  }

  async function load() {
    if (!usesPg) return legacy.load();
    await ensureInit();
    if (!cachedPgDb) {
      const pgDb = await pg.readAll();
      if (cfg.mode === 'pg') cachedPgDb = pgDb;
      else {
        // dual: JSON legado (read-only) preenche somente na carga inicial.
        const legacyDb = legacy ? await legacy.load() : {};
        cachedPgDb = mergeDb(pgDb, legacyDb);
      }
    }
    return structuredClone(cachedPgDb);
  }

  async function save(db) {
    if (!usesPg) return legacy.save(db);
    await ensureInit();
    // Com lock singleton, somente este processo escreve o documento. Persistir
    // o diff evita reler e regravar a frota inteira em cada heartbeat/GET.
    if (cachedPgDb && typeof pg.writeDiff === 'function') await pg.writeDiff(cachedPgDb, db);
    else await pg.writeAll(db);
    cachedPgDb = structuredClone(db);
  }

  async function close() {
    if (jsonLock) await jsonLock.release();
    if (pg) await pg.close();
  }

  async function acquireInstanceLock() {
    if (pg) return pg.acquireInstanceLock();
    return jsonLock.acquire();
  }

  return {
    mode: cfg.mode,
    config: cfg,
    load,
    save,
    ensureInit,
    acquireInstanceLock,
    close,
    store: pg,
    timeseries,
  };
}

module.exports = {
  resolveConfig,
  resolveTimeseriesConfig,
  createDatastore,
  PgStore,
  TimeseriesStore,
  NoopTimeseriesStore,
};
