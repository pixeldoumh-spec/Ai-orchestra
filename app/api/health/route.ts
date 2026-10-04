import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const provider = process.env.AI_MODEL_PROVIDER ?? "mock";
  const workersAI = provider === "workers_ai" || provider === "cloudflare_workers_ai" || provider === "cloudflare-ai";
  return NextResponse.json({
    ok: true,
    service: "agent-orchestrator",
    version: "6.6.0",
    modelProvider: provider,
    plannerModel: process.env.AI_PLANNER_MODEL ?? (workersAI ? "@cf/openai/gpt-oss-20b" : "gpt-5.5"),
    agentModel: workersAI
      ? (process.env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b")
      : (process.env.OPENAI_MODEL ?? "gpt-5.4-mini"),
    verifierModel: process.env.AI_VERIFIER_MODEL
      ?? (workersAI ? "@cf/openai/gpt-oss-20b" : process.env.AI_PLANNER_MODEL ?? "gpt-5.5"),
    fallback: {
      enabled: (process.env.AI_FALLBACK_ENABLED ?? "true").trim().toLowerCase() !== "false",
      provider: process.env.AI_FALLBACK_PROVIDER ?? null,
      model: process.env.AI_FALLBACK_MODEL ?? null,
    },
    productionOperations: {
      streaming: true,
      backgroundQueue: "ai-orchestra-tasks-v66",
      deadLetterQueue: "ai-orchestra-tasks-v66-dlq",
      backgroundWorker: "ai-orchestra-background",
      cron: "* * * * *",
      telemetry: true,
      usageDashboard: true,
    },
    tools: ["connector.http.get", "application_functions", "web_search_openai_only", "file_search_openai_only"],
    timestamp: new Date().toISOString(),
  });
}
