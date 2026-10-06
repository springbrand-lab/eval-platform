# debug-user-flow

End-to-end debug skill — **act as the frontend on behalf of one or more real users** (HTTP + WebSocket), drive a feature, and **correlate with backend logs/traces/DB** to verify new behavior or diagnose a bug.

The user tells you a story ("two users in a group chat, A sends a file, B should see a preview and a typing indicator from the AI") or a bug ("when user X sends a reaction, it sometimes doesn't appear for user Y"). You play every role in the story, capture every wire frame, and explain what happened end-to-end.

**Sibling skill:** `/investigate-koloclaw-instance` (for KoloClaw pod / instance lifecycle issues). Use `/debug-user-flow` for product-feature behavior — anything reachable from the UI through the public API surface.

---

## When to invoke

- A new feature touches `cc_core` + WS + frontend, and you want to exercise it before opening the browser.
- A bug report names a specific UI action (e.g. "send message", "create org") but no obvious crash — needs wire-level inspection.
- You want to replay a user's reported scenario as that user (with their data) and watch what the backend does in Datadog at the same time.
- Multi-user scenarios — anything that requires User A and User B to be online at once (chat, reactions, typing, presence).

**Do not** invoke for:
- KoloClaw pod / instance lifecycle issues → `/investigate-koloclaw-instance`
- Pure frontend rendering bugs that don't cross the API boundary → use the browser.

---

## Read first

Before any side effect:

- `/use-subagents` — heavy exploration goes to subagents.
- `/read-only` if the user said "investigate, don't touch" — staying read-only is the default on staging/prod (see **Safety** below).
- This skill calls the Datadog MCP server. Per its instructions, **load `datadog/logs`, `datadog/traces`, and `datadog/visualizations` skills first** via `mcp__plugin_datadog_mcp__load_datadog_skill` before invoking other Datadog tools.

---

## Inputs the user must provide (ask if missing)

| Input | Required? | Example |
|---|---|---|
| **Environment** | yes | `scratch`, `scratchtaiwan`, `dev`, `staging`, `prod` (default: `dev`) |
| **User(s)** | yes | Any of: a JWT access token they hand you directly (skip Step 1 entirely), email(s), user_id(s), or a fuzzy hint like "the two users I created last Tuesday — please find them" |
| **Story / bug** | yes | "A creates a chat, invites B, A sends 'hi', B sends a reaction" |
| **Goal** | yes | "Verify the reaction propagates to A within 1s" or "Find why B doesn't see it" |

If env is omitted, default to `dev`. **Never** default to `prod`; require explicit user OK.

---

## Step 0 — Configure environment

**AWS credentials gate — read first.** This EC2 dev instance's IAM role has access **only to the `scratch` AWS account**. For any other env (`scratchtaiwan`, `dev`, `staging`, `prod`), `setup_env.sh` (RDS Secrets Manager) and EKS `update-kubeconfig` will fail without user-supplied temporary credentials.

Decision tree:

- **Env is `scratch`** → no creds needed; proceed straight to the source-and-activate block below.
- **Env is anything else** → first verify creds:
  ```bash
  aws sts get-caller-identity   # should show the env's account, not the scratch one
  ```
  If this shows the scratch account or fails, **stop and ask the user** to paste temporary creds for the target env (typically a 3-line export of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). Continue only after `aws sts get-caller-identity` resolves to the right account.

Once creds are sorted:

```bash
cd /home/ubuntu/chocolate_chip_dev/chocolate_chip
source .venv_chocolate_chip_v2026.02.13/bin/activate
source setup_env.sh <env>   # sets DATABASE_URL, DEPLOYMENT_ENV, VALKEY_URL, etc.
```

After sourcing, `$DATABASE_URL` is set against the env's RDS (read-only replica at `$DATABASE_URL_READONLY` if Aurora — staging/prod only).

**Shortcut for user-supplied tokens only:** if the user handed you a JWT access token (Step 1a) and the entire scenario is HTTP/WS against the public hostname — no DB, no kubectl, no Datadog API key needed — you can skip `setup_env.sh` and just use the token + public URL. AWS creds only become mandatory at Steps 5 (kubectl) and 6 (DB).

Public hostnames (verify before use):
- scratch: `https://scratch.app.kolo.ai` (or local `http://localhost:8080` when `deploy_scratch.sh` is running)
- scratchtaiwan: `https://scratchtaiwan.app.kolo.ai` (ap-northeast-1 region)
- dev: `https://dev.app.kolo.ai`
- staging: `https://staging.app.kolo.ai`
- prod: `https://app.kolo.ai`

If unsure of the exact hostname, grep `deploy_<env>.sh` for `PUBLIC_HOSTNAME` or `BASE_URL`.

### Pick the right DB URL (`DEBUG_DB_URL`) — handles the reader-unreachable trap

`setup_env.sh` exports both `DATABASE_URL` (writer) and, when DNS resolves, `DATABASE_URL_READONLY` (reader). The reader is preferable for read-only queries — BUT on **scratch / scratchtaiwan / dev**, the reader endpoint typically **DNS-resolves without being network-reachable from this EC2 instance**, which makes `psql` hang on connect. Probe once and cache in a single var; use that everywhere below:

```bash
DEBUG_DB_URL=$DATABASE_URL
if [ -n "$DATABASE_URL_READONLY" ]; then
  _host=$(echo "$DATABASE_URL_READONLY" | sed -E 's,.*@([^:]+):.*,\1,')
  if timeout 3 bash -c "</dev/tcp/$_host/5432" 2>/dev/null; then
    DEBUG_DB_URL=$DATABASE_URL_READONLY
  fi
fi
export DEBUG_DB_URL
echo "using $(echo "$DEBUG_DB_URL" | sed -E 's,.*@([^/]+)/.*,\1,')"
```

Always pass `PGCONNECT_TIMEOUT=8` to `psql` so a future regression here doesn't hang forever:

```bash
PGCONNECT_TIMEOUT=8 psql "$DEBUG_DB_URL" -At -c "SELECT 1"
```

---

## Step 1 — Resolve users → JWT tokens

The system has **no dev/admin mint endpoint**. We mint tokens directly using the same helper the login flow uses (`create_access_token` at `cc_core/cc_core/api/v1/routes/auth.py:688`). This requires:

1. **DB read access** (already configured by `setup_env.sh` + the `DEBUG_DB_URL` probe above).
2. **The app's `web_portal.secret_key`** — and this is the trap. The cc_core config loader uses **`secretsmanager:BatchGetSecretValue`**, which is a separate IAM action from the more common `GetSecretValue`. If the active IAM identity has GetSecretValue (enough for `setup_env.sh`'s RDS-password fetch) but not BatchGetSecretValue, the config silently falls back to a **placeholder secret** — and your minted token will not validate against the real backend. The mint script below detects this and offers a manual-override path.

### 1a. Shortcut — user-supplied tokens (skip minting)

If the user hands you a token directly (copied from their browser DevTools, the login response, etc.), **skip the rest of Step 1 entirely**. Just save it and move on:

```bash
mkdir -p /tmp/debug-user-flow
chmod 700 /tmp/debug-user-flow
umask 077
cat > /tmp/debug-user-flow/token-alice.jwt    # paste the token, then Ctrl-D
chmod 600 /tmp/debug-user-flow/token-*.jwt
```

If you want to know *which* user the token is for (for logging / DD correlation), decode the unsigned payload — no secret needed:

```bash
python3 -c "import jwt, sys; print(jwt.decode(open('/tmp/debug-user-flow/token-alice.jwt').read().strip(), options={'verify_signature': False}))"
# → {'user_id': 12345, 'iat': ..., 'exp': ..., 'iss': 'development'}
```

Sanity-check: `iss` should match the env you're targeting (`scratch`, `scratchtaiwan`, `development`, `staging`, `prod`) and `exp` should be in the future.

### 1b. Find the user(s) (when no token is supplied)

If the user gave emails:

```bash
psql "$DEBUG_DB_URL" -c \
  "SELECT user_id, email, name, is_anon FROM user_ WHERE email IN ('alice@example.com','bob@example.com')"
```

If they gave names / fuzzy descriptions, ILIKE on email + name (substitute the search term, pass via `-v` so single-quotes / SQL metacharacters in the term don't break or maul the query):

```bash
TERM=%firstname%
psql "$DEBUG_DB_URL" -v term="$TERM" -c \
  "SELECT user_id, email, name FROM user_ WHERE email ILIKE :'term' OR name ILIKE :'term' LIMIT 20"
```

If they gave user_ids, skip ahead.

### 1c. Mint a token

`create_access_token` is **synchronous** and takes a `UserSchema` (not a `user_id`). The script below fetches the user row via `psql` (cheaper than wiring up a SQLAlchemy session), validates it into `UserSchema`, signs the JWT — and **aborts loudly if `web_portal.secret_key` is a placeholder** so you don't waste time minting bogus tokens.

```bash
mkdir -p /tmp/debug-user-flow
cat > /tmp/debug-user-flow/mint_jwt.py <<'PY'
"""Mint a JWT for a given user_id using the same helper the login flow uses.

Writes the token to the file passed via argv[2] (or $MINT_OUT_FILE) — NOT
stdout — because importing cc_core triggers placeholder-secret WARNINGS
and other DEBUG noise on stdout that would otherwise pollute the token
file. All logging goes to stderr.

Usage: python3 mint_jwt.py <user_id> <output_file>
Prereqs: source venv + setup_env.sh; $DEBUG_DB_URL set (Step 0).
"""
import json, os, subprocess, sys

# Imports — both `cc_core.X` and `cc_core.cc_core.X` resolve because the project root
# and the inner package dir are both on sys.path. Use the short form.
from cc_core.api.v1.routes.auth import create_access_token
from cc_db.interface.db_interface import UserSchema
from cc_core.config import config


def log(msg):
    print(msg, file=sys.stderr)


# --- Guard: detect placeholder secret_key (BatchGetSecretValue perm missing) ---
secret = getattr(config.web_portal, "secret_key", "") or ""
override = os.environ.get("WEB_PORTAL_SECRET_KEY_OVERRIDE")
if str(secret).startswith("placeholder") and not override:
    sys.exit(
        "ERROR: web_portal.secret_key is a placeholder — the active IAM identity\n"
        "lacks secretsmanager:BatchGetSecretValue. Tokens minted now would not validate.\n"
        "Fix one of:\n"
        "  • Use an IAM role/user with BatchGetSecretValue (then re-run setup_env.sh).\n"
        "  • Fetch the key manually and override:\n"
        "      KEY=$(aws secretsmanager get-secret-value \\\n"
        "        --secret-id <env>/web_portal/secret_key --query SecretString --output text)\n"
        "      WEB_PORTAL_SECRET_KEY_OVERRIDE=\"$KEY\" python3 mint_jwt.py <user_id> <out>"
    )
if override:
    config.web_portal.secret_key = override

# --- Fetch user row via psql, build UserSchema, sign ---
db_url = os.environ.get("DEBUG_DB_URL") or os.environ.get("DATABASE_URL")
if not db_url:
    sys.exit("ERROR: DATABASE_URL/DEBUG_DB_URL not set; source setup_env.sh first.")

user_id = int(sys.argv[1])
out_path = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MINT_OUT_FILE")
if not out_path:
    sys.exit("ERROR: pass output file as argv[2] or MINT_OUT_FILE — see docstring.")

sql = f"SELECT row_to_json(u) FROM user_ u WHERE user_id = {user_id}"
row_json = subprocess.check_output(["psql", db_url, "-At", "-c", sql]).decode().strip()
if not row_json:
    sys.exit(f"ERROR: no user with user_id={user_id}")

try:
    user = UserSchema.model_validate(json.loads(row_json))
except Exception as e:
    # UserSchema may not accept every column from the `user_` table verbatim.
    # Fall back to the minimal set create_access_token actually needs.
    row = json.loads(row_json)
    user = UserSchema(user_id=row["user_id"], is_anon=row.get("is_anon", False))
    log(f"(fell back to minimal UserSchema: {type(e).__name__}: {e})")

token = create_access_token(user)
with open(out_path, "w") as f:
    f.write(token)
os.chmod(out_path, 0o600)
log(f"wrote {len(token)} bytes to {out_path} for user_id={user_id}")
PY

# Pre-flight: confirm imports + secret_key are OK before trying users.
python3 -c "from cc_core.config import config; sec=str(config.web_portal.secret_key); print('secret_key:', 'placeholder' if sec.startswith('placeholder') else 'real')" 2>&1 | grep "^secret_key:"

# Mint per-user. Output goes via argv[2], not stdout — stdout is reserved for
# cc_core's noisy debug prints from the imports above.
python3 /tmp/debug-user-flow/mint_jwt.py 12345 /tmp/debug-user-flow/token-alice.jwt
```

### 1c.1. **MANDATORY:** register the token in `user_login` so auth accepts it

`create_access_token` produces a valid signed JWT, **but the auth validator (`verify_token_not_revoked` at `cc_core/cc_core/api/v1/dependencies/auth.py`) also requires a `user_login` row whose `token_sha256` matches the token AND whose `logged_out_at IS NULL`.** Without this row, every user-JWT API call 401s with `"Token has been logged out or is invalid"`.

The normal login flows insert this row; the mint script doesn't. Insert it manually — note this is the one place that **must** go to the writer URL, not `$DEBUG_DB_URL`. On Aurora envs (staging/prod) the Step 0 probe sets `DEBUG_DB_URL` to the reader endpoint, where the INSERT would fail with `cannot execute INSERT in a read-only transaction` and the token would silently stay invalid:

```bash
USER_ID=<resolved id from Step 1b>   # e.g. 6386 — DO NOT leave the placeholder
TOKEN=$(cat /tmp/debug-user-flow/token-alice.jwt)
psql "$DATABASE_URL" -v t="$TOKEN" -v uid="$USER_ID" -c "
  INSERT INTO user_login (user_id, token, expires_at)
  VALUES (:'uid'::bigint, :'t', NOW() + INTERVAL '90 days')
"
# token_sha256 is a GENERATED column (sha256 of `token`), so don't try to set it.
```

Smoke-test the token against any user-JWT-protected endpoint:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "https://$ENV.app.kolo.ai/api/v1/auth/me" | jq .user_id
```

Should return the user's id. If it returns `"Token has been logged out or is invalid"`, the `user_login` insert didn't run (or the env hostname is wrong — see Step 0).

### 1c.2. Service tokens vs user JWTs — pick the right one for the endpoint

The user JWT minted above only authenticates against **user-facing** endpoints (`/api/v1/auth/*`, `/api/v1/group_chat/*`, `/api/v1/user/*`, etc. — anything that calls `get_authenticated_user`). For **internal** endpoints (`/api/v1/internal/agent/notify-owner`, `/api/v1/internal/agent/backchannel`, etc.) the dependency is `require_service_token`, which checks `user_koloclaw_instance.service_token` directly.

If you need to call an internal endpoint, pull the service token from the DB instead:

```bash
TARGET_UID=12345
SVC_TOKEN=$(psql "$DEBUG_DB_URL" -At -c "SELECT service_token FROM user_koloclaw_instance WHERE user_id=$TARGET_UID AND service_token_expires_at > NOW() ORDER BY created_at DESC LIMIT 1")
echo -n "$SVC_TOKEN" > /tmp/debug-user-flow/svc-alice.tok
chmod 600 /tmp/debug-user-flow/svc-alice.tok
```

Same `Authorization: Bearer <token>` header shape — the backend dependency picks the right validator based on which the request hit.

If the imports drift (renames, layout changes), grep for `create_access_token`, `UserSchema`, `config.web_portal.secret_key` before guessing. **Never check tokens into git.**

### 1d. Cache tokens per session

Keep one file per user in `/tmp/debug-user-flow/token-<label>.jwt`. The skill is fast enough that re-minting is fine if the file is older than the token expiry (default config: `web_portal.access_token_expire_minutes`).

---

## Step 2 — Map UI feature → endpoint(s)

You need to know **what the frontend would do**. The map lives in code:

| What you're tracing | Where to look |
|---|---|
| HTTP API client by domain | `cc_web_user_portal/cc_web_user_portal/src/apis/<domain>.ts` (e.g. `auth.ts`, `message.ts`) |
| Feature-scoped service client | `cc_web_user_portal/cc_web_user_portal/src/features/<feature>/services/<feature>Api.ts` |
| WS client + event handlers | `cc_web_user_portal/cc_web_user_portal/src/features/group_chat/services/groupChatWsClient.ts` |
| WS auto-connect hook | `.../src/features/group_chat/hooks/useGroupChatWsAutoConnect.ts` |
| Zustand store the WS mutates | `.../src/stores/useGroupChatStore.ts` |
| Backend router files | `cc_core/cc_core/api/v1/routes/*.py` (~70 files, prefix `/api/v1/*`) |
| WS handler + dispatch table | `cc_core/cc_core/api/v1/routes/group_chat.py` (search for `event_type ==`) |
| WS message Pydantic models | `cc_core/cc_core/group_chat/group_chat_ws_events.py` (`GROUP_CHAT_WS_INCOMING_MODELS`, `_OUTGOING_MODELS`) |
| Full route table | `GET /openapi.json` against the running backend, or Swagger UI at `/api/docs` |

**Recipe:** start in the React feature folder (e.g. `src/features/group_chat/`), find the user-action handler (`onClick`, `onSubmit`), follow the import to the service/api file, and read the request line. That's your endpoint and shape. Drop a one-line summary in your scratch notes.

---

## Step 3 — Drive the feature as the user(s)

**The general technique — and the only one that works for arbitrary UI features:** trace what the frontend would call (Step 2), then replay those calls yourself with the user's token. The CLI further down is a *convenience for the group-chat WS surface specifically*, not a substitute for tracing.

### 3a. General pattern — replay the traced endpoints directly

For most UI features (settings, profile, org admin, skills marketplace, briefs, drives, billing, knowledge base, daily summary, etc.) there is **no WS involved** and no canned CLI to help — you just hit the HTTP endpoints the page would hit, in the order it would hit them. The data a user sees on a page is almost always the union of several requests fired from `useEffect` / React Query hooks in the feature folder; replicating the *sequence* matters, not just any single call.

Recipe per feature:

1. From Step 2, you should have a short list of HTTP requests the page issues (URL, method, body shape). If you don't, go back to Step 2 — don't guess.
2. Fire them in order with the user's token:

```bash
TOKEN=$(cat /tmp/debug-user-flow/token-alice.jwt)
BASE=https://dev.app.kolo.ai

# Initial load
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/user/me" | tee /tmp/debug-user-flow/me.json | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/org/list" | tee /tmp/debug-user-flow/orgs.json | jq

# User action (e.g. update profile)
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"new name"}' "$BASE/api/v1/user/me" | jq
```

For anything beyond a handful of requests, prefer `httpx` so you get keep-alive, structured responses, and easy logging:

```bash
cat > /tmp/debug-user-flow/run.py <<'PY'
import json, httpx
from pathlib import Path
TOKEN = Path("/tmp/debug-user-flow/token-alice.jwt").read_text().strip()
BASE = "https://dev.app.kolo.ai"
log = Path("/tmp/debug-user-flow/run.jsonl").open("a")
with httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=30) as c:
    for label, method, path, body in [
        ("me",      "GET",   "/api/v1/user/me",  None),
        ("orgs",    "GET",   "/api/v1/org/list", None),
        ("rename",  "PATCH", "/api/v1/user/me",  {"name": "new name"}),
    ]:
        r = c.request(method, path, json=body)
        log.write(json.dumps({"label": label, "status": r.status_code, "body": r.json() if r.content else None}) + "\n")
        print(f"{label}: {r.status_code}")
PY
python3 /tmp/debug-user-flow/run.py
```

**Verifying you've reproduced the UI accurately:** if the user reports a value-on-screen, your replayed response should contain that value (or contain whatever the frontend transforms into that value). If the API response is fine but the screen is wrong, the bug is in the frontend, not the API — pivot to the browser.

**Is there a WebSocket involved?** Most pages: no. The ones that do (today): anything under `src/features/group_chat/` and anywhere `useGroupChatWsAutoConnect` is in the React tree. If you're unsure, grep the feature folder for `groupChatWsClient` or `new WebSocket(` — absent → HTTP only. If a *new* WS endpoint exists that this skill doesn't know about (the only one documented here is `/api/v1/group_chat/ws`), grep `cc_core/cc_core/api/` for `WebSocket` and add a note before relying on it.

### 3b. Shortcut for the group-chat WS surface

If — and only if — the scenario is a chat operation (send/edit/react/typing/invite/snapshot), there's a purpose-built interactive CLI that handles the WS protocol so you don't have to:

```bash
export ACCESS_TOKEN=$(cat /tmp/debug-user-flow/token-alice.jwt)
python3 scripts/group_chat_ws_cli.py \
  --base-url https://dev.app.kolo.ai \
  --log-file /tmp/debug-user-flow/wire-alice.jsonl
# inside: /help, /create_chat, /send <text>, /list_chats, /invite, ...
```

It logs every WS frame + HTTP response to the JSONL file — that's your wire log for later correlation. **Scope is exactly the group-chat surface**; it won't help with profile, org, skills, briefs, drives, or anything else. For those, use 3a.

### 3c. Multi-user chat scenarios — scripted orchestrator

For "User A does X, User B should see Y" chat scenarios you want a deterministic Python orchestrator that holds N WS sessions open in parallel asyncio tasks. There's no canned multi-user version — write a small one alongside the single-user CLI:

```bash
cat > /tmp/debug-user-flow/multi.py <<'PY'
"""Drive N users against the backend at once. Adapt the steps in `scenario()`."""
import asyncio, json, sys
from pathlib import Path
from urllib.parse import quote
import httpx, websockets

BASE_HTTP = "https://dev.app.kolo.ai"
BASE_WS = BASE_HTTP.replace("https://", "wss://").replace("http://", "ws://")

async def session(label: str, token: str, log_path: Path, sink: asyncio.Queue):
    """Open one user's HTTP client + WS, push inbound frames into `sink`."""
    async with httpx.AsyncClient(
        base_url=BASE_HTTP,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
    ) as http:
        url = f"{BASE_WS}/api/v1/group_chat/ws?token={quote(token)}"
        async with websockets.connect(url) as ws:
            with log_path.open("a") as f:
                async def reader():
                    async for raw in ws:
                        evt = json.loads(raw)
                        f.write(json.dumps({"dir": "in", "label": label, "evt": evt}) + "\n")
                        f.flush()
                        await sink.put((label, evt))
                async def writer(payload):
                    f.write(json.dumps({"dir": "out", "label": label, "evt": payload}) + "\n")
                    f.flush()
                    await ws.send(json.dumps(payload))
                # Hand `http`, `writer`, `sink` back to the scenario via a context object.
                yield {"http": http, "send": writer, "sink": sink, "label": label}

async def scenario(users: dict[str, str]):
    """Edit me: this is the test you actually want to run."""
    log = Path("/tmp/debug-user-flow/multi.jsonl")
    log.unlink(missing_ok=True)
    sink: asyncio.Queue = asyncio.Queue()
    # ... open sessions, wait for chat.snapshot, then perform actions ...
    # For now: just print every event for 10 seconds.
    async def tap():
        try:
            while True:
                lbl, evt = await asyncio.wait_for(sink.get(), timeout=10.0)
                print(f"[{lbl}] {evt.get('type')}")
        except asyncio.TimeoutError:
            return
    # Wiring left as an exercise — see the `session` generator above.

if __name__ == "__main__":
    users = {
        "alice": Path("/tmp/debug-user-flow/token-alice.jwt").read_text().strip(),
        "bob":   Path("/tmp/debug-user-flow/token-bob.jwt").read_text().strip(),
    }
    asyncio.run(scenario(users))
PY
```

The skeleton above is a **starting point** — adapt `scenario()` to the user's exact story (e.g. `await alice.send({"type": "message.send", "request_id": str(uuid4()), ...})`). Cross-reference event shapes in `cc_core/cc_core/group_chat/group_chat_ws_events.py`.

### 3d. WS envelope reference (group-chat surface)

Every outbound frame:

```json
{"type": "message.send", "request_id": "<uuid>", "group_chat_id": "<uuid>", "text": "...", ...}
```

Server replies with an `_ack` event echoing the `request_id`, plus broadcasts (`message.send`, `typing.start`, etc.) to all participants. Main types to know:

- **Client → server:** `chat.set_active`, `message.send`, `message.edit`, `message.delete`, `message.mark_read`, `message.reaction.toggle`, `typing.start`, `typing.stop`, `chat.abort`, `vnc-browser-command-response`.
- **Server → client:** `chat.snapshot`, `chat.active.snapshot`, `message.send` (broadcast), `message.edited`, `message.deleted`, `message.mark_read`, `message.reaction.updated`, `ai.message.stream.start | .delta | .done`, `ai.tool.start | .result`, `typing.start | .stop`, `participant.joined | .left`, `brief.created | .status_changed | .expired`, `daily_summary.ready | .failed`, `vnc-browser-command`.

Always grep `group_chat_ws_events.py` for the authoritative list before relying on this — events come and go.

---

## Step 4 — Correlate with Datadog

You acted as the frontend. Now find your actions in the logs.

### 4a. Load Datadog skills first (mandatory)

```text
mcp__plugin_datadog_mcp__load_datadog_skill(skill_name="datadog/logs")
mcp__plugin_datadog_mcp__load_datadog_skill(skill_name="datadog/traces")
mcp__plugin_datadog_mcp__load_datadog_skill(skill_name="datadog/visualizations")
```

(See the MCP-server instructions in the session header — skills carry domain guidance that isn't in the tool descriptions.)

### 4b. Service / env tags

| Component | `service:` | `env:` (note the mapping!) |
|---|---|---|
| Main FastAPI backend | `cc-app` | scratch → `scratch`, scratchtaiwan → `scratchtaiwan`, dev → **`development`**, staging → `staging`, prod → `prod` |
| KoloClaw control plane | `koloclaw-control-plane`, `koloclaw-reconciler` | same mapping |
| LiteLLM proxy | `litellm-proxy` | same mapping |

The `dev` → `development` rename is the most common mistake.

### 4c. Search recipe

Build a query that bounds the search by time + user + service:

```text
mcp__plugin_datadog_mcp__search_datadog_logs(
  query='service:cc-app env:development @user_id:12345 @http.url:*group_chat*',
  from_ms=<scenario_start_ms - 5000>,
  to_ms=<scenario_end_ms + 5000>,
)
```

Stamp `scenario_start_ms` / `scenario_end_ms` in the Python orchestrator (use `time.time() * 1000`) and pass them in. For WS-only flows, the user-id attribute may be on a `ws.session_id` or `chat_id` field instead — inspect a sample log first to see which structured attributes exist.

### 4d. Traces

If you have a `trace_id` from an HTTP response header (the backend emits `x-datadog-trace-id`), pull the whole trace:

```text
mcp__plugin_datadog_mcp__get_datadog_trace(trace_id=...)
```

For WS, traces don't span the full session — they're per-message-handler. Search by `service:cc-app operation_name:websocket_*` within your time window.

---

## Step 5 — If Datadog is empty, drop into the pod

Sometimes the action never reached the service (network, auth failure) or the service crashed before logging. Verify directly.

### 5a. Configure kubectl

Requires AWS creds for the target env (see Step 0). For non-scratch envs, confirm `aws sts get-caller-identity` resolves to the right account before running these commands — otherwise `update-kubeconfig` will silently grant a kubeconfig that can't authenticate against the cluster.

```bash
# Same logic setup_env.sh uses internally; kube_setup() in the script applies it automatically when present.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-2   # ap-northeast-1 for scratchtaiwan
aws eks update-kubeconfig \
  --name "cc-eks-${PULUMI_ENV}" \
  --region "$REGION" \
  --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/DevsOnCallEKSAccessRole-cc-eks-${PULUMI_ENV}" \
  --alias "cc-eks-${PULUMI_ENV}"
kubectl config use-context "cc-eks-${PULUMI_ENV}"
```

### 5b. Read pods + tail logs

```bash
kubectl get pods -n cc-app -l app.kubernetes.io/name=cc-app
kubectl logs -n cc-app -l app.kubernetes.io/name=cc-app --tail=200 --since=10m
kubectl logs -n cc-app -l app.kubernetes.io/name=cc-app --tail=500 | grep -i "<user_id>"
```

For KoloClaw user pods (if the feature involves one), namespace is per-user:

```bash
kubectl get ns | grep koloclaw-user
kubectl get pods -n koloclaw-user-<slug>
kubectl logs -n koloclaw-user-<slug> --all-containers --tail=300
```

### 5c. Exec in (rarely needed)

```bash
kubectl exec -it -n cc-app deploy/cc-app -- bash
# inside: python3 -c "from cc_db ...", or check env vars, or hit localhost:8000/healthz
```

**Never** edit pod state in staging/prod without explicit user OK.

---

## Step 6 — Query the DB directly

When logs and the API both look fine but the user-visible state is wrong, the DB is the ground truth.

```bash
psql "$DEBUG_DB_URL" <<'SQL'
SELECT group_chat_message_id, sender_user_id, text, created_at_utc
FROM group_chat_message
WHERE group_chat_id = '<uuid>'
ORDER BY created_at_utc DESC LIMIT 20;
SQL
```

Use `$DATABASE_URL_READONLY` whenever it's set (staging/prod Aurora). On scratch/scratchtaiwan/dev there's no replica — `$DATABASE_URL` is the only option, and it's safe to query.

**No writes** without an explicit user OK. Even on scratch, an `UPDATE` that the user didn't ask for is a deviation.

---

## Key reference files

| Concern | Path |
|---|---|
| JWT format + validation | `cc_core/cc_core/api/v1/dependencies/auth.py:25-106` |
| Token mint helper | `cc_core/cc_core/api/v1/routes/auth.py:688-701` (`create_access_token`) |
| User table model | `cc_db/cc_db/models/model.py:570-677` (`User`, table `user_`) |
| FastAPI route registration | `cc_core/cc_core/api/v1/__init__.py:86-166` |
| Single-user WS+HTTP CLI | `scripts/group_chat_ws_cli.py` |
| WS handler + dispatch | `cc_core/cc_core/api/v1/routes/group_chat.py:1719+` |
| WS message Pydantic models | `cc_core/cc_core/group_chat/group_chat_ws_events.py` |
| Frontend HTTP client (general) | `cc_web_user_portal/cc_web_user_portal/src/apis/` |
| Frontend group-chat client | `.../src/features/group_chat/services/groupChatApi.ts` |
| Frontend WS client | `.../src/features/group_chat/services/groupChatWsClient.ts` |
| Frontend WS auto-connect | `.../src/features/group_chat/hooks/useGroupChatWsAutoConnect.ts` |
| Frontend WS-driven store | `.../src/stores/useGroupChatStore.ts` |
| Env config + DB URL | `setup_env.sh:272-424` |
| EKS cluster setup | `infra/eks.py:188, 214-219`, `setup_env.sh:207-234` |
| Helm deployment | `deploy/helm/cc-app/templates/deployment.yaml` |
| Sibling runbook | `.claude/commands/investigate-koloclaw-instance.md` |

---

## Playbook templates

### A. "Two users, one chat, send + react"

1. Resolve `alice` and `bob` user_ids (Step 1a), mint tokens (Step 1b).
2. Alice creates a chat: `POST /api/v1/group_chat` (HTTP).
3. Alice creates an invite link: `POST /api/v1/group_chat/invite-links`.
4. Bob redeems the invite: `POST /api/v1/group_chat/invite-links/redeem`.
5. Open WS as both. Wait for `chat.snapshot` on each.
6. Alice sends `message.send`. Both should receive a `message.send` broadcast.
7. Bob sends `message.reaction.toggle`. Both should receive `message.reaction.updated`.
8. Datadog: `service:cc-app env:development @group_chat_id:<uuid>` from start..end. Look for one trace per action, no errors, both fan-outs visible.

### B. "AI streamed response — first delta latency"

1. One user, one chat with an AI participant (verify via `participant.joined` after `chat.set_active`).
2. Send `message.send` with text. Record T0.
3. Watch for `ai.message.stream.start` (T1) and the first `ai.message.stream.delta` (T2). T2 − T0 is your first-token latency.
4. Datadog: filter `service:cc-app operation_name:*ai*` for the same window, look at `@duration` distribution.

### C. "Reaction sometimes doesn't appear for user Y"

1. Resolve users, mint tokens.
2. Run the orchestrator in a loop (N iterations, e.g. 50).
3. After each iteration, assert: did user Y receive `message.reaction.updated` for the toggle user X just sent?
4. Capture the iteration number where it failed. Pull the WS frame log from `/tmp/debug-user-flow/multi.jsonl` for that window.
5. Datadog: search for the failing chat_id / message_id, look at Valkey Pub/Sub spans.

(Add new playbooks to this section as you discover patterns worth saving.)

---

## Safety guardrails

**Env policy:**
- `scratch`, `scratchtaiwan`, `dev` — fine to act on autonomously, including sending WS messages, creating chats, sending HTTP POSTs. No pod mutations.
- `staging` — read-only by default. WS sends, chat creation, or DB writes require an explicit user OK in this session.
- `prod` — always read-only by default. Any action that would *appear in another real user's UI* (creating a chat with them, sending a reaction to a real chat) requires explicit user OK with the action spelled out.

**Token hygiene:**
- Tokens live in `/tmp/debug-user-flow/token-<label>.jwt`, `chmod 600`.
- Delete them at the end of the session, or set a TODO to do so. Never paste them into logs, commits, or chat output.
- Tokens have the user's full privilege — minting one is equivalent to logging in as them.

**Data hygiene:**
- Don't dump full PII (emails, phone numbers, message content) into the assistant output unless the user asked.
- For wire logs in `/tmp/debug-user-flow/*.jsonl`, mention them by path; don't paste them inline beyond a few illustrative lines.

**No surprise side effects:**
- Always tell the user before you `POST`, `PUT`, `DELETE`, or send any non-`chat.set_active` WS event in their session, unless they pre-authorized the scenario.

---

## Common failure modes

| Symptom | Likely cause | Where to check |
|---|---|---|
| 401 on first HTTP call | Token expired / invalid / wrong env | Re-mint; verify `iss` matches the env DB name in the token payload |
| 401 on WS but HTTP works | WS auth uses `?token=...` (query param), not header — check URL | `cc_core/cc_core/api/v1/routes/group_chat.py:1712` |
| WS connects but no `chat.snapshot` | Token issued for wrong env (issuer mismatch) | Decode JWT, inspect `iss` |
| `chat.snapshot` empty | User has no chats in this env, or hit a different DB | Cross-check `psql` count of `group_chat_participant` for the user_id |
| Backend traffic invisible in Datadog | Wrong `env:` tag (`dev` vs `development`) | See Step 4b mapping table |
| Pod healthy, logs silent | Request didn't reach the service | Check ingress/ALB target group status; `kubectl describe ingress -n cc-app` |
| WS broadcast missing for one user | Valkey Pub/Sub miss or stale subscription | Datadog: `service:cc-app operation_name:*valkey*`; check pod restarts during the window |
| Message persists but never broadcasts | Background fanout task crashed | `kubectl logs -n cc-app deploy/cc-app --tail=500 | grep -i fanout` |
| 401 `"Token has been logged out or is invalid"` on a fresh mint | `user_login` row missing — the validator checks `sha256(token)` is in that table with `logged_out_at IS NULL`; `create_access_token` alone doesn't insert one | Run the Step 1c.1 `INSERT INTO user_login (...)` after every mint, before any user-JWT API call |
| Tokens fail with 401 even with `user_login` registered | IAM identity lacks `secretsmanager:BatchGetSecretValue` → `web_portal.secret_key` loaded as placeholder; signed JWT can't validate against the real backend | Run `python3 -c "from cc_core.config import config; sec=str(config.web_portal.secret_key); print('placeholder' if sec.startswith('placeholder') else 'real')"`. Use `WEB_PORTAL_SECRET_KEY_OVERRIDE` (Step 1c) or different IAM creds. |
| 401 `"Service token not associated with any active instance"` on internal-endpoint call | Used a user JWT against an `/api/v1/internal/agent/*` route, which expects a service token | Pull `user_koloclaw_instance.service_token` (Step 1c.2) and use that instead |
| `psql` hangs forever on connect | Reader endpoint DNS-resolves but isn't network-reachable (`$DATABASE_URL_READONLY` on scratch/scratchtaiwan/dev) | Set `DEBUG_DB_URL` via the Step 0 probe + always pass `PGCONNECT_TIMEOUT=8` |

---

## When you're done

- Summarize: what you did, what each user observed, where the wire log + DD links live.
- If the scenario succeeded, that's the result. If it failed, name the failure mode (one row from the table above, or a new one).
- Offer to delete `/tmp/debug-user-flow/*` and revoke tokens (`/api/v1/auth/logout` or invalidate `user_login` row) if the user wants a clean slate.
