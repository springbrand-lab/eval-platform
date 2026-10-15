import { api, enc } from "./client";
import type { AgentObservationRef } from "./types";

export type ObservedKind = "samplings" | "evaluations";

export interface WorkspaceTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly mime?: string;
  readonly size?: number;
  readonly updatedAt?: string;
  readonly children?: readonly WorkspaceTreeNode[];
}

export interface TrajectoryEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly submissionId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

export interface TrajectoryPage {
  readonly events: readonly { readonly ingestSeq: number; readonly event: TrajectoryEvent }[];
  readonly beforeSeq: number | null;
  readonly hasOlder: boolean;
}

export const observationKeys = {
  ref: (projectId: string, kind: ObservedKind, id: string) => ["observation", projectId, kind, id, "ref"] as const,
  part: (projectId: string, kind: ObservedKind, id: string, part: string) => ["observation", projectId, kind, id, part] as const,
};

const base = (projectId: string, kind: ObservedKind, id: string) => `/api/projects/${enc(projectId)}/${kind}/${enc(id)}/observation`;

export const getObservationRef = (projectId: string, kind: ObservedKind, id: string, signal?: AbortSignal) =>
  api.get<AgentObservationRef>(base(projectId, kind, id), { signal });
export const getMessages = (projectId: string, kind: ObservedKind, id: string, signal?: AbortSignal) =>
  api.get<unknown[]>(`${base(projectId, kind, id)}/messages`, { signal });
export const getWorkspaceTree = (projectId: string, kind: ObservedKind, id: string, signal?: AbortSignal) =>
  api.get<WorkspaceTreeNode[]>(`${base(projectId, kind, id)}/tree`, { signal });
export const getTrajectoryPage = (projectId: string, kind: ObservedKind, id: string, beforeSeq?: number, signal?: AbortSignal) =>
  api.get<TrajectoryPage>(`${base(projectId, kind, id)}/trajectory`, { params: { limit: 100, ...(beforeSeq ? { beforeSeq } : {}) }, signal });
export const getWorkspaceFile = (projectId: string, kind: ObservedKind, id: string, path: string, signal?: AbortSignal) =>
  api.blob(`${base(projectId, kind, id)}/file`, { params: { path }, signal, timeoutMs: 120_000 });
