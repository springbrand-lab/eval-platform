import { describe, expect, it } from "vitest";
import { EVAL_MANAGEMENT_MCP_PATH } from "./mcp.js";
import { MANAGEMENT_TOKEN, RESULT_TOKEN, WEB_TOKEN, run, setupManagement } from "./test-fixture.js";

const rpc = (method: string, id: number | undefined = 1, params: unknown = {}) => ({
  jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params,
});

describe("trusted management MCP transport", () => {
  it("is absent without its secret; disabled and unauthorized calls never lease an owner", async () => {
    const disabled = setupManagement(false);
    expect((await disabled.rpc(rpc("tools/list"))).status).toBe(404);
    expect((await disabled.request(EVAL_MANAGEMENT_MCP_PATH, { method: "GET" })).status).toBe(404);
    expect(disabled.ownerServices).not.toHaveBeenCalled();

    const app = setupManagement();
    for (const token of [RESULT_TOKEN, WEB_TOKEN, "wrong-token"]) {
      expect((await app.rpc(rpc("tools/list"), token)).status).toBe(401);
    }
    expect((await app.request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Eval-Web-Token": WEB_TOKEN },
      body: JSON.stringify(rpc("tools/list")),
    })).status).toBe(401);
    expect(app.ownerServices).not.toHaveBeenCalled();
    // The management Bearer does not authorize the Evaluator's other MCP.
    expect((await app.request("/mcp/evaluation-results", {
      method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(rpc("tools/list")),
    })).status).toBe(401);
  });

  it("allows only POST with a separate token, even for a caller with a Web token", async () => {
    const app = setupManagement();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(EVAL_MANAGEMENT_MCP_PATH, {
        method, headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    const response = await app.request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        "Content-Type": "application/json", "X-Eval-Web-Token": "invalid" },
      body: JSON.stringify(rpc("ping")),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(app.ownerServices).toHaveBeenCalledWith(app.runtime.serviceAccount.user, "fixed-session");
    expect(app.release).toHaveBeenCalledTimes(1);
  });

  it("is stateless and advertises exactly sixteen management tools including separate read-only reconciliation", async () => {
    const app = setupManagement();
    const initialized = await app.rpc(rpc("initialize", 2, { protocolVersion: "2025-06-18" }));
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } } } });
    const tools = await (await app.rpc(rpc("tools/list"))).json() as {
      result: { tools: Array<{ name: string; inputSchema: {
        type: string; required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown>;
      } }> };
    };
    expect(tools.result.tools.map(({ name }) => name)).toEqual([
      "list_options", "prepare_inputs", "get_preparation", "search_agent_resources",
      "upload_agent_skill", "upload_agent_reference", "create_output_schema", "create_agent", "create_project", "preview_run",
      "submit_run", "reconcile_operation", "stop_run", "get_run", "get_metrics", "inspect_case",
    ]);
    expect(tools.result.tools.filter(({ name }) => name !== "reconcile_operation").every(({ inputSchema }) => inputSchema.type === "object"
      && inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.result.tools.find(({ name }) => name === "create_agent")!.inputSchema.required)
      .toEqual(expect.arrayContaining(["operationKey", "purpose", "instructions", "modelId"]));
    expect(tools.result.tools.find(({ name }) => name === "create_output_schema")!.inputSchema.required)
      .toEqual(expect.arrayContaining(["operationKey", "name", "description", "content"]));
    expect(tools.result.tools.find(({ name }) => name === "create_project")!.inputSchema.required)
      .toContain("expectedSnapshots");
    const runInput = tools.result.tools.find(({ name }) => name === "submit_run")!.inputSchema;
    expect(runInput.required).toEqual(expect.arrayContaining(["projectId", "idempotencyKey", "operation", "selector", "targets", "expectedPlanDigests"]));
    expect(runInput.properties).not.toHaveProperty("replayOnly"); // removed from both call and advertised schemas
    const metricsInput = tools.result.tools.find(({ name }) => name === "get_metrics")!.inputSchema;
    expect(metricsInput.properties).toEqual(expect.objectContaining({
      section: expect.any(Object), role: expect.any(Object),
      toolPage: expect.any(Object), toolPageSize: expect.any(Object),
      evaluationId: expect.any(Object), resultOffset: expect.any(Object), numericPointer: expect.any(Object),
    }));
    const optionsInput = tools.result.tools.find(({ name }) => name === "list_options")!.inputSchema;
    expect(optionsInput.properties).toHaveProperty("schemaOffset");
    expect(optionsInput.properties?.category).toMatchObject({
      enum: expect.arrayContaining(["dataset_data", "output_schema_detail", "project_schema_detail", "approval_output_schema"]),
    });
    expect(tools.result.tools.find(({ name }) => name === "reconcile_operation")!.inputSchema)
      .toHaveProperty("oneOf");
    expect(tools.result.tools.map(({ name }) => name)).not.toContain("submit_evaluation");
    expect(app.release).toHaveBeenCalledTimes(2);
  });

  it("keeps the ordinary 1 MB MCP ingress limit despite the bounded Schema JSON-escape allowance", async () => {
    const app = setupManagement();
    const oversized = await app.rpc(rpc("ping", 1, { padding: "x".repeat(1_000_000) }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "REQUEST_PAYLOAD_TOO_LARGE" });
    expect(app.services.outputSchemas.create).not.toHaveBeenCalled();
  });

  it("negotiates the same four protocol versions and defaults unknown or missing versions", async () => {
    const app = setupManagement();
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const initialized = await app.rpc(rpc("initialize", 5, { protocolVersion: version }));
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toEqual({ jsonrpc: "2.0", id: 5, result: {
        protocolVersion: version, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "eval-platform-eval-management", version: "1.0.0" },
      } });
    }
    for (const params of [{ protocolVersion: "unsupported" }, {}]) {
      const initialized = await app.rpc(rpc("initialize", 5, params));
      expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    }
    expect(app.release).toHaveBeenCalledTimes(6);
  });

  it("never executes an ID-less notification or a result-submission tool", async () => {
    const app = setupManagement();
    const notice = await app.rpc({ jsonrpc: "2.0", method: "tools/call",
      params: { name: "create_project", arguments: {} } });
    expect(notice.status).toBe(202);
    expect(await notice.text()).toBe("");
    const other = await app.rpc({ jsonrpc: "2.0", id: null, method: "tools/call",
      params: { name: "stop_run", arguments: { projectId: "project-1", runId: "run-1" } } });
    expect(other.status).toBe(202);
    expect(app.services.projects.create).not.toHaveBeenCalled();
    expect(app.services.projectRuns.stopRun).not.toHaveBeenCalled();
    const forbidden = await (await app.call("submit_evaluation", { evaluationId: "evaluation-1" })).json();
    expect(forbidden).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });
    expect(app.release).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed JSON and fields outside strict tool schemas without any write", async () => {
    const app = setupManagement();
    const malformed = await app.rpc('{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list"}');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const wrongType = await app.request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "text/plain" },
      body: JSON.stringify(rpc("tools/list")),
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "Content-Type must be application/json" } });
    const bad = await (await app.call("create_agent", {
      operationKey: "key", name: "Agent", purpose: "evaluation", instructions: "Do work",
      modelId: "model-1", mcpServers: [{ serverId: "management-secret" }],
    })).json();
    expect(bad).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    expect(app.sp.requestAgentLibrary).not.toHaveBeenCalled();
    expect(app.services.agentConfigs.create).not.toHaveBeenCalled();
    expect(app.release).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed envelopes and unsafe IDs without executing tools", async () => {
    const app = setupManagement();
    const invalid = await app.rpc({ jsonrpc: "1.0", id: 7, method: "tools/call",
      params: { name: "create_project", arguments: {} } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "Invalid Request" } });
    for (const id of [{ invalid: true }, "x".repeat(129), Number.MAX_SAFE_INTEGER + 1]) {
      const response = await app.rpc({ jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "create_project", arguments: {} } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "Invalid Request" } });
    }
    expect(app.services.projects.create).not.toHaveBeenCalled();
    expect(app.release).toHaveBeenCalledTimes(4);
  });

  it("rejects model URLs, sandbox paths and inline file bytes instead of treating them as upload references", async () => {
    const app = setupManagement();
    for (const extra of [
      { uploadRef: "https://attacker.test/file" },
      { uploadRef: "/tmp/agent-file.zip" },
      { uploadRef: Buffer.from("private").toString("base64") },
    ]) {
      const result = await (await app.call("upload_agent_reference", { operationKey: "file", ...extra })).json();
      expect(result).toMatchObject({ result: { isError: true } });
    }
    expect(app.sp.requestAgentLibrary).not.toHaveBeenCalled();
    expect(app.managed.operations.size).toBe(0);
  });

  it("does not include SP, database or tool-argument diagnostics in a tool error and always releases", async () => {
    const app = setupManagement();
    app.sp.getCreditBalance.mockRejectedValueOnce(new Error("postgres://owner:secret@db/private"));
    const result = await (await app.call("list_options", { category: "credits" })).json();
    expect(result).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("INTERNAL_ERROR") }] } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(app.release).toHaveBeenCalledTimes(1);
    const missingMethod = await app.rpc(rpc("no-such-method"));
    expect(missingMethod.status).toBe(200);
    expect(await missingMethod.json()).toEqual({ jsonrpc: "2.0", id: 1,
      error: { code: -32601, message: "Method not found" } });
    expect(app.release).toHaveBeenCalledTimes(2);
  });

  it("bounds the serialized response even when an owned Run contains many long IDs", async () => {
    const app = setupManagement();
    const ids = Array.from({ length: 50 }, (_, index) => `s-${index}-${"x".repeat(500)}`);
    app.services.results.getRun.mockResolvedValueOnce({ ...run, samplingIds: ids, evaluationIds: ids });
    const result = await (await app.call("get_run", { runId: run.runId, pageSize: 50 })).json();
    expect(result).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("CATALOG_PAYLOAD_TOO_LARGE") }] } });
    expect(app.release).toHaveBeenCalledTimes(1);
  });
});
