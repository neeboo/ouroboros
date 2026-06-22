import { diagnoseRunOverview, isOuroborosRuntimePath, readableValue } from "@ouroboros/harness";
import type { OverseerDiagnosis, RunOverview, RunStatusCounts } from "@ouroboros/harness";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_REACT_MODULES } from "./dashboard-app";
import { summarizeOverseerDiagnosis } from "./run-evidence";

interface DashboardActionResult {
  attemptId?: string;
  runId?: string;
  taskId?: string;
  proposalId?: string;
  status?: string;
  interrupted?: number;
  pid?: number;
}

interface DashboardIntakeAttachment {
  name?: string;
  type?: string;
  size?: number;
  content?: string;
}

interface DashboardActions {
  createGoal?: (goal: string) => DashboardActionResult;
  interruptAndCreateGoal?: (goal: string) => DashboardActionResult;
  resumeTask?: (taskId: string) => DashboardActionResult;
  rerunTask?: (taskId: string) => DashboardActionResult;
  stopAttempt?: (attemptId: string) => DashboardActionResult;
  startRunner?: () => DashboardActionResult;
  stopRunner?: () => DashboardActionResult;
  startSupervisor?: () => DashboardActionResult;
  stopSupervisor?: () => DashboardActionResult;
  createIntake?: (document: string, title?: string) => DashboardActionResult | Promise<DashboardActionResult>;
  acceptGuardrailProposal?: (proposalId: string, acceptedBy?: string) => DashboardActionResult | Promise<DashboardActionResult>;
}

type DashboardAutoStartRunner = (overview: RunOverview, runner: DashboardRunnerStatus | null) => boolean;

interface DashboardRunnerStatus {
  status: "idle" | "running" | "exited";
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  lastOutput?: string;
  externallyManaged?: boolean;
}

export interface DashboardRunSummary {
  id: string;
  status: string;
  goal: string;
  projectId: string | null;
  createdAt: string | null;
}

const DASHBOARD_RUNS_HISTORY_LIMIT_MAX = 100;
const DASHBOARD_RUNS_HISTORY_LIMIT_DEFAULT = 10;
const DASHBOARD_RUN_SUMMARY_GOAL_MAX = 140;

interface DashboardTaskGraphNode {
  id: string;
  type: "task";
  position: { x: number; y: number };
  data: {
    role: string;
    status: string;
    goal: string;
    taskId: string;
    doneWhenCount: number;
    latestSession: {
      status: string;
      attemptId: string;
      sessionName: string | null;
      codexSessionId: string | null;
      latestText: string;
      model: Record<string, unknown> | null;
    } | null;
  };
}

interface DashboardTaskGraphEdge {
  id: string;
  source: string;
  target: string;
  label: "dependsOn" | "parentId" | "created" | "reviews";
  type: "smoothstep";
  animated: boolean;
  markerEnd: { type: "arrowclosed" };
}

export interface DashboardTaskGraph {
  nodes: DashboardTaskGraphNode[];
  edges: DashboardTaskGraphEdge[];
}

export function buildDashboardTaskGraph(overview: RunOverview, groupId?: string | null): DashboardTaskGraph {
  const selectedTaskIds = collectRelatedTaskIds(overview, groupId);
  const selectedTasks = overview.tasks.filter((task) => selectedTaskIds.has(task.id));
  const taskIds = new Set(selectedTasks.map((task) => task.id));
  const latestSessionByTask = new Map(
    overview.sessions
      .filter((session) => taskIds.has(session.taskId))
      .map((session) => [
        session.taskId,
        {
          status: session.status,
          attemptId: session.attemptId,
          sessionName: session.sessionName,
          codexSessionId: session.codexSessionId,
          latestText: session.latestText,
          model: session.model,
        },
      ]),
  );
  const columns = new Map<string, number>();
  const nodes = selectedTasks.map((task, index) => {
    const column = roleColumn(task.role);
    const row = columns.get(column) ?? 0;
    columns.set(column, row + 1);
    return {
      id: task.id,
      type: "task" as const,
      position: { x: columnX(column), y: row * 190 + (index % 2) * 12 },
      data: {
        role: task.role,
        status: task.status,
        goal: compactText(task.goal, 118),
        taskId: task.id,
        doneWhenCount: Array.isArray(task.doneWhen) ? task.doneWhen.length : 0,
        latestSession: latestSessionByTask.get(task.id) ?? null,
      },
    };
  });
  const edges = graphRelations(overview)
    .filter((relation) => taskIds.has(relation.sourceId) && taskIds.has(relation.targetId))
    .map((relation) =>
      taskGraphEdge(
        relation.kind,
        relation.sourceId,
        relation.targetId,
        selectedTasks.some((task) => task.id === relation.targetId && task.status === "running"),
      ),
    );
  return { nodes, edges };
}

export function aggregateDashboardOverview(rootOverview: RunOverview, childOverviews: RunOverview[] = []): RunOverview {
  const activeChildOverviews = childOverviews.filter((overview) => !isRetiredRun(overview.run));
  if (activeChildOverviews.length === 0) {
    return rootOverview;
  }
  const overviews = [rootOverview, ...activeChildOverviews];
  const tasks = uniqueDashboardItems(overviews.flatMap((overview) => overview.tasks));
  const sessions = uniqueDashboardItems(overviews.flatMap((overview) => overview.sessions), (session) => session.attemptId);
  const threads = uniqueDashboardItems(overviews.flatMap((overview) => overview.threads));
  const lessons = uniqueDashboardItems(overviews.flatMap((overview) => overview.lessons));
  const run = rootOverview.run
    ? {
      ...rootOverview.run,
      status: aggregateDashboardRunStatus(overviews, tasks, sessions, threads),
    }
    : null;
  return {
    ...rootOverview,
    run,
    tasks,
    sessions,
    threads,
    lessons,
  };
}

export interface DashboardOverseerDiagnosis {
  state: OverseerDiagnosis["state"];
  reason: string;
  activeWork: {
    readyTaskIds: string[];
    runningTaskIds: string[];
  };
  runningAttempts: Array<{
    attemptId: string;
    taskId: string;
    role: string;
    codexSessionId: string | null;
    sessionName: string | null;
    backend: Record<string, unknown> | null;
    cwd: string | null;
    worktreePath: string | null;
  }>;
  orphanedLeases: Array<{
    taskId: string;
    sessionRef: string | null;
    worktreePath: string | null;
    reason: string;
  }>;
  queueStarvation: boolean;
  emptyRunGoalReviewRaceRisk: boolean;
}

export function overviewDiagnosisForResponse(overview: RunOverview): DashboardOverseerDiagnosis {
  const diagnosis = diagnoseRunOverview(overview);
  return {
    ...summarizeOverseerDiagnosis(diagnosis),
    activeWork: diagnosis.activeWork,
    runningAttempts: diagnosis.runningAttempts.map((session) => ({
      attemptId: session.attemptId,
      taskId: session.taskId,
      role: session.role,
      codexSessionId: session.codexSessionId,
      sessionName: session.sessionName,
      backend: session.backend,
      cwd: session.cwd,
      worktreePath: session.worktreePath,
    })),
    orphanedLeases: diagnosis.orphanedLeases,
    queueStarvation: diagnosis.queueStarvation,
    emptyRunGoalReviewRaceRisk: diagnosis.emptyRunGoalReviewRaceRisk,
  };
}

function isRetiredRun(run: RunOverview["run"]) {
  return run?.context?.retired === true;
}

function uniqueDashboardItems<T>(
  items: T[],
  keyFor: (item: T) => string | null | undefined = (item) => {
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  },
) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function aggregateDashboardRunStatus(
  overviews: RunOverview[],
  tasks: RunOverview["tasks"],
  sessions: RunOverview["sessions"],
  threads: RunOverview["threads"],
): NonNullable<RunOverview["run"]>["status"] {
  const runs = overviews.map((overview) => overview.run).filter((run): run is NonNullable<RunOverview["run"]> => run !== null);
  if (runs.length > 0 && runs.every((run) => run.status === "done")) {
    return "done";
  }
  if (
    tasks.some((task) => task.status === "running") ||
    sessions.some((session) => session.status === "running") ||
    threads.some((thread) => thread.status === "running") ||
    runs.some((run) => run.status === "running")
  ) {
    return "running";
  }
  if (tasks.some((task) => task.status === "todo") || runs.some((run) => run.status === "todo")) {
    return "todo";
  }
  if (tasks.some((task) => task.status === "blocked") || runs.some((run) => run.status === "blocked")) {
    return "blocked";
  }
  return "done";
}

function inferDashboardSupervisorStatus(
  supervisor: DashboardRunnerStatus | null,
  overview: RunOverview,
  globalRuns: RunStatusCounts,
): DashboardRunnerStatus | null {
  if (supervisor?.status === "running") {
    return supervisor;
  }
  const activeThreads = overview.threads.filter((thread) => thread.status === "running");
  const activeTasks = overview.tasks.filter((task) => task.status === "running");
  const hasQueuedGlobalRuns = (globalRuns.todo || 0) > 0 || (globalRuns.running || 0) > 0;
  if (overview.run?.status === "done" && !hasQueuedGlobalRuns && activeTasks.length === 0) {
    return supervisor;
  }
  if (activeThreads.length > 0 || activeTasks.length > 0) {
    return {
      ...(supervisor ?? {}),
      status: "running",
      pid: supervisor?.pid ?? activeThreads.find((thread) => thread.pid)?.pid ?? null,
      lastOutput: supervisor?.lastOutput || "External supervisor inferred from active tasks.",
      externallyManaged: true,
    };
  }
  if (supervisor) {
    return supervisor;
  }
  if (hasQueuedGlobalRuns) {
    return {
      status: "idle",
      pid: null,
      lastOutput: "",
    };
  }
  return null;
}

function collectRelatedTaskIds(overview: RunOverview, groupId?: string | null) {
  if (!groupId) {
    return new Set(overview.tasks.map((task) => task.id));
  }
  const seeds = overview.tasks
    .filter((task) => task.id === groupId || (task.cycleId || task.id) === groupId)
    .map((task) => task.id);
  const related = new Set(seeds.length ? seeds : [groupId]);
  const adjacency = new Map<string, Set<string>>();
  const link = (sourceId: string, targetId: string) => {
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  };
  for (const relation of graphRelations(overview)) {
    link(relation.sourceId, relation.targetId);
  }
  const queue = [...related];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (!related.has(next)) {
        related.add(next);
        queue.push(next);
      }
    }
  }
  return related;
}

function graphRelations(overview: RunOverview) {
  const taskIds = new Set(overview.tasks.map((task) => task.id));
  const relations: Array<{ kind: DashboardTaskGraphEdge["label"]; sourceId: string; targetId: string }> = [];
  const seen = new Set<string>();
  const add = (kind: DashboardTaskGraphEdge["label"], sourceId: unknown, targetId: unknown) => {
    if (typeof sourceId !== "string" || typeof targetId !== "string") return;
    if (!taskIds.has(sourceId) || !taskIds.has(targetId) || sourceId === targetId) return;
    const pairKey = `${sourceId}->${targetId}`;
    const key = `${kind}:${pairKey}`;
    if (seen.has(key)) return;
    if (kind === "created" && relations.some((relation) => `${relation.sourceId}->${relation.targetId}` === pairKey)) return;
    seen.add(key);
    relations.push({ kind, sourceId, targetId });
  };

  for (const task of overview.tasks) {
    for (const sourceId of task.dependsOn || []) add("dependsOn", sourceId, task.id);
    if (task.parentId) add("parentId", task.parentId, task.id);
  }

  for (const session of overview.sessions) {
    const artifacts = Array.isArray(session.output?.artifacts) ? session.output.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const record = artifact as Record<string, unknown>;
      add("created", record.sourceTaskId, record.taskId);
    }
  }

  for (const task of overview.tasks) {
    if (task.role !== "goal-review") continue;
    const hasRelation = relations.some((relation) => relation.sourceId === task.id || relation.targetId === task.id);
    if (hasRelation) continue;
    const taskIndex = overview.tasks.findIndex((candidate) => candidate.id === task.id);
    const previous = [...overview.tasks.slice(0, taskIndex)]
      .reverse()
      .find((candidate) => candidate.role !== "goal-review");
    if (previous) add("reviews", previous.id, task.id);
  }

  return relations;
}

function taskGraphEdge(
  label: DashboardTaskGraphEdge["label"],
  source: string,
  target: string,
  animated: boolean,
): DashboardTaskGraphEdge {
  return {
    id: `${label}:${source}->${target}`,
    source,
    target,
    label,
    type: "smoothstep",
    animated,
    markerEnd: { type: "arrowclosed" },
  };
}

function roleColumn(role: string) {
  if (role === "planner" || role === "goal-review") return "planner";
  if (role === "verifier") return "verifier";
  return "worker";
}

function columnX(column: string) {
  if (column === "planner") return 0;
  if (column === "verifier") return 720;
  return 360;
}

function compactText(value: string, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function dashboardEvidenceItemTextForTest(item: unknown) {
  return dashboardEvidenceItemText(item);
}

function dashboardEvidenceItemText(item: unknown) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return readableValue(item);
  }
  const record = item as Record<string, unknown>;
  if ("summary" in record) {
    const summary = readableValue(record.summary);
    if (summary) {
      return summary;
    }
  }
  return readableValue(item);
}

export interface DashboardEventLine {
  category: string;
  label: string;
  text: string;
}

export function dashboardCodexEventPartsForTest(payload: unknown): DashboardEventLine | null {
  return dashboardCodexEventParts(payload);
}

function dashboardCodexEventParts(payload: unknown): DashboardEventLine | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const item = record.item && typeof record.item === "object" ? (record.item as Record<string, unknown>) : null;
  if (item) {
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "message") {
      const role = typeof item.role === "string" && item.role ? item.role : "message";
      const content = Array.isArray(item.content) ? item.content : [];
      const parts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const piece = part as Record<string, unknown>;
        const text = typeof piece.text === "string" ? piece.text
          : typeof piece.output === "string" ? piece.output
          : "";
        if (text.trim()) parts.push(text.trim());
      }
      if (parts.length === 0) return null;
      return { category: "message", label: role, text: parts.join(" ").replace(/\s+/g, " ") };
    }
    if (itemType === "function_call" || itemType === "tool_call") {
      const name = typeof item.name === "string" && item.name ? item.name : "tool";
      const summary = dashboardSummarizeToolArguments(item.arguments);
      return { category: "tool", label: name, text: summary || "(invoked)" };
    }
    if (itemType === "function_call_output" || itemType === "tool_call_output") {
      const raw = typeof item.output === "string" ? item.output : "";
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { category: "tool-output", label: "tool output", text };
    }
    if (itemType === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const parts: string[] = [];
      for (const part of summary) {
        if (!part || typeof part !== "object") continue;
        const piece = part as Record<string, unknown>;
        const text = typeof piece.text === "string" ? piece.text
          : typeof piece.summary === "string" ? piece.summary
          : "";
        if (text.trim()) parts.push(text.trim());
      }
      if (parts.length === 0) return null;
      return { category: "thinking", label: "thinking", text: parts.join(" ").replace(/\s+/g, " ") };
    }
  }
  if (type === "session.created" || type === "session.updated" || type === "session.completed") {
    const action = type.split(".")[1] || "started";
    return { category: "session", label: "session", text: action };
  }
  if (type === "response.output_text.delta" || type === "response.output_text.done") {
    const delta = typeof record.delta === "string" ? record.delta : "";
    const text = delta.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { category: "message", label: "assistant", text };
  }
  if (type === "response.reasoning.delta" || type === "response.reasoning_text.delta") {
    const delta = typeof record.delta === "string" ? record.delta : "";
    const text = delta.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { category: "thinking", label: "thinking", text };
  }
  if (type === "response.function_call_arguments.delta" || type === "response.function_call.delta") {
    const delta = typeof record.delta === "string" ? record.delta : "";
    const text = delta.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { category: "tool", label: "tool", text };
  }
  if (typeof record.delta === "string" && record.delta.trim()) {
    return { category: "message", label: "delta", text: record.delta.trim() };
  }
  if (typeof record.message === "string" && record.message.trim()) {
    return { category: "message", label: "message", text: record.message.trim() };
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return { category: "error", label: "error", text: record.error.trim() };
  }
  return null;
}

function dashboardSummarizeToolArguments(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return dashboardClampText(trimmed, 180);
  }
  if (!parsed || typeof parsed !== "object") return dashboardClampText(String(parsed), 180);
  if (Array.isArray(parsed)) {
    return dashboardClampText(parsed.map((value) => readableValue(value)).filter(Boolean).join(" "), 180);
  }
  const record = parsed as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.input;
  if (Array.isArray(command)) {
    return dashboardClampText(command.map((part) => readableValue(part)).filter(Boolean).join(" "), 180);
  }
  if (typeof command === "string") return dashboardClampText(command, 180);
  const path = record.path ?? record.file;
  if (typeof path === "string") return dashboardClampText(path, 180);
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    pairs.push(key + ": " + dashboardClampText(readableValue(value), 90));
    if (pairs.length >= 3) break;
  }
  return dashboardClampText(pairs.join(" · "), 180);
}

function dashboardClampText(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function dashboardEventLineForTest(event: { text?: string | null; stream?: string; payload?: unknown }): DashboardEventLine | null {
  if (event.text && String(event.text).trim()) {
    const stream = typeof event.stream === "string" ? event.stream : "stdout";
    return { category: stream === "stderr" ? "error" : "other", label: stream === "stderr" ? "stderr" : "log", text: String(event.text).trim() };
  }
  const parts = dashboardCodexEventParts(event.payload);
  if (parts) return parts;
  const record = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  for (const key of ["delta", "message", "text", "content"]) {
    if (typeof record[key] === "string" && (record[key] as string).trim()) {
      return { category: "other", label: key, text: (record[key] as string).trim() };
    }
  }
  return null;
}

export function dashboardHtml(input: { runId: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ouroboros Dashboard</title>
  <meta name="ouroboros-dashboard-react-modules" content="${escapeHtml(DASHBOARD_REACT_MODULES.map((module) => module.id).join(","))}">
  <link rel="stylesheet" href="/assets/dashboard-canvas.css">
  <style>
    :root {
      color-scheme: light;
      font-family: "Aptos", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      --app: #121212;
      --sidebar: #30302f;
      --sidebar-soft: #3a3a38;
      --panel: #252524;
      --panel-soft: #2f2f2e;
      --canvas: #151515;
      --canvas-soft: #1d1d1c;
      --line: rgba(255, 255, 255, 0.1);
      --line-strong: rgba(255, 255, 255, 0.18);
      --ink: #f0f0eb;
      --muted: #aaa9a3;
      --muted-2: #787772;
      --ok: #b8d4c2;
      --warn: #d4c7a8;
      --danger: #d2aaa8;
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      color: var(--ink);
      background: var(--app);
    }
    * { box-sizing: border-box; }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
    }
    *::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    *::-webkit-scrollbar-track {
      background: transparent;
    }
    *::-webkit-scrollbar-thumb {
      min-height: 44px;
      border: 4px solid transparent;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      background-clip: padding-box;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
      background-clip: padding-box;
    }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100dvh;
      overflow: hidden;
      background: var(--app);
    }
    .app-shell {
      height: 100dvh;
      min-height: 100dvh;
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr) clamp(380px, 30vw, 520px);
      overflow-x: hidden;
      background: var(--app);
    }
    .task-sidebar {
      height: 100dvh;
      display: grid;
      grid-template-rows: auto auto 1fr;
      min-width: 0;
      min-height: 0;
      padding: 14px 10px;
      background: linear-gradient(180deg, #313130, #565652);
      border-right: 1px solid rgba(255, 255, 255, 0.12);
      overflow: hidden;
    }
    .sidebar-head {
      padding: 2px 6px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .run-status {
      min-width: 0;
      max-width: 160px;
      padding: 0;
      border: 0;
      color: var(--ok);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .run-status.updating::after {
      content: "";
      display: inline-block;
      width: 4px;
      height: 4px;
      margin-left: 7px;
      border-radius: 999px;
      background: currentColor;
      vertical-align: middle;
      animation: breathe 1.2s ease-in-out infinite;
    }
    #run-title {
      margin-top: 10px;
      color: #d0d0c9;
      font-size: 14px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .project-title {
      margin-top: 7px;
      color: #aaa9a3;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.45;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-header {
      min-width: 0;
      overflow: hidden;
    }
    .project-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-root {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .intake-composer {
      display: grid;
      gap: 8px;
      margin-top: 16px;
    }
    .intake-label {
      color: #bab9b2;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .intake-input {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      padding: 10px 11px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      outline: 0;
      background: rgba(18, 18, 18, 0.3);
      color: #f0f0eb;
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
    }
    .intake-input:focus {
      border-color: rgba(255, 255, 255, 0.32);
      background: rgba(18, 18, 18, 0.44);
    }
    .intake-actions {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 8px;
      align-items: center;
    }
    .attachment-chips {
      min-height: 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .attachment-chip {
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: #d7d6cf;
      background: rgba(255, 255, 255, 0.06);
      font-size: 11px;
      line-height: 1.3;
    }
    .attachment-chip span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attachment-chip button {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: inherit;
      cursor: pointer;
    }
    .plain-button {
      min-width: 0;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
      color: #efeee9;
      font: inherit;
      font-size: 12px;
      font-weight: 680;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .plain-button:hover {
      background: rgba(255, 255, 255, 0.11);
      border-color: rgba(255, 255, 255, 0.24);
    }
    .plain-button:active {
      transform: scale(0.98);
    }
    .plain-button.secondary {
      color: #d7d6cf;
      background: transparent;
    }
    .plain-button.danger {
      color: #ead2d0;
      border-color: rgba(210, 170, 168, 0.32);
      background: rgba(210, 170, 168, 0.08);
    }
    .plain-button.danger:hover {
      border-color: rgba(210, 170, 168, 0.48);
      background: rgba(210, 170, 168, 0.14);
    }
    .plain-button:disabled {
      cursor: default;
      opacity: 0.45;
      transform: none;
    }
    .form-status {
      min-height: 15px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .sidebar-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0;
      padding: 14px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .stat {
      padding: 9px 10px 11px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .stat b {
      display: block;
      font-family: var(--mono);
      font-size: 24px;
      line-height: 1.1;
      color: #f1f1ec;
    }
    .stat span {
      display: block;
      margin-top: 5px;
      color: #bbbab3;
      font-size: 11px;
      font-weight: 720;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .task-nav {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0 8px 24px 4px;
      scrollbar-gutter: stable;
    }
    .nav-section {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      margin-bottom: 18px;
      overflow-x: hidden;
    }
    .section-label {
      margin: 0 0 8px;
      padding: 0 4px;
      color: #bab9b2;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .task-list {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      display: grid;
      gap: 0;
      overflow-x: hidden;
    }
    .task-row {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);
      gap: 9px;
      align-items: start;
      padding: 10px 6px 11px;
      border: 1px solid transparent;
      border-bottom-color: rgba(255, 255, 255, 0.07);
      border-radius: 0;
      background: transparent;
      color: #e4e3dd;
      text-align: left;
      font: inherit;
      overflow: hidden;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .task-row:hover {
      transform: translateX(2px);
      background: rgba(255, 255, 255, 0.055);
    }
    .task-row:active { transform: translateY(0) scale(0.995); }
    .task-row.selected {
      background: rgba(255, 255, 255, 0.09);
      border-bottom-color: rgba(255, 255, 255, 0.11);
    }
    .task-row-text {
      min-width: 0;
      overflow: hidden;
    }
    .task-row strong {
      display: block;
      min-width: 0;
      color: #f2f1ec;
      font-size: 14px;
      font-weight: 680;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-row .row-meta {
      margin-top: 4px;
      color: #aaa9a2;
      font-size: 11px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-run-row {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 64px) minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 8px 6px 9px;
      border: 1px solid transparent;
      border-bottom-color: rgba(255, 255, 255, 0.07);
      border-radius: 0;
      background: transparent;
      color: #e4e3dd;
      text-align: left;
      font: inherit;
      overflow: hidden;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .history-run-row:hover {
      transform: translateX(2px);
      background: rgba(255, 255, 255, 0.055);
    }
    .history-run-row.is-active {
      background: rgba(255, 255, 255, 0.09);
      border-bottom-color: rgba(255, 255, 255, 0.11);
    }
    .history-run-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      padding: 0 6px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.08);
      color: #f2f1ec;
      white-space: nowrap;
    }
    .history-run-status.status-done { background: rgba(184, 212, 194, 0.22); color: var(--ok); }
    .history-run-status.status-running { background: rgba(212, 199, 168, 0.22); color: var(--warn); }
    .history-run-status.status-blocked { background: rgba(210, 170, 168, 0.22); color: var(--danger); }
    .history-run-status.status-todo { background: rgba(255, 255, 255, 0.08); color: var(--muted); }
    .history-run-goal {
      display: block;
      min-width: 0;
      color: #f2f1ec;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-run-id {
      grid-column: 1 / -1;
      display: block;
      margin-top: 2px;
      color: #787772;
      font-size: 10px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      min-width: 0;
      height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr;
      background: var(--canvas);
      overflow: hidden;
    }
    .workspace-head {
      padding: 24px 44px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(18, 18, 18, 0.88);
      backdrop-filter: blur(12px);
    }
    .workspace-head-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
    }
    .workspace-title-block {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 760px;
    }
    .workspace-kicker {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 740;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .workspace-title {
      margin-top: 8px;
      min-width: 0;
      color: var(--ink);
      font-size: 24px;
      font-weight: 720;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .workspace-title-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    .workspace-title.is-collapsed {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .workspace-title.is-expanded {
      display: block;
      overflow: visible;
    }
    .workspace-title-toggle {
      flex: 0 0 auto;
      min-width: 0;
      min-height: 28px;
      margin-top: 11px;
      padding: 0 9px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.065);
      color: #d8d7d0;
      font: inherit;
      font-size: 11px;
      font-weight: 720;
      cursor: pointer;
    }
    .workspace-title-toggle:hover {
      border-color: rgba(255, 255, 255, 0.26);
      background: rgba(255, 255, 255, 0.11);
    }
    .workspace-title-toggle:focus-visible {
      outline: 2px solid rgba(255, 255, 255, 0.55);
      outline-offset: 2px;
    }
    .workspace-toggle {
      flex: 0 0 auto;
      display: inline-grid;
      grid-template-columns: repeat(2, minmax(72px, 1fr));
      gap: 3px;
      padding: 3px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
    }
    .workspace-toggle button {
      min-width: 0;
      height: 30px;
      padding: 0 13px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #b9b8b1;
      font: inherit;
      font-size: 12px;
      font-weight: 720;
      cursor: pointer;
    }
    .workspace-toggle button.active {
      background: #e3e2dc;
      color: #171716;
      box-shadow: 0 1px 8px rgba(0, 0, 0, 0.24);
    }
    .workspace-flow {
      min-height: 0;
      overflow: auto;
      padding: 38px 48px 128px;
      scrollbar-gutter: stable;
    }
    .workspace-flow.canvas-workspace {
      overflow: hidden;
      padding: 0;
      scrollbar-gutter: auto;
    }
    .flow-inner {
      width: min(100%, 720px);
      min-width: 0;
      margin: 0 auto;
    }
    .transcript {
      display: grid;
    }
    .canvas-inner {
      width: 100%;
      min-height: 0;
      height: 100%;
      margin: 0;
      border: 0;
      border-radius: 0;
      overflow: hidden;
      background: #f6f6f3;
    }
    #dashboard-canvas-root {
      width: 100%;
      height: 100%;
    }
    .of-node {
      width: 250px;
      min-width: 0;
      display: grid;
      gap: 10px;
      padding: 13px 14px 14px;
      border: 1px solid #c7c7c2;
      border-radius: 8px;
      background: #ffffff;
      color: #151515;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.08);
    }
    .of-node-running { border-color: #777773; }
    .of-node-done { border-color: #222222; }
    .of-node-blocked { border-color: #8b8b8b; border-style: dashed; }
    .of-node-todo { border-color: #adadad; }
    .of-node-head {
      min-width: 0;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: #5b5b57;
      font-size: 10px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .of-node-head span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .of-node-goal {
      color: #181818;
      font-size: 13px;
      font-weight: 720;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .of-node-meta {
      display: grid;
      gap: 3px;
      color: #666661;
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .of-handle {
      width: 8px;
      height: 8px;
      border: 1px solid #5f5f5b;
      background: #ffffff;
    }
    .react-flow__edge-text {
      font-size: 10px;
      fill: #3f3f3d;
    }
    .react-flow__controls button {
      border-color: #dededa;
      background: #ffffff;
      color: #1b1b1b;
    }
    .react-flow__minimap {
      border: 1px solid #d7d7d2;
      border-radius: 6px;
      background: #fbfbf8;
    }
    .turn {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 18px;
      padding: 28px 0 36px;
      border-top: 1px solid rgba(255, 255, 255, 0.065);
      background: transparent;
      animation: liftIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .turn-body {
      min-width: 0;
    }
    .turn.primary {
      padding-top: 12px;
      border-top: 0;
    }
    .turn-gutter {
      display: grid;
      grid-template-rows: 26px 1fr;
      justify-items: center;
      min-height: 100%;
    }
    .turn-avatar {
      width: 26px;
      height: 26px;
      display: inline-grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
      color: #ecebe5;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .turn-rail {
      width: 1px;
      min-height: 24px;
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.08);
    }
    .turn-head, .inspector-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .turn-author {
      color: #f1f1ec;
      font-size: 16px;
      font-weight: 720;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .turn-summary {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .turn-text {
      margin-top: 18px;
      color: #d8d7d0;
      font-size: 14px;
      line-height: 1.85;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .conversation-evidence {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .evidence-group {
      min-width: 0;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .evidence-title {
      color: #aaa9a2;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.35;
    }
    .evidence-list {
      display: grid;
      gap: 6px;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }
    .evidence-item {
      min-width: 0;
      color: #d3d2cc;
      font-size: 12px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .evidence-item .meta {
      margin-top: 2px;
      font-size: 10.5px;
    }
    .raw-stream {
      margin-top: 14px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .raw-stream summary {
      cursor: pointer;
      color: #aaa9a2;
      font-weight: 650;
    }
    .stream-output {
      margin: 18px 0 0;
      max-height: 320px;
      overflow: auto;
      padding: 14px 0 0 16px;
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      color: #efefea;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .stream-line + .stream-line {
      margin-top: 8px;
    }
    .stream-line .stream-line-label {
      display: inline-block;
      min-width: 92px;
      margin-right: 8px;
      color: #8d8f99;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stream-line.event-tool .stream-line-label,
    .stream-line.event-tool-output .stream-line-label,
    .stream-line.event-session .stream-line-label,
    .stream-line.event-thinking .stream-line-label,
    .stream-line.event-message .stream-line-label,
    .stream-line.event-error .stream-line-label,
    .stream-line.event-other .stream-line-label {
      color: #757884;
    }
    .stream-line.event-error {
      color: #e6a3a3;
    }
    .raw-stream .raw-json details {
      margin-top: 8px;
    }
    .raw-stream .raw-json summary {
      color: #757884;
      font-size: 10.5px;
    }
    .raw-stream .raw-json pre {
      margin: 6px 0 0;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      color: #c9c9c4;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .tool-line {
      margin-top: 14px;
      color: var(--muted-2);
      font-size: 11px;
      line-height: 1.6;
    }
    .turn .meta { margin-top: 10px; }
    .inspector-panel {
      width: clamp(380px, 30vw, 520px);
      min-width: 380px;
      max-width: 520px;
      height: 100dvh;
      min-height: 0;
      padding: 46px 26px 28px;
      background: var(--app);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .inspector-card {
      min-width: 0;
      padding: 22px 0 24px;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .inspector-card:first-child {
      padding-top: 0;
    }
    .inspector-card + .inspector-card {
      margin-top: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .inspector-card h2 {
      margin: 0 0 18px;
      color: #a8a7a1;
      font-size: 13px;
      font-weight: 760;
      letter-spacing: 0;
      text-transform: none;
    }
    .todo-list, .lesson-list, .info-list {
      display: grid;
      gap: 9px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .current-task {
      margin: 0 0 20px;
      padding-bottom: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .current-task-title {
      color: #efeee9;
      font-size: 13px;
      font-weight: 690;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .current-task-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .todo-item {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: #d9d8d1;
      font-size: 13px;
      line-height: 1.42;
    }
    .todo-text {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .todo-item.done {
      color: var(--muted);
    }
    .todo-item.done .todo-text {
      text-decoration: line-through;
      text-decoration-color: rgba(255, 255, 255, 0.38);
    }
    .todo-item .meta {
      display: block;
      margin-top: 2px;
      font-size: 10.5px;
    }
    .control-row {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .action-group {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .action-title {
      color: #efeee9;
      font-size: 12px;
      font-weight: 720;
      line-height: 1.4;
    }
    .action-help {
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .action-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .changed-files-section {
      min-width: 0;
    }
    .changed-file-tree {
      min-width: 0;
      max-height: 280px;
      display: grid;
      gap: 2px;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .changed-file-children {
      display: grid;
      gap: 2px;
      margin-left: 8px;
      padding-left: 12px;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
    }
    .changed-file-node {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 7px;
      align-items: center;
      padding: 5px 7px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: #d8d7d0;
      font: inherit;
      font-size: 12px;
      line-height: 1.35;
      text-align: left;
    }
    button.changed-file-node {
      cursor: pointer;
    }
    button.changed-file-node:hover {
      background: rgba(255, 255, 255, 0.045);
      color: #f4f3ee;
    }
    button.changed-file-node.selected {
      background: rgba(255, 255, 255, 0.075);
      color: #ffffff;
    }
    button.changed-file-node.selected .changed-file-type {
      color: #c8c7c1;
    }
    .changed-file-type {
      color: var(--muted-2);
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.4;
      text-align: center;
    }
    .changed-file-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .changed-file-path {
      min-width: 0;
      margin-top: 8px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .diff-panel {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .diff-header {
      position: sticky;
      top: 0;
      z-index: 1;
      overflow: hidden;
      padding: 0 0 10px;
      background: var(--app);
    }
    .diff-path {
      min-width: 0;
      color: #deddd7;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .diff-output {
      max-height: 340px;
      overflow-x: auto;
      overflow-y: auto;
      margin: 0;
      padding: 8px 0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      background: rgba(18, 18, 18, 0.22);
      color: #f0f0eb;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.62;
      white-space: pre;
      overflow-wrap: normal;
    }
    .diff-row {
      display: grid;
      grid-template-columns: 42px max-content;
      min-width: max-content;
      align-items: start;
    }
    .diff-gutter {
      user-select: none;
      padding: 0 10px 0 12px;
      color: var(--muted-2);
      text-align: right;
    }
    .diff-line {
      white-space: pre;
      font-family: var(--mono);
      padding-right: 18px;
    }
    .diff-row.added {
      background: rgba(111, 160, 122, 0.12);
    }
    .diff-row.added .diff-gutter {
      color: #a9c7b1;
    }
    .diff-row.removed {
      background: rgba(184, 113, 111, 0.12);
    }
    .diff-row.removed .diff-gutter {
      color: #d6aaa8;
    }
    .diff-row.hunk {
      background: rgba(255, 255, 255, 0.055);
      color: #cfcec8;
    }
    .diff-row.context {
      background: transparent;
    }
    .diff-state {
      min-width: 0;
      padding: 12px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      white-space: normal;
    }
    .checkbox {
      width: 18px;
      height: 18px;
      margin-top: 2px;
      display: inline-grid;
      place-items: center;
      border: 2px solid rgba(255, 255, 255, 0.42);
      border-radius: 999px;
    }
    .checkbox.done { background: #deded8; border-color: #deded8; }
    .checkbox.done::after {
      content: "";
      width: 5px;
      height: 3px;
      border-left: 1.5px solid #111;
      border-bottom: 1.5px solid #111;
      transform: translateY(-1px) rotate(-45deg);
    }
    .lesson {
      padding: 9px 0 11px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      color: #d6d5cf;
      font-size: 14px;
      line-height: 1.55;
    }
    .guardrail-list {
      display: grid;
      gap: 10px;
    }
    .guardrail-group + .guardrail-group {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .guardrail-group-title {
      margin-bottom: 9px;
      color: #efeee9;
      font-size: 12px;
      font-weight: 720;
      line-height: 1.4;
    }
    .guardrail-item {
      min-width: 0;
      padding: 10px 0 11px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
    }
    .guardrail-id {
      min-width: 0;
      color: var(--muted-2);
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1.45;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .guardrail-summary {
      min-width: 0;
      margin-top: 4px;
      color: #deddd7;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .guardrail-meta {
      min-width: 0;
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .guardrail-actions {
      margin-top: 7px;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .guardrail-status {
      min-width: 0;
      color: var(--muted-2);
      font-size: 11px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .guardrail-status.error {
      color: #ead2d0;
    }
    .prompt-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 0;
      border: 0;
      border-radius: 0;
      color: #d9d9d4;
      background: transparent;
      font-size: 14px;
      font-weight: 720;
      text-decoration: underline;
      text-decoration-color: rgba(255, 255, 255, 0.28);
      text-underline-offset: 3px;
      transition: color 160ms, text-decoration-color 160ms;
    }
    .prompt-link:hover {
      color: #ffffff;
      text-decoration-color: rgba(255, 255, 255, 0.72);
    }
    .prompt-link:active { color: #cfcfc9; }
    .status-dot {
      width: 8px;
      height: 8px;
      margin-top: 6px;
      border-radius: 999px;
      background: #8f8f88;
    }
    .status-dot.done { background: var(--ok); }
    .status-dot.running { background: #d8d0a8; animation: breathe 1.8s ease-in-out infinite; }
    .status-dot.blocked { background: var(--danger); }
    .status-dot.todo { background: var(--warn); }
    .status-text {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      max-width: 100%;
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-text.done { color: var(--ok); }
    .status-text.running { color: #d8d0a8; }
    .status-text.blocked { color: var(--danger); }
    .status-text.todo { color: var(--warn); }
    .role-label, .kind-label {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .empty {
      padding: 16px;
      border-top: 1px dashed rgba(255, 255, 255, 0.14);
      border-bottom: 1px dashed rgba(255, 255, 255, 0.14);
      border-radius: 0;
      color: #aaa9a3;
      font-size: 14px;
      line-height: 1.6;
      background: rgba(255, 255, 255, 0.035);
    }
    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: #d8d7d0;
      font-size: 13px;
      font-weight: 680;
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .code-meta {
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.65;
    }
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }
      50% { box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.08); }
    }
    @keyframes liftIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 900px) {
      body { overflow: auto; }
      .app-shell {
        height: auto;
        min-height: 100dvh;
        grid-template-columns: minmax(0, 1fr);
      }
      .task-sidebar, .workspace, .inspector-panel {
        height: auto;
        max-height: none;
        overflow: visible;
      }
      .inspector-panel { width: auto; min-width: 0; max-width: none; }
      .inspector-panel {
        padding: 24px 18px 30px;
        border-left: 0;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .task-sidebar { min-width: 0; overflow-x: hidden; overflow-y: visible; }
      .workspace-head-row {
        display: grid;
      }
      .workspace-toggle {
        width: 100%;
      }
      .workspace-flow { padding: 18px 16px 32px; }
      .workspace-flow.canvas-workspace { min-height: 560px; padding: 0; }
      .workspace-head { padding: 16px; }
      .canvas-inner {
        height: 560px;
        min-height: 560px;
      }
    }
  </style>
  <script type="module" src="/assets/dashboard-canvas.js"></script>
</head>
<body>
  <div class="app-shell">
    <aside class="task-sidebar">
      <div class="sidebar-head">
        <div class="brand-row">
          <h1>Ouroboros</h1>
          <div class="run-status" id="run-status">Loading</div>
        </div>
        <div id="run-title">Loading ${escapeHtml(input.runId)}</div>
        <div class="project-title project-header" id="project-title" data-project-header>
          <div class="project-name" data-project-name>Project Workspace</div>
          <div class="project-root" data-project-root></div>
        </div>
        <form class="intake-composer" id="intake-composer">
          <label class="intake-label" for="intake-input">New intake</label>
          <input id="attachment-input" type="file" multiple hidden>
          <div class="attachment-chips" id="attachment-chips" aria-live="polite"></div>
          <textarea class="intake-input" id="intake-input" name="prompt" placeholder="Describe the next goal or change request"></textarea>
          <div class="intake-actions">
            <button class="plain-button secondary" type="button" data-attach-files>+</button>
            <button class="plain-button secondary" type="button" data-clear-attachments>Clear</button>
            <div class="form-status" id="intake-form-status"></div>
            <button class="plain-button" type="submit" data-send-intake>Send</button>
          </div>
        </form>
      </div>
      <section class="sidebar-stats" id="sidebar-stats"></section>
      <nav class="task-nav" aria-label="Goals">
        <section class="nav-section">
          <h2 class="section-label">Active Goals</h2>
          <div class="task-list" id="active-goal-list"></div>
        </section>
        <section class="nav-section">
          <h2 class="section-label">History</h2>
          <div class="task-list" id="history-goal-list"></div>
        </section>
        <section class="nav-section" data-history-runs>
          <h2 class="section-label">Recent runs</h2>
          <div class="task-list" id="recent-runs-list" data-history-runs-list aria-live="polite">Loading recent runs…</div>
        </section>
      </nav>
    </aside>
    <main class="workspace">
      <header class="workspace-head">
        <div class="workspace-head-row">
          <div class="workspace-title-block">
            <div class="workspace-kicker" id="workspace-kicker">Task Flow</div>
            <div class="workspace-title-row">
              <div class="workspace-title is-collapsed" id="workspace-title" title="Loading">Loading</div>
              <button class="workspace-title-toggle" id="workspace-title-toggle" type="button" data-workspace-title-toggle aria-expanded="false" aria-controls="workspace-title" aria-label="Expand workspace title">Expand</button>
            </div>
          </div>
          <div class="workspace-toggle" aria-label="Workspace view">
            <button type="button" data-workspace-mode="canvas" aria-pressed="false">Canvas</button>
            <button type="button" data-workspace-mode="flow" aria-pressed="true" class="active">Flow</button>
          </div>
        </div>
      </header>
      <section class="workspace-flow" id="workspace-flow"></section>
    </main>
    <aside class="inspector-panel" id="inspector-panel"></aside>
  </div>
  <script>
    const defaultRunId = ${JSON.stringify(input.runId)};
    const activeRunStorageKey = "ouroboros:dashboard:activeRun";
    const parseRunIdFromHash = (hash) => {
      if (typeof hash !== "string" || !hash) return null;
      const match = hash.match(/[#&]run=([^&]+)/);
      if (!match) return null;
      try {
        const decoded = decodeURIComponent(match[1]);
        return /^[A-Za-z0-9_-]+$/.test(decoded) ? decoded : null;
      } catch {
        return null;
      }
    };
    const resolveInitialRunId = () => {
      const fromHash = parseRunIdFromHash(window.location?.hash || "");
      if (fromHash && fromHash !== defaultRunId) return fromHash;
      try {
        const stored = window.localStorage?.getItem(activeRunStorageKey);
        if (typeof stored === "string" && /^[A-Za-z0-9_-]+$/.test(stored) && stored !== defaultRunId) {
          return stored;
        }
      } catch {
      }
      return defaultRunId;
    };
    let runId = resolveInitialRunId();
    if (runId !== defaultRunId) {
      try { window.localStorage?.setItem(activeRunStorageKey, runId); } catch {}
      try { window.history.replaceState(null, "", "#run=" + encodeURIComponent(runId)); } catch {}
    }
    let dashboardStorageKey = "ouroboros:dashboard:" + runId;
    const byStatus = (items) => items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
    const compactJson = (value) => {
      try {
        const seen = new WeakSet();
        const json = JSON.stringify(value, (_key, nested) => {
          if (typeof nested === "bigint") return String(nested);
          if (!nested || typeof nested !== "object") return nested;
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
          return nested;
        });
        return json || "";
      } catch {
        return typeof value === "object" ? "[Unserializable object]" : String(value);
      }
    };
    const readableValue = (value, seen) => {
      if (typeof value === "string") return value.replace(/\\s+/g, " ").trim();
      if (value === null || value === undefined) return "";
      if (typeof value !== "object") return String(value);
      const seenObjects = seen || new WeakSet();
      if (seenObjects.has(value)) return "[Circular]";
      seenObjects.add(value);
      if (Array.isArray(value)) {
        return value.map((item) => readableValue(item, seenObjects)).filter(Boolean).join("; ");
      }
      const preferred = ["summary", "message", "error", "details", "name", "status", "severity", "path", "command"];
      const used = new Set();
      const parts = [];
      for (const key of preferred) {
        if (!(key in value) || value[key] === null || value[key] === undefined) continue;
        used.add(key);
        const formatted = readableValue(value[key], seenObjects);
        if (formatted) parts.push(key + ": " + formatted);
      }
      const remaining = {};
      for (const [key, nested] of Object.entries(value)) {
        if (!used.has(key)) remaining[key] = nested;
      }
      if (Object.keys(remaining).length > 0) parts.push("extra: " + compactJson(remaining));
      return (parts.length ? parts.join("; ") : compactJson(value)).replace(/\\s+/g, " ").trim();
    };
    const codexEventParts = (payload) => {
      if (!payload || typeof payload !== "object") return null;
      const type = typeof payload.type === "string" ? payload.type : "";
      const item = payload.item && typeof payload.item === "object" ? payload.item : null;
      if (item) {
        const itemType = typeof item.type === "string" ? item.type : "";
        if (itemType === "message") {
          const role = typeof item.role === "string" && item.role ? item.role : "message";
          const content = Array.isArray(item.content) ? item.content : [];
          const parts = [];
          for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const text = typeof part.text === "string" ? part.text
              : typeof part.output === "string" ? part.output
              : "";
            if (text.trim()) parts.push(text.trim());
          }
          if (parts.length === 0) return null;
          return { category: "message", label: role, text: parts.join(" ").replace(/\\s+/g, " ") };
        }
        if (itemType === "function_call" || itemType === "tool_call") {
          const name = typeof item.name === "string" && item.name ? item.name : "tool";
          const summary = summarizeToolArguments(item.arguments);
          return { category: "tool", label: name, text: summary || "(invoked)" };
        }
        if (itemType === "function_call_output" || itemType === "tool_call_output") {
          const raw = typeof item.output === "string" ? item.output : "";
          const text = raw.replace(/\\s+/g, " ").trim();
          if (!text) return null;
          return { category: "tool-output", label: "tool output", text };
        }
        if (itemType === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary : [];
          const parts = [];
          for (const part of summary) {
            if (!part || typeof part !== "object") continue;
            const text = typeof part.text === "string" ? part.text
              : typeof part.summary === "string" ? part.summary
              : "";
            if (text.trim()) parts.push(text.trim());
          }
          if (parts.length === 0) return null;
          return { category: "thinking", label: "thinking", text: parts.join(" ").replace(/\\s+/g, " ") };
        }
      }
      if (type === "session.created" || type === "session.updated" || type === "session.completed") {
        const action = type.split(".")[1] || "started";
        return { category: "session", label: "session", text: action };
      }
      if (type === "response.output_text.delta" || type === "response.output_text.done") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        return { category: "message", label: "assistant", text };
      }
      if (type === "response.reasoning.delta" || type === "response.reasoning_text.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        return { category: "thinking", label: "thinking", text };
      }
      if (type === "response.function_call_arguments.delta" || type === "response.function_call.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        return { category: "tool", label: "tool", text };
      }
      if (typeof payload.delta === "string" && payload.delta.trim()) {
        return { category: "message", label: "delta", text: payload.delta.trim() };
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        return { category: "message", label: "message", text: payload.message.trim() };
      }
      if (typeof payload.error === "string" && payload.error.trim()) {
        return { category: "error", label: "error", text: payload.error.trim() };
      }
      return null;
    };
    const summarizeToolArguments = (raw) => {
      if (typeof raw !== "string") return "";
      const trimmed = raw.trim();
      if (!trimmed) return "";
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { return clampText(trimmed, 180); }
      if (!parsed || typeof parsed !== "object") return clampText(String(parsed), 180);
      if (Array.isArray(parsed)) return clampText(parsed.map((value) => readableValue(value)).filter(Boolean).join(" "), 180);
      const command = parsed.command ?? parsed.cmd ?? parsed.input;
      if (Array.isArray(command)) return clampText(command.map((part) => readableValue(part)).filter(Boolean).join(" "), 180);
      if (typeof command === "string") return clampText(command, 180);
      const path = parsed.path ?? parsed.file;
      if (typeof path === "string") return clampText(path, 180);
      const pairs = [];
      for (const [key, value] of Object.entries(parsed)) {
        pairs.push(key + ": " + clampText(readableValue(value), 90));
        if (pairs.length >= 3) break;
      }
      return clampText(pairs.join(" · "), 180);
    };
    const clampText = (value, max) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      if (text.length <= max) return text;
      return text.slice(0, max - 1) + "…";
    };
    const codexEventCategory = (event) => {
      const payload = event.payload || {};
      if (payload && typeof payload === "object" && typeof payload.error === "string") return "error";
      const parts = codexEventParts(payload);
      return parts ? parts.category : "other";
    };
    const eventText = (event) => {
      if (event.text && String(event.text).trim()) return String(event.text).trim();
      const payload = event.payload || {};
      const parts = codexEventParts(payload);
      if (parts) {
        const label = parts.label === parts.category ? parts.label : parts.label;
        return "[" + label + "] " + parts.text;
      }
      for (const key of ["delta", "message", "text", "content"]) {
        if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
      }
      return "";
    };
    const latestText = (session) => session.latestText || session.events.map(eventText).filter(Boolean).slice(-1)[0] || "";
    const readableSummary = (session) => {
      const summary = session.output?.summary;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
      const fallback = latestText(session);
      return fallback ? compact(fallback, 360) : "No summary recorded yet.";
    };
    const evidenceItemText = (item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return readableValue(item);
      if ("summary" in item) {
        const summary = readableValue(item.summary);
        if (summary) return summary;
      }
      return readableValue(item);
    };
    const evidenceItemMeta = (item) => {
      if (!item || typeof item !== "object") return "";
      const parts = [];
      if (item.status) parts.push(String(item.status));
      if (item.name && item.summary) parts.push(String(item.name));
      if (item.kind && item.path) parts.push(String(item.kind));
      return parts.join(" · ");
    };
    const evidenceSection = (title, items) => {
      const list = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined) : [];
      if (list.length === 0) return "";
      return '<section class="evidence-group"><div class="evidence-title">' + escapeHtml(title) + '</div><ul class="evidence-list">' +
        list.slice(0, 8).map((item) => {
          const meta = evidenceItemMeta(item);
          return '<li class="evidence-item">' + escapeHtml(evidenceItemText(item)) +
            (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '') + '</li>';
        }).join("") +
        (list.length > 8 ? '<li class="evidence-item meta">' + escapeHtml(list.length - 8) + ' more</li>' : '') +
        '</ul></section>';
    };
    const conversationEvidence = (session) => {
      const output = session.output || {};
      const groups = [
        evidenceSection("Problems", output.problems),
        evidenceSection("Checks", output.checks),
        evidenceSection("Changed files", output.changedFiles),
        evidenceSection("Artifacts", output.artifacts),
      ].filter(Boolean).join("");
      return groups ? '<div class="conversation-evidence">' + groups + '</div>' : "";
    };
    const streamOutput = (session) => {
      const events = (session.events || []).slice(-20);
      const lines = events
        .map((event) => {
          if (event.text && String(event.text).trim()) {
            return { category: event.stream === "stderr" ? "error" : "other", label: event.stream === "stderr" ? "stderr" : "log", text: String(event.text).trim() };
          }
          const parts = codexEventParts(event.payload || {});
          if (parts) return parts;
          const payload = event.payload || {};
          for (const key of ["delta", "message", "text", "content"]) {
            if (typeof payload[key] === "string" && payload[key].trim()) {
              return { category: "other", label: key, text: payload[key].trim() };
            }
          }
          return null;
        })
        .filter(Boolean);
      if (lines.length === 0 && latestText(session)) {
        lines.push({ category: "other", label: "latest", text: latestText(session) });
      }
      if (lines.length === 0) return '<div class="turn-text">No stream output recorded.</div>';
      return '<div class="stream-output" data-attempt-stream="' + escapeHtml(session.attemptId) + '">' +
        lines.map((line, index) => {
          const label = line.label || line.category;
          return '<div class="stream-line event-' + escapeHtml(line.category) + '" data-event-index="' + index + '">' +
            '<span class="stream-line-label">' + escapeHtml(label) + '</span>' +
            '<span class="stream-line-text">' + escapeHtml(line.text) + '</span>' +
            '</div>';
        }).join("") +
        '</div>';
    };
    const rawEventDump = (session) => {
      const events = (session.events || []).slice(-20);
      if (events.length === 0) return "";
      const items = events.map((event, index) => {
        const payload = event.payload && typeof event.payload === "object" ? event.payload : null;
        if (!payload) {
          const text = typeof event.text === "string" ? event.text : "";
          if (!text.trim()) return "";
          return '<details><summary>event ' + (index + 1) + ' · ' + escapeHtml(event.stream || "text") + '</summary><pre>' + escapeHtml(text) + '</pre></details>';
        }
        return '<details><summary>event ' + (index + 1) + ' · ' + escapeHtml(event.stream || "codex-json") + '</summary><pre>' + escapeHtml(compactJson(payload)) + '</pre></details>';
      }).filter(Boolean).join("");
      if (!items) return "";
      return '<details class="raw-json"><summary>Raw JSON payloads</summary>' + items + '</details>';
    };
    const rawStreamDetails = (session) =>
      '<details class="raw-stream"><summary>Raw output</summary>' + streamOutput(session) + rawEventDump(session) + '</details>';
    const promptLink = (task) => '<a class="prompt-link" target="_blank" rel="noreferrer" href="/tasks/' + encodeURIComponent(task.id) + '/prompt">Prompt</a>';
    const isWorkspaceMode = (value) => value === "canvas" || value === "flow";
    const readDashboardState = () => {
      try {
        const parsed = JSON.parse(window.localStorage?.getItem(dashboardStorageKey) || "{}");
        return {
          selectedGoalId: typeof parsed.selectedGoalId === "string" ? parsed.selectedGoalId : null,
          workspaceMode: isWorkspaceMode(parsed.workspaceMode) ? parsed.workspaceMode : null,
          workspaceTitleExpanded: parsed.workspaceTitleExpanded === true,
        };
      } catch {
        return { selectedGoalId: null, workspaceMode: null, workspaceTitleExpanded: false };
      }
    };
    const writeDashboardState = (state) => {
      try {
        window.localStorage?.setItem(dashboardStorageKey, JSON.stringify({
          selectedGoalId: typeof state.selectedGoalId === "string" ? state.selectedGoalId : null,
          workspaceMode: isWorkspaceMode(state.workspaceMode) ? state.workspaceMode : "flow",
          workspaceTitleExpanded: state.workspaceTitleExpanded === true,
        }));
      } catch {
      }
    };
    const restoredDashboardState = readDashboardState();
    let selectedGoalId = restoredDashboardState.selectedGoalId || null;
    let workspaceMode = restoredDashboardState.workspaceMode || "flow";
    let workspaceTitleExpanded = restoredDashboardState.workspaceTitleExpanded === true;
    let latestOverview = null;
    let selectedChangedFilePath = null;
    const diffByPath = new Map();
    let attachments = [];
    const resolvedBlockedTaskIdsFor = (tasks) => {
      const repairsByParent = new Map();
      const doneVerifiersByDependency = new Map();
      for (const task of tasks) {
        if (task.parentId && task.role === "worker" && task.status === "done") {
          if (!repairsByParent.has(task.parentId)) repairsByParent.set(task.parentId, []);
          repairsByParent.get(task.parentId).push(task);
        }
        if (task.role !== "verifier" || task.status !== "done") continue;
        for (const dependencyId of task.dependsOn || []) {
          if (!doneVerifiersByDependency.has(dependencyId)) doneVerifiersByDependency.set(dependencyId, []);
          doneVerifiersByDependency.get(dependencyId).push(task);
        }
      }
      return new Set(tasks
        .filter((task) => task.status === "blocked")
        .filter((task) =>
          (repairsByParent.get(task.id) || []).some(
            (repair) => (doneVerifiersByDependency.get(repair.id) || []).length > 0,
          )
        )
        .map((task) => task.id));
    };
    const effectiveTaskStatus = (task, resolvedBlockedTaskIds) =>
      task.status === "blocked" && resolvedBlockedTaskIds.has(task.id) ? "done" : task.status;
    const groupStatus = (tasks) => {
      const resolvedBlockedTaskIds = resolvedBlockedTaskIdsFor(tasks);
      const statuses = tasks.map((task) => effectiveTaskStatus(task, resolvedBlockedTaskIds));
      if (statuses.some((status) => status === "running")) return "running";
      if (statuses.some((status) => status === "todo")) return "todo";
      if (statuses.some((status) => status === "blocked")) return "blocked";
      return "done";
    };
    const isCycleStarter = (task) => task.role === "planner" || task.role === "goal-review";
    const titleTaskFor = (tasks) =>
      tasks.find((task) => !["planner", "verifier", "goal-review"].includes(task.role) && !task.goal.startsWith("Repair:")) ||
      tasks.find((task) => task.role === "verifier") ||
      tasks[0];
    const addRelation = (relations, seen, taskIds, kind, sourceId, targetId) => {
      if (typeof sourceId !== "string" || typeof targetId !== "string") return;
      if (!taskIds.has(sourceId) || !taskIds.has(targetId) || sourceId === targetId) return;
      const pairKey = sourceId + "->" + targetId;
      if (kind === "created" && relations.some((relation) => relation.sourceId + "->" + relation.targetId === pairKey)) return;
      const key = kind + ":" + pairKey;
      if (seen.has(key)) return;
      seen.add(key);
      relations.push({ kind, sourceId, targetId });
    };
    const graphRelationsFor = (overview) => {
      const taskIds = new Set((overview.tasks || []).map((task) => task.id));
      const relations = [];
      const seen = new Set();
      for (const task of overview.tasks || []) {
        for (const sourceId of task.dependsOn || []) addRelation(relations, seen, taskIds, "dependsOn", sourceId, task.id);
        if (task.parentId) addRelation(relations, seen, taskIds, "parentId", task.parentId, task.id);
      }
      for (const session of overview.sessions || []) {
        const artifacts = Array.isArray(session.output?.artifacts) ? session.output.artifacts : [];
        for (const artifact of artifacts) {
          if (!artifact || typeof artifact !== "object") continue;
          addRelation(relations, seen, taskIds, "created", artifact.sourceTaskId, artifact.taskId);
        }
      }
      for (const task of overview.tasks || []) {
        if (task.role !== "goal-review") continue;
        const hasRelation = relations.some((relation) => relation.sourceId === task.id || relation.targetId === task.id);
        if (hasRelation) continue;
        const taskIndex = overview.tasks.findIndex((candidate) => candidate.id === task.id);
        const previous = [...overview.tasks.slice(0, taskIndex)].reverse().find((candidate) => candidate.role !== "goal-review");
        if (previous) addRelation(relations, seen, taskIds, "reviews", previous.id, task.id);
      }
      return relations;
    };
    const relatedTaskIdsFor = (overview, groupId) => {
      if (!groupId) return new Set((overview.tasks || []).map((task) => task.id));
      const seeds = (overview.tasks || [])
        .filter((task) => task.id === groupId || (task.cycleId || task.id) === groupId)
        .map((task) => task.id);
      const related = new Set(seeds.length ? seeds : [groupId]);
      const adjacency = new Map();
      const link = (sourceId, targetId) => {
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
        if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
        adjacency.get(sourceId).add(targetId);
        adjacency.get(targetId).add(sourceId);
      };
      for (const relation of graphRelationsFor(overview)) link(relation.sourceId, relation.targetId);
      const queue = [...related];
      while (queue.length) {
        const id = queue.shift();
        for (const next of adjacency.get(id) || []) {
          if (!related.has(next)) {
            related.add(next);
            queue.push(next);
          }
        }
      }
      return related;
    };
    const buildGoalGroups = (overview) => {
      const relations = graphRelationsFor(overview);
      const adjacency = new Map();
      const link = (sourceId, targetId) => {
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
        if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
        adjacency.get(sourceId).add(targetId);
        adjacency.get(targetId).add(sourceId);
      };
      for (const relation of relations) link(relation.sourceId, relation.targetId);
      const taskById = new Map((overview.tasks || []).map((task) => [task.id, task]));
      const visited = new Set();
      const groups = [];
      for (const task of overview.tasks) {
        if (visited.has(task.id)) continue;
        const taskIds = new Set();
        const queue = [task.id];
        visited.add(task.id);
        while (queue.length) {
          const id = queue.shift();
          taskIds.add(id);
          for (const next of adjacency.get(id) || []) {
            if (!visited.has(next)) {
              visited.add(next);
              queue.push(next);
            }
          }
        }
        const tasks = overview.tasks.filter((candidate) => taskIds.has(candidate.id));
        const root = tasks.find((candidate) => isCycleStarter(candidate)) || taskById.get(task.id) || tasks[0];
        groups.push({ id: root.cycleId || root.id, root, titleTask: titleTaskFor(tasks), taskIds, tasks });
      }
      return groups.map((group) => {
        const ids = group.taskIds;
        const sessions = overview.sessions.filter((session) => ids.has(session.taskId));
        const lessons = (overview.lessons || []).filter((lesson) => ids.has(lesson.taskId));
        const activeTasks = group.tasks.filter((task) => task.status === "todo" || task.status === "running");
        const resolvedBlockedTaskIds = resolvedBlockedTaskIdsFor(group.tasks);
        return {
          id: group.id,
          root: group.root,
          titleTask: group.titleTask,
          tasks: group.tasks,
          sessions,
          lessons,
          activeTasks,
          resolvedBlockedTaskIds,
          resolvedBlockedCount: resolvedBlockedTaskIds.size,
          status: groupStatus(group.tasks),
        };
      });
    };
    const compact = (value, max = 140) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 1) + "…" : text;
    };
    const lessonList = (lessons) => lessons.length
      ? '<div class="lesson-list">' + lessons.map((lesson) =>
        '<div class="lesson ' + escapeHtml(lesson.kind) + '"><span class="kind-label">' + escapeHtml(lesson.kind) + '</span> ' +
        escapeHtml(lesson.summary) + '<div class="meta code-meta">task ' + escapeHtml(lesson.taskId) + '<br>attempt ' + escapeHtml(lesson.attemptId) + '</div></div>'
      ).join("") + '</div>'
      : '<div class="empty">No lessons or experiences</div>';
    const normalizeChangedFilePath = (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim().replaceAll("\\\\", "/");
      if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\\//.test(trimmed)) return null;
      const normalized = trimmed.split("/").filter((part) => part && part !== ".").join("/");
      if (!normalized || normalized.split("/").some((part) => part === "..")) return null;
      return normalized;
    };
    const changedFilesForGroup = (group) => {
      const seen = new Set();
      return (group?.sessions || []).flatMap((session) => {
        const changedFiles = Array.isArray(session.output?.changedFiles) ? session.output.changedFiles : [];
        return changedFiles.flatMap((rawPath) => {
          const path = normalizeChangedFilePath(rawPath);
          if (!path || seen.has(path)) return [];
          seen.add(path);
          return [{ path, taskId: session.taskId, attemptId: session.attemptId }];
        });
      }).sort((left, right) => left.path.localeCompare(right.path));
    };
    const changedFilesTree = (files) => {
      const root = [];
      const directories = new Map([["", root]]);
      for (const file of files) {
        const parts = file.path.split("/");
        let parentPath = "";
        for (let index = 0; index < parts.length; index += 1) {
          const name = parts[index];
          const nodePath = parentPath ? parentPath + "/" + name : name;
          const parent = directories.get(parentPath) || root;
          const isFile = index === parts.length - 1;
          let node = parent.find((candidate) => candidate.path === nodePath);
          if (!node) {
            node = isFile
              ? { name, path: nodePath, type: "file", file }
              : { name, path: nodePath, type: "directory", children: [] };
            parent.push(node);
            parent.sort((left, right) => left.type === right.type ? left.path.localeCompare(right.path) : left.type === "file" ? -1 : 1);
          }
          if (!isFile) directories.set(nodePath, node.children || []);
          parentPath = nodePath;
        }
      }
      return root;
    };
    const renderChangedFilesTree = (nodes) => nodes.map((node) => {
      if (node.type === "directory") {
        return '<div data-changed-file-node="directory" data-changed-file-path="' + escapeHtml(node.path) + '">' +
          '<div class="changed-file-node"><span class="changed-file-type" aria-hidden="true">dir</span><span class="changed-file-name" title="' + escapeHtml(node.path) + '">' + escapeHtml(node.name) + '</span></div>' +
          '<div class="changed-file-children">' + renderChangedFilesTree(node.children || []) + '</div></div>';
      }
      const selected = node.path === selectedChangedFilePath;
      return '<button type="button" class="changed-file-node ' + (selected ? "selected" : "") + '" data-changed-file-node="file" data-changed-file-path="' + escapeHtml(node.path) + '"' + (selected ? ' data-selected-changed-file="true" aria-current="true"' : "") + ' title="' + escapeHtml(node.path) + '">' +
        '<span class="changed-file-type" aria-hidden="true">file</span><span class="changed-file-name">' + escapeHtml(node.name) + '</span></button>';
    }).join("");
    const diffLineType = (line) => {
      if (line.startsWith("@@")) return "hunk";
      if (line.startsWith("+") && !line.startsWith("+++")) return "added";
      if (line.startsWith("-") && !line.startsWith("---")) return "removed";
      return "context";
    };
    const renderDiffRows = (diff) => {
      const lines = String(diff || "").split("\\n");
      if (lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) return '<div class="diff-state" data-diff-state="no-diff">No working tree diff for this file.</div>';
      return lines.map((line, index) => {
        const type = diffLineType(line);
        const mark = type === "added" ? "+" : type === "removed" ? "-" : type === "hunk" ? "@" : "";
        return '<div class="diff-row ' + type + '" data-diff-row data-diff-row-type="' + type + '" data-diff-line="' + index + '">' +
          '<span class="diff-gutter">' + escapeHtml(mark) + '</span><span class="diff-line">' + escapeHtml(line) + '</span></div>';
      }).join("");
    };
    const renderDiffState = (state, message) =>
      '<div class="diff-output" data-diff-output><div class="diff-state" data-diff-state="' + escapeHtml(state) + '">' + escapeHtml(message) + '</div></div>';
    const renderDiffPanel = (path) => {
      if (!path) return '<div class="diff-panel" data-diff-panel>' + renderDiffState("empty-selection", "Select a changed file to inspect its diff.") + '</div>';
      const state = diffByPath.get(path);
      const body = !state || state.status === "loading"
        ? renderDiffState("loading", "Loading diff...")
        : state.status === "error"
          ? renderDiffState("error", state.error || "Unable to load diff.")
          : '<div class="diff-output" data-diff-output>' + renderDiffRows(state.diff || "") + '</div>';
      return '<div class="diff-panel" data-diff-panel data-diff-path="' + escapeHtml(path) + '">' +
        '<div class="diff-header" data-diff-header><div class="diff-path" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</div></div>' + body + '</div>';
    };
    const renderChangedFilesSection = (group) => {
      const files = changedFilesForGroup(group);
      if (!files.some((file) => file.path === selectedChangedFilePath)) selectedChangedFilePath = files[0]?.path || null;
      const tree = changedFilesTree(files);
      return '<section class="inspector-card changed-files-section" data-inspector-section="changed-files" data-changed-files-section><h2>Changed Files</h2>' +
        (files.length ? '<div class="changed-file-tree" data-changed-file-tree>' + renderChangedFilesTree(tree) + '</div>' : '<div class="empty">No changed files reported for this goal.</div>') +
        renderDiffPanel(selectedChangedFilePath) +
        '</section>';
    };
    const taskMeta = (task) => '<span class="code-meta">id ' + escapeHtml(task.id) + '</span>' + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '');
    const relationText = (ids) => ids.length ? ids.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '<span class="meta">none</span>';
    const guardrailRecords = (value) => Array.isArray(value) ? value.filter((record) => record && typeof record === "object" && !Array.isArray(record)) : [];
    const guardrailSource = (record) => typeof record.source === "string" && record.source.trim() ? record.source.trim() : "unspecified source";
    const guardrailRoles = (record) => {
      const roles = Array.isArray(record.roles) ? record.roles : typeof record.role === "string" ? [record.role] : [];
      const clean = roles.map((role) => String(role || "").trim()).filter(Boolean);
      return clean.length ? compact(clean.join(", "), 160) : "global";
    };
    const guardrailCount = (record) => Number.isFinite(Number(record.count)) ? Number(record.count) : null;
    const guardrailItem = (record, state) => {
      const id = compact(record.id || "guardrail", 92);
      const source = guardrailSource(record);
      const roles = guardrailRoles(record);
      const count = guardrailCount(record);
      const meta = ["source " + source, count === null ? "" : "count " + count, "roles " + roles].filter(Boolean).join(" · ");
      const stateAttribute = state === "active" ? 'data-guardrail-state="active"' : 'data-guardrail-state="proposed"';
      const proposalId = typeof record.id === "string" ? record.id : "";
      const accepted = record.accepted === true;
      const acceptControl = state === "proposed" && !accepted && proposalId
        ? '<div class="guardrail-actions" data-guardrail-actions="' + escapeHtml(proposalId) + '">' +
          '<button type="button" class="plain-button" data-accept-guardrail="' + escapeHtml(proposalId) + '" data-accept-guardrail-run="' + escapeHtml(runId) + '" aria-label="Accept guardrail proposal ' + escapeHtml(proposalId) + '">Accept</button>' +
          '<span class="guardrail-status" data-guardrail-status="' + escapeHtml(proposalId) + '" role="status" aria-live="polite"></span>' +
          '</div>'
        : (accepted
            ? '<div class="guardrail-actions"><span class="guardrail-status">Accepted · use the CLI or harness to retire.</span></div>'
            : '');
      return '<div class="guardrail-item" ' + stateAttribute + ' data-guardrail-id="' + escapeHtml(proposalId) + '">' +
        '<div class="guardrail-id" title="' + escapeHtml(record.id || "guardrail") + '">' + escapeHtml(id) + '</div>' +
        '<div class="guardrail-summary">' + escapeHtml(compact(record.summary, 220) || "No summary recorded.") + '</div>' +
        '<div class="guardrail-meta">' + escapeHtml(meta) + '</div>' +
        acceptControl +
        '</div>';
    };
    const guardrailGroup = (title, records, state) =>
      '<div class="guardrail-group"><div class="guardrail-group-title">' + escapeHtml(title) + ' · ' + escapeHtml(records.length) + '</div>' +
      (records.length ? '<div class="guardrail-list">' + records.map((record) => guardrailItem(record, state)).join("") + '</div>' : '<div class="empty">None recorded.</div>') +
      '</div>';
    const renderGuardrailsSection = (overview) => {
      const activeGuardrails = guardrailRecords(overview.run?.context?.guardrails).filter((record) => record.active !== false);
      const pendingProposals = guardrailRecords(overview.run?.context?.guardrailProposals).filter((record) => record.accepted !== true);
      if (activeGuardrails.length === 0 && pendingProposals.length === 0) return "";
      return '<section class="inspector-card" data-inspector-section="guardrails"><h2>Guardrails</h2>' +
        guardrailGroup("Active Guardrails", activeGuardrails, "active") +
        guardrailGroup("Pending Guardrail Proposals", pendingProposals, "proposed") +
        '<div class="meta">Accept control posts to /api/runs/' + escapeHtml(runId) + '/guardrails/&lt;proposalId&gt;/accept and delegates to the harness-owned acceptGuardrailProposal action. CLI commands propose-guardrails and accept-guardrail remain available.</div>' +
        '</section>';
    };
    const roleSummary = (tasks) => [...new Set(tasks.map((task) => task.role))].join(" / ");
    const roleMark = (role) => escapeHtml(String(role || "?").slice(0, 2));
    const modelMetaForSession = (session) => {
      const model = session && session.model && typeof session.model === "object" ? session.model : null;
      if (!model || !model.model) return "";
      const details = [
        model.source ? "source " + model.source : "",
        model.role ? "role " + model.role : "",
        model.provider ? "provider " + model.provider : "",
        model.profile ? "profile " + model.profile : "",
        model.base_url ? "base_url " + model.base_url : "",
        model.env_key ? "env_key " + model.env_key : "",
      ].filter(Boolean).join(" · ");
      return "Model " + model.model + (details ? " · " + details : "");
    };
    const goalRow = (group) =>
      '<button class="task-row ' + (group.id === selectedGoalId ? 'selected' : '') + '" data-goal-id="' + escapeHtml(group.id) + '">' +
      '<span class="status-dot ' + escapeHtml(group.status) + '"></span>' +
      '<span class="task-row-text"><strong>' + escapeHtml(group.titleTask.goal) + '</strong><span class="row-meta">' + group.tasks.length + ' tasks · ' + escapeHtml(roleSummary(group.tasks)) + (group.resolvedBlockedCount ? ' · ' + escapeHtml(group.resolvedBlockedCount) + ' repaired block' : '') + '</span></span>' +
      '<span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span></button>';
    const turn = (input) =>
      '<article class="turn ' + (input.primary ? "primary" : "") + '" data-turn-key="' + escapeHtml(input.key || input.mark) + '"><div class="turn-gutter"><div class="turn-avatar">' + input.mark + '</div><div class="turn-rail"></div></div>' +
      '<div class="turn-body"><div class="turn-head"><div><div class="turn-author">' + input.author + '</div>' +
      (input.summary ? '<div class="turn-summary">' + input.summary + '</div>' : '') + '</div>' +
      (input.action || '') + '</div>' + (input.body || '') + '</div></article>';
    const sessionFlowTurn = (session) =>
      turn({
        key: session.attemptId,
        mark: roleMark(session.role),
        author: escapeHtml(session.role),
        summary: escapeHtml(session.taskGoal) + ' · ' + escapeHtml(session.status) + (modelMetaForSession(session) ? ' · ' + escapeHtml(modelMetaForSession(session)) : ''),
        action: '<span class="status-text ' + escapeHtml(session.status) + '">' + escapeHtml(session.status) + '</span>',
        body:
          '<div class="tool-line code-meta">task ' + escapeHtml(session.taskId) + ' · attempt ' + escapeHtml(session.attemptId) +
          (session.sessionName ? '<br>session ' + escapeHtml(session.sessionName) : '') +
          (session.codexSessionId ? '<br>codex ' + escapeHtml(session.codexSessionId) : '') +
          (modelMetaForSession(session) ? '<br>' + escapeHtml(modelMetaForSession(session)) : '') + '</div>' +
          '<div class="turn-text">' + escapeHtml(readableSummary(session)) + '</div>' +
          conversationEvidence(session) +
          rawStreamDetails(session),
      });
    const renderFlowWorkspace = (group) => {
      if (!group) return '<div class="flow-inner"><div class="empty">No goal selected</div></div>';
      const orderedSessions = [...group.sessions].sort((left, right) => {
        const leftTime = Date.parse(left.startedAt || "") || 0;
        const rightTime = Date.parse(right.startedAt || "") || 0;
        return leftTime - rightTime;
      });
      const taskIdsWithSessions = new Set(orderedSessions.map((session) => session.taskId));
      const pendingFlow = group.tasks.filter((task) => !taskIdsWithSessions.has(task.id) && (task.status === "todo" || task.status === "running"));
      return '<div class="flow-inner"><div class="transcript">' +
        turn({
          primary: true,
          key: "goal:" + group.id,
          mark: "go",
          author: escapeHtml(group.titleTask.goal),
          summary: '<span class="role-label">' + escapeHtml(roleSummary(group.tasks)) + '</span> · <span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span>',
          action: promptLink(group.titleTask),
          body: '<div class="tool-line">' + taskMeta(group.root) + '</div><div class="turn-text">' + escapeHtml(group.root.prompt) + '</div>',
        }) +
        (orderedSessions.length ? orderedSessions.map(sessionFlowTurn).join("") : '<div class="empty">No sessions recorded for this goal yet.</div>') +
        (pendingFlow.length ? pendingFlow.map((task) => turn({
          key: "task:" + task.id,
          mark: roleMark(task.role),
          author: escapeHtml(task.role),
          summary: escapeHtml(task.goal),
          action: '<span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span>',
          body: '<div class="tool-line">' + taskMeta(task) + '</div>',
        })).join("") : '') +
        (group.lessons.length ? turn({
          key: "lessons:" + group.id,
          mark: "le",
          author: "Lessons and experiences",
          summary: escapeHtml(group.lessons.length + " records"),
          body: lessonList(group.lessons.slice(-6)),
        }) : '') +
        '</div></div>';
    };
    const graphColumn = (role) => role === "planner" || role === "goal-review" ? "planner" : role === "verifier" ? "verifier" : "worker";
    const graphColumnX = (column) => column === "planner" ? 0 : column === "verifier" ? 720 : 360;
    const canvasGraphFor = (overview, group) => {
      if (!group) return { nodes: [], edges: [] };
      const groupTaskIds = relatedTaskIdsFor(overview, group.id);
      const tasks = overview.tasks.filter((task) => groupTaskIds.has(task.id));
      const sessions = new Map((overview.sessions || []).filter((session) => groupTaskIds.has(session.taskId)).map((session) => [session.taskId, {
        status: session.status,
        attemptId: session.attemptId,
        sessionName: session.sessionName,
        codexSessionId: session.codexSessionId,
        latestText: latestText(session),
        model: session.model || null,
      }]));
      const columns = new Map();
      const nodes = tasks.map((task, index) => {
        const column = graphColumn(task.role);
        const row = columns.get(column) || 0;
        columns.set(column, row + 1);
        return {
          id: task.id,
          type: "task",
          position: { x: graphColumnX(column), y: row * 190 + (index % 2) * 12 },
          data: {
            role: task.role,
            status: task.status,
            goal: compact(task.goal, 118),
            taskId: task.id,
            doneWhenCount: Array.isArray(task.doneWhen) ? task.doneWhen.length : 0,
            latestSession: sessions.get(task.id) || null,
          },
        };
      });
      const edges = graphRelationsFor(overview).filter((edge) => groupTaskIds.has(edge.sourceId) && groupTaskIds.has(edge.targetId)).map((edge) => ({
        id: edge.kind + ":" + edge.sourceId + "->" + edge.targetId,
        source: edge.sourceId,
        target: edge.targetId,
        label: edge.kind,
        type: "smoothstep",
        animated: tasks.some((task) => task.id === edge.targetId && task.status === "running"),
        markerEnd: { type: "arrowclosed" },
      }));
      return { nodes, edges };
    };
    const renderCanvasWorkspace = (group) => {
      if (!group) return '<div class="canvas-inner"><div class="empty">No goal selected</div></div>';
      const graph = canvasGraphFor(latestOverview || { tasks: group.tasks, sessions: group.sessions, lessons: group.lessons }, group);
      return '<div class="canvas-inner" data-canvas-goal-id="' + escapeHtml(group.id) + '">' +
        '<div id="dashboard-canvas-root" data-canvas-graph="' + escapeHtml(JSON.stringify(graph)) + '"></div>' +
        '<div hidden>' + graph.nodes.map((node) => {
          const task = node.data;
          const model = task.latestSession && task.latestSession.model ? task.latestSession.model : null;
          return '<span data-canvas-task-id="' + escapeHtml(task.taskId) + '">' + escapeHtml(task.role) + ' ' + escapeHtml(task.status) +
            (model ? ' model ' + escapeHtml(model.model || "") + ' source ' + escapeHtml(model.source || "") : '') + '</span>';
        }).join("") + graph.edges.map((edge) =>
          '<span data-canvas-edge="' + escapeHtml(edge.id) + '">' + escapeHtml(edge.label) + '</span>'
        ).join("") + '</div>' +
        '</div>';
    };
    const renderWorkspace = (group) => workspaceMode === "canvas" ? renderCanvasWorkspace(group) : renderFlowWorkspace(group);
    const mountReactFlowCanvas = () => {
      if (workspaceMode !== "canvas") return;
      const mount = document.getElementById("dashboard-canvas-root");
      if (!mount) return;
      const graphJson = mount.getAttribute("data-canvas-graph") || '{"nodes":[],"edges":[]}';
      const mountGraph = () => {
        try {
          window.OuroborosCanvas?.render(mount, JSON.parse(graphJson));
        } catch (error) {
          mount.innerHTML = '<div class="empty">Canvas failed to render: ' + escapeHtml(error && error.message ? error.message : String(error)) + '</div>';
        }
      };
      if (window.OuroborosCanvas) {
        mountGraph();
      } else {
        window.addEventListener("ouroboros-canvas-ready", mountGraph, { once: true });
      }
    };
    const renderInspector = (overview, group) => {
      if (!group) return '<section class="inspector-card" data-inspector-section="progress"><h2>Detail</h2><div class="empty">Select a goal</div></section>';
      const doneWhen = group.tasks.flatMap((task) => (Array.isArray(task.doneWhen) ? task.doneWhen : []).map((item) => ({ task, item })));
      const runningSessions = group.sessions.filter((session) => session.status === "running");
      const unresolvedBlockedTasks = group.tasks.filter((task) => task.status === "blocked" && !group.resolvedBlockedTaskIds.has(task.id));
      const currentTask = group.tasks.find((task) => task.status === "running") ||
        group.tasks.find((task) => task.status === "todo") ||
        unresolvedBlockedTasks[unresolvedBlockedTasks.length - 1] ||
        [...group.tasks].reverse().find((task) => task.status === "done") ||
        [...group.tasks].reverse().find((task) => task.status === "blocked");
      const resumableTask = runningSessions.length ? null : unresolvedBlockedTasks[unresolvedBlockedTasks.length - 1] || null;
      const rerunnableTask = runningSessions.length ? null : [...unresolvedBlockedTasks, ...group.tasks.filter((task) => task.status === "done")].reverse()[0] || null;
      const taskActions = [
        runningSessions.length ? '<button class="plain-button danger" data-stop-attempt-id="' + escapeHtml(runningSessions[0].attemptId) + '">Stop current task</button>' : '',
        resumableTask ? '<button class="plain-button" data-resume-task-id="' + escapeHtml(resumableTask.id) + '">Resume selected task</button>' : '',
        rerunnableTask ? '<button class="plain-button" data-rerun-task-id="' + escapeHtml(rerunnableTask.id) + '">Rerun selected task</button>' : ''
      ].filter(Boolean).join("");
      return '<section class="inspector-card" data-inspector-section="progress"><h2>Progress</h2>' +
        (currentTask ? '<div class="current-task"><div class="current-task-title">' + escapeHtml(currentTask.goal) + '</div><div class="current-task-meta">' + escapeHtml(currentTask.role) + ' · <span class="status-text ' + escapeHtml(currentTask.status) + '">' + escapeHtml(currentTask.status) + '</span><br><span class="code-meta">' + escapeHtml(currentTask.id) + '</span></div></div>' : '') +
        (doneWhen.length ? '<ul class="todo-list">' + doneWhen.map(({ task, item }) =>
          '<li class="todo-item ' + (effectiveTaskStatus(task, group.resolvedBlockedTaskIds) === "done" ? "done" : "") + '"><span class="checkbox ' + (effectiveTaskStatus(task, group.resolvedBlockedTaskIds) === "done" ? "done" : "") + '" aria-hidden="true"></span><span class="todo-text">' + escapeHtml(item) + '<span class="meta">' + escapeHtml(task.role) + '</span></span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded</div>') +
        (group.resolvedBlockedCount ? '<div class="meta">' + escapeHtml(group.resolvedBlockedCount) + ' blocked verifier task was repaired and is now historical evidence.</div>' : '') +
        (taskActions ? '<div class="action-group"><div class="action-title">Task actions</div><div class="action-help">These controls affect only the selected task.</div><div class="action-buttons">' + taskActions + '</div></div>' : '') +
        '</section>' + renderChangedFilesSection(group);
    };
    const latestRunnerSignal = (overview) => {
      const session = [...(overview.sessions || [])].reverse()[0];
      const text = session ? latestText(session) : "";
      if (!session || !text || session.status === "done") return null;
      if (session.status !== "running" && session.status !== "blocked") return null;
      const timedOut = text.includes("Reconnecting... 5/5") || text.toLowerCase().includes("request timed out");
      return {
        status: session.status,
        taskGoal: session.taskGoal,
        attemptId: session.attemptId,
        text,
        timedOut,
      };
    };
    const runnerOutputSnippet = (runner, runDone) => {
      const text = String(runner?.lastOutput || "").trim();
      if (!text || runDone || runner?.exitCode === 0) return "";
      if (text.startsWith("{") && text.includes('"status":"done"')) return "";
      return compact(text, 900);
    };
    const renderSupervisor = (overview) => {
      const supervisor = overview.supervisor;
      const status = supervisor?.status || "idle";
      const globalRuns = overview.globalRuns || {};
      const todoRuns = globalRuns.todo || 0;
      const runningRuns = globalRuns.running || 0;
      const output = String(supervisor?.lastOutput || "").trim();
      const canStart = status !== "running" && (todoRuns > 0 || runningRuns > 0);
      const canStop = status === "running" && !supervisor?.externallyManaged;
      const statusClass = status === "running" ? "running" : todoRuns || runningRuns ? "todo" : "done";
      return '<section class="inspector-card" data-inspector-section="supervisor"><h2>Supervisor</h2>' +
        '<div class="current-task"><div class="current-task-title">Global supervisor</div><div class="current-task-meta">' +
        escapeHtml(todoRuns) + ' todo run' + (todoRuns === 1 ? "" : "s") + ' · ' +
        escapeHtml(runningRuns) + ' running run' + (runningRuns === 1 ? "" : "s") +
        ' · <span class="status-text ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + '</span>' +
        (supervisor?.pid ? '<br><span class="code-meta">pid ' + escapeHtml(supervisor.pid) + '</span>' : '') +
        (supervisor?.externallyManaged ? '<br><span class="code-meta">external supervisor observed</span>' : '') +
        (supervisor?.exitCode !== undefined && supervisor?.exitCode !== null ? '<br><span class="code-meta">exit ' + escapeHtml(supervisor.exitCode) + '</span>' : '') +
        '</div></div>' +
        (output ? '<div class="stream-output">' + escapeHtml(compact(output, 900)) + '</div>' : '') +
        (canStart || canStop ? '<div class="action-group"><div class="action-title">Runner actions</div><div class="action-help">These controls affect the run-level runner or supervisor process.</div><div class="action-buttons">' +
          (canStart ? '<button class="plain-button" data-start-supervisor>Start supervisor</button>' : '') +
          (canStop ? '<button class="plain-button danger" data-stop-supervisor>Stop supervisor</button>' : '') +
        '</div></div>' : '') +
        '</section>';
    };
    const renderDiagnosis = (overview) => {
      const diagnosis = overview.diagnosis;
      if (!diagnosis || typeof diagnosis !== "object") return "";
      const state = typeof diagnosis.state === "string" ? diagnosis.state : "unknown";
      const reason = compact(String(diagnosis.reason || ""), 220);
      const activeWork = diagnosis.activeWork || {};
      const readyCount = Array.isArray(activeWork.readyTaskIds) ? activeWork.readyTaskIds.length : 0;
      const runningCount = Array.isArray(activeWork.runningTaskIds) ? activeWork.runningTaskIds.length : 0;
      const runningAttempts = Array.isArray(diagnosis.runningAttempts) ? diagnosis.runningAttempts : [];
      const orphanedLeases = Array.isArray(diagnosis.orphanedLeases) ? diagnosis.orphanedLeases : [];
      const queueStarvation = Boolean(diagnosis.queueStarvation);
      const raceRisk = Boolean(diagnosis.emptyRunGoalReviewRaceRisk);
      const stateClass = state === "complete" ? "done" : state === "paused" || state === "blocked" ? "blocked" : state === "orphaned" ? "blocked" : state === "draining" ? "running" : "todo";
      const parts = [];
      parts.push('<section class="inspector-card" data-inspector-section="diagnosis"><h2>Overseer diagnosis</h2>');
      parts.push('<div class="current-task"><div class="current-task-title">Run supervisor state</div><div class="current-task-meta">');
      parts.push(escapeHtml(readyCount) + ' ready · ' + escapeHtml(runningCount) + ' running · <span class="status-text ' + escapeHtml(stateClass) + '">' + escapeHtml(state) + '</span>');
      parts.push('<br><span class="code-meta">' + escapeHtml(reason) + '</span>');
      if (queueStarvation) parts.push('<br><span class="code-meta">queue starvation: ready work without a live runner</span>');
      if (raceRisk) parts.push('<br><span class="code-meta">empty-run goal-review race risk</span>');
      parts.push('</div></div>');
      if (runningAttempts.length > 0) {
        parts.push('<div class="meta">Running attempts</div><ul class="task-list">');
        for (const attempt of runningAttempts.slice(0, 4)) {
          const meta = [escapeHtml(attempt.role || "session")].filter(Boolean);
          if (attempt.codexSessionId) meta.push('<span class="code-meta">codex ' + escapeHtml(attempt.codexSessionId) + '</span>');
          parts.push('<li class="task-row"><span class="task-role">' + escapeHtml(attempt.attemptId) + '</span> <span class="task-meta">' + escapeHtml(attempt.taskId) + (meta.length ? ' · ' + meta.join(" · ") : "") + '</span></li>');
        }
        parts.push('</ul>');
      }
      if (orphanedLeases.length > 0) {
        parts.push('<div class="meta">Orphaned leases</div><ul class="task-list">');
        for (const lease of orphanedLeases.slice(0, 4)) {
          const meta = [escapeHtml(lease.reason || "running task has no running attempt")];
          if (lease.sessionRef) meta.push('<span class="code-meta">session ' + escapeHtml(lease.sessionRef) + '</span>');
          if (lease.worktreePath) meta.push('<span class="code-meta">worktree ' + escapeHtml(lease.worktreePath) + '</span>');
          parts.push('<li class="task-row"><span class="task-role">' + escapeHtml(lease.taskId) + '</span> <span class="task-meta">' + meta.join(" · ") + '</span></li>');
        }
        parts.push('</ul>');
      }
      parts.push('</section>');
      return parts.join("");
    };
    const renderRunner = (overview) => {
      const runner = overview.runner;
      const issue = latestRunnerSignal(overview);
      const status = runner?.status || "idle";
      const runDone = overview.run?.status === "done";
      const queuedTasks = (overview.tasks || []).filter((task) => task.status === "todo" || task.status === "running");
      const hasQueuedWork = queuedTasks.length > 0;
      const stalledQueue = !runDone && status !== "running" && hasQueuedWork;
      const canStart = status !== "running" && !runDone && hasQueuedWork;
      const canStop = status === "running";
      const output = runnerOutputSnippet(runner, runDone);
      const statusClass = status === "running" ? "running" : stalledQueue ? "blocked" : runDone || runner?.exitCode === 0 ? "done" : status === "exited" ? "blocked" : "todo";
      const title = runDone ? "Run complete" : status === "running" ? "Background runner" : stalledQueue ? "Queue waiting for runner" : "Runner idle";
      const meta = runDone ? "goal reached" : status === "running" ? "background loop is active" : stalledQueue ? queuedTasks.length + " active task" + (queuedTasks.length === 1 ? "" : "s") + " waiting; dashboard is only observing because the runner is " + status : "no queued work";
      return '<section class="inspector-card" data-inspector-section="runner"><h2>Runner</h2>' +
        '<div class="current-task"><div class="current-task-title">' + escapeHtml(title) + '</div><div class="current-task-meta">' + escapeHtml(meta) + ' · <span class="status-text ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + '</span>' +
        (runner?.pid ? '<br><span class="code-meta">pid ' + escapeHtml(runner.pid) + '</span>' : '') +
        (runner?.exitCode !== undefined && runner?.exitCode !== null ? '<br><span class="code-meta">exit ' + escapeHtml(runner.exitCode) + '</span>' : '') +
        (stalledQueue && queuedTasks[0] ? '<br><span class="code-meta">next ' + escapeHtml(queuedTasks[0].role) + ' · ' + escapeHtml(queuedTasks[0].id) + '</span>' : '') +
        '</div></div>' +
        (issue ? '<div class="current-task"><div class="current-task-title">' + escapeHtml(issue.timedOut ? "Connection timed out" : "Latest runner issue") + '</div><div class="current-task-meta">' + escapeHtml(issue.taskGoal) + '<br><span class="code-meta">' + escapeHtml(issue.attemptId) + '</span></div><div class="stream-output">' + escapeHtml(issue.text) + '</div></div>' : '') +
        (output ? '<div class="stream-output">' + escapeHtml(output) + '</div>' : '') +
        (canStart || canStop ? '<div class="action-group"><div class="action-title">Runner actions</div><div class="action-help">These controls affect the run-level runner or supervisor process.</div><div class="action-buttons">' +
          (canStart ? '<button class="plain-button" data-start-runner>Start background runner</button>' : '') +
          (canStop ? '<button class="plain-button danger" data-stop-runner>Stop background runner</button>' : '') +
        '</div></div>' : '') +
        '</section>';
    };
    const postJson = async (path, body) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "request failed");
      return payload;
    };
    const attachmentMetaForFile = (file) => ({
      name: file.name,
      type: file.type || "text/plain",
      size: file.size,
    });
    const readAttachment = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ ...attachmentMetaForFile(file), content: String(reader.result || "") });
      reader.onerror = () => reject(reader.error || new Error("attachment read failed"));
      reader.readAsText(file);
    });
    const renderAttachmentChips = () => {
      const node = document.getElementById("attachment-chips");
      if (!node) return;
      node.innerHTML = attachments.map((attachment, index) =>
        '<div class="attachment-chip" data-attachment-index="' + index + '"><span title="' + escapeHtml(attachment.name) + '">' +
        escapeHtml(attachment.name || "attachment") + '</span><button type="button" aria-label="Remove attachment" data-remove-attachment="' + index + '">x</button></div>'
      ).join("");
    };
    const intakeDocument = (prompt, attachmentList) => {
      const sections = ["Prompt:\\n" + prompt.trim()];
      for (const attachment of attachmentList) {
        sections.push([
          "Attachment: " + (attachment.name || "attachment"),
          "type: " + (attachment.type || "text/plain"),
          "size: " + Number(attachment.size || 0),
          "",
          String(attachment.content || ""),
        ].join("\\n"));
      }
      return sections.join("\\n\\n---\\n\\n");
    };
    const fetchDiffForChangedFile = async (path) => {
      if (!path) return;
      diffByPath.set(path, { status: "loading" });
      if (latestOverview) render(latestOverview);
      try {
        const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/diff?path=" + encodeURIComponent(path));
        const diff = await response.text();
        if (!response.ok) throw new Error(diff || "diff request failed");
        diffByPath.set(path, { status: "done", diff });
      } catch (error) {
        diffByPath.set(path, { status: "error", error: error && error.message ? error.message : String(error) });
      }
      if (latestOverview) render(latestOverview);
    };
    const refreshOverview = () => overviewWorker.postMessage({ type: "refresh" });
    const setIntakeStatus = (message) => {
      const node = document.getElementById("intake-form-status");
      if (node) node.textContent = message;
    };
    const setGoalFormStatus = setIntakeStatus;
    const renderedHtml = new Map();
    const setTextIfChanged = (id, value) => {
      const node = document.getElementById(id);
      const next = String(value ?? "");
      if (node && node.textContent !== next) node.textContent = next;
    };
    const setHtmlIfChanged = (id, html) => {
      const current = renderedHtml.get(id);
      if (current === html) return;
      renderedHtml.set(id, html);
      const node = document.getElementById(id);
      if (node) node.innerHTML = html;
    };
    const patchKeyedChildren = (id, html, keyAttribute) => {
      if (renderedHtml.get(id) === html) return;
      const node = document.getElementById(id);
      if (!node) return;
      const template = document.createElement("template");
      template.innerHTML = html;
      const nextChildren = Array.from(template.content.children);
      const keyedNextChildren = nextChildren.filter((child) => child.hasAttribute(keyAttribute));
      if (keyedNextChildren.length === 0) {
        renderedHtml.set(id, html);
        node.innerHTML = html;
        return;
      }
      const nextKeys = new Set(keyedNextChildren.map((child) => child.getAttribute(keyAttribute)));
      for (const currentChild of Array.from(node.children)) {
        const key = currentChild.getAttribute(keyAttribute);
        if (!key || !nextKeys.has(key)) currentChild.remove();
      }
      for (const nextChild of keyedNextChildren) {
        const key = nextChild.getAttribute(keyAttribute);
        const currentChild = node.querySelector("[" + keyAttribute + "=\\"" + CSS.escape(key) + "\\"]");
        if (!currentChild) {
          node.appendChild(nextChild.cloneNode(true));
          continue;
        }
        if (currentChild.outerHTML !== nextChild.outerHTML) {
          currentChild.replaceWith(nextChild.cloneNode(true));
          continue;
        }
        node.appendChild(currentChild);
      }
      renderedHtml.set(id, html);
    };
    const patchInspectorPanel = (inspectorHtml, runnerHtml) => {
      patchKeyedChildren("inspector-panel", inspectorHtml + runnerHtml, "data-inspector-section");
    };
    const syncWorkspaceToggle = () => {
      for (const button of document.querySelectorAll("[data-workspace-mode]")) {
        const active = button.getAttribute("data-workspace-mode") === workspaceMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    };
    const syncWorkspaceTitle = (title) => {
      const titleNode = document.getElementById("workspace-title");
      const toggle = document.getElementById("workspace-title-toggle");
      const next = String(title ?? "");
      if (titleNode && titleNode.textContent !== next) titleNode.textContent = next;
      if (titleNode) {
        titleNode.setAttribute("title", next);
        titleNode.classList.toggle("is-expanded", workspaceTitleExpanded);
        titleNode.classList.toggle("is-collapsed", !workspaceTitleExpanded);
      }
      if (toggle) {
        toggle.setAttribute("aria-expanded", workspaceTitleExpanded ? "true" : "false");
        toggle.setAttribute("aria-label", workspaceTitleExpanded ? "Collapse workspace title" : "Expand workspace title");
        toggle.textContent = workspaceTitleExpanded ? "Collapse" : "Expand";
      }
    };
    const captureFlowScrollState = () => {
      if (workspaceMode !== "flow") return;
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      return {
        scrollTop: node.scrollTop,
        shouldFollowBottom: distanceFromBottom <= 48,
        streams: Array.from(node.querySelectorAll(".stream-output[data-attempt-stream]")).map((stream) => {
          const streamDistanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
          return {
            attemptId: stream.getAttribute("data-attempt-stream"),
            scrollTop: stream.scrollTop,
            shouldFollowBottom: streamDistanceFromBottom <= 48,
          };
        }),
      };
    };
    const restoreFlowScrollState = (scrollState) => {
      if (workspaceMode !== "flow" || !scrollState) return;
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      requestAnimationFrame(() => {
        node.scrollTop = scrollState.shouldFollowBottom ? node.scrollHeight : scrollState.scrollTop;
        for (const stream of node.querySelectorAll(".stream-output[data-attempt-stream]")) {
          const streamScroll = scrollState.streams.find((item) => item.attemptId === stream.getAttribute("data-attempt-stream"));
          if (!streamScroll) continue;
          stream.scrollTop = streamScroll.shouldFollowBottom ? stream.scrollHeight : streamScroll.scrollTop;
        }
      });
    };
    const patchStreamOutput = (currentStream, nextStream) => {
      const nextLines = Array.from(nextStream.querySelectorAll("[data-event-index]"));
      if (nextLines.length === 0) {
        if (currentStream.innerHTML !== nextStream.innerHTML) currentStream.innerHTML = nextStream.innerHTML;
        return;
      }
      const nextIndexes = new Set(nextLines.map((line) => line.getAttribute("data-event-index")));
      for (const currentLine of Array.from(currentStream.querySelectorAll("[data-event-index]"))) {
        if (!nextIndexes.has(currentLine.getAttribute("data-event-index"))) currentLine.remove();
      }
      for (const nextLine of nextLines) {
        const index = nextLine.getAttribute("data-event-index");
        const currentLine = currentStream.querySelector('[data-event-index="' + CSS.escape(index) + '"]');
        if (!currentLine) {
          currentStream.appendChild(nextLine.cloneNode(true));
          continue;
        }
        if (currentLine.outerHTML !== nextLine.outerHTML) {
          currentLine.replaceWith(nextLine.cloneNode(true));
          continue;
        }
        currentStream.appendChild(currentLine);
      }
    };
    const patchWorkspaceTurn = (currentTurn, nextTurn) => {
      if (currentTurn.outerHTML === nextTurn.outerHTML) return;
      for (const nextStream of nextTurn.querySelectorAll(".stream-output[data-attempt-stream]")) {
        const attemptId = nextStream.getAttribute("data-attempt-stream");
        const currentStream = currentTurn.querySelector('.stream-output[data-attempt-stream="' + CSS.escape(attemptId) + '"]');
        if (currentStream) patchStreamOutput(currentStream, nextStream);
      }
      if (currentTurn.outerHTML === nextTurn.outerHTML) return;
      const patchedTurn = nextTurn.cloneNode(true);
      for (const nextStream of Array.from(patchedTurn.querySelectorAll(".stream-output[data-attempt-stream]"))) {
        const attemptId = nextStream.getAttribute("data-attempt-stream");
        const currentStream = currentTurn.querySelector('.stream-output[data-attempt-stream="' + CSS.escape(attemptId) + '"]');
        if (currentStream) nextStream.replaceWith(currentStream);
      }
      currentTurn.replaceChildren(...Array.from(patchedTurn.childNodes));
    };
    const patchWorkspace = (html) => {
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      const scrollState = captureFlowScrollState();
      if (renderedHtml.get("workspace-flow") === html) {
        restoreFlowScrollState(scrollState);
        return;
      }
      const template = document.createElement("template");
      template.innerHTML = html;
      const nextTranscript = template.content.querySelector(".transcript");
      const currentTranscript = node.querySelector(".transcript");
      if (!nextTranscript || !currentTranscript) {
        renderedHtml.set("workspace-flow", html);
        node.innerHTML = html;
        restoreFlowScrollState(scrollState);
        return;
      }
      const nextTurns = Array.from(nextTranscript.querySelectorAll("[data-turn-key]"));
      const nextKeys = new Set(nextTurns.map((turnNode) => turnNode.getAttribute("data-turn-key")));
      for (const currentTurn of Array.from(currentTranscript.querySelectorAll("[data-turn-key]"))) {
        if (!nextKeys.has(currentTurn.getAttribute("data-turn-key"))) currentTurn.remove();
      }
      for (const nextTurn of nextTurns) {
        const key = nextTurn.getAttribute("data-turn-key");
        const currentTurn = currentTranscript.querySelector('[data-turn-key="' + CSS.escape(key) + '"]');
        if (!currentTurn) {
          currentTranscript.appendChild(nextTurn.cloneNode(true));
          continue;
        }
        patchWorkspaceTurn(currentTurn, nextTurn);
        currentTranscript.appendChild(currentTurn);
      }
      renderedHtml.set("workspace-flow", html);
      restoreFlowScrollState(scrollState);
    };
    const overviewWorkerSource = [
      'let runId = null;',
      'let apiBase = "";',
      'let timer = null;',
      'const shouldPoll = (overview) => overview.supervisor?.status === "running" || overview.runner?.status === "running" || overview.run?.status !== "done" || (overview.globalRuns?.todo || 0) > 0 || (overview.globalRuns?.running || 0) > 0 || overview.sessions.some((session) => session.status === "running");',
      'const schedule = (delay) => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, delay); };',
      'async function refresh() {',
      '  if (!runId) return;',
      '  try {',
      '    self.postMessage({ type: "refreshing" });',
      '    const response = await fetch(apiBase + "/api/runs/" + encodeURIComponent(runId) + "/overview");',
      '    if (!response.ok) throw new Error("overview request failed: " + response.status);',
      '    const overview = await response.json();',
      '    self.postMessage({ type: "overview", overview });',
      '    if (shouldPoll(overview)) schedule(1500);',
      '  } catch (error) {',
      '    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });',
      '    schedule(5000);',
      '  }',
      '}',
      'self.onmessage = (event) => {',
      '  if (event.data?.type === "start") { runId = event.data.runId; apiBase = event.data.apiBase || ""; refresh(); }',
      '  if (event.data?.type === "refresh") refresh();',
      '};'
    ].join("\\n");
    const overviewWorker = new Worker(URL.createObjectURL(new Blob([overviewWorkerSource], { type: "text/javascript" })));
    overviewWorker.onmessage = (event) => {
      if (event.data?.type === "refreshing") document.getElementById("run-status")?.classList.add("updating");
      if (event.data?.type === "overview") {
        document.getElementById("run-status")?.classList.remove("updating");
        render(event.data.overview);
      }
      if (event.data?.type === "error") console.error("overview worker:", event.data.message);
    };
    overviewWorker.onerror = (event) => console.error("overview worker:", event.message);
    function render(overview) {
      latestOverview = overview;
      const taskCounts = byStatus(overview.tasks);
      const globalRuns = overview.globalRuns || {};
      const sessionCounts = byStatus(overview.sessions);
      const goalGroups = buildGoalGroups(overview);
      const activeGroups = goalGroups.filter((group) => group.activeTasks.length > 0);
      if (!selectedGoalId || !goalGroups.some((group) => group.id === selectedGoalId)) {
        selectedGoalId = (activeGroups[0] || goalGroups[goalGroups.length - 1] || {}).id || null;
        workspaceTitleExpanded = false;
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
      }
      const selectedGroup = goalGroups.find((group) => group.id === selectedGoalId);
      const projectName = overview.project ? overview.project.name : "Project Workspace";
      const projectRoot = overview.project ? overview.project.rootPath : "";
      const projectTitle = projectRoot ? projectName + " · " + projectRoot : projectName;
      setTextIfChanged("run-status", overview.run?.status || "unknown");
      setTextIfChanged("run-title", overview.run ? overview.run.goal : runId);
      const projectHeader = document.querySelector("[data-project-header]");
      if (projectHeader) projectHeader.setAttribute("title", projectTitle);
      const projectNameNode = document.querySelector("[data-project-name]");
      if (projectNameNode && projectNameNode.textContent !== projectName) projectNameNode.textContent = projectName;
      const projectRootNode = document.querySelector("[data-project-root]");
      if (projectRootNode && projectRootNode.textContent !== projectRoot) projectRootNode.textContent = projectRoot;
      setTextIfChanged("workspace-kicker", selectedGroup ? selectedGroup.status + " / " + selectedGroup.tasks.length + " tasks" : "Goal Flow");
      syncWorkspaceTitle(selectedGroup ? selectedGroup.titleTask.goal : "No goal selected");
      syncWorkspaceToggle();
      document.getElementById("workspace-flow")?.classList.toggle("canvas-workspace", workspaceMode === "canvas");
      setHtmlIfChanged("sidebar-stats", [
        ["Goals", goalGroups.length],
        ["Active goals", activeGroups.length],
        ["Global todo runs", globalRuns.todo || 0],
        ["Global running runs", globalRuns.running || 0],
        ["Queued tasks", (taskCounts.todo || 0) + (taskCounts.running || 0)],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join(""));
      setHtmlIfChanged("active-goal-list", activeGroups.length ? activeGroups.map(goalRow).join("") : '<div class="empty"><strong>Idle</strong>No active tasks. Describe the next goal in the composer.</div>');
      setHtmlIfChanged("history-goal-list", [...goalGroups].reverse().filter((group) => group.activeTasks.length === 0).map(goalRow).join(""));
      patchWorkspace(renderWorkspace(selectedGroup));
      mountReactFlowCanvas();
      patchInspectorPanel(renderInspector(overview, selectedGroup), renderGuardrailsSection(overview) + renderDiagnosis(overview) + renderSupervisor(overview) + renderRunner(overview));
    }
    let recentRunsCache = [];
    const RECENT_RUNS_LIMIT = 10;
    const renderRecentRunsList = (runs) => {
      const node = document.getElementById("recent-runs-list");
      if (!node) return;
      if (!Array.isArray(runs) || runs.length === 0) {
        node.innerHTML = '<div class="empty">No recent runs available.</div>';
        return;
      }
      node.innerHTML = runs.map((entry) => {
        const id = typeof entry?.id === "string" ? entry.id : "";
        if (!id) return "";
        const status = typeof entry?.status === "string" ? entry.status : "unknown";
        const goal = typeof entry?.goal === "string" && entry.goal.trim() ? entry.goal : "(no goal)";
        const isActive = id === runId;
        return '<button type="button" class="history-run-row' + (isActive ? " is-active" : "") + '" data-history-run-id="' + escapeHtml(id) + '" aria-current="' + (isActive ? "true" : "false") + '" title="' + escapeHtml(entry?.goal || id) + '">' +
          '<span class="history-run-status status-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '<span class="history-run-goal">' + escapeHtml(goal) + '</span>' +
          '<span class="history-run-id code-meta">' + escapeHtml(id) + '</span>' +
        '</button>';
      }).join("");
    };
    const refreshRecentRuns = () => {
      fetch("/api/runs?limit=" + encodeURIComponent(RECENT_RUNS_LIMIT))
        .then((response) => {
          if (!response.ok) throw new Error("recent runs request failed: " + response.status);
          return response.json();
        })
        .then((payload) => {
          recentRunsCache = Array.isArray(payload?.runs) ? payload.runs : [];
          renderRecentRunsList(recentRunsCache);
        })
        .catch((error) => {
          const node = document.getElementById("recent-runs-list");
          if (node) {
            node.innerHTML = '<div class="empty">' + escapeHtml(error?.message ? error.message : "Failed to load recent runs.") + '</div>';
          }
        });
    };
    const setSelectedRun = (nextRunId) => {
      if (typeof nextRunId !== "string" || !nextRunId || nextRunId === runId) {
        renderRecentRunsList(recentRunsCache);
        return;
      }
      runId = nextRunId;
      dashboardStorageKey = "ouroboros:dashboard:" + runId;
      try { window.localStorage?.setItem(activeRunStorageKey, runId); } catch {}
      try { window.history.replaceState(null, "", "#run=" + encodeURIComponent(runId)); } catch {}
      const restored = readDashboardState();
      selectedGoalId = restored.selectedGoalId;
      workspaceMode = restored.workspaceMode || "flow";
      workspaceTitleExpanded = restored.workspaceTitleExpanded === true;
      selectedChangedFilePath = null;
      diffByPath.clear();
      try { window.localStorage?.removeItem("ouroboros:dashboard:changedFile:" + runId); } catch {}
      overviewWorker.postMessage({ type: "start", runId, apiBase: window.location.origin });
      refreshRecentRuns();
    };
    window.addEventListener("hashchange", () => {
      const fromHash = parseRunIdFromHash(window.location.hash || "");
      if (fromHash && fromHash !== runId) {
        setSelectedRun(fromHash);
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const titleToggle = event.target.closest("[data-workspace-title-toggle]");
      if (titleToggle) {
        workspaceTitleExpanded = !workspaceTitleExpanded;
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
        syncWorkspaceTitle(document.getElementById("workspace-title")?.textContent || "");
        return;
      }
      const modeButton = event.target.closest("[data-workspace-mode]");
      if (modeButton) {
        workspaceMode = modeButton.getAttribute("data-workspace-mode") || "flow";
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
        if (latestOverview) render(latestOverview);
        return;
      }
      const changedFileButton = event.target.closest("[data-changed-file-node='file'][data-changed-file-path]");
      if (changedFileButton) {
        selectedChangedFilePath = changedFileButton.getAttribute("data-changed-file-path");
        if (latestOverview) render(latestOverview);
        fetchDiffForChangedFile(selectedChangedFilePath);
        return;
      }
      const attachButton = event.target.closest("[data-attach-files]");
      if (attachButton) {
        document.getElementById("attachment-input")?.click();
        return;
      }
      const clearAttachmentsButton = event.target.closest("[data-clear-attachments]");
      if (clearAttachmentsButton) {
        attachments = [];
        renderAttachmentChips();
        setIntakeStatus("");
        return;
      }
      const removeAttachmentButton = event.target.closest("[data-remove-attachment]");
      if (removeAttachmentButton) {
        const index = Number(removeAttachmentButton.getAttribute("data-remove-attachment"));
        attachments = attachments.filter((_, attachmentIndex) => attachmentIndex !== index);
        renderAttachmentChips();
        return;
      }
      const stopButton = event.target.closest("[data-stop-attempt-id]");
      if (stopButton) {
        const attemptId = stopButton.getAttribute("data-stop-attempt-id");
        stopButton.disabled = true;
        postJson("/api/attempts/" + encodeURIComponent(attemptId) + "/stop", {})
          .then(() => {
            setGoalFormStatus("Stopped current task.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { stopButton.disabled = false; });
        return;
      }
      const startRunnerButton = event.target.closest("[data-start-runner]");
      if (startRunnerButton) {
        startRunnerButton.disabled = true;
        postJson("/api/runs/" + encodeURIComponent(runId) + "/runner/start", {})
          .then(() => {
            setGoalFormStatus("Runner started.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { startRunnerButton.disabled = false; });
        return;
      }
      const stopRunnerButton = event.target.closest("[data-stop-runner]");
      if (stopRunnerButton) {
        stopRunnerButton.disabled = true;
        postJson("/api/runs/" + encodeURIComponent(runId) + "/runner/stop", {})
          .then(() => {
            setGoalFormStatus("Runner stopped.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { stopRunnerButton.disabled = false; });
        return;
      }
      const startSupervisorButton = event.target.closest("[data-start-supervisor]");
      if (startSupervisorButton) {
        startSupervisorButton.disabled = true;
        postJson("/api/supervisor/start", {})
          .then(() => {
            setIntakeStatus("Supervisor started.");
            refreshOverview();
          })
          .catch((error) => setIntakeStatus(error.message))
          .finally(() => { startSupervisorButton.disabled = false; });
        return;
      }
      const stopSupervisorButton = event.target.closest("[data-stop-supervisor]");
      if (stopSupervisorButton) {
        stopSupervisorButton.disabled = true;
        postJson("/api/supervisor/stop", {})
          .then(() => {
            setIntakeStatus("Supervisor stopped.");
            refreshOverview();
          })
          .catch((error) => setIntakeStatus(error.message))
          .finally(() => { stopSupervisorButton.disabled = false; });
        return;
      }
      const rerunButton = event.target.closest("[data-rerun-task-id]");
      if (rerunButton) {
        const taskId = rerunButton.getAttribute("data-rerun-task-id");
        rerunButton.disabled = true;
        postJson("/api/tasks/" + encodeURIComponent(taskId) + "/rerun", {})
          .then(() => {
            setGoalFormStatus("Task queued for rerun.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { rerunButton.disabled = false; });
        return;
      }
      const resumeButton = event.target.closest("[data-resume-task-id]");
      if (resumeButton) {
        const taskId = resumeButton.getAttribute("data-resume-task-id");
        resumeButton.disabled = true;
        postJson("/api/tasks/" + encodeURIComponent(taskId) + "/resume", {})
          .then(() => refreshOverview())
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { resumeButton.disabled = false; });
        return;
      }
      const acceptGuardrailButton = event.target.closest("[data-accept-guardrail]");
      if (acceptGuardrailButton) {
        const proposalId = acceptGuardrailButton.getAttribute("data-accept-guardrail");
        const proposalRunId = acceptGuardrailButton.getAttribute("data-accept-guardrail-run") || runId;
        const status = document.querySelector('[data-guardrail-status="' + CSS.escape(proposalId) + '"]');
        acceptGuardrailButton.disabled = true;
        if (status) { status.textContent = "Accepting..."; status.classList.remove("error"); }
        postJson("/api/runs/" + encodeURIComponent(proposalRunId) + "/guardrails/" + encodeURIComponent(proposalId) + "/accept", { acceptedBy: "dashboard" })
          .then(() => {
            if (status) { status.textContent = "Accepted. Refreshing..."; }
            refreshOverview();
          })
          .catch((error) => {
            if (status) { status.textContent = error.message; status.classList.add("error"); }
          })
          .finally(() => { acceptGuardrailButton.disabled = false; });
        return;
      }
      const historyRunRow = event.target.closest("[data-history-run-id]");
      if (historyRunRow) {
        const nextRunId = historyRunRow.getAttribute("data-history-run-id");
        if (nextRunId && nextRunId !== runId) {
          setSelectedRun(nextRunId);
        }
        return;
      }
      const row = event.target.closest("[data-goal-id]");
      if (!row) return;
      selectedGoalId = row.getAttribute("data-goal-id");
      workspaceTitleExpanded = false;
      writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
      if (latestOverview) render(latestOverview);
    });
    document.getElementById("attachment-input").addEventListener("change", async (event) => {
      const input = event.currentTarget;
      const files = Array.from(input.files || []);
      if (files.length === 0) return;
      setIntakeStatus("Reading attachments...");
      try {
        const read = await Promise.all(files.map(readAttachment));
        attachments = attachments.concat(read);
        renderAttachmentChips();
        setIntakeStatus(attachments.length + " attachment" + (attachments.length === 1 ? "" : "s") + " ready.");
      } catch (error) {
        setIntakeStatus(error && error.message ? error.message : String(error));
      } finally {
        input.value = "";
      }
    });
    document.getElementById("intake-input").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      document.getElementById("intake-composer").requestSubmit(document.querySelector("[data-send-intake]"));
    });
    document.getElementById("intake-composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = event.submitter || document.querySelector("[data-send-intake]");
      const input = document.getElementById("intake-input");
      const prompt = input.value.trim();
      if (!prompt && attachments.length === 0) {
        setIntakeStatus("Write a prompt or attach a file first.");
        return;
      }
      if (submitter) submitter.disabled = true;
      setIntakeStatus("Creating intake run...");
      postJson("/api/runs/" + encodeURIComponent(runId) + "/intake", {
        prompt,
        attachments,
        document: intakeDocument(prompt, attachments),
      })
        .then((payload) => {
          input.value = "";
          attachments = [];
          renderAttachmentChips();
          selectedGoalId = payload.runId || payload.taskId || selectedGoalId;
          workspaceTitleExpanded = false;
          writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
          setIntakeStatus("Intake planner queued.");
          refreshOverview();
        })
        .catch((error) => setIntakeStatus(error.message))
        .finally(() => { if (submitter) submitter.disabled = false; });
    });
    overviewWorker.postMessage({ type: "start", runId, apiBase: window.location.origin });
    refreshRecentRuns();
  </script>
</body>
</html>`;
}

const DASHBOARD_BIND_RETRY_LIMIT = 5;

export function shouldRetryDashboardBind(input: {
  port: number;
  error: unknown;
  attempt: number;
}) {
  if (input.port !== 0 || !Number.isFinite(input.attempt) || input.attempt >= DASHBOARD_BIND_RETRY_LIMIT) {
    return false;
  }
  if (!(input.error instanceof Error)) {
    return false;
  }
  const text = `${input.error.message ?? ""} ${(input.error as { code?: unknown }).code ?? ""}`.toLowerCase();
  return text.includes("eaddrinuse") || text.includes("address already in use");
}

export function serveDashboard(input: {
  runId: string;
  port: number;
  overview: () => RunOverview;
  childOverviews?: () => RunOverview[];
  runOverview?: (runId: string) => RunOverview;
  globalRunCounts?: () => RunStatusCounts;
  renderTaskPrompt: (taskId: string) => string;
  runnerStatus?: () => DashboardRunnerStatus | null;
  supervisorStatus?: () => DashboardRunnerStatus | null;
  autoStartRunner?: DashboardAutoStartRunner;
  actions?: DashboardActions;
  recentRuns?: (limit: number) => DashboardRunSummary[];
}) {
  const fetchHandler = (request: Request) =>
    withDashboardErrors(request, () => handleDashboardRequest(request, input));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DASHBOARD_BIND_RETRY_LIMIT; attempt += 1) {
    try {
      return Bun.serve({ port: input.port, fetch: fetchHandler });
    } catch (error) {
      lastError = error;
      if (!shouldRetryDashboardBind({ port: input.port, error, attempt })) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("serveDashboard bind failed");
}

async function withDashboardErrors(request: Request, handler: () => Response | Promise<Response>) {
  try {
    return await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: message,
          kind: message.includes("Ouroboros database is missing schema") ? "db_missing_schema" : "dashboard_error",
        },
        { status: 500 },
      );
    }
    throw error;
  }
}

export async function handleDashboardRequest(
  request: Request,
  input: {
    runId: string;
    overview: () => RunOverview;
    childOverviews?: () => RunOverview[];
    runOverview?: (runId: string) => RunOverview;
    globalRunCounts?: () => RunStatusCounts;
    renderTaskPrompt: (taskId: string) => string;
    runnerStatus?: () => DashboardRunnerStatus | null;
    supervisorStatus?: () => DashboardRunnerStatus | null;
    autoStartRunner?: DashboardAutoStartRunner;
    actions?: DashboardActions;
    recentRuns?: (limit: number) => DashboardRunSummary[];
  },
) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(dashboardHtml({ runId: input.runId }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/assets/dashboard-canvas.js") {
    return new Response(await bundledDashboardCanvasScript(), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/assets/dashboard-canvas.css") {
    return new Response(await bundledDashboardCanvasCss(), {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (url.pathname === "/api/runs") {
    return handleRecentRunsRequest(url, input.recentRuns);
  }
  const runGetMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/(overview|changed-files|diff)$/);
  if (runGetMatch) {
    const routeRunId = decodeURIComponent(runGetMatch[1]);
    const suffix = runGetMatch[2];
    if (routeRunId === input.runId) {
      if (suffix === "overview") {
        let overview = aggregateDashboardOverview(input.overview(), input.childOverviews?.() ?? []);
        let runner = input.runnerStatus?.() ?? null;
        let supervisor = input.supervisorStatus?.() ?? null;
        if (input.actions?.startRunner && supervisor?.status !== "running" && input.autoStartRunner?.(overview, runner)) {
          input.actions.startRunner();
          overview = aggregateDashboardOverview(input.overview(), input.childOverviews?.() ?? []);
          runner = input.runnerStatus?.() ?? runner;
          supervisor = input.supervisorStatus?.() ?? supervisor;
        }
        const globalRuns = input.globalRunCounts?.() ?? { todo: 0, running: 0, done: 0, blocked: 0 };
        supervisor = inferDashboardSupervisorStatus(supervisor, overview, globalRuns);
        const diagnosis = overviewDiagnosisForResponse(overview);
        return Response.json({ ...overview, runner, supervisor, globalRuns, diagnosis });
      }
      const primaryOverview = aggregateDashboardOverview(input.overview(), input.childOverviews?.() ?? []);
      if (suffix === "changed-files") {
        return Response.json(changedFilesPayload(primaryOverview));
      }
      return dashboardDiffResponse(primaryOverview, url);
    }
    if (!input.runOverview) {
      return Response.json(
        { error: `run overview provider is not configured` },
        { status: 404 },
      );
    }
    let resolvedOverview: RunOverview;
    try {
      resolvedOverview = input.runOverview(routeRunId);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 404 },
      );
    }
    const overview = aggregateDashboardOverview(resolvedOverview, []);
    if (suffix === "overview") {
      return Response.json({ ...overview, diagnosis: overviewDiagnosisForResponse(overview) });
    }
    if (suffix === "changed-files") {
      return Response.json(changedFilesPayload(overview));
    }
    return dashboardDiffResponse(overview, url);
  }
  const runPostMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/(runner\/start|runner\/stop|intake|goals|interrupt)$/);
  if (request.method === "POST" && runPostMatch) {
    const routeRunId = decodeURIComponent(runPostMatch[1]);
    if (routeRunId !== input.runId) {
      return Response.json(
        { error: `dashboard actions are only available on the primary run ${input.runId}` },
        { status: 404 },
      );
    }
  }
  const guardrailAcceptMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/guardrails\/([^/]+)\/accept$/);
  if (request.method === "POST" && guardrailAcceptMatch) {
    const routeRunId = decodeURIComponent(guardrailAcceptMatch[1]);
    if (routeRunId !== input.runId) {
      return Response.json(
        { error: `dashboard actions are only available on the primary run ${input.runId}` },
        { status: 404 },
      );
    }
    const proposalId = decodeURIComponent(guardrailAcceptMatch[2]);
    return withDashboardAction(async () => {
      if (!input.actions?.acceptGuardrailProposal) {
        throw new Error("dashboard guardrail acceptance is not configured");
      }
      const body = await readJsonBody(request).catch(() => ({} as Record<string, unknown>));
      const acceptedBy = optionalBodyString(body, "acceptedBy") || "dashboard";
      return input.actions.acceptGuardrailProposal(proposalId, acceptedBy);
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/runner/start`) {
    return withDashboardAction(async () => {
      if (!input.actions?.startRunner) {
        throw new Error("dashboard runner start is not configured");
      }
      return input.actions.startRunner();
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/runner/stop`) {
    return withDashboardAction(async () => {
      if (!input.actions?.stopRunner) {
        throw new Error("dashboard runner stop is not configured");
      }
      return input.actions.stopRunner();
    });
  }
  if (request.method === "POST" && url.pathname === "/api/supervisor/start") {
    return withDashboardAction(async () => {
      if (!input.actions?.startSupervisor) {
        throw new Error("dashboard supervisor start is not configured");
      }
      return input.actions.startSupervisor();
    });
  }
  if (request.method === "POST" && url.pathname === "/api/supervisor/stop") {
    return withDashboardAction(async () => {
      if (!input.actions?.stopSupervisor) {
        throw new Error("dashboard supervisor stop is not configured");
      }
      return input.actions.stopSupervisor();
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/intake`) {
    return withDashboardAction(async () => {
      if (!input.actions?.createIntake) {
        throw new Error("dashboard intake creation is not configured");
      }
      const body = await readJsonBody(request);
      const prompt = optionalBodyString(body, "prompt") || "Dashboard intake";
      return input.actions.createIntake(dashboardIntakeDocument(body), prompt);
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/goals`) {
    return withDashboardAction(async () => {
      if (!input.actions?.createGoal) {
        throw new Error("dashboard goal creation is not configured");
      }
      const body = await readJsonBody(request);
      const goal = requiredBodyString(body, "goal");
      return input.actions.createGoal(goal);
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/interrupt`) {
    return withDashboardAction(async () => {
      if (!input.actions?.interruptAndCreateGoal) {
        throw new Error("dashboard interrupt is not configured");
      }
      const body = await readJsonBody(request);
      const goal = requiredBodyString(body, "goal");
      return input.actions.interruptAndCreateGoal(goal);
    });
  }
  const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  if (request.method === "POST" && resumeMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.resumeTask) {
        throw new Error("dashboard resume is not configured");
      }
      return input.actions.resumeTask(decodeURIComponent(resumeMatch[1]));
    });
  }
  const rerunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
  if (request.method === "POST" && rerunMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.rerunTask) {
        throw new Error("dashboard rerun is not configured");
      }
      return input.actions.rerunTask(decodeURIComponent(rerunMatch[1]));
    });
  }
  const stopMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/stop$/);
  if (request.method === "POST" && stopMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.stopAttempt) {
        throw new Error("dashboard stop is not configured");
      }
      return input.actions.stopAttempt(decodeURIComponent(stopMatch[1]));
    });
  }
  const promptMatch = url.pathname.match(/^\/tasks\/([^/]+)\/prompt$/);
  if (promptMatch) {
    return new Response(input.renderTaskPrompt(decodeURIComponent(promptMatch[1])), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
}

function handleRecentRunsRequest(url: URL, provider: ((limit: number) => DashboardRunSummary[]) | undefined) {
  if (!provider) {
    return Response.json({ error: "recent runs are not configured" }, { status: 404 });
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "limit") {
      return Response.json({ error: `unknown query parameter: ${key}` }, { status: 400 });
    }
  }
  const rawLimit = url.searchParams.get("limit");
  let limit = DASHBOARD_RUNS_HISTORY_LIMIT_DEFAULT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    if (parsed > DASHBOARD_RUNS_HISTORY_LIMIT_MAX) {
      return Response.json({ error: `limit must be at most ${DASHBOARD_RUNS_HISTORY_LIMIT_MAX}` }, { status: 400 });
    }
    limit = parsed;
  }
  let summaries: DashboardRunSummary[];
  try {
    summaries = provider(limit);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  return Response.json({
    runs: summaries.map((summary) => ({
      id: summary.id,
      status: summary.status,
      goal: compactText(summary.goal ?? "", DASHBOARD_RUN_SUMMARY_GOAL_MAX),
      projectId: summary.projectId ?? null,
      createdAt: summary.createdAt ?? null,
    })),
  });
}

function dashboardDiffResponse(overview: RunOverview, url: URL) {
  const format = url.searchParams.get("format");
  const asJson = format === "json";
  const result = diffForChangedPath(overview, url.searchParams.get("path"));
  if (!result.ok) {
    return asJson
      ? Response.json({ error: result.error }, { status: result.status })
      : new Response(result.error, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return asJson
    ? Response.json({ path: result.path, diff: result.diff })
    : new Response(result.diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function changedFilesPayload(overview: RunOverview) {
  const seen = new Set<string>();
  const files = overview.sessions
    .flatMap((session) => {
      const changedFiles = Array.isArray(session.output?.changedFiles) ? session.output.changedFiles : [];
      return changedFiles.flatMap((rawPath) => {
        const path = normalizeTrackedPath(rawPath);
        if (!path || isOuroborosRuntimePath(path) || seen.has(path)) {
          return [];
        }
        seen.add(path);
        return [{ path, taskId: session.taskId, attemptId: session.attemptId, worktreePath: session.worktreePath ?? null }];
      });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files, tree: changedFilesTree(files.map((file) => file.path)) };
}

function changedFilesTree(paths: string[]) {
  type TreeNode = { name: string; path: string; type: "directory" | "file"; children?: TreeNode[] };
  const root: TreeNode[] = [];
  const directories = new Map<string, TreeNode[]>();
  directories.set("", root);
  for (const path of paths) {
    const parts = path.split("/");
    let parentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const nodePath = parentPath ? `${parentPath}/${name}` : name;
      const parent = directories.get(parentPath) ?? root;
      const isFile = index === parts.length - 1;
      let node = parent.find((candidate) => candidate.path === nodePath);
      if (!node) {
        node = isFile ? { name, path: nodePath, type: "file" } : { name, path: nodePath, type: "directory", children: [] };
        parent.push(node);
        parent.sort(compareTreeNodes);
      }
      if (!isFile) {
        directories.set(nodePath, node.children ?? []);
      }
      parentPath = nodePath;
    }
  }
  return root;
}

function compareTreeNodes(left: { type: string; path: string }, right: { type: string; path: string }) {
  if (left.type !== right.type) {
    return left.type === "file" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function diffForChangedPath(overview: RunOverview, rawPath: string | null):
  | { ok: true; path: string; diff: string }
  | { ok: false; status: number; error: string } {
  const path = normalizeTrackedPath(rawPath);
  if (!path) {
    return { ok: false, status: 400, error: rawPath ? "path traversal is not allowed" : "path is required" };
  }
  const payload = changedFilesPayload(overview);
  const file = payload.files.find((candidate) => candidate.path === path);
  if (!file) {
    return { ok: false, status: 404, error: `changed file not tracked: ${path}` };
  }
  const root = file.worktreePath ?? overview.project?.rootPath ?? overview.sessions.find((session) => session.worktreePath)?.worktreePath;
  if (!root) {
    return { ok: false, status: 400, error: "project root or task worktree is required for diffs" };
  }
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, path);
  const rel = relative(rootPath, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, status: 400, error: "path traversal is not allowed" };
  }
  const result = Bun.spawnSync({
    cmd: ["git", "diff", "--", path],
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    return { ok: false, status: 400, error: stderr || `git diff failed for ${path}` };
  }
  return { ok: true, path, diff: stdout };
}

function normalizeTrackedPath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    return null;
  }
  return normalized;
}

async function withDashboardAction(input: () => DashboardActionResult | Promise<DashboardActionResult>) {
  try {
    return Response.json(await input());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function readJsonBody(request: Request) {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalBodyString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function bodyAttachments(body: Record<string, unknown>) {
  const attachments = body.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment): DashboardIntakeAttachment[] => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
    const candidate = attachment as Record<string, unknown>;
    return [{
      name: typeof candidate.name === "string" ? candidate.name : "attachment",
      type: typeof candidate.type === "string" ? candidate.type : "text/plain",
      size: typeof candidate.size === "number" && Number.isFinite(candidate.size) ? candidate.size : 0,
      content: typeof candidate.content === "string" ? candidate.content : "",
    }];
  });
}

function dashboardIntakeDocument(body: Record<string, unknown>) {
  const explicitDocument = optionalBodyString(body, "document");
  if (explicitDocument) return explicitDocument;
  const prompt = requiredBodyString(body, "prompt");
  const sections = [`Prompt:\n${prompt}`];
  for (const attachment of bodyAttachments(body)) {
    sections.push([
      `Attachment: ${attachment.name || "attachment"}`,
      `type: ${attachment.type || "text/plain"}`,
      `size: ${Number(attachment.size || 0)}`,
      "",
      attachment.content || "",
    ].join("\n"));
  }
  return sections.join("\n\n---\n\n");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

let canvasScriptCache: Promise<string> | null = null;
let canvasCssCache: Promise<string> | null = null;

function bundledDashboardCanvasScript() {
  canvasScriptCache ??= buildDashboardCanvasScript();
  return canvasScriptCache;
}

async function buildDashboardCanvasScript() {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./dashboard-canvas.tsx", import.meta.url))],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n") || "dashboard canvas bundle failed");
  }
  const artifact = result.outputs.find((output) => output.path.endsWith(".js")) ?? result.outputs[0];
  return artifact.text();
}

function bundledDashboardCanvasCss() {
  canvasCssCache ??= buildDashboardCanvasCss();
  return canvasCssCache;
}

async function buildDashboardCanvasCss() {
  const xyflowCssUrl = import.meta.resolve("@xyflow/react/dist/style.css");
  const xyflowCss = await Bun.file(fileURLToPath(xyflowCssUrl)).text();
  return `${xyflowCss}

.react-flow {
  font-family: "Aptos", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}
`;
}
