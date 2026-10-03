import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent } from "@/lib/orchestrator/repository";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    const input = await request.json().catch(() => ({}));
    const decision = input?.decision === "reject" ? "rejected" : "approved";
    const admin = createAdminClient();
    const { data: approval, error } = await admin.from("approvals").select("id, task_id, step_id, status").eq("task_id", id).eq("organization_id", org.id).eq("status", "pending").order("created_at", { ascending: false }).limit(1).single();
    if (error) return NextResponse.json({ error: "No pending approval" }, { status: 404 });
    await admin.from("approvals").update({ status: decision, resolved_by: user.id, resolved_at: new Date().toISOString() }).eq("id", approval.id);
    if (decision === "approved") {
      await admin.from("task_steps").update({ status: "queued" }).eq("id", approval.step_id);
      await admin.from("tasks").update({ status: "queued", error: null }).eq("id", approval.task_id);
    } else {
      await admin.from("task_steps").update({ status: "failed", error: "Human rejected approval" }).eq("id", approval.step_id);
      await admin.from("tasks").update({ status: "failed", error: "Human rejected approval", completed_at: new Date().toISOString() }).eq("id", approval.task_id);
    }
    await appendEvent(id, org.id, "approval.resolved", { approvalId: approval.id, decision, resolvedBy: user.id });
    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
