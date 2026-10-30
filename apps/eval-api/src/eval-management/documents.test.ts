import { createHash } from "node:crypto";
import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { RuntimeEntityNotFoundError, digestJson } from "@eval-platform/eval-runtime";
import { describe, expect, it } from "vitest";
import { detail } from "./metrics-fixture.js";
import { MANAGEMENT_TOKEN, RESULT_TOKEN, SCHEMA, WEB_TOKEN, project, run, setupManagement, toolValue } from "./test-fixture.js";

const DOCUMENTS = "/mcp/eval-management/documents";
const schemaQuery = { kind: "output_schema", outputSchemaId: SCHEMA };
const projectSchemaQuery = { kind: "project_schema", projectId: project.projectId };
const resultQuery = { kind: "evaluation_result", projectId: project.projectId,
  samplingId: "sampling-1", evaluationId: "evaluation-1" };
const url = (query: Record<string, string>) => `${DOCUMENTS}?${new URLSearchParams(query)}`;
const get = (app: ReturnType<typeof setupManagement>, query: Record<string, string>, token = MANAGEMENT_TOKEN) =>
  app.request(url(query), { headers: { Authorization: `Bearer ${token}` } });

function withResult(rawJson: unknown, validation = { status: "valid", reason: "valid" }) {
  const evaluation = detail.evaluations[0]!;
  return { ...detail, evaluations: [{ ...evaluation, output: { ...evaluation.output,
    rawJson, content: JSON.stringify(rawJson), validation,
  } }] };
}

function file(body: string) {
  const lines = body.split("\n");
  expect(lines.at(-1)).toBe("");
  const records = lines.slice(0, -2).map((line) => JSON.parse(line) as {
    type: string; offset: number; base64: string;
  });
  const manifest = JSON.parse(lines.at(-2)!) as {
    type: string; format: string; kind: string;
    projectId?: string; samplingId?: string; evaluationId?: string; runScope?: string; runId?: string;
    outputSchemaId?: string; digest?: string; validation?: { status: string; reason: string };
    display: { totalBytes: number; sha256: string } | null; sourceRedacted: boolean;
    withheld: boolean; displayComplete: boolean;
  };
  let offset = 0;
  const chunks = records.map((record) => {
    expect(record.type).toBe("chunk");
    expect(record.offset).toBe(offset);
    const bytes = Buffer.from(record.base64, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(8_192);
    offset += bytes.byteLength;
    return bytes;
  });
  const bytes = Buffer.concat(chunks);
  expect(manifest.type).toBe("manifest");
  expect(manifest.format).toBe("eval-management-json/v1");
  expect(manifest.displayComplete).toBe(true);
  if (manifest.display) {
    expect(manifest.display).toEqual({ totalBytes: offset,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  } else {
    expect(records).toEqual([]);
  }
  return { manifest, records, bytes };
}

async function incomplete(response: Response) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  await expect((async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      chunks.push(next.value);
    }
  })()).rejects.toThrow();
  const partial = Buffer.concat(chunks).toString("utf8");
  expect(partial).not.toContain('"type":"manifest"');
  return partial;
}

describe("read-only trusted one-shot JSON documents", () => {
  it("authenticates before leasing an owner and accepts only fixed, unambiguous GET selectors", async () => {
    const disabled = setupManagement(false);
    expect((await get(disabled, schemaQuery)).status).toBe(404);
    expect(disabled.ownerServices).not.toHaveBeenCalled();
    const app = setupManagement();
    for (const token of [RESULT_TOKEN, WEB_TOKEN, "bad"]) {
      expect((await get(app, schemaQuery, token)).status).toBe(401);
      expect((await get(app, projectSchemaQuery, token)).status).toBe(401);
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(url(schemaQuery), {
        method, headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    for (const query of [
      { ...schemaQuery, url: "https://foreign.example" }, { ...schemaQuery, projectId: project.projectId },
      { ...projectSchemaQuery, outputSchemaId: SCHEMA }, { ...projectSchemaQuery, runId: run.runId },
      { kind: "output_schema" }, { ...resultQuery, outputSchemaId: SCHEMA },
      { ...resultQuery, runId: "foreign-run" }, { ...resultQuery, kind: "invalid" },
    ]) {
      expect((await get(app, query)).status).not.toBe(200);
    }
    expect((await app.request(`${url(schemaQuery)}&outputSchemaId=${SCHEMA}`, {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).not.toBe(200);
    expect(app.services.outputSchemas.get).not.toHaveBeenCalled();
    expect(app.services.projects.getEvaluationOutputSchema).not.toHaveBeenCalled();
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
  });

  it("streams the Project-frozen Schema after catalog deletion, binding the original plan digest in the manifest", async () => {
    const app = setupManagement();
    const content = { type: "object", description: "Safe field definition. ".repeat(2_000),
      properties: { score: { type: "number" }, reason: { type: "string" } } };
    const digest = await digestJson(content);
    app.services.projects.getEvaluationOutputSchema.mockImplementation(async (projectId) => {
      if (projectId !== project.projectId) throw new RuntimeEntityNotFoundError("project", projectId);
      return { reference: { outputSchemaId: SCHEMA, digest }, content };
    });
    app.savedSchemas.delete(SCHEMA);
    const preview = await toolValue(await app.call("list_options", {
      category: "project_schema_detail", projectId: project.projectId,
    }));
    expect(preview).toMatchObject({ projectId: project.projectId, outputSchemaId: SCHEMA,
      digest, schemaChunk: null, streamRequired: true,
      display: { totalBytes: Buffer.byteLength(JSON.stringify(content), "utf8") } });
    const response = await get(app, projectSchemaQuery);
    expect(response.status).toBe(200);
    const { manifest, bytes } = file(await response.text());
    expect(bytes.toString("utf8")).toBe(JSON.stringify(content));
    expect(manifest).toMatchObject({ kind: "project_schema", projectId: project.projectId,
      outputSchemaId: SCHEMA, digest, display: preview.display, sourceRedacted: false, withheld: false });
    expect(manifest).not.toHaveProperty("runId");
    expect(manifest).not.toHaveProperty("runScope");
    expect(app.services.projects.getEvaluationOutputSchema).toHaveBeenCalledTimes(3); // Preview, GET start, GET end.
    expect(app.services.outputSchemas.get).not.toHaveBeenCalled();
    expect((await get(app, { ...projectSchemaQuery, projectId: "foreign-project" })).status).toBe(404);
  });

  it("never emits a Project Schema manifest if its frozen plan or content changes before stream completion", async () => {
    const app = setupManagement();
    const original = { description: "A".repeat(32_000) };
    const changed = { description: "B".repeat(32_000) };
    app.services.projects.getEvaluationOutputSchema.mockResolvedValueOnce({
      reference: { outputSchemaId: SCHEMA, digest: await digestJson(original) }, content: original,
    }).mockResolvedValueOnce({
      reference: { outputSchemaId: SCHEMA, digest: await digestJson(changed) }, content: changed,
    });
    const partial = await incomplete(await get(app, projectSchemaQuery));
    expect(partial).toContain('"type":"chunk"');
    expect(partial).not.toContain('"type":"manifest"');
    expect(app.services.projects.getEvaluationOutputSchema).toHaveBeenCalledTimes(2);
  });

  it("rechecks Project Schema content even when a broken source repeats the same reference digest", async () => {
    const app = setupManagement();
    const original = { description: "A".repeat(32_000) };
    const digest = await digestJson(original);
    app.services.projects.getEvaluationOutputSchema.mockResolvedValueOnce({
      reference: { outputSchemaId: SCHEMA, digest }, content: original,
    }).mockResolvedValueOnce({
      reference: { outputSchemaId: SCHEMA, digest }, content: { description: "B".repeat(32_000) },
    });
    expect(await incomplete(await get(app, projectSchemaQuery))).not.toContain('"type":"manifest"');
  });

  it("rejects a complete sanitized JSON document over 10 MiB before opening any stream", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withResult({
      reason: "x".repeat(10 * 1024 * 1024),
    }));
    const response = await get(app, resultQuery);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "CATALOG_PAYLOAD_TOO_LARGE" });
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
  });

  it("sends a ~1MB owned Schema once, not hundreds of repeated full-document MCP pages", async () => {
    const app = setupManagement();
    const schema = { type: "object", description: "Field definitions. ".repeat(48_000),
      properties: { reason: { type: "string" }, score: { type: "number" } } };
    const canonical = JSON.stringify(schema);
    expect(Buffer.byteLength(canonical)).toBeLessThan(1_000_000);
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Big", description: "Metadata", schema });
    const preview = await toolValue(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA,
    }));
    expect(preview).toMatchObject({ schemaChunk: null, streamRequired: true, sourceRedacted: false,
      display: { totalBytes: Buffer.byteLength(canonical, "utf8"),
        sha256: createHash("sha256").update(canonical).digest("hex") } });
    const response = await get(app, schemaQuery);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-length")).toBeNull();
    const { manifest, records, bytes } = file(await response.text());
    expect(records.length).toBeGreaterThan(100);
    expect(bytes.toString("utf8")).toBe(canonical);
    expect(manifest).toMatchObject({ kind: "output_schema", outputSchemaId: SCHEMA,
      display: preview.display, sourceRedacted: false, withheld: false });
    expect(app.services.outputSchemas.get).toHaveBeenCalledTimes(3); // MCP, stream start, stream end.
    const continued = await (await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: 2_048,
    })).json() as { result: { isError?: boolean; content: [{ text: string }] } };
    expect(continued.result.isError).toBe(true);
    expect(continued.result.content[0].text).toContain("REQUEST_INVALID_INPUT");
  });

  it("binds a large redacted Evaluation to its original and current exact Run, with one displayed digest", async () => {
    const app = setupManagement();
    const raw = { url: "https://private.example/result", token: 123456789, prompt: { secret: "private" },
      reason: "Safe reason", detail: "Helpful but long. ".repeat(15_000) };
    app.services.metrics.getSamplingDetail.mockResolvedValue(withResult(raw));
    const chosen = { projectId: project.projectId, runId: run.runId,
      scope: "sampling", samplingId: "sampling-1", evaluationId: "evaluation-1" };
    const preview = await toolValue(await app.call("get_metrics", chosen)) as {
      evaluationResult: { rawJsonChunk: null; sourceRedacted: boolean;
        streamRequired: boolean; display: { totalBytes: number; sha256: string } };
    };
    expect(preview.evaluationResult).toMatchObject({ rawJsonChunk: null,
      streamRequired: true, sourceRedacted: true, validation: { status: "valid", reason: "valid" } });
    const response = await get(app, { ...resultQuery, runId: run.runId });
    expect(response.status).toBe(200);
    const { manifest, records, bytes } = file(await response.text());
    expect(records.length).toBeGreaterThan(10);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ url: "[REDACTED: sensitive source content]",
      token: "[REDACTED: sensitive source content]", prompt: "[REDACTED: sensitive source content]",
      reason: "Safe reason", detail: raw.detail });
    expect(bytes.toString("utf8")).not.toMatch(/https:|123456789|private\.example/u);
    expect(manifest).toMatchObject({ ...resultQuery,
      runScope: "exact_run", runId: run.runId,
      display: preview.evaluationResult.display, sourceRedacted: true, withheld: false,
      validation: { status: "valid", reason: "valid" } });
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(3); // MCP, stream start, stream end.
    expect(app.services.projectRuns.readRun).toHaveBeenCalledTimes(3);
  });

  it("reassembles exact UTF-8 across binary frames even when a frame cuts a code point", async () => {
    const app = setupManagement();
    const schema = { title: "评估🧪".repeat(2_000), properties: { reason: { type: "string" } } };
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "UTF-8", description: "Metadata", schema });
    const { manifest, records, bytes } = file(await (await get(app, schemaQuery)).text());
    expect(records.length).toBeGreaterThan(2);
    expect(bytes.subarray(0, 8_192).toString("utf8")).toContain("\ufffd"); // A frame alone ends inside a code point.
    expect(bytes.toString("utf8")).toBe(JSON.stringify(schema));
    expect(manifest).toMatchObject({ display: { totalBytes: bytes.length }, sourceRedacted: false, withheld: false });
  });

  it("withholds unsafe field names, distinguishes absent output and never emits a false success manifest on source loss", async () => {
    const app = setupManagement();
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Unsafe", description: "Metadata",
      schema: { properties: { "https://unsafe.example/key": { type: "string" } } } });
    const unsafe = file(await (await get(app, schemaQuery)).text());
    expect(unsafe.manifest).toMatchObject({ display: null, sourceRedacted: true, withheld: true });
    expect(unsafe.records).toEqual([]);
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withResult(null, { status: "invalid", reason: "invalid-json" }))
      .mockResolvedValueOnce(withResult(null, { status: "invalid", reason: "invalid-json" }));
    const absent = file(await (await get(app, resultQuery)).text());
    expect(absent.manifest).toMatchObject({ display: null, sourceRedacted: false, withheld: false,
      validation: { status: "invalid", reason: "invalid-json" } });
    const safeSchema = { type: "object", title: "Long but valid. ".repeat(2_000) };
    app.services.outputSchemas.get.mockResolvedValueOnce({
      outputSchemaId: SCHEMA, name: "Safe", description: "Metadata", schema: safeSchema,
    }).mockResolvedValueOnce(null);
    const partial = await incomplete(await get(app, schemaQuery));
    expect(partial).toContain('"type":"chunk"');
    expect(partial).not.toContain("unsafe.example");
  });

  it("does not certify a changed Schema body under the same owned ID", async () => {
    const app = setupManagement();
    const original = { title: "A".repeat(32_000) };
    const changed = { title: "B".repeat(32_000) };
    app.services.outputSchemas.get.mockResolvedValueOnce({
      outputSchemaId: SCHEMA, name: "Schema", description: "Metadata", schema: original,
    }).mockResolvedValueOnce({
      outputSchemaId: SCHEMA, name: "Schema", description: "Metadata", schema: changed,
    });
    const partial = await incomplete(await get(app, schemaQuery));
    expect(partial).toContain('"type":"chunk"');
    expect(app.services.outputSchemas.get).toHaveBeenCalledTimes(2);
  });

  it("omits a terminal manifest when a current Evaluation is replaced during the transfer", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withResult({ reason: "A".repeat(32_000) }))
      .mockRejectedValueOnce(new MetricsEntityNotFoundError("sampling", "sampling-1"));
    const partial = await incomplete(await get(app, resultQuery));
    expect(partial).toContain('"type":"chunk"');
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
  });

  it("releases a cancelled large stream without an end-of-file identity read or a temporary file", async () => {
    const app = setupManagement();
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Large", description: "Metadata",
      schema: { description: "Safe. ".repeat(100_000) } });
    const response = await get(app, schemaQuery);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(first.value))).toMatchObject({ type: "chunk", offset: 0 });
    await reader.cancel();
    expect(app.services.outputSchemas.get).toHaveBeenCalledTimes(1);
    expect(app.release).toHaveBeenCalledTimes(1);
  });
});
