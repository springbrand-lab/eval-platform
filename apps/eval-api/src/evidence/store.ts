import { createEvidenceStore, type EvidenceStore } from "@eval-platform/eval-runtime/harness";
import type { WorkerConfig } from "../config/worker.js";
import { openLocalEvidenceBlobs } from "./local-blobs.js";
import { createR2EvidenceBlobs } from "./r2-blobs.js";

/** R2 when the Eval bucket is configured; otherwise `evidence/` under the Bundle directory. */
export async function openEvidenceStore(config: Pick<WorkerConfig, "EVAL_BUNDLE_DIR" | "evidenceR2">): Promise<EvidenceStore> {
  return createEvidenceStore(config.evidenceR2 === undefined
    ? await openLocalEvidenceBlobs(config.EVAL_BUNDLE_DIR)
    : createR2EvidenceBlobs(config.evidenceR2));
}
