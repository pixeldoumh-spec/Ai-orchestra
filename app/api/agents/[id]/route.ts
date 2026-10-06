import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDefaultAgents, listAgents } from "@/lib/orchestrator/registry";

function normalizeCapabilities(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 24))];
}

function inferCapabilities(text: string, existing: string[]) {
  const lower = text.toLowerCase();
  const additions: string[] = [];
  const groups: [string, string[]][] = [
    ["research", ["research", "investigate", "sources", "evidence", "web"]],
    ["analysis", ["analy", "reason", "compare", "strategy", "evaluate"]],
    ["writing", ["write", "writer", "report", "draft", "summarize", "content"]],
    ["coding", ["code", "coding", "developer", "programming", "debug"]],
    ["data", ["data", "sql", "dataset", "analytics", "spreadsheet"]],
    ["vision", ["image", "vision", "visual"]],
  ];
  for (const [capability, words] of groups) {
    if (words.some((word) => lower.includes(word))) additions.push(capability);
  }
  return [...new Set([...existing, ...additions])].slice(0, 24);
}

function inferBudget(text: string, fallback: number) {
  const match = text.match(/(?:budget|limit|under|below)\s*[^0-9]{0,18}([0-9]{1,6})\s*(?:cents?|¢)?/i);
  const value = match ? Number(match[1]) : fallback;
  return Number.isFinite(value) ? Math.min(1_000_000, Math.max(0, Math.round(value))) : fallback;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    const agents = await listAgents(org.id);
    const agent = agents.find((item) => item.id === id);
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    return NextResponse.json({ agent });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "enterprise.manage")) {
      return NextResponse.json({ error: "Agent configuration requires workspace admin access" }, { status: 403 });
    }

    await ensureDefaultAgents(org.id);
    const agents = await listAgents(org.id);
    const current = agents.find((item) => item.id === id);
    if (!current) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const naturalLanguage = typeof body.naturalLanguage === "string" ? body.naturalLanguage.trim().slice(0, 2000) : "";
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : current.description;
    const requestedName = typeof body.name === "string" ? body.name.trim().slice(0, 120) : current.name;
    const capabilities = normalizeCapabilities(body.capabilities ?? inferCapabilities(naturalLanguage, current.capabilities));
    const budgetCents = naturalLanguage ? inferBudget(naturalLanguage, current.budgetCents) : Math.min(1_000_000, Math.max(0, Number(body.budgetCents ?? current.budgetCents)));

    if (naturalLanguage && naturalLanguage.length > 0 && description === current.description) {
      // Keep the administrator's natural-language intent visible without granting new permissions or tools.
      const cappedDescription = naturalLanguage.length <= 2000 ? naturalLanguage : naturalLanguage.slice(0, 2000);
      const db = createAdminClient();
      const { data, error } = await db.from("agents").update({
        name: requestedName || current.name,
        description: cappedDescription,
        capabilities,
        budget_cents: budgetCents,
        updated_at: new Date().toISOString(),
      }).eq("organization_id", org.id).eq("id", id).select("*").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ agent: data, interpretation: { description: cappedDescription, capabilities, budgetCents } });
    }

    const dbAdmin = createAdminClient();
    const { data, error } = await dbAdmin.from("agents").update({
      name: requestedName || current.name,
      description: description || current.description,
      capabilities,
      budget_cents: budgetCents,
      updated_at: new Date().toISOString(),
    }).eq("organization_id", org.id).eq("id", id).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ agent: data, interpretation: { description: description || current.description, capabilities, budgetCents } });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
