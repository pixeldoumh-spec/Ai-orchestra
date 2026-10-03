import { NextResponse } from "next/server";
import { requireUser, getOrganizationForUser } from "@/lib/auth";
import { listAgents } from "@/lib/orchestrator/registry";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const orgId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, orgId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    return NextResponse.json({ organization: org, agents: await listAgents(org.id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
