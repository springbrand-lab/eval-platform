import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";

export type DatasetMemberOrder = "upload" | "unknown";

/** Only facts already persisted by the management preparation flow, not another order store. */
export interface PreparationOrderEvidence {
  readonly ownerUserId: string;
  readonly operationKey: string;
  readonly kind: string;
  readonly status: string;
  readonly fingerprint: string;
  readonly plan: unknown;
  readonly stages: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function completedOriginalIds(owner: string, datasetId: string, evidence: PreparationOrderEvidence): string[] | null {
  if (evidence.ownerUserId !== owner || evidence.kind !== "prepare" || evidence.status !== "completed") return null;
  const plan = record(evidence.plan);
  const stages = record(evidence.stages);
  if (!plan || !stages || plan.version !== 3 || plan.datasetId !== datasetId
    || typeof evidence.operationKey !== "string" || !evidence.operationKey
    || typeof plan.name !== "string" || !plan.name.trim()
    || typeof plan.description !== "string" || !plan.description.trim()
    || typeof plan.promptUploadRef !== "string"
    || platformIdSchema.safeParse(plan.promptUploadRef).data !== plan.promptUploadRef
    || !Array.isArray(plan.dataIds) || plan.dataIds.length < 1 || plan.dataIds.length > 50
    || !Array.isArray(plan.cases) || plan.cases.length !== plan.dataIds.length
    || !Array.isArray(plan.rowDigests) || plan.rowDigests.length !== plan.dataIds.length
    || !["json", "jsonl"].includes(plan.format as string)) return null;
  const fact = record(plan.uploadFact);
  if (!fact || fact.kind !== "prompt" || fact.uploadRef !== plan.promptUploadRef
    || typeof fact.name !== "string" || !fact.name
    || typeof fact.mediaType !== "string" || !fact.mediaType
    || typeof fact.byteSize !== "number" || !Number.isSafeInteger(fact.byteSize) || fact.byteSize < 1
    || typeof fact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(fact.sha256)
    || plan.rowDigests.some((item) => {
      const row = record(item);
      return !row || typeof row.original !== "string" || !/^[a-f0-9]{64}$/u.test(row.original)
        || typeof row.bound !== "string" || !/^[a-f0-9]{64}$/u.test(row.bound);
    })) return null;
  const request = { operationKey: evidence.operationKey, promptUploadRef: plan.promptUploadRef,
    name: plan.name, description: plan.description, format: plan.format, cases: plan.cases };
  // The completed receipt alone is not proof if its ordered hashes or request
  // have changed after completion. Match the same canonical v3 operation fingerprint.
  if (createHash("sha256").update(canonicalJsonBytes([
    "management-preparation/v3", owner, request, fact, plan.rowDigests,
  ])).digest("hex") !== evidence.fingerprint) return null;
  const ids: string[] = plan.dataIds;
  if (new Set(ids).size !== ids.length || ids.some((id) => {
    const parsed = platformIdSchema.safeParse(id);
    return !parsed.success || parsed.data !== id;
  })) return null;
  const datasetStage = record(stages.dataset);
  const receipt = record(datasetStage?.receipt);
  if (datasetStage?.status !== "confirmed" || receipt?.datasetId !== datasetId
    || !Array.isArray(receipt.dataIds) || !sameIds(receipt.dataIds, ids)) return null;
  for (const dataId of ids) {
    const stage = record(stages[`data:${dataId}`]);
    if (stage?.status !== "confirmed" || record(stage.receipt)?.dataId !== dataId) return null;
  }
  return ids;
}

/** Stable legacy fallback; known additions follow unknown historical members in their proven relative order. */
function deterministic<T extends { readonly dataId: string; readonly position: number | null }>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => {
    if (left.position === null && right.position !== null) return -1;
    if (left.position !== null && right.position === null) return 1;
    if (left.position !== null && right.position !== null && left.position !== right.position) {
      return left.position - right.position;
    }
    return left.dataId < right.dataId ? -1 : left.dataId === right.dataId ? 0 : 1;
  });
}

/**
 * Positions prove the original order only for Datasets tracked since creation with no effective
 * membership removal. A pre-tracking Dataset may have undergone a detach-all/readd with dense
 * positions: do not promote its positions to proof. For old, entirely position-less Prompt
 * Datasets, accept only a *single* completed, owned v3 preparation whose fingerprint,
 * ordered row hashes, planned IDs and confirmed receipts prove the full membership.
 * Never revive invalidated proof or accept an older unhashed plan.
 */
export function resolveDatasetMemberOrder<T extends { readonly dataId: string; readonly position: number | null }>(
  owner: string,
  dataset: { readonly datasetId: string; readonly kind: "general" | "prompt";
    readonly originalOrderIntact: boolean | null },
  members: readonly T[],
  completedPlans: readonly PreparationOrderEvidence[],
): { readonly order: DatasetMemberOrder; readonly members: readonly T[] } {
  const positions = members.map((member) => member.position);
  if (dataset.originalOrderIntact === true && members.length && positions.every((position): position is number =>
    typeof position === "number" && Number.isSafeInteger(position) && position >= 0)
    && new Set(positions).size === positions.length) {
    return { order: "upload", members: [...members].sort((left, right) => left.position! - right.position!) };
  }
  if (dataset.originalOrderIntact === null && members.length && dataset.kind === "prompt"
    && positions.every((position) => position === null)
    && completedPlans.length === 1) {
    const original = completedOriginalIds(owner, dataset.datasetId, completedPlans[0]!);
    if (original && members.length === original.length
      && sameIds([...members].map(({ dataId }) => dataId).sort(),
        [...original].sort())) {
      const byId = new Map(members.map((member) => [member.dataId, member]));
      if (byId.size === original.length) {
        return { order: "upload", members: original.map((id) => byId.get(id)!) };
      }
    }
  }
  return { order: "unknown", members: deterministic(members) };
}
