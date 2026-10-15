import { requireSourceCommit } from "@eval-platform/eval-runtime";

/** Immutable SP source selected before deploying the independent Eval SP. */
export interface EvalSpRelease {
  readonly sourceBranch: string;
  readonly sourceCommit: string;
}

export function requireEvalSpRelease(release: EvalSpRelease): EvalSpRelease {
  if (!release.sourceBranch || release.sourceBranch.trim() !== release.sourceBranch) {
    throw new TypeError("sourceBranch must be a nonblank Git branch name");
  }
  return { sourceBranch: release.sourceBranch, sourceCommit: requireSourceCommit(release.sourceCommit) };
}
