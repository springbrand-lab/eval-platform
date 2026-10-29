import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { inspectStrictZip, StrictZipError } from "@springbrand/eval-harness";
import type { Context } from "hono";
import { z } from "zod";
import { digest, IMPORT_LIMITS } from "../agent-imports/model.js";
import type { AppBindings } from "../lib/types.js";
import { AGENT_LIBRARY_ROUTES } from "../sp/agent-library.js";
import { collection, readLibrary, record } from "./common.js";
import { resourceIdSchema, type uploadAgentSkillSchema } from "./schemas.js";

type SkillInput = z.output<typeof uploadAgentSkillSchema>;
const skillRoute = AGENT_LIBRARY_ROUTES.find((item) => item.path === "/skills" && item.method === "post")!;
export class ManagementOutcomeUnknownError extends Error {
  constructor() { super("The management write has no confirmed receipt; inspect the original operation key, never replay it"); }
}
const conflict = () => new HttpError("EVAL_SP_CONFLICT", "Skill name or identity conflicts with the approved intent");

/** Use SP's public ZIP inspector; accept only an unambiguous, simple Skill name from SKILL.md. */
export async function skillNameFromZip(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  let markdown: Uint8Array | undefined;
  try {
    const { entries } = await inspectStrictZip(bytes, {
      entries: 500, maxEntryBytes: IMPORT_LIMITS.fileBytes, maxExpandedBytes: IMPORT_LIMITS.fileBytes,
      maxCompressionRatio: 1_000, pathCharacters: 240,
    }, (path) => path === "SKILL.md" ? { maxBytes: 64_000, message: "SKILL.md is too large" } : undefined, {
      ...(signal ? { signal } : {}),
      onEntry(entry) { if (entry.path === "SKILL.md") markdown = entry.bytes; },
    });
    if (!entries.some((entry) => entry.path === "SKILL.md" && !entry.directory) || !markdown) throw conflict();
  } catch (error) {
    if (error instanceof StrictZipError) throw new HttpError("REQUEST_INVALID_INPUT", "Skill ZIP is invalid or too large", { cause: error });
    throw error;
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(markdown); }
  catch { throw new HttpError("REQUEST_INVALID_INPUT", "SKILL.md must be UTF-8"); }
  const front = /^---\r?\n([\s\S]{0,4000}?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  if (!front) throw conflict();
  const names = front.split(/\r?\n/u).filter((line) => /^name\s*:/iu.test(line))
    .map((line) => /^name: ([a-z0-9][a-z0-9-]{0,119})$/u.exec(line)?.[1]);
  if (names.length !== 1 || !names[0]) throw conflict();
  return names[0];
}

/** Full bounded public catalog page scan; no first-page-only assumption about same-name overwrites. */
async function existingByName(c: Context<AppBindings>, name: string) {
  const matching: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, total } = collection(await readLibrary(c, "/skills",
      new URLSearchParams({ view: "selectable", page: String(page), pageSize: "50" })), 50);
    if (total > 500) throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Cannot safely inspect all Skill names");
    for (const item of data) if (typeof item.name === "string" && item.name.toLocaleLowerCase("en-US") === name) matching.push(item);
    if (page * 50 >= total) break;
  }
  if (matching.length > 1) throw conflict();
  return matching[0] ?? null;
}

async function confirmSkill(c: Context<AppBindings>, id: string, name: string) {
  const { data } = collection(await readLibrary(c, "/skills",
    new URLSearchParams({ view: "selected", ids: id, pageSize: "50" })), 50);
  if (data.length !== 1 || data[0]?.id !== id || data[0]?.name !== name
    || data[0]?.available !== true || data[0]?.deleted === true) throw conflict();
  return { skillId: id, name };
}

export async function uploadAgentSkill(c: Context<AppBindings>, input: SkillInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR");
  const owner = c.var.user.id;
  const metadata = await management.files.info(owner, input.uploadRef, "skill");
  const fingerprint = digest(["management-skill/v1", owner, input,
    { name: metadata.name, mediaType: metadata.mediaType, size: metadata.byteSize, sha256: metadata.sha256 }]);
  const previous = await management.store.get(owner, input.operationKey);
  if (previous && (previous.kind !== "skill" || previous.fingerprint !== fingerprint)) throw conflict();
  if (previous?.stages.skill?.status === "confirmed") {
    const receipt = previous.stages.skill.receipt as { skillId: string; name: string };
    const confirmed = await confirmSkill(c, receipt.skillId, receipt.name);
    await management.store.complete(owner, input.operationKey);
    return confirmed;
  }
  if (previous) throw new ManagementOutcomeUnknownError();

  const bytes = await management.files.read(owner, input.uploadRef, "skill");
  if (await skillNameFromZip(bytes, c.req.raw.signal) !== input.name) throw conflict();
  const existing = await existingByName(c, input.name);
  if (existing && (existing.origin !== "upload" || existing.deleted === true || existing.available !== true
    || resourceIdSchema.safeParse(existing.id).data !== input.existingSkillId)) throw conflict();
  if (!existing && input.existingSkillId) throw conflict();
  // Ordinary SP POST has no conditional create: even a "new" name might race a Web upload.
  // The trusted adapter must obtain *explicit possible-overwrite* approval before any Skill POST.
  if (!input.overwriteExistingSkill) throw conflict();
  const plan = { version: 1, uploadRef: input.uploadRef, name: input.name,
    existingSkillId: input.existingSkillId ?? null, sha256: metadata.sha256 };
  await management.store.begin(owner, input.operationKey, "skill", fingerprint, plan, input.name);
  const claim = await management.store.attempt(owner, input.operationKey, "skill");
  if (claim.status === "attempted") throw new ManagementOutcomeUnknownError();
  if (claim.status === "confirmed") {
    const receipt = claim.receipt as { skillId: string; name: string };
    const confirmed = await confirmSkill(c, receipt.skillId, receipt.name);
    await management.store.complete(owner, input.operationKey);
    return confirmed;
  }
  // After this write-ahead mark, no uncertain POST can ever be sent again, even after a restart.
  try {
    const outcome = record(await c.env.sp.requestAgentLibrary(c.var.sessionToken, {
      route: skillRoute, search: "", signal: c.req.raw.signal,
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    const id = resourceIdSchema.safeParse(outcome?.id).data;
    if (!id || outcome?.name !== input.name || input.existingSkillId && id !== input.existingSkillId) throw conflict();
    const receipt = await confirmSkill(c, id, input.name);
    await management.store.confirm(owner, input.operationKey, "skill", receipt);
    await management.store.complete(owner, input.operationKey);
    return receipt;
  } catch {
    throw new ManagementOutcomeUnknownError();
  }
}
