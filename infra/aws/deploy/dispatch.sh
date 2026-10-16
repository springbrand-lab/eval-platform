#!/usr/bin/env bash
# Copies compose.yaml and deploy.sh to the EC2 instance and runs deploy.sh through Systems Manager.
set -euo pipefail

for required_name in AWS_REGION ECR_REGISTRY ECR_REPOSITORY IMAGE_TAG INSTANCE_ID APP_SECRET_ID DB_SECRET_ID; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "Missing required environment variable: ${required_name}" >&2
    exit 1
  fi
done

DEPLOY_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_DIR=/opt/eval-platform/production
compose_base64="$(base64 < "$DEPLOY_SOURCE/compose.yaml" | tr -d '\n')"
deploy_base64="$(base64 < "$DEPLOY_SOURCE/deploy.sh" | tr -d '\n')"
rebuild_base64="$(base64 < "$DEPLOY_SOURCE/rebuild-once.sql" | tr -d '\n')"
seed_base64="$(base64 < "$DEPLOY_SOURCE/../../../fixtures/eval-demo/seed.mjs" | tr -d '\n')"
parameters="$(jq -nc \
  --arg dir "$REMOTE_DIR" \
  --arg compose "$compose_base64" \
  --arg deploy "$deploy_base64" \
  --arg rebuild_sql "$rebuild_base64" \
  --arg seed_script "$seed_base64" \
  --arg rebuild_database "${REBUILD_DATABASE:-}" \
  --arg region "$AWS_REGION" \
  --arg registry "$ECR_REGISTRY" \
  --arg repository "$ECR_REPOSITORY" \
  --arg tag "$IMAGE_TAG" \
  --arg app_secret "$APP_SECRET_ID" \
  --arg db_secret "$DB_SECRET_ID" \
  '{executionTimeout: ["1500"], commands: [
    ("install -d -m 0755 " + ($dir | @sh)),
    ("printf %s " + ($compose | @sh) + " | base64 -d > " + ($dir | @sh) + "/compose.yaml"),
    ("printf %s " + ($deploy | @sh) + " | base64 -d > " + ($dir | @sh) + "/deploy.sh"),
    ("printf %s " + ($rebuild_sql | @sh) + " | base64 -d > " + ($dir | @sh) + "/rebuild-once.sql"),
    ("printf %s " + ($seed_script | @sh) + " | base64 -d > " + ($dir | @sh) + "/seed-demo.mjs"),
    ("chmod 0755 " + ($dir | @sh) + "/deploy.sh"),
    ("AWS_REGION=" + ($region | @sh) + " ECR_REGISTRY=" + ($registry | @sh) + " ECR_REPOSITORY=" + ($repository | @sh) + " IMAGE_TAG=" + ($tag | @sh) + " APP_SECRET_ID=" + ($app_secret | @sh) + " DB_SECRET_ID=" + ($db_secret | @sh) + " REBUILD_DATABASE=" + ($rebuild_database | @sh) + " " + ($dir | @sh) + "/deploy.sh")
  ]}')"

command_id="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Deploy Eval API $IMAGE_TAG" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

status=Pending
for ((attempt = 0; attempt < 300; attempt++)); do
  status="$(aws ssm get-command-invocation \
    --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" \
    --query Status \
    --output text 2>/dev/null || echo Pending)"
  case "$status" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  sleep 5
done

aws ssm get-command-invocation \
  --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Errors:StandardErrorContent}' \
  --output json
test "$status" = Success
