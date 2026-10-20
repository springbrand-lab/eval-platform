import { createAgentEditorClient, type AgentEditorRequest, type UserAgentConfigTemplate } from "@springbrand/agent-config-editor/client";
import { api } from "./client";
import { deleteWithConfirmation, isConfirmedAbsent } from "./delete-confirmation";

/** The shared editor sees public SP paths; Eval supplies only its authenticated, allowlisted gateway. */
const request: AgentEditorRequest = (path, options) => {
  const target = path.startsWith("/api/model-catalog")
    ? path.replace("/api/model-catalog", "/api/agent-library/models")
    : `/api/agent-library${path.slice("/api".length)}`;
  return api.request(target, options);
};

const editor = createAgentEditorClient(request);
export const agentEditorClient = {
  ...editor,
  skills: {
    ...editor.skills,
    removeSkill: (id: string) => deleteWithConfirmation(
      () => editor.skills.removeSkill(id),
      async () => {
        const { data } = await editor.skills.listSelectedSkills([id]);
        return data.length === 1 && data[0]!.id === id && data[0]!.deleted === true;
      },
      { id },
    ),
  },
  references: {
    ...editor.references,
    removeReference: (id: string) => deleteWithConfirmation(
      () => editor.references.removeReference(id),
      () => isConfirmedAbsent(() => editor.references.getReference(id), "EVAL_SP_NOT_FOUND"),
      { id },
    ),
  },
};
export const getAgentTemplate = (signal?: AbortSignal) => api.get<UserAgentConfigTemplate>("/api/agent-library/default-template", { signal });
export const agentLibraryKeys = {
  template: ["agent-library", "default-template"] as const,
  models: ["agent-library", "models"] as const,
};
