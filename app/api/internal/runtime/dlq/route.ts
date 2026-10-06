import { NextResponse } from "next/server";
import { digestEqual } from "@/lib/core/security";
import { listBackgroundDeadLetters } from "@/lib/ops/repository";
import { replayBackgroundDeadLetter } from "@/lib/orchestrator/background";

function authorized(request: Request): Promise<boolean> {
  const configured = process.env.INTERNAL_WORKER_SECRET ?? "";
  const supplied = request.headers.get("x-worker-secret") ?? "";
  return digestEqual(configured, supplied);
}

export async function GET(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
    return NextResponse.json({ deadLetters: await listBackgroundDeadLetters(limit) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = await request.json();
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: "A valid dead-letter id is required" }, { status: 400 });
    const result = await replayBackgroundDeadLetter(id, undefined);
    if (!result.replayed) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
