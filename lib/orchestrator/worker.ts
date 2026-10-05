          await requeueRunningStepsForApproval(taskId, step.id);
          await updateTaskOwned(taskId, organizationId, workerId, leaseGeneration, { status: "awaiting_approval" });
          await appendEvent(taskId, organizationId, "approval.requested", { stepId: step.id, toolId, reason: toolResult.approvalReason });
          return { stepId: step.id, status: "awaiting_approval", usageCents: totalUsageCents };
        }

        toolOutputs.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(toolResult.output ?? null).slice(0, 20_000),
        });
      }

      const continuationItems: unknown[] = calls.map((call) => ({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      }));
      if (result.outputText.trim()) {
        continuationItems.unshift({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: result.outputText }],
        });
      }
      pendingInput = [
        ...pendingInput,
        ...continuationItems,
        ...toolOutputs,
      ];
    }

    if (!lastModel || finalText.length === 0) {
      throw new Error("Model did not produce a final result within the bounded turn budget");
    }

    const evidencePacketIds = citations.length > 0
      ? await persistModelCitations({
          organizationId,
          taskId,
          stepId: step.id,
          agentId: agent.id,
          outputText: finalText,
          citations,
        })
      : [];

    let storedResult: unknown = evidencePacketIds.length > 0
      ? { content: finalOutput, evidencePacketIds }
      : finalOutput;
    if (step.kind === "verification") {
      const verification = parseVerificationResult(finalOutput);
      if (!verification.passed) {
        throw new Error(`Verifier rejected the result: ${verification.findings.join("; ") || "verification failed"}`);
      }
      storedResult = verification;
    }
