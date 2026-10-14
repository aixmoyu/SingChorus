/**
 * Tolerant JSON column parsers — shared by every route that reads the
 * client_configs JSON columns (server_config / params / route_rules may be
 * absent on rows created before the column existed, or corrupted).
 */

/** Parse a JSON object column (absent/malformed/non-object → {}). */
export function safeParseObject(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a JSON array column (absent/malformed/non-array → []). */
export function safeParseArray(json: string | undefined | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
