import { z } from "zod";

export const createTaskSchema = z.object({
  goal: z.string().trim().min(5).max(2000),
  organizationId: z.string().uuid().optional(),
  maxCostCents: z.number().int().min(0).max(1_000_000).optional(),
});

export const provisionOrgSchema = z.object({ name: z.string().trim().min(2).max(120) });
