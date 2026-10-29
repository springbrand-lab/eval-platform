import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import { z } from "zod";
import { createImportDownloads } from "../agent-imports/bytes.js";
import { digest } from "../agent-imports/model.js";
import type { AppBindings } from "../lib/types.js";
import { AGENT_LIBRARY_ROUTES } from "../sp/agent-library.js";
import { collection, readLibrary, record } from "./common.js";
import { ManagementOutcomeUnknownError } from "./skill.js";
import type { uploadAgentReferenceSchema } from "./schemas.js";

type ReferenceInput = z.output<typeof uploadAgentReferenceSchema>;
const attachmentRoute = AGENT_LIBRARY_ROUTES.find((item) => item.path === "/inbox/attachments" && item.method === "post")!;
const referenceRoute = AGENT_LIBRARY_ROUTES.find((item) => item.path === "/user-references" && item.method === "post")!;
const attachmentSchema = z.strictObject({
  attachmentCdnUrl: z.url(), clientAttachmentId: platformIdSchema,
  name: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(),
});
const referenceSchema = z.object({
  id: platformIdSchema, name: z.string(), mediaType: z.string(),
  size: z.number().int().nonnegative(), status: z.literal("active"), attachmentCdnUrl: z.url(),
});
const conflict = () => new HttpError("EVAL_SP_CONFLICT", "Reference does not match its staged attachment");

function validatedAttachment(c: Context<AppBindings>, value: unknown, plannedId: string,
  name: string, mediaType: string, size: number) {
  const parsed = attachmentSchema.safeParse(value);
  if (!parsed.success || parsed.data.clientAttachmentId !== plannedId
    || parsed.data.name !== name || parsed.data.mediaType !== mediaType || parsed.data.size !== size) throw conflict();
  const address = new URL(parsed.data.attachmentCdnUrl);
  try {
    createImportDownloads({ origin: c.env.evalManagement!.spOrigin, purpose: "target" }).validateUrl(address.href);
  } catch { throw conflict(); }
  if (address.search || address.hash || address.pathname !== `/uploads/v1/${c.var.user.id}/${plannedId}`) throw conflict();
  return parsed.data;
}

async function verifyReference(c: Context<AppBindings>, value: unknown,
  attachment: z.output<typeof attachmentSchema>) {
  const parsed = referenceSchema.safeParse(value);
  if (!parsed.success || parsed.data.name !== attachment.name || parsed.data.mediaType !== attachment.mediaType
    || parsed.data.size !== attachment.size || parsed.data.attachmentCdnUrl !== attachment.attachmentCdnUrl) throw conflict();
  const detail = referenceSchema.safeParse(await readLibrary(c, "/user-references/{id}", new URLSearchParams(), parsed.data.id));
  if (!detail.success || !equalReference(detail.data, parsed.data)) throw conflict();
  return { referenceId: parsed.data.id, name: parsed.data.name };
}

function equalReference(left: z.output<typeof referenceSchema>, right: z.output<typeof referenceSchema>) {
  return left.id === right.id && left.name === right.name && left.mediaType === right.mediaType
    && left.size === right.size && left.status === right.status && left.attachmentCdnUrl === right.attachmentCdnUrl;
}

/** A read-only recovery by the already confirmed, private, unique attachment identity. No create/delete retry. */
async function findReference(c: Context<AppBindings>, attachment: z.output<typeof attachmentSchema>) {
  const matches: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, total } = collection(await readLibrary(c, "/user-references",
      new URLSearchParams({ page: String(page), pageSize: "50" })), 50);
    if (total > 500) throw new ManagementOutcomeUnknownError();
    for (const item of data) if (item.attachmentCdnUrl === attachment.attachmentCdnUrl) matches.push(item);
    if (page * 50 >= total) break;
  }
  if (matches.length > 1) throw conflict();
  return matches.length ? verifyReference(c, matches[0], attachment) : null;
}

export async function uploadAgentReference(c: Context<AppBindings>, input: ReferenceInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR");
  const owner = c.var.user.id;
  const metadata = await management.files.info(owner, input.uploadRef, "reference");
  const fingerprint = digest(["management-reference/v1", owner, input,
    { name: metadata.name, mediaType: metadata.mediaType, size: metadata.byteSize, sha256: metadata.sha256 }]);
  const previous = await management.store.get(owner, input.operationKey);
  if (previous && (previous.kind !== "reference" || previous.fingerprint !== fingerprint)) throw conflict();
  const plan = previous?.plan as { version: 1; clientAttachmentId: string } | undefined;
  const clientAttachmentId = plan?.clientAttachmentId ?? crypto.randomUUID();
  if (!platformIdSchema.safeParse(clientAttachmentId).success) throw conflict();
  const initialBytes = previous ? null : await management.files.read(owner, input.uploadRef, "reference");
  if (!previous) await management.store.begin(owner, input.operationKey, "reference", fingerprint,
    { version: 1, clientAttachmentId, uploadRef: input.uploadRef });

  const savedAttachment = (await management.store.get(owner, input.operationKey))!.stages.attachment;
  let attachment: z.output<typeof attachmentSchema>;
  if (savedAttachment?.status === "confirmed") {
    attachment = validatedAttachment(c, savedAttachment.receipt, clientAttachmentId,
      metadata.name, metadata.mediaType, metadata.byteSize);
  } else {
    // Fetch and hash the staged bytes *before* the irreversible attachment write-ahead mark.
    if (savedAttachment) throw new ManagementOutcomeUnknownError();
    const bytes = initialBytes ?? await management.files.read(owner, input.uploadRef, "reference");
    const claim = await management.store.attempt(owner, input.operationKey, "attachment");
    if (claim.status !== "started") throw new ManagementOutcomeUnknownError();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: metadata.mediaType }), metadata.name);
    form.append("name", metadata.name);
    form.append("clientAttachmentId", clientAttachmentId);
    try {
      attachment = validatedAttachment(c, await c.env.sp.requestAgentLibrary(c.var.sessionToken, {
        route: attachmentRoute, search: "", body: form, signal: c.req.raw.signal,
      }), clientAttachmentId, metadata.name, metadata.mediaType, metadata.byteSize);
      await management.store.confirm(owner, input.operationKey, "attachment", attachment);
    } catch {
      throw new ManagementOutcomeUnknownError();
    }
  }

  const savedReference = (await management.store.get(owner, input.operationKey))!.stages.reference;
  // A read failure cannot strand an operation that has not attempted its Reference POST yet.
  if (!savedReference && await findReference(c, attachment)) throw conflict();
  const claim = await management.store.attempt(owner, input.operationKey, "reference");
  if (claim.status === "confirmed") {
    const receipt = claim.receipt as { referenceId: string; name: string };
    const current = await readLibrary(c, "/user-references/{id}", new URLSearchParams(), receipt.referenceId);
    const verified = await verifyReference(c, current, attachment);
    if (verified.referenceId !== receipt.referenceId || verified.name !== receipt.name) throw conflict();
    await management.store.complete(owner, input.operationKey);
    return verified;
  }
  if (claim.status === "attempted") {
    const recovered = await findReference(c, attachment);
    if (!recovered) throw new ManagementOutcomeUnknownError();
    await management.store.confirm(owner, input.operationKey, "reference", recovered);
    await management.store.complete(owner, input.operationKey);
    return recovered;
  }
  try {
    const result = record(await c.env.sp.requestAgentLibrary(c.var.sessionToken, {
      route: referenceRoute, search: "", body: attachment, signal: c.req.raw.signal,
    }));
    const receipt = await verifyReference(c, result, attachment);
    await management.store.confirm(owner, input.operationKey, "reference", receipt);
    await management.store.complete(owner, input.operationKey);
    // Do not delete the temporary upload: an unknown SP outcome must never lose Reference content.
    return receipt;
  } catch {
    throw new ManagementOutcomeUnknownError();
  }
}
