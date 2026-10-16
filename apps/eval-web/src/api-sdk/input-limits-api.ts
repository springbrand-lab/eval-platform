import type { EvalInputLimits } from "@eval-platform/eval-contracts";
import { api } from "./client";

export const inputLimitsKey = ["input-limits"] as const;
export const getInputLimits = (signal?: AbortSignal) => api.get<EvalInputLimits>("/api/input-limits", { signal });
