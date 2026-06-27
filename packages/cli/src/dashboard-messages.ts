import type { RunOverview } from "@ouroboros/harness";

export type ChatMessagePartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "approval-requested"
  | "active"
  | "done"
  | "error";

export type ChatMessagePartType =
  | "text"
  | "reasoning"
  | "tool-input"
  | "tool-output"
  | "approval"
  | "interruption"
  | "check"
  | "evidence"
  | "error"
  | "raw";

export interface ChatMessagePartBase {
  type: ChatMessagePartType;
  state: ChatMessagePartState;
  label?: string;
  text?: string;
  name?: string;
  raw?: unknown;
}

export interface ChatTextPart extends ChatMessagePartBase {
  type: "text";
  state: "active" | "done";
}

export interface ChatReasoningPart extends ChatMessagePartBase {
  type: "reasoning";
  state: "active" | "done";
}

export interface ChatToolInputPart extends ChatMessagePartBase {
  type: "tool-input";
  state: "input-streaming" | "input-available";
}

export interface ChatToolOutputPart extends ChatMessagePartBase {
  type: "tool-output";
  state: "output-available" | "output-error";
}

export interface ChatApprovalPart extends ChatMessagePartBase {
  type: "approval";
  state: "approval-requested" | "active" | "done";
}

export interface ChatInterruptionPart extends ChatMessagePartBase {
  type: "interruption";
  state: "active" | "done";
}

export interface ChatCheckPart extends ChatMessagePartBase {
  type: "check";
  state: "active" | "done";
}

export interface ChatEvidencePart extends ChatMessagePartBase {
  type: "evidence";
  state: "active" | "done";
}

export interface ChatErrorPart extends ChatMessagePartBase {
  type: "error";
  state: "error";
}

export interface ChatRawPart extends ChatMessagePartBase {
  type: "raw";
  state: "active" | "done";
}

export type ChatMessagePart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatToolInputPart
  | ChatToolOutputPart
  | ChatApprovalPart
  | ChatInterruptionPart
  | ChatCheckPart
  | ChatEvidencePart
  | ChatErrorPart
  | ChatRawPart;

export type ChatRole =
  | "user"
  | "goal"
  | "assistant"
  | "tool"
  | "system"
  | "human";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: ChatMessagePart[];
  createdAt?: string | null;
  source?: {
    taskId?: string;
    attemptId?: string;
    role?: string;
  };
}

export interface ChatSessionLike {
  taskId?: string;
  taskGoal?: string;
  role?: string;
  status?: string;
  attemptId?: string;
  sessionName?: string | null;
  codexSessionId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  latestText?: string | null;
  events?: Array<{ text?: string | null; stream?: string; payload?: unknown }>;
  output?: {
    summary?: string | null;
    problems?: unknown[];
    checks?: unknown[];
    artifacts?: unknown[];
    changedFiles?: unknown[];
  } | null;
}

export interface ChatGroupLike {
  id: string;
  titleTask: { goal: string };
  root: { prompt: string };
  tasks: Array<{
    id: string;
    role: string;
    goal: string;
    status: string;
  }>;
  sessions: ChatSessionLike[];
  lessons?: Array<{ kind: string; summary: string; taskId: string; attemptId: string }>;
  status?: string;
}

function clampText(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value).replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join(" ");
  const record = value as Record<string, unknown>;
  const preferred = ["summary", "message", "text", "output", "error", "details", "name", "status"];
  for (const key of preferred) {
    const candidate = readString(record[key]).trim();
    if (candidate) return candidate;
  }
  return "";
}

function summarizeArguments(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return clampText(trimmed, 200);
  }
  if (!parsed || typeof parsed !== "object") return clampText(String(parsed), 200);
  if (Array.isArray(parsed)) return clampText(parsed.map(textFromUnknown).filter(Boolean).join(" "), 200);
  const record = parsed as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.input;
  if (Array.isArray(command)) {
    return clampText(command.map(textFromUnknown).filter(Boolean).join(" "), 200);
  }
  if (typeof command === "string") return clampText(command, 200);
  const path = record.path ?? record.file;
  if (typeof path === "string") return clampText(path, 200);
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    pairs.push(`${key}: ${clampText(textFromUnknown(value), 90)}`);
    if (pairs.length >= 3) break;
  }
  return clampText(pairs.join(" · "), 200);
}

/**
 * Map a single Codex/ACP/JSON event payload into a structured message part.
 * Returns null when no structured mapping exists so callers can fall back to raw details.
 */
export function codexEventToMessagePart(payload: unknown): ChatMessagePart | null {  if (!isRecord(payload)) return null;
  const type = readString(payload.type);
  const item = isRecord(payload.item) ? payload.item : null;

  if (item) {
    const itemType = readString(item.type);
    if (itemType === "message") {
      const role = readString(item.role) || "message";
      const content = readStringArray(item.content);
      const text = content
        .map((part) => {
          if (!isRecord(part)) return "";
          return readString(part.text) || readString(part.output);
        })
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return null;
      return {
        type: "text",
        state: "done",
        label: role,
        text,
      } satisfies ChatTextPart;
    }
    if (itemType === "function_call" || itemType === "tool_call") {
      const name = readString(item.name) || "tool";
      const summary = summarizeArguments(item.arguments) || "(invoked)";
      return {
        type: "tool-input",
        state: "input-available",
        label: name,
        name,
        text: summary,
        raw: item,
      } satisfies ChatToolInputPart;
    }
    if (itemType === "function_call_output" || itemType === "tool_call_output") {
      const output = readString(item.output).replace(/\s+/g, " ").trim();
      if (!output) return null;
      const isError = /error|failed|exception|traceback/i.test(output);
      return {
        type: "tool-output",
        state: isError ? "output-error" : "output-available",
        label: "tool output",
        text: clampText(output, 480),
        raw: item,
      } satisfies ChatToolOutputPart;
    }
    if (itemType === "reasoning") {
      const summary = readStringArray(item.summary);
      const text = summary
        .map((part) => {
          if (!isRecord(part)) return "";
          return readString(part.text) || readString(part.summary);
        })
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return null;
      return {
        type: "reasoning",
        state: "done",
        label: "thinking",
        text,
      } satisfies ChatReasoningPart;
    }
    if (itemType === "approval_request" || itemType === "approval") {
      const summary = readString(item.summary) || readString(item.reason) || readString(item.message);
      return {
        type: "approval",
        state: "approval-requested",
        label: "approval",
        text: summary || "Approval requested",
        raw: item,
      } satisfies ChatApprovalPart;
    }
  }

  if (type === "response.output_text.delta" || type === "response.output_text.done") {
    const delta = readString(payload.delta).replace(/\s+/g, " ").trim();
    if (!delta) return null;
    return {
      type: "text",
      state: type.endsWith(".delta") ? "active" : "done",
      label: "assistant",
      text: delta,
    } satisfies ChatTextPart;
  }
  // AI SDK UI stream chunk: reasoning-start / response.reasoning.start
  // Emits an active reasoning marker even without delta text so the UI can
  // surface the reasoning state at the start of a thinking span.
  if (type === "reasoning-start" || type === "response.reasoning.start" || type === "response.reasoning_text.start") {
    const delta = readString(payload.delta).replace(/\s+/g, " ").trim();
    return {
      type: "reasoning",
      state: "active",
      label: "thinking",
      text: delta,
    } satisfies ChatReasoningPart;
  }
  // AI SDK UI stream chunk: reasoning-delta / response.reasoning.delta
  if (type === "reasoning-delta" || type === "response.reasoning.delta" || type === "response.reasoning_text.delta") {
    const delta = readString(payload.delta).replace(/\s+/g, " ").trim();
    if (!delta) return null;
    return {
      type: "reasoning",
      state: "active",
      label: "thinking",
      text: delta,
    } satisfies ChatReasoningPart;
  }
  // AI SDK UI stream chunk: reasoning-end / response.reasoning.end
  // Closes the reasoning span even without delta text so the UI can mark the
  // thinking state as done.
  if (type === "reasoning-end" || type === "response.reasoning.end" || type === "response.reasoning_text.end") {
    const delta = readString(payload.delta).replace(/\s+/g, " ").trim();
    return {
      type: "reasoning",
      state: "done",
      label: "thinking",
      text: delta,
    } satisfies ChatReasoningPart;
  }
  if (type === "response.function_call_arguments.delta" || type === "response.function_call.delta" || type === "tool-input-start") {
    const delta = readString(payload.delta).replace(/\s+/g, " ").trim();
    if (!delta) return null;
    const name = readString(payload.name) || "tool";
    return {
      type: "tool-input",
      state: "input-streaming",
      label: name,
      name,
      text: delta,
    } satisfies ChatToolInputPart;
  }
  if (type === "tool-input-available" || type === "response.function_call_arguments.done") {
    const name = readString(payload.name) || "tool";
    const text = readString(payload.arguments) || readString(payload.delta);
    return {
      type: "tool-input",
      state: "input-available",
      label: name,
      name,
      text: summarizeArguments(text) || "(invoked)",
    } satisfies ChatToolInputPart;
  }
  if (type === "tool-output-available" || type === "tool.call.output") {
    const output = readString(payload.output).replace(/\s+/g, " ").trim();
    if (!output) return null;
    const isError = /error|failed|exception|traceback/i.test(output);
    return {
      type: "tool-output",
      state: isError ? "output-error" : "output-available",
      label: "tool output",
      text: clampText(output, 480),
    } satisfies ChatToolOutputPart;
  }
  if (type === "tool-output-error" || type === "tool.call.error") {
    const message = readString(payload.error) || readString(payload.message);
    return {
      type: "tool-output",
      state: "output-error",
      label: "tool output",
      text: message || "tool error",
    } satisfies ChatToolOutputPart;
  }
  if (type === "session.created" || type === "session.updated" || type === "session.completed") {
    const action = type.split(".")[1] || "started";
    return {
      type: "check",
      state: "active",
      label: "session",
      text: action,
    } satisfies ChatCheckPart;
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return {
      type: "error",
      state: "error",
      label: "error",
      text: payload.error.trim(),
    } satisfies ChatErrorPart;
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return {
      type: "text",
      state: "done",
      label: "message",
      text: payload.message.trim(),
    } satisfies ChatTextPart;
  }
  if (typeof payload.delta === "string" && payload.delta.trim()) {
    return {
      type: "text",
      state: "active",
      label: "delta",
      text: payload.delta.trim(),
    } satisfies ChatTextPart;
  }
  return null;
}

/**
 * Convert a raw event (text + payload) into a chat message part. Falls back to a
 * raw-stamped part for stdout/stderr that does not match a structured shape.
 */
export function eventToMessagePart(event: {
  text?: string | null;
  stream?: string;
  payload?: unknown;
}): ChatMessagePart | null {
  const structured = codexEventToMessagePart(event.payload);
  if (structured) return structured;
  const text = readString(event.text).trim();
  if (!text) return null;
  const stream = readString(event.stream) || "stdout";
  if (stream === "stderr") {
    return {
      type: "error",
      state: "error",
      label: "stderr",
      text: clampText(text, 480),
    } satisfies ChatErrorPart;
  }
  return {
    type: "raw",
    state: "active",
    label: stream || "log",
    text: clampText(text, 480),
  } satisfies ChatRawPart;
}

function evidenceItems(items: unknown): Array<{ summary: string; meta: string }> {
  const list = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined) : [];
  return list.map((item) => {
    if (typeof item === "string") return { summary: item, meta: "" };
    if (!isRecord(item)) return { summary: textFromUnknown(item), meta: "" };
    const summary = readString(item.summary) || textFromUnknown(item);
    const metaParts: string[] = [];
    if (item.status) metaParts.push(String(item.status));
    if (item.name && item.summary) metaParts.push(String(item.name));
    if (item.kind && item.path) metaParts.push(`${item.kind} · ${item.path}`);
    return { summary, meta: metaParts.join(" · ") };
  });
}

function sessionToMessage(session: ChatSessionLike, sequence: number): ChatMessage {
  const parts: ChatMessagePart[] = [];
  const events = Array.isArray(session.events) ? session.events : [];
  for (const event of events) {
    const part = eventToMessagePart(event);
    if (part) parts.push(part);
  }
  if (session.output?.summary) {
    parts.unshift({
      type: "text",
      state: "done",
      label: "summary",
      text: readString(session.output.summary).replace(/\s+/g, " ").trim(),
    });
  }
  const checks = evidenceItems(session.output?.checks);
  for (const check of checks) {
    parts.push({
      type: "check",
      state: "active",
      label: "check",
      text: check.summary,
      raw: check.meta || undefined,
    } satisfies ChatCheckPart);
  }
  const problems = evidenceItems(session.output?.problems);
  for (const problem of problems) {
    parts.push({
      type: "evidence",
      state: "active",
      label: "problem",
      text: problem.summary,
    } satisfies ChatEvidencePart);
  }
  const status = readString(session.status) || "running";
  if (status === "blocked" || status === "interrupted") {
    parts.push({
      type: "interruption",
      state: "active",
      label: status,
      text: session.latestText ? clampText(session.latestText, 200) : `${status} session`,
    } satisfies ChatInterruptionPart);
  }
  return {
    id: `session:${session.attemptId || `seq-${sequence}`}`,
    role: "assistant",
    parts: parts.length
      ? parts
      : [
          {
            type: "text",
            state: "done",
            label: "session",
            text: "No structured output recorded yet.",
          } satisfies ChatTextPart,
        ],
    createdAt: session.finishedAt || session.startedAt || null,
    source: {
      taskId: session.taskId,
      attemptId: session.attemptId,
      role: session.role,
    },
  };
}

/**
 * Build a chronological AI SDK-style chat transcript from a goal group.
 * Oldest message first, newest last. Returns the message list plus
 * any pending flow (tasks without sessions) as their own messages.
 */
export function buildChatTranscript(group: ChatGroupLike | null): ChatMessage[] {
  if (!group) return [];
  const messages: ChatMessage[] = [];
  messages.push({
    id: `goal:${group.id}`,
    role: "goal",
    parts: [
      {
        type: "text",
        state: "done",
        label: "Run goal",
        text: readString(group.titleTask?.goal).trim() || "(no goal)",
      },
      {
        type: "text",
        state: "done",
        label: "Prompt",
        text: clampText(group.root?.prompt, 360),
      },
    ],
  });
  const sessions = [...(group.sessions || [])].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt || "") || 0;
    const rightTime = Date.parse(right.startedAt || "") || 0;
    return leftTime - rightTime;
  });
  const sessionTaskIds = new Set(sessions.map((session) => session.taskId).filter(Boolean));
  sessions.forEach((session, index) => {
    messages.push(sessionToMessage(session, index));
  });
  for (const task of group.tasks || []) {
    if (sessionTaskIds.has(task.id)) continue;
    if (task.status !== "todo" && task.status !== "running") continue;
    messages.push({
      id: `task:${task.id}`,
      role: "system",
      parts: [
        {
          type: "text",
          state: task.status === "running" ? "active" : "done",
          label: task.role,
          text: readString(task.goal),
        },
      ],
      source: { taskId: task.id, role: task.role },
    });
  }
  return messages;
}

/**
 * Decide whether the composer should route a new instruction as an
 * interrupt (active run or running session) or fall back to a fresh intake.
 */
export function shouldRouteInterrupt(overview: RunOverview | null, group: ChatGroupLike | null): boolean {
  if (!overview) return false;
  const runStatus = overview.run?.status;
  if (runStatus === "running") return true;
  const sessions = overview.sessions || [];
  if (sessions.some((session) => session.status === "running")) return true;
  const tasks = overview.tasks || [];
  if (tasks.some((task) => task.status === "running" || task.status === "todo")) return true;
  if (group) {
    const groupTaskIds = new Set((group.tasks || []).map((task) => task.id));
    if (sessions.some((session) => groupTaskIds.has(session.taskId) && session.status === "running")) {
      return true;
    }
  }
  return false;
}

export {
  codexEventToMessagePart as codexEventToMessagePartForTest,
  eventToMessagePart as eventToMessagePartForTest,
  buildChatTranscript as buildChatTranscriptForTest,
  shouldRouteInterrupt as shouldRouteInterruptForTest,
};
