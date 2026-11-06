import { describe, expect, it } from "vitest";
import { selectedMcpServerIds } from "./agent-purpose.js";

describe("Agent purpose MCP selections", () => {
  it.each([
    {}, { setting: null }, { setting: [] }, { setting: {} },
    { setting: { mcpServers: null } }, { setting: { mcpServers: "unavailable" } },
  ])("keeps an unreadable selection list empty (%#)", (config) => {
    expect(selectedMcpServerIds(config)).toEqual([]);
  });

  it("preserves managed selection order, duplicates and IDs without admitting Toolkit or unreadable bindings", () => {
    const config = { setting: { mcpServers: [
      null, false, 1, "managed", {}, { serverId: "" }, { serverId: 1 },
      { serverId: "managed.z" },
      { serverId: "calendar", kind: "connector_toolkit" },
      { serverId: "future", kind: "future_kind" },
      { serverId: "undefined-kind", kind: undefined },
      { serverId: "managed.z" }, { serverId: " " }, { serverId: "managed.a" },
    ] } };
    const before = structuredClone(config);
    expect(selectedMcpServerIds(config)).toEqual(["managed.z", "managed.z", " ", "managed.a"]);
    expect(config).toEqual(before);
  });
});
