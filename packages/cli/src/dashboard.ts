import { diagnoseRunOverview, isOuroborosRuntimePath, readableValue } from "@ouroboros/harness";
import type {
  DesignDecision,
  DesignOutcome,
  DesignProposal,
  FounderCharter,
  OverseerDiagnosis,
  RunOverview,
  RunStatusCounts,
  StrategySignal,
} from "@ouroboros/harness";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_REACT_MODULES } from "./dashboard-app";
import {
  buildChatTranscript,
  codexEventToMessagePart,
  eventToMessagePart,
  shouldRouteInterrupt,
  type ChatGroupLike,
  type ChatMessage,
  type ChatMessagePart,
  type ChatSessionLike,
} from "./dashboard-messages";
import {
  designTimelineKindForTask as designTimelineKindForTaskHelper,
} from "./design-status";

export {
  buildChatTranscript as buildChatTranscriptForTest,
  codexEventToMessagePart as codexEventToMessagePartForTest,
  eventToMessagePart as eventToMessagePartForTest,
  shouldRouteInterrupt as shouldRouteInterruptForTest,
};
export type { ChatMessage, ChatMessagePart, ChatGroupLike, ChatSessionLike };
import { renderDashboardRunHistoryRows as renderDashboardRunHistoryRowsReact } from "./dashboard-sidebar";
import { renderDashboardShell } from "./dashboard-shell";
import type { DashboardRunHistoryEntry } from "./dashboard-types";
import type {
  DashboardLinearIntakeLifecycle,
  DashboardLinearIntakePollingSummary,
  DashboardLinearIntakeEventSummary,
  DashboardLinearIntakeRunnerSummary,
} from "./dashboard-workspace-model";

export type {
  DashboardLinearIntakeLifecycle,
  DashboardLinearIntakePollingSummary,
  DashboardLinearIntakeEventSummary,
  DashboardLinearIntakeRunnerSummary,
} from "./dashboard-workspace-model";
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

export interface DashboardDesignStatusSummary {
  projectId: string | null;
  charter: (FounderCharter & { summary: { mission: string; version: number; reviewCadenceDays?: number } }) | null;
  currentProposal: (DesignProposal & {
    summary: {
      title: string;
      status: string;
      recommendation: string;
      reversibility?: string;
      portfolio?: string;
      nextReviewAt?: string;
    };
  }) | null;
  latestDecision: Pick<
    DesignDecision,
    "id" | "decision" | "actorKind" | "actorRef" | "reasons" | "createdAt"
  > | null;
  budget: {
    currency?: string;
    monthlyBudget?: number;
    experimentBudget?: number;
    recurringSpendApprovalAbove?: number;
    runwayFloorMonths?: number;
    portfolio?: { core?: number; growth?: number; exploration?: number };
  } | null;
  authority: {
    autoResearch?: boolean;
    autoReversibleExperiments?: boolean;
    autoIntegrateVerifiedCode?: boolean;
    requireHumanFor?: string[];
  } | null;
  nextOutcomeReview: Pick<
    DesignOutcome,
    "id" | "proposalId" | "stage" | "recommendation" | "reviewAt" | "createdAt"
  > | null;
  recentOutcomes: Array<
    Pick<DesignOutcome, "id" | "proposalId" | "stage" | "recommendation" | "reviewAt" | "createdAt">
  >;
  recentSignals: Array<
    Pick<
      StrategySignal,
      "id" | "signalClass" | "source" | "title" | "status" | "confidence" | "expiresAt" | "observationTime"
    >
  >;
  proposalCountsByStatus: Record<string, number>;
  activeSignalCount: number;
  timeline: DashboardDesignTimelineEntry[];
}

export interface DashboardDesignTimelineEntry {
  kind: "designer" | "outcome-review" | "research" | "planner" | "decision" | "worker" | "verifier";
  taskId?: string | null;
  attemptId?: string | null;
  runId?: string | null;
  proposalId?: string | null;
  label: string;
  detail?: string;
  status?: string;
  createdAt: string | null;
}

export type DashboardDesignTimelineHarness = {
  getRunOverview(input: { runId: string; eventLimit?: number }): {
    tasks: Array<{ id: string; runId: string; role: string; goal: string; status: string }>;
    sessions: Array<{
      taskId: string;
      attemptId: string | null;
      finishedAt: string | null;
      startedAt: string | null;
    }>;
  };
  listExecutionThreads(input: { runId: string }): Array<{
    ownerType: string;
    taskId: string | null;
    attemptId: string | null;
    sessionName: string | null;
    role: string | null;
    status: string;
    heartbeatAt: string;
    createdAt: string;
  }>;
  listDesignDecisions(input: { proposalId: string; limit: number }): Array<{
    decision: string;
    actorKind: string;
    reasons: string[];
    createdAt: string;
  }>;
  listDesignOutcomes(input: { proposalId: string; limit: number }): Array<{
    stage: string;
    recommendation: string;
    unexpectedEffects: unknown[];
    createdAt: string;
  }>;
};

export function buildDashboardDesignTimeline(
  runId: string,
  proposalId: string | null,
  harness: DashboardDesignTimelineHarness,
): DashboardDesignTimelineEntry[] {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const sessionsByTaskId = new Map(overview.sessions.map((session) => [session.taskId, session]));
  const stamped: Array<{ entry: DashboardDesignTimelineEntry; order: number; when: number }> = [];
  let order = 0;
  for (const task of overview.tasks) {
    const kind = designTimelineKindForTaskHelper(task);
    if (!kind) continue;
    const session = sessionsByTaskId.get(task.id);
    const createdAt = session?.finishedAt ?? session?.startedAt ?? null;
    stamped.push({
      entry: {
        kind,
        taskId: task.id,
        attemptId: session?.attemptId ?? null,
        runId: task.runId,
        proposalId,
        label: task.goal,
        status: task.status,
        createdAt,
      },
      order: order++,
      when: createdAt ? Date.parse(createdAt) : 0,
    });
  }
  const threads = harness.listExecutionThreads({ runId });
  for (const thread of threads) {
    if (thread.ownerType !== "subsession") continue;
    const createdAt = thread.heartbeatAt ?? thread.createdAt ?? null;
    stamped.push({
      entry: {
        kind: "research",
        taskId: thread.taskId ?? null,
        attemptId: thread.attemptId ?? null,
        runId,
        proposalId,
        label: thread.sessionName ?? "research subsession",
        detail: thread.role ?? undefined,
        status: thread.status,
        createdAt,
      },
      order: order++,
      when: createdAt ? Date.parse(createdAt) : 0,
    });
  }
  if (proposalId) {
    const decisions = harness.listDesignDecisions({ proposalId, limit: 50 });
    for (const decision of decisions) {
      stamped.push({
        entry: {
          kind: "decision",
          proposalId,
          label: `${decision.decision} by ${decision.actorKind}`,
          detail: decision.reasons.join("; ") || undefined,
          status: decision.decision,
          createdAt: decision.createdAt,
        },
        order: order++,
        when: decision.createdAt ? Date.parse(decision.createdAt) : 0,
      });
    }
    const outcomes = harness.listDesignOutcomes({ proposalId, limit: 50 });
    for (const outcome of outcomes) {
      const unexpected = Array.isArray(outcome.unexpectedEffects) ? outcome.unexpectedEffects : [];
      stamped.push({
        entry: {
          kind: "outcome-review",
          proposalId,
          label: `${outcome.stage} review: ${outcome.recommendation}`,
          detail: unexpected.length > 0 ? "unexpected effects recorded" : undefined,
          status: outcome.recommendation,
          createdAt: outcome.createdAt,
        },
        order: order++,
        when: outcome.createdAt ? Date.parse(outcome.createdAt) : 0,
      });
    }
  }
  stamped.sort((left, right) => {
    if (left.when !== right.when) {
      return left.when - right.when;
    }
    return left.order - right.order;
  });
  return stamped.slice(0, 50).map((item) => item.entry);
}

type DashboardDesignStatusProvider = (routeRunId: string) => DashboardDesignStatusSummary | null;

type DashboardLinearIntakeProvider = (routeRunId: string) => DashboardLinearIntakeLifecycle | Promise<DashboardLinearIntakeLifecycle | null> | null;

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

export function dashboardRunHistoryRowsHtmlForTest(runs: DashboardRunHistoryEntry[], activeRunId: string): string {
  return renderDashboardRunHistoryRows(runs, activeRunId);
}

function renderDashboardRunHistoryRows(runs: DashboardRunHistoryEntry[], activeRunId: string): string {
  return renderDashboardRunHistoryRowsReact(runs, activeRunId);
}

const DASHBOARD_RUNS_HISTORY_LIMIT_MAX = 100;
const DASHBOARD_RUNS_HISTORY_LIMIT_DEFAULT = 10;
const DASHBOARD_RUN_SUMMARY_GOAL_MAX = 140;
const DASHBOARD_CSS_PATH = fileURLToPath(new URL("./dashboard.css", import.meta.url));

type DashboardRouteMethod = "GET" | "POST";

export interface DashboardRouteDefinition {
  name: string;
  method: DashboardRouteMethod;
  path: string;
  kind: "document" | "asset" | "api" | "prompt";
}

export const DASHBOARD_ROUTE_NEXT_MILESTONE =
  "TanStack Router is deferred until the dashboard has a Vite dashboard app boundary that can host a generated routeTree; add that boundary first, then introduce @tanstack/react-router and @tanstack/router-plugin/vite.";

export const DASHBOARD_ROUTE_PATHS = {
  document: "/",
  canvasScriptAsset: "/assets/dashboard-canvas.js",
  canvasCssAsset: "/assets/dashboard-canvas.css",
  dashboardCssAsset: "/assets/dashboard.css",
  tailwindCssAsset: "/assets/tailwindcss",
  recentRunsApi: "/api/runs",
  runOverviewApi: "/api/runs/:runId/overview",
  changedFilesApi: "/api/runs/:runId/changed-files",
  diffApi: "/api/runs/:runId/diff",
  guardrailAcceptApi: "/api/runs/:runId/guardrails/:proposalId/accept",
  runnerStartApi: "/api/runs/:runId/runner/start",
  runnerStopApi: "/api/runs/:runId/runner/stop",
  supervisorStartApi: "/api/supervisor/start",
  supervisorStopApi: "/api/supervisor/stop",
  intakeApi: "/api/runs/:runId/intake",
  goalCreateApi: "/api/runs/:runId/goals",
  goalInterruptApi: "/api/runs/:runId/interrupt",
  taskResumeApi: "/api/tasks/:taskId/resume",
  taskRerunApi: "/api/tasks/:taskId/rerun",
  attemptStopApi: "/api/attempts/:attemptId/stop",
  designStatusApi: "/api/runs/:runId/design/status",
  linearIntakeApi: "/api/runs/:runId/linear-intake",
  taskPrompt: "/tasks/:taskId/prompt",
} as const;

export const DASHBOARD_ROUTES: DashboardRouteDefinition[] = [
  { name: "dashboard.document", method: "GET", path: DASHBOARD_ROUTE_PATHS.document, kind: "document" },
  { name: "dashboard.asset.canvasScript", method: "GET", path: DASHBOARD_ROUTE_PATHS.canvasScriptAsset, kind: "asset" },
  { name: "dashboard.asset.canvasCss", method: "GET", path: DASHBOARD_ROUTE_PATHS.canvasCssAsset, kind: "asset" },
  { name: "dashboard.asset.dashboardCss", method: "GET", path: DASHBOARD_ROUTE_PATHS.dashboardCssAsset, kind: "asset" },
  { name: "dashboard.asset.tailwindCss", method: "GET", path: DASHBOARD_ROUTE_PATHS.tailwindCssAsset, kind: "asset" },
  { name: "dashboard.api.recentRuns", method: "GET", path: DASHBOARD_ROUTE_PATHS.recentRunsApi, kind: "api" },
  { name: "dashboard.api.runOverview", method: "GET", path: DASHBOARD_ROUTE_PATHS.runOverviewApi, kind: "api" },
  { name: "dashboard.api.changedFiles", method: "GET", path: DASHBOARD_ROUTE_PATHS.changedFilesApi, kind: "api" },
  { name: "dashboard.api.diff", method: "GET", path: DASHBOARD_ROUTE_PATHS.diffApi, kind: "api" },
  { name: "dashboard.api.guardrailAccept", method: "POST", path: DASHBOARD_ROUTE_PATHS.guardrailAcceptApi, kind: "api" },
  { name: "dashboard.api.runnerStart", method: "POST", path: DASHBOARD_ROUTE_PATHS.runnerStartApi, kind: "api" },
  { name: "dashboard.api.runnerStop", method: "POST", path: DASHBOARD_ROUTE_PATHS.runnerStopApi, kind: "api" },
  { name: "dashboard.api.supervisorStart", method: "POST", path: DASHBOARD_ROUTE_PATHS.supervisorStartApi, kind: "api" },
  { name: "dashboard.api.supervisorStop", method: "POST", path: DASHBOARD_ROUTE_PATHS.supervisorStopApi, kind: "api" },
  { name: "dashboard.api.intake", method: "POST", path: DASHBOARD_ROUTE_PATHS.intakeApi, kind: "api" },
  { name: "dashboard.api.goalCreate", method: "POST", path: DASHBOARD_ROUTE_PATHS.goalCreateApi, kind: "api" },
  { name: "dashboard.api.goalInterrupt", method: "POST", path: DASHBOARD_ROUTE_PATHS.goalInterruptApi, kind: "api" },
  { name: "dashboard.api.taskResume", method: "POST", path: DASHBOARD_ROUTE_PATHS.taskResumeApi, kind: "api" },
  { name: "dashboard.api.taskRerun", method: "POST", path: DASHBOARD_ROUTE_PATHS.taskRerunApi, kind: "api" },
  { name: "dashboard.api.attemptStop", method: "POST", path: DASHBOARD_ROUTE_PATHS.attemptStopApi, kind: "api" },
  { name: "dashboard.api.designStatus", method: "GET", path: DASHBOARD_ROUTE_PATHS.designStatusApi, kind: "api" },
  { name: "dashboard.api.linearIntake", method: "GET", path: DASHBOARD_ROUTE_PATHS.linearIntakeApi, kind: "api" },
  { name: "dashboard.taskPrompt", method: "GET", path: DASHBOARD_ROUTE_PATHS.taskPrompt, kind: "prompt" },
];

export function dashboardRoutePaths() {
  return DASHBOARD_ROUTES.map((route) => route.path);
}

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
    sessionCount: number;
    evidenceCount: number;
    todoCount: number;
    changedFileCount: number;
    diffCount: number;
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
  const sessionCountByTask = new Map<string, number>();
  const evidenceCountByTask = new Map<string, number>();
  const changedFileCountByTask = new Map<string, number>();
  const diffPathsByTask = new Map<string, Set<string>>();
  for (const task of selectedTasks) {
    evidenceCountByTask.set(task.id, 0);
    sessionCountByTask.set(task.id, 0);
    changedFileCountByTask.set(task.id, 0);
    diffPathsByTask.set(task.id, new Set<string>());
  }
  for (const session of overview.sessions) {
    if (!taskIds.has(session.taskId)) continue;
    sessionCountByTask.set(session.taskId, (sessionCountByTask.get(session.taskId) ?? 0) + 1);
    let evidenceCount = evidenceCountByTask.get(session.taskId) ?? 0;
    if (session.output?.summary) evidenceCount += 1;
    evidenceCount += Array.isArray(session.output?.checks) ? session.output.checks.length : 0;
    evidenceCount += Array.isArray(session.output?.artifacts) ? session.output.artifacts.length : 0;
    evidenceCount += Array.isArray(session.output?.problems) ? session.output.problems.length : 0;
    evidenceCountByTask.set(session.taskId, evidenceCount);

    const seenChangedFiles = new Set<string>();
    for (const path of session.output?.changedFiles ?? []) {
      if (!path || seenChangedFiles.has(path)) continue;
      seenChangedFiles.add(path);
    }
    changedFileCountByTask.set(session.taskId, (changedFileCountByTask.get(session.taskId) ?? 0) + seenChangedFiles.size);

    const diffPaths = diffPathsByTask.get(session.taskId) ?? new Set<string>();
    for (const path of session.output?.changedFiles ?? []) {
      if (path) diffPaths.add(path);
    }
    for (const artifact of session.output?.artifacts ?? []) {
      const record = artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>) : null;
      const kind = typeof record?.kind === "string" ? record.kind.toLowerCase() : "";
      const path = typeof record?.path === "string" ? record.path : "";
      if (path && kind.includes("diff")) {
        diffPaths.add(path);
      }
    }
    diffPathsByTask.set(session.taskId, diffPaths);
  }
  for (const lesson of overview.lessons) {
    if (!taskIds.has(lesson.taskId)) continue;
    evidenceCountByTask.set(lesson.taskId, (evidenceCountByTask.get(lesson.taskId) ?? 0) + 1);
  }
  const columns = new Map<string, number>();
  const nodes = selectedTasks.map((task, index) => {
    const column = roleColumn(task.role);
    const row = columns.get(column) ?? 0;
    columns.set(column, row + 1);
    const sessionCount = sessionCountByTask.get(task.id) ?? 0;
    const evidenceCount = evidenceCountByTask.get(task.id) ?? 0;
    const todoCount = Array.isArray(task.doneWhen) ? task.doneWhen.length : 0;
    const changedFileCount = changedFileCountByTask.get(task.id) ?? 0;
    const diffCount = diffPathsByTask.get(task.id)?.size ?? 0;
    return {
      id: task.id,
      type: "task" as const,
      position: { x: columnX(column), y: row * 190 + (index % 2) * 12 },
      data: {
        role: task.role,
        status: task.status,
        goal: compactText(task.goal, 118),
        taskId: task.id,
        doneWhenCount: todoCount,
        sessionCount,
        evidenceCount,
        todoCount,
        changedFileCount,
        diffCount,
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
  <link rel="stylesheet" href="/assets/dashboard.css">
  <link rel="stylesheet" href="/assets/dashboard-canvas.css">
  <script type="module" src="/assets/dashboard-canvas.js"></script>
</head>
<body>
  ${renderDashboardShell(input)}
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
    const readDashboardState = () => {
      try {
        const parsed = JSON.parse(window.localStorage?.getItem(dashboardStorageKey) || "{}");
        return {
          selectedGoalId: typeof parsed.selectedGoalId === "string" ? parsed.selectedGoalId : null,
          workspaceTitleExpanded: parsed.workspaceTitleExpanded === true,
          selectedChangedFilePath: typeof parsed.selectedChangedFilePath === "string" ? parsed.selectedChangedFilePath : null,
          selectedTaskId: typeof parsed.selectedTaskId === "string" ? parsed.selectedTaskId : null,
          secondaryEvidenceOpen: parsed.secondaryEvidenceOpen === true,
          designDetailsOpen: parsed.designDetailsOpen === true,
          railExpanded: parsed.railExpanded === false ? false : true,
          compactSurface: parsed.compactSurface === "details" ? "details" : "canvas",
          flowScroll: parsed.flowScroll && typeof parsed.flowScroll === "object" ? parsed.flowScroll : null,
        };
      } catch {
        return { selectedGoalId: null, workspaceTitleExpanded: false, selectedChangedFilePath: null, selectedTaskId: null, secondaryEvidenceOpen: false, designDetailsOpen: false, railExpanded: true, compactSurface: "canvas", flowScroll: null };
      }
    };
    const writeDashboardState = (state) => {
      try {
        window.localStorage?.setItem(dashboardStorageKey, JSON.stringify({
          selectedGoalId: typeof state.selectedGoalId === "string" ? state.selectedGoalId : null,
          workspaceTitleExpanded: state.workspaceTitleExpanded === true,
          selectedChangedFilePath: typeof state.selectedChangedFilePath === "string" ? state.selectedChangedFilePath : null,
          selectedTaskId: typeof state.selectedTaskId === "string" ? state.selectedTaskId : null,
          secondaryEvidenceOpen: state.secondaryEvidenceOpen === true,
          designDetailsOpen: state.designDetailsOpen === true,
          railExpanded: state.railExpanded === false ? false : true,
          compactSurface: state.compactSurface === "details" ? "details" : "canvas",
          flowScroll: state.flowScroll && typeof state.flowScroll === "object" ? state.flowScroll : null,
        }));
      } catch {
      }
    };
    const restoredDashboardState = readDashboardState();
    let selectedGoalId = restoredDashboardState.selectedGoalId || null;
    let workspaceTitleExpanded = restoredDashboardState.workspaceTitleExpanded === true;
    let railExpanded = restoredDashboardState.railExpanded !== false;
    let latestOverview = null;
    let selectedChangedFilePath = restoredDashboardState.selectedChangedFilePath || null;
    let selectedTaskId = restoredDashboardState.selectedTaskId || null;
    let secondaryEvidenceOpen = restoredDashboardState.secondaryEvidenceOpen === true;
    let compactSurface = restoredDashboardState.compactSurface === "details" ? "details" : "canvas";
    let designDetailsOpen = restoredDashboardState.designDetailsOpen === true;
    let latestDesignStatus = null;
    let latestLinearIntake = null;
    let restoredFlowScrollState = restoredDashboardState.flowScroll || null;
    const diffByPath = new Map();
    let selectedGroupRef = null;
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
      return '<section class="inspector-card changed-files-section" data-inspector-section="changed-files" data-changed-files-section><h2>Files</h2>' +
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
        guardrailGroup("Active", activeGuardrails, "active") +
        guardrailGroup("Pending", pendingProposals, "proposed") +
        '<div class="meta">Accept control posts to /api/runs/' + escapeHtml(runId) + '/guardrails/&lt;proposalId&gt;/accept and delegates to the harness-owned acceptGuardrailProposal action. CLI commands propose-guardrails and accept-guardrail remain available.</div>' +
        '</section>';
    };
    const subsessionSummaryByThread = (overview) => {
      const map = new Map();
      for (const session of overview.sessions || []) {
        const artifacts = Array.isArray(session.output?.artifacts) ? session.output.artifacts : [];
        for (const artifact of artifacts) {
          const record = artifact && typeof artifact === "object" ? artifact : null;
          if (!record || record.kind !== "subsession_summary") continue;
          const threadId = typeof record.threadId === "string" ? record.threadId : null;
          if (!threadId) continue;
          const collectedAt = session.finishedAt || session.startedAt || null;
          const existing = map.get(threadId);
          if (existing && existing.collectedAt && collectedAt && existing.collectedAt >= collectedAt) continue;
          map.set(threadId, {
            threadId,
            summary: typeof record.summary === "string" ? record.summary : "",
            status: typeof record.status === "string" ? record.status : "done",
            collectedAt,
          });
        }
      }
      return map;
    };
    const formatHeartbeat = (value) => {
      if (!value) return "no heartbeat";
      try {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        const deltaMs = date.getTime() - Date.now();
        const seconds = Math.round(deltaMs / 1000);
        if (Number.isFinite(seconds)) {
          if (Math.abs(seconds) < 60) return seconds >= 0 ? "in " + seconds + "s" : (-seconds) + "s ago";
          const minutes = Math.round(seconds / 60);
          if (Math.abs(minutes) < 60) return minutes >= 0 ? "in " + minutes + "m" : (-minutes) + "m ago";
          const hours = Math.round(minutes / 60);
          return hours >= 0 ? "in " + hours + "h" : (-hours) + "h ago";
        }
      } catch (error) {
        // fall through to raw value
      }
      return String(value);
    };
    const renderSubsessionThreadsSection = (overview, group) => {
      if (!group) return "";
      const threads = Array.isArray(overview.threads) ? overview.threads : [];
      const taskIdSet = new Set(group.tasks.map((task) => task.id));
      const childThreads = threads.filter((thread) =>
        thread && thread.ownerType === "subsession" && taskIdSet.has(thread.taskId),
      );
      if (childThreads.length === 0) return "";
      const summaries = subsessionSummaryByThread(overview);
      const statusOrder = ["running", "done", "blocked", "interrupted", "orphaned"];
      const sorted = [...childThreads].sort((left, right) => {
        const leftStatus = statusOrder.indexOf(left.status);
        const rightStatus = statusOrder.indexOf(right.status);
        if (leftStatus !== rightStatus) {
          return leftStatus === -1 ? 1 : rightStatus === -1 ? -1 : leftStatus - rightStatus;
        }
        return (right.heartbeatAt || "").localeCompare(left.heartbeatAt || "");
      });
      const rows = sorted.map((thread) => {
        const summary = summaries.get(thread.id);
        const sessionLabel = thread.sessionName || thread.agentSessionId || "(unnamed)";
        const heartbeat = formatHeartbeat(thread.heartbeatAt);
        const meta = [
          "role " + (thread.role || "(none)"),
          "status " + thread.status,
          "session " + sessionLabel,
          heartbeat,
        ].join(" · ");
        return '<div class="subsession-row" data-subsession-thread="' + escapeHtml(thread.id) + '" data-subsession-status="' + escapeHtml(thread.status) + '">' +
          '<div class="subsession-head">' +
            '<span class="status-dot ' + escapeHtml(thread.status) + '"></span>' +
            '<span class="subsession-title">' + escapeHtml(sessionLabel) + '</span>' +
            '<span class="subsession-status status-text ' + escapeHtml(thread.status) + '">' + escapeHtml(thread.status) + '</span>' +
          '</div>' +
          '<div class="subsession-meta code-meta">' + escapeHtml(meta) + '</div>' +
          (thread.interruptReason ? '<div class="subsession-summary">interrupt: ' + escapeHtml(compact(thread.interruptReason, 220)) + '</div>' : '') +
          (summary ? '<div class="subsession-summary">' + escapeHtml(compact(summary.summary, 220) || "(empty summary)") + '</div>' : '') +
          '</div>';
      });
      return '<section class="inspector-card" data-inspector-section="subsessions"><h2>Subsessions</h2>' +
        '<div class="subsession-list" data-subsession-list>' + rows.join("") + '</div>' +
        '<div class="meta">Child sessions come from the run overview payload. The refresh poll is never extended to wait on acpx status calls.</div>' +
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
      '<article class="turn ' + (input.primary ? "primary" : "") + (input.kind ? " turn-" + input.kind : "") + '" data-turn-key="' + escapeHtml(input.key || input.mark) + '"' +
      (input.kind ? ' data-turn-kind="' + escapeHtml(input.kind) + '"' : '') +
      (input.role ? ' data-turn-role="' + escapeHtml(input.role) + '"' : '') +
      (input.sessionId ? ' data-turn-session-id="' + escapeHtml(input.sessionId) + '"' : '') +
      (input.createdAt ? ' data-turn-created-at="' + escapeHtml(input.createdAt) + '"' : '') +
      (Number.isFinite(input.sequence) ? ' data-turn-sequence="' + escapeHtml(String(input.sequence)) + '"' : '') +
      '><div class="turn-gutter"><div class="turn-avatar">' + input.mark + '</div><div class="turn-rail"></div></div>' +
      '<div class="turn-body"><div class="turn-head"><div><div class="turn-author">' + input.author + '</div>' +
      (input.summary ? '<div class="turn-summary">' + input.summary + '</div>' : '') + '</div>' +
      (input.action || '') + '</div>' + (input.body || '') + '</div></article>';
    const chatPartClassName = (type, state) =>
      'chat-part chat-part-' + escapeHtml(type) + ' chat-part-state-' + escapeHtml(state);
    const chatPartHtml = (part) => {
      if (!part || typeof part !== "object") return "";
      const type = String(part.type || "raw");
      const state = String(part.state || "active");
      const label = String(part.label || "").trim();
      const text = String(part.text || "").trim();
      if (!text && !label) return "";
      return '<div class="' + chatPartClassName(type, state) + '" data-chat-part-type="' + escapeHtml(type) + '" data-chat-part-state="' + escapeHtml(state) + '">' +
        (label ? '<span class="chat-part-label">' + escapeHtml(label) + '</span>' : '') +
        (text ? '<span class="chat-part-text">' + escapeHtml(text) + '</span>' : '') +
        '</div>';
    };
    // Canonical AI SDK message-part mapper. Mirrors packages/cli/src/dashboard-messages.ts
    // so tests against the imported boundary reflect live renderer behavior.
    const codexEventToMessagePart = (payload) => {
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
            const text = typeof part.text === "string" ? part.text : typeof part.output === "string" ? part.output : "";
            if (text.trim()) parts.push(text.trim());
          }
          if (parts.length === 0) return null;
          return { type: "text", state: "done", label: role, text: parts.join(" ").replace(/\\s+/g, " ") };
        }
        if (itemType === "function_call" || itemType === "tool_call") {
          const name = typeof item.name === "string" && item.name ? item.name : "tool";
          const summary = summarizeToolArguments(item.arguments) || "(invoked)";
          return { type: "tool-input", state: "input-available", label: name, name, text: summary };
        }
        if (itemType === "function_call_output" || itemType === "tool_call_output") {
          const raw = typeof item.output === "string" ? item.output : "";
          const text = raw.replace(/\\s+/g, " ").trim();
          if (!text) return null;
          const isError = /error|failed|exception|traceback/i.test(text);
          return { type: "tool-output", state: isError ? "output-error" : "output-available", label: "tool output", text: clampText(text, 480) };
        }
        if (itemType === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary : [];
          const parts = [];
          for (const part of summary) {
            if (!part || typeof part !== "object") continue;
            const text = typeof part.text === "string" ? part.text : typeof part.summary === "string" ? part.summary : "";
            if (text.trim()) parts.push(text.trim());
          }
          if (parts.length === 0) return null;
          return { type: "reasoning", state: "done", label: "thinking", text: parts.join(" ").replace(/\\s+/g, " ") };
        }
        if (itemType === "approval_request" || itemType === "approval") {
          const summary = typeof item.summary === "string" ? item.summary : typeof item.reason === "string" ? item.reason : typeof item.message === "string" ? item.message : "";
          return { type: "approval", state: "approval-requested", label: "approval", text: summary || "Approval requested" };
        }
      }
      if (type === "response.output_text.delta" || type === "response.output_text.done") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        return { type: "text", state: type.indexOf(".delta") === type.length - 6 ? "active" : "done", label: "assistant", text };
      }
      // AI SDK UI stream chunk: reasoning-start / response.reasoning.start.
      // Emits an active reasoning marker even without delta text.
      if (type === "reasoning-start" || type === "response.reasoning.start" || type === "response.reasoning_text.start") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        return { type: "reasoning", state: "active", label: "thinking", text };
      }
      // AI SDK UI stream chunk: reasoning-delta / response.reasoning.delta
      if (type === "reasoning-delta" || type === "response.reasoning.delta" || type === "response.reasoning_text.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        return { type: "reasoning", state: "active", label: "thinking", text };
      }
      // AI SDK UI stream chunk: reasoning-end / response.reasoning.end.
      // Closes the reasoning span even without delta text.
      if (type === "reasoning-end" || type === "response.reasoning.end" || type === "response.reasoning_text.end") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        return { type: "reasoning", state: "done", label: "thinking", text };
      }
      if (type === "response.function_call_arguments.delta" || type === "response.function_call.delta" || type === "tool-input-start") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const text = delta.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        const name = typeof payload.name === "string" ? payload.name : "tool";
        return { type: "tool-input", state: "input-streaming", label: name, name, text };
      }
      if (type === "tool-input-available" || type === "response.function_call_arguments.done") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const text = (typeof payload.arguments === "string" ? payload.arguments : typeof payload.delta === "string" ? payload.delta : "") || "";
        return { type: "tool-input", state: "input-available", label: name, name, text: summarizeToolArguments(text) || "(invoked)" };
      }
      if (type === "tool-output-available" || type === "tool.call.output") {
        const output = typeof payload.output === "string" ? payload.output : "";
        const text = output.replace(/\\s+/g, " ").trim();
        if (!text) return null;
        const isError = /error|failed|exception|traceback/i.test(text);
        return { type: "tool-output", state: isError ? "output-error" : "output-available", label: "tool output", text: clampText(text, 480) };
      }
      if (type === "tool-output-error" || type === "tool.call.error") {
        const message = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : "";
        return { type: "tool-output", state: "output-error", label: "tool output", text: message || "tool error" };
      }
      if (type === "session.created" || type === "session.updated" || type === "session.completed") {
        const action = type.split(".")[1] || "started";
        return { type: "check", state: "active", label: "session", text: action };
      }
      if (typeof payload.error === "string" && payload.error.trim()) {
        return { type: "error", state: "error", label: "error", text: payload.error.trim() };
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        return { type: "text", state: "done", label: "message", text: payload.message.trim() };
      }
      if (typeof payload.delta === "string" && payload.delta.trim()) {
        return { type: "text", state: "active", label: "delta", text: payload.delta.trim() };
      }
      return null;
    };
    const eventToMessagePart = (event) => {
      const structured = codexEventToMessagePart(event.payload || {});
      if (structured) return structured;
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (!text) return null;
      const stream = typeof event.stream === "string" ? event.stream : "stdout";
      if (stream === "stderr") {
        return { type: "error", state: "error", label: "stderr", text: clampText(text, 480) };
      }
      return { type: "raw", state: "active", label: stream || "log", text: clampText(text, 480) };
    };
    const renderChatPartsForSession = (session) => {
      const events = Array.isArray(session.events) ? session.events : [];
      const parts = events.map(eventToMessagePart).filter(Boolean);
      let html = '';
      if (parts.length === 0) return '';
      const grouped = [];
      let buffer = null;
      for (const part of parts) {
        if (!buffer) {
          buffer = { ...part, text: part.text || "" };
          continue;
        }
        if (buffer.type === part.type && buffer.label === part.label) {
          buffer.text = clampText(String(buffer.text || "") + " " + String(part.text || ""), 600);
          if (part.state === "done") buffer.state = "done";
          continue;
        }
        grouped.push(buffer);
        buffer = { ...part, text: part.text || "" };
      }
      if (buffer) grouped.push(buffer);
      html = grouped.map(chatPartHtml).join("");
      if (!html) return '';
      return '<div class="chat-message-parts" data-chat-message-parts>' + html + '</div>';
    };
    const sessionFlowTurn = (session) =>
      turn({
        kind: "session",
        key: session.attemptId,
        mark: roleMark(session.role),
        author: escapeHtml(session.role),
        summary: escapeHtml(session.taskGoal) + ' · ' + escapeHtml(session.status) + (modelMetaForSession(session) ? ' · ' + escapeHtml(modelMetaForSession(session)) : ''),
        action: '<span class="status-text ' + escapeHtml(session.status) + '">' + escapeHtml(session.status) + '</span>',
        role: session.role,
        sessionId: session.attemptId,
        createdAt: session.finishedAt || session.startedAt || null,
        body:
          '<div class="turn-meta code-meta">task ' + escapeHtml(session.taskId) + ' · attempt ' + escapeHtml(session.attemptId) +
          (session.sessionName ? '<br>session ' + escapeHtml(session.sessionName) : '') +
          (session.codexSessionId ? '<br>codex ' + escapeHtml(session.codexSessionId) : '') +
          (modelMetaForSession(session) ? '<br>' + escapeHtml(modelMetaForSession(session)) : '') + '</div>' +
          '<div class="turn-text">' + escapeHtml(readableSummary(session)) + '</div>' +
          renderChatPartsForSession(session) +
          conversationEvidence(session) +
          rawStreamDetails(session),
      });
    const renderConversationTimeline = (group) => {
      if (!group) return '<div class="empty">No goal selected</div>';
      const orderedSessions = [...group.sessions].sort((left, right) => {
        const leftTime = Date.parse(left.startedAt || "") || 0;
        const rightTime = Date.parse(right.startedAt || "") || 0;
        return leftTime - rightTime;
      });
      const taskIdsWithSessions = new Set(orderedSessions.map((session) => session.taskId));
      const pendingFlow = group.tasks.filter((task) => !taskIdsWithSessions.has(task.id) && (task.status === "todo" || task.status === "running"));
      return '<div class="transcript" id="flow-transcript" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Agent conversation timeline" data-timeline-order="oldest-first">' +
        turn({
          primary: true,
          kind: "goal",
          key: "goal:" + group.id,
          mark: "go",
          author: "Run goal",
          summary: escapeHtml(group.titleTask.goal) + ' · <span class="role-label">' + escapeHtml(roleSummary(group.tasks)) + '</span> · <span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span>',
          action: promptLink(group.titleTask),
          body: '<div class="turn-meta">' + taskMeta(group.root) + '</div><div class="turn-text">' + escapeHtml(group.root.prompt) + '</div>',
        }) +
        (orderedSessions.length ? orderedSessions.map(sessionFlowTurn).join("") : '<div class="empty">No sessions recorded for this goal yet.</div>') +
        (pendingFlow.length ? pendingFlow.map((task) => turn({
          kind: "task",
          key: "task:" + task.id,
          mark: roleMark(task.role),
          author: escapeHtml(task.role),
          summary: escapeHtml(task.goal),
          action: '<span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span>',
          role: task.role,
          body: '<div class="turn-meta">' + taskMeta(task) + '</div>',
        })).join("") : '') +
        (group.lessons.length ? turn({
          kind: "lesson",
          key: "lessons:" + group.id,
          mark: "le",
          author: "Lessons and experiences",
          summary: escapeHtml(group.lessons.length + " records"),
          body: lessonList(group.lessons.slice(-6)),
        }) : '') +
        '</div>';
    };
    const graphColumn = (role) => role === "planner" || role === "goal-review" ? "planner" : role === "verifier" ? "verifier" : "worker";
    const graphColumnX = (column) => column === "planner" ? 0 : column === "verifier" ? 720 : 360;
    const fallbackSelectedTaskIdFor = (graph, group) => {
      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
      const taskIds = graph.nodes.map((node) => node.id);
      if (selectedTaskId && taskIds.includes(selectedTaskId)) return selectedTaskId;
      const orderedStatuses = ["running", "blocked", "todo", "done"];
      const tasksById = new Map((group?.tasks || latestOverview?.tasks || []).map((task) => [task.id, task]));
      for (const status of orderedStatuses) {
        const match = taskIds.find((id) => tasksById.get(id)?.status === status);
        if (match) return match;
      }
      return taskIds[0];
    };
    const resolveFallbackSelectedTaskId = (graph, group) => {
      const fallback = fallbackSelectedTaskIdFor(graph, group);
      return fallback || null;
    };
    const selectCanvasTask = (taskId) => {
      const next = typeof taskId === "string" && taskId ? taskId : null;
      if (next === selectedTaskId) return;
      selectedTaskId = next;
      persistDashboardState();
      const group = selectedGroupRef;
      const graph = group ? canvasGraphFor(latestOverview || { tasks: group.tasks, sessions: group.sessions, lessons: group.lessons }, group) : null;
      const fallback = fallbackSelectedTaskIdFor(graph, group);
      const root = document.getElementById("dashboard-canvas-root");
      if (root) {
        const effective = next && (graph?.nodes.some((node) => node.id === next) ? next : fallback);
        root.setAttribute("data-canvas-selected-task-id", effective || "");
      }
      const fallbackList = document.getElementById("dashboard-canvas-fallback-list");
      if (fallbackList) {
        for (const item of Array.from(fallbackList.querySelectorAll("[data-canvas-task-id]"))) {
          const itemId = item.getAttribute("data-canvas-task-id");
          const isSelected = Boolean(next && itemId === next);
          item.classList.toggle("is-selected", isSelected);
          item.setAttribute("aria-pressed", isSelected ? "true" : "false");
          item.setAttribute("data-selected-task", isSelected ? "true" : "false");
          const marker = item.querySelector(".canvas-fallback-selected-marker");
          if (marker) marker.textContent = isSelected ? "Selected" : "";
        }
      }
      if (window.OuroborosCanvas && root && latestOverview && group) {
        const graphForRender = graph || canvasGraphFor(latestOverview, group);
        const effective = next && graphForRender.nodes.some((node) => node.id === next) ? next : fallback;
        window.OuroborosCanvas.render(root, {
          graph: graphForRender,
          selectedTaskId: effective,
          onSelectTask: selectCanvasTask,
        });
      }
      patchInspectorPanel(dashboardInspectorTimelineHtml(group) + dashboardInspectorComposerHtml(), dashboardInspectorDesignHtml() + dashboardInspectorLinearIntakeHtml() + dashboardInspectorSecondaryHtml(latestOverview, group));
    };
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
      const sessionCountByTask = new Map();
      const evidenceCountByTask = new Map();
      const changedFileCountByTask = new Map();
      const diffPathsByTask = new Map();
      for (const task of tasks) {
        sessionCountByTask.set(task.id, 0);
        evidenceCountByTask.set(task.id, 0);
        changedFileCountByTask.set(task.id, 0);
        diffPathsByTask.set(task.id, new Set());
      }
      for (const session of overview.sessions || []) {
        if (!groupTaskIds.has(session.taskId)) continue;
        sessionCountByTask.set(session.taskId, (sessionCountByTask.get(session.taskId) || 0) + 1);
        let evidenceCount = evidenceCountByTask.get(session.taskId) || 0;
        if (session.output && session.output.summary) evidenceCount += 1;
        evidenceCount += session.output && Array.isArray(session.output.checks) ? session.output.checks.length : 0;
        evidenceCount += session.output && Array.isArray(session.output.artifacts) ? session.output.artifacts.length : 0;
        evidenceCount += session.output && Array.isArray(session.output.problems) ? session.output.problems.length : 0;
        evidenceCountByTask.set(session.taskId, evidenceCount);

        const changedFiles = new Set();
        for (const path of (session.output && session.output.changedFiles) || []) {
          if (!path || changedFiles.has(path)) continue;
          changedFiles.add(path);
        }
        changedFileCountByTask.set(session.taskId, (changedFileCountByTask.get(session.taskId) || 0) + changedFiles.size);

        const diffPaths = diffPathsByTask.get(session.taskId) || new Set();
        for (const path of (session.output && session.output.changedFiles) || []) {
          if (path) diffPaths.add(path);
        }
        for (const artifact of (session.output && session.output.artifacts) || []) {
          const record = artifact && typeof artifact === "object" ? artifact : null;
          const kind = record && typeof record.kind === "string" ? record.kind.toLowerCase() : "";
          const path = record && typeof record.path === "string" ? record.path : "";
          if (path && kind.includes("diff")) diffPaths.add(path);
        }
        diffPathsByTask.set(session.taskId, diffPaths);
      }
      for (const lesson of overview.lessons || []) {
        if (!groupTaskIds.has(lesson.taskId)) continue;
        evidenceCountByTask.set(lesson.taskId, (evidenceCountByTask.get(lesson.taskId) || 0) + 1);
      }
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
            sessionCount: sessionCountByTask.get(task.id) || 0,
            evidenceCount: evidenceCountByTask.get(task.id) || 0,
            todoCount: Array.isArray(task.doneWhen) ? task.doneWhen.length : 0,
            changedFileCount: changedFileCountByTask.get(task.id) || 0,
            diffCount: (diffPathsByTask.get(task.id) || new Set()).size,
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
      const fallbackSelectedTaskId = resolveFallbackSelectedTaskId(graph, group);
      const effectiveSelectedTaskId = selectedTaskId && graph.nodes.some((node) => node.id === selectedTaskId)
        ? selectedTaskId
        : fallbackSelectedTaskId;
      return '<div class="canvas-inner" data-canvas-goal-id="' + escapeHtml(group.id) + '">' +
        '<div id="dashboard-canvas-root" class="canvas-shell" data-canvas-graph="' + escapeHtml(JSON.stringify(graph)) + '" data-canvas-task-count="' + escapeHtml(graph.nodes.length) + '" data-canvas-edge-count="' + escapeHtml(graph.edges.length) + '" data-canvas-selected-task-id="' + escapeHtml(effectiveSelectedTaskId || "") + '" data-canvas-fallback-task-id="' + escapeHtml(fallbackSelectedTaskId || "") + '">' +
        '<div class="canvas-fallback" aria-label="Canvas task map">' +
        '<div class="canvas-fallback-head"><div class="canvas-fallback-title">Task map</div><div class="canvas-fallback-meta">' + escapeHtml(graph.nodes.length) + ' tasks | ' + escapeHtml(graph.edges.length) + ' links</div></div>' +
        (graph.nodes.length ? '<ul class="canvas-fallback-list" id="dashboard-canvas-fallback-list">' + graph.nodes.map((node) => {
          const task = node.data;
          const latest = task.latestSession;
          const latestMeta = latest ? [latest.status, latest.sessionName || latest.codexSessionId || latest.attemptId].filter(Boolean).join(" | ") : "no session";
          const model = latest && latest.model ? latest.model : null;
          const isSelected = Boolean(effectiveSelectedTaskId && task.taskId === effectiveSelectedTaskId);
          const sessionLabel = task.sessionCount === 1 ? "1 session" : task.sessionCount + " sessions";
          const evidenceLabel = task.evidenceCount === 1 ? "1 evidence" : task.evidenceCount + " evidence";
          const todoLabel = task.todoCount === 1 ? "1 todo" : task.todoCount + " todos";
          return '<li class="canvas-fallback-node' + (isSelected ? " is-selected" : "") + '" data-canvas-task-id="' + escapeHtml(task.taskId) + '" data-canvas-task-status="' + escapeHtml(task.status) + '" data-canvas-task-session-count="' + escapeHtml(task.sessionCount) + '" data-canvas-task-evidence-count="' + escapeHtml(task.evidenceCount) + '" data-canvas-task-todo-count="' + escapeHtml(task.todoCount) + '" data-canvas-task-diff-count="' + escapeHtml(task.diffCount) + '" data-selected-task="' + (isSelected ? "true" : "false") + '" aria-pressed="' + (isSelected ? "true" : "false") + '" tabindex="0" role="button" aria-label="Task ' + escapeHtml(task.role) + ' ' + escapeHtml(task.status) + ': ' + escapeHtml(task.goal) + (isSelected ? ". Selected." : ". Press Enter or Space to select.") + '">' +
            '<div class="canvas-fallback-node-head"><span class="canvas-fallback-role">' + escapeHtml(task.role) + '</span><span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span><span class="canvas-fallback-selected-marker" aria-hidden="true">' + (isSelected ? "Selected" : "") + '</span></div>' +
            '<div class="canvas-fallback-node-goal">' + escapeHtml(task.goal) + '</div>' +
            '<div class="canvas-fallback-node-meta">' + escapeHtml(sessionLabel) + ' | ' + escapeHtml(evidenceLabel) + ' | ' + escapeHtml(todoLabel) + ' | ' + escapeHtml(latestMeta) + (model ? ' | model ' + escapeHtml(model.model || "") + ' | source ' + escapeHtml(model.source || "") : '') + '</div>' +
          '</li>';
        }).join("") + '</ul>' : '<div class="empty">No tasks available for this goal.</div>') +
        (graph.edges.length ? '<div class="canvas-fallback-links"><div class="canvas-fallback-links-label">Links</div><div class="canvas-fallback-links-meta">' + graph.edges.slice(0, 12).map((edge) => '<span data-canvas-edge="' + escapeHtml(edge.id) + '">' + escapeHtml(edge.label) + ': ' + escapeHtml(edge.source) + ' -> ' + escapeHtml(edge.target) + '</span>').join("") + '</div></div>' : '') +
        '<div hidden>' + graph.nodes.map((node) => {
          const task = node.data;
          const model = task.latestSession && task.latestSession.model ? task.latestSession.model : null;
          return '<span data-canvas-task-id="' + escapeHtml(task.taskId) + '">' + escapeHtml(task.role) + ' ' + escapeHtml(task.status) +
            (model ? ' latestSession.model ' + escapeHtml(model.model || "") + ' latestSession.source ' + escapeHtml(model.source || "") : '') +
            '</span>';
        }).join("") + graph.edges.map((edge) =>
          '<span data-canvas-edge="' + escapeHtml(edge.id) + '">' + escapeHtml(edge.label) + '</span>'
        ).join("") + '</div>' +
        '</div>' +
        '</div>';
    };
    const dashboardWorkspaceHtml = (group) => renderCanvasWorkspace(group);
    const mountReactFlowCanvas = () => {
      const mount = document.getElementById("dashboard-canvas-root");
      if (!mount) return;
      const graphJson = mount.getAttribute("data-canvas-graph") || '{"nodes":[],"edges":[]}';
      const mountGraph = () => {
        try {
          const graph = JSON.parse(graphJson);
          const selectedFromAttr = mount.getAttribute("data-canvas-selected-task-id") || "";
          const initialSelected = selectedTaskId && graph.nodes.some((node) => node.id === selectedTaskId)
            ? selectedTaskId
            : (selectedFromAttr && graph.nodes.some((node) => node.id === selectedFromAttr) ? selectedFromAttr : null);
          if (initialSelected && initialSelected !== selectedTaskId) {
            selectedTaskId = initialSelected;
            persistDashboardState();
          }
          window.OuroborosCanvas?.render(mount, {
            graph,
            selectedTaskId: initialSelected,
            onSelectTask: selectCanvasTask,
          });
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
    const dashboardInspectorTimelineHtml = (group) => {
      if (!group) return '<section class="inspector-card conversation-timeline-section chat-transcript-section" data-inspector-section="conversation" id="conversation-timeline" data-conversation-timeline data-chat-transcript><h2>Chat</h2><div class="chat-transcript-meta">Codex-style agent conversation · oldest first.</div><div class="chat-transcript-scroll conversation-timeline-scroll" data-conversation-timeline-scroll data-chat-transcript-scroll><div class="empty">Select a task to view its chronological conversation timeline.</div></div></section>';
      const scopedGroup = selectedTaskId ? { ...group, sessions: group.sessions.filter((session) => session.taskId === selectedTaskId), lessons: (group.lessons || []).filter((lesson) => lesson.taskId === selectedTaskId), tasks: group.tasks.filter((task) => task.id === selectedTaskId) } : group;
      return '<section class="inspector-card conversation-timeline-section chat-transcript-section" data-inspector-section="conversation" id="conversation-timeline" data-conversation-timeline data-chat-transcript' + (selectedTaskId ? ' data-task-id="' + escapeHtml(selectedTaskId) + '"' : '') + '>' +
        '<h2>Chat</h2>' +
        '<div class="chat-transcript-meta conversation-timeline-meta">Codex-style agent conversation · oldest first.</div>' +
        '<div class="chat-transcript-scroll conversation-timeline-scroll" data-conversation-timeline-scroll data-chat-transcript-scroll>' +
        renderConversationTimeline(scopedGroup) +
        '</div>' +
        '</section>';
    };
    const shouldRouteInterruptClient = (overview, group) => {
      if (!overview) return false;
      const runStatus = overview.run?.status;
      if (runStatus === "running") return true;
      const sessions = overview.sessions || [];
      if (sessions.some((session) => session.status === "running")) return true;
      const tasks = overview.tasks || [];
      if (tasks.some((task) => task.status === "running" || task.status === "todo")) return true;
      if (group) {
        const groupTaskIds = new Set((group.tasks || []).map((task) => task.id));
        if (sessions.some((session) => groupTaskIds.has(session.taskId) && session.status === "running")) return true;
      }
      return false;
    };
    const composerMode = () => shouldRouteInterruptClient(latestOverview, selectedGroupRef) ? "interrupt" : "intake";
    const dashboardInspectorComposerHtml = () => {
      const mode = composerMode();
      const placeholder = mode === "interrupt"
        ? "Interrupt the active run with a new instruction"
        : "Reply or direct the next step";
      const hint = mode === "interrupt"
        ? "Cmd/Ctrl+Enter interrupts the active run · Shift+Enter for newline"
        : "Cmd/Ctrl+Enter sends via intake · Shift+Enter for newline";
      const buttonLabel = mode === "interrupt" ? "Interrupt" : "Send";
      return '<section class="inspector-card inspector-composer-section" data-inspector-section="composer" id="inspector-composer-section" data-inspector-composer-section data-composer-mode="' + escapeHtml(mode) + '">' +
        '<h2>Composer</h2>' +
        '<form class="inspector-composer" id="inspector-composer" data-inspector-composer-form>' +
          '<textarea id="inspector-composer-input" name="prompt" class="inspector-composer-input" rows="2" placeholder="' + escapeHtml(placeholder) + '" aria-label="Inspector composer"></textarea>' +
          '<div class="inspector-composer-actions">' +
            '<span class="inspector-composer-hint" data-composer-mode-hint>' + escapeHtml(hint) + '</span>' +
            '<span class="inspector-composer-status" id="inspector-composer-status" data-composer-status aria-live="polite"></span>' +
            '<button type="submit" class="plain-button" data-inspector-composer-send data-composer-send>' + escapeHtml(buttonLabel) + '</button>' +
          '</div>' +
        '</form>' +
      '</section>';
    };
    const dashboardInspectorEvidenceHtml = (overview, group) => {
      if (!group) return "";
      const scopedGroup = selectedTaskId
        ? {
            ...group,
            sessions: group.sessions.filter((session) => session.taskId === selectedTaskId),
            lessons: (group.lessons || []).filter((lesson) => lesson.taskId === selectedTaskId),
            tasks: group.tasks.filter((task) => task.id === selectedTaskId),
          }
        : group;
      return renderSubsessionThreadsSection(overview, scopedGroup) + renderChangedFilesSection(scopedGroup);
    };
    const dashboardInspectorSecondaryHtml = (overview, group) => {
      const body = dashboardRunStatusHtml(overview) +
        dashboardInspectorEvidenceHtml(overview, group);
      return '<section class="inspector-card inspector-evidence-disclosure" data-inspector-section="run-evidence" data-secondary-evidence>' +
        '<details' + (secondaryEvidenceOpen ? ' open' : '') + '>' +
          '<summary class="inspector-evidence-summary" data-secondary-evidence-summary>Run evidence</summary>' +
          '<div class="inspector-evidence-body" data-secondary-evidence-body>' + body + '</div>' +
        '</details>' +
      '</section>';
    };
    const formatDesignCurrency = (value, currency) => {
      if (typeof value !== "number") return "";
      return currency ? currency + " " + value : String(value);
    };
    const dashboardDesignDetailsHtml = (status) => {
      const lines = [];
      const charter = status.charter;
      if (charter) {
        lines.push('<div class="design-detail-block"><div class="design-detail-title">Charter</div>');
        lines.push('<div class="design-detail-row"><span>id</span><code>' + escapeHtml(charter.id) + '</code></div>');
        lines.push('<div class="design-detail-row"><span>version</span><span>v' + escapeHtml(String(charter.version)) + '</span></div>');
        if (charter.summary?.mission) {
          lines.push('<div class="design-detail-row"><span>mission</span><span>' + escapeHtml(charter.summary.mission) + '</span></div>');
        }
        if (charter.activatedAt) {
          lines.push('<div class="design-detail-row"><span>activated</span><span>' + escapeHtml(charter.activatedAt) + '</span></div>');
        }
        if (typeof charter.summary?.reviewCadenceDays === "number") {
          lines.push('<div class="design-detail-row"><span>review cadence</span><span>every ' + escapeHtml(String(charter.summary.reviewCadenceDays)) + 'd</span></div>');
        }
        lines.push('</div>');
      }
      const budget = status.budget;
      if (budget) {
        lines.push('<div class="design-detail-block"><div class="design-detail-title">Budget</div>');
        if (typeof budget.monthlyBudget === "number") {
          lines.push('<div class="design-detail-row"><span>monthly</span><span>' + escapeHtml(formatDesignCurrency(budget.monthlyBudget, budget.currency)) + '</span></div>');
        }
        if (typeof budget.experimentBudget === "number") {
          lines.push('<div class="design-detail-row"><span>experiment</span><span>' + escapeHtml(formatDesignCurrency(budget.experimentBudget, budget.currency)) + '</span></div>');
        }
        if (typeof budget.recurringSpendApprovalAbove === "number") {
          lines.push('<div class="design-detail-row"><span>recurring approval &gt;</span><span>' + escapeHtml(formatDesignCurrency(budget.recurringSpendApprovalAbove, budget.currency)) + '</span></div>');
        }
        if (typeof budget.runwayFloorMonths === "number") {
          lines.push('<div class="design-detail-row"><span>runway floor</span><span>' + escapeHtml(String(budget.runwayFloorMonths)) + 'mo</span></div>');
        }
        if (budget.portfolio) {
          const parts = [];
          if (typeof budget.portfolio.core === "number") parts.push("core " + budget.portfolio.core + "%");
          if (typeof budget.portfolio.growth === "number") parts.push("growth " + budget.portfolio.growth + "%");
          if (typeof budget.portfolio.exploration === "number") parts.push("exploration " + budget.portfolio.exploration + "%");
          if (parts.length) {
            lines.push('<div class="design-detail-row"><span>portfolio</span><span>' + escapeHtml(parts.join(", ")) + '</span></div>');
          }
        }
        lines.push('</div>');
      }
      const authority = status.authority;
      if (authority) {
        const flags = [];
        if (authority.autoResearch) flags.push("auto-research");
        if (authority.autoReversibleExperiments) flags.push("auto-experiments");
        if (authority.autoIntegrateVerifiedCode) flags.push("auto-integrate");
        const checkpoints = Array.isArray(authority.requireHumanFor) ? authority.requireHumanFor : [];
        if (flags.length || checkpoints.length) {
          lines.push('<div class="design-detail-block"><div class="design-detail-title">Authority</div>');
          if (flags.length) {
            lines.push('<div class="design-detail-row"><span>delegated</span><span>' + escapeHtml(flags.join(", ")) + '</span></div>');
          }
          if (checkpoints.length) {
            lines.push('<div class="design-detail-row"><span>human checkpoints</span><span>' + escapeHtml(checkpoints.join(", ")) + '</span></div>');
          }
          lines.push('</div>');
        }
      }
      const proposal = status.currentProposal;
      if (proposal) {
        lines.push('<div class="design-detail-block"><div class="design-detail-title">Proposal evidence</div>');
        lines.push('<div class="design-detail-row"><span>id</span><code>' + escapeHtml(proposal.id) + '</code></div>');
        const problemText = proposal.proposal?.problem || proposal.problem;
        if (problemText) {
          lines.push('<div class="design-detail-row"><span>problem</span><span>' + escapeHtml(problemText) + '</span></div>');
        }
        if (proposal.summary?.recommendation) {
          lines.push('<div class="design-detail-row"><span>recommendation</span><span>' + escapeHtml(proposal.summary.recommendation) + '</span></div>');
        }
        if (proposal.proposal?.targetOutcome) {
          lines.push('<div class="design-detail-row"><span>target outcome</span><span>' + escapeHtml(proposal.proposal.targetOutcome) + '</span></div>');
        }
        const evidenceRefs = proposal.proposal?.evidenceRefs;
        if (Array.isArray(evidenceRefs) && evidenceRefs.length) {
          lines.push('<div class="design-detail-row"><span>evidence refs</span><span>' + escapeHtml(evidenceRefs.join("; ")) + '</span></div>');
        }
        const options = proposal.proposal?.options;
        if (Array.isArray(options) && options.length) {
          for (const option of options) {
            const name = option && typeof option === "object" && typeof option.name === "string" ? option.name : "(option)";
            lines.push('<div class="design-detail-row design-detail-option"><span>option</span><span>' + escapeHtml(name) + '</span></div>');
            const metaFields = [
              ["benefits", option && typeof option === "object" ? option.benefits : undefined],
              ["costs", option && typeof option === "object" ? option.costs : undefined],
              ["risks", option && typeof option === "object" ? option.risks : undefined],
              ["lock-in", option && typeof option === "object" ? option.lockIn : undefined],
            ];
            for (const [field, values] of metaFields) {
              if (Array.isArray(values) && values.length) {
                lines.push('<div class="design-detail-row design-detail-option-meta"><span>' + escapeHtml(field) + '</span><span>' + escapeHtml(values.map((value) => String(value)).join("; ")) + '</span></div>');
              }
            }
          }
        }
        const assumptions = proposal.proposal?.assumptions;
        if (Array.isArray(assumptions) && assumptions.length) {
          lines.push('<div class="design-detail-row"><span>assumptions</span><span>' + escapeHtml(assumptions.join("; ")) + '</span></div>');
        }
        const uncertainty = proposal.proposal?.uncertainty;
        if (Array.isArray(uncertainty) && uncertainty.length) {
          lines.push('<div class="design-detail-row"><span>uncertainty</span><span>' + escapeHtml(uncertainty.join("; ")) + '</span></div>');
        }
        const investment = proposal.proposal?.investment;
        if (investment) {
          if (typeof investment.oneTimeCost === "number") {
            lines.push('<div class="design-detail-row"><span>one-time cost</span><span>' + escapeHtml(String(investment.oneTimeCost)) + '</span></div>');
          }
          if (typeof investment.recurringCost === "number") {
            lines.push('<div class="design-detail-row"><span>recurring cost</span><span>' + escapeHtml(String(investment.recurringCost)) + '</span></div>');
          }
          if (investment.reversibility) {
            lines.push('<div class="design-detail-row"><span>reversibility</span><span>' + escapeHtml(investment.reversibility) + '</span></div>');
          }
          if (investment.portfolio) {
            lines.push('<div class="design-detail-row"><span>portfolio</span><span>' + escapeHtml(investment.portfolio) + '</span></div>');
          }
          if (investment.timeBudget) {
            lines.push('<div class="design-detail-row"><span>time budget</span><span>' + escapeHtml(investment.timeBudget) + '</span></div>');
          }
        }
        const experiment = proposal.proposal?.experiment;
        if (experiment && typeof experiment === "object") {
          lines.push('<div class="design-detail-row design-detail-experiment"><span>experiment hypothesis</span><span>' + escapeHtml(experiment.hypothesis || "(unspecified)") + '</span></div>');
          if (experiment.smallestTest) {
            lines.push('<div class="design-detail-row"><span>smallest test</span><span>' + escapeHtml(experiment.smallestTest) + '</span></div>');
          }
          if (Array.isArray(experiment.stopConditions) && experiment.stopConditions.length) {
            lines.push('<div class="design-detail-row"><span>stop conditions</span><span>' + escapeHtml(experiment.stopConditions.join("; ")) + '</span></div>');
          }
          if (experiment.rollback) {
            lines.push('<div class="design-detail-row"><span>rollback</span><span>' + escapeHtml(experiment.rollback) + '</span></div>');
          }
        }
        const contract = proposal.proposal?.evaluationContract;
        if (contract) {
          if (Array.isArray(contract.baseline) && contract.baseline.length) {
            lines.push('<div class="design-detail-row"><span>baseline</span><span>' + escapeHtml(contract.baseline.join("; ")) + '</span></div>');
          }
          if (Array.isArray(contract.successMetrics) && contract.successMetrics.length) {
            lines.push('<div class="design-detail-row"><span>success metrics</span><span>' + escapeHtml(contract.successMetrics.join("; ")) + '</span></div>');
          }
          if (Array.isArray(contract.guardMetrics) && contract.guardMetrics.length) {
            lines.push('<div class="design-detail-row"><span>guard metrics</span><span>' + escapeHtml(contract.guardMetrics.join("; ")) + '</span></div>');
          }
          if (Array.isArray(contract.requiredEvidence) && contract.requiredEvidence.length) {
            lines.push('<div class="design-detail-row"><span>required evidence</span><span>' + escapeHtml(contract.requiredEvidence.join("; ")) + '</span></div>');
          }
          if (contract.reviewAt) {
            lines.push('<div class="design-detail-row"><span>review at</span><span>' + escapeHtml(contract.reviewAt) + '</span></div>');
          }
        }
        lines.push('</div>');
      }
      if (status.latestDecision) {
        const decision = status.latestDecision;
        lines.push('<div class="design-detail-block"><div class="design-detail-title">Latest decision</div>');
        lines.push('<div class="design-detail-row"><span>decision</span><span>' + escapeHtml(decision.decision) + ' by ' + escapeHtml(decision.actorKind) + (decision.actorRef ? ' (' + escapeHtml(decision.actorRef) + ')' : '') + '</span></div>');
        if (Array.isArray(decision.reasons) && decision.reasons.length) {
          lines.push('<div class="design-detail-row"><span>reasons</span><span>' + escapeHtml(decision.reasons.join("; ")) + '</span></div>');
        }
        lines.push('</div>');
      }
      if (status.recentOutcomes?.length) {
        lines.push('<div class="design-detail-block"><div class="design-detail-title">Recent outcomes</div>');
        for (const outcome of status.recentOutcomes.slice(0, 3)) {
          lines.push('<div class="design-detail-row"><span>' + escapeHtml(outcome.stage) + '</span><span>' + escapeHtml(outcome.recommendation) + (outcome.reviewAt ? ' · review ' + escapeHtml(outcome.reviewAt) : '') + '</span></div>');
        }
        lines.push('</div>');
      }
      const timelineLines = dashboardDesignTimelineLinesHtml(status.timeline);
      if (timelineLines) {
        lines.push('<div class="design-detail-block" data-design-timeline-block>');
        lines.push('<div class="design-detail-title">Design timeline</div>');
        lines.push('<ol class="design-timeline" data-design-timeline data-timeline-order="oldest-first">');
        lines.push(timelineLines);
        lines.push('</ol>');
        lines.push('</div>');
      }
      return lines.length ? lines.join("") : '<div class="empty">No design details available.</div>';
    };
    const dashboardDesignTimelineLinesHtml = (timeline) => {
      if (!Array.isArray(timeline) || timeline.length === 0) return "";
      return timeline
        .map((entry) => {
          const kind = entry.kind || "research";
          const label = entry.label || "(no label)";
          const status = entry.status ? ' · ' + escapeHtml(entry.status) : '';
          const detail = entry.detail ? ' · ' + escapeHtml(entry.detail) : '';
          const when = entry.createdAt ? ' · ' + escapeHtml(formatDesignTimelineWhen(entry.createdAt)) : '';
          return '<li class="design-timeline-entry" data-design-timeline-entry data-design-timeline-kind="' + escapeHtml(kind) + '" data-design-timeline-label="' + escapeHtml(label.toLowerCase()) + '">' +
            '<span class="design-timeline-kind">' + escapeHtml(kind) + '</span>' +
            '<span class="design-timeline-label">' + escapeHtml(label) + '</span>' +
            '<span class="design-timeline-meta">' + status + detail + when + '</span>' +
          '</li>';
        })
        .join("");
    };
    const formatDesignTimelineWhen = (value) => {
      if (!value) return "";
      const text = String(value);
      const parsed = Date.parse(text);
      if (!Number.isFinite(parsed)) return text;
      try {
        return new Date(parsed).toISOString();
      } catch {
        return text;
      }
    };
    const dashboardInspectorDesignSummaryHtml = (status) => {
      if (!status) return "";
      const proposal = status.currentProposal;
      const headerBits = [];
      if (proposal?.summary?.status) headerBits.push(escapeHtml(proposal.summary.status));
      if (status.activeSignalCount > 0) headerBits.push(escapeHtml(String(status.activeSignalCount)) + " active signal" + (status.activeSignalCount === 1 ? "" : "s"));
      const summary = proposal?.summary?.title || "(no active proposal)";
      const decision = status.latestDecision;
      const recommendation = proposal?.summary?.recommendation;
      const nextReview = proposal?.summary?.nextReviewAt || status.nextOutcomeReview?.reviewAt;
      const counts = Object.entries(status.proposalCountsByStatus || {}).sort(([left], [right]) => left.localeCompare(right));
      return '<section class="inspector-card inspector-evidence-disclosure inspector-design-section" data-inspector-section="design-status" data-design-status-section>' +
        '<h2>Designer</h2>' +
        '<div class="design-summary">' +
          '<div class="design-summary-title">' + escapeHtml(summary) + '</div>' +
          '<div class="design-summary-meta">' + (headerBits.length ? headerBits.join(" · ") : "no active proposals") + '</div>' +
          (recommendation ? '<div class="design-summary-row"><span>recommendation</span><span>' + escapeHtml(recommendation) + '</span></div>' : '') +
          (decision ? '<div class="design-summary-row"><span>latest decision</span><span>' + escapeHtml(decision.decision) + ' by ' + escapeHtml(decision.actorKind) + '</span></div>' : '') +
          (nextReview ? '<div class="design-summary-row"><span>next review</span><span>' + escapeHtml(nextReview) + '</span></div>' : '') +
          (counts.length ? '<div class="design-summary-row"><span>proposals</span><span>' + escapeHtml(counts.map(([state, count]) => state + "=" + count).join(", ")) + '</span></div>' : '') +
        '</div>' +
        '<details' + (designDetailsOpen ? ' open' : '') + ' data-design-details>' +
          '<summary class="inspector-evidence-summary" data-design-details-summary>Charter, budget and proposal evidence</summary>' +
          '<div class="inspector-evidence-body" data-design-details-body>' + dashboardDesignDetailsHtml(status) + '</div>' +
        '</details>' +
      '</section>';
    };
    const dashboardInspectorDesignHtml = () => dashboardInspectorDesignSummaryHtml(latestDesignStatus);
    const dashboardInspectorLinearIntakeHtml = () => {
      const intake = latestLinearIntake;
      if (!intake) {
        return '<section class="inspector-card inspector-linear-intake-section" data-inspector-section="linear-intake" data-linear-intake-section><h2>Linear intake</h2><div class="empty">Loading intake lifecycle…</div></section>';
      }
      const polling = intake.polling || null;
      const runner = intake.runner || null;
      const events = Array.isArray(intake.events) ? intake.events : [];
      const configured = polling && polling.configured;
      const terminalFailure = polling && polling.terminalFailure ? String(polling.terminalFailure) : "";
      const lastError = polling && polling.lastError ? String(polling.lastError) : "";
      const retryAttempt = polling ? Number(polling.retryAttempt || 0) : 0;
      const nextEligiblePollAt = polling && polling.nextEligiblePollAt ? String(polling.nextEligiblePollAt) : "";
      const lastCycleAt = polling && polling.lastCycleAt ? String(polling.lastCycleAt) : "";
      const lastStatus = polling && polling.lastStatus ? String(polling.lastStatus) : "idle";
      const cyclesCompleted = polling ? Number(polling.cyclesCompleted || 0) : 0;
      const issuesIngested = polling ? Number(polling.issuesIngested || 0) : 0;
      const issuesDeduplicated = polling ? Number(polling.issuesDeduplicated || 0) : 0;
      const issuesRejected = polling ? Number(polling.issuesRejected || 0) : 0;
      const issuesMalformed = polling ? Number(polling.issuesMalformed || 0) : 0;
      const supervisorStatus = runner && runner.supervisorStatus ? String(runner.supervisorStatus) : "idle";
      const runnerStatus = runner && runner.runnerStatus ? String(runner.runnerStatus) : "idle";
      const headerBits = [];
      if (configured) {
        headerBits.push('<span class="status-text ' + escapeHtml(lastStatus) + '">' + escapeHtml(lastStatus) + '</span>');
      } else {
        headerBits.push('<span class="status-text idle">unconfigured</span>');
      }
      if (runner && runner.supervisorRunning) headerBits.push("supervisor " + escapeHtml(supervisorStatus));
      if (runner && runner.runnerRunning) headerBits.push("runner " + escapeHtml(runnerStatus));
      const summaryText = configured
        ? (terminalFailure ? "terminal failure" : retryAttempt > 0 ? "retry in progress" : nextEligiblePollAt ? "scheduled" : lastStatus === "idle" ? "idle" : "polling")
        : (terminalFailure ? "terminal failure (unconfigured)" : "no project or team configured");
      const summaryClass = terminalFailure ? "blocked" : retryAttempt > 0 ? "running" : configured ? "running" : "todo";
      const parts = [];
      parts.push('<section class="inspector-card inspector-linear-intake-section" data-inspector-section="linear-intake" data-linear-intake-section>');
      parts.push('<h2>Linear intake</h2>');
      parts.push('<div class="linear-intake-summary" data-linear-intake-summary>');
      parts.push('<div class="linear-intake-summary-title">Autonomous bounded polling</div>');
      parts.push('<div class="linear-intake-summary-meta">');
      parts.push('<span class="status-text ' + escapeHtml(summaryClass) + '">' + escapeHtml(summaryText) + '</span>');
      if (headerBits.length) parts.push(' · ' + headerBits.join(" · "));
      parts.push('</div>');
      if (terminalFailure) {
        parts.push('<div class="linear-intake-blocked" data-linear-intake-terminal>' + escapeHtml(terminalFailure) + '</div>');
      }
      parts.push('<div class="linear-intake-rows">');
      parts.push('<div class="linear-intake-row"><span>supervisor state</span><span>' + escapeHtml(supervisorStatus) + '</span></div>');
      parts.push('<div class="linear-intake-row"><span>runner state</span><span>' + escapeHtml(runnerStatus) + '</span></div>');
      if (configured) {
        parts.push('<div class="linear-intake-row"><span>last cycle</span><span>' + escapeHtml(lastCycleAt || "—") + '</span></div>');
        parts.push('<div class="linear-intake-row"><span>last status</span><span>' + escapeHtml(lastStatus) + '</span></div>');
        parts.push('<div class="linear-intake-row" data-linear-intake-retry-attempt><span>retry attempt</span><span>' + escapeHtml(String(retryAttempt)) + '</span></div>');
        parts.push('<div class="linear-intake-row" data-linear-intake-next-eligible><span>next eligible poll</span><span>' + escapeHtml(nextEligiblePollAt || "—") + '</span></div>');
        if (lastError) {
          parts.push('<div class="linear-intake-row linear-intake-row-error"><span>last error</span><span>' + escapeHtml(compact(lastError, 220)) + '</span></div>');
        }
        parts.push('<div class="linear-intake-row"><span>cycles</span><span>' + escapeHtml(String(cyclesCompleted)) + '</span></div>');
        parts.push('<div class="linear-intake-row"><span>ingested</span><span>' + escapeHtml(String(issuesIngested)) + '</span></div>');
        parts.push('<div class="linear-intake-row"><span>deduplicated</span><span>' + escapeHtml(String(issuesDeduplicated)) + '</span></div>');
        parts.push('<div class="linear-intake-row"><span>rejected</span><span>' + escapeHtml(String(issuesRejected)) + '</span></div>');
        parts.push('<div class="linear-intake-row"><span>malformed</span><span>' + escapeHtml(String(issuesMalformed)) + '</span></div>');
      } else {
        if (lastCycleAt) {
          parts.push('<div class="linear-intake-row"><span>last cycle</span><span>' + escapeHtml(lastCycleAt) + '</span></div>');
        }
        if (lastStatus && lastStatus !== "idle") {
          parts.push('<div class="linear-intake-row"><span>last status</span><span>' + escapeHtml(lastStatus) + '</span></div>');
        }
        if (lastError) {
          parts.push('<div class="linear-intake-row linear-intake-row-error"><span>last error</span><span>' + escapeHtml(compact(lastError, 220)) + '</span></div>');
        }
        parts.push('<div class="linear-intake-row"><span>transport</span><span>linear-ingest-event fallback only</span></div>');
      }
      parts.push('</div>');
      parts.push('</div>');
      if (events.length > 0) {
        parts.push('<details class="linear-intake-events" data-linear-intake-events>');
        parts.push('<summary class="inspector-evidence-summary">Issues discovered · ' + escapeHtml(String(events.length)) + '</summary>');
        parts.push('<div class="linear-intake-events-body" data-linear-intake-events-body>');
        for (const event of events) {
          parts.push('<div class="linear-intake-event" data-linear-intake-event="' + escapeHtml(event.eventId) + '" data-linear-intake-event-status="' + escapeHtml(event.status) + '">');
          const identifier = event.issue && event.issue.identifier ? event.issue.identifier : event.externalId;
          const title = event.issue && event.issue.title ? compact(event.issue.title, 160) : "(no title)";
          const url = event.issue && event.issue.url ? event.issue.url : "";
          const teamKey = event.issue && event.issue.teamKey ? event.issue.teamKey : "";
          parts.push('<div class="linear-intake-event-head">');
          parts.push('<span class="linear-intake-event-identifier">' + escapeHtml(identifier) + '</span>');
          parts.push('<span class="status-text ' + escapeHtml(event.status) + '">' + escapeHtml(event.status) + '</span>');
          parts.push('</div>');
          parts.push('<div class="linear-intake-event-title">' + escapeHtml(title) + '</div>');
          parts.push('<div class="linear-intake-event-meta">');
          if (url) {
            parts.push('<a class="linear-intake-event-url" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener" data-linear-intake-issue-url>' + escapeHtml(url) + '</a>');
          }
          if (teamKey) {
            parts.push('<span class="code-meta">team ' + escapeHtml(teamKey) + '</span>');
          }
          parts.push('<span class="code-meta">inbox ' + escapeHtml(event.eventId) + '</span>');
          if (event.createdAt) {
            parts.push('<span class="code-meta">created ' + escapeHtml(event.createdAt) + '</span>');
          }
          if (event.processedAt) {
            parts.push('<span class="code-meta">processed ' + escapeHtml(event.processedAt) + '</span>');
          }
          parts.push('</div>');
          parts.push('<div class="linear-intake-event-rows">');
          if (event.designerRunId) {
            parts.push('<div class="linear-intake-row" data-linear-intake-designer-run><span>designer run</span><code>' + escapeHtml(event.designerRunId) + '</code></div>');
          }
          if (event.designerTaskId) {
            parts.push('<div class="linear-intake-row"><span>designer task</span><code>' + escapeHtml(event.designerTaskId) + '</code></div>');
          }
          if (event.designerTaskStatus && event.designerTaskStatus !== "unknown") {
            parts.push('<div class="linear-intake-row"><span>designer task status</span><span class="status-text ' + escapeHtml(event.designerTaskStatus) + '">' + escapeHtml(event.designerTaskStatus) + '</span></div>');
          }
          if (event.proposalId) {
            parts.push('<div class="linear-intake-row" data-linear-intake-proposal-id><span>proposal</span><code>' + escapeHtml(event.proposalId) + '</code></div>');
          }
          if (event.proposalStatus) {
            parts.push('<div class="linear-intake-row"><span>proposal status</span><span>' + escapeHtml(event.proposalStatus) + '</span></div>');
          }
          if (event.decisionId) {
            parts.push('<div class="linear-intake-row" data-linear-intake-decision-id><span>decision</span><code>' + escapeHtml(event.decisionId) + '</code></div>');
          }
          if (event.decision) {
            parts.push('<div class="linear-intake-row"><span>decision outcome</span><span>' + escapeHtml(event.decision) + (event.decisionActorKind ? ' by ' + escapeHtml(event.decisionActorKind) : '') + '</span></div>');
          }
          if (event.planningRunId) {
            parts.push('<div class="linear-intake-row" data-linear-intake-planning-run><span>planning run</span><code>' + escapeHtml(event.planningRunId) + '</code></div>');
          }
          if (event.planningRunStatus && event.planningRunStatus !== "unknown") {
            parts.push('<div class="linear-intake-row"><span>planning run status</span><span class="status-text ' + escapeHtml(event.planningRunStatus) + '">' + escapeHtml(event.planningRunStatus) + '</span></div>');
          }
          if (event.externalRefId) {
            parts.push('<div class="linear-intake-row" data-linear-intake-external-ref><span>external reference</span><code>' + escapeHtml(event.externalRefId) + '</code></div>');
          }
          if (event.blocked) {
            parts.push('<div class="linear-intake-row linear-intake-row-error" data-linear-intake-blocked><span>blocked</span><span>' + escapeHtml(event.blockedReason || "blocked") + '</span></div>');
          }
          parts.push('</div>');
          parts.push('</div>');
        }
        parts.push('</div>');
        parts.push('</details>');
      } else if (configured) {
        parts.push('<div class="linear-intake-events-empty" data-linear-intake-events-empty>No Linear issues ingested yet.</div>');
      }
      parts.push('</section>');
      return parts.join("");
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
      parts.push('<section class="inspector-card" data-inspector-section="diagnosis"><h2>Diagnosis</h2>');
      parts.push('<div class="current-task"><div class="current-task-title">Run state</div><div class="current-task-meta">');
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
    const dashboardRunStatusHtml = (overview) => renderRunner(overview) + renderSupervisor(overview) + renderDiagnosis(overview) + renderGuardrailsSection(overview);
    const dashboardOrientationHtml = (overview, group) => {
      const runStatus = overview?.run?.status || "unknown";
      const runnerStatus = overview?.runner?.status || "idle";
      const supervisorStatus = overview?.supervisor?.status || "idle";
      const activeGoal = group?.titleTask?.goal || overview?.run?.goal || "No active goal";
      const resolvedBlockedTaskIds = group?.resolvedBlockedTaskIds || new Set();
      const runningSession = (overview?.sessions || []).find((session) => session.status === "running");
      const blockedTask = (overview?.tasks || []).find((task) => task.status === "blocked" && !resolvedBlockedTaskIds.has(task.id));
      const todoTask = (overview?.tasks || []).find((task) => task.status === "todo");
      const doneRun = runStatus === "done";
      const attention = runningSession
        ? "Running: " + compact(runningSession.taskGoal || activeGoal, 120)
        : blockedTask
          ? "Blocked: " + compact(blockedTask.goal || activeGoal, 120)
          : todoTask
            ? "Next: " + compact(todoTask.goal || activeGoal, 120)
            : doneRun
              ? "Goal complete"
              : "Waiting for work";
      return '<div class="orientation-strip" data-orientation-strip>' +
        '<div class="orientation-cell"><div class="orientation-label">Active goal</div><div class="orientation-value" title="' + escapeHtml(activeGoal) + '">' + escapeHtml(compact(activeGoal, 140)) + '</div></div>' +
        '<div class="orientation-cell"><div class="orientation-label">Run state</div><div class="orientation-value"><span class="status-text ' + escapeHtml(runStatus) + '">' + escapeHtml(runStatus) + '</span></div></div>' +
        '<div class="orientation-cell"><div class="orientation-label">Attention</div><div class="orientation-value" title="' + escapeHtml(attention) + '">' + escapeHtml(attention) + '</div></div>' +
        '<div class="orientation-cell"><div class="orientation-label">Runner</div><div class="orientation-value"><span class="status-text ' + escapeHtml(runnerStatus) + '">' + escapeHtml(runnerStatus) + '</span>' + (supervisorStatus === "running" ? ' · <span class="status-text ' + escapeHtml(supervisorStatus) + '">supervisor ' + escapeHtml(supervisorStatus) + '</span>' : "") + '</div></div>' +
      '</div>';
    };
    const selectedTaskContextFor = (overview, group, taskId) => {
      const tasks = overview && Array.isArray(overview.tasks) ? overview.tasks : (group?.tasks || []);
      const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : null;
      if (!task) return null;
      const sessions = (overview && Array.isArray(overview.sessions) ? overview.sessions : (group?.sessions || [])).filter((session) => session.taskId === task.id);
      const lessons = (overview && Array.isArray(overview.lessons) ? overview.lessons : (group?.lessons || [])).filter((lesson) => lesson.taskId === task.id);
      const changedFiles = changedFilesForGroup({ sessions, tasks: [task], lessons, resolvedBlockedTaskIds: group?.resolvedBlockedTaskIds || new Set(), resolvedBlockedCount: 0 });
      return { task, sessions, lessons, changedFiles };
    };
    const dashboardInspectorHtml = (overview, group) => {
      const context = selectedTaskContextFor(overview, group, selectedTaskId);
      if (!context) return '<section class="inspector-card" data-inspector-section="progress"><h2>Task summary</h2><div class="empty">Select a task to inspect its summary, actions, and progress.</div></section>';
      const { task, sessions } = context;
      const runningSessions = sessions.filter((session) => session.status === "running");
      const resolvedBlockedTaskIds = group?.resolvedBlockedTaskIds || new Set();
      const isResolved = task.status === "blocked" && resolvedBlockedTaskIds.has(task.id);
      const effectiveStatus = isResolved ? "done" : task.status;
      const taskDoneWhen = Array.isArray(task.doneWhen) ? task.doneWhen : [];
      const nextAction = runningSessions.length
        ? "Stop the active attempt or wait for verifier evidence."
        : task.status === "blocked"
          ? isResolved ? "Verifier repaired this task; review the latest evidence." : "Repair the failing verifier evidence under the retry budget."
          : task.status === "todo"
            ? "Wait for the runner to lease this task."
            : task.status === "done"
              ? "Review the verifier decisions and changed files below."
              : "No task-specific action right now.";
      const taskActions = [
        runningSessions.length ? '<button class="plain-button danger" data-stop-attempt-id="' + escapeHtml(runningSessions[0].attemptId) + '" data-task-action="stop">Stop current task</button>' : '',
        (task.status === "blocked" && !isResolved) ? '<button class="plain-button" data-resume-task-id="' + escapeHtml(task.id) + '" data-task-action="resume">Resume selected task</button>' : '',
        (task.status === "blocked" || task.status === "done") ? '<button class="plain-button" data-rerun-task-id="' + escapeHtml(task.id) + '" data-task-action="rerun">Rerun selected task</button>' : ''
      ].filter(Boolean).join("");
      return '<section class="inspector-card" data-inspector-section="progress" data-task-id="' + escapeHtml(task.id) + '"><h2>Task summary</h2>' +
        '<div class="current-task"><div class="current-task-title">' + escapeHtml(task.goal) + '</div><div class="current-task-meta">' + escapeHtml(task.role) + ' · <span class="status-text ' + escapeHtml(effectiveStatus) + '">' + escapeHtml(effectiveStatus) + '</span><br><span class="code-meta">task ' + escapeHtml(task.id) + '</span></div></div>' +
        '<div class="meta">Next action: ' + escapeHtml(nextAction) + '</div>' +
        (taskDoneWhen.length ? '<ul class="todo-list">' + taskDoneWhen.map((item) =>
          '<li class="todo-item ' + (effectiveStatus === "done" ? "done" : "") + '"><span class="checkbox ' + (effectiveStatus === "done" ? "done" : "") + '" aria-hidden="true"></span><span class="todo-text">' + escapeHtml(item) + '<span class="meta">' + escapeHtml(task.role) + '</span></span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded for this task.</div>') +
        (isResolved ? '<div class="meta">' + escapeHtml(task.status === "blocked" ? "1 blocked verifier task was repaired and is now historical evidence." : "Repaired block") + '</div>' : '') +
        (taskActions ? '<div class="action-group"><div class="action-title">Task actions</div><div class="action-help" data-task-action-help>These controls affect only the selected task.</div><div class="action-buttons" data-task-action-buttons>' + taskActions + '</div></div>' : '') +
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
      patchStaticHtml("attachment-chips", attachments.map((attachment, index) =>
        '<div class="attachment-chip" data-attachment-index="' + index + '"><span title="' + escapeHtml(attachment.name) + '">' +
        escapeHtml(attachment.name || "attachment") + '</span><button type="button" aria-label="Remove attachment" data-remove-attachment="' + index + '">x</button></div>'
      ).join(""));
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
    const patchStaticHtml = (id, html) => {
      const current = renderedHtml.get(id);
      if (current === html) return;
      const node = document.getElementById(id);
      if (!node) return;
      const template = document.createElement("template");
      template.innerHTML = html;
      node.replaceChildren(...Array.from(template.content.childNodes));
      renderedHtml.set(id, html);
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
        patchStaticHtml(id, html);
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
      const panel = document.getElementById("inspector-panel");
      const scrollNode = panel?.querySelector("[data-conversation-timeline-scroll]") ;
      const scrollTop = scrollNode instanceof HTMLElement ? scrollNode.scrollTop : 0;
      const distanceFromBottom = scrollNode instanceof HTMLElement
        ? scrollNode.scrollHeight - scrollNode.scrollTop - scrollNode.clientHeight
        : 0;
      patchKeyedChildren("inspector-panel", inspectorHtml + runnerHtml, "data-inspector-section");
      const nextScroll = panel?.querySelector("[data-conversation-timeline-scroll]");
      if (nextScroll instanceof HTMLElement) {
        nextScroll.scrollTop = distanceFromBottom <= 48 ? nextScroll.scrollHeight : scrollTop;
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
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        shouldFollowBottom: distanceFromBottom <= 48,
        streams: Array.from(node.querySelectorAll(".stream-output[data-attempt-stream]")).map((stream) => {
          const streamDistanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
          return {
            attemptId: stream.getAttribute("data-attempt-stream"),
            scrollTop: stream.scrollTop,
            scrollHeight: stream.scrollHeight,
            shouldFollowBottom: streamDistanceFromBottom <= 48,
          };
        }),
      };
    };
    const syncRailState = () => {
      const shell = document.querySelector(".app-shell");
      if (!shell) return;
      const next = railExpanded ? "expanded" : "collapsed";
      const current = shell.getAttribute("data-rail") || next;
      if (current !== next) shell.setAttribute("data-rail", next);
      const collapseButton = document.querySelector('[data-rail-toggle="collapse"]');
      if (collapseButton instanceof HTMLElement) {
        collapseButton.setAttribute("aria-expanded", railExpanded ? "true" : "false");
        collapseButton.setAttribute("aria-label", railExpanded ? "Collapse run navigator" : "Run navigator collapsed");
        collapseButton.title = railExpanded ? "Collapse run navigator" : "Run navigator collapsed";
        collapseButton.disabled = !railExpanded;
      }
      const expandButton = document.querySelector('[data-rail-toggle="expand"]');
      if (expandButton instanceof HTMLElement) {
        expandButton.setAttribute("aria-expanded", railExpanded ? "true" : "false");
      }
    };
    const setRailExpanded = (next) => {
      const value = next === true;
      if (value === railExpanded) return;
      railExpanded = value;
      syncRailState();
      persistDashboardState();
    };
    const normalizeCompactSurface = (value) => value === "details" ? "details" : "canvas";
    const compactSurfaceSwitchHtml = () => {
      const next = normalizeCompactSurface(compactSurface);
      const canvasActive = next === "canvas";
      const detailsActive = next === "details";
      return '<div class="compact-surface-switch" data-compact-surface-switch role="group" aria-label="Workspace surface" data-compact-surface="' + escapeHtml(next) + '">' +
        '<button type="button" class="compact-surface-switch-button" data-compact-surface-toggle="canvas" aria-pressed="' + (canvasActive ? "true" : "false") + '"' + (canvasActive ? ' aria-current="true"' : '') + '>Canvas</button>' +
        '<button type="button" class="compact-surface-switch-button" data-compact-surface-toggle="details" aria-pressed="' + (detailsActive ? "true" : "false") + '"' + (detailsActive ? ' aria-current="true"' : '') + '>Task details</button>' +
        '</div>';
    };
    const syncCompactSurface = () => {
      const next = normalizeCompactSurface(compactSurface);
      const shell = document.querySelector(".app-shell");
      if (shell instanceof HTMLElement) {
        shell.setAttribute("data-compact-surface", next);
      }
      const host = document.querySelector("[data-compact-surface-switch]");
      if (host instanceof HTMLElement) {
        host.setAttribute("data-compact-surface", next);
        for (const button of Array.from(host.querySelectorAll("[data-compact-surface-toggle]"))) {
          const value = button.getAttribute("data-compact-surface-toggle") === "details" ? "details" : "canvas";
          const isActive = value === next;
          button.setAttribute("aria-pressed", isActive ? "true" : "false");
          if (isActive) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
          button.classList.toggle("is-active", isActive);
        }
      }
    };
    const mountCompactSurfaceSwitch = () => {
      const headRow = document.querySelector(".workspace-head-row");
      if (!headRow) return;
      if (headRow.querySelector("[data-compact-surface-switch]")) {
        syncCompactSurface();
        return;
      }
      const mount = document.createElement("div");
      mount.setAttribute("class", "workspace-head-actions");
      mount.setAttribute("data-workspace-head-actions", "");
      mount.innerHTML = compactSurfaceSwitchHtml();
      headRow.appendChild(mount);
      syncCompactSurface();
    };
    const setCompactSurface = (next) => {
      const value = normalizeCompactSurface(next);
      if (value === compactSurface) return;
      compactSurface = value;
      syncCompactSurface();
      persistDashboardState();
    };
    const persistDashboardState = () => {
      writeDashboardState({ selectedGoalId, workspaceTitleExpanded, selectedChangedFilePath, selectedTaskId, secondaryEvidenceOpen, designDetailsOpen, railExpanded, compactSurface, flowScroll: captureFlowScrollState() });
    };
    const persistFlowScrollState = () => {
      const flowScroll = captureFlowScrollState();
      if (!flowScroll) return;
      writeDashboardState({ selectedGoalId, workspaceTitleExpanded, selectedChangedFilePath, selectedTaskId, secondaryEvidenceOpen, designDetailsOpen, railExpanded, compactSurface, flowScroll });
    };
    const restoreFlowScrollState = (scrollState) => {
      if (!scrollState) return;
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      requestAnimationFrame(() => {
        const flowDelta = node.scrollHeight - (scrollState.scrollHeight || 0);
        node.scrollTop = scrollState.shouldFollowBottom ? node.scrollHeight : Math.max(0, scrollState.scrollTop + flowDelta);
        for (const stream of node.querySelectorAll(".stream-output[data-attempt-stream]")) {
          const streamScroll = scrollState.streams.find((item) => item.attemptId === stream.getAttribute("data-attempt-stream"));
          if (!streamScroll) continue;
          const streamDelta = stream.scrollHeight - (streamScroll.scrollHeight || 0);
          stream.scrollTop = streamScroll.shouldFollowBottom ? stream.scrollHeight : Math.max(0, streamScroll.scrollTop + streamDelta);
        }
      });
    };
    const patchStreamOutput = (currentStream, nextStream) => {
      const nextLines = Array.from(nextStream.querySelectorAll("[data-event-index]"));
      if (nextLines.length === 0) {
        if (currentStream.innerHTML !== nextStream.innerHTML) currentStream.replaceChildren(...Array.from(nextStream.cloneNode(true).childNodes));
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
      const nextTranscript = template.content.querySelector("#flow-transcript") || template.content.querySelector(".transcript");
      const currentTranscript = node.querySelector("#flow-transcript") || node.querySelector(".transcript");
      if (!nextTranscript || !currentTranscript) {
        patchStaticHtml("workspace-flow", html);
        restoreFlowScrollState(restoredFlowScrollState || scrollState);
        restoredFlowScrollState = null;
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
      restoreFlowScrollState(restoredFlowScrollState || scrollState);
      restoredFlowScrollState = null;
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
    let lastDesignStatusFetchAt = 0;
    const DESIGN_STATUS_REFRESH_INTERVAL_MS = 15000;
    const maybeRefreshDesignStatus = (force) => {
      const now = Date.now();
      if (!force && now - lastDesignStatusFetchAt < DESIGN_STATUS_REFRESH_INTERVAL_MS) return;
      lastDesignStatusFetchAt = now;
      refreshDesignStatus();
      refreshLinearIntake();
    };
    overviewWorker.onmessage = (event) => {
      if (event.data?.type === "refreshing") {
        document.getElementById("run-status")?.classList.add("updating");
        maybeRefreshDesignStatus(false);
      }
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
        persistDashboardState();
      }
      const selectedGroup = goalGroups.find((group) => group.id === selectedGoalId);
      const allTaskIds = new Set((overview.tasks || []).map((task) => task.id));
      if (selectedTaskId && !allTaskIds.has(selectedTaskId)) {
        selectedTaskId = null;
        persistDashboardState();
      }
      selectedGroupRef = selectedGroup || null;
      const projectName = overview.project ? overview.project.name : "Project Workspace";
      const projectRoot = overview.project ? overview.project.rootPath : "";
      const projectTitle = projectRoot ? projectName + " · " + projectRoot : projectName;
      setTextIfChanged("run-status", overview.run?.status || "unknown");
      setTextIfChanged("run-title", overview.run ? overview.run.goal : runId);
      syncRailState();
      const projectHeader = document.querySelector("[data-project-header]");
      if (projectHeader) projectHeader.setAttribute("title", projectTitle);
      const projectNameNode = document.querySelector("[data-project-name]");
      if (projectNameNode && projectNameNode.textContent !== projectName) projectNameNode.textContent = projectName;
      const projectRootNode = document.querySelector("[data-project-root]");
      if (projectRootNode && projectRootNode.textContent !== projectRoot) projectRootNode.textContent = projectRoot;
      setTextIfChanged("workspace-kicker", "Task canvas");
      syncWorkspaceTitle(selectedGroup ? selectedGroup.titleTask.goal : "No goal selected");
      mountCompactSurfaceSwitch();
      patchStaticHtml("workspace-orientation", dashboardOrientationHtml(overview, selectedGroup));
      patchWorkspace(dashboardWorkspaceHtml(selectedGroup));
      mountReactFlowCanvas();
      patchInspectorPanel(dashboardInspectorTimelineHtml(selectedGroup) + dashboardInspectorComposerHtml(), dashboardInspectorDesignHtml() + dashboardInspectorLinearIntakeHtml() + dashboardInspectorSecondaryHtml(overview, selectedGroup));
    }
    let recentRunsCache = [];
    const RECENT_RUNS_LIMIT = 10;
    const runHistoryRowTemplate = document.createElement("template");
    runHistoryRowTemplate.innerHTML = ${JSON.stringify(renderDashboardRunHistoryRows([
      { id: "__run_history_id__", status: "unknown", goal: "__run_history_goal__", projectId: null, createdAt: null },
    ], "__active_run_id__"))};
    const renderReactRunHistoryRow = (entry) => {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id) return "";
      const status = typeof entry?.status === "string" ? entry.status : "unknown";
      const rawGoal = typeof entry?.goal === "string" ? entry.goal : "";
      const goal = rawGoal.trim() ? rawGoal : "(no goal)";
      const isActive = id === runId;
      const fragment = runHistoryRowTemplate.content.cloneNode(true);
      const row = fragment.querySelector("[data-react-run-history]");
      if (!row) return "";
      row.classList.toggle("is-active", isActive);
      row.dataset.historyRunId = id;
      row.dataset.activeRunId = runId;
      row.dataset.historyRunSelected = isActive ? "true" : "false";
      row.setAttribute("aria-current", isActive ? "true" : "false");
      row.setAttribute("title", rawGoal || id);
      const statusNode = row.querySelector(".history-run-status");
      if (statusNode) {
        statusNode.className = "history-run-status status-" + status;
        statusNode.textContent = status;
      }
      const goalNode = row.querySelector(".history-run-goal");
      if (goalNode) goalNode.textContent = goal;
      const idNode = row.querySelector(".history-run-id");
      if (idNode) idNode.textContent = id;
      const host = document.createElement("div");
      host.appendChild(fragment);
      return host.innerHTML;
    };
    const renderRunHistorySection = (id, runs, label) => {
      const node = document.getElementById(id);
      if (!node) return;
      if (!Array.isArray(runs) || runs.length === 0) {
        patchStaticHtml(id, '<div class="empty">' + escapeHtml(label) + ' unavailable.</div>');
        return;
      }
      patchStaticHtml(id, runs.map(renderReactRunHistoryRow).join(""));
    };
    const renderRecentRunsList = (runs) => {
      const activeRun = runs.find((entry) => entry?.id === runId);
      const historyRuns = runs.filter((entry) => entry?.id !== runId);
      renderRunHistorySection("active-run-list", activeRun ? [activeRun] : [], "Active run");
      renderRunHistorySection("recent-runs-list", historyRuns, "Run history");
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
            patchStaticHtml("recent-runs-list", '<div class="empty">' + escapeHtml(error?.message ? error.message : "Failed to load recent runs.") + '</div>');
          }
        });
    };
    const refreshDesignStatus = () => {
      fetch("/api/runs/" + encodeURIComponent(runId) + "/design/status")
        .then((response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error("design status request failed: " + response.status);
          return response.json();
        })
        .then((snapshot) => {
          latestDesignStatus = snapshot && typeof snapshot === "object" ? snapshot : null;
          if (latestOverview) render(latestOverview);
        })
        .catch(() => {
          latestDesignStatus = null;
          if (latestOverview) render(latestOverview);
        });
    };
    const refreshLinearIntake = () => {
      fetch("/api/runs/" + encodeURIComponent(runId) + "/linear-intake")
        .then((response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error("linear intake request failed: " + response.status);
          return response.json();
        })
        .then((snapshot) => {
          latestLinearIntake = snapshot && typeof snapshot === "object" ? snapshot : null;
          if (latestOverview) render(latestOverview);
        })
        .catch(() => {
          latestLinearIntake = null;
          if (latestOverview) render(latestOverview);
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
      workspaceTitleExpanded = restored.workspaceTitleExpanded === true;
      selectedChangedFilePath = restored.selectedChangedFilePath || null;
      selectedTaskId = restored.selectedTaskId || null;
      railExpanded = restored.railExpanded !== false;
      compactSurface = restored.compactSurface === "details" ? "details" : "canvas";
      syncCompactSurface();
      restoredFlowScrollState = restored.flowScroll || null;
      diffByPath.clear();
      latestDesignStatus = null;
      latestLinearIntake = null;
      overviewWorker.postMessage({ type: "start", runId, apiBase: window.location.origin });
      refreshRecentRuns();
      maybeRefreshDesignStatus(true);
    };
    window.addEventListener("hashchange", () => {
      const fromHash = parseRunIdFromHash(window.location.hash || "");
      if (fromHash && fromHash !== runId) {
        setSelectedRun(fromHash);
      }
    });
    document.addEventListener("toggle", (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const secondaryDisclosure = target.closest("[data-secondary-evidence] > details");
      if (secondaryDisclosure) {
        secondaryEvidenceOpen = secondaryDisclosure.hasAttribute("open");
        persistDashboardState();
        return;
      }
      const designDisclosure = target.closest("[data-design-details]");
      if (designDisclosure) {
        designDetailsOpen = designDisclosure.hasAttribute("open");
        persistDashboardState();
      }
    }, { capture: true });
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const railToggle = event.target.closest("[data-rail-toggle]");
      if (railToggle) {
        const action = railToggle.getAttribute("data-rail-toggle");
        if (action === "collapse") {
          setRailExpanded(false);
        } else if (action === "expand") {
          setRailExpanded(true);
        } else {
          setRailExpanded(!railExpanded);
        }
        return;
      }
      const titleToggle = event.target.closest("[data-workspace-title-toggle]");
      if (titleToggle) {
        workspaceTitleExpanded = !workspaceTitleExpanded;
        persistDashboardState();
        syncWorkspaceTitle(document.getElementById("workspace-title")?.textContent || "");
        return;
      }
      const compactToggle = event.target.closest("[data-compact-surface-toggle]");
      if (compactToggle) {
        const next = compactToggle.getAttribute("data-compact-surface-toggle") === "details" ? "details" : "canvas";
        setCompactSurface(next);
        return;
      }
      const changedFileButton = event.target.closest("[data-changed-file-node='file'][data-changed-file-path]");
      if (changedFileButton) {
        selectedChangedFilePath = changedFileButton.getAttribute("data-changed-file-path");
        persistDashboardState();
        if (latestOverview) render(latestOverview);
        fetchDiffForChangedFile(selectedChangedFilePath);
        return;
      }
      const canvasFallbackNode = event.target.closest(".canvas-fallback-list .canvas-fallback-node[data-canvas-task-id]");
      if (canvasFallbackNode) {
        selectCanvasTask(canvasFallbackNode.getAttribute("data-canvas-task-id"));
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
      persistDashboardState();
      if (latestOverview) render(latestOverview);
    });
    document.getElementById("workspace-flow")?.addEventListener("scroll", persistFlowScrollState, { passive: true });
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
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const fallbackNode = target.closest(".canvas-fallback-list .canvas-fallback-node[data-canvas-task-id]");
      if (!fallbackNode) return;
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      selectCanvasTask(fallbackNode.getAttribute("data-canvas-task-id"));
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
          persistDashboardState();
          setIntakeStatus("Intake planner queued.");
          refreshOverview();
        })
        .catch((error) => setIntakeStatus(error.message))
        .finally(() => { if (submitter) submitter.disabled = false; });
    });
    const inspectorComposer = document.getElementById("inspector-composer");
    const inspectorComposerInput = document.getElementById("inspector-composer-input");
    const inspectorComposerStatus = () => document.getElementById("inspector-composer-status");
    const setComposerStatus = (message, kind) => {
      const node = inspectorComposerStatus();
      if (!node) return;
      node.textContent = message || "";
      node.classList.remove("pending", "sent", "error");
      if (kind) node.classList.add(kind);
    };
    const composerRouteMode = () => {
      const section = document.getElementById("inspector-composer-section");
      if (!section) return "intake";
      const value = section.getAttribute("data-composer-mode") || "intake";
      return value === "interrupt" ? "interrupt" : "intake";
    };
    const submitInspectorComposer = (prompt) => {
      const mode = composerRouteMode();
      const endpoint = mode === "interrupt"
        ? "/api/runs/" + encodeURIComponent(runId) + "/interrupt"
        : "/api/runs/" + encodeURIComponent(runId) + "/intake";
      const body = mode === "interrupt"
        ? { goal: prompt }
        : { prompt, attachments: [], document: intakeDocument(prompt, []) };
      setComposerStatus(mode === "interrupt" ? "Sending interrupt..." : "Creating intake run...", "pending");
      return postJson(endpoint, body)
        .then((payload) => {
          inspectorComposerInput.value = "";
          setComposerStatus(mode === "interrupt" ? "Interrupt sent." : "Intake queued.", "sent");
          if (mode === "intake") {
            selectedGoalId = payload.runId || payload.taskId || selectedGoalId;
            workspaceTitleExpanded = false;
            persistDashboardState();
          }
          refreshOverview();
        })
        .catch((error) => {
          setComposerStatus(error && error.message ? error.message : String(error), "error");
        });
    };
    if (inspectorComposer && inspectorComposerInput) {
      inspectorComposerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
        event.preventDefault();
        inspectorComposer.requestSubmit(document.querySelector("[data-inspector-composer-send]"));
      });
      inspectorComposer.addEventListener("submit", (event) => {
        event.preventDefault();
        const inspectorInputValue = String(inspectorComposerInput.value || "").trim();
        if (!inspectorInputValue) {
          setComposerStatus("Write a prompt to send from the composer.", "error");
          return;
        }
        submitInspectorComposer(inspectorInputValue);
      });
    }
    overviewWorker.postMessage({ type: "start", runId, apiBase: window.location.origin });
    refreshRecentRuns();
    maybeRefreshDesignStatus(true);
    syncCompactSurface();
  </script>
</body>
</html>`;
}

const DASHBOARD_BIND_RETRY_LIMIT = 10;

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
  return (
    text.includes("eaddrinuse") ||
    text.includes("address already in use") ||
    (text.includes("failed to start server") && text.includes("is port") && text.includes("in use"))
  );
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
  designStatus?: DashboardDesignStatusProvider;
  linearIntake?: DashboardLinearIntakeProvider;
}) {
  const fetchHandler = (request: Request) =>
    withDashboardErrors(request, () => handleDashboardRequest(request, input));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DASHBOARD_BIND_RETRY_LIMIT; attempt += 1) {
    const port = input.port === 0 ? dashboardEphemeralPortCandidate(attempt) : input.port;
    try {
      return Bun.serve({ port, fetch: fetchHandler });
    } catch (error) {
      lastError = error;
      if (!shouldRetryDashboardBind({ port: input.port, error, attempt })) {
        if (input.port === 0 && attempt >= DASHBOARD_BIND_RETRY_LIMIT) {
          break;
        }
        throw error;
      }
      Bun.sleepSync(25);
    }
  }
  if (input.port === 0) {
    return createInProcessDashboardServer(fetchHandler, dashboardEphemeralPortCandidate(DASHBOARD_BIND_RETRY_LIMIT + 1));
  }
  throw lastError ?? new Error("serveDashboard bind failed");
}

function dashboardEphemeralPortCandidate(attempt: number) {
  const base = 43_000 + (process.pid % 1_000);
  return base + attempt;
}

function createInProcessDashboardServer(fetchHandler: (request: Request) => Response | Promise<Response>, port: number) {
  const originalFetch = globalThis.fetch;
  const hostnames = new Set(["localhost", "127.0.0.1"]);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? new URL(input)
      : new URL(input.url);
    if (hostnames.has(url.hostname) && url.port === String(port)) {
      const request = input instanceof Request ? input : new Request(url, init);
      return Promise.resolve(fetchHandler(request));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const server = {
    port,
    hostname: "localhost",
    development: false,
    id: `in-process-dashboard-${port}`,
    pendingRequests: 0,
    fetch: fetchHandler,
    stop: () => {
      if (globalThis.fetch === serverFetch) {
        globalThis.fetch = originalFetch;
      }
      return undefined;
    },
    ref: () => server,
    unref: () => server,
    reload: () => server,
    upgrade: () => false,
    publish: () => 0,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
  const serverFetch = globalThis.fetch;
  return server as unknown as ReturnType<typeof Bun.serve>;
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
    designStatus?: DashboardDesignStatusProvider;
    linearIntake?: DashboardLinearIntakeProvider;
  },
) {
  const url = new URL(request.url);
  if (url.pathname === DASHBOARD_ROUTE_PATHS.document) {
    return new Response(dashboardHtml({ runId: input.runId }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === DASHBOARD_ROUTE_PATHS.dashboardCssAsset) {
    return new Response(await bundledDashboardCss(), {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (url.pathname === DASHBOARD_ROUTE_PATHS.tailwindCssAsset) {
    return new Response("", {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (url.pathname === DASHBOARD_ROUTE_PATHS.canvasScriptAsset) {
    return new Response(await bundledDashboardCanvasScript(), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === DASHBOARD_ROUTE_PATHS.canvasCssAsset) {
    return new Response(await bundledDashboardCanvasCss(), {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (url.pathname === DASHBOARD_ROUTE_PATHS.recentRunsApi) {
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
  if (request.method === "POST" && url.pathname === DASHBOARD_ROUTE_PATHS.supervisorStartApi) {
    return withDashboardAction(async () => {
      if (!input.actions?.startSupervisor) {
        throw new Error("dashboard supervisor start is not configured");
      }
      return input.actions.startSupervisor();
    });
  }
  if (request.method === "POST" && url.pathname === DASHBOARD_ROUTE_PATHS.supervisorStopApi) {
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
  const designStatusMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/design\/status$/,
  );
  if (request.method === "GET" && designStatusMatch) {
    const routeRunId = decodeURIComponent(designStatusMatch[1]);
    if (!input.designStatus) {
      return Response.json(
        { error: "dashboard design status is not configured" },
        { status: 404 },
      );
    }
    let snapshot: DashboardDesignStatusSummary | null;
    try {
      snapshot = input.designStatus(routeRunId);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
    if (!snapshot) {
      return Response.json(
        { error: "no active project charter configured for this run" },
        { status: 404 },
      );
    }
    return Response.json(snapshot);
  }
  const linearIntakeMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/linear-intake$/,
  );
  if (request.method === "GET" && linearIntakeMatch) {
    const routeRunId = decodeURIComponent(linearIntakeMatch[1]);
    if (!input.linearIntake) {
      return Response.json(
        { error: "dashboard linear intake is not configured" },
        { status: 404 },
      );
    }
    let snapshot: DashboardLinearIntakeLifecycle | null;
    try {
      snapshot = await input.linearIntake(routeRunId);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
    if (!snapshot) {
      return Response.json(
        { error: "linear intake is not configured for this run" },
        { status: 404 },
      );
    }
    return Response.json(snapshot);
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

let dashboardCssSourceCache: string | null = null;
let dashboardCssCache: Promise<string> | null = null;
let canvasScriptCache: Promise<string> | null = null;
let canvasCssCache: Promise<string> | null = null;

export function dashboardCssSourceForTest() {
  dashboardCssSourceCache ??= readFileSync(DASHBOARD_CSS_PATH, "utf8");
  return dashboardCssSourceCache;
}

function bundledDashboardCss() {
  dashboardCssCache ??= buildDashboardCss();
  return dashboardCssCache;
}

async function buildDashboardCss() {
  const cssSource = dashboardCssSourceForTest();
  if (!dashboardCssCompilerAvailable()) {
    return dashboardCssFallback(cssSource);
  }
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ default: unknown }>;
    const [{ default: postcss }, tailwindModule] = await Promise.all([
      dynamicImport("postcss"),
      dynamicImport("@tailwindcss/postcss"),
    ]);
    const processor = postcss as (plugins: unknown[]) => { process: (css: string, options: { from: string }) => Promise<{ css: string }> };
    const result = await processor([tailwindModule.default]).process(cssSource, {
      from: DASHBOARD_CSS_PATH,
    });
    return result.css;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Cannot find package") || error.message.includes("Cannot find module"))) {
      return dashboardCssFallback(cssSource);
    }
    throw error;
  }
}

function dashboardCssCompilerAvailable() {
  try {
    import.meta.resolve("postcss");
    import.meta.resolve("@tailwindcss/postcss");
    return true;
  } catch {
    return false;
  }
}

function dashboardCssFallback(cssSource: string) {
  return cssSource
    .replace(/^@import "tailwindcss";\n\n/, "")
    .replace(/@theme \{[\s\S]*?\}\n\n/, "");
}

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
  width: 100%;
  height: 100%;
  font-family: "Aptos", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}

.react-flow__renderer,
.react-flow__viewport {
  min-width: 0;
  min-height: 0;
}
`;
}
