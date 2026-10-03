import { createClient } from "@supabase/supabase-js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function createAdminClient() {
  const url = process.env.SUPABASE_URL ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = env("SUPABASE_SECRET_KEY");
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
