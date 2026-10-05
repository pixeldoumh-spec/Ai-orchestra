import { createAdminClient } from "@/lib/supabase/admin";
import { applyProductPlanToEntitlements } from "./provisioning";

export async function listProductPlans() {
  const db = createAdminClient();
  const { data, error } = await db.from("product_plans").select("*").eq("published", true).order("monthly_price_cents", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getBillingOverview(organizationId: string) {
  const db = createAdminClient();
  const [{ data: entitlement, error: entitlementError }, { data: customer, error: customerError }, { data: subscriptions, error: subscriptionError }, { data: invoices, error: invoiceError }, { data: plans, error: planError }] = await Promise.all([
    db.from("organization_entitlements").select("*").eq("organization_id", organizationId).maybeSingle(),
    db.from("billing_customers").select("organization_id,provider,external_customer_id,email,created_at,updated_at").eq("organization_id", organizationId).maybeSingle(),
    db.from("billing_subscriptions").select("id,plan_code,provider,external_subscription_id,status,interval,current_period_start,current_period_end,cancel_at_period_end,customer_external_id,metadata,created_at,updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }).limit(5),
    db.from("billing_invoices").select("id,external_invoice_id,status,currency,amount_due_cents,amount_paid_cents,hosted_invoice_url,period_start,period_end,created_at,updated_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(20),
    db.from("product_plans").select("*").eq("published", true).order("monthly_price_cents", { ascending: true, nullsFirst: false }),
  ]);
  for (const error of [entitlementError, customerError, subscriptionError, invoiceError, planError]) if (error) throw new Error(error.message);

  const quota = await (async () => {
    const { data, error } = await db.rpc("get_product_quota_snapshot", { p_organization_id: organizationId });
    if (error) throw new Error(error.message);
    return data ?? {};
  })();

  const currentPlanCode = entitlement?.plan ?? "starter";
  const currentPlan = (plans ?? []).find((plan: any) => plan.code === currentPlanCode) ?? null;
  return {
    currentPlan,
    entitlement,
    customer: customer ?? null,
    subscriptions: subscriptions ?? [],
    invoices: invoices ?? [],
    plans: plans ?? [],
    quota,
  };
}

export async function saveStripeCustomer(input: { organizationId: string; externalCustomerId: string; email?: string | null }) {
  const db = createAdminClient();
  const { error } = await db.from("billing_customers").upsert({
    organization_id: input.organizationId,
    provider: "stripe",
    external_customer_id: input.externalCustomerId,
    email: input.email ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id" });
  if (error) throw new Error(error.message);
}

function metadataObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)]));
}

async function orgForStripeCustomer(customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const db = createAdminClient();
  const { data } = await db.from("billing_customers").select("organization_id").eq("external_customer_id", customerId).maybeSingle();
  return data?.organization_id ?? null;
}

export async function resolveOrganizationForSubscription(subscription: any): Promise<string | null> {
  const metadata = metadataObject(subscription?.metadata);
  return metadata.organization_id ?? await orgForStripeCustomer(typeof subscription?.customer === "string" ? subscription.customer : null);
}

function unixToIso(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function statusAsProductStatus(status: string): string {
  const allowed = new Set(["trialing","active","incomplete","incomplete_expired","past_due","canceled","unpaid","paused"]);
  return allowed.has(status) ? status : "canceled";
}

export async function upsertStripeSubscription(subscription: any) {
  const organizationId = await resolveOrganizationForSubscription(subscription);
  if (!organizationId) throw new Error("Stripe subscription is not linked to an organization");
  const metadata = metadataObject(subscription?.metadata);
  const planCode = metadata.plan_code || await resolvePlanCodeFromPrice(subscription?.items?.data?.[0]?.price?.id);
  if (!planCode) throw new Error("Stripe subscription is not linked to a product plan");

  const interval = subscription?.items?.data?.[0]?.price?.recurring?.interval === "year" ? "year" : "month";
  const db = createAdminClient();
  const { data, error } = await db.from("billing_subscriptions").upsert({
    organization_id: organizationId,
    plan_code: planCode,
    provider: "stripe",
    external_subscription_id: String(subscription.id),
    status: statusAsProductStatus(String(subscription.status ?? "canceled")),
    interval,
    current_period_start: unixToIso(subscription.current_period_start),
    current_period_end: unixToIso(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    customer_external_id: typeof subscription.customer === "string" ? subscription.customer : null,
    metadata: metadataObject(subscription.metadata),
    updated_at: new Date().toISOString(),
  }, { onConflict: "external_subscription_id" }).select("id,organization_id,plan_code,status,interval,current_period_start,current_period_end,cancel_at_period_end,external_subscription_id").single();
  if (error) throw new Error(error.message);

  const billable = ["trialing", "active", "past_due"].includes(String(subscription.status));
  await applyProductPlanToEntitlements(organizationId, billable ? planCode : "starter");
  return data;
}

async function resolvePlanCodeFromPrice(priceId: unknown): Promise<string | null> {
  if (typeof priceId !== "string" || !priceId) return null;
  const db = createAdminClient();
  const { data } = await db.from("product_plans").select("code").or(`stripe_monthly_price_id.eq.${priceId},stripe_annual_price_id.eq.${priceId}`).maybeSingle();
  return data?.code ?? null;
}

export async function upsertStripeInvoice(invoice: any) {
  const organizationId = await orgForStripeCustomer(typeof invoice?.customer === "string" ? invoice.customer : null);
  if (!organizationId) return null;
  const subscriptionId = typeof invoice?.subscription === "string" ? invoice.subscription : null;
  const db = createAdminClient();
  let localSubscriptionId: string | null = null;
  if (subscriptionId) {
    const { data } = await db.from("billing_subscriptions").select("id").eq("external_subscription_id", subscriptionId).maybeSingle();
    localSubscriptionId = data?.id ?? null;
  }
  const periodStart = invoice?.period_start ?? invoice?.lines?.data?.[0]?.period?.start;
  const periodEnd = invoice?.period_end ?? invoice?.lines?.data?.[0]?.period?.end;
  const { data, error } = await db.from("billing_invoices").upsert({
    organization_id: organizationId,
    subscription_id: localSubscriptionId,
    provider: "stripe",
    external_invoice_id: String(invoice.id),
    status: String(invoice.status ?? "open"),
    currency: String(invoice.currency ?? "usd"),
    amount_due_cents: Math.max(0, Number(invoice.amount_due ?? 0)),
    amount_paid_cents: Math.max(0, Number(invoice.amount_paid ?? 0)),
    hosted_invoice_url: typeof invoice.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : null,
    period_start: unixToIso(periodStart),
    period_end: unixToIso(periodEnd),
    metadata: metadataObject(invoice.metadata),
    updated_at: new Date().toISOString(),
  }, { onConflict: "external_invoice_id" }).select("id,external_invoice_id,status,amount_due_cents,amount_paid_cents,hosted_invoice_url").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function recordBillingEvent(input: { eventId: string; eventType: string; payloadHash: string; payload: unknown }) {
  const db = createAdminClient();
  const { data: existing } = await db.from("billing_events").select("id,status").eq("external_event_id", input.eventId).maybeSingle();
  if (existing && (existing.status === "processed" || existing.status === "ignored")) return { duplicate: true, status: existing.status };
  if (existing) {
    const { error: resetError } = await db.from("billing_events").update({
      status: "received",
      error: null,
      payload: input.payload,
      payload_hash: input.payloadHash,
      received_at: new Date().toISOString(),
      processed_at: null,
    }).eq("external_event_id", input.eventId);
    if (resetError) throw new Error(resetError.message);
    return { duplicate: false, id: existing.id };
  }

  const { data, error } = await db.from("billing_events").insert({
    provider: "stripe",
    external_event_id: input.eventId,
    event_type: input.eventType,
    payload_hash: input.payloadHash,
    status: "received",
    payload: input.payload,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { duplicate: false, id: data.id };
}

export async function finalizeBillingEvent(eventId: string, status: "processed" | "failed" | "ignored", errorMessage?: string | null) {
  const db = createAdminClient();
  const { error } = await db.from("billing_events").update({
    status,
    error: errorMessage ?? null,
    processed_at: new Date().toISOString(),
  }).eq("external_event_id", eventId);
  if (error) throw new Error(error.message);
}
