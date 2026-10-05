import { createAdminClient } from "@/lib/supabase/admin";

export async function applyProductPlanToEntitlements(organizationId: string, planCode: string) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("apply_product_plan", {
    p_organization_id: organizationId,
    p_plan_code: planCode,
  });
  if (error) throw new Error(error.message);
  return data;
}
