# PostgreSQL Optimization Examples

## Example 1: Fixing a Seq Scan with Missing Index

**Problem**: Slow query filtering on a non-indexed column.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE customer_email = 'alice@example.com';
```

**Bad plan:**
```
Seq Scan on orders  (cost=0.00..45123.00 rows=1 width=256)
  (actual time=312.456..892.123 rows=1 loops=1)
  Filter: (customer_email = 'alice@example.com')
  Rows Removed by Filter: 2000000
  Buffers: shared read=32456
```

**Diagnosis**: Seq Scan on 2M rows, removing 1,999,999 rows by filter. Classic missing index.

**Fix:**
```sql
CREATE INDEX idx_orders_customer_email ON orders (customer_email);
```

**Good plan after fix:**
```
Index Scan using idx_orders_customer_email on orders
  (cost=0.43..8.45 rows=1 width=256)
  (actual time=0.032..0.034 rows=1 loops=1)
  Index Cond: (customer_email = 'alice@example.com')
  Buffers: shared hit=4
```

**Improvement**: 892ms → 0.034ms, 32456 buffer reads → 4 buffer hits.

---

## Example 2: Bad Row Estimates from Correlated Columns

**Problem**: Planner badly underestimates rows for a multi-column filter.

```sql
EXPLAIN (ANALYZE)
SELECT * FROM addresses
WHERE city = 'San Francisco' AND zip_code = '94105';
```

**Bad plan:**
```
Bitmap Heap Scan on addresses  (cost=9.50..52.30 rows=1 width=128)
  (actual time=0.156..45.678 rows=8500 loops=1)
  Recheck Cond: (city = 'San Francisco')
  Filter: (zip_code = '94105')
  Rows Removed by Filter: 1500
  →  Bitmap Index Scan on idx_addresses_city
       (cost=0.00..9.50 rows=10000 width=0)
```

**Diagnosis**: Estimated 1 row, actual 8500 rows. The planner assumed `city` and `zip_code` are independent, but `zip_code = '94105'` is almost entirely within `city = 'San Francisco'`.

**Fix:**
```sql
CREATE STATISTICS s_address_city_zip (dependencies, mcv)
    ON city, zip_code FROM addresses;
ANALYZE addresses;
```

**After fix**, the planner estimates ~8400 rows (close to actual 8500) and may choose a different, more efficient plan for downstream joins.

---

## Example 3: Hash Join Spilling to Disk

**Problem**: Hash join using multiple batches (spilling to disk).

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.*, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.created_at > '2025-01-01';
```

**Bad plan:**
```
Hash Join  (cost=15000.00..89000.00 rows=500000 width=312)
  (actual time=2500.000..8900.000 rows=520000 loops=1)
  Buffers: shared hit=12000 read=45000, temp read=8000 written=8000
  →  Hash  (cost=12000.00..12000.00 rows=200000 width=64)
       Buckets: 32768  Batches: 16  Memory Usage: 4096kB
       →  Seq Scan on customers c ...
  →  Seq Scan on orders o ...
```

**Diagnosis**: `Batches: 16` means the hash table didn't fit in `work_mem` and spilled to disk 16 times. `temp read/written=8000` confirms disk spill.

**Fix:**
```sql
-- Increase work_mem for this session/query
SET LOCAL work_mem = '256MB';

-- Re-run the query — now fits in a single batch
```

**After fix**: `Batches: 1`, no temp reads/writes, execution time drops significantly.

---

## Example 4: Enabling Index-Only Scan with INCLUDE

**Problem**: Index Scan reads the heap even though only a few columns are needed.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT customer_id, total_amount
FROM orders
WHERE customer_id = 42;
```

**Plan:**
```
Index Scan using idx_orders_customer_id on orders
  (cost=0.43..125.00 rows=50 width=16)
  (actual time=0.045..2.345 rows=48 loops=1)
  Buffers: shared hit=52
```

**Diagnosis**: Even though we only need `customer_id` and `total_amount`, every index hit requires a heap fetch (52 buffer accesses for 48 rows).

**Fix:**
```sql
CREATE INDEX idx_orders_cust_covering
    ON orders (customer_id) INCLUDE (total_amount);
```

**After fix:**
```
Index Only Scan using idx_orders_cust_covering on orders
  (cost=0.43..5.50 rows=50 width=16)
  (actual time=0.025..0.089 rows=48 loops=1)
  Heap Fetches: 0
  Buffers: shared hit=3
```

**Improvement**: 52 buffer hits → 3, no heap fetches. The index contains all needed data.

---

## Example 5: Partitioning for Time-Series Data

**Problem**: Queries on a 500M-row events table always scan the whole table even when filtering by date.

```sql
EXPLAIN (ANALYZE)
SELECT count(*) FROM events
WHERE created_at BETWEEN '2025-06-01' AND '2025-06-30';
```

**Before partitioning:**
```
Aggregate  (cost=9500000.00..9500000.01 rows=1 width=8)
  →  Seq Scan on events  (actual time=0.012..45000.000 rows=15000000 loops=1)
       Filter: (created_at >= ... AND created_at < ...)
       Rows Removed by Filter: 485000000
```

**Fix**: Convert to monthly range partitions.

```sql
-- Create partitioned table
CREATE TABLE events_new (LIKE events INCLUDING ALL)
    PARTITION BY RANGE (created_at);

-- Create partitions
CREATE TABLE events_2025_06 PARTITION OF events_new
    FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
-- ... other months ...

-- Migrate data (use pg_partman for automation)
```

**After partitioning:**
```
Aggregate  (cost=350000.00..350000.01 rows=1 width=8)
  →  Seq Scan on events_2025_06 events
       (actual time=0.012..1200.000 rows=15000000 loops=1)
       Filter: (created_at >= ... AND created_at < ...)
```

**Improvement**: Only scans the relevant partition. 45s → 1.2s.

---

## Example 6: BRIN Index on Naturally Ordered Data

**Problem**: B-tree index on a timestamp column uses too much disk space on a huge table.

```sql
-- Current B-tree index: 12 GB
SELECT pg_size_pretty(pg_relation_size('idx_logs_created_at'));
-- → '12 GB'
```

**Fix**: Replace with BRIN if data is inserted in chronological order.

```sql
-- Check correlation first
SELECT correlation FROM pg_stats
WHERE tablename = 'logs' AND attname = 'created_at';
-- → 0.998 (nearly perfect physical ordering)

-- Replace with BRIN
DROP INDEX idx_logs_created_at;
CREATE INDEX idx_logs_created_at_brin ON logs USING BRIN (created_at)
    WITH (pages_per_range = 32);
```

**Result**: Index size drops from 12 GB to ~500 KB. Query performance is similar for range queries because physical order matches logical order.

---

## Example 7: Fixing a Correlated Subquery

**Problem**: SubPlan executing per-row.

```sql
EXPLAIN (ANALYZE)
SELECT o.id, o.total,
    (SELECT name FROM customers c WHERE c.id = o.customer_id) AS customer_name
FROM orders o
WHERE o.status = 'pending';
```

**Bad plan:**
```
Seq Scan on orders o  (actual time=0.020..5600.000 rows=50000 loops=1)
  Filter: (status = 'pending')
  SubPlan 1
    →  Index Scan on customers c  (actual time=0.010..0.012 rows=1 loops=50000)
```

**Diagnosis**: SubPlan executes 50,000 times (once per row). Total: 50000 × 0.012ms = 600ms just for subplan.

**Fix**: Rewrite as JOIN.

```sql
SELECT o.id, o.total, c.name AS customer_name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'pending';
```

**After fix:**
```
Hash Join  (actual time=15.000..180.000 rows=50000 loops=1)
  →  Seq Scan on customers c  (actual time=0.010..8.000 rows=100000 loops=1)
  →  Index Scan on idx_orders_status on orders o
       (actual time=0.030..45.000 rows=50000 loops=1)
```

**Improvement**: 5600ms → 180ms. Hash join builds customer hash table once instead of 50,000 individual lookups.

---

## Example 8: Replace an Application N+1 Loop with One Query

**Problem**: A request performs one lookup per identifier.

```typescript
const rows = [];
for (const id of ids) {
  rows.push((await pool.query(
    "SELECT * FROM resources WHERE id = $1",
    [id],
  )).rows[0]);
}
```

Even if every lookup uses an index, `N` statements pay `N` parse/execute cycles and usually `N` network waits.

**Fix**: Send the identifiers as one bounded array.

```typescript
const result = await pool.query(
  "SELECT * FROM resources WHERE id = ANY($1::text[])",
  [ids],
);
const byId = new Map(result.rows.map((row) => [row.id, row]));
const rows = ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
```

Preserve caller order in application code or with an ordinal input relation when order matters:

```sql
SELECT resource.*
FROM unnest($1::text[]) WITH ORDINALITY AS input(id, position)
JOIN resources AS resource ON resource.id = input.id
ORDER BY input.position;
```

---

## Example 9: Bulk Update Different Values with Conflict Detection

**Problem**: A transaction creates one `UPDATE` per row.

```typescript
for (const update of updates) {
  await client.query(
    "UPDATE user_agents SET runtime_plan = $1 WHERE id = $2 AND revision = $3",
    [update.runtimePlan, update.id, update.revision],
  );
}
```

**Fix**: Use one structured input relation and return every updated identity.

```sql
WITH input AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS value(
    id text,
    revision bigint,
    runtime_plan jsonb
  )
), updated AS (
  UPDATE user_agents AS target
  SET runtime_plan = input.runtime_plan
  FROM input
  WHERE target.id = input.id
    AND target.revision = input.revision
  RETURNING target.id
)
SELECT
  (SELECT count(*) FROM input) AS requested,
  (SELECT count(*) FROM updated) AS updated;
```

Reject or retry the complete operation when `requested <> updated`. Without this comparison, a version mismatch silently becomes a partial update.

---

## Example 10: Use the Repository Batch Deep Module

**Problem**: A caller reimplements transaction, pipeline, response draining, and client release behavior.

```typescript
const client = await db.$client.connect();
try {
  await client.query("BEGIN");
  await Promise.all(statements.map((statement) => client.query(statement)));
  await client.query("COMMIT");
} finally {
  client.release();
}
```

This duplicates behavior already owned by `api/src/db/batch.ts` and is easy to get wrong on failure or when pipeline is unavailable.

**Fix for atomic statements**:

```typescript
import { executeAtomicBatch } from "../../db/batch";

const [created, updated] = await executeAtomicBatch(db, [
  db.insert(orders).values(order).returning(),
  db.update(accounts).set(accountUpdate).where(accountGuard).returning(),
]);
```

**Fix for independent statements that need no shared transaction**:

```typescript
import { executeIndependentBatch } from "../../db/batch";

const [usersResult, ordersResult] = await executeIndependentBatch(db, [
  db.select().from(users).where(inArray(users.id, userIds)),
  db.select().from(orders).where(inArray(orders.id, orderIds)),
]);
```

The module preserves statement/result order, pipelines when available, falls back to sequential execution otherwise, drains results, and releases the checked-out client. Prefer Examples 8 and 9 whenever the work can be represented as one set-based statement.
