---
name: postgres-optimization
description: Optimize PostgreSQL 17 queries, schemas, indexes, request-level SQL batches, round trips, and concurrent transaction behavior. Use for slow queries, N+1 calls, excessive SQL per request, bulk writes, connection-pool pressure, lock contention, query plans, schema design, index selection, planner behavior, or database tuning. Also use when writing or reviewing raw SQL passed to SQLAlchemy text() — bind parameters, literal colons, and the phantom-bind hazard.
---

# PostgreSQL 17 Optimization

## Diagnose the Right Layer First

Do not assume every database performance problem is a slow-query problem.

| Symptom | Measure first | Primary fixes |
|---|---|---|
| One SQL statement is slow | `EXPLAIN (ANALYZE, BUFFERS)` | Plan, index, statistics, query rewrite |
| One request emits many SQL statements | Request-level query count and round trips | Set-based SQL, bulk DML, remove duplicate reads |
| Many independent statements wait on network latency | Per-request DB time vs server execution time | Driver pipelining or bounded parallel submission |
| Concurrent requests block or retry | `pg_stat_activity`, `pg_locks`, retry/lock metrics | Lock order, CAS, row locks, shorter transactions |
| Pool saturation | Pool wait time, active/idle counts, DB connection limit | Backpressure, query-count reduction, pool sizing |

`EXPLAIN` cannot reveal application-level N+1 calls or network round trips across separate statements. Trace and count the whole request before optimizing individual plans.

## Reading EXPLAIN / EXPLAIN ANALYZE

For a slow individual statement, start by examining the query plan. For request-level batching, count statements and round trips first, then inspect the dominant statements.

### Getting a Plan

```sql
-- Estimated plan (does not execute)
EXPLAIN (FORMAT JSON, VERBOSE) SELECT ...;

-- Actual execution stats (executes the query)
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ...;

-- Safe for writes (wraps in transaction + rollback)
BEGIN; EXPLAIN (ANALYZE, BUFFERS) UPDATE ...; ROLLBACK;
```

### Key Metrics to Check

| Metric | What it tells you |
|--------|-------------------|
| `actual time` vs `estimated rows` | Row estimate accuracy — bad estimates cascade into bad plans |
| `Buffers: shared hit` vs `shared read` | Cache hit ratio — high `read` means disk I/O |
| `rows removed by filter` | Post-fetch filtering — sign of missing or wrong index |
| `Sort Method: external merge` | `work_mem` too small for the sort |
| `Hash Batch > 1` | Hash spilling to disk — increase `work_mem` |
| `loops` | Nested loop iteration count — multiply inner costs by this |

### Red Flags in Plans

- **Seq Scan on large table with low selectivity** — missing index
- **Nested Loop with high loop count** — consider Hash or Merge Join
- **Bitmap Heap Scan → Recheck Cond** — lossy bitmap, too many matching rows
- **Index Scan with Filter** — index doesn't cover all WHERE clauses
- **Materialize inside nested loop** — subquery re-execution; consider CTE or lateral join
- **SubPlan (not InitPlan)** — correlated subquery executing per-row

## Index Strategy

### Index Type Selection

| Index Type | Best For | Not For |
|------------|----------|---------|
| **B-tree** (default) | Equality, range, sorting, `IS NULL` | Arrays, full-text, geometric |
| **Hash** | Equality-only lookups (PG17: now WAL-logged, crash-safe) | Range queries, sorting |
| **GIN** | Arrays (`@>`), JSONB, full-text (`tsvector`), trigram | Range queries, high-write tables |
| **GiST** | Geometric, range types, full-text (ranking), nearest-neighbor | Exact equality on scalars |
| **BRIN** | Physically ordered data (timestamps, sequences), huge tables | Randomly ordered data |
| **SP-GiST** | Non-balanced structures (IP addresses, phone numbers) | General purpose |

### Index Design Principles

1. **Column order matters for B-tree**: leftmost prefix rule applies. Put equality columns first, then range columns, then sort columns.
2. **Covering indexes** (`INCLUDE`): add non-searchable columns to avoid heap fetches (index-only scans).
3. **Partial indexes**: `WHERE active = true` — smaller, faster, and only maintained for matching rows.
4. **Expression indexes**: `CREATE INDEX ON t ((lower(email)))` for queries that filter on expressions.
5. **Multicolumn GIN**: for JSONB queries filtering on multiple keys.

### When NOT to Add an Index

- Table has < ~10k rows (seq scan is often faster)
- Column has very low selectivity (e.g., boolean with 50/50 distribution)
- Write-heavy table where index maintenance cost dominates
- Query is rarely executed

### Checking Index Usage

```sql
-- Unused indexes (candidates for removal)
SELECT schemaname, relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- Index vs sequential scan ratio
SELECT relname,
       seq_scan, idx_scan,
       ROUND(100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 1) AS idx_pct
FROM pg_stat_user_tables
ORDER BY seq_scan DESC;
```

## Extended Statistics

PostgreSQL assumes column independence by default. When columns are correlated, the planner produces wrong row estimates. Extended statistics fix this.

### When to Create Extended Statistics

- **Functional dependencies**: one column determines another (e.g., `city` → `zip_code`)
- **Correlated columns**: filtering on multiple correlated columns causes severe under/over-estimation
- **Multicolumn GROUP BY**: planner overestimates distinct groups

### Creating Extended Stats

```sql
-- ndistinct: corrects GROUP BY estimates
CREATE STATISTICS s_orders_ndistinct (ndistinct)
    ON customer_id, product_category FROM orders;

-- dependencies: corrects WHERE clause estimates for correlated columns
CREATE STATISTICS s_address_deps (dependencies)
    ON city, zip_code FROM addresses;

-- MCV (most common values): best for skewed correlated data
CREATE STATISTICS s_orders_mcv (mcv)
    ON customer_id, status FROM orders;

-- Combine all types
CREATE STATISTICS s_orders_all (ndistinct, dependencies, mcv)
    ON customer_id, product_category, status FROM orders;

-- Must ANALYZE after creating
ANALYZE orders;
```

### Verifying Stats Are Used

```sql
-- Check extended stats
SELECT stxname, stxkeys, stxkind
FROM pg_statistic_ext
JOIN pg_statistic_ext_data ON stxoid = stxoid
WHERE stxrelid = 'orders'::regclass;

-- Compare row estimates before/after
EXPLAIN SELECT ... ;  -- check "rows" estimate
```

## Request-Level Batching and Concurrency

### Repository Batch Deep Module — Use This Seam

In this repository, batch execution is owned by [`api/src/db/batch.ts`](../../../api/src/db/batch.ts). Before writing a transaction loop, checking out a PostgreSQL client, enabling pipeline behavior at a caller, or using `Promise.all` over database statements, use this module.

```typescript
import {
  executeAtomicBatch,
  executeIndependentBatch,
} from "../../db/batch";
```

Choose its interface by semantics:

| Interface | Use when | Guarantees |
|---|---|---|
| `executeAtomicBatch(db, statements)` | All prebuilt statements must commit or roll back together | One transaction; submission and result order preserved; pipeline when available; sequential fallback |
| `executeIndependentBatch(db, statements)` | Statements are independent and need no shared transaction | One checked-out client; result order preserved; pipeline when available; sequential fallback; client released after drain |

Both interfaces accept fully prebuilt `SQLWrapper[]` statements. They do not support JavaScript branching on an intermediate result. For dependent work, use sequential queries or move the dependency into one SQL statement/CTE.

The priority is:

1. One set-based SQL statement when the work can be expressed as a relation.
2. The Batch deep module when multiple prebuilt statements remain.
3. Sequential execution only when application code needs an earlier result.

Do not create another batch helper, import the deleted `db/transaction` path, or reproduce client checkout, pipeline detection, result draining, transaction, or release logic in a caller. Only work below this seam when maintaining the Batch module itself. Its interface behavior is covered by [`api/src/db/batch.node.test.ts`](../../../api/src/db/batch.node.test.ts).

### Preferred Order

Optimize multiple SQL calls in this order:

1. **Remove duplicate reads.** Reuse facts already returned by the owning query or mutation.
2. **Replace loops with set-based SQL.** Prefer one `JOIN`, multi-row `INSERT`, `UPDATE ... FROM`, `DELETE ... USING`, `unnest`, or `jsonb_to_recordset` statement.
3. **Batch invariant reads.** Fetch rows for all requested identifiers with `IN`, `ANY`, or a joined input relation.
4. **Use the Batch deep module for remaining statements.** It owns pipeline, transaction/client lifecycle, ordered results, draining, and sequential fallback.
5. **Tune pools and server parameters last.** A larger pool does not repair excessive SQL and can amplify contention.

### Decision Table

| Statements | Correct execution shape |
|---|---|
| Independent reads outside a transaction | One joined/set query first; otherwise `executeIndependentBatch` |
| Prebuilt statements in one transaction with no JavaScript result dependency | `executeAtomicBatch` |
| A later statement needs an earlier result in application code | Sequential `await`, or rewrite as one SQL/CTE |
| Many rows receive the same change | One `UPDATE ... WHERE id = ANY(...)` |
| Many rows receive different changes | `UPDATE ... FROM (VALUES ...)` or `jsonb_to_recordset` |
| Many inserts | One multi-row `INSERT ... VALUES (...)` or `INSERT ... SELECT` |
| Multiple writers mutate the same aggregate | One aggregate mutation with CAS or `SELECT ... FOR UPDATE` |
| Workers claim independent jobs | `FOR UPDATE SKIP LOCKED` with a bounded batch |

### Set-Based Bulk DML

Use parameterized input relations instead of constructing one statement per row.

```sql
UPDATE user_agents AS target
SET runtime_plan = input.runtime_plan
FROM jsonb_to_recordset($1::jsonb) AS input(
  id text,
  revision bigint,
  runtime_plan jsonb
)
WHERE target.id = input.id
  AND target.revision = input.revision;
```

For bulk inserts:

```sql
INSERT INTO events (id, account_id, body)
SELECT id, account_id, body
FROM jsonb_to_recordset($1::jsonb) AS input(
  id text,
  account_id text,
  body jsonb
);
```

Keep payloads bounded. Chunk large batches when parameter count, statement size, lock duration, memory, or failure blast radius becomes material. Choose chunk size from measurement rather than a universal constant.

### Batch Execution Is Not Set-Based SQL

Pipelining sends multiple parameterized statements without waiting for each response. The server still executes distinct statements and returns distinct results.

- Call `executeAtomicBatch` or `executeIndependentBatch`; the Batch module owns client and pipeline details.
- Preserve deterministic statement order when constructing the input array.
- Do not pipeline when application code must branch on an intermediate result.
- Do not call pool-level `query()` for a transaction; use `executeAtomicBatch`.
- Do not concatenate parameterized SQL into a semicolon-delimited string as a batching shortcut.

The Batch module reduces round-trip latency but does not reduce SQL count, planning, locks, WAL, or database CPU. Continue to prefer set-based SQL where possible.

### Concurrent Writes

Choose one owner for an aggregate mutation and keep its read-check-write sequence together.

**Optimistic CAS** is appropriate when contention is expected to be low:

```sql
UPDATE credit_accounts
SET available_units = $1, version = version + 1
WHERE user_id = $2 AND version = $3
RETURNING *;
```

Zero returned rows means the caller lost the race. Retry the complete mutation from fresh facts with a small, explicit limit.

**Row locking** is appropriate when contention is frequent or a mutation needs several dependent reads:

```sql
SELECT * FROM credit_accounts
WHERE user_id = $1
FOR UPDATE;
```

- Lock rows in a stable order to reduce deadlocks.
- Keep transactions short; never hold a database lock across provider/network calls.
- Treat serialization failures and deadlocks as bounded retryable transaction failures.
- Use advisory locks only for coordination that cannot be represented by locking owned rows.

### Pooling and Backpressure

- Measure pool wait time separately from query execution time.
- Bound application concurrency before increasing pool size.
- Size the pool across all application instances against PostgreSQL's connection budget.
- Set statement, lock, and transaction timeouts appropriate to the workload.
- A request-level SQL budget is a regression signal, not a universal hard limit. Add focused query-count tests for known hot paths.

Read [reference.md](reference.md#application-concurrency-and-batching) when choosing pipeline, CAS, row locks, or pool behavior. See [examples.md](examples.md#example-8-replace-an-application-n1-loop-with-one-query) for worked batch rewrites.

## Schema Design Patterns

### Normalization Guidelines

- Normalize to 3NF by default. Denormalize only with measured justification.
- Use `BIGINT` or `UUID` for primary keys. Avoid `SERIAL` for new schemas (use `GENERATED ALWAYS AS IDENTITY`).
- Add `NOT NULL` constraints everywhere possible — helps the planner.
- Use `CHECK` constraints — the planner can skip partitions and simplify plans.

### Partitioning

Use partitioning when:
- Table exceeds ~100M rows or ~100 GB
- Queries consistently filter on the partition key
- You need efficient bulk deletion (drop partition)

```sql
-- Range partitioning by date
CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    created_at TIMESTAMPTZ NOT NULL,
    payload JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2025_q1 PARTITION OF events
    FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');
```

**Partition key selection**: choose the column most frequently in WHERE clauses. Avoid over-partitioning (100s of partitions add planner overhead).

### JSONB Best Practices

- Use typed columns for frequently queried fields; reserve JSONB for variable/sparse data.
- Always create GIN index: `CREATE INDEX ON t USING GIN (data jsonb_path_ops)` for containment queries.
- `jsonb_path_ops` is smaller and faster than default GIN for `@>` queries; use default GIN if you need `?`, `?|`, `?&` operators.

## Server Configuration Tuning

### Memory Parameters

| Parameter | Starting Point | Notes |
|-----------|---------------|-------|
| `shared_buffers` | 25% of RAM | Diminishing returns past ~8 GB |
| `effective_cache_size` | 50-75% of RAM | Hint to planner, not allocation |
| `work_mem` | 32-256 MB | Per-sort/hash operation; `SET LOCAL` for heavy queries |
| `maintenance_work_mem` | 512 MB - 2 GB | For VACUUM, CREATE INDEX, ALTER TABLE |
| `huge_pages` | `try` | Reduce TLB misses for shared_buffers |

### Planner Parameters

| Parameter | Default | When to adjust |
|-----------|---------|----------------|
| `random_page_cost` | 4.0 | Lower to 1.1-1.5 for SSDs |
| `effective_io_concurrency` | 1 | Raise to 200 for SSDs |
| `cpu_tuple_cost` | 0.01 | Rarely needs adjustment |
| `default_statistics_target` | 100 | Increase for skewed distributions (up to 10000) |
| `jit` | on | Disable if JIT overhead exceeds benefit on short queries |
| `plan_cache_mode` | auto | Force `generic_plan` or `custom_plan` for prepared statements |

### Parallelism

```sql
-- Check current settings
SHOW max_parallel_workers_per_gather;  -- default: 2
SHOW min_parallel_table_scan_size;     -- default: 8MB
SHOW parallel_tuple_cost;              -- default: 0.1

-- For large analytical queries, increase per-session
SET max_parallel_workers_per_gather = 4;
```

## Optimization Workflow

When asked to optimize a query or schema:

1. **Identify the scope**: one statement, one request, one transaction, or concurrent requests.
2. **Count statements and round trips** for request/transaction problems; get `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for slow statements.
3. **Remove multiplicative work**: application loops, correlated subqueries, repeated reconciliation, duplicate post-write reads.
4. **Use set-based SQL**, then the repository Batch deep module, before pool or server changes.
5. **Identify the bottleneck**: plan node, network wait, lock wait, pool wait, or retry churn.
6. **Check row estimates**: compare estimated vs actual rows. Off by >10x needs attention.
7. **Fix statistics, indexes, and join strategy** where the plan proves they matter.
8. **Verify concurrency semantics**: atomicity, idempotency, lock order, CAS/serialization retry, and rollback.
9. **Tune pipeline, pool, and server parameters last**.

## Diagnostic Queries

```sql
-- Table bloat estimate
SELECT schemaname, relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 20;

-- Cache hit ratio (should be > 99%)
SELECT
    sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0) AS cache_hit_ratio
FROM pg_statio_user_tables;

-- Slow queries (requires pg_stat_statements)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;

-- Lock contention
SELECT blocked.pid, blocked.query AS blocked_query,
       blocking.pid AS blocking_pid, blocking.query AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
JOIN pg_locks gl ON gl.locktype = bl.locktype
    AND gl.database IS NOT DISTINCT FROM bl.database
    AND gl.relation IS NOT DISTINCT FROM bl.relation
    AND gl.page IS NOT DISTINCT FROM bl.page
    AND gl.tuple IS NOT DISTINCT FROM bl.tuple
    AND gl.pid != bl.pid AND gl.granted
JOIN pg_stat_activity blocking ON blocking.pid = gl.pid;
```

## Raw SQL Safety — SQLAlchemy `text()` Bind Parameters

**`text()` parses `:name` as a named bind parameter ANYWHERE in the string — including inside quoted SQL string literals.** It does not understand SQL quoting. A literal colon followed by identifier characters silently becomes a phantom bind param, and every execution then fails with `A value is required for bind parameter 'name'`. `::` casts are safe (a double colon is never parsed as a bind).

This shipped as a real bug (PR #9920): a rename suffix `':retired-'` inside a quoted SQL literal compiled as a phantom `retired` bind param. Worse, the caller's savepoint guard swallowed the error, so the statement *silently never ran* in production — the failure mode is not always a visible crash.

### Rules when writing `text()` SQL

1. **No bare literal colons.** If a quoted SQL literal must contain `:`, escape it as `\:` (in a non-raw Python string: `'\\:'`):

   ```python
   # BUG: ':retired' compiles as a phantom bind parameter
   text("UPDATE t SET key = key || ':retired-' || id::text")

   # CORRECT: \: is SQLAlchemy's literal-colon escape
   text("UPDATE t SET key = key || '\\:retired-' || id::text")
   ```

   Better still, hoist the literal into a real bind param (`|| :suffix ||`) so there is no colon in the SQL string at all.

2. **Never interpolate runtime values into the SQL string** (f-string / `.format()` / concatenation) — use bind params. Interpolated values can inject SQL, and a value containing `:word` recreates the phantom-bind failure at runtime where no static check can see it. The one accepted codebase exception: `int()`-wrapped interval literals, e.g. `text(f"interval '{int(seconds)} seconds'")`.

3. **Guard every non-trivial `text()` statement with a compile-based test.** String-level assertions (`":retired" in sql`) cannot catch phantom binds — only compiling can. Compile against the real Postgres dialect and assert the *exact* bind set:

   ```python
   from sqlalchemy.dialects import postgresql

   compiled = stmt.compile(dialect=postgresql.dialect())
   assert sorted(compiled.binds) == ["org_id"]  # the ONLY intended binds
   assert "':retired-'" in str(compiled)  # escaped literal survived intact
   ```

4. **Quick audit of an existing statement**: `sqlalchemy.text(sql)._bindparams.keys()` lists every name `text()` actually parsed — anything unexpected in that set is a phantom bind. See `cc_core/tests/services/test_evaluate_usage_threshold.py` (the `compiled.binds` assertion) for the canonical regression-test shape, and commit `43b1a8a228` for the full worked example.

## Additional Resources

- For planner internals, cost model, and join algorithm details, see [reference.md](reference.md)
- For worked optimization examples, see [examples.md](examples.md)
- For project batch execution, use [`api/src/db/batch.ts`](../../../api/src/db/batch.ts)
