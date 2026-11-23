import { describe, expect, it } from "vitest";
import { AGENT, OWNER, SCHEMA, setupManagement, toolValue } from "./test-fixture.js";

describe("bounded management choices and current SP discovery", () => {
  it("paginates fixed-account choices and exposes only a credit balance", async () => {
    const app = setupManagement();
    expect(await toolValue(await app.call("list_options", { category: "agents", q: "agent" }))).toMatchObject({
      items: [{ id: AGENT, name: "Agent", purpose: "execution" }], total: 1,
    });
    expect(app.services.agentConfigs.listAgents).toHaveBeenCalledWith("subject");
    const schemas = await toolValue(await app.call("list_options", { category: "output_schemas" }));
    expect(schemas).toMatchObject({ items: [{ id: SCHEMA, name: "Output" }] });
    expect(JSON.stringify(schemas)).not.toContain("private");
    expect(await toolValue(await app.call("list_options", { category: "credits" }))).toMatchObject({
      balance: { availableUnits: 5, topupRemainingUnits: 1, otherRemainingUnits: 4 },
    });
    expect(app.sp.getCreditBalance).toHaveBeenCalledWith("fixed-session");
    expect(await toolValue(await app.call("list_options", { category: "input_limits" })))
      .toMatchObject({ limits: { runTargetIds: expect.any(Number) } });
    expect(app.release).toHaveBeenCalledTimes(4);
  });

  it("searches whole Suppliers and standalone Actions without returning provider metadata", async () => {
    const app = setupManagement();
    expect(await toolValue(await app.call("search_agent_resources", { kind: "suppliers" }))).toMatchObject({
      items: [{ id: "supplier-1", name: "Supplier", description: "APIs" }], total: 1,
    });
    const actions = await toolValue(await app.call("search_agent_resources", { kind: "actions", pageSize: 2 }));
    expect(actions).toEqual({ kind: "actions", page: 1, pageSize: 2, total: 1,
      items: [{ id: "action-1", name: "Action", description: "" }] });
    const detail = await toolValue(await app.call("search_agent_resources", { kind: "actions", id: "action-1" }));
    expect(detail).toMatchObject({ item: { id: "action-1", selectable: true, supplierId: null } });
    expect(app.sp.requestAgentLibrary.mock.calls.map(([token, request]) => ({ token, path: request.route.path, search: request.search }))).toEqual([
      { token: "fixed-session", path: "/api-suppliers", search: "" },
      { token: "fixed-session", path: "/actions", search: "?page=1" },
      { token: "fixed-session", path: "/actions/{id}", search: "" },
    ]);
  });

  it("re-pages the fixed-size public catalog across an MCP page boundary", async () => {
    const app = setupManagement();
    const all = Array.from({ length: 45 }, (_, index) => ({ id: `action.${index + 1}`, name: `Action ${index + 1}` }));
    app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
      expect(request.route.path).toBe("/actions");
      const query = new URLSearchParams(request.search);
      expect(query.has("pageSize")).toBe(false);
      expect(query.get("q")).toBe("Search + notes");
      const page = Number(query.get("page"));
      return { items: all.slice((page - 1) * 20, page * 20), page, pageSize: 20, total: all.length };
    });
    const value = await toolValue(await app.call("search_agent_resources", {
      kind: "actions", q: "Search + notes", page: 2, pageSize: 25,
    }));
    expect(value).toMatchObject({ page: 2, pageSize: 25, total: 45 });
    expect((value.items as { id: string }[]).map((item) => item.id)).toEqual(all.slice(25).map((item) => item.id));
    expect(app.sp.requestAgentLibrary).toHaveBeenCalledTimes(3);
  });

  it("rejects a changed or obsolete catalog response instead of presenting partial success", async () => {
    for (const obsolete of [false, true]) {
      const app = setupManagement();
      app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
        const page = Number(new URLSearchParams(request.search).get("page"));
        if (obsolete) return { data: [], total: 0, page, pageSize: 50 };
        return { items: Array.from({ length: 20 }, (_, index) => ({ id: `action.${page}.${index}`, name: "Action" })),
          page, pageSize: 20, total: page === 1 ? 45 : 44 };
      });
      expect(await (await app.call("search_agent_resources", { kind: "actions", pageSize: 25 })).json())
        .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
    }
  });

  it("keeps Toolkit cursor paging and omits account connection credentials", async () => {
    const app = setupManagement();
    app.sp.requestAgentLibrary.mockResolvedValue({ items: [
      { toolkitId: "tool-1", name: "Toolkit 1", status: "connected", description: "Public",
        connections: [{ id: "private-connection", displayName: "Private person", secret: "token" }] },
      { toolkitId: "tool-2", name: "Toolkit 2", status: "not_connected" },
    ], nextCursor: null });
    const first = await toolValue(await app.call("search_agent_resources", { kind: "toolkits", pageSize: 1 }));
    expect(first).toMatchObject({ items: [{ id: "tool-1" }], nextCursor: expect.any(String) });
    expect(JSON.stringify(first)).not.toMatch(/private-connection|Private person|token/u);
    expect(await toolValue(await app.call("search_agent_resources", {
      kind: "toolkits", cursor: first.nextCursor, pageSize: 1,
    }))).toMatchObject({ items: [{ id: "tool-2" }], nextCursor: null });
  });

  it("omits Reference URLs and rejects retired group filters and forged cursors", async () => {
    const app = setupManagement();
    const original = app.sp.requestAgentLibrary.getMockImplementation()!;
    app.sp.requestAgentLibrary.mockImplementation(async (token, request) => request.route.path === "/user-references/{id}"
      ? { id: request.id, name: "Reference", status: "active", size: 20,
        mediaType: "text/plain", attachmentCdnUrl: "https://private.test/token" }
      : original(token, request));
    const detail = await toolValue(await app.call("search_agent_resources", {
      kind: "references", id: "55555555-5555-4555-8555-555555555555",
    }));
    expect(JSON.stringify(detail)).not.toContain("private.test");
    for (const input of [{ kind: "action_groups" }, { kind: "actions", supplierId: "supplier-1" },
      { kind: "models", cursor: "connection" }, { kind: "toolkits", cursor: "not-a-cursor" }]) {
      expect(await (await app.call("search_agent_resources", input)).json()).toMatchObject({ result: { isError: true } });
    }
    expect(app.ownerServices.mock.calls.every(([user]) => user.id === OWNER)).toBe(true);
  });

  it("does not alias a selected historical Action ID", async () => {
    const app = setupManagement();
    app.sp.requestAgentLibrary.mockResolvedValueOnce({
      id: "action.other", name: "Other", description: "", status: "active", selectable: true, supplier: null,
    });
    expect(await (await app.call("search_agent_resources", { kind: "actions", id: "action.local.search" })).json())
      .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
  });
});
