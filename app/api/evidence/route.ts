import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { listTaskEvidence } from "@/lib/evidence/repository";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const params = new URL(request.url).searchParams;
    const organizationId = params.get("organizationId");
    const taskId = params.get("taskId");
    if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });

    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }

    return NextResponse.json({
      evidence: await listTaskEvidence(org.id, taskId),
    });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status },
    );
  }
}
