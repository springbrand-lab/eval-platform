#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

test "${EVAL_TEST_DATA_REFRESH:-}" = all-test-data-authorized
[[ "${REFRESH_RUN_ID:-}" =~ ^[0-9]+$ ]]
[[ "${EXPECTED_IMAGE_TAG:-}" =~ ^[0-9a-f]{40}$ ]]
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
api=eval-platform-api-1
worker=eval-platform-run-worker-1
container_dir="/tmp/eval-test-refresh-$REFRESH_RUN_ID"
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
  docker exec "$api" rm -rf -- "$container_dir" >/dev/null 2>&1 || true
  docker exec "$worker" rm -rf -- "$container_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

api_image="$(docker inspect --format '{{.Config.Image}}' "$api")"
worker_image="$(docker inspect --format '{{.Config.Image}}' "$worker")"
test "$api_image" = "$worker_image"
test "${api_image##*:}" = "$EXPECTED_IMAGE_TAG"
test "$(docker inspect --format '{{.State.Running}}' "$api")" = true
test "$(docker inspect --format '{{.State.Running}}' "$worker")" = true
api_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/bundles"}}{{.Source}}{{end}}{{end}}' "$api")"
worker_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/bundles"}}{{.Source}}{{end}}{{end}}' "$worker")"
test -n "$api_mount"
test "$api_mount" = "$worker_mount"
printf 'Verified API and Worker image: %s\nShared Bundle volume: %s\n' "$api_image" "$api_mount"
for service in "$api" "$worker"; do
  docker exec "$service" node -e 'if(process.env.EVAL_BUNDLE_DIR!=="/data/bundles")process.exit(1)'
  docker exec "$service" mkdir -p "$container_dir"
done
docker cp "$task_root/." "$api:$container_dir" >/dev/null
operation="$container_dir/infra/aws/ops/refresh-test-data.mjs"
backup_parent=/opt/eval-platform/production/backups
if [[ -n "${VERIFY_BACKUP:-}" ]]; then
  [[ "$VERIFY_BACKUP" =~ ^/opt/eval-platform/production/backups/[0-9]{8}T[0-9]{6}Z-test-refresh-[A-Za-z0-9]{6}$ ]]
  backup_dir="$VERIFY_BACKUP"
  test -s "$backup_dir/receipt.json"
  (cd "$backup_dir" && sha256sum -c SHA256SUMS)
  printf 'Verifying completed refresh from backup: %s\n' "$backup_dir"
else
docker exec -e EVAL_TEST_DATA_REFRESH=all-test-data-authorized "$api" \
  node "$operation" --quiesce "$container_dir/inventory.json"

install -d -m 0700 "$backup_parent"
backup_dir="$(mktemp -d "$backup_parent/$(date -u +%Y%m%dT%H%M%SZ)-test-refresh-XXXXXX")"
docker cp "$api:$container_dir/inventory.json" "$backup_dir/inventory.json" >/dev/null
docker inspect "$api" | PG_ENV_PATH="$work_dir/postgres.env" python3 -c '
import json, os
from pathlib import Path
from urllib.parse import urlsplit, unquote
record=json.load(__import__("sys").stdin)[0]
env=dict(item.split("=",1) for item in record["Config"]["Env"] if "=" in item)
url=urlsplit(env["DATABASE_URL"])
if unquote(url.path.lstrip("/")) != "eval-platform": raise SystemExit("Unexpected backup database")
fields={"PGHOST":url.hostname,"PGPORT":str(url.port or 5432),"PGDATABASE":"eval-platform",
"PGUSER":unquote(url.username),"PGPASSWORD":unquote(url.password),"PGSSLMODE":"verify-full",
"PGSSLROOTCERT":"/etc/ssl/certs/aws-rds-global-bundle.pem"}
if any("\n" in value or "\r" in value for value in fields.values()): raise SystemExit("Invalid PostgreSQL environment")
Path(os.environ["PG_ENV_PATH"]).write_text("".join(name+"="+value+"\n" for name,value in fields.items()))
'
test -s /opt/eval-platform/production/rds-global-bundle.pem
docker pull --quiet postgres:18.3-alpine >/dev/null
postgres=(docker run --rm --network eval_default --env-file "$work_dir/postgres.env"
  --mount type=bind,src=/opt/eval-platform/production/rds-global-bundle.pem,dst=/etc/ssl/certs/aws-rds-global-bundle.pem,readonly
  --mount "type=bind,src=$backup_dir,dst=/backup" postgres:18.3-alpine)
"${postgres[@]}" pg_dump --format=custom --file=/backup/database.dump
"${postgres[@]}" pg_restore --list /backup/database.dump >/dev/null
docker exec "$api" tar -C /data/bundles -czf - . > "$backup_dir/bundles.tar.gz"
tar -tzf "$backup_dir/bundles.tar.gz" >/dev/null
(cd "$backup_dir" && sha256sum database.dump bundles.tar.gz inventory.json > SHA256SUMS)
printf 'Database and Bundle backups verified: %s\n' "$backup_dir"

docker exec -e EVAL_TEST_DATA_REFRESH=all-test-data-authorized "$api" \
  node "$operation" --apply "$container_dir/inventory.json" "$container_dir/receipt.json"
docker cp "$api:$container_dir/receipt.json" "$backup_dir/receipt.json" >/dev/null
fi
for service in "$api" "$worker"; do
  docker exec -i "$service" sh -c 'umask 077; cat > "$1"' sh "$container_dir/receipt.json" < "$backup_dir/receipt.json"
done
docker exec -e EVAL_TEST_DATA_REFRESH=all-test-data-authorized "$api" \
  node "$operation" --verify "$container_dir/receipt.json"
cat > "$work_dir/verify-bundles.mjs" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const receipt=JSON.parse(await readFile(process.argv[2],'utf8'));
const result=[];
for(const [kind,bundleId,count] of [['materials',receipt.materialBundleId,3],['sessions',receipt.sessionBundleId,2]]) {
  const directory=join(process.env.EVAL_BUNDLE_DIR,receipt.ownerUserId,bundleId,kind);
  const names=(await readdir(directory)).sort();
  assert.equal(names.length,count);
  for(const name of names) {
    assert.match(name,/^[0-9a-f-]{36}\.json$/);
    const bytes=await readFile(join(directory,name));
    JSON.parse(bytes.toString('utf8'));
    result.push({kind,name,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
}
console.log(JSON.stringify(result));
JS
for service in "$api" "$worker"; do
  docker exec -i "$service" node --input-type=module - "$container_dir/receipt.json" \
    < "$work_dir/verify-bundles.mjs" > "$work_dir/$service-bundles.json"
done
cmp "$work_dir/$api-bundles.json" "$work_dir/$worker-bundles.json"
cp "$work_dir/$api-bundles.json" "$backup_dir/verified-bundle-hashes.json"
printf 'Verified all 5 new resource manifests through API and Worker containers.\n'
cat "$backup_dir/receipt.json"
printf '\nCompleted disposable Eval input refresh. Backup: %s\n' "$backup_dir"
