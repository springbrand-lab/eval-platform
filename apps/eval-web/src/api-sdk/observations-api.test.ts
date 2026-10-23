import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTrajectoryPage } from "./observations-api";

const get = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ api: { get }, enc: encodeURIComponent }));
const native = { format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: "chat" }, submissionId: "submission",
  projection: { kind: "safe", policyId: "fixture", policyVersion: 1 },
  record: { type: "conversation", value: { id: 1, futureField: { preserved: true } } } };

describe("native observation page contract", () => {
  beforeEach(() => get.mockReset());
  it("keeps full native fields and validates a receiving-store cursor", async () => {
    const page = { format: "pi-trajectory/v1", events: [{ ingestSeq: 4, event: native }], beforeSeq: 4, hasOlder: true };
    get.mockResolvedValue(page);
    await expect(getTrajectoryPage("p", "samplings", "s", 10)).resolves.toEqual(page);
  });
  it.each([
    { events: [{ ingestSeq: 4, event: { format: "future/v2" } }], beforeSeq: null, hasOlder: false },
    { events: [{ ingestSeq: 4, event: { type: "turn.finished" } }], beforeSeq: null, hasOlder: false },
    { events: [{ ingestSeq: 4, event: native }], beforeSeq: 3, hasOlder: true },
    { events: [{ ingestSeq: 4, event: { ...native, ingestSeq: 5 } }], beforeSeq: null, hasOlder: false },
    { format: undefined, events: [], beforeSeq: null, hasOlder: false },
    { events: [{ ingestSeq: 4, event: { ...native, projection: undefined } }], beforeSeq: null, hasOlder: false },
    { events: [{ ingestSeq: 5, event: native }, { ingestSeq: 4, event: native }], beforeSeq: null, hasOlder: false },
    { events: [{ ingestSeq: 4, event: native }, { ingestSeq: 4, event: native }], beforeSeq: null, hasOlder: false },
  ])("rejects incompatible or contradictory live data", async (page) => {
    get.mockResolvedValue({ format: "pi-trajectory/v1", ...page });
    await expect(getTrajectoryPage("p", "evaluations", "e")).rejects.toThrow();
  });
  it("rejects a page that crosses its requested history boundary", async () => {
    get.mockResolvedValue({ format: "pi-trajectory/v1", events: [{ ingestSeq: 10, event: native }], beforeSeq: null, hasOlder: false });
    await expect(getTrajectoryPage("p", "evaluations", "e", 10)).rejects.toThrow(/order/);
  });
});
