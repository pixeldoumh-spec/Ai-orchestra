import { NextResponse } from "next/server";
import { digestEqual } from "@/lib/core/security";
import { createAdminClient } from "@/lib/supabase/admin";
import { processTask } from "@/lib/orchestrator/worker";

export async function POST(request: Request) {
  const configured = process.env.INTERNAL_WORKER_SECRET;
  const supplied = request.headers.get("x-worker-secret") ?? "";
  if (!configured || !(await digestEqual(configured, supplied))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const db = createAdminClient();
  const { data: tasks, error } = await db.from("tasks").select("id, organization_id").in("status", ["queued", "running"]).or(`run_after.is.null,run_after.lte.${new Date().toISOString()}`).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).order("created_at", { ascending: true }).limit(10);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const task of tasks ?? []) results.push(await processTask(task.id, task.organization_id));
  return NextResponse.json({ processed: results.length, results });
}
