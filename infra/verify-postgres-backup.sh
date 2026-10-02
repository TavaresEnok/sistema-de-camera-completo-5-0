#!/bin/sh
set -eu

interval="${POSTGRES_BACKUP_VERIFY_INTERVAL_SECONDS:-86400}"
retry_interval="${POSTGRES_BACKUP_VERIFY_RETRY_SECONDS:-60}"
initial_delay="${POSTGRES_BACKUP_VERIFY_INITIAL_DELAY_SECONDS:-900}"
verify_db="${POSTGRES_BACKUP_VERIFY_DB:-vms_restore_verify}"

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

cleanup() {
  dropdb --if-exists --force -h postgres -U "$POSTGRES_USER" "$verify_db" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

verify_dump() {
  cleanup
  pg_restore --list "$1" >/dev/null || return 1
  createdb -h postgres -U "$POSTGRES_USER" "$verify_db" || return 1
  pg_restore --exit-on-error --no-owner --no-privileges \
    -h postgres -U "$POSTGRES_USER" -d "$verify_db" "$1" >/dev/null || return 1
  migrations="$(psql -h postgres -U "$POSTGRES_USER" -d "$verify_db" -Atc \
    'select count(*) from "_prisma_migrations" where finished_at is not null' 2>/dev/null)" || return 1
  [ "$migrations" -gt 0 ] || return 1
  # A dump taken before the clean install's migrations is not a valid backup.
  tables="$(psql -h postgres -U "$POSTGRES_USER" -d "$verify_db" -Atc \
    "select count(*) from information_schema.tables where table_schema='public' and table_name in ('User','Camera','Recording','RolePermission')" 2>/dev/null)" || return 1
  [ "$tables" -eq 4 ] || return 1
}

sleep "$initial_delay"
while true; do
  latest="$(find /backups -maxdepth 1 -type f -name 'drac-postgres-*.dump' -print | sort | tail -n 1)"
  if [ -z "$latest" ]; then
    echo "$(date -u +%FT%TZ) backup_verify=no_dump"
  else
    if ! verify_dump "$latest"; then
      cleanup
      touch /tmp/last-failed
      echo "$(date -u +%FT%TZ) backup_restore_verify=failed reason=restore_or_schema_incomplete file=$(basename "$latest")"
      sleep "$retry_interval"
      continue
    fi
    cleanup
    touch /tmp/last-ok
    echo "$(date -u +%FT%TZ) backup_restore_verify=ok file=$(basename "$latest") migrations=$migrations"
  fi
  sleep "$interval"
done
