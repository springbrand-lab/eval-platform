import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EvidenceBlobStore } from "@eval-platform/eval-runtime/harness";

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Evidence under `<root>/evidence/`: `blobs/<sha256>` and `<evidence hex>/manifest.json`.
 * Bytes stream through a temporary file while hashed, then are linked into place once, so a
 * partial write is never visible and an existing blob is never rewritten.
 */
export async function openLocalEvidenceBlobs(bundleRoot: string): Promise<EvidenceBlobStore> {
  const root = join(bundleRoot, "evidence");
  const blobs = join(root, "blobs");
  const temporary = join(root, "tmp");
  await mkdir(blobs, { recursive: true });
  await mkdir(temporary, { recursive: true });

  /** Publishes a finished temporary file at `target`; an existing target wins and is kept. */
  async function publish(file: string, target: string): Promise<void> {
    try {
      await link(file, target);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    } finally {
      await rm(file, { force: true });
    }
  }

  return {
    async putBlob(content, maxBytes) {
      const file = join(temporary, randomUUID());
      const hash = createHash("sha256");
      let size = 0;
      try {
        await pipeline(Readable.fromWeb(content as never), async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            size += chunk.byteLength;
            if (size > maxBytes) throw new Error("Evidence blob is too large");
            hash.update(chunk);
            yield chunk;
          }
        }, createWriteStream(file, { flags: "wx" }));
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
      const sha256 = hash.digest("hex");
      await publish(file, join(blobs, sha256));
      return { sha256, size };
    },

    async readBlob(sha256) {
      if (!SHA256.test(sha256)) return undefined;
      const path = join(blobs, sha256);
      try {
        await stat(path);
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    },

    async putManifest(evidenceHex, bytes) {
      if (!SHA256.test(evidenceHex)) throw new TypeError("Invalid evidence ID");
      await mkdir(join(root, evidenceHex), { recursive: true });
      const file = join(temporary, randomUUID());
      await pipeline(Readable.from([bytes]), createWriteStream(file, { flags: "wx" }) as Writable);
      await publish(file, join(root, evidenceHex, "manifest.json"));
    },

    async readManifest(evidenceHex) {
      if (!SHA256.test(evidenceHex)) return undefined;
      try {
        return new Uint8Array(await readFile(join(root, evidenceHex, "manifest.json")));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
