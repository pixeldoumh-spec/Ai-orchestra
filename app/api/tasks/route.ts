import { NextResponse } from "next/server";
import { createTaskSchema } from "@/lib/api";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { normalizeIdempotencyKey } from "@/lib/core/idempotency";
import { createTask } from "@/lib/orchestrator/repository";
import { ensureDefaultAgents, listAgents } from "@/lib/orchestrator/registry";
import { planWorkflow } from "@/lib/orchestrator/planner";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const body = await request.json();
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const key = normalizeIdempotencyKey(request.headers.get("idempotency-key"));
    if (!key) return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });

    const org = await getOrganizationForUser(db, user.id, parsed.data.organizationId);
    if (!org) return NextResponse.json({ error: "Create or select an organization first" }, { status: 400 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) return NextResponse.json({ error: "Runtime execution permission is required" }, { status: 403 });
    await ensureDefaultAgents(org.id);
    const agents = await listAgents(org.id);
    const plan = await planWorkflow({ goal: parsed.data.goal, agents });
    const task = await createTask({
      organizationId: org.id,
      userId: user.id,
      goal: parsed.data.goal,
      idempotencyKey: key,
      maxCostCents: parsed.data.maxCostCents ?? 500,
      plan,
      plannerModel: process.env.AI_PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? null,
      teamId: parsed.data.teamId ?? null,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}