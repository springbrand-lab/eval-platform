/** Keeps multi-row writes and IN predicates far below PostgreSQL's 65,535 bind-parameter limit. */
const SQL_BATCH_SIZE = 1_000;

export function* sqlBatches<T>(items: readonly T[]): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += SQL_BATCH_SIZE) {
    yield items.slice(offset, offset + SQL_BATCH_SIZE);
  }
}

/** Selects distinct IDs in bounded batches; returns one row or null per requested ID, in request order. */
export async function selectByIds<T>(
  ids: readonly string[],
  select: (batch: string[]) => Promise<readonly T[]>,
  idOf: (row: T) => string,
): Promise<(T | null)[]> {
  const byId = new Map<string, T>();
  for (const batch of sqlBatches([...new Set(ids)])) {
    for (const row of await select(batch)) byId.set(idOf(row), row);
  }
  return ids.map((id) => byId.get(id) ?? null);
}

/** Appends one batched row to its group. */
export function addToGroup<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}
