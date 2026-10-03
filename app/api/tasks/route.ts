import { NextResponse } from "next/server";
import { executeGoal } from "@/lib/orchestrator/orchestrator";
import { listAgents, listTasks } from "@/lib/orchestrator/store";
import "@/lib/agents/demo-agents";

export async function GET() {
  return NextResponse.json({ agents: listAgents(), tasks: listTasks() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  const task = await executeGoal(goal);
  return NextResponse.json(task, { status: 201 });
}
