import type { AgentDefinition } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

export async function listAgents(organizationId: string): Promise<AgentDefinition[]> {
  const db = createAdminClient();
  const { data, error } = await db.from("agents").select("*").eq("organization_id", organizationId).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentDefinition[];
}

export async function ensureDefaultAgents(organizationId: string): Promise<void> {
  const db = createAdminClient();
  const { count, error } = await db.from("agents").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  if ((count ?? 0) > 0) return;

  const agents: Omit<AgentDefinition, "model">[] = [
    { id: "research", organizationId, name: "Research Agent", description: "Collects and structures inputs.", capabilities: ["research", "summarize"], permissions: ["context.read"], tools: ["time.now"], budgetCents: 100, status: "healthy", version: "2.0.0" },
    { id: "analysis", organizationId, name: "Analysis Agent", description: "Reasons over structured inputs.", capabilities: ["analysis", "reasoning"], permissions: ["context.read"], tools: [], budgetCents: 150, status: "healthy", version: "2.0.0" },
    { id: "writer", organizationId, name: "Writer Agent", description: "Creates the user-facing artifact.", capabilities: ["writing", "formatting"], permissions: ["context.read", "artifact.write"], tools: ["artifact.write"], budgetCents: 100, status: "healthy", version: "2.0.0" },
    { id: "verifier", organizationId, name: "Verifier Agent", description: "Checks completeness, consistency and unsupported claims.", capabilities: ["verification", "quality-control"], permissions: ["context.read", "artifact.read"], tools: [], budgetCents: 75, status: "healthy", version: "2.0.0" },
  ];
  const { error: insertError } = await db.from("agents").insert(agents);
  if (insertError) throw new Error(insertError.message);
}
