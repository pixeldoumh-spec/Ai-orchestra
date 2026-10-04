import { getCloudflareContext } from "@opennextjs/cloudflare";

type QueueBinding = {
  send(body: unknown): Promise<unknown>;
};

function getTaskQueue(runtimeEnv?: unknown): QueueBinding {
  if (runtimeEnv && typeof runtimeEnv === "object") {
    const queue = (runtimeEnv as { TASK_QUEUE?: unknown }).TASK_QUEUE;
    if (queue && typeof queue === "object" && typeof (queue as { send?: unknown }).send === "function") {
      return queue as QueueBinding;
    }
  }
  const context = getCloudflareContext();
  const queue = (context.env as { TASK_QUEUE?: unknown }).TASK_QUEUE;
  if (!queue || typeof queue !== "object" || typeof (queue as { send?: unknown }).send !== "function") {
    throw new Error("TASK_QUEUE is not configured");
  }
  return queue as QueueBinding;
}

export function newDispatchId(taskId: string): string {
  return `task_${taskId}_${crypto.randomUUID()}`;
}

export async function enqueueTask(input: {
  taskId: string;
  organizationId: string;
  reason?: "user_start" | "cron_redrive" | "step_retry" | "yield";
}) {
  const dispatchId = newDispatchId(input.taskId);
  const payload = {
    schemaVersion: 1,
    dispatchId,
    taskId: input.taskId,
    organizationId: input.organizationId,
    reason: input.reason ?? "user_start",
    enqueuedAt: new Date().toISOString(),
  };
  const queue = getTaskQueue(input.runtimeEnv);
  await queue.send(payload);
  return { dispatchId };
}
