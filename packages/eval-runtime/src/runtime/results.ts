import {
  EVALUATION_FINAL_REPLY_PATH,
  EVALUATION_SUBMIT_TOOL,
} from "@eval-platform/eval-contracts";
import type {
  EvaluationAgentOutput,
  EvaluationOutputSchema,
  EvaluationStructuredOutput,
} from "@eval-platform/eval-contracts";

export interface EvaluationResultCheck {
  readonly valid: boolean;
  /** Human-readable reasons when invalid; empty when valid. */
  readonly errors: readonly string[];
}

/**
 * How Runtime learns an Evaluator's result. Metrics owns validation; the application owns the
 * submission tool and its storage. See docs/eval-evaluation-result-submission.md.
 */
export interface EvaluationResultPort {
  /** Present only when the submission tool is configured for Evaluators. */
  readonly submission?: {
    /** Per-Evaluation credential the Evaluator passes to the tool. */
    token(evaluationId: string): string;
    /** The latest valid result submitted through the tool, if any. */
    read(evaluationId: string): Promise<EvaluationStructuredOutput | undefined>;
  };
  check(schema: EvaluationOutputSchema, content: string): EvaluationResultCheck;
}

export const RESULT_NOT_SUBMITTED = "evaluation result not submitted";
export const RESULT_INVALID_PREFIX = "evaluation result invalid";

/** The Evaluator's closing instruction: hand the result to the platform, or write the file without the tool. */
export function resultInstruction(input: {
  readonly schemaPath: string;
  readonly resultPath: string;
  readonly submission?: { readonly evaluationId: string; readonly token: string };
}): string {
  const finalReply = `Also end your final reply with the same JSON value in one \`\`\`json code block.`;
  if (input.submission === undefined) {
    return `Finish by writing one JSON value to ${input.resultPath}, following the JSON Schema at ${input.schemaPath}. ${finalReply}`;
  }
  return `Finish by calling the ${EVALUATION_SUBMIT_TOOL} tool with evaluationId "${input.submission.evaluationId}", submitToken "${input.submission.token}" and result set to one JSON value following the JSON Schema at ${input.schemaPath}. Do not write a result file. If the tool rejects the result, correct it and call the tool again; do not re-evaluate. If the tool is unavailable, say so. ${finalReply}`;
}

/** The last fenced JSON block that parses, else the whole reply when it is JSON; the raw text is kept for Metrics. */
export function extractFinalReplyResult(reply: string): string | undefined {
  const blocks = [...reply.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!.trim()).reverse();
  for (const candidate of [...blocks, reply.trim()]) {
    if (candidate === "") continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return undefined;
}

/** Prefers a submitted result, then SP's result file, then the final reply; never invents one. */
export async function resolveEvaluationResult(input: {
  readonly port: EvaluationResultPort;
  readonly evaluationId: string;
  readonly output: EvaluationAgentOutput;
  readonly readFinalReply: () => Promise<string | undefined>;
}): Promise<EvaluationAgentOutput> {
  const submitted = await input.port.submission?.read(input.evaluationId);
  if (submitted) return { ...input.output, structuredOutput: { ...submitted, source: "submission" } };
  const file = input.output.structuredOutput;
  if (file) return { ...input.output, structuredOutput: { ...file, source: file.source ?? "result-file" } };
  const reply = await input.readFinalReply();
  const content = reply === undefined ? undefined : extractFinalReplyResult(reply);
  if (content === undefined) return input.output;
  return { ...input.output, structuredOutput: { path: EVALUATION_FINAL_REPLY_PATH, content, source: "final-reply" } };
}

/** Why an output cannot make the Evaluation succeed, or undefined when its result is valid. */
export function evaluationResultFailure(
  port: EvaluationResultPort,
  schema: EvaluationOutputSchema,
  output: EvaluationAgentOutput,
): string | undefined {
  const result = output.structuredOutput;
  if (!result) return RESULT_NOT_SUBMITTED;
  const check = port.check(schema, result.content);
  if (check.valid) return undefined;
  return `${RESULT_INVALID_PREFIX} (${result.source ?? "result-file"}): ${check.errors.join("; ") || "does not match the output Schema"}`;
}
