#!/usr/bin/env bash
# Runs on the EC2 instance (sent by dispatch.sh through Systems Manager).
set -Eeuo pipefail

for name in AWS_REGION ECR_REGISTRY ECR_REPOSITORY IMAGE_TAG APP_SECRET_ID DB_SECRET_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
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
python3 > "$TEMP_DIR/secrets.compose.json" <<'PY'
import json
import os
from pathlib import Path
from urllib.parse import quote

app = json.loads(Path(os.environ["APP_SECRET_PATH"]).read_text())
database = json.loads(Path(os.environ["DB_SECRET_PATH"]).read_text())

langfuse = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_ENVIRONMENT"]
# Optional; the API serves the Evaluator result MCP Server and the Worker derives submit tokens from it.
result_mcp = ["EVAL_RESULT_MCP_TOKEN"]
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

print(json.dumps({
    "services": {
        "api": {"environment": {"DATABASE_URL": database_url, **pick(api_required + langfuse + result_mcp)}},
        "run-worker": {"environment": {"DATABASE_URL": database_url, **pick(worker_required + evidence_r2 + langfuse + result_mcp)}},
    }
}))
PY

IMAGE_URI="$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
export IMAGE_URI AWS_REGION
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

compose=(docker compose -p eval-platform -f "$DEPLOY_DIR/compose.yaml" -f "$TEMP_DIR/secrets.compose.json")
"${compose[@]}" pull --quiet
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

docker image prune --all --force --filter "until=72h" > /dev/null

echo "Deployed $IMAGE_URI"
