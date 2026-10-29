import { createHmac, timingSafeEqual } from "node:crypto";
import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { createEvaluationResultValidator } from "@eval-platform/eval-metrics";
import type { EvaluationResultCheck, EvaluationResultPort } from "@eval-platform/eval-runtime";
import type { EvaluationSubmissionStore } from "../db/evaluation-submissions.js";
import { sameSecret } from "../lib/secret.js";

/** Per-Evaluation credential: one Agent Config serves many Evaluations, so the MCP Bearer token alone cannot tell them apart. */
export function evaluationSubmitToken(secret: string, evaluationId: string): string {
  return createHmac("sha256", secret).update(`submit:${evaluationId}`).digest("base64url");
}

export function verifyEvaluationSubmitToken(secret: string, evaluationId: string, token: string): boolean {
  const expected = Buffer.from(evaluationSubmitToken(secret, evaluationId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Metrics' validator in Runtime's terms; the MCP tool and the Worker reject exactly the same results. */
export function createEvaluationResultCheck(): (schema: EvaluationOutputSchema, content: string) => EvaluationResultCheck {
  const validate = createEvaluationResultValidator();
  return (schema, content) => {
    const result = validate(schema, content);
    if (result.status === "valid") return { valid: true, errors: [] };
    const errors = result.errors.map((error) => `${error.instancePath || "/"}: ${error.message}`);
    return { valid: false, errors: errors.length > 0 ? errors : [result.reason] };
  };
}

/** The Worker's result port; without a token Evaluators are not told about the tool. */
export function createEvaluationResultPort(input: {
  readonly store: Pick<EvaluationSubmissionStore, "read">;
  readonly token?: string;
}): EvaluationResultPort {
  const { store, token } = input;
  return {
    ...(token === undefined ? {} : { submission: {
      token: (evaluationId: string) => evaluationSubmitToken(token, evaluationId),
      read: (evaluationId: string) => store.read(evaluationId),
    } }),
    check: createEvaluationResultCheck(),
  };
}
