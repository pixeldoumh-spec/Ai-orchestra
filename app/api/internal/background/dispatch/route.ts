import { NextResponse } from "next/server";
import { digestEqual } from "@/lib/core/security";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent } from "@/lib/orchestrator/repository";
import { enqueueTask } from "@/lib/orchestrator/queue";
import { markTaskDispatched } from "@/lib/ops/repository";

export async function POST(request: Request) {
  const configured = process.env.BACKGROUND_WORKER_SECRET;
  const supplied = request.headers.get("x-background-worker-secret") ?? "";
  if (!configured || !(await digestEqual(configured, supplied))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const db = createAdminClient();
    const now = new Date();
    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - 45_000).toISOString();
    const limit = Math.min(25, Math.max(1, Number(process.env.BACKGROUND_DISPATCH_LIMIT ?? "12")));
    const { data: candidates, error } = await db
      .from("tasks")
      .select("id,organization_id,status,run_after,lease_until,last_dispatched_at,execution_mode")
      .in("status", ["queued", "running"])
      .eq("execution_mode", "background")
      .or(`run_after.is.null,run_after.lte.${nowIso}`)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .order("created_at", { ascending: true })
      .limit(limit * 4);
    if (error) throw new Error(error.message);

    const eligible = (candidates ?? []).filter((task) =>
      !task.last_dispatched_at || Date.parse(task.last_dispatched_at) <= Date.parse(cutoffIso)
    ).slice(0, limit);

    const dispatched: Array<{ taskId: string; dispatchId: string }> = [];
    for (const task of eligible) {
      const { dispatchId } = await enqueueTask({
        taskId: task.id,
        organizationId: task.organization_id,
        reason: "cron_redrive",
      });
      await markTaskDispatched(task.id, dispatchId);
      await appendEvent(task.id, task.organization_id, "task.dispatched", {
        dispatchId,
        reason: "cron_redrive",
        queue: "ai-orchestra-tasks-v66",
      });
      dispatched.push({ taskId: task.id, dispatchId });
    }

    return NextResponse.json({
      ok: true,
      checked: candidates?.length ?? 0,
      dispatched,
      timestamp: nowIso,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Background dispatch failed" },
      { status: 500 },
    );
  }
}
