export function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  return `${prefix}_${uuid.replaceAll("-", "").slice(0, 24)}`;
}

export async function digestEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([globalThis.crypto.subtle.digest("SHA-256", encoder.encode(a)), globalThis.crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const aa = new Uint8Array(da); const bb = new Uint8Array(db);
  if (aa.length !== bb.length) return false;
  let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
