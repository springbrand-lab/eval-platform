import { describe, expect, it } from "vitest";
import { agentSlug } from "./agent.js";
import { AGENT, OWNER, setupManagement, toolValue } from "./test-fixture.js";

const referenceId = "55555555-5555-4555-8555-555555555555";
const input = {
  operationKey: "approval-1", name: "Evaluation Agent", description: "Grades cases",
  purpose: "evaluation", instructions: "\n  Evaluate the results.  \n", modelId: "model-1",
  skillIds: ["skill-1"], referenceFileIds: [referenceId], actionIds: ["action-1"],
};

describe("management Agent creation", () => {
  it("uses a stable owner-scoped slug, current template/model and selected active resources", async () => {
    const app = setupManagement();
    const value = await toolValue(await app.call("create_agent", input));
    expect(value).toEqual({ agentId: AGENT, name: "Evaluation Agent", purpose: "evaluation" });
    expect(app.services.agentConfigs.create).toHaveBeenCalledExactlyOnceWith({
      slug: agentSlug(OWNER, input.operationKey),
      name: input.name, description: input.description, purpose: "evaluation",
      setting: expect.objectContaining({
        presetId: "model-1", model: "provider/model", thinking: "medium", systemPrompt: input.instructions,
        skillIds: ["skill-1"], referenceFileIds: [referenceId], actionIds: ["action-1"],
        mcpServers: [], connectorIds: [], extensionIds: [],
      }),
    }, { verifyReplay: true });
    expect(agentSlug(OWNER, input.operationKey)).toBe(agentSlug(OWNER, input.operationKey));
    expect(agentSlug(OWNER, "other-key")).not.toBe(agentSlug(OWNER, input.operationKey));
    expect(agentSlug("other-owner", input.operationKey)).not.toBe(agentSlug(OWNER, input.operationKey));
    expect(app.sp.requestAgentLibrary.mock.calls.every(([token]) => token === "fixed-session")).toBe(true);
    expect(app.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a removed or unavailable Model, Skill, Reference or Action before an SP write", async () => {
    for (const resource of ["model", "skill", "reference", "action"] as const) {
      const app = setupManagement();
      const original = app.sp.requestAgentLibrary.getMockImplementation()!;
      app.sp.requestAgentLibrary.mockImplementation(async (token, request) => {
        if (resource === "model" && request.route.path === "/models") return [];
        if (resource === "skill" && request.route.path === "/skills") {
          return { data: [{ id: "skill-1", available: false, deleted: true }], total: 1 };
        }
        if (resource === "reference" && request.route.path === "/user-references/{id}") {
          return { id: referenceId, status: "disabled" };
        }
        if (resource === "action" && request.route.path === "/actions/{id}") {
          return { id: "action-1", status: "deprecated", selectable: false };
        }
        return original(token, request);
      });
      const result = await (await app.call("create_agent", input)).json();
      expect(result).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
      expect(app.services.agentConfigs.create).not.toHaveBeenCalled();
      expect(app.release).toHaveBeenCalledTimes(1);
    }
  });

  it("selects only connected Toolkits and active Components named by the user", async () => {
    const app = setupManagement();
    const original = app.sp.requestAgentLibrary.getMockImplementation()!;
    app.sp.requestAgentLibrary.mockImplementation(async (token, request) => {
      if (request.route.path === "/connectors") return {
        items: [{ toolkitId: "toolkit-1", status: "connected" }], nextCursor: null,
      };
      if (request.route.path === "/components") return {
        data: [{ id: request.search.includes("kind=extension") ? "extension-1" : "component-1",
          status: "active", selectable: true }], total: 1,
      };
      return original(token, request);
    });
    const selected = { ...input, connectorToolkitIds: ["toolkit-1"],
      connectorIds: ["component-1"], extensionIds: ["extension-1"] };
    await toolValue(await app.call("create_agent", selected));
    expect(app.services.agentConfigs.create).toHaveBeenCalledWith(expect.objectContaining({
      setting: expect.objectContaining({
        mcpServers: [{ kind: "connector_toolkit", serverId: "toolkit-1" }],
        connectorIds: ["component-1"], extensionIds: ["extension-1"],
      }),
    }), { verifyReplay: true });
  });

  it("fails closed when a selected Toolkit or Component is unavailable", async () => {
    for (const unavailablePath of ["/connectors", "/components"] as const) {
      const app = setupManagement();
      const original = app.sp.requestAgentLibrary.getMockImplementation()!;
      app.sp.requestAgentLibrary.mockImplementation(async (token, request) => {
        if (request.route.path === "/connectors") return {
          items: [{ toolkitId: "toolkit-1", status: unavailablePath === "/connectors" ? "not_connected" : "connected" }],
          nextCursor: null,
        };
        if (request.route.path === "/components") return {
          data: [{ id: "component-1", status: "active",
            selectable: unavailablePath !== "/components" }], total: 1,
        };
        return original(token, request);
      });
      const response = await (await app.call("create_agent", { ...input,
        connectorToolkitIds: ["toolkit-1"], connectorIds: ["component-1"] })).json();
      expect(response).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
      expect(app.services.agentConfigs.create).not.toHaveBeenCalled();
    }
  });

  it("never accepts arbitrary configuration or reports an unknown creation as a success", async () => {
    const app = setupManagement();
    for (const extra of [{ mcpServers: [{ serverId: "admin" }] }, { ownerUserId: "another-account" },
      { setting: { connectorIds: ["private"] } }, { url: "https://untrusted.test" }]) {
      const result = await (await app.call("create_agent", { ...input, ...extra })).json();
      expect(result).toMatchObject({ result: { isError: true } });
    }
    expect(app.services.agentConfigs.create).not.toHaveBeenCalled();
    app.services.agentConfigs.create.mockRejectedValueOnce(new Error("SP POST result unknown: secret-token"));
    const unknown = await (await app.call("create_agent", input)).json();
    expect(unknown).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(unknown)).not.toContain("secret-token");
  });
});
