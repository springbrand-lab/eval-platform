import { z } from "zod";
import { identifierSchema } from "./identifier.js";

export const dashboardInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  projectIds: z.array(identifierSchema).min(2).refine((ids) => new Set(ids).size === ids.length, "Project IDs must be distinct"),
});

export const dashboardCreateSchema = dashboardInputSchema.extend({
  idempotencyKey: identifierSchema.max(200),
});

export const dashboardUpdateSchema = dashboardInputSchema.extend({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const dashboardSchema = dashboardInputSchema.extend({
  dashboardId: z.uuid().transform((value) => value.toLowerCase()),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type DashboardInput = z.output<typeof dashboardInputSchema>;
export type DashboardCreateInput = z.input<typeof dashboardCreateSchema>;
export type DashboardUpdateInput = z.input<typeof dashboardUpdateSchema>;
export type Dashboard = z.output<typeof dashboardSchema>;
