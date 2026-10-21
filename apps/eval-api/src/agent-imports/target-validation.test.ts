import { afterEach, describe, expect, it } from "vitest";
import { isRequestCancelled } from "@springbrand/http/errors";
import { equalJson } from "@eval-platform/eval-contracts";
import { EvalSpApiError } from "../sp/http.js";
import type { SourceSnapshot } from "./model.js";
import { createAgentImportService, createAgentImportTaskReader } from "./service.js";
import { ImportConflictError, ImportDependencyError, ImportOutcomeUnknownError } from "./errors.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";
import { agentId, otherAgentId, owner, referenceId, snapshotFixture, sourceUser, workerFixture } from "./worker.test-support.js";

const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const ok = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });
const completeDevSetting = () => ({
  ...canonicalSourceSettingFixture(),
  authoring: {
    goal: "  Find reliable sources\n", inputs: "A topic", exampleInput: "Research this",
    instructionsMode: "manual",
  },
  preferredSupplierIds: ["supplier.research", "supplier.search"],
  referenceNotes: "  Private background\n\nKeep this whitespace.  \n",
});
async function validationFixture(validate: (request: Request) => Response | Promise<Response>, snapshot?: SourceSnapshot) {
  const f = await workerFixture(snapshot); fixtures.push(f);
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
      f.requests.push(request.clone());
      return validate(request);
    }
    return transport(request);
  });
  return f;
}
const resourceWrites = (f: Awaited<ReturnType<typeof workerFixture>>) => f.requests.filter((request) =>
  request.method !== "GET"
  && !(request.method === "POST"
    && new URL(request.url).pathname === "/api/agent-config-imports/validate"));

describe("complete Agent setting target preflight", () => {
  it.each(["skills", "references"] as const)("blocks a root missing selected source %s before preparing any target admission facts", async (kind) => {
    const snapshot = snapshotFixture();
    if (kind === "skills") snapshot.skills = [];
    else snapshot.references = [];
    const f = await workerFixture(snapshot); fixtures.push(f);
    const service = createAgentImportService(f);
    const reader = createAgentImportTaskReader(f.store);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId, otherAgentId], purpose: "execution", idempotencyKey: `missing-${kind}`,
    });
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    const preflights = f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate");
    expect(await Promise.all(preflights.map((request) => request.clone().json()))).toEqual([{
      setting: canonicalSourceSettingFixture(), dependencies: [], plannedResources: { skills: [], references: [] },
    }]);
    expect(resourceWrites(f)).toEqual([]);
    await service.apply(taskId, "apply-independent");
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).status).toBe("completed_with_errors");
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
  });

  it("does not add cross-root Skill name admission after Target approves each independent selected set", async () => {
    const snapshot = snapshotFixture();
    const first = { ...canonicalSourceSettingFixture(), skillIds: ["private-skill"] };
    const second = { ...canonicalSourceSettingFixture(), skillIds: ["other-private"] };
    snapshot.agents[0]!.setting = first;
    snapshot.agents[1]!.setting = second;
    snapshot.skills.push({ id: "other-private", name: "PRIVATE-SKILL", kind: "user", contentHash: null,
      files: [{ path: "SKILL.md", size: 3, url: "https://dev.test/files/other-private" }] });
    const f = await validationFixture(async (request) => {
      const body = await request.json();
      const selected = body.setting.skillIds[0];
      const expected = selected === "private-skill"
        ? { setting: first, dependencies: [], plannedResources: { skills: [{ id: "private-skill", name: "private-skill" }], references: [] } }
        : { setting: second, dependencies: [], plannedResources: { skills: [{ id: "other-private", name: "PRIVATE-SKILL" }], references: [] } };
      return equalJson(body, expected) ? ok({ version: 1, setting: expected.setting })
        : Response.json({ code: "AGENT_CONFIG_IMPORT_INVALID", errMsg: "Unexpected selection facts" }, { status: 422 });
    }, snapshot);
    const service = createAgentImportService(f);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId, otherAgentId], purpose: "execution", idempotencyKey: "independent-selected-names",
    });
    await f.worker.run(taskId);
    expect((await createAgentImportTaskReader(f.store).task(taskId)).agents.map((agent) => agent.status)).toEqual(["ready", "ready"]);
    expect(resourceWrites(f)).toEqual([]);
  });

  it("preflights only selected future user Skill names and Reference sizes from the frozen snapshot, then uses actual imported facts", async () => {
    const snapshot = snapshotFixture();
    snapshot.references.push({ ...snapshot.references[0]!, id: otherAgentId, name: "unused.txt", size: 17 });
    const setting = structuredClone(snapshot.agents[0]!.setting);
    const plannedResources = {
      skills: [{ id: "private-skill", name: "private-skill" }],
      references: [{ id: referenceId, size: 3 }],
    };
    const f = await workerFixture(snapshot); fixtures.push(f);
    const transport = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
        f.requests.push(request.clone());
        const body = await request.json();
        const expected = f.targetSkills.has("private-skill") && f.targetReferences.has(referenceId)
          ? { skills: [], references: [] } : plannedResources;
        if (!equalJson(body.plannedResources, expected) || !equalJson(body.dependencies, [])) {
          return Response.json({ code: "AGENT_CONFIG_IMPORT_INVALID", errMsg: "Selected future resource facts are required" }, { status: 422 });
        }
        return ok({ version: 1, setting });
      }
      if (new URL(request.url).pathname === "/api/skills" && new URL(request.url).searchParams.get("view") === "library") {
        f.requests.push(request.clone());
        return Response.json({ code: "REQUEST_NOT_FOUND", errMsg: "No catalog admission fallback" }, { status: 404 });
      }
      return transport(request);
    });
    const service = createAgentImportService(f);
    const reader = createAgentImportTaskReader(f.store);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId], purpose: "execution", idempotencyKey: "planned-facts",
    });
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).agents[0]?.status).toBe("ready");
    expect(resourceWrites(f)).toEqual([]);
    const task = (await f.store.get(taskId))!;
    const plan = structuredClone(task.plan);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    snapshot.skills[0]!.name = "changed after preview";
    snapshot.references[0]!.size = 99;
    await service.apply(taskId, "apply-planned");
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).status).toBe("completed");
    const preflights = f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate");
    expect(await Promise.all(preflights.map((request) => request.clone().json()))).toEqual([
      { setting, dependencies: [], plannedResources },
      { setting, dependencies: [], plannedResources },
      { setting, dependencies: [], plannedResources: { skills: [], references: [] } },
    ]);
    expect(task.plan).toEqual(plan);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.requests.some((request) => /^\/api\/(?:actions|components|connectors|model-catalog)(?:\/|$)/u.test(new URL(request.url).pathname))).toBe(false);
    expect(f.requests.some((request) => new URL(request.url).pathname === "/api/skills"
      && new URL(request.url).searchParams.get("view") === "library")).toBe(false);
  });

  it("blocks an older target's full-setting rejection during preview even with zero direct capability dependencies", async () => {
    const snapshot = snapshotFixture();
    snapshot.agents[0]!.setting = completeDevSetting();
    const original = structuredClone(snapshot);
    const f = await workerFixture(snapshot); fixtures.push(f);
    const transport = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/agent-config-imports/validate" || path === "/api/user-agent-configs/imports") {
        const { setting } = await request.clone().json();
        if (path.endsWith("/validate") || setting.authoring !== undefined) {
          f.requests.push(request.clone());
          return setting.authoring === undefined ? ok({ version: 1, setting }) : Response.json({
            code: "REQUEST_VALIDATION_FAILED", errMsg: "private target validation details",
            errors: [{ path: "setting.authoring", errMsg: "Unknown field" }], requestId: "preflight-request",
          }, { status: 422 });
        }
      }
      return transport(request);
    });
    const service = createAgentImportService(f);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId, otherAgentId], purpose: "execution", idempotencyKey: "preview-complete",
    });
    await f.worker.run(taskId);
    const view = await createAgentImportTaskReader(f.store).task(taskId);
    expect(view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(JSON.stringify(view)).not.toContain("private target validation details");
    expect((await f.store.get(taskId))!.plan!.eligibleAgentIds).toEqual([otherAgentId]);
    expect(f.requests.filter((request) => request.method !== "GET"
      && new URL(request.url).pathname !== "/api/agent-config-imports/validate")).toEqual([]);
    expect(snapshot).toEqual(original);
  });

  it.each(["authoring", "preferredSupplierIds", "referenceNotes", "futureSettingField"])(
    "rejects a preflight success that drops %s instead of freezing a lossy target setting",
    async (field) => {
      const snapshot = snapshotFixture();
      snapshot.agents[0]!.setting = { ...completeDevSetting(), futureSettingField: { keep: "verbatim" } };
      const original = structuredClone(snapshot);
      const f = await workerFixture(snapshot); fixtures.push(f);
      const transport = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
          f.requests.push(request.clone());
          const { setting } = await request.json();
          delete setting[field];
          return ok({ version: 1, setting });
        }
        return transport(request);
      });
      await expect(f.agents.prepareImport(snapshot.agents[0]!, "execution")).rejects.toBeInstanceOf(ImportConflictError);
      expect(snapshot).toEqual(original);
      expect(f.requests.filter((request) => request.method !== "GET"
        && new URL(request.url).pathname !== "/api/agent-config-imports/validate")).toEqual([]);
    },
  );

  it("rejects a non-JSON target setting instead of equating numeric overflow with a canonical null", async () => {
    const f = await workerFixture(); fixtures.push(f);
    const transport = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
        f.requests.push(request.clone());
        const body = JSON.stringify({ success: true, msg: { version: 1, setting: completeDevSetting() } })
          .replace('"systemPrompt":null', '"systemPrompt":1e400');
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      }
      return transport(request);
    });
    await expect(f.target.validateSelections(completeDevSetting())).rejects.toBeInstanceOf(ImportDependencyError);
  });

  it.each(["config", "validate"])("retains the SDK cancellation cause in the existing %s dependency-failure flow", async (operation) => {
    const f = await workerFixture(); fixtures.push(f);
    const transport = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === `/api/agent-config-imports/${operation}`) {
        f.requests.push(request.clone());
        return new Response(new ReadableStream({
          start(controller) { controller.error(new DOMException("Cancelled target read", "AbortError")); },
        }), { headers: { "Content-Type": "application/json" } });
      }
      return transport(request);
    });
    const error = await f.target.validateSelections(completeDevSetting()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportDependencyError);
    expect(isRequestCancelled((error as Error).cause)).toBe(true);
    expect(error).not.toBeInstanceOf(ImportConflictError);
  });

  it.each([
    { status: 422, code: "REQUEST_VALIDATION_FAILED" }, { status: 422, code: "AGENT_CONFIG_IMPORT_INVALID" },
    { status: 422, code: "AGENT_CONFIG_INVALID" }, { status: 403, code: "MODEL_ACCESS_DENIED" },
  ])(
    "blocks the documented $status/$code rejection with a safe conflict and structured target diagnostics",
    async ({ status, code }) => {
      const f = await workerFixture(); fixtures.push(f);
      const transport = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
          return Response.json({
            code, errMsg: "private target validation details", requestId: "validation-request",
            errors: [{ path: "setting.preferredSupplierIds", errMsg: "Supplier is unavailable" }],
          }, { status });
        }
        return transport(request);
      });
      const error = await f.target.validateSelections(completeDevSetting()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ImportConflictError);
      expect(error).toMatchObject({ status: 409, code: "EVAL_SP_CONFLICT", cause: expect.any(EvalSpApiError) });
      expect((error as Error).cause).toMatchObject({ status, payload: {
        code, requestId: "validation-request",
        errors: [{ path: "setting.preferredSupplierIds", errMsg: "Supplier is unavailable" }],
      } });
      expect((error as Error).message).not.toContain("private target validation details");
    },
  );

  it.each([
    { status: 404, code: "REQUEST_NOT_FOUND" }, { status: 405, code: "REQUEST_METHOD_NOT_ALLOWED" },
    { status: 401, code: "AUTH_UNAUTHENTICATED" }, { status: 403, code: "REQUEST_FORBIDDEN" },
    { status: 429, code: "REQUEST_RATE_LIMITED" }, { status: 503, code: "DATABASE_UNAVAILABLE" },
    { status: 422, code: "UNKNOWN_TARGET_VALIDATION" }, { status: 400, code: "REQUEST_VALIDATION_FAILED" },
    { status: 401, code: "AGENT_CONFIG_INVALID" }, { status: 503, code: "AGENT_CONFIG_IMPORT_INVALID" },
    { status: 409, code: "UNKNOWN_PROXY_CONFLICT" }, { status: 409, code: "MODEL_ACCESS_DENIED" },
    { status: 401, code: "MODEL_ACCESS_DENIED" }, { status: 422, code: "MODEL_ACCESS_DENIED" },
    { status: 503, code: "MODEL_ACCESS_DENIED" }, { status: 403, code: "AGENT_CONFIG_IMPORT_CONFLICT" },
  ])("fails closed on preflight HTTP $status/$code without status-only guessing or writes", async ({ status, code }) => {
    const f = await validationFixture(() => Response.json({
      code, errMsg: "private target details", requestId: "dependency-request",
    }, { status }));
    const error = await f.target.validateSelections(completeDevSetting()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportDependencyError);
    expect(error).toMatchObject({ status: 503, code: "EVAL_SP_UNAVAILABLE", cause: expect.any(EvalSpApiError) });
    expect((error as Error).cause).toMatchObject({ status, payload: { code, requestId: "dependency-request" } });
    expect((error as Error).message).not.toContain("private target details");
    expect(resourceWrites(f)).toEqual([]);
  });

  it.each([
    { version: 2, setting: completeDevSetting() }, { version: "1", setting: completeDevSetting() },
    { setting: completeDevSetting() }, { version: 1 }, { version: 1, setting: null },
    { version: 1, setting: [] }, { version: 1, setting: "not a setting" },
  ])("fails closed on an incompatible preflight result (%#), even with empty selections", async (msg) => {
    const f = await validationFixture(() => ok(msg));
    await expect(f.target.validateSelections(completeDevSetting())).rejects.toBeInstanceOf(ImportDependencyError);
    expect(resourceWrites(f)).toEqual([]);
  });

  it.each(["bare", "negative", "malformed", "offline"])("does not bypass a %s preflight response during preview", async (response) => {
    const f = await validationFixture(() => {
      if (response === "offline") throw new TypeError("target offline");
      if (response === "malformed") return new Response('{"success":true,"msg":', { headers: { "Content-Type": "application/json" } });
      return Response.json(response === "bare" ? { version: 1, setting: completeDevSetting() }
        : { success: false, msg: { version: 1, setting: completeDevSetting() } });
    });
    await expect(f.preview([otherAgentId])).rejects.toBeInstanceOf(ImportDependencyError);
    expect(resourceWrites(f)).toEqual([]);
    expect(f.savedViews.at(-1)?.status).toBe("checking");
    expect(f.savedViews.at(-1)?.agents[0]?.status).not.toBe("ready");
  });

  it.each([
    { change: "trimmed notes", patch: { referenceNotes: "Private background\n\nKeep this whitespace." } },
    { change: "truncated authoring", patch: { authoring: { goal: "Find reliable" } } },
    { change: "rewritten defaults", patch: { presetId: "target-default" } },
    { change: "reordered Supplier preferences", patch: { preferredSupplierIds: ["supplier.search", "supplier.research"] } },
    { change: "invented defaults", patch: { targetOnlyDefault: false } },
  ])("rejects a target success with $change instead of accepting a different frozen setting", async ({ patch }) => {
    const f = await validationFixture(() => ok({ version: 1, setting: { ...completeDevSetting(), ...patch } }));
    await expect(f.target.validateSelections(completeDevSetting())).rejects.toBeInstanceOf(ImportConflictError);
    expect(resourceWrites(f)).toEqual([]);
  });

  it("preserves complete Dev fields through preview, create-only apply and durable receipt finalization under the fixed target owner", async () => {
    const snapshot = snapshotFixture();
    const setting = { ...completeDevSetting(), skillIds: ["private-skill", "builtin-demo"], referenceFileIds: [referenceId] };
    snapshot.agents[0]!.setting = setting;
    const original = structuredClone(setting);
    const f = await validationFixture(async (request) => {
      const { setting } = await request.json();
      return ok({ version: 1, setting: Object.fromEntries(Object.entries(setting).reverse()) });
    }, snapshot);
    const service = createAgentImportService(f);
    const reader = createAgentImportTaskReader(f.store);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId], purpose: "execution", idempotencyKey: "complete-round-trip",
    });
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).agents[0]?.status).toBe("ready");
    const task = (await f.store.get(taskId))!;
    expect(task.snapshot!.agents[0]!.setting).toEqual(original);
    expect(task.plan!.resources.find((resource) => resource.kind === "agent")!.prepared!.config.setting).toEqual(original);
    const plan = structuredClone(task.plan);
    expect(resourceWrites(f)).toEqual([]);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    snapshot.agents[0]!.setting = { ...snapshot.agents[0]!.setting, referenceNotes: "Changed in dev after preview" };
    f.failNextPurpose();
    await service.apply(taskId, "apply-complete");
    await expect(f.worker.run(taskId)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    const posts = resourceWrites(f).filter((request) => new URL(request.url).pathname === "/api/user-agent-configs/imports");
    expect(posts).toHaveLength(1);
    const body = await posts[0]!.clone().json();
    expect(body).toMatchObject({ id: agentId, setting: original, dependencies: [] });
    expect(body).not.toHaveProperty("user_id");
    const receipt = await f.target.receipt("agent", body.importKey);
    expect(receipt).toMatchObject({ receipt: { resourceId: agentId, importKey: body.importKey },
      resource: { id: agentId, user_id: owner, setting: original } });
    const writes = resourceWrites(f).length;
    await f.worker.run(taskId);
    expect((await reader.task(taskId)).status).toBe("completed");
    expect(await f.agents.get(agentId)).toMatchObject({ id: agentId, user_id: owner, setting: original });
    expect(task.plan).toEqual(plan);
    expect(resourceWrites(f)).toHaveLength(writes);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    for (const request of f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate")) {
      const body = await request.clone().json();
      expect(body.setting).toEqual(original);
      expect(body.dependencies).toEqual([]);
      expect([
        { skills: [{ id: "private-skill", name: "private-skill" }], references: [{ id: referenceId, size: 3 }] },
        { skills: [], references: [] },
      ]).toContainEqual(body.plannedResources);
      expect(Object.keys(body).sort()).toEqual(["dependencies", "plannedResources", "setting"]);
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe("Bearer target-session");
      expect(request.headers.get("Origin")).toBe("https://web.test");
    }
    const preflights = f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate");
    expect((await preflights.at(-1)!.clone().json()).plannedResources).toEqual({ skills: [], references: [] });
    expect(f.sp.createAgentConfig).not.toHaveBeenCalled();
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("revalidates full settings before any apply dependency write and isolates a newly rejected Supplier preference", async () => {
    const snapshot = snapshotFixture();
    snapshot.agents[0]!.setting = { ...snapshot.agents[0]!.setting, ...completeDevSetting(),
      skillIds: ["private-skill", "builtin-demo"], referenceFileIds: [referenceId] };
    let reject = false;
    const f = await validationFixture(async (request) => {
      const { setting } = await request.json();
      return reject && setting.preferredSupplierIds !== undefined
        ? Response.json({ code: "AGENT_CONFIG_INVALID", errMsg: "private Supplier details" }, { status: 422 })
        : ok({ version: 1, setting });
    }, snapshot);
    const service = createAgentImportService(f);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId, otherAgentId], purpose: "execution", idempotencyKey: "fresh-validation",
    });
    await f.worker.run(taskId);
    const task = (await f.store.get(taskId))!;
    const plan = structuredClone(task.plan);
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["ready", "ready"]);
    reject = true;
    await service.apply(taskId, "apply-fresh");
    await f.worker.run(taskId);
    const view = await createAgentImportTaskReader(f.store).task(taskId);
    expect(view.status).toBe("completed_with_errors");
    expect(view.agents.map((agent) => agent.status)).toEqual(["conflict", "created"]);
    expect(JSON.stringify(view)).not.toContain("private Supplier details");
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
    expect((await resourceWrites(f)[0]!.clone().json()).id).toBe(otherAgentId);
    expect(await f.target.agent(agentId)).toBeNull();
    expect(await f.target.skill("private-skill")).toBeNull();
    expect(await f.target.reference(referenceId)).toBeNull();
    expect(task.plan).toEqual(plan);
  });

  it.each([404, 401, 503])("pauses apply when preflight becomes HTTP %i, then resumes the same frozen plan without source reads", async (status) => {
    let unavailable = false;
    const f = await validationFixture(async (request) => {
      const { setting } = await request.json();
      return unavailable ? Response.json({ code: status === 404 ? "REQUEST_NOT_FOUND"
        : status === 401 ? "AUTH_UNAUTHENTICATED" : "DATABASE_UNAVAILABLE", errMsg: "unavailable" }, { status })
        : ok({ version: 1, setting });
    });
    const service = createAgentImportService(f);
    const { taskId } = await service.preview({
      sourceUserId: sourceUser, agentIds: [agentId], purpose: "execution", idempotencyKey: "preflight-outage",
    });
    await f.worker.run(taskId);
    const task = (await f.store.get(taskId))!;
    const plan = structuredClone(task.plan);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    unavailable = true;
    await service.apply(taskId, "apply-outage");
    await expect(f.worker.run(taskId)).rejects.toBeInstanceOf(ImportDependencyError);
    expect(resourceWrites(f)).toEqual([]);
    expect(task.view.status).toBe("importing");
    expect(task.plan).toEqual(plan);
    unavailable = false;
    await f.worker.run(taskId);
    expect((await createAgentImportTaskReader(f.store).task(taskId)).status).toBe("completed");
    expect(task.plan).toEqual(plan);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
  });

  it("keeps a cancelled preview retryable rather than marking its Agent ready or conflicted", async () => {
    const f = await validationFixture(() => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException("Cancelled target read", "AbortError")); },
    }), { headers: { "Content-Type": "application/json" } }));
    const error = await f.preview([otherAgentId]).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportDependencyError);
    expect(isRequestCancelled((error as Error).cause)).toBe(true);
    expect(f.savedViews.at(-1)?.status).toBe("checking");
    expect(f.savedViews.at(-1)?.agents[0]?.status).toBe("pending");
    expect(resourceWrites(f)).toEqual([]);
  });
});
