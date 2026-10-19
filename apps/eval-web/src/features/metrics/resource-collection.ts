import type { ResourceCollections } from "@/api-sdk/types";

export const RESOURCES_PENDING_LABEL = "补采资源中";

/** Collected but not finalized snapshots; their numbers may still grow. */
export function unfinalizedResourceCount(collections: Pick<ResourceCollections, "collected" | "finalized">): number {
  return Math.max(0, collections.collected - collections.finalized);
}

/** Failed, never collected or unfinalized resources of submitted Agents. */
export function resourceCollectionGap(collections: ResourceCollections): number {
  return collections.failed + collections.uncollected + unfinalizedResourceCount(collections);
}
