import { errorDefinitions } from "@springbrand/contracts/errors";
import { agentConfigDeletionCheckSchema } from "@springbrand/contracts/agent-config-deletion";

/** Public SP errors whose corrective actions belong to the shared Agent editor. */
export const spEditorErrorDefinitions = {
  AGENT_CONFIG_INVALID: errorDefinitions.AGENT_CONFIG_INVALID,
  AGENT_CONFIG_CONFLICT: errorDefinitions.AGENT_CONFIG_CONFLICT,
  AGENT_CONFIG_ACTIVE_CHAT: errorDefinitions.AGENT_CONFIG_ACTIVE_CHAT,
  AGENT_CONFIG_ACTIVE_SCHEDULE_RUN: errorDefinitions.AGENT_CONFIG_ACTIVE_SCHEDULE_RUN,
  AGENT_CONFIG_ENABLED_SCHEDULE: errorDefinitions.AGENT_CONFIG_ENABLED_SCHEDULE,
  MODEL_ACCESS_DENIED: errorDefinitions.MODEL_ACCESS_DENIED,
  CONNECTOR_UNAVAILABLE: errorDefinitions.CONNECTOR_UNAVAILABLE,
  CONNECTOR_REQUEST_INVALID: errorDefinitions.CONNECTOR_REQUEST_INVALID,
  MCP_CONNECTION_UNAVAILABLE: errorDefinitions.MCP_CONNECTION_UNAVAILABLE,
  UPLOAD_INVALID: errorDefinitions.UPLOAD_INVALID,
  UPLOAD_FILE_REQUIRED: errorDefinitions.UPLOAD_FILE_REQUIRED,
  UPLOAD_FILE_KEY_INVALID: errorDefinitions.UPLOAD_FILE_KEY_INVALID,
  UPLOAD_FILE_NOT_FOUND: errorDefinitions.UPLOAD_FILE_NOT_FOUND,
  UPLOAD_FILE_TOO_LARGE: errorDefinitions.UPLOAD_FILE_TOO_LARGE,
  UPLOAD_FILE_TYPE_UNSUPPORTED: errorDefinitions.UPLOAD_FILE_TYPE_UNSUPPORTED,
};

export const spEditorErrorDetails = {
  AGENT_CONFIG_ACTIVE_CHAT: agentConfigDeletionCheckSchema,
  AGENT_CONFIG_ACTIVE_SCHEDULE_RUN: agentConfigDeletionCheckSchema,
  AGENT_CONFIG_ENABLED_SCHEDULE: agentConfigDeletionCheckSchema,
};

export function isSpEditorErrorCode(value: unknown): value is keyof typeof spEditorErrorDefinitions {
  return typeof value === "string" && Object.hasOwn(spEditorErrorDefinitions, value);
}
