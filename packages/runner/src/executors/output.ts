import type { AttemptOutput } from "@ouroboros/harness";

export function parseAttemptOutput(raw: string): AttemptOutput {
  const parsed = JSON.parse(extractJsonObject(raw));
  if (parsed.status !== "done" && parsed.status !== "blocked") {
    throw new Error("agent output status must be 'done' or 'blocked'");
  }
  return {
    status: parsed.status,
    summary: String(parsed.summary ?? ""),
    changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String) : [],
    checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    problems: Array.isArray(parsed.problems) ? parsed.problems.map(String) : [],
    nextTasks: Array.isArray(parsed.nextTasks) ? parsed.nextTasks : [],
  };
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    return fenced[1];
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("agent output did not contain a JSON object");
}
