import type { Context } from "hono";
import type { AppBindings } from "../lib/types.js";
import { createAgent } from "./agent.js";
import { inspectCase } from "./inspect.js";
import { getMetrics } from "./metrics.js";
import { listOptions } from "./options.js";
import { createOutputSchema } from "./output-schema.js";
import { prepareInputs, getPreparation } from "./preparation.js";
import { uploadAgentReference } from "./reference.js";
import { searchAgentResources } from "./resources.js";
import { createProject, getRun, previewRun, stopRun, submitRun } from "./runs.js";
import { managementSchemas as schemas } from "./schemas.js";
import { uploadAgentSkill } from "./skill.js";

/** Only the implemented management operations. An unknown name is rejected before this dispatcher. */
export function callTool(c: Context<AppBindings>, name: keyof typeof schemas, args: unknown): Promise<unknown> {
  switch (name) {
    case "list_options": return listOptions(c, schemas.list_options.parse(args));
    case "prepare_inputs": return prepareInputs(c, schemas.prepare_inputs.parse(args));
    case "get_preparation": {
      const { operationKey, page, pageSize } = schemas.get_preparation.parse(args);
      return getPreparation(c, operationKey, page, pageSize);
    }
    case "search_agent_resources": return searchAgentResources(c, schemas.search_agent_resources.parse(args));
    case "upload_agent_skill": return uploadAgentSkill(c, schemas.upload_agent_skill.parse(args));
    case "upload_agent_reference": return uploadAgentReference(c, schemas.upload_agent_reference.parse(args));
    case "create_output_schema": return createOutputSchema(c, schemas.create_output_schema.parse(args));
    case "create_agent": return createAgent(c, schemas.create_agent.parse(args));
    case "create_project": return createProject(c, schemas.create_project.parse(args));
    case "preview_run": return previewRun(c, schemas.preview_run.parse(args));
    case "submit_run": return submitRun(c, schemas.submit_run.parse(args));
    case "stop_run": return stopRun(c, schemas.stop_run.parse(args));
    case "get_run": return getRun(c, schemas.get_run.parse(args));
    case "get_metrics": return getMetrics(c, schemas.get_metrics.parse(args));
    case "inspect_case": return inspectCase(c, schemas.inspect_case.parse(args));
  }
  throw new TypeError("Unknown management tool");
}
