/** Keep multi-row writes and IN predicates below PostgreSQL's bind-parameter limit. */
export function* sqlBatches<T>(items: readonly T[]): Generator<T[]> {
  const batchSize = 1_000;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    yield items.slice(offset, offset + batchSize);
  }
}
