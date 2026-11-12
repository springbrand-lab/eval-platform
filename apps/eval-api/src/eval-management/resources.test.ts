import { describe, expect, it } from "vitest";
import { AGENT, OWNER, SCHEMA, setupManagement, toolValue } from "./test-fixture.js";

describe("bounded management choices and SP discovery", () => {
  it("paginates fixed-account choices, omits Schema bodies and exposes only a credit balance", async () => {
    const app = setupManagement();
    expect(await toolValue(await app.call("list_options", { category: "agents", q: "agent" }))).toMatchObject({
      items: [{ id: AGENT, name: "Agent", purpose: "execution" }], total: 1,
    });
    expect(app.services.agentConfigs.listAgents).toHaveBeenCalledWith("subject");
    const schemas = await toolValue(await app.call("list_options", { category: "output_schemas" }));
    expect(schemas).toMatchObject({ items: [{ id: SCHEMA, name: "Output" }] });
    expect(JSON.stringify(schemas)).not.toContain("private");
    const credits = await toolValue(await app.call("list_options", { category: "credits" }));
    expect(credits).toMatchObject({ balance: { availableUnits: 5, topupRemainingUnits: 1, otherRemainingUnits: 4 } });
    expect(app.sp.getCreditBalance).toHaveBeenCalledWith("fixed-session");
    expect(JSON.stringify(credits)).not.toContain("unused");
    expect(await toolValue(await app.call("list_options", { category: "input_limits" })))
      .toMatchObject({ limits: { runTargetIds: expect.any(Number) } });
    expect(app.release).toHaveBeenCalledTimes(4);
  });

  it("searches only allowlisted public SP routes, with bounded metadata and no connection credentials", async () => {
    const app = setupManagement();
    const original = app.sp.requestAgentLibrary.getMockImplementation()!;
    app.sp.requestAgentLibrary.mockImplementation(async (token, request) => {
      if (request.route.path === "/connectors") return { items: [
        { toolkitId: "tool-1", name: "Toolkit 1", status: "connected", description: "Public",
          connections: [{ id: "private-connection", displayName: "Private person", secret: "token" }] },
        { toolkitId: "tool-2", name: "Toolkit 2", status: "not_connected" },
        { toolkitId: "tool-3", name: "Toolkit 3", status: "connected" },
      ], nextCursor: null };
      if (request.route.path === "/actions") return { data: [{ supplier: { id: "supplier-1", name: "Supplier",
        iconUrl: "https://private.test" }, actionCount: 3 }], total: 1 };
      if (request.route.path === "/actions/group-actions") return { data: [
        { id: "action-1", name: "Action", status: "active", selectable: true,
          description: "Search", supplier: { id: "supplier-1", name: "Supplier", iconUrl: "https://private.test" } },
      ], total: 1 };
      if (request.route.path === "/components") return { data: [{
        id: "component-1", name: "Component", status: "active", selectable: true,
      }], total: 1 };
      return original(token, request);
    });

    const groups = await toolValue(await app.call("search_agent_resources", { kind: "action_groups" }));
    expect(groups).toMatchObject({ items: [{ id: "supplier-1", name: "Supplier", actionCount: 3 }] });
    const actions = await toolValue(await app.call("search_agent_resources", {
      kind: "actions", supplierId: "supplier-1", pageSize: 2,
    }));
    expect(actions).toMatchObject({ items: [{ id: "action-1", supplierId: "supplier-1" }] });
    const call = app.sp.requestAgentLibrary.mock.calls.find(([, input]) => input.route.path === "/actions/group-actions")!;
    expect(call[1].search).toContain("supplierId=supplier-1");
    const components = await toolValue(await app.call("search_agent_resources", { kind: "extensions" }));
    expect(components).toMatchObject({ items: [{ id: "component-1" }] });
    expect(app.sp.requestAgentLibrary.mock.calls.find(([, input]) => input.route.path === "/components")![1].search)
      .toContain("kind=extension");

    const first = await toolValue(await app.call("search_agent_resources", { kind: "toolkits", pageSize: 1 }));
    expect(first).toMatchObject({ items: [{ id: "tool-1" }], nextCursor: expect.any(String) });
    expect(JSON.stringify(first)).not.toMatch(/private-connection|Private person|token/u);
    const second = await toolValue(await app.call("search_agent_resources", {
      kind: "toolkits", cursor: first.nextCursor, pageSize: 1,
    }));
    expect(second).toMatchObject({ items: [{ id: "tool-2" }], nextCursor: expect.any(String) });
    const third = await toolValue(await app.call("search_agent_resources", {
      kind: "toolkits", cursor: second.nextCursor, pageSize: 1,
    }));
    expect(third).toMatchObject({ items: [{ id: "tool-3" }], nextCursor: null });
  });

  it("omits Reference URLs and rejects ambiguous Action searches or forged Toolkit cursors", async () => {
    const app = setupManagement();
    const original = app.sp.requestAgentLibrary.getMockImplementation()!;
    app.sp.requestAgentLibrary.mockImplementation(async (token, request) => request.route.path === "/user-references/{id}"
      ? { id: request.id, name: "Reference", status: "active", size: 20,
        mediaType: "text/plain", attachmentCdnUrl: "https://private.test/token" }
      : original(token, request));
    const detail = await toolValue(await app.call("search_agent_resources", {
      kind: "references", id: "55555555-5555-4555-8555-555555555555",
    }));
    expect(detail).toMatchObject({ item: { status: "active", size: 20 } });
    expect(JSON.stringify(detail)).not.toContain("private.test");
    for (const input of [{ kind: "actions" }, { kind: "actions", supplierId: "supplier-1", unassigned: true },
      { kind: "models", cursor: "connection" }, { kind: "toolkits", cursor: "not-a-cursor" }]) {
      expect(await (await app.call("search_agent_resources", input)).json())
        .toMatchObject({ result: { isError: true } });
    }
    expect(app.ownerServices).toHaveBeenCalledTimes(5);
    expect(app.ownerServices.mock.calls.every(([user]) => user.id === OWNER)).toBe(true);
  });

  it("discovers Frank connector-slug groups and returns raw local Action IDs for selection and detail", async () => {
    const app = setupManagement();
    const supplier = { id: "exa", name: "Exa" };
    const action = { id: "action.local.exa.search", name: "Exa Search (local)", description: "Search the web",
      status: "active", selectable: true, supplier };
    app.sp.requestAgentLibrary.mockImplementation(async (_token, request) => {
      if (request.route.path === "/actions") return { data: [{ supplier, actionCount: 1 }], total: 1 };
      if (request.route.path === "/actions/group-actions") return { data: [action], total: 1 };
      if (request.route.path === "/actions/{id}") return action;
      throw new Error(`Unexpected public library path ${request.route.path}`);
    });
    expect(await toolValue(await app.call("search_agent_resources", {
      kind: "action_groups", q: "Exa (local)", pageSize: 2,
    }))).toEqual({ kind: "action_groups", page: 1, pageSize: 2, total: 1,
      items: [{ id: "exa", name: "Exa", unassigned: false, actionCount: 1 }] });
    const selected = { id: action.id, name: action.name, description: action.description,
      status: "active", selectable: true, supplierId: "exa" };
    expect(await toolValue(await app.call("search_agent_resources", {
      kind: "actions", supplierId: "exa", q: "Search (local)", pageSize: 2,
    }))).toEqual({ kind: "actions", page: 1, pageSize: 2, total: 1, items: [selected] });
    expect(await toolValue(await app.call("search_agent_resources", {
      kind: "actions", id: action.id,
    }))).toEqual({ kind: "actions", item: selected });
    expect(app.sp.requestAgentLibrary.mock.calls.map(([token, request]) => ({
      token, path: request.route.path, id: request.id, search: request.search,
    }))).toEqual([
      { token: "fixed-session", path: "/actions", id: undefined, search: "?page=1&pageSize=2&q=Exa+%28local%29" },
      { token: "fixed-session", path: "/actions/group-actions", id: undefined,
        search: "?page=1&pageSize=2&q=Search+%28local%29&supplierId=exa" },
      { token: "fixed-session", path: "/actions/{id}", id: action.id, search: "" },
    ]);
  });

  it("does not accept a different historical ID as a Frank Action detail alias", async () => {
    const app = setupManagement();
    app.sp.requestAgentLibrary.mockResolvedValueOnce({
      id: "action.exa.search", name: "Search", status: "active", selectable: true,
      supplier: { id: "exa", name: "Exa" },
    });
    const response = await (await app.call("search_agent_resources", {
      kind: "actions", id: "action.local.exa.search",
    })).json();
    expect(response).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
    expect(app.sp.requestAgentLibrary).toHaveBeenCalledExactlyOnceWith("fixed-session",
      expect.objectContaining({ route: expect.objectContaining({ path: "/actions/{id}" }),
        id: "action.local.exa.search", search: "" }));
  });
});
