import { NextResponse } from "next/server";
import { provisionOrgSchema } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDefaultAgents } from "@/lib/orchestrator/registry";

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const parsed = provisionOrgSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const db = createAdminClient();
    const { data: org, error: orgError } = await db.from("organizations").insert({ name: parsed.data.name, created_by: user.id }).select("id, name").single();
    if (orgError) return NextResponse.json({ error: orgError.message }, { status: 400 });
    const { error: memberError } = await db.from("organization_members").insert({ organization_id: org.id, user_id: user.id, role: "owner" });
    if (memberError) {
      await db.from("organizations").delete().eq("id", org.id);
      return NextResponse.json({ error: memberError.message }, { status: 400 });
    }
    await ensureDefaultAgents(org.id);
    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
