import type { AgentDefinition, TaskRecord } from "./types";

const agents = new Map<string, AgentDefinition>();
const tasks = new Map<string, TaskRecord>();

export function registerAgent(agent: AgentDefinition) { agents.set(agent.id, agent); }
export function listAgents() { return [...agents.values()]; }
export function getAgent(id: string) { return agents.get(id); }
export function saveTask(task: TaskRecord) { tasks.set(task.id, task); return task; }
export function getTask(id: string) { return tasks.get(id); }
export function listTasks() { return [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
