import { createHash } from "node:crypto";
import { Harness } from "./harness";
import type {
  AttemptOutput,
  ControlPlaneWatchdogCanary,
  ControlPlaneWatchdogFaultClassification,
  ControlPlaneWatchdogHistoryEntry,
  ControlPlaneWatchdogRecoveryStage,
  ControlPlaneWatchdogState,
  ControlPlaneWatchdogStateKind,
  ExecutionThread,
  Run,
  RunOverview,
  Task,
} from "./types";

export const WATCHDOG_STATE_VERSION = 1;
export const WATCHDOG_STALL_TICK_THRESHOLD = 3;
export const WATCHDOG_STALL_MIN_INTERVAL_MS = 60_000;
export const WATCHDOG_COOLDOWN_MS = 15 * 60_000;
export const WATCHDOG_CANARY_WINDOW_TICKS = 2;
export const WATCHDOG_FRESH_HEARTBEAT_MS = 90_000;
export const WATCHDOG_HISTORY_LIMIT = 20;
export const WATCHDOG_RECONCILE_LEASE_MS = 5 * 60_000;

export interface SelfImprovementQuiescence {
  version: 1;
  assessmentFingerprint: string;
  sourceRunId: string;
  sourceTaskId: string;
  sourceAttemptId: string;
  summary: string;
  decidedAt: string;
  nextWakeAt: string;
  evidence: string[];
}

export interface WatchdogThreadInput {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  role: string;
  status: ExecutionThread["status"];
  agentSessionId: string | null;
  heartbeatAt?: string | null;
}

export interface WatchdogFingerprintInputs {
  runs: Array<Pick<Run, "id" | "status" | "goal">>;
  rootRunId: string;
  tasks: Array<Pick<Task, "id" | "runId" | "status" | "role" | "goal" | "cycleId" | "parentId">>;
  attempts: Array<{
    taskId: string;
    attemptId: string;
    status: string;
    runDecision: string | null;
    summary: string;
  }>;
  threads: WatchdogThreadInput[];
  integrations: Array<{
    workerTaskId: string;
    verifierTaskId: string;
    integratedAt: string | null;
  }>;
  actionEventIds: string[];
}

export interface WatchdogSnapshotInput {
  rootRunId: string;
  rootRun: Run | null;
  overview: RunOverview;
  harness: Harness;
  now: number;
  daemonIntervalMs: number;
  inboxEvents: Array<{ id: string; status: string; provider: string; eventType: string }>;
  scheduledReviews: Array<{ runId: string; reviewAt: string | null }>;
}

export interface WatchdogEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface WatchdogObservationSnapshot {
  fingerprint: string;
  eligibility: WatchdogEligibility;
  fault: ControlPlaneWatchdogFaultClassification | null;
  affectedRunIds: string[];
}

interface SupervisedTreeSnapshot {
  runs: Run[];
  tasks: Task[];
  sessions: RunOverview["sessions"];
  threads: ExecutionThread[];
  integratedWorkerTaskIds: Set<string>;
}

/**
 * Build a deterministic canonical snapshot string from the meaningful parts of
 * the supervised descendant tree. The fingerprint ignores row iteration order,
 * watchdog audit context, timestamps that change without work, and
 * heartbeat-only events. Only meaningful run, task, attempt, thread,
 * integration, and non-watchdog action changes alter the fingerprint.
 */
export function buildWatchdogFingerprint(input: WatchdogFingerprintInputs): string {
  const runLines = [...input.runs]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((run) => `${run.id}:${run.status}:${clamp(run.goal)}`);
  const taskLines = [...input.tasks]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((task) => `${task.id}:${task.runId}:${task.status}:${task.role}:${task.cycleId}:${task.parentId ?? ""}:${clamp(task.goal)}`);
  const attemptLines = [...input.attempts]
    .sort((left, right) =>
      left.taskId < right.taskId
        ? -1
        : left.taskId > right.taskId
          ? 1
          : left.attemptId < right.attemptId
            ? -1
            : 1,
    )
    .map((attempt) => `${attempt.taskId}:${attempt.attemptId}:${attempt.status}:${attempt.runDecision ?? ""}`);
  // Threads intentionally exclude heartbeatAt: a heartbeat-only event must
  // never count as meaningful progress or alter the fingerprint.
  const threadLines = [...input.threads]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((thread) => `${thread.id}:${thread.runId}:${thread.taskId ?? ""}:${thread.attemptId ?? ""}:${thread.role}:${thread.status}:${thread.agentSessionId ?? ""}`);
  const integrationLines = [...input.integrations]
    .sort((left, right) =>
      left.workerTaskId < right.workerTaskId ? -1 : left.workerTaskId > right.workerTaskId ? 1 : 0,
    )
    .map((integration) => `${integration.workerTaskId}:${integration.verifierTaskId}`);
  const actionLines = [...input.actionEventIds].sort().map((id) => id);

  const payload = JSON.stringify({
    runs: runLines,
    tasks: taskLines,
    attempts: attemptLines,
    threads: threadLines,
    integrations: integrationLines,
    actions: actionLines,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Enumerate the supervised descendant run tree starting at the root. The
 * descendant set is the root run plus every run reachable through
 * `context.parentRunId` linkage. Returning a deterministic sorted list keeps
 * the fingerprint stable regardless of insertion order.
 */
export function listSupervisedDescendantRuns(harness: Harness, rootRunId: string): Run[] {
  const all = harness.listRuns({ limit: 10_000 });
  const byId = new Map(all.map((run) => [run.id, run]));
  const root = byId.get(rootRunId);
  if (!root) return [];
  const visited = new Set<string>([rootRunId]);
  const queue: string[] = [rootRunId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of all) {
      if (visited.has(candidate.id)) continue;
      if (candidate.context?.source === "watchdog-repair") continue;
      const parent = readParentRunId(candidate);
      if (parent === current) {
        visited.add(candidate.id);
        queue.push(candidate.id);
      }
    }
  }
  const result: Run[] = [];
  for (const id of visited) {
    const run = byId.get(id);
    if (run) result.push(run);
  }
  result.sort((left, right) => left.id.localeCompare(right.id));
  return result;
}

function readParentRunId(run: Run): string | null {
  const raw = run.context?.parentRunId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Build a supervised-tree snapshot by aggregating the per-run overview of
 * every descendant. The snapshot is the canonical input to the fingerprint
 * function and the eligibility classifier.
 */
export function buildSupervisedTreeSnapshot(harness: Harness, rootRunId: string): SupervisedTreeSnapshot {
  const runs = listSupervisedDescendantRuns(harness, rootRunId);
  const tasks: Task[] = [];
  const sessions: RunOverview["sessions"] = [];
  const threads: ExecutionThread[] = [];
  const integratedWorkerTaskIds = new Set<string>();
  for (const run of runs) {
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
    for (const task of overview.tasks) tasks.push(task);
    for (const session of overview.sessions) sessions.push(session);
    for (const thread of overview.threads) threads.push(thread);
    for (const taskId of collectIntegratedWorkerTaskIds(harness, run.id)) {
      integratedWorkerTaskIds.add(taskId);
    }
  }
  return { runs, tasks, sessions, threads, integratedWorkerTaskIds };
}

/**
 * Determine whether the watchdog should observe this tick. Eligibility requires
 * expected work and excludes paused trees, human checkpoints, intentional
 * quiescence, future scheduled outcome reviews or Linear polls, fresh
 * running-attempt heartbeats, and drained terminal trees.
 */
export function computeWatchdogEligibility(input: {
  rootRunId: string;
  rootRun: Run | null;
  runs: Run[];
  tasks: WatchdogFingerprintInputs["tasks"];
  threads: WatchdogThreadInput[];
  attempts: WatchdogFingerprintInputs["attempts"];
  inboxEvents: WatchdogSnapshotInput["inboxEvents"];
  scheduledReviews: WatchdogSnapshotInput["scheduledReviews"];
  now: number;
}): WatchdogEligibility {
  const { rootRun, runs, tasks, threads, attempts, inboxEvents, scheduledReviews, now } = input;
  if (!rootRun) {
    return { eligible: false, reasons: ["root-run-missing"] };
  }
  if (isActiveRunPause(rootRun.context.runPause)) {
    return { eligible: false, reasons: ["run-paused"] };
  }
  if (hasHumanCheckpoint(rootRun.context)) {
    return { eligible: false, reasons: ["human-checkpoint"] };
  }
  const nonTerminalRuns = runs.filter((run) => run.status !== "done" && run.status !== "blocked");
  const activeTasks = tasks.filter((task) => task.status === "todo" || task.status === "running");
  const durableFutureWake = hasFutureSelfImprovementWake(rootRun.context, now);
  const terminalContinuousRootWithoutWake =
    nonTerminalRuns.length === 0
    && activeTasks.length === 0
    && isContinuousSelfImprovementRoot(rootRun)
    && !durableFutureWake;
  if (
    hasFutureScheduledReview(scheduledReviews, now)
    && !terminalContinuousRootWithoutWake
    && !durableFutureWake
  ) {
    return { eligible: false, reasons: ["scheduled-review-pending"] };
  }
  if (hasPendingLinearIntake(inboxEvents)) {
    return { eligible: false, reasons: ["linear-intake-pending"] };
  }
  if (attempts.some((attempt) => attempt.status === "running")) {
    return { eligible: false, reasons: ["running-attempt"] };
  }
  if (threads.some((thread) => thread.status === "running" && isFreshHeartbeat(now, thread.heartbeatAt))) {
    return { eligible: false, reasons: ["fresh-heartbeat"] };
  }
  // Expected work: any nonterminal run in the supervised descendant tree.
  // This intentionally includes empty nonterminal PAN-1223 fixtures while
  // excluding drained terminal trees.
  if (
    nonTerminalRuns.length === 0
    && activeTasks.length === 0
    && durableFutureWake
  ) {
    return { eligible: false, reasons: ["intentionally-quiescent"] };
  }
  if (nonTerminalRuns.length === 0) {
    if (isContinuousSelfImprovementRoot(rootRun)) {
      return { eligible: true, reasons: ["terminal-evolution-without-wake"] };
    }
    return { eligible: false, reasons: ["drained-terminal"] };
  }
  return { eligible: true, reasons: [] };
}

function isFreshHeartbeat(now: number, heartbeatAt: string | null | undefined): boolean {
  if (typeof heartbeatAt !== "string" || heartbeatAt.length === 0) {
    return true;
  }
  const normalized = heartbeatAt.endsWith("Z") ? heartbeatAt : `${heartbeatAt}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return now - parsed <= WATCHDOG_FRESH_HEARTBEAT_MS;
}

function isActiveRunPause(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasHumanCheckpoint(context: Record<string, unknown>): boolean {
  const paused = context.pauseForHumanReason;
  if (typeof paused === "string" && paused.length > 0) {
    return true;
  }
  const pendingHuman = context.pendingHumanApprovals;
  if (Array.isArray(pendingHuman) && pendingHuman.length > 0) {
    return true;
  }
  return false;
}

export function readSelfImprovementQuiescence(
  context: Record<string, unknown>,
): SelfImprovementQuiescence | null {
  const selfImprovement = context.selfImprovement;
  if (!selfImprovement || typeof selfImprovement !== "object" || Array.isArray(selfImprovement)) return null;
  const record = selfImprovement as Record<string, unknown>;
  const raw = record.quiescence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || record.quiescent !== true) {
    return null;
  }
  const quiescence = raw as Record<string, unknown>;
  const assessmentFingerprint = quiescence.assessmentFingerprint;
  const sourceRunId = quiescence.sourceRunId;
  const sourceTaskId = quiescence.sourceTaskId;
  const sourceAttemptId = quiescence.sourceAttemptId;
  const summary = quiescence.summary;
  const decidedAt = quiescence.decidedAt;
  const nextWakeAt = quiescence.nextWakeAt;
  const evidence = quiescence.evidence;
  if (
    quiescence.version !== 1
    || typeof assessmentFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(assessmentFingerprint)
    || assessmentFingerprint !== record.assessmentFingerprint
    || typeof sourceRunId !== "string" || sourceRunId.length === 0
    || typeof sourceTaskId !== "string" || sourceTaskId.length === 0
    || typeof sourceAttemptId !== "string" || sourceAttemptId.length === 0
    || typeof summary !== "string" || summary.trim().length === 0
    || typeof decidedAt !== "string" || !isStrictUtcIso(decidedAt)
    || typeof nextWakeAt !== "string" || !isStrictUtcIso(nextWakeAt)
    || Date.parse(nextWakeAt) <= Date.parse(decidedAt)
    || !Array.isArray(evidence) || evidence.length === 0
    || evidence.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    return null;
  }
  return {
    version: 1,
    assessmentFingerprint,
    sourceRunId,
    sourceTaskId,
    sourceAttemptId,
    summary,
    decidedAt,
    nextWakeAt,
    evidence: evidence as string[],
  };
}

function hasFutureSelfImprovementWake(context: Record<string, unknown>, now: number): boolean {
  const quiescence = readSelfImprovementQuiescence(context);
  return quiescence !== null && Date.parse(quiescence.nextWakeAt) > now;
}

function isContinuousSelfImprovementRoot(run: Run): boolean {
  return run.context.source === "self-improve";
}

function isStrictUtcIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hasFutureScheduledReview(
  reviews: WatchdogSnapshotInput["scheduledReviews"],
  now: number,
): boolean {
  for (const review of reviews) {
    if (!review.reviewAt) continue;
    const normalized = review.reviewAt.endsWith("Z") ? review.reviewAt : `${review.reviewAt}Z`;
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed) && parsed > now) {
      return true;
    }
  }
  return false;
}

function hasPendingLinearIntake(
  inboxEvents: WatchdogSnapshotInput["inboxEvents"],
): boolean {
  return inboxEvents.some((event) => event.status === "todo" || event.status === "running");
}

function clamp(value: string): string {
  if (!value) return "";
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}

/**
 * Inspect the supervised descendant tree, build its canonical fingerprint,
 * evaluate eligibility, and classify the most specific fixed-recovery fault if
 * the tree has expected work but is not making progress.
 */
export function observeWatchdogTree(input: WatchdogSnapshotInput): WatchdogObservationSnapshot {
  const { harness, rootRunId, rootRun, now, inboxEvents, scheduledReviews } = input;
  const snapshot = buildSupervisedTreeSnapshot(harness, rootRunId);

  const runs: WatchdogFingerprintInputs["runs"] = snapshot.runs.map((run) => ({
    id: run.id,
    status: run.status,
    goal: run.goal,
  }));

  const taskRows: WatchdogFingerprintInputs["tasks"] = snapshot.tasks.map((task) => ({
    id: task.id,
    runId: task.runId,
    status: task.status,
    role: task.role,
    goal: task.goal,
    cycleId: task.cycleId,
    parentId: task.parentId,
  }));

  const attemptRows: WatchdogFingerprintInputs["attempts"] = snapshot.sessions.map((session) => ({
    taskId: session.taskId,
    attemptId: session.attemptId,
    status: session.status,
    runDecision: typeof session.output.runDecision === "string" ? session.output.runDecision : null,
    summary: typeof session.output.summary === "string" ? session.output.summary : "",
  }));

  const threadRows: WatchdogThreadInput[] = snapshot.threads.map((thread) => ({
    id: thread.id,
    runId: thread.runId,
    taskId: thread.taskId,
    attemptId: thread.attemptId,
    role: thread.role,
    status: thread.status,
    agentSessionId: thread.agentSessionId,
    heartbeatAt: thread.heartbeatAt,
  }));

  const unintegratedReadiness = computeUnintegratedWorkers(harness, rootRunId, snapshot);
  const integrationRows: WatchdogFingerprintInputs["integrations"] = unintegratedReadiness.map((worker) => ({
    workerTaskId: worker.taskId,
    verifierTaskId: worker.verifierTaskId,
    integratedAt: null,
  }));

  const scopedRunIds = new Set(snapshot.runs.map((run) => run.id));
  const recentActionIds = harness
    .listHarnessActionEventsForRunIds([...scopedRunIds])
    .filter((event) => !isWatchdogCoordinationEvent(event))
    .filter((event) => actionEventBelongsToTree(event, scopedRunIds))
    .map((event) => event.id)
    .sort((left, right) => left.localeCompare(right));

  const fingerprint = buildWatchdogFingerprint({
    runs,
    rootRunId,
    tasks: taskRows,
    attempts: attemptRows,
    threads: threadRows,
    integrations: integrationRows,
    actionEventIds: recentActionIds,
  });

  const eligibility = computeWatchdogEligibility({
    rootRunId,
    rootRun,
    runs: snapshot.runs,
    tasks: taskRows,
    attempts: attemptRows,
    threads: threadRows,
    inboxEvents,
    scheduledReviews,
    now,
  });

  const fault = classifyFault({
    runs: snapshot.runs,
    tasks: snapshot.tasks,
    sessions: snapshot.sessions,
    threads: snapshot.threads,
    harness,
    rootRunId,
    readiness: unintegratedReadiness,
  });

  return {
    fingerprint,
    eligibility,
    fault: fault.classification,
    affectedRunIds: fault.affectedRunIds,
  };
}

function isWatchdogCoordinationEvent(event: { actionType: string; request: unknown }): boolean {
  if (event.actionType === "runWatchdogPass") return true;
  const request = event.request as Record<string, unknown> | null;
  if (!request || typeof request !== "object") return false;
  if (
    typeof request.reason === "string" &&
    request.reason.startsWith("watchdog reconcile ")
  ) {
    return true;
  }
  return event.actionType === "completeSystemTask" &&
    typeof request.taskId === "string" &&
    request.taskId.startsWith("task_watchdog_repair_");
}

function actionEventBelongsToTree(
  event: { request: unknown; result: unknown },
  scopedRunIds: Set<string>,
): boolean {
  const request = event.request as Record<string, unknown> | null;
  if (request && typeof request === "object") {
    const runId = request.runId;
    if (typeof runId === "string" && scopedRunIds.has(runId)) {
      return true;
    }
    const rootRunId = request.rootRunId;
    if (typeof rootRunId === "string" && scopedRunIds.has(rootRunId)) {
      return true;
    }
  }
  const result = event.result as Record<string, unknown> | null;
  if (result && typeof result === "object") {
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const record = artifact as Record<string, unknown>;
      const runId = record.runId;
      if (typeof runId === "string" && scopedRunIds.has(runId)) {
        return true;
      }
    }
  }
  return false;
}

function classifyFault(input: {
  runs: Run[];
  tasks: Task[];
  sessions: RunOverview["sessions"];
  threads: ExecutionThread[];
  harness: Harness;
  rootRunId: string;
  readiness: Array<{ runId: string; taskId: string; verifierTaskId: string }>;
}): {
  classification: ControlPlaneWatchdogFaultClassification | null;
  affectedRunIds: string[];
} {
  const { runs, tasks, sessions, threads, rootRunId, readiness } = input;

  const orphanedLeases: Array<{ runId: string; taskId: string }> = [];
  for (const run of runs) {
    if (run.status === "done" || run.status === "blocked") continue;
    const runTasks = tasks.filter((task) => task.runId === run.id && task.status === "running");
    for (const task of runTasks) {
      const hasRunningAttempt = sessions.some(
        (session) => session.taskId === task.id && session.status === "running",
      );
      const hasRunningThread = threads.some(
        (thread) => thread.taskId === task.id && thread.status === "running",
      );
      if (!hasRunningAttempt && !hasRunningThread) {
        orphanedLeases.push({ runId: run.id, taskId: task.id });
      }
    }
  }

  const unintegratedWorkers = readiness.map((worker) => ({
    runId: worker.runId,
    taskId: worker.taskId,
    verifierTaskId: worker.verifierTaskId,
  }));

  const emptyNonTerminalRuns: Array<{ runId: string }> = [];
  for (const run of runs) {
    if (run.status === "done" || run.status === "blocked") continue;
    const runTasks = tasks.filter((task) => task.runId === run.id);
    const hasActive = runTasks.some((task) => task.status === "todo" || task.status === "running");
    if (!hasActive) {
      emptyNonTerminalRuns.push({ runId: run.id });
    }
  }

  const allRunIds = new Set<string>();
  for (const item of [...orphanedLeases, ...unintegratedWorkers, ...emptyNonTerminalRuns]) {
    allRunIds.add(item.runId);
  }

  if (orphanedLeases.length > 0) {
    return {
      classification: {
        kind: "orphaned-leases",
        affectedRunIds: [...new Set(orphanedLeases.map((lease) => lease.runId))],
        selectedAction: "reclaimRunningTasks",
        details: `${orphanedLeases.length} orphaned lease(s): ${orphanedLeases.map((lease) => lease.taskId).join(",")}`,
      },
      affectedRunIds: [...allRunIds],
    };
  }

  if (unintegratedWorkers.length > 0) {
    return {
      classification: {
        kind: "unintegrated-verified",
        affectedRunIds: [...new Set(unintegratedWorkers.map((worker) => worker.runId))],
        selectedAction: "integrateVerifiedRun",
        details: `${unintegratedWorkers.length} unintegrated verified worker(s): ${unintegratedWorkers.map((worker) => worker.taskId).join(",")}`,
      },
      affectedRunIds: [...allRunIds],
    };
  }

  if (emptyNonTerminalRuns.length > 0) {
    return {
      classification: {
        kind: "empty-nonterminal-run",
        affectedRunIds: emptyNonTerminalRuns.map((entry) => entry.runId),
        selectedAction: "prepareRunDrain",
        details: `Empty non-terminal run(s): ${emptyNonTerminalRuns.map((entry) => entry.runId).join(",")}`,
      },
      affectedRunIds: [...allRunIds],
    };
  }

  const rootRun = runs.find((run) => run.id === rootRunId);
  if (
    rootRun?.context.source === "self-improve"
    && runs.every((run) => run.status === "done" || run.status === "blocked")
  ) {
    return {
      classification: {
        kind: "terminal-evolution-stall",
        affectedRunIds: [rootRunId],
        selectedAction: "none",
        details: "Continuous self-improvement is terminal without a durable future wake",
      },
      affectedRunIds: [rootRunId],
    };
  }

  // Fingerprint is unchanged but no classified fixed-action fault exists. The
  // watchdog cannot dispatch a deterministic fixed recovery for this class; it
  // must converge to an evidenced blocked state if the stall persists.
  return {
    classification: {
      kind: "unsupported",
      affectedRunIds: [...allRunIds, rootRunId],
      selectedAction: "none",
      details: "No fixed-action recovery available for this fingerprint",
    },
    affectedRunIds: [...allRunIds, rootRunId],
  };
}

/**
 * Read existing watchdog state from the root run context, or return null.
 */
export function readWatchdogState(context: Record<string, unknown>): ControlPlaneWatchdogState | null {
  const raw = context.controlPlaneWatchdog;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.state !== "string" || typeof record.version !== "number") {
    return null;
  }
  return normalizeWatchdogState(record as unknown as ControlPlaneWatchdogState);
}

/**
 * Compute unintegrated verified workers across the supervised descendant tree.
 * Mirrors the criteria in actions.ts `describeIntegrationReadiness` without
 * importing it, so the watchdog module stays free of the actions.ts circular
 * import.
 */
function computeUnintegratedWorkers(
  harness: Harness,
  rootRunId: string,
  snapshot: SupervisedTreeSnapshot,
): Array<{ runId: string; taskId: string; verifierTaskId: string }> {
  const result: Array<{ runId: string; taskId: string; verifierTaskId: string }> = [];
  const overviewAggregate: RunOverview = {
    run: null,
    project: null,
    tasks: snapshot.tasks,
    sessions: snapshot.sessions,
    threads: snapshot.threads,
    lessons: [],
  };
  for (const run of snapshot.runs) {
    if (run.status === "done" || run.status === "blocked") continue;
    const overview: RunOverview = {
      ...overviewAggregate,
      run,
    };
    const integratedWorkerTaskIds = collectIntegratedWorkerTaskIdsForRun(harness, run.id);
    const runOverview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
    for (const task of runOverview.tasks) {
      if (["planner", "verifier", "goal-review"].includes(task.role)) continue;
      if (task.status !== "done" || !task.worktreePath) continue;
      if (integratedWorkerTaskIds.has(task.id)) continue;
      if (snapshot.integratedWorkerTaskIds.has(task.id)) continue;
      const session = latestSessionForTask(runOverview, task.id);
      const changedFiles = Array.isArray(session?.output?.changedFiles)
        ? (session!.output.changedFiles as unknown[])
        : [];
      if (changedFiles.length === 0) continue;
      const verifier = selectVerifierForWorker(runOverview, task.id);
      if (!verifier) continue;
      result.push({ runId: run.id, taskId: task.id, verifierTaskId: verifier.id });
    }
  }
  return result;
}

function collectIntegratedWorkerTaskIds(harness: Harness, runId: string): Set<string> {
  return collectIntegratedWorkerTaskIdsForRun(harness, runId);
}

function collectIntegratedWorkerTaskIdsForRun(harness: Harness, runId: string): Set<string> {
  const ids = new Set<string>();
  for (const event of harness.listHarnessActionEvents({ limit: 500 })) {
    if (event.actionType !== "integrateVerifiedRun" || event.status !== "done") continue;
    const request = event.request as Record<string, unknown>;
    if (request.runId !== runId || typeof request.workerTaskId !== "string") continue;
    const result = event.result as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const integratedIds = artifacts.flatMap((artifact) => {
      if (!artifact || typeof artifact !== "object") return [];
      const record = artifact as Record<string, unknown>;
      if (record.kind !== "integration" || typeof record.workerTaskId !== "string") return [];
      return [record.workerTaskId];
    });
    if (integratedIds.length > 0) {
      ids.add(request.workerTaskId);
    }
    for (const id of integratedIds) {
      ids.add(id);
    }
    if (integratedIds.length === 0) {
      ids.add(request.workerTaskId);
    }
  }
  return ids;
}

function latestSessionForTask(overview: RunOverview, taskId: string) {
  return (
    [...overview.sessions].reverse().find((session) => session.taskId === taskId && session.status === "done") ?? null
  );
}

function selectVerifierForWorker(overview: RunOverview, workerTaskId: string): Task | null {
  return (
    [...overview.tasks].reverse().find((task) => {
      if (task.role !== "verifier" || task.status !== "done" || !task.dependsOn.includes(workerTaskId)) {
        return false;
      }
      const session = latestSessionForTask(overview, task.id);
      if (!session) return false;
      const checks = Array.isArray(session.output.checks) ? session.output.checks : [];
      return !checks.some(isFailedCheck);
    }) ?? null
  );
}

function isFailedCheck(check: unknown) {
  return Boolean(
    check && typeof check === "object" && "status" in check && (check as { status?: unknown }).status === "failed",
  );
}

export function normalizeWatchdogState(value: ControlPlaneWatchdogState): ControlPlaneWatchdogState {
  return {
    version: WATCHDOG_STATE_VERSION,
    state: value.state,
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : null,
    firstSeenAt: typeof value.firstSeenAt === "string" ? value.firstSeenAt : null,
    unchangedEligibleTicks: Number.isFinite(value.unchangedEligibleTicks)
      ? Math.max(0, Math.floor(value.unchangedEligibleTicks))
      : 0,
    lastMeaningfulProgressAt:
      typeof value.lastMeaningfulProgressAt === "string" ? value.lastMeaningfulProgressAt : null,
    lastObservationAt: typeof value.lastObservationAt === "string" ? value.lastObservationAt : null,
    recoveryStage: value.recoveryStage ?? "none",
    repairFingerprint: typeof value.repairFingerprint === "string" ? value.repairFingerprint : null,
    repairRunId: typeof value.repairRunId === "string" ? value.repairRunId : null,
    repairTaskId: typeof value.repairTaskId === "string" ? value.repairTaskId : null,
    actionEventIds: Array.isArray(value.actionEventIds)
      ? value.actionEventIds.filter((id): id is string => typeof id === "string")
      : [],
    attemptCount: Number.isFinite(value.attemptCount)
      ? Math.max(0, Math.floor(value.attemptCount))
      : 0,
    cooldownUntil: typeof value.cooldownUntil === "string" ? value.cooldownUntil : null,
    affectedRunIds: Array.isArray(value.affectedRunIds)
      ? value.affectedRunIds.filter((id): id is string => typeof id === "string")
      : [],
    fault: value.fault ?? null,
    canary: normalizeCanary(value.canary),
    failure: value.failure ?? null,
    reconcileClaim:
      value.reconcileClaim &&
      typeof value.reconcileClaim.fingerprint === "string" &&
      typeof value.reconcileClaim.ownerId === "string" &&
      typeof value.reconcileClaim.actionType === "string" &&
      typeof value.reconcileClaim.targetRunId === "string" &&
      typeof value.reconcileClaim.actionEventId === "string" &&
      typeof value.reconcileClaim.claimedAt === "string" &&
      typeof value.reconcileClaim.leaseUntil === "string"
        ? value.reconcileClaim
        : null,
    history: Array.isArray(value.history) ? value.history.slice(-WATCHDOG_HISTORY_LIMIT) : [],
  };
}

function normalizeCanary(value: ControlPlaneWatchdogState["canary"] | undefined): ControlPlaneWatchdogCanary {
  const fallback: ControlPlaneWatchdogCanary = {
    status: "none",
    observedAt: null,
    fingerprint: null,
    evidence: [],
    ticksInCanary: 0,
  };
  if (!value || typeof value !== "object") return fallback;
  return {
    status: value.status ?? "none",
    observedAt: typeof value.observedAt === "string" ? value.observedAt : null,
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : null,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string")
      : [],
    ticksInCanary:
      typeof value.ticksInCanary === "number" && Number.isFinite(value.ticksInCanary)
        ? Math.max(0, Math.floor(value.ticksInCanary))
        : 0,
  };
}

/**
 * Compute the next watchdog state given the observation and the prior state.
 * The transition is a pure function; persistence and reconciliation are the
 * caller's responsibility. All timestamps derive from the injected `now`, so
 * the transition is fully deterministic under a fake clock.
 *
 * Frozen sequence: healthy -> suspect -> stalled/reconciling (no dispatch) ->
 * repairing (single fixed-action dispatch on the next eligible unchanged
 * tick) -> canary -> recovered | blocked.
 */
export function transitionWatchdogState(input: {
  previous: ControlPlaneWatchdogState | null;
  observation: WatchdogObservationSnapshot;
  now: number;
  daemonIntervalMs: number;
}): {
  nextState: ControlPlaneWatchdogState;
  transition: WatchdogTransition;
} {
  const { observation, now, daemonIntervalMs } = input;
  const previous = input.previous ? normalizeWatchdogState(input.previous) : null;
  const isoNow = new Date(now).toISOString();
  const stallMinInterval = Math.max(WATCHDOG_STALL_MIN_INTERVAL_MS, daemonIntervalMs * 2);

  const previousFingerprint = previous?.fingerprint ?? null;
  const unchangedFromPrevious =
    previousFingerprint !== null && previousFingerprint === observation.fingerprint;
  const meaningfulChange = !unchangedFromPrevious;
  const eligible = observation.eligibility.eligible;
  const progressingCanary = previous?.canary?.status === "progressing";

  // Reset path: ineligibility always returns the watchdog to healthy with no
  // recovery work. Heartbeat-only events and watchdog writes never count as
  // meaningful progress; the fingerprint already excludes them.
  if (!eligible) {
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "healthy",
      fingerprint: observation.fingerprint,
      firstSeenAt: null,
      unchangedEligibleTicks: 0,
      lastMeaningfulProgressAt: previous?.lastMeaningfulProgressAt ?? isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "none",
      repairFingerprint: null,
      repairRunId: null,
      repairTaskId: null,
      actionEventIds: [],
      attemptCount: 0,
      cooldownUntil: null,
      affectedRunIds: [],
      fault: null,
      canary: emptyCanary(),
      failure: null,
      history: appendHistory(previous?.history ?? [], "healthy", observation.fingerprint, "none", "not eligible", isoNow),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  // Blocked state: stay blocked unless the fingerprint changes (which resets
  // suspicion and permits a new bounded recovery) or the run becomes
  // ineligible (handled above).
  if (previous?.state === "blocked") {
    if (meaningfulChange) {
      const nextState: ControlPlaneWatchdogState = {
        version: WATCHDOG_STATE_VERSION,
        state: "healthy",
        fingerprint: observation.fingerprint,
        firstSeenAt: isoNow,
        unchangedEligibleTicks: 0,
        lastMeaningfulProgressAt: isoNow,
        lastObservationAt: isoNow,
        recoveryStage: "none",
        repairFingerprint: null,
        repairRunId: null,
        repairTaskId: null,
        actionEventIds: [],
        attemptCount: previous.attemptCount,
        cooldownUntil: null,
        affectedRunIds: [],
        fault: null,
        canary: emptyCanary(),
        failure: null,
        history: appendHistory(previous.history, "healthy", observation.fingerprint, "none", "fingerprint changed after blocked", isoNow),
      };
      return { nextState, transition: { kind: "observe" } };
    }
    const nextState: ControlPlaneWatchdogState = {
      ...previous,
      fingerprint: observation.fingerprint,
      lastObservationAt: isoNow,
      affectedRunIds: observation.affectedRunIds,
      fault: observation.fault,
      history: appendHistory(
        previous.history,
        "blocked",
        observation.fingerprint,
        "blocked",
        "blocked tick observed",
        isoNow,
      ),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  // Meaningful progress while a canary is in flight consumes one canary slot.
  // The recovery completes once the canary window accumulates enough
  // continued progress events.
  if (meaningfulChange && progressingCanary && previous) {
    const advancedProgress = previous.canary.evidence.length + 1;
    const canaryComplete = advancedProgress >= WATCHDOG_CANARY_WINDOW_TICKS;
    const nextState: ControlPlaneWatchdogState = {
      ...previous,
      version: WATCHDOG_STATE_VERSION,
      state: canaryComplete ? "recovered" : "canary",
      fingerprint: observation.fingerprint,
      unchangedEligibleTicks: 0,
      lastMeaningfulProgressAt: isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "canary",
      cooldownUntil: null,
      affectedRunIds: observation.affectedRunIds,
      fault: null,
      canary: {
        status: "progressing",
        observedAt: previous.canary.observedAt,
        fingerprint: observation.fingerprint,
        evidence: [...previous.canary.evidence, `progress ${advancedProgress} at ${isoNow}`],
        ticksInCanary: 0,
      },
      failure: null,
      history: appendHistory(
        previous.history,
        canaryComplete ? "recovered" : "canary",
        observation.fingerprint,
        "canary",
        canaryComplete ? "canary progress window satisfied" : "canary progress observed",
        isoNow,
      ),
    };
    return {
      nextState,
      transition: canaryComplete ? { kind: "canary" } : { kind: "observe" },
    };
  }

  // Meaningful change observed while in `reconciling` with persisted action
  // evidence: the reconcile's fixed action took effect (e.g.,
  // prepareRunDrain created a goal-review task). The frozen contract still
  // requires exactly one linked repair run per supported fault fingerprint,
  // so we skip the generic meaningful-change reset and proceed to the
  // repair transition. The post-repair canary then determines whether the
  // recovery is durable.
  if (
    meaningfulChange &&
    previous?.state === "reconciling" &&
    previous?.actionEventIds.length > 0
  ) {
    const unchangedTicks = previous.unchangedEligibleTicks + 1;
    const repairFingerprint = previous.fingerprint ?? observation.fingerprint;
    const attemptCount = previous.attemptCount + 1;
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "repairing",
      fingerprint: observation.fingerprint,
      firstSeenAt: previous.firstSeenAt ?? isoNow,
      unchangedEligibleTicks: unchangedTicks,
      lastMeaningfulProgressAt: isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "repair-run",
      repairFingerprint,
      repairRunId: previous.repairRunId,
      repairTaskId: previous.repairTaskId,
      actionEventIds: previous.actionEventIds,
      attemptCount,
      cooldownUntil: null,
      affectedRunIds: observation.affectedRunIds,
      fault: previous.fault ?? observation.fault,
      canary: {
        status: "pending",
        observedAt: isoNow,
        fingerprint: observation.fingerprint,
        evidence: [],
        ticksInCanary: 0,
      },
      failure: null,
      history: appendHistory(
        previous.history,
        "repairing",
        observation.fingerprint,
        "repair-run",
        "repair dispatched after reconcile progress",
        isoNow,
      ),
    };
    const faultClassification =
      previous.fault ?? observation.fault ?? unsupportedFault(observation.affectedRunIds);
    return {
      nextState,
      transition: {
        kind: "repair",
        fault: faultClassification,
      },
    };
  }

  // Any other meaningful change resets suspicion and recovers the watchdog
  // to healthy.
  if (meaningfulChange) {
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "healthy",
      fingerprint: observation.fingerprint,
      firstSeenAt: isoNow,
      unchangedEligibleTicks: 0,
      lastMeaningfulProgressAt: isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "none",
      repairFingerprint: null,
      repairRunId: null,
      repairTaskId: null,
      actionEventIds: [],
      attemptCount: previous?.attemptCount ?? 0,
      cooldownUntil: null,
      affectedRunIds: [],
      fault: null,
      canary: emptyCanary(),
      failure: null,
      history: appendHistory(previous?.history ?? [], "healthy", observation.fingerprint, "none", "meaningful progress", isoNow),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  // Eligible and unchanged.
  const previousUnchangedTicks = previous?.unchangedEligibleTicks ?? 0;
  const unchangedTicks = previousUnchangedTicks + 1;
  const firstSeenAt = previous?.firstSeenAt ?? isoNow;
  const firstSeenMs = Date.parse(firstSeenAt.endsWith("Z") ? firstSeenAt : `${firstSeenAt}Z`);
  const elapsedMs = Number.isFinite(firstSeenMs) ? Math.max(0, now - firstSeenMs) : 0;

  // Progressing canary, unchanged tick: count this canary tick and check
  // whether the window has expired without sufficient continued progress.
  if (progressingCanary && previous) {
    const ticksInCanary = previous.canary.ticksInCanary + 1;
    const progressCount = previous.canary.evidence.length;
    if (
      ticksInCanary >= WATCHDOG_CANARY_WINDOW_TICKS &&
      progressCount < WATCHDOG_CANARY_WINDOW_TICKS
    ) {
      const blocked = blockFromPrevious(
        previous,
        observation,
        isoNow,
        now,
        "canary window expired without continued progress",
      );
      return { nextState: blocked, transition: { kind: "block" } };
    }
    const nextState: ControlPlaneWatchdogState = {
      ...previous,
      fingerprint: observation.fingerprint,
      unchangedEligibleTicks: unchangedTicks,
      lastObservationAt: isoNow,
      lastMeaningfulProgressAt: previous.lastMeaningfulProgressAt,
      affectedRunIds: observation.affectedRunIds,
      fault: observation.fault,
      canary: {
        ...previous.canary,
        ticksInCanary,
      },
      history: appendHistory(
        previous.history,
        previous.state,
        observation.fingerprint,
        previous.recoveryStage,
        "canary unchanged eligible tick",
        isoNow,
      ),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  // Threshold check. Before the threshold is met (count or elapsed time),
  // the watchdog stays in suspect and observes without dispatching.
  const stallThresholdMet =
    unchangedTicks >= WATCHDOG_STALL_TICK_THRESHOLD && elapsedMs >= stallMinInterval;
  if (!stallThresholdMet) {
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "suspect",
      fingerprint: observation.fingerprint,
      firstSeenAt,
      unchangedEligibleTicks: unchangedTicks,
      lastMeaningfulProgressAt: previous?.lastMeaningfulProgressAt ?? isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "none",
      repairFingerprint: null,
      repairRunId: null,
      repairTaskId: null,
      actionEventIds: [],
      attemptCount: previous?.attemptCount ?? 0,
      cooldownUntil: previous?.cooldownUntil ?? null,
      affectedRunIds: observation.affectedRunIds,
      fault: observation.fault,
      canary: emptyCanary(),
      failure: null,
      history: appendHistory(
        previous?.history ?? [],
        "suspect",
        observation.fingerprint,
        "none",
        unchangedTicks >= WATCHDOG_STALL_TICK_THRESHOLD
          ? "stall threshold count reached but min interval not elapsed"
          : unchangedTicks === 1
            ? "first unchanged eligible tick"
            : "unchanged eligible tick before stall",
        isoNow,
      ),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  // Threshold fully met. Honor an in-flight repair and active cooldown before
  // considering a new dispatch.
  const repairFingerprint = observation.fingerprint;
  const sameRepairInFlight =
    previous?.repairFingerprint === repairFingerprint &&
    previous?.repairRunId !== null &&
    (previous?.state === "repairing" || previous?.state === "canary");
  const cooldownActive = isCooldownActive(previous?.cooldownUntil, now);

  if (sameRepairInFlight && previous) {
    const nextState: ControlPlaneWatchdogState = {
      ...previous,
      fingerprint: observation.fingerprint,
      unchangedEligibleTicks: unchangedTicks,
      lastObservationAt: isoNow,
      lastMeaningfulProgressAt: previous.lastMeaningfulProgressAt,
      affectedRunIds: observation.affectedRunIds,
      fault: observation.fault,
      history: appendHistory(
        previous.history,
        previous.state,
        observation.fingerprint,
        previous.recoveryStage,
        "repair already in flight",
        isoNow,
      ),
    };
    if (previous.state === "repairing" && previous.actionEventIds.length > 0) {
      return {
        nextState,
        transition: {
          kind: "repair",
          fault: previous.fault ?? observation.fault ?? unsupportedFault(observation.affectedRunIds),
        },
      };
    }
    return { nextState, transition: { kind: "observe" } };
  }

  if (cooldownActive && previous) {
    const blocked = blockFromPrevious(previous, observation, isoNow, now, "cooldown active after recovery did not progress");
    return { nextState: blocked, transition: { kind: "block" } };
  }

  // Frozen sequence at the threshold:
  //   suspect -> stalled (observe, persisted)
  //   stalled -> reconciling (reconcile transition; dispatches fixed action)
  //   reconciling -> repairing (repair transition; creates linked repair run)
  //   repairing -> canary (canary transition after action sequence recorded)
  //   canary -> recovered|blocked
  const faultClassification = observation.fault ?? unsupportedFault(observation.affectedRunIds);
  const previouslyStalled = previous?.state === "stalled";
  const previouslyReconciling =
    previous?.state === "reconciling" &&
    previous?.actionEventIds.length > 0;

  if (!previouslyStalled && !previouslyReconciling) {
    // First time at the threshold: emit an explicit stalled state. The
    // reconcile action is dispatched on the NEXT eligible unchanged tick,
    // giving observers a deterministic stalled state to surface before any
    // recovery work begins.
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "stalled",
      fingerprint: observation.fingerprint,
      firstSeenAt,
      unchangedEligibleTicks: unchangedTicks,
      lastMeaningfulProgressAt: previous?.lastMeaningfulProgressAt ?? isoNow,
      lastObservationAt: isoNow,
      recoveryStage: stageForFault(faultClassification),
      repairFingerprint: null,
      repairRunId: null,
      repairTaskId: null,
      actionEventIds: previous?.actionEventIds ?? [],
      attemptCount: previous?.attemptCount ?? 0,
      cooldownUntil: previous?.cooldownUntil ?? null,
      affectedRunIds: observation.affectedRunIds,
      fault: faultClassification,
      canary: emptyCanary(),
      failure: null,
      history: appendHistory(
        previous?.history ?? [],
        "stalled",
        observation.fingerprint,
        stageForFault(faultClassification),
        "stall threshold reached",
        isoNow,
      ),
    };
    return { nextState, transition: { kind: "observe" } };
  }

  if (previouslyStalled && !previouslyReconciling) {
    // Stalled on the prior tick: dispatch the fixed-action reconcile and
    // advance to reconciling. The caller persists the reconcile action event
    // id and advances the persisted state to reconciling once the dispatch
    // completes.
    const nextState: ControlPlaneWatchdogState = {
      version: WATCHDOG_STATE_VERSION,
      state: "reconciling",
      fingerprint: observation.fingerprint,
      firstSeenAt,
      unchangedEligibleTicks: unchangedTicks,
      lastMeaningfulProgressAt: previous?.lastMeaningfulProgressAt ?? isoNow,
      lastObservationAt: isoNow,
      recoveryStage: "reconcile",
      repairFingerprint: null,
      repairRunId: null,
      repairTaskId: null,
      actionEventIds: previous?.actionEventIds ?? [],
      attemptCount: previous?.attemptCount ?? 0,
      cooldownUntil: previous?.cooldownUntil ?? null,
      affectedRunIds: observation.affectedRunIds,
      fault: faultClassification,
      canary: emptyCanary(),
      failure: null,
      history: appendHistory(
        previous?.history ?? [],
        "reconciling",
        observation.fingerprint,
        "reconcile",
        "reconcile transition dispatched",
        isoNow,
      ),
    };
    return {
      nextState,
      transition: { kind: "reconcile", fault: faultClassification },
    };
  }

  // Previously reconciling with the fixed-action event persisted: open the
  // bounded repair run for this fingerprint.
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  const nextState: ControlPlaneWatchdogState = {
    version: WATCHDOG_STATE_VERSION,
    state: "repairing",
    fingerprint: observation.fingerprint,
    firstSeenAt,
    unchangedEligibleTicks: unchangedTicks,
    lastMeaningfulProgressAt: previous?.lastMeaningfulProgressAt ?? isoNow,
    lastObservationAt: isoNow,
    recoveryStage: "repair-run",
    repairFingerprint,
    repairRunId: previous?.repairRunId ?? null,
    repairTaskId: previous?.repairTaskId ?? null,
    actionEventIds: previous?.actionEventIds ?? [],
    attemptCount,
    cooldownUntil: null,
    affectedRunIds: observation.affectedRunIds,
    fault: faultClassification,
    canary: {
      status: "pending",
      observedAt: isoNow,
      fingerprint: observation.fingerprint,
      evidence: [],
      ticksInCanary: 0,
    },
    failure: null,
    history: appendHistory(
      previous?.history ?? [],
      "repairing",
      observation.fingerprint,
      "repair-run",
      "repair dispatched after reconcile",
      isoNow,
    ),
  };

  return {
    nextState,
    transition: {
      kind: "repair",
      fault: faultClassification,
    },
  };
}

function emptyCanary(): ControlPlaneWatchdogCanary {
  return { status: "none", observedAt: null, fingerprint: null, evidence: [], ticksInCanary: 0 };
}

function blockFromPrevious(
  previous: ControlPlaneWatchdogState,
  observation: WatchdogObservationSnapshot,
  isoNow: string,
  now: number,
  reason: string,
): ControlPlaneWatchdogState {
  const cooldownUntil = previous.cooldownUntil ?? new Date(now + WATCHDOG_COOLDOWN_MS).toISOString();
  return {
    version: WATCHDOG_STATE_VERSION,
    state: "blocked",
    fingerprint: observation.fingerprint,
    firstSeenAt: previous.firstSeenAt,
    unchangedEligibleTicks: previous.unchangedEligibleTicks,
    lastMeaningfulProgressAt: previous.lastMeaningfulProgressAt,
    lastObservationAt: isoNow,
    recoveryStage: "blocked",
    repairFingerprint: previous.repairFingerprint,
    repairRunId: previous.repairRunId,
    repairTaskId: previous.repairTaskId,
    actionEventIds: previous.actionEventIds,
    attemptCount: previous.attemptCount,
    cooldownUntil,
    affectedRunIds: observation.affectedRunIds,
    fault: observation.fault,
    canary:
      previous.canary.status === "none"
        ? { status: "failed", observedAt: isoNow, fingerprint: observation.fingerprint, evidence: [reason], ticksInCanary: 0 }
        : { ...previous.canary, status: "failed", evidence: [...previous.canary.evidence, reason] },
    failure: previous.failure ?? {
      reason,
      details: [],
      recordedAt: isoNow,
    },
    history: appendHistory(previous.history, "blocked", observation.fingerprint, "blocked", reason, isoNow),
  };
}

function isCooldownActive(cooldownUntil: string | null | undefined, now: number): boolean {
  if (!cooldownUntil) return false;
  const parsed = Date.parse(cooldownUntil.endsWith("Z") ? cooldownUntil : `${cooldownUntil}Z`);
  if (!Number.isFinite(parsed)) return false;
  return parsed > now;
}

function stageForFault(fault: ControlPlaneWatchdogFaultClassification): ControlPlaneWatchdogRecoveryStage {
  switch (fault.selectedAction) {
    case "reclaimRunningTasks":
      return "reclaim-leases";
    case "integrateVerifiedRun":
      return "integrate-verified";
    case "prepareRunDrain":
      return "prepare-run-drain";
    case "none":
    default:
      return "none";
  }
}

function unsupportedFault(affectedRunIds: string[]): ControlPlaneWatchdogFaultClassification {
  return {
    kind: "unsupported",
    affectedRunIds,
    selectedAction: "none",
    details: "No fixed-action recovery available for this fingerprint",
  };
}

function appendHistory(
  history: ControlPlaneWatchdogHistoryEntry[],
  state: ControlPlaneWatchdogStateKind,
  fingerprint: string | null,
  recoveryStage: ControlPlaneWatchdogRecoveryStage,
  reason: string,
  isoNow: string,
): ControlPlaneWatchdogHistoryEntry[] {
  const entry: ControlPlaneWatchdogHistoryEntry = {
    state,
    fingerprint,
    recoveryStage,
    observedAt: isoNow,
    reason,
  };
  const next = [...history, entry];
  return next.slice(-WATCHDOG_HISTORY_LIMIT);
}

export type WatchdogTransition =
  | { kind: "observe" }
  | { kind: "reconcile"; fault: ControlPlaneWatchdogFaultClassification }
  | { kind: "repair"; fault: ControlPlaneWatchdogFaultClassification }
  | { kind: "canary" }
  | { kind: "block" };

/**
 * Deterministic repair identity for a given root run and fingerprint. Used by
 * the atomic transition to reserve a single repair run and repair task per
 * fingerprint across concurrent callers and reopened Harness instances.
 */
export function repairIdentity(rootRunId: string, fingerprint: string): {
  runId: string;
  taskId: string;
  attemptId: string;
  actionEventId: string;
} {
  const hash = createHash("sha256")
    .update(`watchdog-repair:${rootRunId}:${fingerprint}`)
    .digest("hex");
  return {
    runId: `run_watchdog_repair_${hash.slice(0, 24)}`,
    taskId: `task_watchdog_repair_${hash.slice(0, 24)}`,
    attemptId: `attempt_watchdog_repair_${hash.slice(0, 24)}`,
    actionEventId: `action_watchdog_repair_${hash.slice(0, 24)}`,
  };
}

/**
 * Advance a state machine after a repair action sequence has been recorded.
 * The caller invokes this from the atomic transaction once a `repair`
 * transition has dispatched its completeSystemTask action.
 */
export function advanceAfterRepair(input: {
  previous: ControlPlaneWatchdogState;
  repairRunId: string;
  repairTaskId: string;
  actionEventIds: string[];
  now: number;
}): ControlPlaneWatchdogState {
  const { previous, repairRunId, repairTaskId, actionEventIds, now } = input;
  const isoNow = new Date(now).toISOString();
  return {
    ...previous,
    state: "canary",
    recoveryStage: "canary",
    repairRunId,
    repairTaskId,
    actionEventIds,
    canary: {
      status: "progressing",
      observedAt: isoNow,
      fingerprint: previous.fingerprint,
      evidence: [],
      ticksInCanary: 0,
    },
    history: appendHistory(
      previous.history,
      "canary",
      previous.fingerprint,
      "canary",
      "repair action sequence recorded",
      isoNow,
    ),
  };
}

/**
 * Mark a recovery as failed: enter the durable `blocked` state, preserve
 * evidence, and arm the cooldown deadline. The caller invokes this from the
 * atomic transaction once a `repair` transition has dispatched its
 * fixed-action (or determined the fault is unsupported) so that the failed
 * recovery still produces exactly one repair run and one action sequence.
 */
export function blockAfterRepair(input: {
  previous: ControlPlaneWatchdogState;
  repairRunId: string;
  repairTaskId: string;
  actionEventIds: string[];
  observation: WatchdogObservationSnapshot;
  failureReason: string;
  now: number;
}): ControlPlaneWatchdogState {
  const { previous, repairRunId, repairTaskId, actionEventIds, observation, failureReason, now } = input;
  const isoNow = new Date(now).toISOString();
  const cooldownUntil = new Date(now + WATCHDOG_COOLDOWN_MS).toISOString();
  return {
    ...previous,
    version: WATCHDOG_STATE_VERSION,
    state: "blocked",
    fingerprint: observation.fingerprint,
    recoveryStage: "blocked",
    repairRunId,
    repairTaskId,
    actionEventIds,
    cooldownUntil,
    affectedRunIds: observation.affectedRunIds,
    fault: observation.fault,
    canary:
      previous.canary.status === "none"
        ? { status: "failed", observedAt: isoNow, fingerprint: observation.fingerprint, evidence: [failureReason], ticksInCanary: 0 }
        : { ...previous.canary, status: "failed", evidence: [...previous.canary.evidence, failureReason] },
    failure: previous.failure ?? {
      reason: failureReason,
      details: [],
      recordedAt: isoNow,
    },
    history: appendHistory(
      previous.history,
      "blocked",
      observation.fingerprint,
      "blocked",
      failureReason,
      isoNow,
    ),
  };
}

/**
 * Reflect the result of an attempted fixed-action reconciliation. When the
 * fixed action returned `done`, the watchdog stays in `reconciling` with the
 * action event id recorded; the next eligible tick either observes meaningful
 * progress (resetting suspicion) or dispatches the linked repair run.
 *
 * When the fixed action returned `blocked` (or no fixed action is supported
 * for the fault), the watchdog immediately converges to the durable `blocked`
 * state with the action event id, the failure evidence, and the 15-minute
 * cooldown. The repair run is created later by the repair transition so the
 * blocked state still references exactly one deterministic repair run.
 */
export function recordReconciliationOutcome(input: {
  previous: ControlPlaneWatchdogState;
  outcome:
    | { kind: "done"; actionEventId: string; summary: string }
    | { kind: "blocked"; actionEventId: string; summary: string }
    | { kind: "unsupported"; actionEventId: null; summary: string };
  now: number;
}): ControlPlaneWatchdogState {
  const { previous, outcome, now } = input;
  const isoNow = new Date(now).toISOString();
  const actionEventIds = Array.from(
    new Set(
      [
        ...previous.actionEventIds,
        ...(outcome.actionEventId ? [outcome.actionEventId] : []),
      ].filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
  if (outcome.kind === "done") {
    return {
      ...previous,
      lastObservationAt: isoNow,
      actionEventIds,
      history: appendHistory(
        previous.history,
        previous.state,
        previous.fingerprint,
        previous.recoveryStage,
        `reconciliation done: ${outcome.summary.slice(0, 120)}`,
        isoNow,
      ),
    };
  }
  const failureReason =
    outcome.kind === "unsupported"
      ? `unsupported fault: ${outcome.summary.slice(0, 120)}`
      : `reconcile fixed action blocked: ${outcome.summary.slice(0, 120)}`;
  const cooldownUntil = new Date(now + WATCHDOG_COOLDOWN_MS).toISOString();
  return {
    ...previous,
    version: WATCHDOG_STATE_VERSION,
    state: "blocked",
    lastObservationAt: isoNow,
    recoveryStage: "blocked",
    actionEventIds,
    cooldownUntil: previous.cooldownUntil ?? cooldownUntil,
    canary:
      previous.canary.status === "none"
        ? { status: "failed", observedAt: isoNow, fingerprint: previous.fingerprint, evidence: [failureReason], ticksInCanary: 0 }
        : { ...previous.canary, status: "failed", evidence: [...previous.canary.evidence, failureReason] },
    failure: previous.failure ?? {
      reason: failureReason,
      details: [],
      recordedAt: isoNow,
    },
    history: appendHistory(
      previous.history,
      "blocked",
      previous.fingerprint,
      "blocked",
      failureReason,
      isoNow,
    ),
  };
}

export type { AttemptOutput };
