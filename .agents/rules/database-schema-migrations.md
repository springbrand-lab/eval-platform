# PostgreSQL Schema and Drizzle Migrations

Applies to API business schema and migration work.

Read `api-interface-implementation.md` for Model ownership, table placement,
types, projections, routes, Handlers, and Web consumption. This file owns only
the migration workflow and database-operation safety.

## Migration workflow

A committed schema change must include its PostgreSQL migration unless the task
explicitly separates those deliverables.

1. Change the owning model schema.
2. Run `pnpm db:generate`.
3. Review the generated SQL and metadata. Drizzle output is a draft, not proof
   that renames, data movement, defaults, constraints, or destructive ordering
   are correct.
4. Run `pnpm db:check`.
5. Run the narrow model tests and, when database behavior is involved, the
   relevant PostgreSQL integration test.

The runtime migration directory is `api/migrations-postgres/`. The legacy
`api/migrations/` directory only documents the former D1 export and must not
receive new runtime migrations.

## Safety

- `pnpm db:migrate:local` is for the repository's local PostgreSQL only.
- Never point a local migration command at dev, staging, production, or another
  shared database.
- Do not apply remote migrations out of band. Use the repository's deployment
  workflow or an explicitly authorized operator procedure.
- Resolve and display the exact target before any schema-mutating operation.
- Do not use `drizzle-kit push` against shared databases.

For destructive changes, prefer expand/contract: first add a representation
that old and new code can both tolerate, migrate/backfill safely, switch
callers, and remove the old representation in a later compatible change.
Treat drops, renames, type narrowing, `NOT NULL` tightening, and raw data
rewrites as destructive until reviewed otherwise.

For indexes on live tables, consider PostgreSQL locking and use a concurrent
strategy when the migration runner and operation support it. Verify the actual
generated SQL rather than assuming Drizzle selected the safe form.
