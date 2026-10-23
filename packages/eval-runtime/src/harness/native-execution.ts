import { equalJson, jsonObjectInPlaceSchema } from "@eval-platform/eval-contracts";
import {
  openTrajectory, parseTrajectoryRecord, readTrajectoryBookkeeping, trajectoryRecordIdentity,
  evalTrajectoryScopeSchema,
  type TrajectoryDeliveryState, type TrajectoryReader, type TrajectoryRecord, type TrajectoryResource,
} from "@springbrand/eval-harness";

export interface NativeExecutionScope {
  readonly resource: TrajectoryResource;
  readonly submissionId: string;
}

export const nativeExecutionKey = (scope: NativeExecutionScope) =>
  JSON.stringify([scope.resource.agentId, scope.resource.sessionId, scope.submissionId]);

export function belongsToNativeExecution(record: TrajectoryRecord, scope: NativeExecutionScope): boolean {
  return record.submissionId === scope.submissionId && equalJson(record.resource, scope.resource);
}

export function parseSafeTrajectoryRecord(value: unknown): TrajectoryRecord {
  const record = parseTrajectoryRecord(value);
  if (record.projection?.kind !== "safe") throw new Error("Native trajectory is not a safe public projection");
  return record;
}

export function distinctNativeRecords(values: readonly unknown[]): TrajectoryRecord[] {
  const distinct = new Map<string, TrajectoryRecord>();
  const policies = new Map<string, TrajectoryRecord["projection"]>();
  for (const value of values) {
    const record = parseSafeTrajectoryRecord(value);
    const actor = JSON.stringify(record.resource);
    const policy = policies.get(actor);
    if (policy && !equalJson(policy, record.projection)) throw new Error("Conflicting native trajectory projection policy");
    policies.set(actor, record.projection);
    const key = trajectoryRecordIdentity(record);
    const previous = distinct.get(key);
    if (previous) {
      const { ingestSeq: _left, ...left } = previous;
      const { ingestSeq: _right, ...right } = record;
      if (!equalJson(left, right)) throw new Error(`Conflicting trajectory source identity ${key}`);
    } else distinct.set(key, record);
  }
  return [...distinct.values()];
}

export function nativeExecutionMembers(state: TrajectoryDeliveryState): readonly NativeExecutionScope[] {
  jsonObjectInPlaceSchema.parse(state);
  const members = new Map<string, NativeExecutionScope>();
  if (!state.resource || !state.submissionId) throw new Error("Native trajectory has no explicit root execution scope");
  const visit = (member: TrajectoryDeliveryState) => {
    if (member.resource && member.submissionId) {
      const scope = evalTrajectoryScopeSchema.parse({ resource: member.resource, submissionId: member.submissionId });
      const key = nativeExecutionKey(scope);
      if (members.has(key)) throw new Error("Native trajectory repeats an execution membership");
      members.set(key, scope);
    }
    member.children.forEach(visit);
  };
  visit(state);
  return [...members.values()];
}

export interface NativeExecutionView {
  readonly reader: TrajectoryReader;
  readonly records: readonly TrajectoryRecord[];
  /** Observed immutable execution work, including entries no longer in Pi's context window. */
  readonly selected: ReadonlySet<string>;
  /** Pi's model-visible branch at each execution seal; never the accounting work set. */
  readonly visible: ReadonlyMap<string, readonly TrajectoryRecord[]>;
  readonly complete: boolean;
  readonly diagnostics: readonly string[];
  close(): Promise<void>;
}

/** SP owns work membership and source closure. Pi owns model-visible context, not accounting. */
export async function openNativeExecution(
  values: readonly unknown[], members: readonly NativeExecutionScope[],
): Promise<NativeExecutionView> {
  if (members.length === 0) throw new Error("Native trajectory has no execution membership");
  const scopes = members.map((member) => evalTrajectoryScopeSchema.parse(member));
  if (new Set(scopes.map(nativeExecutionKey)).size !== scopes.length) throw new Error("Native trajectory repeats an execution membership");
  const records = distinctNativeRecords(values);
  const reader = await openTrajectory(records);
  const selected = new Set<string>();
  const visible = new Map<string, readonly TrajectoryRecord[]>();
  const diagnostics: string[] = [];
  try {
    for (const member of scopes) {
      const owned = records.filter((record) => belongsToNativeExecution(record, member));
      const byId = new Map(owned.filter((record) => record.record.type === "entry").map((record) => [record.record.value.id, record]));
      for (const record of byId.values()) selected.add(trajectoryRecordIdentity(record));
      const seals = owned.filter((record) => {
        const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
        return data?.type === "host_turn" && data.phase === "terminal";
      });
      if (seals.length !== 1) {
        diagnostics.push(`Execution ${nativeExecutionKey(member)} has no unique native seal`);
        continue;
      }
      const seal = seals[0]!;
      if (seal.record.type !== "entry") continue;
      const context = await reader.context({
        resource: member.resource, conversationId: seal.record.value.conversationId, at: seal.record.value.id,
      });
      visible.set(nativeExecutionKey(member), context.entries.flatMap((entry) => {
        const record = byId.get(entry.id);
        return record ? [record] : [];
      }));
    }
    return { reader, records, selected, visible, complete: diagnostics.length === 0, diagnostics,
      close: () => reader.close() };
  } catch (error) {
    await reader.close();
    throw error;
  }
}
