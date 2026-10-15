import { describe, expect, it } from "vitest";
import {
  AGENT_STATUSES,
  PENDING_SAMPLING_STATUSES,
  SAMPLING_STATUSES,
  TERMINAL_AGENT_STATUSES,
  isPendingSamplingStatus,
  isTerminalAgentStatus,
} from "./index.js";

describe("@eval-platform/eval-contracts", () => {
  it("classifies every Sampling status against the single pending set", () => {
    expect(SAMPLING_STATUSES.filter(isPendingSamplingStatus)).toEqual(PENDING_SAMPLING_STATUSES);
  });

  it("classifies every Agent status against the single terminal set", () => {
    expect(AGENT_STATUSES.filter(isTerminalAgentStatus)).toEqual(TERMINAL_AGENT_STATUSES);
  });
});
