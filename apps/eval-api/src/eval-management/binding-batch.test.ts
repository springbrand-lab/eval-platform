import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data, InitialMaterialsRef } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { describe, expect, it, vi } from "vitest";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { patchedInitialResources, type BatchDataBinding } from "../initial-resources.js";
import { requireInitializationBudget } from "../sp/bundle-content.js";
import { batchBindingFingerprint } from "./binding-plan.js";
import { DATASET, OWNER, setupManagement, toolValue } from "./test-fixture.js";

const IDS = Array.from({ length: 20 }, (_, index) =>
  `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const MATERIAL = { bundleId: "77777777-7777-4777-8777-777777777777",
  materialId: "88888888-8888-4888-8888-888888888888" };
const MATERIAL_B = { bundleId: MATERIAL.bundleId,
  materialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const SESSION = { bundleId: "99999999-9999-4999-8999-999999999999",
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError?: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

function fixture() {
  const app = setupManagement();
  const rows = new Map(IDS.map((dataId, index) => [dataId, {
    dataId, name: `Case ${index + 1}`, userPrompt: `PRIVATE_PROMPT_${index}`,
    evalPrompt: `PRIVATE_EVAL_PROMPT_${index}`, business: { url: "https://private.example" },
  } as Data]));
  const materials = new Map<string, { byteSize: number; deleted: boolean }>([
    [`${MATERIAL.bundleId}:${MATERIAL.materialId}`, { byteSize: 3, deleted: false }],
    [`${MATERIAL_B.bundleId}:${MATERIAL_B.materialId}`, { byteSize: 5, deleted: false }],
  ]);
  let writes = 0, loseReply = false, failOn: string | null = null;
  let beforeCommit: (() => void) | null = null;
  const target = async (datasetId: string, dataId: string, expected: string, result?: string) => {
    const row = datasetId === DATASET ? rows.get(dataId) : undefined;
    if (!row) throw new HttpError("DATA_NOT_FOUND");
    if ([...app.managed.operations.values()].some((op) => op.kind === "prepare"
      && op.status === "pending" && op.plan.datasetId === datasetId)) throw new HttpError("EVAL_SP_CONFLICT");
    if (![expected, result].includes(await digestJson(row))) throw new HttpError("EVAL_SP_CONFLICT");
    return row;
  };
  const size = (field: "initialMaterials" | "evalInitialMaterials", ref: InitialMaterialsRef, before: Data) => {
    const entry = materials.get(`${ref.bundleId}:${ref.materialId}`);
    const retained = before[field]?.some(({ bundleId, materialId }) =>
      bundleId === ref.bundleId && materialId === ref.materialId);
    if (!entry || entry.deleted && !retained) throw new BundleResourceNotFoundError("Material", ref.materialId);
    return entry.byteSize;
  };
  const validateReferences = (before: Data, after: Data) => {
    for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
      requireInitializationBudget((after[field] ?? [])
        .reduce((total, ref) => total + size(field, ref, before), 0), field);
    }
    if (after.initialSession && (after.initialSession.bundleId !== SESSION.bundleId
      || after.initialSession.sessionId !== SESSION.sessionId)) throw new BundleResourceNotFoundError("Session", "");
  };
  const preflightBindMaterialBytes = vi.fn(async (datasetId: string, dataId: string, expected: string,
    refs: { initialMaterials?: readonly InitialMaterialsRef[]; evalInitialMaterials?: readonly InitialMaterialsRef[] }) => {
    const data = await target(datasetId, dataId, expected);
    return { data, byteSizes: {
      initialMaterials: (refs.initialMaterials ?? []).map((ref) => size("initialMaterials", ref, data)),
      evalInitialMaterials: (refs.evalInitialMaterials ?? []).map((ref) => size("evalInitialMaterials", ref, data)),
    } };
  });
  const inspectBindTargets = vi.fn(async (datasetId: string, bindings: readonly BatchDataBinding[]) => {
    const current = await Promise.all(bindings.map((entry) => target(datasetId, entry.dataId,
      entry.expectedContentDigest, entry.contentDigest)));
    for (const row of current) validateReferences(row, row);
    return current;
  });
  const bindDataBatch = vi.fn(async (datasetId: string, bindings: readonly BatchDataBinding[]) => {
    beforeCommit?.();
    beforeCommit = null;
    const next: Data[] = [];
    const changed: Data[] = [];
    for (const entry of bindings) {
      const before = await target(datasetId, entry.dataId, entry.expectedContentDigest);
      const after = patchedInitialResources(before, entry.patch);
      if (await digestJson(after) !== entry.contentDigest) throw new HttpError("EVAL_SP_CONFLICT");
      validateReferences(before, after);
      if (entry.dataId === failOn) throw new HttpError("EVAL_SP_CONFLICT");
      if (entry.expectedContentDigest === entry.contentDigest) next.push(before);
      else { next.push(after); changed.push(after); }
    }
    for (const row of changed) rows.set(row.dataId, row);
    writes += changed.length;
    if (loseReply) { loseReply = false; throw Error("batch committed; response lost"); }
    return next;
  });
  const bindData = vi.fn(async () => { throw Error("Batch must never use one-Data bindData"); });
  Object.assign(app.services, {
    initialResources: { preflightBindMaterialBytes, inspectBindTarget: target,
      inspectBindTargets, bindData, bindDataBatch },
    sessionBundles: { getResource: vi.fn(async (bundleId: string, sessionId: string) => {
      if (bundleId !== SESSION.bundleId || sessionId !== SESSION.sessionId) {
        throw new BundleResourceNotFoundError("Session", sessionId);
      }
      return { ...SESSION };
    }) },
  });
  const input = async (operationKey: string, ids: readonly string[] = IDS.slice(0, 3)) => ({
    operationKey, datasetId: DATASET,
    bindings: await Promise.all(ids.map(async (dataId, index) => ({
      dataId, expectedContentDigest: await digestJson(rows.get(dataId)!),
      ...(index % 3 === 0 ? { initialMaterials: [MATERIAL] }
        : index % 3 === 1 ? { evalInitialMaterials: [MATERIAL] } : { initialSession: SESSION }),
    }))),
  });
  return { app, rows, materials, bindData, bindDataBatch, inspectBindTargets, preflightBindMaterialBytes,
    input, writes: () => writes, loseReply: () => { loseReply = true; }, failOn: (id: string) => { failOn = id; },
    clearFailure: () => { failOn = null; }, editBeforeCommit: (edit: () => void) => { beforeCommit = edit; } };
}

describe("Moss v4 atomic binding (fake MCP regression)", () => {
  it("accepts one already-bound Data alongside two updates in one batch, reusing Materials across roles and Data", async () => {
    const f = fixture();
    const first = { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] };
    f.rows.set(IDS[0]!, first);
    const original = [first, f.rows.get(IDS[1]!)!, f.rows.get(IDS[2]!)!];
    const input = { operationKey: "mixed-noop-and-two-writes", datasetId: DATASET, bindings: [
      { dataId: IDS[0], expectedContentDigest: await digestJson(first),
        initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] },
      { dataId: IDS[1], expectedContentDigest: await digestJson(original[1]),
        initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] },
      { dataId: IDS[2], expectedContentDigest: await digestJson(original[2]),
        initialMaterials: [MATERIAL, MATERIAL_B], evalInitialMaterials: [MATERIAL] },
    ] };
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toMatchObject({ kind: "bind", status: "completed", datasetId: DATASET,
      bindings: [{ dataId: IDS[0] }, { dataId: IDS[1] }, { dataId: IDS[2] }] });
    expect(f.preflightBindMaterialBytes).toHaveBeenCalledTimes(3);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.bindData).not.toHaveBeenCalled();
    expect(f.rows.get(IDS[0]!)).toBe(first); // No redundant UPDATE of the already-satisfied member.
    expect(f.rows.get(IDS[1]!)).toMatchObject({ initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] });
    expect(f.rows.get(IDS[2]!)).toMatchObject({
      initialMaterials: [MATERIAL, MATERIAL_B], evalInitialMaterials: [MATERIAL],
    });
    expect(f.writes()).toBe(2);
    expect((receipt.bindings as Array<{ contentDigest: string }>).map(({ contentDigest }) => contentDigest))
      .toEqual(await Promise.all(input.bindings.map(async ({ dataId }) => digestJson(f.rows.get(dataId!)!))));
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toEqual(receipt);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(2);
  });

  it("binds three existing Data in one write, keeps input order and returns only digest receipts", async () => {
    const f = fixture();
    const before = [...f.rows.values()].map((row) => structuredClone(row));
    const input = await f.input("three-existing", [IDS[2]!, IDS[0]!, IDS[1]!]);
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toEqual({
      operationKey: input.operationKey, kind: "bind", status: "completed", datasetId: DATASET,
      bindings: await Promise.all(input.bindings.map(async ({ dataId }) => ({
        dataId, contentDigest: await digestJson(f.rows.get(dataId)),
      }))),
    });
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.bindData).not.toHaveBeenCalled();
    expect(f.writes()).toBe(3);
    expect([...f.rows.values()].map(({ userPrompt }) => userPrompt))
      .toEqual(before.map(({ userPrompt }) => userPrompt));
    const plan = f.app.managed.operations.get(input.operationKey)!.plan;
    expect(plan).toMatchObject({ version: 4, datasetId: DATASET });
    expect(plan).not.toHaveProperty("dataId");
    expect(plan).not.toHaveProperty("dataIds"); // A bind cannot prove Prompt row order.
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey,
      page: 2, pageSize: 2 }));
    expect(detail).toEqual({ operationKey: input.operationKey, kind: "bind", status: "completed",
      datasetId: DATASET, totalBindings: 3, page: 2, pageSize: 2,
      bindings: [{ ...(receipt.bindings as Array<object>)[2], binding: "confirmed" }] });
    expect(JSON.stringify({ receipt, detail })).not.toMatch(/PRIVATE_|https?:\/\/|initialMaterials|uploadRef/u);
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toEqual(receipt);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(3);
  });

  it("rejects malformed rows, duplicate IDs and >20 entries before opening a catalog or recording an operation", async () => {
    const f = fixture();
    const input = await f.input("bad-shape");
    for (const bad of [
      { ...input, bindings: [] },
      { ...input, bindings: [...input.bindings, input.bindings[0]] },
      { ...input, bindings: Array.from({ length: 21 }, () => input.bindings[0]) },
      { ...input, bindings: [{ dataId: IDS[0], expectedContentDigest: input.bindings[0]!.expectedContentDigest }] },
      { ...input, bindings: [{ ...input.bindings[0], initialMaterials: [] }] },
      { ...input, bindings: [{ ...input.bindings[0], initialMaterials: [MATERIAL, MATERIAL] }] },
      { ...input, bindings: [{ ...input.bindings[0], expectedContentDigest: "A".repeat(64) }] },
      { ...input, bindings: [{ ...input.bindings[0], initialSession: { uploadRef: crypto.randomUUID() } }] },
      { ...input, bindings: [{ ...input.bindings[0], evalInitialMaterials: [{ ...MATERIAL, url: "https://secret" }] }] },
      { ...input, dataId: IDS[0] },
      { ...input, bindings: [{ ...input.bindings[0], userPrompt: "PRIVATE_PROMPT" }] },
    ]) {
      expect(await errorCode(await f.app.call("bind_data_resources", bad))).toContain("REQUEST_INVALID_INPUT");
    }
    expect(f.preflightBindMaterialBytes).not.toHaveBeenCalled();
    expect(f.bindDataBatch).not.toHaveBeenCalled();
    expect(f.app.managed.operations.size).toBe(0);
  });

  it("accepts cleared absent fields and an entirely already-satisfied batch without extra UPDATEs", async () => {
    const f = fixture();
    const before = [IDS[0]!, IDS[1]!, IDS[2]!].map((dataId) => {
      const row = { ...f.rows.get(dataId)!, initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] };
      f.rows.set(dataId, row);
      return row;
    });
    const input = { operationKey: "all-already-bound", datasetId: DATASET,
      bindings: await Promise.all(before.map(async ({ dataId }) => ({
        dataId, expectedContentDigest: await digestJson(f.rows.get(dataId)),
        initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL],
      }))) };
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toMatchObject({ status: "completed", bindings: [
      { dataId: IDS[0] }, { dataId: IDS[1] }, { dataId: IDS[2] },
    ] });
    expect(f.preflightBindMaterialBytes).toHaveBeenCalledTimes(3);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(0);
    before.forEach((row, index) => expect(f.rows.get(IDS[index]!)).toBe(row));
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toEqual(receipt);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(0);

    const clear = await f.input("clear-already-absent", [IDS[3]!]);
    const cleared = { ...clear, bindings: [{ dataId: IDS[3]!,
      expectedContentDigest: clear.bindings[0]!.expectedContentDigest, initialSession: null }] };
    expect(await toolValue(await f.app.call("bind_data_resources", cleared)))
      .toMatchObject({ status: "completed", bindings: [{ dataId: IDS[3] }] });
    expect(f.writes()).toBe(0);
  });

  it("accepts a no-op stored plan but cannot complete or display a partial stage as confirmed", async () => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] });
    const noOp = await f.input("already-satisfied-plan", [IDS[0]!]);
    await expect(f.app.managed.store.begin(OWNER, noOp.operationKey, "bind",
      batchBindingFingerprint(OWNER, noOp), { version: 4, request: noOp, datasetId: DATASET,
        bindings: [{ dataId: IDS[0], expectedContentDigest: noOp.bindings[0]!.expectedContentDigest,
          contentDigest: noOp.bindings[0]!.expectedContentDigest, patch: { initialMaterials: [MATERIAL] } }] }))
      .resolves.toMatchObject({ kind: "bind", status: "pending" });
    expect(f.app.managed.operations.size).toBe(1);

    const input = await f.input("partial-stage", [IDS[1]!, IDS[2]!]);
    f.failOn(IDS[1]!);
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    await expect(f.app.managed.store.complete(OWNER, input.operationKey)).rejects.toThrow();
    const plan = f.app.managed.operations.get(input.operationKey)!.plan;
    const first = (plan.bindings as BatchDataBinding[])[0]!;
    await f.app.managed.store.confirm(OWNER, input.operationKey, "batch",
      { datasetId: DATASET, bindings: [{ dataId: first.dataId, contentDigest: first.contentDigest }] });
    await expect(f.app.managed.store.complete(OWNER, input.operationKey)).rejects.toThrow();
    expect(await errorCode(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toContain("RESPONSE_INVALID");
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
    expect(f.writes()).toBe(0);
  });

  it.each([0, 1, 2])("rejects the entire mixed batch if member %i changes another field between preflight and CAS", async (index) => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!,
      initialMaterials: [MATERIAL], evalInitialMaterials: [MATERIAL] });
    const input = await f.input(`mixed-stale-${index}`);
    const originals = input.bindings.map(({ dataId }) => f.rows.get(dataId)!);
    f.editBeforeCommit(() => f.rows.set(IDS[index]!, {
      ...f.rows.get(IDS[index]!)!, userPrompt: "Edited after trusted preflight",
    }));
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.preflightBindMaterialBytes).toHaveBeenCalledTimes(3);
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(0);
    for (const [position, row] of originals.entries()) {
      expect(f.rows.get(IDS[position]!)).toEqual(position === index
        ? { ...row, userPrompt: "Edited after trusted preflight" } : row);
    }
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
  });

  it("does not mistake an unchanged member for proof that the other two committed on attempted replay", async () => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] });
    const input = await f.input("mixed-rollback");
    f.failOn(IDS[2]!);
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.writes()).toBe(0);
    f.clearFailure();
    expect(await errorCode(await f.app.call("bind_data_resources", input)))
      .toContain("OPERATION_OUTCOME_UNKNOWN");
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(0);
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
  });

  it("reconciles a lost mixed-batch reply only after both changing members match their planned full digests", async () => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] });
    const input = await f.input("mixed-lost-reply");
    f.loseReply();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.writes()).toBe(2);
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toMatchObject({
      status: "completed", bindings: [{ dataId: IDS[0] }, { dataId: IDS[1] }, { dataId: IDS[2] }],
    });
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(2);
  });

  it("fails closed when the no-op member changes another field after the mixed transaction's reply is lost", async () => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] });
    const input = await f.input("mixed-noop-lost-then-edited");
    f.loseReply();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.writes()).toBe(2);
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, userPrompt: "Unrelated edit after commit" });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(2);
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
  });

  it("reconciles an all-no-op lost reply by the fully validated target state without another batch transaction", async () => {
    const f = fixture();
    const before = { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] };
    f.rows.set(IDS[0]!, before);
    const input = await f.input("all-noop-lost-reply", [IDS[0]!]);
    f.loseReply();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown" });
    expect(f.writes()).toBe(0);
    expect(await toolValue(await f.app.call("bind_data_resources", input)))
      .toMatchObject({ status: "completed", bindings: [{ dataId: IDS[0] }] });
    expect(f.inspectBindTargets).toHaveBeenCalled();
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.rows.get(IDS[0]!)).toBe(before);
    expect(f.writes()).toBe(0);
  });

  it("never reports an all-no-op batch successful if an untouched reference fails catalog or byte-budget validation", async () => {
    for (const scenario of ["foreign", "oversize"] as const) {
      const f = fixture();
      const row = { ...f.rows.get(IDS[0]!)!, initialMaterials: [
        scenario === "foreign" ? { ...MATERIAL, materialId: crypto.randomUUID() } : MATERIAL,
      ] };
      f.rows.set(IDS[0]!, row);
      if (scenario === "oversize") {
        f.editBeforeCommit(() => f.materials.set(`${MATERIAL.bundleId}:${MATERIAL.materialId}`,
          { byteSize: Number.MAX_SAFE_INTEGER, deleted: false }));
      }
      const input = { operationKey: `invalid-noop-${scenario}`, datasetId: DATASET,
        bindings: [{ dataId: IDS[0], expectedContentDigest: await digestJson(row), initialSession: null }] };
      const error = await errorCode(await f.app.call("bind_data_resources", input));
      expect(error).toContain(scenario === "foreign" ? "BUNDLE_RESOURCE_NOT_FOUND" : "BUNDLE_FILE_TOO_LARGE");
      expect(f.preflightBindMaterialBytes).toHaveBeenCalledTimes(1);
      expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
      expect(f.rows.get(IDS[0]!)).toBe(row);
      expect(f.writes()).toBe(0);
      expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
      expect(await errorCode(await f.app.call("bind_data_resources", input)))
        .toContain(scenario === "foreign" ? "BUNDLE_RESOURCE_NOT_FOUND" : "BUNDLE_FILE_TOO_LARGE");
    }
  });

  it("rejects a newly soft-deleted Material after mixed-batch preflight without updating any Data", async () => {
    const f = fixture();
    f.rows.set(IDS[0]!, { ...f.rows.get(IDS[0]!)!, initialMaterials: [MATERIAL] });
    const input = await f.input("mixed-soft-delete");
    const batch = { ...input, bindings: [
      input.bindings[0]!, input.bindings[1]!,
      { dataId: IDS[2], expectedContentDigest: input.bindings[2]!.expectedContentDigest,
        initialMaterials: [MATERIAL_B] },
    ] };
    f.editBeforeCommit(() => f.materials.set(`${MATERIAL_B.bundleId}:${MATERIAL_B.materialId}`,
      { byteSize: 5, deleted: true }));
    expect(await errorCode(await f.app.call("bind_data_resources", batch))).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(f.writes()).toBe(0);
    expect(f.rows.get(IDS[1]!)).not.toHaveProperty("evalInitialMaterials");
    expect(f.rows.get(IDS[2]!)).not.toHaveProperty("initialMaterials");
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
  });

  it("rolls back all three when a later member fails, and never treats a subset readback as completed", async () => {
    const f = fixture();
    const input = await f.input("rollback-three");
    const original = await Promise.all(input.bindings.map(async ({ dataId }) => digestJson(f.rows.get(dataId))));
    f.failOn(IDS[1]!);
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(0);
    expect(await Promise.all(input.bindings.map(async ({ dataId }) => digestJson(f.rows.get(dataId))))).toEqual(original);
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey, pageSize: 1 })))
      .toMatchObject({ kind: "bind", status: "outcome_unknown", totalBindings: 3,
        bindings: [{ dataId: IDS[0], binding: "attempted" }] });
    f.clearFailure();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("OPERATION_OUTCOME_UNKNOWN");
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1); // No same-key blind rewrite after an attempted stage.
    expect(f.writes()).toBe(0);
    await expect(f.app.managed.store.assertReadyDatasets(OWNER, [DATASET])).rejects.toThrow();
    expect(await errorCode(await f.app.call("bind_data_resources", { ...input, operationKey: "new-key" })))
      .toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.has("new-key")).toBe(false);
  });

  it("readbacks *all* full Data digests after a lost reply, not only the first planned member", async () => {
    const f = fixture();
    const input = await f.input("lost-atomic-reply");
    f.loseReply();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.writes()).toBe(3);
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown", bindings: [
        { dataId: IDS[0], binding: "attempted" },
        { dataId: IDS[1], binding: "attempted" },
        { dataId: IDS[2], binding: "attempted" },
      ] });
    const recovered = await toolValue(await f.app.call("bind_data_resources", input));
    expect(recovered).toMatchObject({ status: "completed", bindings: [
      { dataId: IDS[0] }, { dataId: IDS[1] }, { dataId: IDS[2] },
    ] });
    expect(f.inspectBindTargets).toHaveBeenCalledWith(DATASET, expect.arrayContaining([
      expect.objectContaining({ dataId: IDS[0] }), expect.objectContaining({ dataId: IDS[1] }),
      expect.objectContaining({ dataId: IDS[2] }),
    ]));
    expect(f.bindDataBatch).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(3);
    await expect(f.app.managed.store.assertReadyDatasets(OWNER, [DATASET])).resolves.toBeUndefined();
    f.rows.set(IDS[1]!, { ...f.rows.get(IDS[1]!)!, userPrompt: "Edited after completion" });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.writes()).toBe(3);
  });

  it("keeps an attempted, partially matching readback unknown and fences v3/v4 overlap", async () => {
    const f = fixture();
    const input = await f.input("partial-readback");
    f.loseReply();
    await f.app.call("bind_data_resources", input);
    const untouched = f.rows.get(IDS[1]!)!;
    f.rows.set(IDS[1]!, { ...untouched, userPrompt: "Edited by another writer" });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.writes()).toBe(3);
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown", totalBindings: 3 });
    const other = await f.input("overlap-v4", [IDS[2]!, IDS[3]!]);
    expect(await errorCode(await f.app.call("bind_data_resources", other))).toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.has(other.operationKey)).toBe(false);
    expect(await errorCode(await f.app.call("bind_data_resources", {
      operationKey: "overlap-v3", datasetId: DATASET, dataId: IDS[2],
      expectedContentDigest: await digestJson(f.rows.get(IDS[2]!)!), initialSession: null,
    }))).toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.has("overlap-v3")).toBe(false);
    expect(f.bindData).not.toHaveBeenCalled();
  });

  it("rejects a v4 claim overlapping an existing v3 pending Data and retains a deleted Material only in its original role", async () => {
    const f = fixture();
    const original = f.rows.get(IDS[0]!)!;
    f.rows.set(IDS[0]!, { ...original, initialMaterials: [MATERIAL] });
    f.materials.set(`${MATERIAL.bundleId}:${MATERIAL.materialId}`, { byteSize: 3, deleted: true });
    await f.app.managed.store.begin(OWNER, "pending-v3", "bind", "a".repeat(64),
      { version: 3, datasetId: DATASET, dataId: IDS[1] });
    const attempted = await f.input("overlap-v3-pending", [IDS[0]!, IDS[1]!]);
    expect(await errorCode(await f.app.call("bind_data_resources", {
      ...attempted, bindings: [
        { ...attempted.bindings[0]!, initialSession: SESSION },
        { dataId: IDS[1]!, expectedContentDigest: attempted.bindings[1]!.expectedContentDigest,
          initialSession: SESSION },
      ],
    }))).toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.has(attempted.operationKey)).toBe(false);
    const retained = await f.input("retained", [IDS[0]!]);
    expect(await toolValue(await f.app.call("bind_data_resources", {
      ...retained, bindings: [{ ...retained.bindings[0]!, initialSession: SESSION }],
    })))
      .toMatchObject({ status: "completed" });
    expect(f.rows.get(IDS[0]!)?.initialMaterials).toEqual([MATERIAL]);
    const selected = await f.input("different-role", [IDS[0]!]);
    const newlySelected = { ...selected, bindings: [{ ...selected.bindings[0]!, evalInitialMaterials: [MATERIAL] }] };
    expect(await errorCode(await f.app.call("bind_data_resources", newlySelected)))
      .toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(f.writes()).toBe(1);
    expect(f.app.managed.operations.has(newlySelected.operationKey)).toBe(false);
  });

  it("pages twenty batch receipts in original order at <=10 items and <=4,800 bytes", async () => {
    const f = fixture();
    const input = await f.input("long-batch-" + "k".repeat(180), IDS);
    const bound = await (await f.app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(bound.result.isError).not.toBe(true);
    const receiptText = bound.result.content[0].text;
    expect(receiptText.length).toBeLessThanOrEqual(4_800);
    expect(Buffer.byteLength(receiptText, "utf8")).toBeLessThanOrEqual(4_800);
    const receipt = JSON.parse(receiptText) as { bindings: Array<{ dataId: string }> };
    expect(receipt.bindings.map(({ dataId }) => dataId)).toEqual(IDS);
    expect(receiptText).not.toMatch(/PRIVATE_|https?:\/\/|initialMaterials|expectedContentDigest|uploadRef/u);
    for (const [page, expected] of [[1, IDS.slice(0, 10)], [2, IDS.slice(10)], [3, []]] as const) {
      const rpc = await (await f.app.call("get_preparation", { operationKey: input.operationKey,
        page, pageSize: 10 })).json() as { result: { isError?: boolean; content: [{ text: string }] } };
      expect(rpc.result.isError).not.toBe(true);
      const text = rpc.result.content[0].text;
      expect(text.length).toBeLessThanOrEqual(4_800);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_800);
      const value = JSON.parse(text) as { bindings: Array<{ dataId: string }> };
      expect(value).toMatchObject({ kind: "bind", status: "completed", page, pageSize: 10, totalBindings: 20 });
      expect(value.bindings.map(({ dataId }) => dataId)).toEqual(expected);
      expect(text).not.toMatch(/PRIVATE_|https?:\/\/|initialMaterials|expectedContentDigest|uploadRef/u);
    }
  });
});
