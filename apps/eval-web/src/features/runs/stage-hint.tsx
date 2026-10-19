import type { SamplingStageState } from "@eval-platform/eval-contracts";
import { stagePendingHint, type StageKind } from "./run-status";

export function StageHint({ stage, state }: { stage: StageKind; state: SamplingStageState }) {
  const hint = stagePendingHint(stage, state);
  if (!hint) return null;
  const detail = state.resourcesPending?.lastError ?? state.observationPending?.lastError;
  return <span data-testid="stage-hint" title={detail} className="text-[11px] text-text-muted">{hint}</span>;
}
