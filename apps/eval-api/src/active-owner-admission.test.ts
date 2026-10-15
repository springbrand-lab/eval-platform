import { describe, expect, it, vi } from "vitest";
import { createActiveOwnerAdmission } from "./active-owner-admission.js";

describe("active owner admission", () => {
  it("shares one admission while requests overlap and evicts it after the last release", () => {
    const factory = vi.fn((owner: string) => ({ owner }));
    const pool = createActiveOwnerAdmission(factory);
    const first = pool.acquire("alice");
    const second = pool.acquire("alice");
    const other = pool.acquire("bob");
    expect(first.admission).toBe(second.admission);
    expect(other.admission).not.toBe(first.admission);
    expect(factory).toHaveBeenCalledTimes(2);
    first.release();
    first.release();
    const concurrent = pool.acquire("alice");
    expect(concurrent.admission).toBe(second.admission);
    second.release();
    concurrent.release();
    const later = pool.acquire("alice");
    expect(later.admission).not.toBe(first.admission);
    expect(factory).toHaveBeenCalledTimes(3);
    later.release();
    other.release();
  });
});
