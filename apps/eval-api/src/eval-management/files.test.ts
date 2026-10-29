import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openImportStaging } from "../agent-imports/bytes.js";
import { createManagementFiles } from "./files.js";
import { fakeManagement } from "./management.test-support.js";
import { MANAGEMENT_TOKEN, OWNER, RESULT_TOKEN, setupManagement } from "./test-fixture.js";
import { MANAGEMENT_UPLOAD_PATH } from "./upload-route.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const bytes = new TextEncoder().encode("private file");
const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const headers = (body = bytes) => ({
  Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/octet-stream",
  "X-Upload-Kind": "reference", "X-Upload-Name": encodeURIComponent("合同.txt"),
  "X-Upload-Media-Type": "text/plain", "X-Upload-Size": String(body.length),
  "X-Upload-Sha256": sha256(body),
});

describe("trusted bounded management bytes", () => {
  it("authenticates before reading a byte; rejects cross-token, unsupported methods, paths and wrong digests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eval-management-file-"));
    directories.push(root);
    const managed = fakeManagement(OWNER);
    const app = setupManagement(true, createManagementFiles(managed.store,
      await openImportStaging(root, "management-uploads")));
    const forbidden = await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: { ...headers(), Authorization: `Bearer ${RESULT_TOKEN}` }, body: bytes,
    });
    expect(forbidden.status).toBe(401);
    expect(app.ownerServices).not.toHaveBeenCalled();
    const unsupported = await app.request(MANAGEMENT_UPLOAD_PATH, { method: "GET" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toBe("POST");
    expect((await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: { ...headers(), "X-Upload-Name": "some%2Fpath.txt" }, body: bytes,
    })).status).toBe(400);
    expect((await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: { ...headers(), "X-Upload-Sha256": "0".repeat(64) }, body: bytes,
    })).status).toBe(400);
    expect(managed.uploads.size).toBe(0);
    const success = await app.request(MANAGEMENT_UPLOAD_PATH, { method: "POST", headers: headers(), body: bytes });
    expect(success.status).toBe(201);
    const receipt = await success.json() as { uploadRef: string; sha256: string; byteSize: number; expiresAt: string };
    expect(receipt).toEqual({
      uploadRef: expect.any(String), sha256: sha256(bytes), byteSize: bytes.length, expiresAt: expect.any(String),
    });
    expect(JSON.stringify(receipt)).not.toContain("合同");
    expect(await app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "reference")).toEqual(bytes);
    await expect(app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "material")).rejects.toThrow();
    await expect(app.runtime.evalManagement!.files.read(crypto.randomUUID(), receipt.uploadRef, "reference")).rejects.toThrow();
    managed.uploads.set(receipt.uploadRef, {
      ...managed.uploads.get(receipt.uploadRef)!, expiresAt: new Date(0),
    });
    await expect(app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "reference")).rejects.toThrow();
    expect(app.release).toHaveBeenCalledTimes(3);
  });

  it("checks declared lengths and per-kind maxima before storing anything", async () => {
    const app = setupManagement();
    const malformed = [
      { "X-Upload-Size": String(bytes.length + 1) },
      { "X-Upload-Size": "2147483648" },
      { "X-Upload-Kind": "material", "X-Upload-Size": "5000001" },
      { "Content-Type": "text/plain" },
      { "X-Upload-Name": "%ZZ" },
    ];
    for (const extra of malformed) {
      const response = await app.request(MANAGEMENT_UPLOAD_PATH, {
        method: "POST", headers: { ...headers(), ...extra }, body: bytes,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(app.managed.uploads.size).toBe(0);
  });
});
