      subject,
      payload,
      scope: typeof input?.scope === "string" ? input.scope : undefined,
      kind: input?.kind as "request" | "response" | "event" | "delegation" | undefined,
      conversationId: typeof input?.conversationId === "string" ? input.conversationId : null,
      correlationId: typeof input?.correlationId === "string" ? input.correlationId : null,
      replyToMessageId: typeof input?.replyToMessageId === "string" ? input.replyToMessageId : null,
      ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
      priority: typeof input?.priority === "number" ? input.priority : undefined,
    });
    const result = { output: { sent: true, messageId: message.messageId, recipientAgentId: message.recipientAgentId, conversationId: message.conversationId, status: message.status }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "agent.delegate") {
    const input = invocation.input as { recipientAgentId?: unknown; objective?: unknown; context?: unknown; scope?: unknown; ttlSeconds?: unknown; priority?: unknown; maxCostCents?: unknown } | null;
    const recipientAgentId = String(input?.recipientAgentId ?? "").trim();
    const objective = String(input?.objective ?? "").trim();
    if (!recipientAgentId || objective.length < 5) throw new Error("agent.delegate requires recipientAgentId and a useful objective");
    const delegated = await delegateToAgent({
      organizationId: agent.organizationId,
      taskId,
      stepId,
      senderAgent: agent,
      recipientAgentId,
      objective: objective.slice(0, 4000),
      context: input?.context ?? null,
      scope: typeof input?.scope === "string" ? input.scope : undefined,
      ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
      priority: typeof input?.priority === "number" ? input.priority : undefined,
      maxCostCents: typeof input?.maxCostCents === "number" ? input.maxCostCents : undefined,
    });
    const result = { output: delegated, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "knowledge.search") {
    const input = invocation.input as { query?: unknown; limit?: unknown } | null;
    const query = String(input?.query ?? "").trim();
    if (!query) throw new Error("knowledge.search requires a query");

    const db = createAdminClient();
    const { data: task, error: taskError } = await db
      .from("tasks")
      .select("created_by")
      .eq("organization_id", agent.organizationId)
      .eq("id", taskId)
      .single();
    if (taskError) throw new Error(taskError.message);
    const userId = typeof task?.created_by === "string" ? task.created_by : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error("Knowledge search requires a valid task owner identity");
    }

    const results = await retrieveKnowledge({
      organizationId: agent.organizationId,
      userId,
      query,
      limit: typeof input?.limit === "number" ? input.limit : 8,
      workspaceOnly: true,
      runtimeEnv: undefined,
    });
    const result = {
      output: {
        query,
        results: results.map((row: any) => ({
          id: row.id,
          sourceType: row.source_type,
          documentId: row.document_id,
          memoryId: row.memory_id,
          filename: row.filename,
          kind: row.kind,
          content: row.content,
          sourceRef: row.source_ref,