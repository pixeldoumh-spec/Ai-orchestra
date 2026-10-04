const SENSITIVE_QUERY_KEYS = /^(authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|signature|sig|code)$/i;

export function sanitizeConnectorUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function sanitizeConnectorText(value: string, maxChars = 4000): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(x-api-key\s*:\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[redacted]$2")
    .slice(0, Math.max(256, Math.min(50000, maxChars)));
}
