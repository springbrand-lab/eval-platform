# API error handling

Applies when adding or changing API handlers, domain error translation, shared HTTP
responses/clients, authentication failures, or request logging.

- `packages/http/src/errors.ts` is the single error-code catalog. Use stable
  `DOMAIN_REASON` uppercase codes, with one HTTP status and default public message
  per code. Reuse a code only when callers can take the same corrective action.
- API failure responses use `httpErrorSchema`: `code`, `errMsg`, `requestId`, and
  optional `errors: [{ path, errMsg }]` and schema-validated, code-specific
  `details`. Use typed details for domain facts, never encode them in field
  messages. HTTP status must be a real 4xx/5xx.
  Never return HTTP 200 with `success: false`, add another error envelope, or
  dispatch business behavior by matching a public message.
- Success envelopes and domain result payloads are separate from HTTP failures.
  Preserve external protocol contracts such as OAuth redirects and Action/RPC
  execution-result payloads; translate failures at their HTTP adapter boundary.
- Throw `HttpError` at the HTTP boundary, or use a shared response helper.
  Models own typed domain errors and must not import HTTP handling.
  Translate only known domain/input errors. Unknown exceptions must propagate.
  Use the route validator or shared `parseInput` for request inputs. Do not map
  every `ZodError` to 422: stored-state and output schema failures are server errors.
- Preserve original causes with `{ cause: error }` when translating dependency
  failures. Store safe upstream status/request identifiers when available.
  Do not turn I/O failures into input errors, not-found responses, or auth 401s.
- Public messages explain the problem and a safe next action. Never expose raw
  SQL, bound parameters, tokens, provider response bodies, or internal stacks.
  Validation errors identify fields, not only “Validation failed”.
- `createApp` normalizes unexpected exceptions; `pinoLogger` emits one request
  record containing its request ID, HTTP status, error code, and bounded,
  credential-redacted diagnostics. Do not separately log-and-rethrow the same
  request exception or serialize arbitrary error/request objects.
- Clients preserve error code, status, request ID and field errors. Only a
  confirmed invalid Session clears authentication. An error response does not
  authorize replaying a mutation; retries must follow the operation's contract.
- Update OpenAPI and focused tests together. Cover a real failure, a service
  outage, and preservation of useful diagnostics without sensitive data.

See `docs/agents/api-errors.md` for the wire contract and migration notes.
