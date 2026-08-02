// Strict ISO 8601 (UTC) timestamp validation.
//
// `Date.parse` accepts many non-ISO formats (RFC 2822, month-name dates, numeric
// offsets) and silently coerces numbers and booleans. Designer signals and
// authority evidence must only ever be evaluated against unambiguous UTC
// instants, so this module enforces a single canonical shape:
//   YYYY-MM-DDTHH:mm:ss(.sss)Z
// plus a finite Date.parse result. Anything else fails closed.

const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (!ISO_8601_UTC_PATTERN.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function requireStrictIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty ISO 8601 timestamp`);
  }
  if (!ISO_8601_UTC_PATTERN.test(value)) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp in the form YYYY-MM-DDTHH:mm:ss(.sss)Z`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return value;
}

export function optionalStrictIsoTimestamp(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  return requireStrictIsoTimestamp(value, label);
}
