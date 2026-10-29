import type { SpPiTrajectoryPage } from "@eval-platform/eval-contracts";
import { api, enc } from "./client";
import type { AgentObservationRef } from "./types";

export type ObservedKind = "samplings" | "evaluations";

export interface WorkspaceTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly mime?: string;
  readonly size?: number;
  readonly updatedAt?: number;
  readonly children?: readonly WorkspaceTreeNode[];
}

/** Forward-only, frozen public SP Chat page, relayed unchanged by Eval API. */
export type TrajectoryPage = SpPiTrajectoryPage;

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
export const getTrajectoryPage = (projectId: string, kind: ObservedKind, id: string, afterSeq = 0,
  throughSeq?: number, signal?: AbortSignal) =>
  api.get<TrajectoryPage>(`${base(projectId, kind, id)}/trajectory`, {
    params: { afterSeq, limit: 100, ...(throughSeq === undefined ? {} : { throughSeq }) }, signal,
  });
export const getWorkspaceFile = (projectId: string, kind: ObservedKind, id: string, path: string, signal?: AbortSignal) =>
  api.blob(`${base(projectId, kind, id)}/file`, { params: { path }, signal, timeoutMs: 120_000 });

/** One Attempt's stored raw resource snapshot, as the JSON bytes the API streams. */
export const getResourceSnapshot = (projectId: string, kind: ObservedKind, id: string, attemptId: string) =>
  api.blob(`/api/projects/${enc(projectId)}/${kind}/${enc(id)}/attempts/${enc(attemptId)}/resource-snapshot`, { timeoutMs: 600_000 });
