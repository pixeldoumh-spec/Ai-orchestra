import { createAdminClient } from "@/lib/supabase/admin";
import { createConnector, setConnectorStatus } from "./repository";

export async function listMarketplace(organizationId: string) {
  const db = createAdminClient();
  const [{ data: catalog, error: catalogError }, { data: installs, error: installError }] = await Promise.all([
    db.from("connector_marketplace_catalog").select("slug,name,description,category,kind,base_url,auth_scheme,version,categories,manifest,published").eq("published", true).order("name"),
    db.from("organization_connector_installs").select("id,catalog_slug,connector_id,installed_version,status,installed_by,installed_at,uninstalled_at").eq("organization_id", organizationId).order("installed_at", { ascending: false }),
  ]);
  if (catalogError) throw new Error(catalogError.message);
  if (installError) throw new Error(installError.message);
  return { catalog: catalog ?? [], installs: installs ?? [] };
}

export async function installMarketplaceConnector(input: {
  organizationId: string;
  catalogSlug: string;
  userId: string;
  baseUrl?: string | null;
}) {
  const db = createAdminClient();
  const { data: catalog, error: catalogError } = await db.from("connector_marketplace_catalog").select("*").eq("slug", input.catalogSlug).eq("published", true).single();
  if (catalogError || !catalog) throw new Error("Marketplace connector not found");

  const { data: entitlement } = await db.from("organization_entitlements").select("features").eq("organization_id", input.organizationId).maybeSingle();
  const features = entitlement?.features && typeof entitlement.features === "object" ? entitlement.features as Record<string, unknown> : {};
  if (features.marketplace !== true) throw new Error("Connector marketplace is not enabled for this plan");

  const { data: existingInstall } = await db.from("organization_connector_installs").select("*").eq("organization_id", input.organizationId).eq("catalog_slug", input.catalogSlug).maybeSingle();
  if (existingInstall?.status === "active") return existingInstall;

  const baseUrl = input.baseUrl?.trim() || catalog.base_url || null;
  if (catalog.manifest?.requires_base_url && !baseUrl) throw new Error("This marketplace connector requires an HTTPS base URL");
  if (baseUrl && !baseUrl.startsWith("https://")) throw new Error("Marketplace connector base URL must use HTTPS");

  const needsCredential = catalog.auth_scheme !== "none";
  const connector = await createConnector({
    organizationId: input.organizationId,
    name: catalog.name,
    kind: catalog.kind,
    baseUrl,
    authScheme: catalog.auth_scheme,
    version: catalog.version,
  });
  if (needsCredential) await setConnectorStatus(input.organizationId, connector.id, "degraded");

  const { data: install, error: installError } = await db.from("organization_connector_installs").upsert({
    organization_id: input.organizationId,
    catalog_slug: input.catalogSlug,
    connector_id: connector.id,
    installed_version: catalog.version,
    status: "active",
    installed_by: input.userId,
    installed_at: new Date().toISOString(),
    uninstalled_at: null,
  }, { onConflict: "organization_id,catalog_slug" }).select("id,catalog_slug,connector_id,installed_version,status,installed_by,installed_at,uninstalled_at").single();
  if (installError) throw new Error(installError.message);
  return install;
}

export async function uninstallMarketplaceConnector(input: { organizationId: string; catalogSlug: string }) {
  const db = createAdminClient();
  const { data: install, error: readError } = await db.from("organization_connector_installs").select("id,connector_id").eq("organization_id", input.organizationId).eq("catalog_slug", input.catalogSlug).maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!install) return null;
  await setConnectorStatus(input.organizationId, install.connector_id, "disabled");
  const { data, error } = await db.from("organization_connector_installs").update({
    status: "uninstalled",
    uninstalled_at: new Date().toISOString(),
  }).eq("organization_id", input.organizationId).eq("catalog_slug", input.catalogSlug).select("id,catalog_slug,connector_id,installed_version,status,installed_by,installed_at,uninstalled_at").single();
  if (error) throw new Error(error.message);
  return data;
}
