import type { Attempt, AttemptEvent } from "@ouroboros/harness";

const DEFAULT_EVENT_LIMIT = 25;
const MAX_LINE_CHARS = 200;

const EVENT_CATEGORIES = ["client", "thinking", "tool", "error"] as const;
type EventCategory = (typeof EVENT_CATEGORIES)[number] | "other";
const KNOWN_CATEGORIES = new Set<string>(EVENT_CATEGORIES);

export interface AttemptExplanationOptions {
  stdout?: string | null;
  events?: AttemptEvent[];
  role?: string | null;
  eventLimit?: number;
}

export function formatAttemptExplanation(
  attempt: Attempt | null,
  options: AttemptExplanationOptions = {},
): string {
  if (!attempt) {
    throw new Error("attempt not found");
  }
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const lines: string[] = [];

  lines.push(`Attempt ${attempt.id}`);
  lines.push(`Task: ${attempt.taskId}`);
  if (options.role) {
    lines.push(`Role: ${options.role}`);
  }
  lines.push(`Status: ${attempt.status}`);

  const route = routeLabel(attempt);
  const model = modelLabel(attempt.input.model);
  if (model || route) {
    const parts: string[] = [];
    if (model) parts.push(`Model: ${model}`);
    if (route) parts.push(`Route: ${route}`);
    lines.push(parts.join("  "));
  }

  const codexSessionId = stringOrNull(attempt.input.codexSessionId);
  if (codexSessionId) {
    lines.push(`Codex session: ${codexSessionId}`);
  }

  const events = categorizeStdout(resolveStdout(options));
  lines.push("");
  if (events.length === 0) {
    lines.push("Events: (none captured)");
  } else {
    lines.push(`Events (${events.length})`);
    const shown = events.slice(0, eventLimit);
    for (const category of EVENT_CATEGORIES) {
      const bucket = shown.filter((event) => event.category === category);
      if (bucket.length === 0) continue;
      lines.push(`  ${category}:`);
      for (const event of bucket) {
        lines.push(`    - ${clamp(event.text, MAX_LINE_CHARS)}`);
      }
    }
    const others = shown.filter((event) => event.category === "other");
    if (others.length > 0) {
      lines.push("  other:");
      for (const event of others) {
        lines.push(`    - ${clamp(event.text, MAX_LINE_CHARS)}`);
      }
    }
    const hidden = events.length - shown.length;
    if (hidden > 0) {
      lines.push(`  … ${hidden} more event(s) not shown`);
    }
  }

  const problems = collectProblems(attempt, events);
  lines.push("");
  if (problems.length === 0) {
    lines.push("Errors and warnings: (none)");
  } else {
    lines.push(`Errors and warnings (${problems.length})`);
    for (const problem of problems) {
      lines.push(`  - ${clamp(problem, MAX_LINE_CHARS)}`);
    }
  }

  const summary = (attempt.output?.summary ?? "").trim();
  lines.push("");
  if (summary) {
    lines.push("Summary");
    lines.push(`  ${clamp(summary, MAX_LINE_CHARS)}`);
  } else {
    lines.push("Summary: (none)");
  }

  return lines.join("\n");
}

function resolveStdout(options: AttemptExplanationOptions): string {
  if (options.stdout !== undefined && options.stdout !== null) {
    return options.stdout;
  }
  const events = Array.isArray(options.events) ? options.events : [];
  if (events.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const event of events) {
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!text) continue;
    if (event.stream === "stdout" || event.stream === "stderr") {
      lines.push(prefixLine(event, text));
    }
  }
  return lines.join("\n");
}

function prefixLine(event: AttemptEvent, text: string): string {
  if (event.stream === "stderr") {
    return /^\[error\]/i.test(text) ? text : `[error] ${text}`;
  }
  return text;
}

interface CategorizedEvent {
  category: EventCategory;
  text: string;
}

function categorizeStdout(stdout: string): CategorizedEvent[] {
  if (!stdout) {
    return [];
  }
  const events: CategorizedEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^\[([^\]]+)\]/.exec(line);
    if (match) {
      const tag = match[1].toLowerCase();
      const category: EventCategory = KNOWN_CATEGORIES.has(tag) ? (tag as EventCategory) : "other";
      events.push({ category, text: line });
      continue;
    }
    if (/\b(error|failed|failure)\b/i.test(line)) {
      events.push({ category: "error", text: line });
      continue;
    }
    events.push({ category: "other", text: line });
  }
  return events;
}

function collectProblems(attempt: Attempt, events: CategorizedEvent[]): string[] {
  const problems: string[] = [];
  for (const event of events) {
    if (event.category === "error") {
      problems.push(event.text);
    }
  }
  const outputProblems = Array.isArray(attempt.output?.problems) ? attempt.output.problems : [];
  for (const problem of outputProblems) {
    if (typeof problem === "string" && problem.length > 0) {
      problems.push(problem);
    }
  }
  if (attempt.error) {
    problems.push(attempt.error);
  }
  return dedupe(problems);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    ordered.push(item);
  }
  return ordered;
}

function routeLabel(attempt: Attempt): string | null {
  const route = attempt.input.route;
  if (route && typeof route === "object") {
    const record = route as Record<string, unknown>;
    const executionMode = stringOrNull(record.executionMode);
    if (executionMode) {
      return executionMode;
    }
    const backend = record.backend;
    if (backend && typeof backend === "object") {
      const kind = stringOrNull((backend as Record<string, unknown>).kind);
      if (kind) {
        return kind;
      }
    }
  }
  const directBackend = stringOrNull(attempt.input.backend);
  if (directBackend) {
    return directBackend;
  }
  return null;
}

function modelLabel(raw: unknown): string | null {
  if (typeof raw === "string") {
    return stringOrNull(raw);
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (typeof record.model === "string") {
      return stringOrNull(record.model);
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}
