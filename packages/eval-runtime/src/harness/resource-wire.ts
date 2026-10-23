import { equalJson, jsonObjectInPlaceSchema } from "@eval-platform/eval-contracts";
import {
  isEvalRuntimeBusinessDelivered, isEvalTrajectoryDelivered, trajectoryResourceSchema,
  type EvalResourceReadiness, type EvalResourceReadinessReport, type RuntimeBusinessDeliveryState,
  type TrajectoryDeliveryState,
} from "@springbrand/eval-harness";
import { z } from "zod";
import { nativeExecutionKey, nativeExecutionMembers } from "./native-execution.js";

const id = z.string().min(1);
const count = z.number().int().nonnegative().safe().nullable();
const status = z.enum(["delivered", "pending", "failed", "quarantined", "missing", "unreadable"]);

// Decode only fields already exported by SP. Do not infer readiness from trajectory contents.
const trajectory: z.ZodType<TrajectoryDeliveryState> = z.lazy(() => z.strictObject({
  resource: trajectoryResourceSchema.nullable(), submissionId: id.nullable(), status,
  requiredClosed: z.boolean(), pendingRecords: count, children: z.array(trajectory), error: z.string().exactOptional(),
}));
const runtimeBusiness: z.ZodType<RuntimeBusinessDeliveryState> = z.lazy(() => z.strictObject({
  actor: z.strictObject({
    resource: trajectoryResourceSchema.nullable(), path: z.array(z.strictObject({ className: id, name: id })),
  }),
  submissionId: id.nullable(), status, pendingRuntimeEvents: count, quarantinedRuntimeEvents: count,
  children: z.array(runtimeBusiness), error: z.string().exactOptional(),
}));

export const nativeResourceReadinessSchema: z.ZodType<EvalResourceReadiness> = z.preprocess((value, context) => {
  if (!jsonObjectInPlaceSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Native readiness must contain only lossless JSON data" });
    return z.NEVER;
  }
  return value;
}, z.strictObject({
  receiptTerminal: z.boolean(), stateUnreadable: z.boolean(),
  pendingTelemetryEvents: count, pendingRuntimeEvents: count,
  trajectory, runtimeBusiness,
  actionCharges: z.strictObject({
    complete: z.boolean(), unsettledExecutions: z.number().int().nonnegative().safe(),
    missingExecutionIds: z.number().int().nonnegative().safe(),
  }),
}));

/** Validate public execution attribution, not just Chat lifetime identity. Null pending facts stay unknown. */
export function validateNativeResourceScope(report: EvalResourceReadinessReport, requireScope: boolean): void {
  const { scope, readiness, finalized } = report;
  const root = readiness.trajectory;
  if (root.resource && root.resource.sessionId !== scope.chatId ||
    root.submissionId !== null && root.submissionId !== scope.submissionId) {
    throw new Error("Native resource root does not match the requested execution");
  }
  if (finalized || requireScope && root.resource !== null && root.submissionId !== null) nativeExecutionMembers(root);
  const business = readiness.runtimeBusiness;
  if (business.actor.resource !== null && root.resource !== null && !equalJson(business.actor.resource, root.resource) ||
    business.submissionId !== null && business.submissionId !== scope.submissionId) {
    throw new Error("Runtime business delivery does not match the native root execution");
  }
  if (finalized && (!isEvalTrajectoryDelivered(root) || !isEvalRuntimeBusinessDelivered(business) ||
    !readiness.receiptTerminal || readiness.stateUnreadable || readiness.pendingTelemetryEvents !== 0 ||
    readiness.pendingRuntimeEvents !== 0 || !readiness.actionCharges.complete ||
    readiness.actionCharges.unsettledExecutions !== 0 || readiness.actionCharges.missingExecutionIds !== 0)) {
    throw new Error("Finalized native resources have unresolved public delivery facts");
  }
  if (finalized) {
    const delivered = new Set<string>();
    const visit = (state: RuntimeBusinessDeliveryState) => {
      if (!state.actor.resource || !state.submissionId) throw new Error("Runtime business delivery has no execution identity");
      const key = nativeExecutionKey({ resource: state.actor.resource, submissionId: state.submissionId });
      if (delivered.has(key)) throw new Error("Runtime business delivery repeats an execution");
      delivered.add(key);
      state.children.forEach(visit);
    };
    visit(business);
    if (nativeExecutionMembers(root).some((member) => !delivered.has(nativeExecutionKey(member)))) {
      throw new Error("Finalized native resources are missing required execution business delivery");
    }
  }
}
