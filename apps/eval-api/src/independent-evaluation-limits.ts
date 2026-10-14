/** One all-selection response must fit the corresponding explicit POST. */
export const MAX_EVALUATION_SAMPLING_IDS = 10_000;
export const MAX_EVALUATION_BODY_BYTES = 8 * 1024 * 1024;
/** Reserves space for the two 512-character request fields and JSON framing. */
export const MAX_SELECTION_RESPONSE_BYTES = MAX_EVALUATION_BODY_BYTES - 8 * 1024;

export class EvaluationSelectionTooLargeError extends Error {
  constructor() {
    super(`Select at most ${MAX_EVALUATION_SAMPLING_IDS} Samplings per evaluation`);
    this.name = "EvaluationSelectionTooLargeError";
  }
}
