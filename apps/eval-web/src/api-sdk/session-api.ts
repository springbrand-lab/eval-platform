import { api } from "./client";
import type { Me } from "./types";

export const meKey = ["me"] as const;
export const getMe = (signal?: AbortSignal) => api.get<Me>("/api/me", { signal });
