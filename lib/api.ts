import { z } from "zod";

export const createTaskSchema = z.object({
  goal: z.string().trim().min(5).max(2000),
  organizationId: z.string().uuid().optional(),
  maxCostCents: z.number().int().min(0).max(1_000_000).optional(),
});

export const provisionOrgSchema = z.object({ name: z.string().trim().min(2).max(120) });


export const connectorCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["reserved", "http"]),
  baseUrl: z.string().url().refine((value) => value.startsWith("https://"), "baseUrl must use HTTPS").nullable().optional(),
  authScheme: z.enum(["none", "bearer", "api_key", "hmac"]).default("none"),
  version: z.string().trim().min(1).max(40).default("1.0.0"),
  fallbackConnectorId: z.string().uuid().nullable().optional(),
});
export const connectorCredentialSchema = z.object({
  name: z.string().trim().min(2).max(120),
  secret: z.string().min(1).max(100000),
  scopes: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
  authScheme: z.enum(["none", "bearer", "api_key", "hmac"]),
  expiresAt: z.string().datetime().nullable().optional(),
});
export const connectorBindingSchema = z.object({
  agentId: z.string().min(1).max(120),
  credentialId: z.string().uuid().nullable().optional(),
  allowedTools: z.array(z.string().regex(/^[a-z][a-z0-9._-]{1,80}$/)).min(1).max(32),
  scopes: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
  priority: z.number().int().min(0).max(10000).default(100),
});
export const connectorStatusSchema = z.object({
  status: z.enum(["active", "degraded", "disabled"]),
});
