import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent } from "@/lib/orchestrator/repository";

export async function listTaskComments(organizationId: string, taskId: string) {
  const db = createAdminClient();
  const { data, error } = await db.from("task_comments")
    .select("id,organization_id,task_id,team_id,author_id,body,created_at")
    .eq("organization_id", organizationId)
    .eq("task_id", taskId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function addTaskComment(input: {
  organizationId: string;
  taskId: string;
  teamId?: string | null;
  authorId: string;
  body: string;
}) {
  const db = createAdminClient();
  const body = input.body.trim();
  if (body.length < 1 || body.length > 4000) throw new Error("Comment must be between 1 and 4000 characters");
  const { data: task, error: taskError } = await db.from("tasks")
    .select("id,team_id")
    .eq("organization_id", input.organizationId)
    .eq("id", input.taskId)
    .maybeSingle();
  if (taskError) throw new Error(taskError.message);
  if (!task) throw new Error("Task not found");

  const teamId = input.teamId ?? task.team_id ?? null;
  if (teamId) {
    const { data: team } = await db.from("enterprise_teams").select("id").eq("organization_id", input.organizationId).eq("id", teamId).maybeSingle();
    if (!team) throw new Error("Team not found in this workspace");
  }

  const { data, error } = await db.from("task_comments").insert({
    organization_id: input.organizationId,
    task_id: input.taskId,
    team_id: teamId,
    author_id: input.authorId,
    body,
  }).select("id,organization_id,task_id,team_id,author_id,body,created_at").single();
  if (error) throw new Error(error.message);
  await appendEvent(input.taskId, input.organizationId, "task.comment.added", { commentId: data.id, teamId });
  return data;
}

export async function assignTaskTeam(input: {
  organizationId: string;
  taskId: string;
  teamId: string | null;
}) {
  const db = createAdminClient();
  if (input.teamId) {
    const { data: team, error: teamError } = await db.from("enterprise_teams")
      .select("id").eq("organization_id", input.organizationId).eq("id", input.teamId).maybeSingle();
    if (teamError) throw new Error(teamError.message);
    if (!team) throw new Error("Team not found in this workspace");
  }
  const { data, error } = await db.from("tasks").update({ team_id: input.teamId })
    .eq("organization_id", input.organizationId).eq("id", input.taskId)
    .select("id,organization_id,team_id").single();
  if (error) throw new Error(error.message);
  await appendEvent(input.taskId, input.organizationId, "task.team.updated", { teamId: input.teamId });
  return data;
}
