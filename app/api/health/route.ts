import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "agent-orchestrator",
    version: "2.0.0",
    modelProvider: process.env.AI_MODEL_PROVIDER ?? "mock",
    timestamp: new Date().toISOString(),
  });
}
