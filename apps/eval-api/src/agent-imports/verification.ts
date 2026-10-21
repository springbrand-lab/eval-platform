import { createImportDownloads, type ImportStaging } from "./bytes.js";
import { ImportConflictError } from "./errors.js";
import type { ImportTask, PlannedResource } from "./model.js";
import { sameFiles } from "./semantics.js";
import type { AgentImportTarget } from "./target.js";
import type { Fetch } from "../sp/http.js";

/** Target bytes are read independently; a receipt does not prove there has been no later local edit. */
export function createImportVerification(input: { target: AgentImportTarget; staging: ImportStaging; fetch?: Fetch; heartbeat?: () => Promise<void> }) {
  const downloads = createImportDownloads({ origin: input.target.origin, purpose: "target", ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return async function verify(resource: PlannedResource, task: ImportTask): Promise<boolean> {
    if (task.ownerUserId !== input.target.ownerUserId) throw new ImportConflictError("Target owner mismatch");
    if (resource.kind === "skill") {
      const current = await input.target.skill(resource.id);
      if (!current) return false;
      if (current.name !== resource.name || current.origin !== (resource.platform ? "marketplace" : "upload")) {
        throw new ImportConflictError("Target Skill identity, kind or runtime name does not match");
      }
      if (new Set(current.files.map((file) => file.path)).size !== current.files.length) throw new ImportConflictError("Target Skill has duplicate file paths");
      const files = [];
      for (const file of current.files) {
        await input.heartbeat?.();
        files.push(await downloads.hash(file));
      }
      if (!sameFiles(resource.files, files)) throw new ImportConflictError("Target Skill content differs from the frozen manifest");
      return true;
    }
    if (resource.kind === "reference") {
      const current = await input.target.reference(resource.id);
      if (!current) return false;
      const source = resource.source;
      if (!("mediaType" in source) || current.status !== "active" || current.name !== source.name
        || current.size !== source.size || current.mediaType !== source.mediaType) {
        throw new ImportConflictError("Target Reference is unavailable or has different metadata");
      }
      await input.heartbeat?.();
      const file = await downloads.hash({ path: "reference", size: current.size, url: current.attachmentCdnUrl });
      if (file.sha256 !== resource.files[0]?.sha256) throw new ImportConflictError("Target Reference content differs from the frozen manifest");
      return true;
    }
    throw new TypeError("Agent verification belongs to AgentConfigService");
  };
}
