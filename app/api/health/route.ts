import { NextResponse } from "next/server";

export async function GET() {
  const provider = process.env.AI_MODEL_PROVIDER ?? "mock";
  return NextResponse.json({
    ok: true,
    service: "agent-orchestrator",
    version: "6.2.0",
    modelProvider: provider,
    plannerModel: process.env.AI_PLANNER_MODEL ?? (provider === "workers_ai" ? "@cf/openai/gpt-oss-20b" : "gpt-5.5"),
    agentModel: provider === "workers_ai"
      ? (process.env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b")
      : (process.env.OPENAI_MODEL ?? "gpt-5.4-mini"),
    verifierModel: process.env.AI_VERIFIER_MODEL
      ?? (provider === "workers_ai" ? "@cf/openai/gpt-oss-20b" : process.env.AI_PLANNER_MODEL ?? "gpt-5.5"),
    workersAI: provider === "workers_ai"
      ? {
          model: process.env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b",
          freeDailyNeurons: 10_000,
          hostedGrounding: false,
          functionCalling: true,
          reasoning: true,
        }
      : null,
    tools: ["connector.http.get", "application_functions", "web_search_openai_only", "file_search_openai_only"],
    timestamp: new Date().toISOString(),
  });
}
