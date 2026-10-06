# Workspace and Package Boundaries

The filename is retained only for migration history. The rules below describe
this repository's current workspace boundaries.

This repository has four application contexts:

- `web`: browser UI and browser-side API clients;
- `api`: Node/PostgreSQL business API;
- `agent`: Cloudflare Agent runtime and host integration;
- `creation-page`: public Creation delivery Worker.

Shared capabilities live in the owning `@springbrand/*` packages documented
in the root `AGENTS.md`.

## Boundary rules

- Start in the context that owns the requested behavior.
- Search the relevant package and its callers before adding application-local
  logic.
- Import across boundaries through public package exports or HTTP contracts,
  never by traversing into another workspace's source tree.
- Web must consume browser-safe contracts and API responses; it must not import
  Agent runtime implementation entry points.
- Do not copy DTOs, schemas, helpers, state machines, or UI primitives across
  contexts.
- If two real consumers need runtime-agnostic logic, move it to the existing
  owning package. Do not create a new package for a hypothetical second user.
- For published `@springbrand/*` packages, change upstream and upgrade the
  exact dependency. Never edit `node_modules` or fork package behavior in the
  application.
- When a replacement crosses a boundary, migrate all callers and remove the old
  path so only one source of truth remains.

A feature may legitimately require coordinated changes across several contexts.
That is not itself a violation. Ask for direction only when the cross-context
work materially expands the requested product behavior, public API, security
boundary, or deployment scope.
