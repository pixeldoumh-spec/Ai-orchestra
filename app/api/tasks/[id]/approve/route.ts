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
    const approvalId = typeof input?.approvalId === "string" ? input.approvalId : "";
    if (!approvalId) return NextResponse.json({ error: "approvalId is required" }, { status: 400 });
    const decision = input?.decision === "reject" ? "rejected" : input?.decision === "approve" ? "approved" : null;
    if (!decision) return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });

    const admin = createAdminClient();
    const { data: approval, error } = await admin
      .from("approvals")
      .select("id, task_id, organization_id, step_id, status, expires_at")
      .eq("id", approvalId)
      .eq("task_id", id)
      .eq("organization_id", org.id)
      .single();
    if (error || !approval) return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    if (approval.status !== "pending") return NextResponse.json({ error: `Approval is already ${approval.status}` }, { status: 409 });
    if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now()) {
      await admin.from("approvals").update({ status: "expired", resolved_by: user.id, resolved_at: new Date().toISOString() }).eq("id", approvalId);
      return NextResponse.json({ error: "Approval expired" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin.from("approvals").update({ status: decision, resolved_by: user.id, resolved_at: now }).eq("id", approvalId).eq("status", "pending");
    if (approval.connector_request_id) {
      const { error: requestError } = await admin.from("connector_requests").update({ status: decision === "approved" ? "approved" : "denied", completed_at: now }).eq("id", approval.connector_request_id).in("status", ["prepared", "approved"]);
      if (requestError) throw new Error(requestError.message);
    }
    if (updateError) throw new Error(updateError.message);

    if (decision === "approved") {
      await admin.from("task_steps").update({ status: "queued", error: null, run_after: null }).eq("id", approval.step_id);
      await admin.from("tasks").update({ status: "queued", error: null, run_after: null }).eq("id", approval.task_id);
    } else {
      await admin.from("task_steps").update({ status: "failed", error: "Human rejected approval", finished_at: now }).eq("id", approval.step_id);
      await admin.from("tasks").update({ status: "failed", error: "Human rejected approval", completed_at: now }).eq("id", approval.task_id);
    }
    await appendEvent(id, org.id, "approval.resolved", { approvalId, decision }, user.id);
    return NextResponse.json({ ok: true, decision, approvalId, connectorRequestId: approval.connector_request_id ?? null });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}