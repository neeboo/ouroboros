import { readableValue, type AttemptOutput } from "@ouroboros/harness";
import { createHash } from "node:crypto";

const DEFAULT_DIAGNOSTIC_CHARS = 4_096;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_ENTRY_CHARS = 480;
const MAX_CHANGED_FILES = 64;
const MAX_CHECKS = 32;
const MAX_ARTIFACTS = 32;

export function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function redactDiagnosticText(value: string) {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|lin_api|lin_oauth)[_-][A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /(\b(?:authorization|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\])]+)/gi,
      "$1[REDACTED]",
    );
}

export interface BoundedDiagnosticText {
  text: string;
  sha256: string;
  originalChars: number;
  utf8Bytes: number;
  truncated: boolean;
}

export function boundedDiagnosticText(value: unknown, maxChars = DEFAULT_DIAGNOSTIC_CHARS): BoundedDiagnosticText {
  const raw = typeof value === "string" ? value : readableValue(value);
  const redacted = redactDiagnosticText(raw);
  const metadata = {
    sha256: sha256Text(raw),
    originalChars: raw.length,
    utf8Bytes: Buffer.byteLength(raw, "utf8"),
  };
  if (redacted.length <= maxChars) {
    return { text: redacted, ...metadata, truncated: false };
  }
  const marker = `\n...[truncated originalChars=${metadata.originalChars} utf8Bytes=${metadata.utf8Bytes} sha256=${metadata.sha256}]...\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(remaining / 2);
  const tailChars = Math.floor(remaining / 2);
  return {
    text: `${redacted.slice(0, headChars)}${marker}${redacted.slice(-tailChars)}`,
    ...metadata,
    truncated: true,
  };
}

export function latestRootCause(output: AttemptOutput) {
  const problem = [...(output.problems ?? [])]
    .reverse()
    .map((entry) => readableValue(entry))
    .find((entry) => entry.trim().length > 0);
  return boundedDiagnosticText(problem ?? output.summary ?? "Verifier blocked without a recorded root cause.", MAX_SUMMARY_CHARS).text;
}

export function compactAttemptEvidence(output: AttemptOutput) {
  const raw = safeJson(output);
  const compact = {
    status: output.status,
    summary: boundedDiagnosticText(output.summary, MAX_SUMMARY_CHARS).text,
    changedFiles: summarizeStrings(output.changedFiles ?? [], MAX_CHANGED_FILES),
    checks: summarizeRecords(output.checks ?? [], MAX_CHECKS, ["name", "status"]),
    artifacts: summarizeRecords(output.artifacts ?? [], MAX_ARTIFACTS, [
      "kind",
      "path",
      "sha",
      "taskId",
      "attemptId",
      "sessionId",
    ]),
    problems: summarizeProblems(output.problems ?? []),
  };
  return {
    ...compact,
    originalEvidence: {
      sha256: sha256Text(raw),
      characterCount: raw.length,
      utf8ByteCount: Buffer.byteLength(raw, "utf8"),
      itemCount:
        1
        + (output.changedFiles?.length ?? 0)
        + (output.checks?.length ?? 0)
        + (output.artifacts?.length ?? 0)
        + (output.problems?.length ?? 0),
      truncated: raw.length > safeJson(compact).length,
    },
  };
}

export function compactUnknownEvidence(value: unknown) {
  const raw = safeJson(value);
  const diagnostic = boundedDiagnosticText(raw, MAX_SUMMARY_CHARS);
  return {
    summary: diagnostic.text,
    originalEvidence: {
      sha256: diagnostic.sha256,
      characterCount: diagnostic.originalChars,
      utf8ByteCount: diagnostic.utf8Bytes,
      itemCount: Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 1,
      truncated: diagnostic.truncated,
    },
  };
}

function summarizeStrings(values: unknown[], limit: number) {
  const items = values.slice(0, limit).map((value) => boundedDiagnosticText(value, MAX_ENTRY_CHARS).text);
  return {
    items,
    count: values.length,
    truncated: values.length > items.length || items.some((item, index) => item !== redactDiagnosticText(readableValue(values[index]))),
    sha256: sha256Text(safeJson(values)),
  };
}

function summarizeProblems(values: unknown[]) {
  const latest = [...values].reverse().find((value) => readableValue(value).trim().length > 0);
  const items = latest === undefined ? [] : [boundedDiagnosticText(latest, MAX_SUMMARY_CHARS).text];
  return {
    items,
    count: values.length,
    truncated: values.length > items.length || items.some((item) => {
      const original = typeof latest === "string" ? latest : readableValue(latest);
      return item !== redactDiagnosticText(original);
    }),
    sha256: sha256Text(safeJson(values)),
  };
}

function summarizeRecords(values: unknown[], limit: number, allowedKeys: string[]) {
  const items = values.slice(0, limit).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { summary: boundedDiagnosticText(value, MAX_ENTRY_CHARS).text };
    }
    const record = value as Record<string, unknown>;
    const selected = Object.fromEntries(
      allowedKeys
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, boundedDiagnosticText(record[key], MAX_ENTRY_CHARS).text]),
    );
    const omitted = Object.fromEntries(Object.entries(record).filter(([key]) => !allowedKeys.includes(key)));
    return Object.keys(omitted).length === 0
      ? selected
      : {
          ...selected,
          omittedEvidenceSha256: sha256Text(safeJson(omitted)),
          omittedFieldCount: Object.keys(omitted).length,
        };
  });
  return {
    items,
    count: values.length,
    truncated: values.length > items.length || values.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.keys(value as Record<string, unknown>).some((key) => !allowedKeys.includes(key));
    }),
    sha256: sha256Text(safeJson(values)),
  };
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return readableValue(value);
  }
}
