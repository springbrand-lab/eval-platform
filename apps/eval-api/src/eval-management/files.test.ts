import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
const receiptPath = (id: string) => `${MANAGEMENT_UPLOAD_PATH}/${id}`;
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
    const staging = await openImportStaging(root, "management-uploads");
    const app = setupManagement(true, createManagementFiles(managed.store, staging));
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
    expect(receipt.uploadRef).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(JSON.stringify(receipt)).not.toContain("合同");
    const recovered = await app.request(receiptPath(receipt.uploadRef), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    });
    expect(recovered.status).toBe(200); // Old clients can also recover if they kept the random ref.
    expect(recovered.headers.get("cache-control")).toContain("no-store");
    expect(await recovered.json()).toEqual({
      uploadRef: receipt.uploadRef, kind: "reference", name: "合同.txt", mediaType: "text/plain",
      byteSize: bytes.length, sha256: sha256(bytes), expiresAt: receipt.expiresAt,
    });
    expect(await app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "reference")).toEqual(bytes);
    await expect(app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "material")).rejects.toThrow();
    await expect(app.runtime.evalManagement!.files.read(crypto.randomUUID(), receipt.uploadRef, "reference")).rejects.toThrow();
    managed.uploads.set(receipt.uploadRef, {
      ...managed.uploads.get(receipt.uploadRef)!, expiresAt: new Date(0),
    });
    await expect(app.runtime.evalManagement!.files.read(OWNER, receipt.uploadRef, "reference")).rejects.toThrow();
    expect(app.release).toHaveBeenCalledTimes(4);
  });

  it("recovers a stable UUIDv8 only for the original READY file, without rewriting staged bytes on a duplicate POST", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eval-management-file-"));
    directories.push(root);
    const managed = fakeManagement(OWNER);
    const staging = await openImportStaging(root, "management-uploads");
    const app = setupManagement(true, createManagementFiles(managed.store, staging));
    const id = "00000000-0000-8000-8000-000000000001";
    const otherId = "00000000-0000-8000-8000-000000000002";
    const posted = await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: { ...headers(), "X-Upload-Id": id }, body: bytes,
    });
    expect(posted.status).toBe(201);
    const receipt = await posted.json() as { uploadRef: string; byteSize: number; sha256: string; expiresAt: string };
    expect(receipt.uploadRef).toBe(id);
    const storedFile = path.join(root, "management-uploads", id, sha256(bytes));
    const expiryFile = path.join(root, "management-uploads", id, "expires");
    // Recovery must not use ImportStaging.read(), which would rewrite `expires`.
    await utimes(expiryFile, new Date(0), new Date(0));
    const recovered = await app.request(receiptPath(id), { headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } });
    expect(recovered.status).toBe(200);
    const metadata = await recovered.json();
    expect(metadata).toEqual({
      uploadRef: id, kind: "reference", name: "合同.txt", mediaType: "text/plain",
      byteSize: bytes.length, sha256: receipt.sha256, expiresAt: receipt.expiresAt,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private file|ownerUserId|claimedBy|"url"/u);
    expect((await stat(expiryFile)).mtimeMs).toBe(0);

    const differentBytes = new TextEncoder().encode("other upload");
    const duplicate = await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: { ...headers(differentBytes), "X-Upload-Id": id }, body: differentBytes,
    });
    expect(duplicate.status).toBe(409);
    expect(await (await app.request(receiptPath(id), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).json()).toEqual(metadata);
    expect(await app.runtime.evalManagement!.files.read(OWNER, id, "reference")).toEqual(bytes);
    // Identical bytes do not identify an intended upload: two IDs can have different kind/name.
    const second = await app.request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST", headers: {
        ...headers(), "X-Upload-Id": otherId, "X-Upload-Kind": "material", "X-Upload-Name": "other.txt",
      }, body: bytes,
    });
    expect(second.status).toBe(201);
    expect((await second.json() as { uploadRef: string }).uploadRef).toBe(otherId);
    const secondMetadata = await (await app.request(receiptPath(otherId), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).json();
    expect(secondMetadata).toMatchObject({ uploadRef: otherId, kind: "material", name: "other.txt", sha256: sha256(bytes) });
    expect(secondMetadata).not.toEqual(metadata);

    const readyRow = managed.uploads.get(id)!;
    managed.uploads.set(id, { ...readyRow, name: "../wrong-file" });
    expect((await app.request(receiptPath(id), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(404);
    managed.uploads.set(id, readyRow);
    await expect(app.runtime.evalManagement!.files.recover(crypto.randomUUID(), id)).rejects.toMatchObject({
      code: "REQUEST_NOT_FOUND",
    });
    const reservedId = "00000000-0000-8000-8000-000000000003";
    const reservedExpiresAt = new Date(Date.now() + 60_000);
    await managed.store.reserveUpload(OWNER, reservedId, {
      kind: "reference", name: "reserved.txt", mediaType: "text/plain", byteSize: bytes.length,
      sha256: sha256(bytes), expiresAt: reservedExpiresAt,
    });
    await staging.write(reservedId, { path: "upload", url: "", size: bytes.length }, new Response(bytes).body!,
      reservedExpiresAt.toISOString()); // File may already be staged while its DB row is still RESERVED.
    for (const missingId of [reservedId, "00000000-0000-8000-8000-000000000004"]) {
      expect((await app.request(receiptPath(missingId), {
        headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
      })).status).toBe(404);
    }
    managed.uploads.set(otherId, { ...managed.uploads.get(otherId)!, expiresAt: new Date(0) });
    expect((await app.request(receiptPath(otherId), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(404);

    await writeFile(storedFile, new Uint8Array(bytes.length).fill(65)); // same size; hash must still be verified
    expect((await app.request(receiptPath(id), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(404);
    await rm(storedFile);
    await symlink(expiryFile, storedFile); // no symlink traversal, even if a hash-name file exists
    expect((await app.request(receiptPath(id), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(404);
    await rm(path.join(root, "management-uploads", id), { recursive: true, force: true });
    expect((await app.request(receiptPath(id), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(404);
    expect(await readdir(path.join(root, "management-uploads"))).not.toContain(id); // GET never creates a staging directory
  });

  it("requires the management Bearer before leasing an owner or reading a recovery receipt", async () => {
    const disabled = setupManagement(false);
    const id = "00000000-0000-8000-8000-000000000001";
    expect((await disabled.request(receiptPath(id))).status).toBe(404);
    expect(disabled.ownerServices).not.toHaveBeenCalled();
    const app = setupManagement();
    for (const authorization of [undefined, `Bearer ${RESULT_TOKEN}`, "Bearer wrong"]) {
      expect((await app.request(receiptPath(id), {
        headers: authorization ? { Authorization: authorization } : {},
      })).status).toBe(401);
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(receiptPath(id), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    expect((await app.request(receiptPath("not-a-uuid"), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(400);
    expect((await app.request(`${receiptPath(id)}?uploadId=${id}`, {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
    })).status).toBe(400);
    expect(app.managed.uploads.size).toBe(0);
  });

  it("checks declared lengths and per-kind maxima before storing anything", async () => {
    const app = setupManagement();
    const malformed = [
      { "X-Upload-Size": String(bytes.length + 1) },
      { "X-Upload-Size": "2147483648" },
      { "X-Upload-Kind": "material", "X-Upload-Size": "5000001" },
      { "Content-Type": "text/plain" },
      { "X-Upload-Name": "%ZZ" },
      { "X-Upload-Id": "not-a-uuid" },
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
