import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { softDeleteMemory } from "@/lib/knowledge/memory";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    const { id } = await context.params;
    return NextResponse.json({ memory: await softDeleteMemory(org.id, user.id, id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
