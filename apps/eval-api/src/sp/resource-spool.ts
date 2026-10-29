import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResourceSnapshotDownload, AgentResourceSnapshotPage, AgentResourceSnapshotSummary } from "@eval-platform/eval-contracts";
import { SpHarnessError } from "./harness-error.js";

/** Only compact facts, never a referenced native body, enter this private temporary file.
 * There is one independently bounded JSON line per page/record, not a Chat-sized JS array. */
export const RESOURCE_SPOOL_PAGE_MAX_BYTES = 4_000_000;

export async function createResourceSpool() {
  const directory = await mkdtemp(join(tmpdir(), "eval-resources-"));
  const path = join(directory, "pages.jsonl");
  let writer;
  try {
    writer = await open(path, "wx", 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await writer.close();
    }
  };
  const dispose = () => rm(directory, { recursive: true, force: true });
  return {
    async write(page: AgentResourceSnapshotPage): Promise<void> {
      if (closed) throw new SpHarnessError("Resource download has already been sealed", false);
      const line = JSON.stringify(page);
      if (Buffer.byteLength(line) > RESOURCE_SPOOL_PAGE_MAX_BYTES) {
        throw new SpHarnessError("Compact resource record exceeds one bounded page", false);
      }
      await writer.appendFile(`${line}\n`, "utf8");
    },
    async finish(summary: AgentResourceSnapshotSummary, creditsTotal: number | null): Promise<AgentResourceSnapshotDownload> {
      await close();
      return {
        kind: "pages",
        summary,
        creditsTotal,
        async *readPages(): AsyncIterable<AgentResourceSnapshotPage> {
          const file = createReadStream(path, { highWaterMark: 64 * 1024 });
          const pending: Buffer[] = [];
          let pendingBytes = 0;
          for await (const bytes of file) {
            const chunk = bytes as Buffer;
            let start = 0;
            for (let index = 0; index < chunk.byteLength; index++) {
              if (chunk[index] !== 10) continue;
              const length = pendingBytes + index - start;
              if (length === 0 || length > RESOURCE_SPOOL_PAGE_MAX_BYTES) {
                throw new SpHarnessError("Compact resource page changed after verification", false);
              }
              const line = pending.length === 0 ? chunk.subarray(start, index)
                : Buffer.concat([...pending, chunk.subarray(start, index)], length);
              pending.length = 0;
              pendingBytes = 0;
              try {
                yield JSON.parse(line.toString("utf8")) as AgentResourceSnapshotPage;
              } catch {
                throw new SpHarnessError("Sealed resource page is not valid JSON", false);
              }
              start = index + 1;
            }
            if (start < chunk.byteLength) {
              const tail = chunk.subarray(start);
              pending.push(tail);
              pendingBytes += tail.byteLength;
              if (pendingBytes > RESOURCE_SPOOL_PAGE_MAX_BYTES) {
                throw new SpHarnessError("Compact resource page changed after verification", false);
              }
            }
          }
          if (pendingBytes !== 0) {
            throw new SpHarnessError("Sealed resource page ended without a complete line", false);
          }
        },
        dispose,
      };
    },
    async discard(): Promise<void> {
      await close();
      await dispose();
    },
  };
}
