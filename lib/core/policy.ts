export type RiskLevel = "low" | "medium" | "high" | "critical";
export interface PolicyContext { agentPermissions: string[]; requestedPermission: string; risk: RiskLevel; approvalGranted: boolean; }
export function canUsePermission(ctx: PolicyContext): boolean {
  if (!ctx.agentPermissions.includes(ctx.requestedPermission)) return false;
  if (ctx.risk === "critical" && !ctx.approvalGranted) return false;
  if (ctx.risk === "high" && !ctx.approvalGranted) return false;
  return true;
}
export function requiresApproval(risk: RiskLevel): boolean { return risk === "high" || risk === "critical"; }
