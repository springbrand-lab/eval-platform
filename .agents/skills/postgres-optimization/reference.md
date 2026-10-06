# PostgreSQL 17 Planner & Internals Reference

## Query Planner Architecture

### Planning Phases

1. **Parse** — SQL text → parse tree
2. **Analyze/Rewrite** — resolve names, apply rules/views → query tree
3. **Plan** — query tree → plan tree (cheapest expected cost)
4. **Execute** — plan tree → result rows

The planner (optimizer) in phase 3 is cost-based. It enumerates possible plans and picks the one with the lowest estimated total cost.

### Cost Model

PostgreSQL costs are in arbitrary units calibrated to sequential page reads.

```
Total cost = startup cost + run cost

Startup cost: work before the first row is returned (e.g., sort)
Run cost: cost to return all rows
```

**Cost parameters and their meaning:**

| Parameter | Default | Represents |
|-----------|---------|------------|
| `seq_page_cost` | 1.0 | Cost of a sequential disk page read (baseline) |
| `random_page_cost` | 4.0 | Cost of a random disk page read |
| `cpu_tuple_cost` | 0.01 | Cost to process one row |
| `cpu_index_tuple_cost` | 0.005 | Cost to process one index entry |
| `cpu_operator_cost` | 0.0025 | Cost to apply one operator/function |
| `parallel_tuple_cost` | 0.1 | Cost to transfer a row from worker to leader |
| `parallel_setup_cost` | 1000 | One-time cost to launch parallel workers |

**For SSDs**, set:
```sql
ALTER SYSTEM SET random_page_cost = 1.1;
ALTER SYSTEM SET effective_io_concurrency = 200;
SELECT pg_reload_conf();
```

### How the Planner Estimates Rows

Row estimation is the most critical part of planning. Bad estimates → bad plans.

**Single column selectivity:**
```
estimated_rows = total_rows × selectivity

-- For equality: selectivity = 1 / n_distinct (if uniform)
-- For range: selectivity = (high - value) / (high - low)
-- For MCV values: selectivity = frequency from pg_stats
-- For non-MCV values: spread remaining frequency over remaining distinct values
```

**Multi-column selectivity (without extended stats):**
```
combined_selectivity = sel_col1 × sel_col2 × ... × sel_colN
```
This independence assumption breaks badly for correlated columns.

**With extended statistics:**
- **dependencies**: planner knows col1 determines col2, adjusts selectivity
- **ndistinct**: planner knows actual distinct count for column groups
- **MCV lists**: planner has joint frequency distribution for common value combos

### Statistics Storage

Per-column stats are in `pg_stats`:

```sql
SELECT attname, n_distinct, most_common_vals, most_common_freqs,
       histogram_bounds, correlation
FROM pg_stats
WHERE tablename = 'orders' AND attname = 'status';
```

Key fields:
- `n_distinct`: negative = fraction of rows (e.g., -0.5 = 50% unique), positive = exact count
- `correlation`: physical vs logical ordering (1.0 = perfectly ordered, 0.0 = random). High correlation → BRIN indexes work well, planner prefers index scans.
- `most_common_vals` / `most_common_freqs`: top values and their frequencies
- `histogram_bounds`: equi-depth histogram of non-MCV values

### Increasing Statistics Granularity

```sql
-- Per-column (useful for highly skewed columns)
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;
ANALYZE orders;

-- Global default
SET default_statistics_target = 500;
```

Higher targets = more histogram buckets + more MCV entries = better estimates but slower ANALYZE.

## Join Algorithms

### Nested Loop

```
For each row in outer:
    For each matching row in inner:
        emit combined row
```

- **Best when**: outer is small, inner has a fast index lookup
- **Cost**: O(N × M) worst case, O(N × log M) with index on inner
- **Planner chooses this when**: one side is small or an index exists on the join key

### Hash Join

```
Build phase: scan inner, build hash table on join key
Probe phase: scan outer, probe hash table for matches
```

- **Best when**: no useful indexes, both sides are medium-large
- **Cost**: O(N + M) if hash fits in `work_mem`
- **Spills to disk**: when hash table exceeds `work_mem` (look for `Batches > 1` in EXPLAIN)
- **Parallel hash**: PG17 supports parallel hash join build

### Merge Join

```
Sort both sides on join key
Walk both sorted streams, matching rows
```

- **Best when**: both sides are pre-sorted (index scan) or large enough that sort + merge < hash
- **Cost**: O(N log N + M log M) for sort, O(N + M) for merge
- **Planner chooses this when**: inputs are already sorted or sort is cheap

### Join Order Optimization

- For ≤ `geqo_threshold` tables (default 12): exhaustive dynamic programming search
- For > `geqo_threshold` tables: Genetic Query Optimizer (GEQO) — heuristic, non-deterministic
- `join_collapse_limit` (default 8): explicit JOINs with > this many tables won't be reordered
- `from_collapse_limit` (default 8): subqueries in FROM with > this many tables won't be flattened

## Plan Node Types

### Scan Nodes

| Node | When Used | Notes |
|------|-----------|-------|
| Seq Scan | No usable index or table is small | Reads entire table sequentially |
| Index Scan | Selective index condition | Reads index then heap (random I/O) |
| Index Only Scan | All needed columns in index (covering) | Skips heap if visibility map says all-visible |
| Bitmap Index Scan → Bitmap Heap Scan | Moderate selectivity, multiple conditions | Builds bitmap of pages, then reads them in order |
| TID Scan | `WHERE ctid = ...` | Direct tuple access |
| CTE Scan | Scanning a CTE | PG12+: planner can inline non-recursive CTEs |
| Function Scan | `FROM generate_series(...)` | Scans function output |

**Bitmap scan details**: when multiple indexes apply, planner can BitmapAnd / BitmapOr them. Lossy bitmaps (when bitmap exceeds `work_mem`) store page-level instead of tuple-level, requiring recheck.

### Join Nodes

| Node | Algorithm |
|------|-----------|
| Nested Loop | For each outer row, scan inner |
| Hash Join | Build hash table on inner, probe with outer |
| Merge Join | Sort-merge both sides |

### Aggregation Nodes

| Node | When Used |
|------|-----------|
| Aggregate | Simple aggregation (no GROUP BY, or small groups) |
| HashAggregate | GROUP BY with moderate group count fitting work_mem |
| GroupAggregate | GROUP BY on pre-sorted input |
| Mixed Aggregate | Combination for GROUPING SETS |

### Other Important Nodes

| Node | Purpose |
|------|---------|
| Sort | Explicit sort (check `Sort Method` in EXPLAIN) |
| Incremental Sort | PG13+: sorts on additional keys when leading keys are pre-sorted |
| Materialize | Caches result of inner side for nested loop re-reads |
| Memoize | PG14+: caches inner side results by key (parameterized nested loop) |
| Gather / Gather Merge | Collects rows from parallel workers |
| Append | Combines results (UNION ALL, partitioned table scans) |
| MergeAppend | Combines pre-sorted results (partitioned table with ORDER BY) |
| Limit | Stops execution after N rows — can dramatically reduce cost if planner accounts for it |

## MVCC and Bloat

### How MVCC Affects Performance

Every UPDATE creates a new row version. Old versions remain until VACUUM removes them. This causes:

- **Table bloat**: dead tuples waste space, cause extra I/O
- **Index bloat**: index entries pointing to dead tuples
- **HOT updates**: if updated columns are not indexed AND new tuple fits on same page, no index update needed. Design indexes to enable HOT.

### VACUUM Tuning

```sql
-- Check autovacuum effectiveness
SELECT relname, last_vacuum, last_autovacuum, n_dead_tup,
       n_live_tup, autovacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;

-- Aggressive settings for high-churn tables
ALTER TABLE hot_table SET (
    autovacuum_vacuum_scale_factor = 0.01,     -- default 0.2
    autovacuum_vacuum_threshold = 1000,          -- default 50
    autovacuum_analyze_scale_factor = 0.005,     -- default 0.1
    autovacuum_vacuum_cost_delay = 2             -- default 2ms (PG17)
);
```

### Preventing Bloat

- Tune autovacuum to run more frequently on high-write tables
- Avoid long-running transactions (hold back xmin, prevent VACUUM)
- Monitor `pg_stat_user_tables.n_dead_tup`
- Use `pg_repack` for zero-downtime table compaction if needed

## Page Layout and TOAST

### Heap Page Structure (8 KB default)

```
[Page Header (24 bytes)]
[Item Pointers → point to tuples]
[Free Space]
[Tuples (from end of page, growing backwards)]
[Special Space (for index pages)]
```

- Each tuple has a 23-byte header (xmin, xmax, ctid, infomask, etc.)
- Maximum row size = page size - header overhead ≈ 8160 bytes
- Columns wider than ~2 KB trigger TOAST (The Oversized-Attribute Storage Technique)

### TOAST Strategies

| Strategy | Behavior |
|----------|----------|
| `PLAIN` | No TOAST, no compression (fixed-width types) |
| `EXTENDED` | Compress first, then move to TOAST table if still too large (default for variable-width) |
| `EXTERNAL` | Move to TOAST table without compressing (better for already-compressed data) |
| `MAIN` | Compress but try to keep inline (last resort: TOAST) |

For JSONB columns that are frequently read: `EXTERNAL` avoids decompression cost. For rarely-read large text: `EXTENDED` saves space.

## Application Concurrency and Batching

### Repository Batch Ownership

[`api/src/db/batch.ts`](../../../api/src/db/batch.ts) is the repository's deep module for executing multiple prebuilt Drizzle statements. Callers choose only the required semantics:

```text
must commit together  -> executeAtomicBatch
independent statements -> executeIndependentBatch
needs prior JS result  -> sequential queries or one dependent SQL/CTE
```

The module owns pipeline detection, checked-out client lifecycle, ordered results, draining, transaction behavior, sequential fallback, and release. Do not reproduce those responsibilities in models, routes, or payment handlers.

Set-based SQL remains preferable because it removes statements rather than only overlapping protocol waits.

### Three Different Forms of Parallel Work

Do not conflate these mechanisms:

| Mechanism | What becomes concurrent | What it improves |
|---|---|---|
| PostgreSQL parallel plan | Workers inside one SQL statement | CPU/scan time for eligible large queries |
| Driver pipeline | Protocol messages for several SQL statements on one connection | Network idle time between statements |
| Pool concurrency | Queries on several PostgreSQL connections | Throughput for independent work |

Only set-based SQL reduces the number of SQL statements. Pipeline and pool concurrency retain the original database work.

### Simple, Extended, and Pipelined Query Flow

- A parameterized driver query normally uses PostgreSQL's extended protocol.
- Without pipeline support, drivers commonly wait for one query cycle before sending the next.
- Pipeline-capable drivers can send several extended query cycles before reading their responses.
- PostgreSQL processes one connection's statements in order; pipelining overlaps client/server communication rather than executing statements simultaneously on that backend.
- Independent execution on the database requires multiple connections or PostgreSQL parallel workers.

Never replace parameterized statements with a concatenated multi-command string merely to save round trips. It weakens parameter safety, result attribution, cancellation, and error handling.

### Pipeline Inside a Transaction

The Batch module pipelines only statements that are fully known before submission:

```text
BEGIN (await)
  submit statement 1
  submit statement 2
  submit statement 3
  await/drain all results
COMMIT
```

If one statement fails, PostgreSQL marks the transaction aborted. Drain every submitted result, then roll back. Do not release the client with in-flight responses.

Application code should obtain this behavior through `executeAtomicBatch`; the protocol shape below explains its implementation rather than providing a second caller pattern.

Pipeline is inappropriate for this shape:

```text
row = INSERT ... RETURNING id
if row.kind == "x":
    UPDATE ... USING row.id
else:
    DELETE ... USING row.id
```

Use sequential execution or move the dependency into a data-modifying CTE.

### Set-Based Input Relations

Choose the input relation by payload shape:

| Input | Recommended form |
|---|---|
| One scalar array | `unnest($1::text[])` or `column = ANY($1)` |
| A small fixed list of tuples | `VALUES ($1, $2), ...` |
| Dynamic structured rows | `jsonb_to_recordset($1::jsonb)` |
| Rows already in the database | Join the source table/CTE directly |

For optimistic updates with different expected versions, preserve conflict detection in the bulk statement. A bulk `WHERE target.version = input.version` silently skips stale rows unless the caller validates the returned row count. Either compare `RETURNING` with the input set or deliberately raise/encode a conflict.

### CAS vs Row Locks

| Condition | Prefer |
|---|---|
| Low contention, cheap recomputation | Version CAS with bounded retry |
| Frequent contention, several dependent reads | `SELECT ... FOR UPDATE` |
| Workers claim unrelated jobs | `FOR UPDATE SKIP LOCKED` |
| Cross-row invariant | Stable ordered row locks or one constraint-backed statement |

CAS retry must restart from fresh committed facts; retrying only the final `UPDATE` reuses stale calculations.

### Deadlock Prevention

- Acquire the same tables and rows in the same order across code paths.
- Lock the narrowest rows needed.
- Avoid user interaction, HTTP, object storage, or provider calls inside a transaction.
- Keep retry limits and total deadlines explicit.
- Record retry reason separately for unique conflicts, CAS misses, deadlocks, serialization failures, and timeouts.

### Pool Sizing

Estimate a global budget before changing per-process pool size:

```text
total_possible_connections = instance_count × pool_max + maintenance_connections
```

Keep this below PostgreSQL's usable connection limit with operational headroom. Increasing `pool_max` can reduce local queueing while worsening database scheduling, memory use, and lock contention. Reduce SQL per request and add admission/backpressure before enlarging the pool.

## PostgreSQL 17 Notable Optimizer Improvements

- **Incremental sort improvements**: better cost modeling for incremental sorts
- **Improved partition pruning**: faster pruning with many partitions
- **MERGE command improvements**: better optimization of MERGE statements
- **Parallel hash join build**: multiple workers can build the hash table
- **Better JSON/JSONB support**: `JSON_TABLE`, `JSON_EXISTS`, and other SQL/JSON standard functions
- **Vacuum improvements**: more efficient dead tuple tracking, reduced overhead
- **Logical replication improvements**: performance and monitoring enhancements
