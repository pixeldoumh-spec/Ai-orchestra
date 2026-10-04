import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { getTask } from "@/lib/orchestrator/repository";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function encodeEvent(id: string | number, payload: unknown) {
  return `id: ${id}\nevent: execution\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id: taskId } = await context.params;
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }

    const task = await getTask(taskId, org.id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const lastHeader = request.headers.get("last-event-id");
    const cursor = Math.max(0, Number(new URL(request.url).searchParams.get("cursor") ?? lastHeader ?? 0) || 0);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        let lastId = cursor;
        const started = Date.now();
        let lastHeartbeat = Date.now();
        const dbAdmin = createAdminClient();
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch {}
        };
        try {
          controller.enqueue(encoder.encode(`retry: 3000\n\n`));
          controller.enqueue(encoder.encode(encodeEvent(`snapshot-${Date.now()}`, {
            type: "snapshot",
            task: await getTask(taskId, org.id),
          })));
          while (!closed && Date.now() - started < Math.min(300000, Math.max(10000, Number(process.env.TASK_STREAM_MAX_MS ?? "240000")))) {
            const { data, error } = await dbAdmin
              .from("task_events")
              .select("id,task_id,organization_id,event_type,payload,created_at")
              .eq("task_id", taskId)
              .eq("organization_id", org.id)
              .gt("id", lastId)
              .order("id", { ascending: true })
              .limit(100);
            if (error) throw new Error(error.message);
            for (const event of data ?? []) {
              lastId = Number(event.id);
              controller.enqueue(encoder.encode(encodeEvent(event.id, {
                type: "event",
                event,
              })));
            }
            const latest = await getTask(taskId, org.id);
            const status = latest?.status;
            if (status && ["verified", "failed", "cancelled"].includes(status)) {
              close();
              return;
            }
            if (Date.now() - lastHeartbeat >= 15000) {
              controller.enqueue(encoder.encode(": ping\n\n"));
              lastHeartbeat = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, 900));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Stream error";
          try { controller.enqueue(encoder.encode(encodeEvent(`error-${Date.now()}`, { type: "error", error: message }))); } catch {}
          close();
        } finally {
          close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
