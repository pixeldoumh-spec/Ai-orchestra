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
    { id: "research", organization_id: organizationId, name: "Research Agent", description: "Collects and structures inputs with live web and connector retrieval.", capabilities: ["research", "summarize", "web-research"], permissions: ["context.read", "time.read", "connector.read", "network.send", "network.receive", "network.ack"], tools: ["time.now", "connector.http.get", "agent.message.send", "agent.message.receive", "agent.message.ack"], budget_cents: 100, status: "healthy", version: "4.0.0" },
    { id: "analysis", organization_id: organizationId, name: "Analysis Agent", description: "Reasons over structured inputs and tenant knowledge.", capabilities: ["analysis", "reasoning"], permissions: ["context.read", "connector.read", "network.send", "network.receive", "network.ack"], tools: ["connector.http.get", "agent.message.send", "agent.message.receive", "agent.message.ack"], budget_cents: 150, status: "healthy", version: "4.0.0" },
    { id: "writer", organization_id: organizationId, name: "Writer Agent", description: "Creates the user-facing result from verified inputs and tenant knowledge.", capabilities: ["writing", "formatting"], permissions: ["context.read", "artifact.write", "connector.read", "network.send", "network.receive", "network.ack"], tools: ["artifact.write", "connector.http.get", "agent.message.send", "agent.message.receive", "agent.message.ack"], budget_cents: 100, status: "healthy", version: "4.0.0" },
    { id: "verifier", organization_id: organizationId, name: "Verifier Agent", description: "Checks completeness, consistency and unsupported claims.", capabilities: ["verification", "quality-control"], permissions: ["context.read", "artifact.read", "network.send", "network.receive", "network.ack"], tools: ["agent.message.send", "agent.message.receive", "agent.message.ack"], budget_cents: 75, status: "healthy", version: "4.0.0" },
  ];
  if ((count ?? 0) === 0) {
    const { error: insertError } = await db.from("agents").insert(agents);
    if (insertError) throw new Error(insertError.message);
  }
  for (const seed of agents) {
    const { data: existing, error: existingError } = await db.from("agents").select("id,permissions,tools").eq("organization_id", organizationId).eq("id", seed.id).maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (!existing) continue;
    const permissions = [...new Set([...(Array.isArray(existing.permissions) ? existing.permissions : []), ...seed.permissions])];
    const tools = [...new Set([...(Array.isArray(existing.tools) ? existing.tools : []), ...seed.tools])];
    if (permissions.length !== (Array.isArray(existing.permissions) ? existing.permissions.length : 0) || tools.length !== (Array.isArray(existing.tools) ? existing.tools.length : 0)) {
      const { error: syncError } = await db.from("agents").update({ permissions, tools }).eq("organization_id", organizationId).eq("id", seed.id);
      if (syncError) throw new Error(syncError.message);
    }
  }
  const { data: currentAgents, error: agentListError } = await db.from("agents").select("id").eq("organization_id", organizationId);
  if (agentListError) throw new Error(agentListError.message);
  await Promise.all((currentAgents ?? []).map((agent) => ensureAgentIdentity(organizationId, agent.id)));
}