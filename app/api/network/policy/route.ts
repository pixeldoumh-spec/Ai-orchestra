import { NextResponse } from "next/server";
import { networkPolicySchema } from "@/lib/api";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { appendAuditLog } from "@/lib/enterprise/repository";
import { getNetworkPolicy, updateNetworkPolicy } from "@/lib/network/repository";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "network.read")) return NextResponse.json({ error: "Network read permission is required" }, { status: 403 });
    return NextResponse.json({ organization: org, policy: await getNetworkPolicy(org.id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const { db, user } = await requireUser();
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "network.manage")) return NextResponse.json({ error: "Network policy administration requires owner/admin role" }, { status: 403 });
    const parsed = networkPolicySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const policy = await updateNetworkPolicy(org.id, parsed.data);
    await appendAuditLog({
      organizationId: org.id,
      actorType: "user",
      actorId: user.id,
      action: "network.policy.update",
      resourceType: "agent_network_policy",
      resourceId: org.id,
      result: "success",
      metadata: {
        enabled: policy.enabled,
        allowDelegation: policy.allowDelegation,
        maxDelegationDepth: policy.maxDelegationDepth,
        maxHops: policy.maxHops,
        rateLimitPerMinute: policy.rateLimitPerMinute,
      },
    });
    return NextResponse.json({ policy });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
