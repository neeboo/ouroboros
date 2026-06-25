import type { RunOverview, Status } from "@ouroboros/harness";
import { buildDashboardTaskGraph, type DashboardTaskGraph } from "./dashboard";

export interface DashboardWorkspaceSelection {
  selectedGroupId?: string | null;
  selectedRunId?: string | null;
  runHistory?: DashboardWorkspaceRunHistoryInput[];
}

export interface DashboardWorkspaceRunHistoryInput {
  id: string;
  status: string;
  goal: string;
  projectId?: string | null;
  createdAt?: string | null;
}

export interface DashboardWorkspaceModel {
  project: DashboardWorkspaceProjectSummary;
  run: DashboardWorkspaceRunSummary;
  leftRail: DashboardWorkspaceLeftRail;
  canvas: DashboardWorkspaceCanvas;
  timeline: DashboardWorkspaceTimeline;
  inspector: DashboardWorkspaceInspectorContext;
}

export interface DashboardWorkspaceProjectSummary {
  id: string | null;
  name: string;
  rootPath: string | null;
}

export interface DashboardWorkspaceRunSummary {
  id: string | null;
  status: Status | "unknown";
  goal: string;
  projectId: string | null;
  createdAt: string | null;
  selected: boolean;
}

export interface DashboardWorkspaceLeftRail {
  runs: DashboardWorkspaceRunSummary[];
  groups: DashboardWorkspaceGroupSummary[];
}

export interface DashboardWorkspaceGroupSummary {
  id: string;
  label: string;
  status: Status | "mixed";
  roleSummary: string;
  taskCount: number;
  selected: boolean;
}

export interface DashboardWorkspaceCanvas {
  nodes: DashboardWorkspaceCanvasNode[];
  edges: DashboardWorkspaceCanvasEdge[];
  legacyTaskGraph: DashboardTaskGraph;
}

export interface DashboardWorkspaceCanvasNode {
  id: string;
  kind: "task";
  label: string;
  role: string;
  status: Status;
  position: { x: number; y: number };
  metadata: DashboardWorkspaceNodeMetadata;
}

export interface DashboardWorkspaceNodeMetadata {
  taskId: string;
  sessionCount: number;
  evidenceCount: number;
  todoCount: number;
  changedFileCount: number;
  diffCount: number;
  sessions: DashboardWorkspaceSessionSummary[];
  prompts: DashboardWorkspacePromptSummary[];
  evidence: DashboardWorkspaceEvidenceSummary[];
  todos: DashboardWorkspaceTodoSummary[];
  changedFiles: DashboardWorkspaceChangedFileSummary[];
  diffs: DashboardWorkspaceDiffSummary[];
}

export interface DashboardWorkspaceCanvasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface DashboardWorkspaceSessionSummary {
  id: string;
  taskId: string;
  role: string;
  status: string;
  name: string | null;
  codexSessionId: string | null;
  latestText: string;
}

export interface DashboardWorkspacePromptSummary {
  taskId: string;
  text: string;
}

export interface DashboardWorkspaceEvidenceSummary {
  id: string;
  taskId: string;
  attemptId: string | null;
  label: "summary" | "check" | "artifact" | "problem" | "lesson";
  text: string;
}

export interface DashboardWorkspaceTodoSummary {
  id: string;
  taskId: string;
  text: string;
  status: "todo" | "done";
}

export interface DashboardWorkspaceChangedFileSummary {
  path: string;
  taskId: string;
  attemptId: string;
}

export interface DashboardWorkspaceDiffSummary {
  id: string;
  taskId: string;
  attemptId: string;
  path: string;
  summary: string;
}

export interface DashboardWorkspaceTimeline {
  newestAtBottom: true;
  turns: DashboardWorkspaceTimelineTurn[];
}

export interface DashboardWorkspaceTimelineTurn {
  id: string;
  kind: "event" | "session";
  taskId: string;
  sessionId: string;
  role: string;
  label: string;
  text: string;
  createdAt: string | null;
  sequence: number;
}

export type DashboardWorkspaceInspectorContext =
  | {
    kind: "task";
    taskId: string;
    title: string;
    role: string;
    status: Status;
    sessions: DashboardWorkspaceSessionSummary[];
    evidence: DashboardWorkspaceEvidenceSummary[];
    todos: DashboardWorkspaceTodoSummary[];
    changedFiles: DashboardWorkspaceChangedFileSummary[];
    diffs: DashboardWorkspaceDiffSummary[];
  }
  | {
    kind: "run";
    runId: string | null;
    title: string;
    status: Status | "unknown";
    taskCount: number;
  };

export function buildDashboardWorkspaceModel(
  overview: RunOverview,
  selection: DashboardWorkspaceSelection = {},
): DashboardWorkspaceModel {
  const legacyTaskGraph = buildDashboardTaskGraph(overview, selection.selectedGroupId);
  const graphTaskIds = new Set(legacyTaskGraph.nodes.map((node) => node.id));
  const sessionsByTask = groupSessionsByTask(overview.sessions);
  const evidenceByTask = collectEvidenceByTask(overview);
  const todosByTask = collectTodosByTask(overview);
  const changedFilesByTask = collectChangedFilesByTask(overview);
  const diffsByTask = collectDiffsByTask(overview);
  const promptsByTask = collectPromptsByTask(overview);
  const taskById = new Map(overview.tasks.map((task) => [task.id, task]));

  const canvasNodes = legacyTaskGraph.nodes.map((node) => {
    const task = taskById.get(node.id);
    const sessions = sessionsByTask.get(node.id) ?? [];
    const evidence = evidenceByTask.get(node.id) ?? [];
    const todos = todosByTask.get(node.id) ?? [];
    const changedFiles = changedFilesByTask.get(node.id) ?? [];
    const diffs = diffsByTask.get(node.id) ?? [];
    return {
      id: node.id,
      kind: "task" as const,
      label: compactText(task?.goal || node.data.goal || node.id, 140),
      role: task?.role || node.data.role,
      status: task?.status ?? statusFromValue(node.data.status),
      position: node.position,
      metadata: {
        taskId: node.id,
        sessionCount: sessions.length,
        evidenceCount: evidence.length,
        todoCount: todos.length,
        changedFileCount: changedFiles.length,
        diffCount: diffs.length,
        sessions,
        prompts: promptsByTask.get(node.id) ?? [],
        evidence,
        todos,
        changedFiles,
        diffs,
      },
    };
  });

  const selectedTask =
    (selection.selectedGroupId ? taskById.get(selection.selectedGroupId) : null) ??
    canvasNodes.map((node) => taskById.get(node.id)).find((task): task is NonNullable<typeof task> => Boolean(task)) ??
    overview.tasks[0] ??
    null;

  return {
    project: projectSummary(overview),
    run: runSummary(overview, selection.selectedRunId),
    leftRail: {
      runs: leftRailRuns(overview, selection),
      groups: groupSummaries(overview, selection.selectedGroupId),
    },
    canvas: {
      nodes: canvasNodes,
      edges: legacyTaskGraph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
      })),
      legacyTaskGraph,
    },
    timeline: {
      newestAtBottom: true,
      turns: timelineTurns(overview, graphTaskIds),
    },
    inspector: selectedTask
      ? {
        kind: "task",
        taskId: selectedTask.id,
        title: compactText(selectedTask.goal, 180),
        role: selectedTask.role,
        status: selectedTask.status,
        sessions: sessionsByTask.get(selectedTask.id) ?? [],
        evidence: evidenceByTask.get(selectedTask.id) ?? [],
        todos: todosByTask.get(selectedTask.id) ?? [],
        changedFiles: changedFilesByTask.get(selectedTask.id) ?? [],
        diffs: diffsByTask.get(selectedTask.id) ?? [],
      }
      : {
        kind: "run",
        runId: overview.run?.id ?? null,
        title: overview.run?.goal || "No run selected",
        status: overview.run?.status ?? "unknown",
        taskCount: overview.tasks.length,
      },
  };
}

function projectSummary(overview: RunOverview): DashboardWorkspaceProjectSummary {
  if (overview.project) {
    return {
      id: overview.project.id,
      name: overview.project.name,
      rootPath: overview.project.rootPath,
    };
  }
  return {
    id: overview.run?.projectId ?? null,
    name: overview.run?.projectId ?? "Project Workspace",
    rootPath: overview.run?.projectRoot ?? null,
  };
}

function runSummary(overview: RunOverview, selectedRunId?: string | null): DashboardWorkspaceRunSummary {
  return {
    id: overview.run?.id ?? null,
    status: overview.run?.status ?? "unknown",
    goal: overview.run?.goal ?? "",
    projectId: overview.run?.projectId ?? null,
    createdAt: overview.run?.createdAt ?? null,
    selected: Boolean(overview.run?.id && selectedRunId === overview.run.id),
  };
}

function leftRailRuns(
  overview: RunOverview,
  selection: DashboardWorkspaceSelection,
): DashboardWorkspaceRunSummary[] {
  const current = runSummary(overview, selection.selectedRunId);
  const history = (selection.runHistory ?? [])
    .filter((run) => run.id !== current.id)
    .map((run) => ({
      id: run.id,
      status: run.status as Status | "unknown",
      goal: run.goal,
      projectId: run.projectId ?? null,
      createdAt: run.createdAt ?? null,
      selected: selection.selectedRunId === run.id,
    }));
  return current.id ? [current, ...history] : history;
}

function groupSummaries(overview: RunOverview, selectedGroupId?: string | null): DashboardWorkspaceGroupSummary[] {
  return overview.tasks.map((task) => ({
    id: task.id,
    label: compactText(task.goal, 90),
    status: task.status,
    roleSummary: task.role,
    taskCount: 1,
    selected: selectedGroupId === task.id || selectedGroupId === task.cycleId,
  }));
}

function groupSessionsByTask(sessions: RunOverview["sessions"]) {
  const grouped = new Map<string, DashboardWorkspaceSessionSummary[]>();
  for (const session of sessions) {
    pushGrouped(grouped, session.taskId, {
      id: session.attemptId,
      taskId: session.taskId,
      role: session.role,
      status: session.status,
      name: session.sessionName,
      codexSessionId: session.codexSessionId,
      latestText: session.latestText,
    });
  }
  return grouped;
}

function collectPromptsByTask(overview: RunOverview) {
  const grouped = new Map<string, DashboardWorkspacePromptSummary[]>();
  for (const task of overview.tasks) {
    if (!task.prompt) continue;
    pushGrouped(grouped, task.id, { taskId: task.id, text: task.prompt });
  }
  return grouped;
}

function collectTodosByTask(overview: RunOverview) {
  const grouped = new Map<string, DashboardWorkspaceTodoSummary[]>();
  for (const task of overview.tasks) {
    for (const [index, text] of task.doneWhen.entries()) {
      pushGrouped(grouped, task.id, {
        id: `${task.id}:todo:${index}`,
        taskId: task.id,
        text,
        status: task.status === "done" ? "done" : "todo",
      });
    }
  }
  return grouped;
}

function collectEvidenceByTask(overview: RunOverview) {
  const grouped = new Map<string, DashboardWorkspaceEvidenceSummary[]>();
  for (const session of overview.sessions) {
    if (session.output.summary) {
      pushGrouped(grouped, session.taskId, {
        id: `${session.attemptId}:summary`,
        taskId: session.taskId,
        attemptId: session.attemptId,
        label: "summary",
        text: readableValue(session.output.summary),
      });
    }
    for (const [index, check] of (session.output.checks ?? []).entries()) {
      pushGrouped(grouped, session.taskId, {
        id: `${session.attemptId}:check:${index}`,
        taskId: session.taskId,
        attemptId: session.attemptId,
        label: "check",
        text: readableValue(check),
      });
    }
    for (const [index, artifact] of (session.output.artifacts ?? []).entries()) {
      pushGrouped(grouped, session.taskId, {
        id: `${session.attemptId}:artifact:${index}`,
        taskId: session.taskId,
        attemptId: session.attemptId,
        label: "artifact",
        text: readableValue(artifact),
      });
    }
    for (const [index, problem] of (session.output.problems ?? []).entries()) {
      pushGrouped(grouped, session.taskId, {
        id: `${session.attemptId}:problem:${index}`,
        taskId: session.taskId,
        attemptId: session.attemptId,
        label: "problem",
        text: readableValue(problem),
      });
    }
  }
  for (const lesson of overview.lessons) {
    pushGrouped(grouped, lesson.taskId, {
      id: `${lesson.attemptId}:lesson:${lesson.id}`,
      taskId: lesson.taskId,
      attemptId: lesson.attemptId,
      label: "lesson",
      text: lesson.summary,
    });
  }
  return grouped;
}

function collectChangedFilesByTask(overview: RunOverview) {
  const grouped = new Map<string, DashboardWorkspaceChangedFileSummary[]>();
  for (const session of overview.sessions) {
    for (const path of session.output.changedFiles ?? []) {
      pushGrouped(grouped, session.taskId, {
        path,
        taskId: session.taskId,
        attemptId: session.attemptId,
      });
    }
  }
  return grouped;
}

function collectDiffsByTask(overview: RunOverview) {
  const grouped = new Map<string, DashboardWorkspaceDiffSummary[]>();
  for (const session of overview.sessions) {
    const paths = new Set<string>();
    for (const path of session.output.changedFiles ?? []) {
      paths.add(path);
    }
    for (const artifact of session.output.artifacts ?? []) {
      const record = objectRecord(artifact);
      const kind = typeof record?.kind === "string" ? record.kind : "";
      const path = typeof record?.path === "string" ? record.path : "";
      if (path && kind.toLowerCase().includes("diff")) {
        paths.add(path);
      }
    }
    for (const path of paths) {
      pushGrouped(grouped, session.taskId, {
        id: `${session.attemptId}:diff:${path}`,
        taskId: session.taskId,
        attemptId: session.attemptId,
        path,
        summary: path,
      });
    }
  }
  return grouped;
}

function timelineTurns(overview: RunOverview, graphTaskIds: Set<string>): DashboardWorkspaceTimelineTurn[] {
  const turns: DashboardWorkspaceTimelineTurn[] = [];
  for (const session of overview.sessions) {
    if (graphTaskIds.size > 0 && !graphTaskIds.has(session.taskId)) continue;
    for (const event of session.events ?? []) {
      const text = event.text?.trim() || eventTextFromPayload(event.payload);
      if (!text) continue;
      turns.push({
        id: event.id,
        kind: "event",
        taskId: session.taskId,
        sessionId: session.attemptId,
        role: session.role,
        label: session.sessionName || session.codexSessionId || session.attemptId,
        text,
        createdAt: event.createdAt ?? null,
        sequence: event.sequence,
      });
    }
    if (turns.every((turn) => turn.sessionId !== session.attemptId) && session.latestText.trim()) {
      turns.push({
        id: `${session.attemptId}:latest`,
        kind: "session",
        taskId: session.taskId,
        sessionId: session.attemptId,
        role: session.role,
        label: session.sessionName || session.codexSessionId || session.attemptId,
        text: session.latestText.trim(),
        createdAt: session.finishedAt ?? session.startedAt ?? null,
        sequence: Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return turns.sort((a, b) => {
    const createdAtOrder = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    if (createdAtOrder !== 0) return createdAtOrder;
    const sequenceOrder = timelineSequence(a) - timelineSequence(b);
    if (sequenceOrder !== 0) return sequenceOrder;
    const sessionOrder = a.sessionId.localeCompare(b.sessionId);
    if (sessionOrder !== 0) return sessionOrder;
    return a.id.localeCompare(b.id);
  });
}

function timelineSequence(turn: DashboardWorkspaceTimelineTurn) {
  return Number.isFinite(turn.sequence) ? turn.sequence : Number.MAX_SAFE_INTEGER;
}

function eventTextFromPayload(payload: unknown) {
  const record = objectRecord(payload);
  if (!record) return "";
  for (const key of ["delta", "message", "text", "content", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pushGrouped<T>(grouped: Map<string, T[]>, key: string, value: T) {
  const list = grouped.get(key) ?? [];
  list.push(value);
  grouped.set(key, list);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactText(value: string, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function statusFromValue(value: unknown): Status {
  return value === "running" || value === "done" || value === "blocked" ? value : "todo";
}
