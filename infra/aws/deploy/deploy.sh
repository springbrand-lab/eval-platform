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

python3 "$DEPLOY_DIR/render-secrets.py" \
  "$TEMP_DIR/app-secret.json" "$TEMP_DIR/database-secret.json" > "$TEMP_DIR/secrets.compose.json"

if python3 -c 'import json,sys; sys.exit(not json.load(open(sys.argv[1]))["x-agent-imports-enabled"])' \
  "$TEMP_DIR/secrets.compose.json"; then
  export COMPOSE_PROFILES=agent-imports
else
  unset COMPOSE_PROFILES
fi

IMAGE_URI="$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
export IMAGE_URI AWS_REGION
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

compose=(docker compose -p eval-platform -f "$DEPLOY_DIR/compose.yaml" -f "$TEMP_DIR/secrets.compose.json")
"${compose[@]}" pull --quiet
"${compose[@]}" run --rm --no-deps api node dist/migrate.js
if [[ -z "${COMPOSE_PROFILES:-}" ]]; then
  "${compose[@]}" --profile agent-imports stop import-worker
fi
"${compose[@]}" up -d --pull never --remove-orphans --wait
# Finish projections invalidated by the old Worker while the first backfill was running.
"${compose[@]}" exec -T api node dist/migrate.js
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
if [[ "${COMPOSE_PROFILES:-}" == agent-imports ]]; then
  test "$("${compose[@]}" ps --status running --quiet import-worker | wc -l)" -eq 1
fi

docker image prune --all --force --filter "until=72h" > /dev/null

echo "Deployed $IMAGE_URI"
