import type { AgentImportPreview, AgentImportTaskView } from "@eval-platform/eval-contracts";
import type { ImportIntent, ImportPlan, ImportReceipt, ImportTask, PlannedResource, ResourceKind, SourceSnapshot } from "./model.js";
import type { ResourceSourceStore } from "../db/agent-import-sources.js";
import type { TargetAttachment } from "./target.js";

export interface AgentImportStore {
  readonly sources: ResourceSourceStore;
  create(request: AgentImportPreview, connectionId: string, actorId?: string): Promise<ImportTask>;
  get(taskId: string): Promise<ImportTask | null>;
  apply(taskId: string, idempotencyKey: string): Promise<ImportTask>;
  claim(taskId: string, token: string): Promise<ImportTask | null>;
  heartbeat(task: ImportTask): Promise<void>;
  save(task: ImportTask, update: {
    view?: AgentImportTaskView; snapshot?: SourceSnapshot; plan?: ImportPlan;
  }): Promise<void>;
  release(task: ImportTask): Promise<void>;
  intent(kind: ResourceKind, id: string): Promise<ImportIntent | null>;
  markIntent(task: ImportTask, resource: PlannedResource, status: ImportIntent["status"], receipt?: ImportReceipt, error?: string): Promise<void>;
  saveAttachment(task: ImportTask, resource: PlannedResource, attachment: TargetAttachment): Promise<void>;
  complete(task: ImportTask, resource: PlannedResource, receipt: ImportReceipt | null): Promise<void>;
}
