import { describe, expect, it } from "vitest";
import { OUTPUT_SCHEMA_BYTES } from "../limits.js";
import { SCHEMA, WEB_TOKEN, setupManagement, toolValue } from "./test-fixture.js";

const content = JSON.stringify({ type: "object", properties: { score: { type: "number" } }, required: ["score"] });
const input = { operationKey: "schema-upload-1", name: "  Feishu score  ", description: "  New eval Schema  ", content };
const normalized = { ...input, name: "Feishu score", description: "New eval Schema" };

describe("idempotent management output Schema upload", () => {
  it("preserves ordinary Web HTTP creation of exact/case-variant duplicate names", async () => {
    const app = setupManagement();
    const create = (name: string) => app.request("/api/evaluation-output-schemas", {
      method: "POST", headers: { "X-Eval-Web-Token": WEB_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "HTTP catalog creation", content }),
    });
    const first = await create("Output");
    const second = await create("Output");
    const variant = await create("output");
    expect([first.status, second.status, variant.status]).toEqual([201, 201, 201]);
    const ids = (await Promise.all([first, second, variant].map(async (response) =>
      (await response.json() as { msg: { outputSchemaId: string } }).msg.outputSchemaId)));
    expect(new Set([SCHEMA, ...ids]).size).toBe(4);
    const variantId = ids[2]!;
    const patched = await app.request(`/api/evaluation-output-schemas/${variantId}`, {
      method: "PATCH", headers: { "X-Eval-Web-Token": WEB_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Output" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ msg: { outputSchemaId: variantId, name: "Output" } });
    expect(app.savedSchemas.get(ids[0]!)?.name).toBe("Output");
  });

  it("creates only through the owner catalog, replays the same ID, and returns no content", async () => {
    const app = setupManagement();
    const firstResponse = await app.call("create_output_schema", input);
    const first = await toolValue(firstResponse);
    expect(first).toEqual({ outputSchemaId: expect.any(String), name: normalized.name });
    expect((first.outputSchemaId as string)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(app.services.outputSchemas.create).toHaveBeenCalledExactlyOnceWith({
      name: normalized.name, description: normalized.description, content,
    }, first.outputSchemaId);
    expect(await toolValue(await app.call("create_output_schema", normalized))).toEqual(first);
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(1);
    const receipt = await toolValue(await app.call("get_preparation", { operationKey: input.operationKey }));
    expect(receipt).toEqual({ operationKey: input.operationKey, kind: "output_schema", status: "completed",
      receipt: first, stages: { output_schema: "confirmed" } });
    const operation = app.managed.operations.get(input.operationKey)!;
    expect(operation.kind).toBe("output_schema");
    expect(operation.status).toBe("completed");
    expect(operation.skillName).toBeNull();
    expect(operation.plan).toMatchObject({ version: 1, outputSchemaId: first.outputSchemaId,
      name: normalized.name, description: normalized.description, contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(JSON.stringify({ first, receipt, plan: operation.plan })).not.toContain(content);
    expect(app.sp.requestAgentLibrary).not.toHaveBeenCalled();
  });

  it("conflicts on changed same-key intent, but independent keys may create identical/case-variant names", async () => {
    const app = setupManagement();
    const original = await toolValue(await app.call("create_output_schema", input));
    for (const attempt of [
      { ...normalized, content: JSON.stringify({ type: "string" }) },
      { ...normalized, description: "Changed" },
      { ...normalized, name: "Changed" },
    ]) {
      const failure = await (await app.call("create_output_schema", attempt)).json() as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(failure.result.isError).toBe(true);
      expect(failure.result.content[0]!.text).toContain("EVAL_SP_CONFLICT");
    }
    const siblings = await Promise.all([
      { ...normalized, operationKey: "same-name-key" },
      { ...normalized, operationKey: "case-variant-key", name: "fEiShU SCORE" },
      { ...normalized, operationKey: "existing-name-key", name: "Output" },
      { ...normalized, operationKey: "existing-case-key", name: "output" },
    ].map((request) => app.call("create_output_schema", request).then(toolValue)));
    expect(siblings.map((row) => row.name)).toEqual(["Feishu score", "fEiShU SCORE", "Output", "output"]);
    const ids = [original.outputSchemaId, ...siblings.map((row) => row.outputSchemaId), SCHEMA];
    expect(new Set(ids).size).toBe(ids.length);
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(5);
    expect(app.savedSchemas.get(original.outputSchemaId as string)?.name).toBe(normalized.name);
    expect(app.savedSchemas.get(SCHEMA)?.name).toBe("Output");
  });

  it("fences only the unknown operation key, without blindly replaying its write", async () => {
    const app = setupManagement();
    app.services.outputSchemas.create.mockRejectedValueOnce(new Error("database address/password/private content leaked"));
    const unknown = await (await app.call("create_output_schema", input)).json() as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(unknown.result).toMatchObject({ isError: true,
      content: [{ text: expect.stringContaining("OPERATION_OUTCOME_UNKNOWN") }] });
    expect(JSON.stringify(unknown)).not.toContain("password");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual({ operationKey: input.operationKey, kind: "output_schema", status: "outcome_unknown",
        stages: { output_schema: "attempted" } });
    const replay = await (await app.call("create_output_schema", input)).json() as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(replay.result.content[0]!.text).toContain("OPERATION_OUTCOME_UNKNOWN");
    const changed = await (await app.call("create_output_schema", {
      ...normalized, content: JSON.stringify({ type: "string" }),
    })).json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(changed.result.content[0]!.text).toContain("EVAL_SP_CONFLICT");
    // A distinct, explicitly requested creation may reuse the name, but is not
    // recovery of the original uncertain write. Its independent receipt ID is authoritative.
    const other = await toolValue(await app.call("create_output_schema", { ...input, operationKey: "independent-key" }));
    expect(other).toEqual({ outputSchemaId: expect.any(String), name: normalized.name });
    expect(other.outputSchemaId).not.toBe(app.managed.operations.get(input.operationKey)!.plan.outputSchemaId);
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(2);
    expect(app.managed.operations.get(input.operationKey)!.stages.output_schema?.status).toBe("attempted");
    expect(app.managed.operations.size).toBe(2);
  });

  it("recovers a lost post-INSERT response by owned planned ID/body, never by a same-name guess", async () => {
    const app = setupManagement();
    // An existing different ID with the *same name* cannot serve as this operation's receipt.
    const unrelatedId = crypto.randomUUID();
    app.savedSchemas.set(unrelatedId, { outputSchemaId: unrelatedId, name: normalized.name,
      description: "Unrelated", schema: { type: "string" } });
    const original = app.services.outputSchemas.create.getMockImplementation()!;
    app.services.outputSchemas.create.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("insert committed but response was lost");
    });
    // The first request cannot prove the response while its catalog read is unavailable.
    app.services.outputSchemas.get.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("read-back lost"));
    expect((await (await app.call("create_output_schema", input)).json()) as unknown)
      .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("OPERATION_OUTCOME_UNKNOWN") }] } });
    const replay = await toolValue(await app.call("create_output_schema", input));
    expect(replay).toEqual({ outputSchemaId: expect.any(String), name: normalized.name });
    expect(replay.outputSchemaId).not.toBe(unrelatedId);
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(1);
    const row = app.savedSchemas.get(replay.outputSchemaId as string)!;
    expect(row.schema).toEqual(JSON.parse(content));
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ kind: "output_schema", status: "completed", receipt: replay });
    // A changed catalog row cannot be quietly accepted on a later replay.
    app.savedSchemas.set(row.outputSchemaId, { ...row, description: "Changed in the catalog" });
    const changed = await (await app.call("create_output_schema", input)).json() as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(changed.result.content[0]!.text).toContain("EVAL_SP_CONFLICT");
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(1);
  });

  it("enforces the existing decoded content byte limit and rejects invalid JSON before durable marks", async () => {
    const app = setupManagement();
    for (const schemaContent of ["{", JSON.stringify({ type: "object", description: "a".repeat(OUTPUT_SCHEMA_BYTES) })]) {
      const failure = await (await app.call("create_output_schema", { ...input, content: schemaContent })).json() as {
        result: { isError: boolean };
      };
      expect(failure.result.isError).toBe(true);
    }
    expect(app.managed.operations.size).toBe(0);
    expect(app.services.outputSchemas.create).not.toHaveBeenCalled();
  });

  it("accepts a valid Schema whose escaped MCP envelope exceeds the ordinary 1 MB bound", async () => {
    const app = setupManagement();
    const escaped = JSON.stringify({ type: "object", description: "\"".repeat(300_000) });
    expect(Buffer.byteLength(escaped, "utf8")).toBeLessThan(OUTPUT_SCHEMA_BYTES);
    const args = { ...input, content: escaped };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "create_output_schema", arguments: args } });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1_000_000);
    const result = await toolValue(await app.rpc(body));
    expect(result).toEqual({ outputSchemaId: expect.any(String), name: normalized.name });
    expect(app.services.outputSchemas.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(escaped.slice(0, 100));
  });
});
