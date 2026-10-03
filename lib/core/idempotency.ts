function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export function normalizeIdempotencyKey(value: string | null | undefined): string {
  const raw = value?.trim(); if (!raw) return "";
  return `${fnv1a(raw)}${fnv1a(raw.split("").reverse().join(""))}${raw.length.toString(16)}`.slice(0, 48);
}
