# API Interface Implementation

Read this rule before adding or changing an API business interface across
`api/src/models/**`, `api/src/routes/**`, `packages/http/**`, or
`web/src/api-sdk/**`.

Use the existing vertical flow. Do not create a parallel repository, service,
controller, DTO, or client-generation layer.

```text
[PostgreSQL]
      |
      v
[models/<domain>/schema.ts]  Drizzle table and row types
      |
      v
[models/<domain>/index.ts]   validation, data operations, domain projections
      |
      v
[routes/<domain>/*.routes.ts] OpenAPI request and response contracts
      |
      v
[*.handlers.ts]              auth, Model call, HTTP result
      |
      v
[*.index.ts]                 route registration
      |
      v
[web/src/api-sdk/*-api.ts]   browser business API
      |
      v
[Feature / React Query / Hook]
```

## 1. Model schema

- Define business tables in `api/src/models/<domain>/schema.ts` with Drizzle
  `pgTable`.
- Keep PostgreSQL column identifiers in `snake_case`.
- Derive row types from the table with `$inferSelect` and `$inferInsert`; do
  not manually restate the row shape.
- Export the table and row types needed by the domain Model. Do not put HTTP
  request or response schemas in the Drizzle schema file.
- Add every new table to the sole aggregate entry,
  `api/src/models/schema.ts`.
- Follow `database-schema-migrations.md` for every schema change.

## 2. Domain Model

Keep persistence, domain validation, invariants, and projections in
`api/src/models/<domain>/index.ts` or a focused sibling module owned by that
domain.

- Use `createDbServerModel` for ordinary single-table CRUD that it already
  expresses. Add named functions for joins, transactions, lifecycle changes,
  invariants, and domain-specific queries.
- A Model operation that accepts untrusted domain input must parse it with a
  Zod schema at the Model boundary. Derive its TypeScript input/output with
  `z.input`, `z.output`, or `z.infer`; do not duplicate the shape manually.
- Accept domain input in `camelCase`. Convert it to Drizzle `snake_case` row
  fields in one Model mapping function before persistence.
- Do not expose raw database rows as API responses. Project rows to
  `camelCase` domain objects in the Model, at the earliest boundary leaving
  persistence.
- Keep transport concerns such as status codes, cookies, and Hono contexts out
  of Models. Represent expected domain conflicts with specific errors or
  explicit results that Handlers can map.
- Export the domain through `api/src/models/index.ts`. Re-export focused table
  and domain types from the domain module when callers genuinely need them.

Handlers must not add new direct Drizzle queries or duplicate Model
projections. Existing direct-query Handlers are legacy paths to converge when
the touched behavior can move cleanly to its owning Model; do not broaden the
task into an unrelated migration.

## 3. Contracts and OpenAPI routes

Define each HTTP operation in
`api/src/routes/<domain>/<domain>.routes.ts` with `createRoute`.

- Put path, query, body, response, tag, summary, and documented error statuses
  in the route definition.
- Use `jsonContent` or `jsonContentRequired`, `responseSchema`,
  `httpErrorSchema`, and the existing validation error schemas instead of
  inventing an envelope.
- A contract used across API and Web, or owned by an existing capability,
  belongs in the matching `@springbrand/*` package, usually
  `@springbrand/http`. Export both its Zod schema and inferred TypeScript type.
- A schema used by only one route may remain in `*.routes.ts`.
- Reuse a Model/domain schema only when it describes the same trust boundary
  and public meaning. Never expose the Drizzle row schema as the HTTP contract.
- Keep wire fields in `camelCase` unless an externally owned protocol requires
  another shape.

## 4. Handlers and registration

Implement HTTP behavior in `<domain>.handlers.ts`.

- Type handlers with `AppRouteHandler<typeof routes.<operation>>` or the
  equivalent context derived from that route.
- Authenticate and authorize first, then read `c.req.valid(...)`, call the
  owning Model/service, map expected domain outcomes, and return through
  `@springbrand/http/worker` helpers such as `ok`, `httpNotFound`, and
  `httpUnauthorized`.
- Do not redefine request validation, business rules, projections, response
  envelopes, or database access in the Handler.

Register route/handler pairs in `<domain>.index.ts` with
`createRouter().openapi(...)`, then mount a new domain router in
`api/src/app.ts`. Registration files contain wiring, not business behavior.

## 5. Browser API and feature consumption

Add the browser boundary in `web/src/api-sdk/<domain>-api.ts`.

- Use `requestApi` from `web/src/lib/rpc.ts`; do not create another fetch
  client or repeat authentication/error handling.
- Import shared request and response types from their owning
  `@springbrand/*` package. Do not manually copy a route schema into Web.
- Keep SDK functions thin: serialize path/query/body, call the endpoint, and
  return the typed result. Export stable React Query keys beside the relevant
  SDK operation when the domain uses them.
- Keep caching, invalidation, loading state, optimistic behavior, and UI error
  presentation in the Feature, React Query hook, or controller, not the SDK.

## 6. Verification

Add the narrowest tests that prove each changed boundary:

- Model tests for input rejection, invariants, row mapping, projections, and
  meaningful query edge cases; use PostgreSQL integration tests when SQL,
  constraints, or transactions are part of the behavior.
- Route/Handler tests for authentication, validated input, documented status
  mapping, response shape, and important domain failures.
- SDK tests only when query serialization, request options, or response
  handling contains behavior worth testing.
- Feature/Hook tests for React Query cache keys, invalidation, loading, error,
  or optimistic state when those behaviors change.

Do not test `createRouter().openapi(...)` wiring in isolation. Finish with the
narrow checks first, then run the affected workspace checks and tests.

This rule applies to new and materially changed interfaces. It does not require
a bulk rewrite of untouched legacy endpoints.
