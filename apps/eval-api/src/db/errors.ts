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
