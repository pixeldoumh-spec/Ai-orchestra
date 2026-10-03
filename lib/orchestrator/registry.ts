import type { AgentDefinition } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureAgentIdentity } from "./identity";

export async function listAgents(organizationId: string): Promise<AgentDefinition[]> {
  const db = createAdminClient();
  const { data, error } = await db.from("agents").select("*").eq("organization_id", organizationId).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    tools: Array.isArray(row.tools) ? row.tools : [],
    budgetCents: Number(row.budget_cents ?? 0),
    status: row.status,
    version: row.version,
    model: row.model ?? null,
  })) as AgentDefinition[];
}

export async function ensureDefaultAgents(organizationId: string): Promise<void> {
  const db = createAdminClient();
  const { count, error } = await db.from("agents").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  if (error) throw new Error(error.message);

  const agents = [
    { id: "research", organization_id: organizationId, name: "Research Agent", description: "Collects and structures inputs.", capabilities: ["research", "summarize"], permissions: ["context.read", "time.read"], tools: ["time.now"], budget_cents: 100, status: "healthy", version: "5.0.0" },
    { id: "analysis", organization_id: organizationId, name: "Analysis Agent", description: "Reasons over structured inputs.", capabilities: ["analysis", "reasoning"], permissions: ["context.read"], tools: [], budget_cents: 150, status: "healthy", version: "5.0.0" },
    { id: "writer", organization_id: organizationId, name: "Writer Agent", description: "Creates the user-facing result and optional artifact.", capabilities: ["writing", "formatting"], permissions: ["context.read", "artifact.write"], tools: ["artifact.write"], budget_cents: 100, status: "healthy", version: "5.0.0" },
    { id: "verifier", organization_id: organizationId, name: "Verifier Agent", description: "Checks completeness, consistency and unsupported claims.", capabilities: ["verification", "quality-control"], permissions: ["context.read", "artifact.read"], tools: [], budget_cents: 75, status: "healthy", version: "5.0.0" },
  ];
  if ((count ?? 0) === 0) {
    const { error: insertError } = await db.from("agents").insert(agents);
    if (insertError) throw new Error(insertError.message);
  }
  const { data: currentAgents, error: agentListError } = await db.from("agents").select("id").eq("organization_id", organizationId);
  if (agentListError) throw new Error(agentListError.message);
  await Promise.all((currentAgents ?? []).map((agent) => ensureAgentIdentity(organizationId, agent.id)));
}