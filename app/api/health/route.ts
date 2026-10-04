import { NextResponse } from "next/server";

export async function GET() {
  const provider = process.env.AI_MODEL_PROVIDER ?? "mock";
  return NextResponse.json({
    ok: true,
    service: "agent-orchestrator",
    version: "6.2.0",
    modelProvider: provider,
    plannerModel: process.env.AI_PLANNER_MODEL ?? "gpt-5.5",
    agentModel: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    verifierModel: process.env.AI_VERIFIER_MODEL ?? process.env.AI_PLANNER_MODEL ?? "gpt-5.5",
    tools: ["web_search", "file_search", "connector.http.get"],
    timestamp: new Date().toISOString(),
  });
}
