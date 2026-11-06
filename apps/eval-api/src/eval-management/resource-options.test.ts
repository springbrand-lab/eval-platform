import { describe, expect, it, vi } from "vitest";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { setupManagement, toolValue } from "./test-fixture.js";

const BUNDLE = "77777777-7777-4777-8777-777777777777";
const MATERIAL = "88888888-8888-4888-8888-888888888888";
const SESSION = "99999999-9999-4999-8999-999999999999";

async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError?: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

function catalogs() {
  const app = setupManagement();
  const materialBundles = {
    list: vi.fn(async () => Array.from({ length: 7 }, (_, index) => ({
      bundleId: index ? `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` : BUNDLE,
      name: index === 0 ? "https://internal.example/private" : `Material Bundle ${index}`,
      description: index === 1 ? "password: must-not-appear" : "Material inventory",
      privateUrl: "https://not-for-moss.invalid",
    }))),
    listResources: vi.fn(async (id: string) => {
      if (id !== BUNDLE) throw new BundleResourceNotFoundError("Material Bundle", id);
      return Array.from({ length: 6 }, (_, index) => ({
        bundleId: BUNDLE, materialId: index === 0 ? MATERIAL
          : `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: index === 0 ? "文档🧪".repeat(600) : `Brief ${index}`,
        description: index === 1 ? "sk-very-private-credential-value" : "Public description",
        byteSize: index * 10, files: "PRIVATE_BODY",
      }));
    }),
    listFiles: vi.fn(async (id: string, materialId: string) => {
      if (id !== BUNDLE || materialId !== MATERIAL) throw new BundleResourceNotFoundError("Material", materialId);
      return [
        { path: "/safe/readme.txt", mediaType: "text/plain", byteSize: 12, bytes: "PRIVATE_BODY" },
        { path: "/https://private.invalid/context", mediaType: "text/plain", byteSize: 20 },
        { path: `/${"r".repeat(200)}.txt`, mediaType: "application/octet-stream", byteSize: 1 },
      ];
    }),
  };
  const sessionBundles = {
    list: vi.fn(async () => [{ bundleId: BUNDLE, name: "Previous history", description: "Session inventory" }]),
    listResources: vi.fn(async (id: string) => {
      if (id !== BUNDLE) throw new BundleResourceNotFoundError("Session Bundle", id);
      return [{ bundleId: BUNDLE, sessionId: SESSION, name: "History", description: "Earlier context",
        format: "jsonl", content: "PRIVATE_BODY" }];
    }),
    listFiles: vi.fn(async (id: string, sessionId: string) => {
      if (id !== BUNDLE || sessionId !== SESSION) throw new BundleResourceNotFoundError("Session", sessionId);
      return [{ path: "/context.jsonl", mediaType: "application/x-ndjson", byteSize: 71, bytes: "PRIVATE_BODY" }];
    }),
  };
  Object.assign(app.services, { materialBundles, sessionBundles });
  return { app, materialBundles, sessionBundles };
}

describe("bounded, redacted existing Material/Session choices", () => {
  it("lists all six categories with the exact active-catalog selectors, stable paging and metadata only", async () => {
    const { app, materialBundles, sessionBundles } = catalogs();
    const calls = [
      { category: "material_bundles" },
      { category: "session_bundles" },
      { category: "materials", bundleId: BUNDLE },
      { category: "sessions", bundleId: BUNDLE },
      { category: "material_files", bundleId: BUNDLE, materialId: MATERIAL },
      { category: "session_files", bundleId: BUNDLE, sessionId: SESSION },
    ];
    for (const input of calls) {
      const rpc = await (await app.call("list_options", input)).json() as {
        result: { isError?: boolean; content: [{ text: string }] };
      };
      expect(rpc.result.isError).not.toBe(true);
      const text = rpc.result.content[0].text;
      expect(text.length).toBeLessThanOrEqual(4_800);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_800);
      expect(text).not.toMatch(/PRIVATE_BODY|password: must-not-appear|https?:\/\/|sk-very-private-credential-value|privateUrl/u);
      const response = JSON.parse(text) as { items: unknown[]; pageSize: number };
      expect(response.pageSize).toBe(5);
      expect(response.items.length).toBeLessThanOrEqual(5);
    }
    const bundles = await toolValue(await app.call("list_options", { category: "material_bundles" }));
    expect(bundles).toMatchObject({ total: 7, page: 1, pageSize: 5 });
    expect((bundles.items as unknown[]).slice(0, 2)).toMatchObject([
      { bundleId: BUNDLE, sourceRedacted: true }, { sourceRedacted: true },
    ]);
    expect(await toolValue(await app.call("list_options", {
      category: "material_bundles", page: 2, pageSize: 50,
    }))).toMatchObject({ page: 2, pageSize: 5, total: 7, items: [{ name: "Material Bundle 5" }, { name: "Material Bundle 6" }] });
    const materials = await toolValue(await app.call("list_options", { category: "materials", bundleId: BUNDLE }));
    expect(materials).toMatchObject({ category: "materials", bundleId: BUNDLE, total: 6 });
    expect((materials.items as unknown[]).slice(0, 2)).toMatchObject([
      { materialId: MATERIAL, byteSize: 0, nameTruncated: true }, { sourceRedacted: true },
    ]);
    expect(await toolValue(await app.call("list_options", { category: "sessions", bundleId: BUNDLE })))
      .toEqual({ category: "sessions", bundleId: BUNDLE, page: 1, pageSize: 5, total: 1,
        items: [{ bundleId: BUNDLE, sessionId: SESSION, name: "History", description: "Earlier context", format: "jsonl" }] });
    expect(await toolValue(await app.call("list_options", { category: "material_files", bundleId: BUNDLE, materialId: MATERIAL })))
      .toMatchObject({ materialId: MATERIAL, total: 3, items: [
        { path: "/safe/readme.txt", mediaType: "text/plain", byteSize: 12 },
        { sourceRedacted: true, byteSize: 20 }, { pathTruncated: true },
      ] });
    expect(await toolValue(await app.call("list_options", { category: "session_files", bundleId: BUNDLE, sessionId: SESSION })))
      .toEqual({ category: "session_files", bundleId: BUNDLE, sessionId: SESSION, page: 1, pageSize: 5, total: 1,
        items: [{ path: "/context.jsonl", mediaType: "application/x-ndjson", byteSize: 71 }] });
    expect(materialBundles.listResources).toHaveBeenCalledWith(BUNDLE);
    expect(materialBundles.listFiles).toHaveBeenCalledWith(BUNDLE, MATERIAL);
    expect(sessionBundles.listFiles).toHaveBeenCalledWith(BUNDLE, SESSION);
  });

  it("rejects unrelated selectors, foreign/wrong-kind/removed IDs and malformed catalog UUIDs without bytes", async () => {
    const { app, materialBundles, sessionBundles } = catalogs();
    for (const input of [
      { category: "materials" },
      { category: "sessions", bundleId: BUNDLE, materialId: MATERIAL },
      { category: "material_files", bundleId: BUNDLE },
      { category: "session_files", bundleId: BUNDLE, materialId: MATERIAL },
      { category: "material_bundles", bundleId: BUNDLE },
      { category: "session_bundles", q: "context" },
      { category: "material_files", bundleId: BUNDLE, materialId: MATERIAL, datasetId: BUNDLE },
      { category: "materials", bundleId: BUNDLE, pageSize: 51 },
    ]) expect(await errorCode(await app.call("list_options", input))).toContain("REQUEST_INVALID_INPUT");
    expect(materialBundles.list).not.toHaveBeenCalled();
    expect(await errorCode(await app.call("list_options", { category: "materials", bundleId: SESSION })))
      .toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await errorCode(await app.call("list_options", { category: "session_files", bundleId: BUNDLE, sessionId: MATERIAL })))
      .toContain("BUNDLE_RESOURCE_NOT_FOUND");
    materialBundles.list.mockResolvedValueOnce([
      { bundleId: "not-a-uuid", name: "Bad", description: "Bad", privateUrl: "https://not-for-moss.invalid" },
    ]);
    expect(await errorCode(await app.call("list_options", { category: "material_bundles" })))
      .toContain("RESPONSE_INVALID");
    expect(sessionBundles.listResources).not.toHaveBeenCalled();
  });
});
