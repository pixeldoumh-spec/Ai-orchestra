import { NextResponse } from "next/server";

export async function GET() {
  const provider = process.env.AI_MODEL_PROVIDER ?? "mock";
  const workers = provider === "workers_ai" || provider === "cloudflare_workers_ai" || provider === "cloudflare-ai";
  return NextResponse.json({
    ok: true,
    service: "agent-orchestrator",
    version: "6.6.0",
    modelProvider: provider,
    plannerModel: process.env.AI_PLANNER_MODEL ?? (workers ? "@cf/openai/gpt-oss-20b" : "gpt-5.5"),
    agentModel: workers
      ? (process.env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b")
      : (process.env.OPENAI_MODEL ?? "gpt-5.4-mini"),
    verifierModel: process.env.AI_VERIFIER_MODEL
      ?? (workers ? "@cf/openai/gpt-oss-20b" : process.env.AI_PLANNER_MODEL ?? "gpt-5.5"),
    operations: {
      execution: "durable_background_queue",
      queue: "ai-orchestra-tasks-v66",
      deadLetterQueue: "ai-orchestra-tasks-v66-dlq",
      stream: "sse_replay",
      cronRedrive: "1m",
      fallbackEnabled: (process.env.AI_FALLBACK_ENABLED ?? "true") !== "false",
      fallbackProvider: process.env.AI_FALLBACK_PROVIDER ?? null,
      fallbackModel: process.env.AI_FALLBACK_MODEL ?? null,
    },
    workersAI: workers ? {
      model: process.env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b",
      freeDailyNeurons: 10_000,
      hostedGrounding: false,
      functionCalling: true,
      reasoning: true,
    } : null,
    tools: [
      "connector.http.get",
      "application_functions",
      "web_search_openai_only",
      "file_search_openai_only",
    ],
    timestamp: new Date().toISOString(),
  });
}
