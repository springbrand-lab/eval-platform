import { dashboardCreateSchema, dashboardDataExclusionsSchema, dashboardInputSchema, dashboardUpdateSchema } from "@eval-platform/eval-contracts";
import { z } from "@hono/zod-openapi";
import { COMPARISON_PROJECTS, RUN_TARGET_IDS } from "../limits.js";
import { entityIdSchema, idempotencyKeySchema } from "../routes/schemas.js";

const projectIds = dashboardInputSchema.shape.projectIds.max(COMPARISON_PROJECTS).pipe(z.array(entityIdSchema));
const excludedDataIds = dashboardDataExclusionsSchema.max(RUN_TARGET_IDS).pipe(z.array(entityIdSchema)).optional();

export const dashboardCreateInputSchema = dashboardCreateSchema.extend({
  projectIds,
  excludedDataIds,
  idempotencyKey: dashboardCreateSchema.shape.idempotencyKey.pipe(idempotencyKeySchema),
});

export const dashboardUpdateInputSchema = dashboardUpdateSchema.extend({ projectIds, excludedDataIds });
