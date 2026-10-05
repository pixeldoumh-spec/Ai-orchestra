import { createHmac, timingSafeEqual } from "node:crypto";

function getStripeSecret(): string {
  const value = process.env.STRIPE_SECRET_KEY;
  if (!value) throw new Error("Stripe billing is not configured");
  return value;
}

async function stripeRequest(path: string, body: URLSearchParams): Promise<any> {
  const response = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeSecret()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.error?.message === "string" ? payload.error.message : "Stripe API request failed";
    throw new Error(message);
  }
  return payload;
}

function envPriceId(planCode: string, interval: "month" | "year"): string | null {
  const key = "STRIPE_" + planCode.toUpperCase() + "_" + interval.toUpperCase() + "_PRICE_ID";
  const value = process.env[key];
  return value?.trim() || null;
}

export function resolveStripePriceId(plan: { code: string; stripe_monthly_price_id?: string | null; stripe_annual_price_id?: string | null }, interval: "month" | "year") {
  return interval === "year"
    ? plan.stripe_annual_price_id || envPriceId(plan.code, interval)
    : plan.stripe_monthly_price_id || envPriceId(plan.code, interval);
}

export async function createStripeCustomer(input: { email?: string; organizationId: string; name?: string }) {
  const body = new URLSearchParams();
  if (input.email) body.set("email", input.email);
  if (input.name) body.set("name", input.name);
  body.set("metadata[organization_id]", input.organizationId);
  return stripeRequest("/customers", body);
}

export async function createStripeCheckout(input: {
  customerId: string;
  priceId: string;
  organizationId: string;
  planCode: string;
  interval: "month" | "year";
  successUrl: string;
  cancelUrl: string;
}) {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("customer", input.customerId);
  body.set("line_items[0][price]", input.priceId);
  body.set("line_items[0][quantity]", "1");
  body.set("success_url", input.successUrl);
  body.set("cancel_url", input.cancelUrl);
  body.set("subscription_data[metadata][organization_id]", input.organizationId);
  body.set("subscription_data[metadata][plan_code]", input.planCode);
  body.set("metadata[organization_id]", input.organizationId);
  body.set("metadata[plan_code]", input.planCode);
  body.set("metadata[interval]", input.interval);
  return stripeRequest("/checkout/sessions", body);
}

export async function createStripeBillingPortal(customerId: string, returnUrl: string) {
  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  return stripeRequest("/billing_portal/sessions", body);
}

export async function cancelStripeSubscription(externalSubscriptionId: string) {
  const body = new URLSearchParams();
  body.set("cancel_at_period_end", "true");
  return stripeRequest(`/subscriptions/${encodeURIComponent(externalSubscriptionId)}`, body);
}

function constantTimeHexEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function verifyStripeSignature(payload: string, signatureHeader: string, secret: string, toleranceSeconds = 300): boolean {
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith("t="))?.slice(2) ?? "0");
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || timestamp <= 0 || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return signatures.some((candidate) => constantTimeHexEqual(candidate, expected));
}
