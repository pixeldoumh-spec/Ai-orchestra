import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export async function requireUser(): Promise<{ db: Db; user: { id: string; email?: string } }> {
  const db = await createClient();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new Response("Unauthorized", { status: 401 });
  return { db, user: { id: data.user.id, email: data.user.email } };
}

export async function getOrganizationForUser(db: Db, userId: string, requestedId?: string | null) {
  let query = db.from("organization_members").select("organization_id, role, organizations(id, name)").eq("user_id", userId).order("created_at", { ascending: true }).limit(20);
  if (requestedId) query = query.eq("organization_id", requestedId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const first = data?.[0] as { organization_id: string; role: string; organizations?: { id: string; name: string } | null } | undefined;
  if (!first?.organizations) return null;
  return { id: first.organization_id, name: first.organizations.name, role: first.role };
}
