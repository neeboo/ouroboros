const PREFERRED_FIELDS = ["summary", "message", "error", "details", "name", "status", "severity", "path", "command"];

export function readableValue(value: unknown): string {
  const seen = new WeakSet<object>();
  return compactWhitespace(formatReadableValue(value, seen));
}

export function readableList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => readableValue(value)).filter((value) => value.length > 0);
}

function formatReadableValue(value: unknown, seen: WeakSet<object>): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => formatReadableValue(item, seen)).filter(Boolean).join("; ");
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const used = new Set<string>();

  for (const key of PREFERRED_FIELDS) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      continue;
    }
    used.add(key);
    const formatted = formatReadableValue(record[key], seen);
    if (formatted) {
      parts.push(`${key}: ${formatted}`);
    }
  }

  const remaining = Object.fromEntries(Object.entries(record).filter(([key]) => !used.has(key)));
  if (Object.keys(remaining).length > 0) {
    parts.push(`extra: ${compactJson(remaining)}`);
  }

  return parts.length > 0 ? parts.join("; ") : compactJson(record);
}

function compactJson(value: unknown) {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") {
        return String(nested);
      }
      if (!nested || typeof nested !== "object") {
        return nested;
      }
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
      return nested;
    });
    return json ?? "";
  } catch {
    return typeof value === "object" ? "[Unserializable object]" : String(value);
  }
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
