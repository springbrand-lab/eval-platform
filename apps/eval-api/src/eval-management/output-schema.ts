import { createHash } from "node:crypto";
import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import type { z } from "zod";
import { digest } from "../agent-imports/model.js";
import type { AppBindings } from "../lib/types.js";
import { parseEvaluationOutputSchema } from "../project-output-schema.js";
import type { createOutputSchemaSchema } from "./schemas.js";
import { ManagementOutcomeUnknownError } from "./skill.js";

type Input = z.output<typeof createOutputSchemaSchema>;
const conflict = () => new HttpError("EVAL_SP_CONFLICT", "Output Schema operation key or planned identity conflicts with the intent");

/** Same owner/key always plans the same UUID, including when two API instances begin concurrently. */
function plannedId(owner: string, key: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["management-output-schema/v1", owner, key])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // RFC 9562 version 8: custom SHA-256-derived UUID.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return platformIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`);
}

/** One existing owner-scoped catalog; durable operation stages fence any unproved INSERT. */
export async function createOutputSchema(c: Context<AppBindings>, input: Input) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR");
  const owner = c.var.user.id;
  const catalog = c.var.services.outputSchemas;
  // Validate *before* claiming a name or marking a write. This enforces OUTPUT_SCHEMA_BYTES
  // and the same strict JSON / draft 2020-12 validation as the ordinary catalog upload.
  const schema = parseEvaluationOutputSchema(input.content);
  const contentSha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
  const fingerprint = digest(["management-output-schema/v1", owner,
    input.operationKey, input.name, input.description, contentSha256]);
  const plan = {
    version: 1, outputSchemaId: plannedId(owner, input.operationKey),
    name: input.name, description: input.description, contentSha256,
  };
  const previous = await management.store.get(owner, input.operationKey);
  if (previous && (previous.kind !== "output_schema" || previous.fingerprint !== fingerprint)) throw conflict();
  // Name is display metadata, not a receipt or unique key: HTTP permits duplicate Schema names.
  await management.store.begin(owner, input.operationKey, "output_schema", fingerprint, plan);

  const verify = async () => {
    const saved = await catalog.get(plan.outputSchemaId);
    if (!saved) return null;
    if (saved.outputSchemaId !== plan.outputSchemaId || saved.name !== input.name
      || saved.description !== input.description || !equalJson(saved.schema, schema)) throw conflict();
    return { outputSchemaId: saved.outputSchemaId, name: saved.name };
  };
  try {
    const claim = await management.store.attempt(owner, input.operationKey, "output_schema");
    const receipt = await verify();
    if (claim.status === "confirmed") {
      if (!receipt || !equalJson(claim.receipt, receipt)) throw conflict();
      await management.store.complete(owner, input.operationKey);
      return receipt;
    }
    if (receipt) {
      // The previous INSERT committed but its confirmation/HTTP response was lost.
      await management.store.confirm(owner, input.operationKey, "output_schema", receipt);
      await management.store.complete(owner, input.operationKey);
      return receipt;
    }
    if (claim.status !== "started") throw new ManagementOutcomeUnknownError();

    // A persisted "attempted" stage exists before the first catalog write. If INSERT or
    // read-back fails, replay checks this planned ID; it never attempts a second write.
    try {
      await catalog.create({ name: input.name, description: input.description, content: input.content },
        plan.outputSchemaId);
    } catch {
      // A lost response after a committed insert can still be proven by the planned ID.
      const saved = await verify();
      if (!saved) throw new ManagementOutcomeUnknownError();
    }
    const saved = await verify();
    if (!saved) throw new ManagementOutcomeUnknownError();
    await management.store.confirm(owner, input.operationKey, "output_schema", saved);
    await management.store.complete(owner, input.operationKey);
    // Deliberately no Schema content, hash, description, URL or attachment bytes in MCP output.
    return saved;
  } catch (error) {
    if (error instanceof HttpError && error.code === "EVAL_SP_CONFLICT") throw error;
    // Even an unknown *receipt* or read-back must not become permission for another INSERT.
    throw new ManagementOutcomeUnknownError();
  }
}
