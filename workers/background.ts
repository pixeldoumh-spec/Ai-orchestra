type QueueMessage = {
  body: {
    schemaVersion?: number;
    dispatchId?: string;
    taskId?: string;
    organizationId?: string;
    reason?: string;
    enqueuedAt?: string;
  };
  id: string;
  attempts: number;
  ack?: () => void;
  retry?: (options?: { delaySeconds?: number }) => void;
};

type Env = {
  TASK_QUEUE: unknown;
  ORCHESTRATOR: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  BACKGROUND_WORKER_SECRET: string;
};

function safeErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  if (/timeout/i.test(message)) return "timeout";
  if (/quota|allocation/i.test(message)) return "quota";
  if (/capacity|busy|429|rate limit/i.test(message)) return "capacity";
  if (/forbidden|unauthorized|authentication/i.test(message)) return "auth";
  if (/budget/i.test(message)) return "budget";
  return "runtime";
}

async function callOrchestrator(env: Env, path: string, body: unknown) {
  return env.ORCHESTRATOR.fetch("https://internal" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-background-worker-secret": env.BACKGROUND_WORKER_SECRET,
    },
    body: JSON.stringify(body),
  });
}

const backgroundWorker = {
  async queue(batch: { messages: QueueMessage[] }, env: Env) {
    for (const message of batch.messages) {
      const body = message.body ?? {};
      if (!body.taskId || !body.organizationId || !body.dispatchId) {
        message.retry?.({ delaySeconds: 30 });
        continue;
      }
      try {
        const response = await callOrchestrator(env as Env, "/api/internal/background/execute", {
          ...body,
          queueMessageId: message.id,
          attempt: message.attempts ?? 1,
        });
        if (!response.ok) {
          message.retry?.({ delaySeconds: Math.min(300, 15 * Math.max(1, message.attempts ?? 1)) });
          continue;
        }
        message.ack?.();
      } catch {
        message.retry?.({ delaySeconds: Math.min(300, 15 * Math.max(1, message.attempts ?? 1)) });
      }
    }
  },
  async scheduled(_event: { cron?: string }, env: Env) {
    try {
      await callOrchestrator(env, "/api/internal/background/dispatch", {
        trigger: "cron",
        requestedAt: new Date().toISOString(),
      });
    } catch {
      // The queue will self-heal the next minute.
    }
  },
};

export default backgroundWorker;
