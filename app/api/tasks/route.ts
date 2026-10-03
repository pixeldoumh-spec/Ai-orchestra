import { NextResponse } from "next/server";
import { createTaskSchema } from "@/lib/api";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { normalizeIdempotencyKey } from "@/lib/core/idempotency";
import { createTask } from "@/lib/orchestrator/repository";
import { ensureDefaultAgents } from "@/lib/orchestrator/registry";

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
    await ensureDefaultAgents(org.id);
    const task = await createTask({ organizationId: org.id, userId: user.id, goal: parsed.data.goal, idempotencyKey: key, maxCostCents: parsed.data.maxCostCents ?? 500 });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
