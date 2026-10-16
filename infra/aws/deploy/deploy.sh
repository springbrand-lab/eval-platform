#!/usr/bin/env bash
# Runs on the EC2 instance (sent by dispatch.sh through Systems Manager).
set -Eeuo pipefail

for name in AWS_REGION ECR_REGISTRY ECR_REPOSITORY IMAGE_TAG APP_SECRET_ID DB_SECRET_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

if [[ -n "${REBUILD_DATABASE:-}" && "$REBUILD_DATABASE" != eval-platform ]]; then
  echo 'REBUILD_DATABASE must be empty or eval-platform' >&2
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="$(mktemp -d)"
services_stopped=false
rebuild_attempted=false
cleanup() {
  local result=$?
  if [[ "$services_stopped" == true && "$rebuild_attempted" == false ]]; then
    "${compose[@]}" start api run-worker || true
  fi
  rm -rf -- "$TEMP_DIR"
  exit "$result"
}
trap cleanup EXIT
umask 077
export DOCKER_CONFIG="$TEMP_DIR/docker-config"
install -d -m 0700 "$DOCKER_CONFIG"

# The API is reachable only through the cloudflared connector on Eval SP's compose network.
docker network inspect eval_default > /dev/null

aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$APP_SECRET_ID" \
  --query SecretString \
  --output text > "$TEMP_DIR/app-secret.json"
aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$DB_SECRET_ID" \
  --query SecretString \
  --output text > "$TEMP_DIR/database-secret.json"
curl -fsSLo "$TEMP_DIR/rds-global-bundle.pem" \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
grep -q -- "-----BEGIN CERTIFICATE-----" "$TEMP_DIR/rds-global-bundle.pem"
install -m 0644 "$TEMP_DIR/rds-global-bundle.pem" "$DEPLOY_DIR/rds-global-bundle.pem"

APP_SECRET_PATH="$TEMP_DIR/app-secret.json" \
DB_SECRET_PATH="$TEMP_DIR/database-secret.json" \
POSTGRES_ENV_PATH="$TEMP_DIR/postgres.env" \
python3 > "$TEMP_DIR/secrets.compose.json" <<'PY'
import json
import os
from pathlib import Path
from urllib.parse import quote

app = json.loads(Path(os.environ["APP_SECRET_PATH"]).read_text())
database = json.loads(Path(os.environ["DB_SECRET_PATH"]).read_text())

langfuse = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_ENVIRONMENT"]
evidence_r2 = [
    "EVAL_EVIDENCE_R2_ENDPOINT",
    "EVAL_EVIDENCE_R2_BUCKET",
    "EVAL_EVIDENCE_R2_ACCESS_KEY_ID",
    "EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY",
]
api_required = [
    "EVAL_SP_API_ORIGIN",
    "EVAL_SP_SERVICE_USER_ID",
    "EVAL_SP_SERVICE_SESSION_TOKEN",
    "EVAL_SP_ADMIN_TOKEN",
    "EVAL_WEB_ORIGIN",
    "EVAL_WEB_API_TOKEN",
    "EVAL_SP_SOURCE_BRANCH",
    "EVAL_SP_SOURCE_COMMIT",
    "EVAL_SP_AGENT_ORIGIN",
    "EVAL_SP_TRUSTED_ORIGIN",
]
worker_required = ["EVAL_SP_AGENT_ORIGIN", "EVAL_SP_SERVICE_TOKEN"]
missing = sorted({name for name in api_required + worker_required if not app.get(name)})
if missing:
    raise SystemExit("AWS app secret is missing: " + ", ".join(missing))

if database.get("dbname") != "eval-platform":
    raise SystemExit("Database secret must target eval-platform")
database_url = (
    "postgres://"
    + quote(database["username"], safe="")
    + ":"
    + quote(database["password"], safe="")
    + "@"
    + database["host"]
    + f":{database.get('port', 5432)}/"
    + quote(database["dbname"], safe="")
    + "?sslmode=verify-full&sslrootcert="
    + quote("/etc/ssl/certs/aws-rds-global-bundle.pem", safe="")
)

def pick(names):
    return {name: app[name] for name in names if app.get(name)}

postgres_env = {
    "PGHOST": database["host"], "PGPORT": str(database.get("port", 5432)),
    "PGDATABASE": database["dbname"], "PGUSER": database["username"],
    "PGPASSWORD": database["password"], "PGSSLMODE": "verify-full",
    "PGSSLROOTCERT": "/etc/ssl/certs/aws-rds-global-bundle.pem",
}
if any("\n" in value or "\r" in value for value in postgres_env.values()):
    raise SystemExit("PostgreSQL client environment values must be single-line")
Path(os.environ["POSTGRES_ENV_PATH"]).write_text("".join(name + "=" + value + "\n" for name, value in postgres_env.items()))

print(json.dumps({
    "services": {
        "api": {"environment": {"DATABASE_URL": database_url, **pick(api_required + langfuse)}},
        "run-worker": {"environment": {"DATABASE_URL": database_url, **pick(worker_required + evidence_r2 + langfuse)}},
    }
}))
PY

IMAGE_URI="$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
export IMAGE_URI AWS_REGION
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

compose=(docker compose -p eval-platform -f "$DEPLOY_DIR/compose.yaml" -f "$TEMP_DIR/secrets.compose.json")
"${compose[@]}" pull --quiet
if [[ "${REBUILD_DATABASE:-}" == eval-platform ]]; then
  docker pull --quiet postgres:18.3-alpine
  install -d -m 0700 "$DEPLOY_DIR/backups"
  backup_dir="$(mktemp -d "$DEPLOY_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
  postgres=(docker run --rm --network eval_default
    --env-file "$TEMP_DIR/postgres.env"
    --mount "type=bind,src=$DEPLOY_DIR/rds-global-bundle.pem,dst=/etc/ssl/certs/aws-rds-global-bundle.pem,readonly"
    --mount "type=bind,src=$DEPLOY_DIR/rebuild-once.sql,dst=/rebuild-once.sql,readonly"
    --mount "type=bind,src=$backup_dir,dst=/backup"
    postgres:18.3-alpine)
  "${postgres[@]}" psql -X --set=apply_rebuild=false --file=/rebuild-once.sql
  echo "Eval rebuild backup directory: $backup_dir"
  services_stopped=true
  "${compose[@]}" stop --timeout 30 api
  "${compose[@]}" stop --timeout 300 run-worker
  "${postgres[@]}" pg_dump --format=custom --file=/backup/database.dump
  "${postgres[@]}" pg_restore --file=/dev/null /backup/database.dump
  "${compose[@]}" run --rm --no-deps -T api tar -C /data/bundles -czf - . > "$backup_dir/bundles.tar.gz"
  "${postgres[@]}" tar -tzf /backup/bundles.tar.gz > /dev/null
  printf '%s\n' "$IMAGE_URI" > "$backup_dir/target-image.txt"
  (cd "$backup_dir" && sha256sum database.dump bundles.tar.gz target-image.txt > SHA256SUMS)
  # A lost COMMIT acknowledgement must never restart the old services against an uncertain schema.
  rebuild_attempted=true
  "${postgres[@]}" psql -X --set=apply_rebuild=true --file=/rebuild-once.sql
fi
"${compose[@]}" run --rm --no-deps api node dist/migrate.js
"${compose[@]}" up -d --pull never --remove-orphans --wait
"${compose[@]}" exec -T api node --input-type=module <<'JS'
for (const path of ["/healthz", "/api/material-bundles", "/api/session-bundles", "/api/datasets", "/api/evaluation-output-schemas"]) {
  const response = await fetch(`http://127.0.0.1:8788${path}`, {
    headers: { "X-Eval-Web-Token": process.env.EVAL_WEB_API_TOKEN }, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(`Eval smoke test failed: ${path} (${response.status})`);
  console.log(`Eval smoke test passed: ${path}`);
}
JS
# The Run Worker has no HTTP surface; it exits when its configuration or database connection fails.
sleep 10
test "$("${compose[@]}" ps --status running --quiet run-worker | wc -l)" -eq 1

if [[ "${REBUILD_DATABASE:-}" == eval-platform ]]; then
  "${compose[@]}" exec -T api node --input-type=module - --seed < "$DEPLOY_DIR/seed-demo.mjs"
fi

docker image prune --all --force --filter "until=72h" > /dev/null

echo "Deployed $IMAGE_URI"
