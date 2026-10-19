import { describe, expect, it } from "vitest";
import { resourceCollectionGap, unfinalizedResourceCount } from "./resource-collection";

describe("resource collection gaps", () => {
  const collections = { collected: 3, pending: 0, failed: 1, uncollected: 1, unsubmitted: 2, finalized: 1 };

  it("counts collected snapshots that are not finalized", () => {
    expect(unfinalizedResourceCount(collections)).toBe(2);
    expect(unfinalizedResourceCount({ collected: 1, finalized: 1 })).toBe(0);
  });

  it("treats failed, uncollected and unfinalized resources as recoverable, but not unsubmitted Agents", () => {
    expect(resourceCollectionGap(collections)).toBe(4);
    expect(resourceCollectionGap({ collected: 0, pending: 0, failed: 0, uncollected: 0, unsubmitted: 2, finalized: 0 })).toBe(0);
  });
});
