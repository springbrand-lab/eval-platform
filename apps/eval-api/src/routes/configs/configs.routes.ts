import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { HarnessConfig, RetryPolicy } from "@eval-platform/eval-contracts";
import type { EvaluationConfig, EvaluationConfigInput, ExecutionConfig, PipelineConfig } from "@eval-platform/eval-runtime";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  entityIdSchema,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Runtime validates Harness and retry facts; the HTTP contract fixes only the envelope. */
const harnessSchema = z.custom<HarnessConfig>(isObject, "must be an object");
const evaluationHarnessSchema = z.custom<EvaluationConfigInput["evaluationHarness"]>(isObject, "must be an object");
const retryPolicySchema = z.custom<RetryPolicy>(isObject, "must be an object");

const executionConfigInputSchema = z.strictObject({
  datasetId: platformIdSchema,
  sampleIds: z.array(entityIdSchema).exactOptional(),
  harness: harnessSchema,
  samplingCount: z.number(),
  executionConcurrency: z.number(),
  retryPolicy: retryPolicySchema.exactOptional(),
});

const evaluationConfigInputSchema = z.strictObject({
  evaluationHarness: evaluationHarnessSchema,
  evaluationConcurrency: z.number(),
  retryPolicy: retryPolicySchema.exactOptional(),
});

const pipelineConfigInputSchema = z.strictObject({
  executionConfigId: entityIdSchema,
  evaluationConfigId: entityIdSchema,
});

function configRoutes<I extends z.ZodType, O extends z.ZodType>(path: string, kind: string, input: I, output: O) {
  const params = z.object({ configId: entityIdSchema });
  return {
    list: createRoute({
      method: "get",
      path,
      tags: ["Config"],
      summary: `List ${kind} configs`,
      responses: {
        200: jsonContent(responseSchema(z.array(output).readonly()), `${kind} configs`),
        ...errorResponses,
      },
    }),
    create: createRoute({
      method: "post",
      path,
      tags: ["Config"],
      summary: `Create a ${kind} config`,
      middleware: [jsonBody(JSON_BODY_BYTES)],
      request: { body: jsonBodyContent(input) },
      responses: {
        201: jsonContent(responseSchema(output), `Created ${kind} config`),
        ...bodyErrorResponses,
        ...conflictResponse,
      },
    }),
    get: createRoute({
      method: "get",
      path: `${path}/{configId}`,
      tags: ["Config"],
      summary: `Get a ${kind} config`,
      request: { params },
      responses: {
        200: jsonContent(responseSchema(output), `${kind} config`),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    replace: createRoute({
      method: "put",
      path: `${path}/{configId}`,
      tags: ["Config"],
      summary: `Replace a ${kind} config's editable fields`,
      middleware: [jsonBody(JSON_BODY_BYTES)],
      request: { params, body: jsonBodyContent(input) },
      responses: {
        200: jsonContent(responseSchema(output), `${kind} config`),
        ...bodyErrorResponses,
        ...notFoundResponse,
      },
    }),
  };
}

export const execution = configRoutes("/execution", "Execution", executionConfigInputSchema, z.custom<ExecutionConfig>());
export const evaluation = configRoutes("/evaluation", "Evaluation", evaluationConfigInputSchema, z.custom<EvaluationConfig>());
export const pipeline = configRoutes("/pipeline", "Pipeline", pipelineConfigInputSchema, z.custom<PipelineConfig>());
