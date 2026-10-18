import type { AgentPurpose } from "@eval-platform/eval-contracts";

/** A user-supplied catalog field (name, description, content, reference) is invalid. */
export class CatalogInputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "CatalogInputError";
  }
}

/** User-supplied catalog content exceeds its documented limit. */
export class CatalogPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogPayloadTooLargeError";
  }
}

/** Another creation request already committed a Project under this key; the caller replays it. */
export class ProjectCreationKeyTakenError extends Error {
  constructor() {
    super("A Project was already created with this idempotency key");
    this.name = "ProjectCreationKeyTakenError";
  }
}

/** A creation key is bound to a different request body. */
export class ProjectIdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key was used to create a different Project");
    this.name = "ProjectIdempotencyConflictError";
  }
}

/** The evaluation plan was locked by the first evaluating Run and can no longer be replaced. */
export class ProjectEvaluationPlanLockedError extends Error {
  constructor(readonly projectId: string) {
    super(`Project ${projectId} evaluation plan is locked`);
    this.name = "ProjectEvaluationPlanLockedError";
  }
}

/** A frozen Project Agent Config copy cannot be edited, deleted or selected again. */
export class AgentConfigFrozenError extends Error {
  constructor(readonly userAgentId: string) {
    super(`Agent Config ${userAgentId} is a frozen Project copy`);
    this.name = "AgentConfigFrozenError";
  }
}

/** An editable Agent Config keeps its execution/evaluation purpose for its entire lifetime. */
export class AgentConfigPurposeLockedError extends Error {
  constructor(readonly userAgentId: string) {
    super(`Agent Config ${userAgentId} purpose cannot be changed after creation`);
    this.name = "AgentConfigPurposeLockedError";
  }
}

/** A Project or evaluation plan selected an Agent whose immutable purpose is different. */
export class AgentConfigPurposeMismatchError extends Error {
  constructor(readonly userAgentId: string, readonly expected: AgentPurpose, readonly actual: AgentPurpose) {
    super(`Agent Config ${userAgentId} is an ${actual} Agent, but ${expected} is required`);
    this.name = "AgentConfigPurposeMismatchError";
  }
}

/** The immutable purpose cannot be reconciled from Eval's persisted record and the SP catalog. */
export class AgentConfigPurposeUnavailableError extends Error {
  constructor(readonly userAgentId?: string) {
    super(userAgentId
      ? `Agent Config ${userAgentId} purpose cannot be resolved from the Eval SP catalog`
      : "Agent Config purpose cannot be resolved from the Eval SP catalog");
    this.name = "AgentConfigPurposeUnavailableError";
  }
}

export type BundleResourceKind = "Material Bundle" | "Session Bundle" | "Material" | "Session";

export class BundleResourceNotFoundError extends Error {
  constructor(readonly kind: BundleResourceKind, readonly id: string) {
    super(`Unknown ${kind} ${id}`);
    this.name = "BundleResourceNotFoundError";
  }
}

export class BundleResourceInUseError extends Error {
  constructor(readonly kind: BundleResourceKind, readonly id: string) {
    super(`${kind} is still bound to Data: ${id}`);
    this.name = "BundleResourceInUseError";
  }
}

export class OutputSchemaNotFoundError extends Error {
  constructor(readonly outputSchemaId: string) {
    super(`Unknown output format ${outputSchemaId}`);
    this.name = "OutputSchemaNotFoundError";
  }
}

export class ProjectRunStopConflictError extends Error {
  constructor() {
    super("Project has no unfinished Run");
    this.name = "ProjectRunStopConflictError";
  }
}

export class ResultCollectionConflictError extends Error {
  constructor() { super("Only a failed stage with a completed Agent in a non-stopped Run can recollect results"); this.name = "ResultCollectionConflictError"; }
}
