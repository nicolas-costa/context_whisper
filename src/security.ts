/**
 * Security helpers (redaction, truncation)
 *
 * Keep this small and dependency-free: it runs in error paths and should never throw.
 */

export function truncate(input: string, maxChars: number): string {
  if (!input) return '';
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars) + `…[truncated ${input.length - maxChars} chars]`;
}

/**
 * Best-effort redaction of secrets from error messages/log lines.
 *
 * This is NOT a perfect sanitizer. It exists to prevent the most common credential leaks
 * (passwords inside DSNs / connection strings, api keys in query params).
 */
export function redactSecrets(input: string): string {
  if (!input) return '';

  let s = input;

  // URLs with credentials: scheme://user:pass@host -> scheme://user:***@host
  s = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/\s:@]+):([^\/\s@]+)@/g, '$1:***@');

  // password=... in DSN-like strings
  s = s.replace(/(\bpassword\s*=\s*)([^\s;]+)/gi, '$1***');

  // api_key / api-key in query params or key=value logs
  s = s.replace(/(\bapi[_-]?key\s*=\s*)([^\s&;]+)/gi, '$1***');

  return s;
}
