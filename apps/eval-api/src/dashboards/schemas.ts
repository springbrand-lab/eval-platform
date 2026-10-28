import { dashboardCreateSchema, dashboardInputSchema, dashboardUpdateSchema } from "@eval-platform/eval-contracts";
import { z } from "@hono/zod-openapi";
import { COMPARISON_PROJECTS } from "../limits.js";
import { entityIdSchema, idempotencyKeySchema } from "../routes/schemas.js";

const projectIds = dashboardInputSchema.shape.projectIds.max(COMPARISON_PROJECTS).pipe(z.array(entityIdSchema));

export const dashboardCreateInputSchema = dashboardCreateSchema.extend({
  projectIds,
  idempotencyKey: dashboardCreateSchema.shape.idempotencyKey.pipe(idempotencyKeySchema),
});

export const dashboardUpdateInputSchema = dashboardUpdateSchema.extend({ projectIds });
