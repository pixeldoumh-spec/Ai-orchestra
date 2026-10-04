import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentDefinition, ModelTool } from "@/lib/orchestrator/types";

export async function getHostedModelTools(
  organizationId: string,
  agent: AgentDefinition,
): Promise<ModelTool[]> {
  if ((process.env.AI_MODEL_PROVIDER ?? "mock").trim().toLowerCase() !== "openai") return [];

  const tools: ModelTool[] = [];
  if (agent.capabilities.includes("research") || agent.capabilities.includes("web-research")) {
    tools.push({
      type: "web_search",
      search_context_size:
        (process.env.AI_WEB_SEARCH_CONTEXT_SIZE as "low" | "medium" | "high" | undefined) ?? "medium",
    });
  }

  if (
    agent.capabilities.includes("research") ||
    agent.capabilities.includes("analysis") ||
    agent.capabilities.includes("writing")
  ) {
    const db = createAdminClient();
    const { data, error } = await db
      .from("organization_knowledge_bases")
      .select("external_vector_store_id,status")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.status === "active" && data.external_vector_store_id) {
      tools.push({
        type: "file_search",
        vector_store_ids: [data.external_vector_store_id],
        max_num_results: Math.min(
          50,
          Math.max(1, Number(process.env.AI_FILE_SEARCH_MAX_RESULTS ?? "8")),
        ),
      });
    }
  }

  return tools;
}
