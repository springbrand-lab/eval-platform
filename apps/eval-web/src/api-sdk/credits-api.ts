import { api } from "./client";
import type { CreditBalance, CreditGrant, CreditGrantRecord } from "./types";

export const creditKeys = {
  balance: () => ["credits", "balance"] as const,
  grants: () => ["credits", "grants"] as const,
};

export const getCreditBalance = (signal?: AbortSignal) => api.get<CreditBalance>("/api/credits", { signal });
export const listCreditGrants = (limit = 50, signal?: AbortSignal) =>
  api.get<CreditGrantRecord[]>("/api/credits/grants", { params: { limit }, signal });
export const grantCredits = (input: { units: number; idempotencyKey: string; note?: string }) =>
  api.post<CreditGrant>("/api/credits/grants", input);
