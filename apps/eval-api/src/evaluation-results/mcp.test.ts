import { describe, expect, it, vi } from "vitest";
import type { ApiRuntime } from "../lib/types.js";
import { WEB_ORIGIN, requestApp } from "../test-support.js";
import { EVALUATION_RESULTS_MCP_PATH } from "./mcp.js";
import { evaluationSubmitToken } from "./submission.js";

const TOKEN = "m".repeat(40);
const EVALUATION_ID = "evaluation-1";
const schema = { type: "object", required: ["score"], properties: { score: { type: "number" } }, additionalProperties: false };

function setup(target: Awaited<ReturnType<NonNullable<ApiRuntime["evaluationResults"]>["submissions"]["target"]>> = {
  ownerUserId: "owner-1", status: "running", schema,
}, configured = true) {
  const submissions = {
    target: vi.fn(async () => target),
    save: vi.fn(async (..._args: readonly unknown[]) => "accepted" as "accepted" | "replayed" | "closed" | "conflict"),
  };
  const runtime = {
    webOrigin: WEB_ORIGIN,
    ...(configured ? { evaluationResults: { token: TOKEN, submissions } } : {}),
  } as unknown as ApiRuntime;
  const request = requestApp(runtime);
  const rpc = async (body: unknown, token = TOKEN) => request(EVALUATION_RESULTS_MCP_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const call = (args: unknown) => rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "submit_evaluation", arguments: args } });
  return { request, rpc, call, submissions };
}

const valid = { evaluationId: EVALUATION_ID, submitToken: evaluationSubmitToken(TOKEN, EVALUATION_ID), result: { score: 8 } };

describe("evaluation result MCP Server", () => {
  it("speaks stateless Streamable HTTP and lists one stable tool", async () => {
    const app = setup();
    const init = await app.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sp", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(await init.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect((await app.rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await app.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ name: string; description: string; inputSchema: { required: string[] } }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["submit_evaluation"]);
    expect(list.result.tools[0]!.description).toContain("Call this MCP tool directly");
    expect(list.result.tools[0]!.description).toContain("do not invoke it through codemode or the execution tool");
    expect(list.result.tools[0]!.inputSchema.required).toEqual(["evaluationId", "submitToken", "result"]);
    expect(await (await app.rpc({ jsonrpc: "2.0", id: 3, method: "ping" })).json())
      .toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await (await app.rpc({ jsonrpc: "2.0", id: 4, method: "nope" })).json())
      .toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found: nope" } });
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(EVALUATION_RESULTS_MCP_PATH, {
        method, headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }
  });

  it("negotiates all four supported protocol versions and defaults unknown or missing versions", async () => {
    const app = setup();
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const initialized = await app.rpc({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: version } });
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toEqual({ jsonrpc: "2.0", id: 5, result: {
        protocolVersion: version, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "eval-platform-evaluation-results", version: "1.0.0" },
      } });
    }
    for (const params of [{ protocolVersion: "unsupported" }, {}]) {
      const initialized = await app.rpc({ jsonrpc: "2.0", id: 5, method: "initialize", params });
      expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    }
  });

  it("rejects a wrong Bearer token and is absent when not configured", async () => {
    const app = setup();
    expect((await app.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "x".repeat(40))).status).toBe(401);
    expect(app.submissions.target).not.toHaveBeenCalled();
    expect((await setup(undefined, false).rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("rejects malformed JSON and envelopes before dispatch", async () => {
    const app = setup();
    const malformed = await app.request(EVALUATION_RESULTS_MCP_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: '{"jsonrpc":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    for (const body of [[], { jsonrpc: "1.0", id: 7, method: "tools/call", params: { name: "submit_evaluation", arguments: valid } }]) {
      const invalid = await app.rpc(body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }
    expect(app.submissions.target).not.toHaveBeenCalled();
    expect(app.submissions.save).not.toHaveBeenCalled();
  });

  it("never executes a notification or exposes the management tool catalog", async () => {
    const app = setup();
    for (const id of [undefined, null]) {
      const notice = await app.rpc({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }),
        method: "tools/call", params: { name: "submit_evaluation", arguments: valid } });
      expect(notice.status).toBe(202);
      expect(await notice.text()).toBe("");
    }
    const forbidden = await app.rpc({ jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "create_project", arguments: {} } });
    expect(forbidden.status).toBe(200);
    expect(await forbidden.json()).toEqual({ jsonrpc: "2.0", id: 8,
      error: { code: -32602, message: "Unknown tool: create_project" } });
    expect(app.submissions.target).not.toHaveBeenCalled();
    expect(app.submissions.save).not.toHaveBeenCalled();
  });

  it("saves a valid result for a running Evaluation", async () => {
    const app = setup();
    const body = await (await app.call(valid)).json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]!.text).toContain("accepted");
    expect(app.submissions.save).toHaveBeenCalledWith(expect.objectContaining({ evaluationId: EVALUATION_ID, ownerUserId: "owner-1", content: '{"score":8}' }));
  });

  it("retries a transient submission failure", async () => {
    const app = setup();
    app.submissions.save.mockRejectedValueOnce(new Error("temporary database failure"));
    const body = await (await app.call(valid)).json() as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]!.text).toContain("accepted");
    expect(app.submissions.save).toHaveBeenCalledTimes(2);
    expect(app.submissions.save.mock.calls[1]![0]).toBe(app.submissions.save.mock.calls[0]![0]);
  });

  it("accepts a result passed as JSON text", async () => {
    const app = setup();
    await app.call({ ...valid, result: '{"score": 9}' });
    expect(app.submissions.save).toHaveBeenCalledWith(expect.objectContaining({ content: '{"score":9}' }));
  });

  it.each([
    ["a submit token for another Evaluation", { ...valid, submitToken: evaluationSubmitToken(TOKEN, "evaluation-2") }, "do not match"],
    ["a result that breaks the Schema", { ...valid, result: { score: "high", extra: 1 } }, "/score: must be number"],
    ["missing arguments", { evaluationId: EVALUATION_ID }, "must be the strings"],
  ])("returns a tool error and saves nothing for %s", async (_name, args, message) => {
    const app = setup();
    const body = await (await app.call(args)).json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain(message);
    expect(app.submissions.save).not.toHaveBeenCalled();
  });

  it("accepts a late valid result after an observation failure", async () => {
    const app = setup({ ownerUserId: "owner-1", status: "failed", schema });
    expect(await (await app.call(valid)).json()).toMatchObject({ result: { content: [{ text: expect.stringContaining("accepted") }] } });
    expect(app.submissions.save).toHaveBeenCalledTimes(1);
  });

  it.each(["closed", "conflict"] as const)("reports atomic %s without claiming acceptance", async (receipt) => {
    const app = setup();
    app.submissions.save.mockResolvedValue(receipt);
    expect(await (await app.call(valid)).json()).toMatchObject({ result: { isError: true } });
  });

  it("acknowledges an identical accepted replay and rejects an unknown Evaluation", async () => {
    const app = setup({ ownerUserId: "owner-1", status: "succeeded", schema });
    app.submissions.save.mockResolvedValue("replayed");
    expect(await (await app.call(valid)).json()).toMatchObject({ result: { content: [{ text: expect.stringContaining("accepted") }] } });
    const missing = setup(null);
    expect(await (await missing.call(valid)).json()).toMatchObject({ result: { isError: true } });
    expect(missing.submissions.save).not.toHaveBeenCalled();
  });
});
