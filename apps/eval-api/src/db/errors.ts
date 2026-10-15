import { EVALUATION_SAMPLING_IDS } from "../limits.js";

/** A user-supplied catalog field (name, description, content, page size, reference) is invalid. */
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

/** An all-selection or explicit evaluation selection exceeds one admission request. */
export class EvaluationSelectionTooLargeError extends Error {
  constructor() {
    super(`Select at most ${EVALUATION_SAMPLING_IDS} Samplings per evaluation`);
    this.name = "EvaluationSelectionTooLargeError";
  }
}

export class DatasetInUseError extends Error {
  constructor(readonly datasetId: string) {
    super(`Dataset is still referenced: ${datasetId}`);
    this.name = "DatasetInUseError";
  }
}

export type BundleResourceKind = "Bundle" | "Material" | "Session";

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

export class OutputSchemaInUseError extends Error {
  constructor(readonly outputSchemaId: string) {
    super(`Output format is still bound to a Project: ${outputSchemaId}`);
    this.name = "OutputSchemaInUseError";
  }
}

export type ConfigReference = "Agent Config" | "Dataset" | "Dataset Sample" | "Execution Config" | "Evaluation Config";

/** A saved config would reference an entity outside its owner's scope. */
export class ConfigReferenceError extends Error {
  constructor(readonly reference: ConfigReference, readonly id: string) {
    super(`${reference} ${id} is outside the config owner scope or does not exist`);
    this.name = "ConfigReferenceError";
  }
}

export class ProjectRunStopConflictError extends Error {
  constructor() {
    super("Project has no unfinished Run");
    this.name = "ProjectRunStopConflictError";
  }
}
