"""Render the deployment's service-specific environment without contacting any service."""

import json
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit


DEV_SP_API_ORIGIN = "https://devrapi.springbrand.ai"


def render(app, database):
    api_required = [
        "EVAL_SP_API_ORIGIN", "EVAL_SP_SERVICE_USER_ID", "EVAL_SP_SERVICE_SESSION_TOKEN",
        "EVAL_SP_ADMIN_TOKEN", "EVAL_WEB_ORIGIN", "EVAL_WEB_API_TOKEN",
        "EVAL_SP_SOURCE_BRANCH", "EVAL_SP_SOURCE_COMMIT",
        "EVAL_SP_AGENT_ORIGIN", "EVAL_SP_TRUSTED_ORIGIN",
    ]
    run_required = ["EVAL_SP_AGENT_ORIGIN", "EVAL_SP_SERVICE_TOKEN"]
    missing = sorted(name for name in set(api_required + run_required) if not app.get(name))
    if missing:
        raise SystemExit("AWS app secret is missing: " + ", ".join(missing))
    if database.get("dbname") != "eval-platform":
        raise SystemExit("Database secret must target eval-platform")

    enabled = bool(app.get("SP_PLATFORM_RESOURCE_ADMIN_TOKEN"))
    source = ["SP_PLATFORM_RESOURCE_ADMIN_TOKEN"] if enabled else []
    if enabled:
        def origin(value):
            try:
                parsed = urlsplit(value)
                if (parsed.scheme not in ("http", "https") or not parsed.hostname
                        or parsed.username or parsed.password or parsed.query or parsed.fragment
                        or parsed.path not in ("", "/")):
                    raise ValueError()
                return parsed.scheme, parsed.hostname.lower(), parsed.port or (
                    443 if parsed.scheme == "https" else 80
                )
            except (TypeError, ValueError):
                raise SystemExit("SP import origins must be HTTP origins without credentials or paths")

        if origin(DEV_SP_API_ORIGIN) == origin(app["EVAL_SP_API_ORIGIN"]):
            raise SystemExit("Source and target SP origins must be different")

    database_url = (
        "postgres://" + quote(database["username"], safe="") + ":"
        + quote(database["password"], safe="") + "@" + database["host"]
        + f":{database.get('port', 5432)}/" + quote(database["dbname"], safe="")
        + "?sslmode=verify-full&sslrootcert="
        + quote("/etc/ssl/certs/aws-rds-global-bundle.pem", safe="")
    )

    def environment(names):
        return {"DATABASE_URL": database_url, **{
            name: app[name] for name in names if app.get(name)
        }}

    langfuse = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_ENVIRONMENT"]
    result_mcp = ["EVAL_RESULT_MCP_TOKEN"]
    evidence = [
        "EVAL_EVIDENCE_R2_ENDPOINT", "EVAL_EVIDENCE_R2_BUCKET",
        "EVAL_EVIDENCE_R2_ACCESS_KEY_ID", "EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY",
    ]
    services = {
        "api": {"environment": environment(api_required + langfuse + result_mcp + source)},
        "run-worker": {"environment": environment(run_required + evidence + langfuse + result_mcp)},
    }
    if enabled:
        services["import-worker"] = {"environment": environment([
            "EVAL_SP_API_ORIGIN", "EVAL_SP_SERVICE_USER_ID",
            "EVAL_SP_SERVICE_SESSION_TOKEN", "EVAL_WEB_ORIGIN", *source,
        ])}
    return {"x-agent-imports-enabled": enabled, "services": services}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: render-secrets.py APP_SECRET_PATH DATABASE_SECRET_PATH")
    try:
        app = json.loads(Path(sys.argv[1]).read_text())
        database = json.loads(Path(sys.argv[2]).read_text())
    except (OSError, ValueError):
        raise SystemExit("Unable to read application/database secret JSON")
    print(json.dumps(render(app, database)))
