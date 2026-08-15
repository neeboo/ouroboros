import {
  applyHarnessAction,
  describeIntegrationReadiness,
  describeRunCompletionReadiness,
  diagnoseRunOverview,
  GOAL_REVIEW_TASK_DONE_WHEN,
  GOAL_REVIEW_TASK_GOAL,
  GOAL_REVIEW_TASK_PROMPT,
  type Attempt,
  type AttemptOutput,
  type ExecutionThread,
  type ExecutionThreadStatus,
  type Harness,
  type HarnessActionResult,
  type FrozenResourceAllocationV0,
  type Run,
  type RunOverview,
  type Task,
  effectiveResourceHardTimeoutMs,
  effectiveResourceTaskLimit,
  parseFrozenResourceAllocationV0,
  selectResourceAwareRuns,
} from "@ouroboros/harness";
import { randomUUID } from "node:crypto";
import { buildTaskPrompt, protectedPromptContractFingerprintForSource } from "./prompt";
import {
  assertPersistedHarnessRevisionAttestation,
  blockedHarnessRevisionOutput,
  harnessRevisionAttemptInput,
  loadFrozenHarnessRevision,
  type LoadedHarnessRevision,
} from "./harness-revision-loader";
import {
  promptBudgetAttemptInput,
  promptBudgetBlockedOutput,
  promptBudgetEvidence,
} from "./prompt-budget";
import { applyStartHooks } from "./runner";
import { createCodexResumableClient, sessionIdFromEvents } from "./executors/codex-resumable";
import type { CodexResumableClientOptions, CodexResumableResult } from "./executors/codex-resumable";
import { childToolchainEnvEvidence } from "./executors/proxy-env";
import { reconcileTerminalBlockedVerifierRepair } from "./hooks/create-repair";
import { reconcileTerminalDoneWorkerVerifiers } from "./hooks/create-verifier";
import { createRouteExecutor } from "./route-executor";
import {
  assertPersistedHostExecutionCapabilityAttestation,
  hostExecutionCapabilityAttemptInput,
} from "./executors/host-execution-capabilities";
import { createDurableAttemptReplayCache } from "./executors/replay";
import { resolveExecutionRoute } from "./execution-routing";
import type { ResolvedExecutionRoute } from "./execution-routing";
import type { AttemptInputFactory, ExecutorEventRecorder, StartHook, StartHookResult, StopHook, StopHookResult, TaskExecutorFactory } from "./types";
import type { AttemptReplayCache } from "./executors/types";
import type { HostCapabilityReadback, HostReadbackForTask } from "./host-capability-readback";
import {
  assertPersistedVerifierExecutionEnvironmentReceipt,
  blockedVerifierExecutionEnvironmentOutput,
  prepareVerifierExecutionEnvironment,
  preparedVerifierExecutionEnvironmentFromAttempt,
  verifierExecutionEnvironmentAttemptInput,
  withVerifierExecutionEnvironmentReceipt,
  type VerifierExecutionEnvironmentHost,
} from "./verifier-execution-environment";

const DEFAULT_RUNNING_ATTEMPT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HEARTBEAT_MS = 30 * 1000;

export type CodexResumableClientFactory = (input: {
  model?: string;
  reasoningEffort?: string;
  cwd: string;
  task?: Task;
  route?: ResolvedExecutionRoute;
}) => ReturnType<typeof createCodexResumableClient>;

export interface CodexResumableOrchestrationInput {
  harness: Harness;
  cwd?: string;
  worktreeForTask?: (task: Task) => string;
  startHooks?: StartHook[];
  stopHooksByRole?: Record<string, StopHook[]>;
  cliAgentBackend?: string;
  cliExecutor?: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable";
  model?: string;
  clientFactory?: CodexResumableClientFactory;
  genericExecutorFactory?: TaskExecutorFactory;
  genericAttemptInput?: AttemptInputFactory;
  hostReadbackForTask?: HostReadbackForTask;
  verifierExecutionEnvironmentHost?: VerifierExecutionEnvironmentHost;
  codexOptions?: Partial<CodexResumableClientOptions>;
  ownerId?: string;
  pid?: number;
  runningAttemptStaleMs?: number;
  genericAttemptIdleTimeoutMs?: number;
  genericAttemptHardTimeoutMs?: number;
  genericAttemptHeartbeatMs?: number;
  shouldStop?: () => boolean;
  reconcileTerminalBlockedVerifierRepairs?: boolean;
  reconcileTerminalDoneWorkerVerifiers?: boolean;
}

type RuntimeGenerationState = "current" | "stale" | "draining-for-reload" | "reloaded" | "reload-failed";

interface RuntimeGenerationContext {
  state?: RuntimeGenerationState;
  generation?: number;
  sourceRoot?: string;
  launchHead?: string;
  observedHead?: string;
  promptContractHash?: string;
  attestedGeneration?: number;
  attestedHead?: string;
  attestedPromptContractHash?: string;
  processIdentity?: string;
  attestedProcessIdentity?: string;
}

export interface RunCodexResumableLoopInput extends CodexResumableOrchestrationInput {
  runId: string;
  maxRounds: number;
  limit: number;
  maxTries: number;
  integrateCompletedRuns?: boolean;
  integrationTargetBranch?: string;
  integrationPush?: boolean;
}

export async function runCodexResumableLoop(input: RunCodexResumableLoopInput) {
  assertNoAmbientIntegrationOverrides(input);
  let interruptedSignal: "SIGINT" | "SIGTERM" | null = null;
  const onSigint = () => {
    interruptedSignal = "SIGINT";
  };
  const onSigterm = () => {
    interruptedSignal = "SIGTERM";
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const orchestrator = new CodexResumableOrchestrator(input);
  const rounds = [];
  try {
    for (let index = 0; index < input.maxRounds; index += 1) {
      if (interruptedSignal || input.shouldStop?.()) {
        break;
      }
      const reconciledVerifiers = input.reconcileTerminalDoneWorkerVerifiers
        ? await reconcileTerminalDoneWorkerVerifiers({ harness: input.harness, runId: input.runId })
        : [];
      const reconciledRepairs = input.reconcileTerminalBlockedVerifierRepairs
        ? await reconcileTerminalBlockedVerifierRepair({ harness: input.harness, runId: input.runId })
        : [];
      const reclaimed = input.harness.reclaimRunningTasksWithoutAttempts({
        runId: input.runId,
        maxRecoveries: input.maxTries,
      });
      const resumed = await orchestrator.resumeRunningAttempts({
        runId: input.runId,
        limit: input.limit,
        maxRunningContinuations: input.maxTries,
      });
      if (resumed.length > 0) {
        rounds.push({ index, tasks: resumed, reclaimed, reconciledVerifiers, reconciledRepairs });
        if (resumed.some((task) => task.status === "running")) {
          break;
        }
        continue;
      }

      if (!orchestrator.canLeaseReadyWork(input.runId)) {
        break;
      }

      const started = await orchestrator.startReadyAttempts({ runId: input.runId, limit: input.limit });
      if (started.length === 0) {
        const overviewBeforeReview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
        const integration = maybeIntegrateCompletedRun(input, overviewBeforeReview);
        if (integration?.some((result) => result.status === "done")) {
          rounds.push({ index, tasks: started, integration, reclaimed, reconciledVerifiers, reconciledRepairs });
          continue;
        }
        const drain = applyHarnessAction(input.harness, {
          type: "prepareRunDrain",
          runId: input.runId,
          maxTries: input.maxTries,
          reason: "runner found no ready tasks",
        });
        if (drain.status === "done") {
          const reviewed = await orchestrator.startReadyAttempts({ runId: input.runId, limit: input.limit });
          if (reviewed.length > 0) {
            if (reviewed.some((task) => task.status === "running")) {
              rounds.push({ index, tasks: reviewed, goalReview: drain, reclaimed, reconciledVerifiers, reconciledRepairs });
              break;
            }
            // A terminal goal review may atomically materialize the next task. Give
            // that durable handoff one bounded start opportunity even when this is
            // the loop's final round; do not recursively drain again here.
            const continuations = await orchestrator.startReadyAttempts({ runId: input.runId, limit: input.limit });
            rounds.push({
              index,
              tasks: reviewed,
              continuations,
              goalReview: drain,
              reclaimed,
              reconciledVerifiers,
              reconciledRepairs,
            });
            if (continuations.some((task) => task.status === "running")) {
              break;
            }
            continue;
          }
        }
        break;
      }
      rounds.push({ index, tasks: started, reclaimed, reconciledVerifiers, reconciledRepairs });
      if (started.some((task) => task.status === "running")) {
        break;
      }
    }
    return { rounds };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (interruptedSignal) {
      input.harness.interruptRunningAttemptsByOwner({
        runId: input.runId,
        pid: input.pid ?? process.pid,
        reason: `runner interrupted by ${interruptedSignal}`,
      });
    }
  }
}

export interface RunCodexAutopilotInput extends RunCodexResumableLoopInput {
  maxCycles: number;
  intervalMs: number;
}

export async function runCodexAutopilot(input: RunCodexAutopilotInput) {
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const result = await runCodexResumableLoop(input);
    const overview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
    cycles.push({
      index,
      rounds: result.rounds,
      activeTasks: overview.tasks.filter((task) => task.status === "todo" || task.status === "running").length,
      runStatus: overview.run?.status ?? null,
    });

    if (overview.run?.status === "done") {
      return { status: "done" as const, cycles };
    }
    if (index < input.maxCycles - 1) {
      await sleep(input.intervalMs);
    }
  }
  const overview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
  return { status: overview.run?.status ?? "unknown", cycles };
}

export interface SuperviseCodexRunsInput extends CodexResumableOrchestrationInput {
  rootRunId?: string | null;
  runConcurrency: number;
  taskConcurrency: number;
  maxCycles: number;
  maxRounds: number;
  maxTries: number;
  intervalMs: number;
  integrateCompletedRuns?: boolean;
  integrationTargetBranch?: string;
  integrationPush?: boolean;
}

export async function superviseCodexRuns(input: SuperviseCodexRunsInput) {
  assertNoAmbientIntegrationOverrides(input);
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const candidates = runnableRuns(input.harness, { limit: input.runConcurrency, rootRunId: input.rootRunId ?? null });
    if (candidates.length === 0) {
      return { status: "idle" as const, cycles };
    }
    const results = await Promise.all(candidates.map(async (run) => {
      const resourceAllocation = resourceAllocationForRun(run);
      const result = await runCodexResumableLoop({
        ...input,
        runId: run.id,
        maxRounds: input.maxRounds,
        limit: effectiveResourceTaskLimit(input.taskConcurrency, resourceAllocation),
        maxTries: input.maxTries,
        genericAttemptHardTimeoutMs: effectiveResourceHardTimeoutMs(
          input.genericAttemptHardTimeoutMs,
          resourceAllocation,
        ),
      });
      const overview = input.harness.getRunOverview({ runId: run.id, eventLimit: 0 });
      const loopIntegration = result.rounds.flatMap((round) => {
        const integration = (round as { integration?: Array<HarnessActionResult & { eventId: string }> }).integration;
        return Array.isArray(integration) ? integration : [];
      });
      const postLoopIntegration = maybeIntegrateCompletedRun(input, overview);
      const integration = input.integrateCompletedRuns
        ? [...loopIntegration, ...(postLoopIntegration ?? [])]
        : postLoopIntegration;
      const refreshedOverview = integration && integration.length > 0
        ? input.harness.getRunOverview({ runId: run.id, eventLimit: 0 })
        : overview;
      return {
        runId: run.id,
        goal: run.goal,
        status: refreshedOverview.run?.status ?? run.status,
        rounds: result.rounds,
        activeTasks: refreshedOverview.tasks.filter((task) => task.status === "todo" || task.status === "running").length,
        integration,
      };
    }));
    cycles.push({ index, runs: results });
    if (index < input.maxCycles - 1) {
      await sleep(input.intervalMs);
    }
  }
  return { status: "cycle_limit" as const, cycles };
}

export interface SuperviseCodexDaemonInput extends CodexResumableOrchestrationInput {
  rootRunId?: string | null;
  runConcurrency: number;
  taskConcurrency: number;
  tickCycles: number;
  maxRounds: number;
  maxTries: number;
  intervalMs: number;
  idleMs: number;
  maxTicks: number;
  integrateCompletedRuns?: boolean;
  integrationTargetBranch?: string;
  integrationPush?: boolean;
  onTick?: (tick: Record<string, unknown>) => void;
}

export async function superviseCodexDaemon(input: SuperviseCodexDaemonInput) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const ticks = [];
  let index = 0;
  while (!stopping && (input.maxTicks === 0 || index < input.maxTicks)) {
    let waitMs = input.intervalMs;
    let tick;
    try {
      const result = await superviseCodexRuns({
        ...input,
        maxCycles: input.tickCycles,
        shouldStop: () => stopping || input.shouldStop?.() === true,
      });
      waitMs = result.status === "idle" ? input.idleMs : input.intervalMs;
      tick = {
        type: "daemon.tick",
        index,
        status: "ok" as const,
        result,
        runCounts: runStatusCounts(input.harness),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      tick = {
        type: "daemon.tick",
        index,
        status: "error" as const,
        error: errorMessage(error),
        runCounts: runStatusCounts(input.harness),
        createdAt: new Date().toISOString(),
      };
    }
    ticks.push(tick);
    input.onTick?.(tick);
    index += 1;
    if (!stopping && (input.maxTicks === 0 || index < input.maxTicks)) {
      await sleep(waitMs);
    }
  }

  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return {
    status: stopping ? "stopped" as const : input.maxTicks > 0 ? "tick_limit" as const : "stopped" as const,
    ticks,
    runCounts: runStatusCounts(input.harness),
  };
}

export async function startCodexResumableAttempt(input: CodexResumableOrchestrationInput & { taskId: string }) {
  return new CodexResumableOrchestrator(input).startAttempt(input.taskId);
}

export async function resumeCodexResumableAttempt(
  input: CodexResumableOrchestrationInput & { attemptId: string; prompt?: string },
) {
  return new CodexResumableOrchestrator(input).resumeAttempt(input.attemptId, input.prompt);
}

class CodexResumableOrchestrator {
  private readonly harness: Harness;
  private readonly cwd: string;
  private readonly ownerId: string;
  private readonly pid: number;
  private readonly staleMs: number;
  private readonly genericIdleMs: number;
  private readonly genericHardMs: number;
  private readonly genericHeartbeatMs: number;
  private readonly replayCache: AttemptReplayCache;

  constructor(private readonly input: CodexResumableOrchestrationInput) {
    this.harness = input.harness;
    this.cwd = input.cwd ?? process.cwd();
    this.ownerId = input.ownerId ?? String(process.pid);
    this.pid = input.pid ?? process.pid;
    this.staleMs = input.runningAttemptStaleMs ?? DEFAULT_RUNNING_ATTEMPT_STALE_MS;
    this.genericIdleMs = input.genericAttemptIdleTimeoutMs ?? DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS;
    this.genericHardMs = input.genericAttemptHardTimeoutMs ?? DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS;
    this.genericHeartbeatMs = input.genericAttemptHeartbeatMs ?? DEFAULT_GENERIC_ATTEMPT_HEARTBEAT_MS;
    this.replayCache = createDurableAttemptReplayCache({ harness: this.harness });
  }

  async startAttempt(taskId: string) {
    const task = this.taskOrThrow(taskId);
    const run = this.runOrThrow(task.runId);
    if (run.context.retired === true) {
      throw new Error(`run ${run.id} is retired and cannot start attempts`);
    }
    if (!runtimeGenerationAllowsLeasing(run, this.cwd, this.harness)) {
      throw new Error(`runtime generation ${String((run.context.controlPlaneRuntime as Record<string, unknown> | undefined)?.state ?? "unknown")} cannot start new work`);
    }
    const sessionName = task.sessionRef ?? `task-${task.id}`;
    const route = this.resolveRoute(run, task);
    const cwd = task.worktreePath ?? this.worktreeFor(task) ?? this.cwd;
    const hostCapabilityInput = hostExecutionCapabilityAttemptInput(task.config?.hostExecutionCapabilities, {
      role: task.role,
      verifierContract: task.config?.verifierContract,
    });
    if (hostExecutionCapabilityProblem(hostCapabilityInput)) {
      return this.blockNewAttemptForHostExecutionCapability({ run, task, sessionName, cwd, route, hostCapabilityInput });
    }
    let verifierExecutionEnvironment;
    try {
      verifierExecutionEnvironment = this.verifierExecutionEnvironmentFor(run, task, cwd, route);
    } catch (error) {
      return this.blockNewAttemptForVerifierExecutionEnvironment({ run, task, sessionName, cwd, route, error });
    }
    this.harness.clearRunPause(run.id);
    let loadedHarnessRevision: LoadedHarnessRevision | null;
    try {
      loadedHarnessRevision = loadFrozenHarnessRevision({ harness: this.harness, run, cwd });
    } catch (error) {
      return this.blockNewAttemptForHarnessRevision({ run, task, sessionName, cwd, route, error });
    }
    const hostCapabilityReadback = await this.hostReadbackForTask(run, task, cwd);
    const prompt = this.promptForTask(run, task, loadedHarnessRevision, hostCapabilityReadback);
    const oversized = promptBudgetEvidence(prompt, "runner client start");
    if (oversized) {
      const attemptId = this.harness.recordAttempt({
        taskId,
        input: {
          ...promptBudgetAttemptInput(oversized),
          sessionName,
          executor: route.backend.kind,
          ...attemptInputForRoute(route, cwd),
        },
        output: promptBudgetBlockedOutput(oversized),
      });
      this.upsertAttemptThread({ runId: run.id, task, attemptId, sessionName, cwd, status: "blocked" });
      return { attemptId, taskId, status: "blocked" as const, codexSessionId: null };
    }
    const startResult = await applyStartHooks({
      hooks: this.input.startHooks ?? [],
      run,
      task,
      sessionName,
      cwd,
    });
    const baseInput = {
      prompt,
      sessionName,
      executor: route.backend.kind,
      ...attemptInputForRoute(route, cwd),
      ...(this.input.genericAttemptInput?.({ run, task, sessionName, cwd, route }) ?? {}),
      ...(hostCapabilityReadback ? { hostCapabilityReadback } : {}),
      ...harnessRevisionAttemptInput(loadedHarnessRevision),
      ...hostCapabilityInput,
      ...verifierExecutionEnvironmentAttemptInput(verifierExecutionEnvironment),
    };
    if ((startResult.problems ?? []).length > 0) {
      const attemptId = this.harness.recordAttempt({
        taskId,
        input: { ...baseInput, startHooks: true },
        output: blockedByStartHooks(startResult),
      });
      this.upsertAttemptThread({ runId: run.id, task, attemptId, sessionName, cwd, status: "blocked" });
      return { attemptId, taskId, status: "blocked" as const, codexSessionId: null };
    }
    return this.runStartedAttempt({ run, task, sessionName, prompt, cwd, route, startResult, baseInput });
  }

  async resumeAttempt(attemptId: string, promptOverride?: string) {
    const existingAttempt = this.harness.getAttempt(attemptId);
    if (!existingAttempt) {
      throw new Error(`attempt not found: ${attemptId}`);
    }
    if (existingAttempt.status !== "running") {
      throw new Error(`attempt is not running: ${attemptId}`);
    }
    const task = this.taskOrThrow(existingAttempt.taskId);
    const run = this.runOrThrow(task.runId);
    const cwd = typeof existingAttempt.input.cwd === "string"
      ? existingAttempt.input.cwd
      : task.worktreePath ?? this.cwd;
    try {
      assertPersistedHostExecutionCapabilityAttestation(
        existingAttempt.input,
        task.config?.hostExecutionCapabilities,
        { role: task.role, verifierContract: task.config?.verifierContract },
      );
      const currentVerifierExecutionEnvironment = this.verifierExecutionEnvironmentFor(
        run,
        task,
        cwd,
        this.resolveRoute(run, task),
      );
      assertPersistedVerifierExecutionEnvironmentReceipt(existingAttempt.input, currentVerifierExecutionEnvironment);
      const loadedHarnessRevision = loadFrozenHarnessRevision({ harness: this.harness, run, cwd });
      assertPersistedHarnessRevisionAttestation(existingAttempt.input, loadedHarnessRevision);
    } catch (error) {
      const output = blockedResumeContractOutput(error);
      this.harness.finishAttempt({ attemptId, output });
      this.updateAttemptThread({ attemptId, status: "blocked", agentSessionId: null, heartbeat: true });
      return { attemptId, status: "blocked" as const, codexSessionId: null };
    }
    this.harness.clearRunPause(run.id);
    const sessionId = this.sessionIdForAttempt(
      existingAttempt,
      this.harness.listExecutionThreads({ runId: run.id }).find((thread) => thread.attemptId === attemptId),
    );
    const claimed = this.tryClaimDirectResume(attemptId);
    if (!claimed) {
      const refreshed = this.harness.getAttempt(attemptId);
      if (!refreshed) {
        throw new Error(`attempt not found: ${attemptId}`);
      }
      if (refreshed.status !== "running") {
        throw new Error(`attempt is not running: ${attemptId}`);
      }
      throw new Error(`direct resume already claimed: ${attemptId}`);
    }
    const { attempt, claimToken } = claimed;
    if (!sessionId) {
      const output = missingResumableSessionOutput("direct resume");
      this.harness.finishAttempt({ attemptId, output });
      this.updateAttemptThread({ attemptId, status: "blocked", agentSessionId: null, heartbeat: true });
      return { attemptId, status: "blocked" as const, codexSessionId: null };
    }
    const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attemptId}`;
    const prompt = promptOverride ?? "Continue until you can return the required structured JSON.";
    const oversized = promptBudgetEvidence(prompt, "runner client resume");
    if (oversized) {
      this.releaseDirectResumeClaim(attemptId, claimToken);
      const output = promptBudgetBlockedOutput(oversized);
      this.harness.finishAttempt({ attemptId, output });
      this.updateAttemptThread({ attemptId, status: "blocked", agentSessionId: sessionId, heartbeat: true });
      return { attemptId, status: "blocked" as const, codexSessionId: sessionId };
    }
    const resolvedModel = attemptModelPreference(attempt.input);
    const recorder = this.createAttemptEventRecorder(attemptId);
    let result: CodexResumableResult;
    try {
      result = await this.client({ model: resolvedModel?.model, reasoningEffort: resolvedModel?.reasoning_effort, cwd, task }).resume({
        sessionId,
        sessionName,
        prompt,
        onStdout: recorder.stdout,
        onStderr: recorder.stderr,
        onEvent: recorder.event,
      });
    } catch (error) {
      this.releaseDirectResumeClaim(attemptId, claimToken);
      throw error;
    }
    this.harness.updateAttemptInput({
      attemptId,
      input: {
        ...(this.harness.getAttempt(attemptId)?.input ?? attempt.input),
        ...codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
      },
    });
    if (result.status === "running") {
      const resumedSessionId = result.sessionId ?? this.sessionIdForAttempt(this.harness.getAttempt(attemptId)!);
      if (!resumedSessionId) {
        return this.blockAttemptWithoutResumableSession({
          attemptId,
          task,
          sessionName,
          result,
        });
      }
      this.releaseDirectResumeClaim(attemptId, claimToken);
      return { attemptId, status: "running" as const, codexSessionId: resumedSessionId };
    }
    const codexSessionId: string = result.sessionId ?? sessionId;
    const recoveredControlPlaneFailure = this.finishRecoverableControlPlaneFailure({
      attemptId,
      task,
      rawOutput: result.output,
      codexSessionId,
    });
    if (recoveredControlPlaneFailure) {
      return { attemptId, status: "blocked" as const, codexSessionId: result.sessionId };
    }
    const output = await this.finishCodexAttempt({
      attemptId,
      run,
      task,
      sessionName,
      prompt,
      rawOutput: result.output,
      codexSessionId,
    });
    return { attemptId, status: output.status, codexSessionId: result.sessionId };
  }

  private tryClaimDirectResume(attemptId: string) {
    for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
      const current = this.harness.getAttempt(attemptId);
      if (!current) {
        throw new Error(`attempt not found: ${attemptId}`);
      }
      if (current.status !== "running") {
        return null;
      }
      const existingClaim = directResumeClaimFromAttempt(current);
      if (existingClaim) {
        if (!processIsAlive(existingClaim.pid)) {
          this.releaseDirectResumeClaim(attemptId, existingClaim.token);
          continue;
        }
        return null;
      }

      const claimToken = randomUUID();
      const claimJson = JSON.stringify({
        token: claimToken,
        ownerId: this.ownerId,
        pid: this.pid,
        claimedAt: new Date().toISOString(),
      });
      const updated = this.harness.runInTransaction((db) => db
        .query(
          `
          update attempts
          set input_json = json_set(input_json, '$.directResumeClaim', json($claimJson))
          where id = $attemptId
            and status = 'running'
            and json_type(input_json, '$.directResumeClaim') is null
          `,
        )
        .run({ $attemptId: attemptId, $claimJson: claimJson }).changes > 0);
      if (!updated) {
        return null;
      }
      const attempt = this.harness.getAttempt(attemptId);
      if (!attempt || attempt.status !== "running") {
        return null;
      }
      return { attempt, claimToken };
    }
    return null;
  }

  private releaseDirectResumeClaim(attemptId: string, claimToken: string) {
    this.harness.runInTransaction((db) => {
      db.query(
        `
        update attempts
        set input_json = json_remove(input_json, '$.directResumeClaim')
        where id = $attemptId
          and status = 'running'
          and json_extract(input_json, '$.directResumeClaim.token') = $claimToken
        `,
      ).run({ $attemptId: attemptId, $claimToken: claimToken });
    });
  }

  async resumeRunningAttempts(input: { runId: string; limit: number; maxRunningContinuations: number }) {
    const attempts = this.harness.listRunningAttempts({ runId: input.runId }).slice(0, input.limit);
    if (attempts.length > 0) {
      this.harness.clearRunPause(input.runId);
    }
    const overview = this.harness.getRunOverview({ runId: input.runId, eventLimit: 1 });
    const sessionsByAttemptId = new Map(overview.sessions.map((session) => [session.attemptId, session]));
    const threadsByAttemptId = new Map(overview.threads.map((thread) => [thread.attemptId, thread]));
    const tasks = await Promise.all(attempts.map(async (attempt) => {
      const task = this.harness.getTask(attempt.taskId);
      if (!task) return null;
      const run = this.harness.getRun(task.runId);
      if (!run) return null;
      const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
      const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? this.cwd;
      try {
        this.harness.assertTaskExecutionAllowed({ taskId: task.id });
      } catch (error) {
        const reason = errorMessage(error);
        this.harness.recoverRunningAttempt({
          attemptId: attempt.id,
          reason,
          maxRecoveries: 0,
          output: {
            status: "blocked",
            summary: "Stored task failed the execution governance boundary before resume",
            changedFiles: [],
            checks: [{ name: "task execution governance", status: "failed", evidence: reason }],
            artifacts: [{ kind: "governance_bypass_blocked", taskId: task.id, attemptId: attempt.id }],
            problems: [reason],
          },
        });
        this.updateAttemptThread({ attemptId: attempt.id, status: "interrupted", heartbeat: true });
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: null };
      }
      try {
        const route = this.resolveRoute(run, task);
        const currentVerifierExecutionEnvironment = this.verifierExecutionEnvironmentFor(run, task, cwd, route);
        assertPersistedVerifierExecutionEnvironmentReceipt(attempt.input, currentVerifierExecutionEnvironment);
        const loadedHarnessRevision = loadFrozenHarnessRevision({ harness: this.harness, run, cwd });
        assertPersistedHarnessRevisionAttestation(attempt.input, loadedHarnessRevision);
      } catch (error) {
        const output = blockedHarnessRevisionOutput(error);
        this.harness.finishAttempt({ attemptId: attempt.id, output });
        this.updateAttemptThread({ attemptId: attempt.id, status: "blocked", agentSessionId: null, heartbeat: true });
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: null };
      }
      const thread = threadsByAttemptId.get(attempt.id);
      const sessionId = this.sessionIdForAttempt(attempt, thread);
      if (!sessionId) {
        if (this.runningAttemptIsFresh(sessionsByAttemptId.get(attempt.id), thread)) {
          this.upsertAttemptThread({ runId: run.id, task, attemptId: attempt.id, sessionName, cwd, status: "running" });
          return { taskId: task.id, attemptId: attempt.id, sessionName, status: "running" as const, codexSessionId: null };
        }
        this.upsertAttemptThread({ runId: run.id, task, attemptId: attempt.id, sessionName, cwd, status: "orphaned" });
        const output: AttemptOutput = {
          ...missingResumableSessionOutput("run-loop resume"),
          artifacts: [{ kind: "execution_thread", status: "orphaned", attemptId: attempt.id }],
        };
        this.harness.finishAttempt({ attemptId: attempt.id, output });
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: null };
      }
      const prompt =
        typeof attempt.input.prompt === "string"
          ? attempt.input.prompt
          : "Continue until you can return the required structured JSON.";
      const resolvedModel = attemptModelPreference(attempt.input);
      const claimed = this.tryClaimDirectResume(attempt.id);
      if (!claimed) {
        return null;
      }
      const { attempt: claimedAttempt, claimToken } = claimed;
      const runningContinuations = resumableRunningContinuationCount(claimedAttempt.input);
      if (runningContinuations >= input.maxRunningContinuations) {
        this.releaseDirectResumeClaim(attempt.id, claimToken);
        const output = resumableContinuationBudgetOutput(input.maxRunningContinuations);
        this.harness.finishAttempt({ attemptId: attempt.id, output });
        this.updateAttemptThread({ attemptId: attempt.id, status: "blocked", agentSessionId: sessionId, heartbeat: true });
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: sessionId };
      }
      const oversized = promptBudgetEvidence(prompt, "runner client resume");
      if (oversized) {
        this.releaseDirectResumeClaim(attempt.id, claimToken);
        const output = promptBudgetBlockedOutput(oversized);
        this.harness.finishAttempt({ attemptId: attempt.id, output });
        this.updateAttemptThread({ attemptId: attempt.id, status: "blocked", agentSessionId: sessionId, heartbeat: true });
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: sessionId };
      }
      this.upsertAttemptThread({
        runId: run.id,
        task,
        attemptId: attempt.id,
        sessionName,
        cwd,
        agentSessionId: sessionId,
        status: "running",
      });
      const recorder = this.createAttemptEventRecorder(attempt.id);
      let result: CodexResumableResult;
      try {
        result = await this.client({ model: resolvedModel?.model, reasoningEffort: resolvedModel?.reasoning_effort, cwd, task }).resume({
          sessionId,
          sessionName,
          prompt,
          onStdout: recorder.stdout,
          onStderr: recorder.stderr,
          onEvent: recorder.event,
        });
      } catch (error) {
        this.releaseDirectResumeClaim(attempt.id, claimToken);
        throw error;
      }
      this.harness.updateAttemptInput({
        attemptId: attempt.id,
        input: {
          ...(this.harness.getAttempt(attempt.id)?.input ?? claimedAttempt.input),
          ...codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
          resumableRunningContinuations: result.status === "running"
            ? runningContinuations + 1
            : runningContinuations,
          threadId: threadIdForAttempt(attempt.id),
        },
      });
      this.updateAttemptThread({
        attemptId: attempt.id,
        status: result.status === "running" ? "running" : undefined,
        agentSessionId: result.sessionId ?? this.sessionIdFromAttemptEvents(attempt.id),
        heartbeat: true,
      });
      if (result.status === "running") {
        const resumedSessionId = result.sessionId ?? this.sessionIdForAttempt(this.harness.getAttempt(attempt.id)!);
        if (!resumedSessionId) {
          return this.blockAttemptWithoutResumableSession({
            attemptId: attempt.id,
            task,
            sessionName,
            result,
          });
        }
        this.releaseDirectResumeClaim(attempt.id, claimToken);
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "running" as const, codexSessionId: resumedSessionId };
      }
      const codexSessionId: string = result.sessionId ?? sessionId;
      const recoveredControlPlaneFailure = this.finishRecoverableControlPlaneFailure({
        attemptId: attempt.id,
        task,
        rawOutput: result.output,
        codexSessionId,
      });
      if (recoveredControlPlaneFailure) {
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "blocked" as const, codexSessionId: result.sessionId };
      }
      const output = await this.finishCodexAttempt({
        attemptId: attempt.id,
        run,
        task,
        sessionName,
        prompt,
        rawOutput: result.output,
        codexSessionId,
      });
      return { taskId: task.id, attemptId: attempt.id, sessionName, status: output.status, codexSessionId: result.sessionId };
    }));
    return tasks.filter((task) => task !== null);
  }

  canLeaseReadyWork(runId: string) {
    return runtimeGenerationAllowsLeasing(this.harness.getRun(runId), this.cwd, this.harness);
  }

  async startReadyAttempts(input: { runId: string; limit: number }) {
    const run = this.runOrThrow(input.runId);
    if (run.context.retired === true) {
      return [];
    }
    if (!runtimeGenerationAllowsLeasing(run, this.cwd, this.harness)) {
      return [];
    }
    this.harness.clearRunPause(run.id);
    const leased = this.harness.leaseReadyTasks({
      runId: input.runId,
      limit: input.limit,
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: this.input.worktreeForTask,
    });
    return Promise.all(leased.map(async (task) => {
      const sessionName = task.sessionRef ?? `task-${task.id}`;
      const cwd = task.worktreePath ?? this.cwd;
      try {
        const route = this.resolveRoute(run, task);
        let loadedHarnessRevision: LoadedHarnessRevision | null;
        try {
          loadedHarnessRevision = loadFrozenHarnessRevision({ harness: this.harness, run, cwd });
        } catch (error) {
          return this.blockNewAttemptForHarnessRevision({ run, task, sessionName, cwd, route, error });
        }
        const hostCapabilityReadback = await this.hostReadbackForTask(run, task, cwd);
        const prompt = this.promptForTask(run, task, loadedHarnessRevision, hostCapabilityReadback);
        const oversized = promptBudgetEvidence(prompt, "runner client start");
        if (oversized) {
          const attemptId = this.harness.recordAttempt({
            taskId: task.id,
            input: {
              ...promptBudgetAttemptInput(oversized),
              sessionName,
              executor: route.backend.kind,
              ...attemptInputForRoute(route, cwd),
            },
            output: promptBudgetBlockedOutput(oversized),
          });
          this.upsertAttemptThread({ runId: run.id, task, attemptId, sessionName, cwd, status: "blocked" });
          return { taskId: task.id, attemptId, sessionName, status: "blocked" as const, codexSessionId: null };
        }
        const hostCapabilityInput = hostExecutionCapabilityAttemptInput(task.config?.hostExecutionCapabilities, {
          role: task.role,
          verifierContract: task.config?.verifierContract,
        });
        if (hostExecutionCapabilityProblem(hostCapabilityInput)) {
          return this.blockNewAttemptForHostExecutionCapability({ run, task, sessionName, cwd, route, hostCapabilityInput });
        }
        let verifierExecutionEnvironment;
        try {
          verifierExecutionEnvironment = this.verifierExecutionEnvironmentFor(run, task, cwd, route);
        } catch (error) {
          return this.blockNewAttemptForVerifierExecutionEnvironment({ run, task, sessionName, cwd, route, error });
        }
        const baseInput = {
          prompt,
          sessionName,
          executor: route.backend.kind,
          ...attemptInputForRoute(route, cwd),
          ...(this.input.genericAttemptInput?.({ run, task, sessionName, cwd, route }) ?? {}),
          ...(hostCapabilityReadback ? { hostCapabilityReadback } : {}),
          ...harnessRevisionAttemptInput(loadedHarnessRevision),
          ...hostCapabilityInput,
          ...verifierExecutionEnvironmentAttemptInput(verifierExecutionEnvironment),
        };
        const startResult = await applyStartHooks({
          hooks: this.input.startHooks ?? [],
          run,
          task,
          sessionName,
          cwd,
        });
        if ((startResult.problems ?? []).length > 0) {
          const attemptId = this.harness.recordAttempt({
            taskId: task.id,
            input: { ...baseInput, startHooks: true },
            output: blockedByStartHooks(startResult),
          });
          this.upsertAttemptThread({ runId: run.id, task, attemptId, sessionName, cwd, status: "blocked" });
          return { taskId: task.id, attemptId, sessionName, status: "blocked" as const, codexSessionId: null };
        }
        return this.runStartedAttempt({ run, task, sessionName, prompt, cwd, route, startResult, baseInput });
      } catch (error) {
        const stillOrphaned = this.harness.getTask(task.id)?.status === "running"
          && !this.harness.listRunningAttempts({ runId: run.id }).some((attempt) => attempt.taskId === task.id);
        if (stillOrphaned) {
          return this.blockLeasedTaskPreparationFailure({ run, task, sessionName, cwd, error });
        }
        throw error;
      }
    }));
  }

  private async runStartedAttempt(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    prompt: string;
    cwd: string;
    route: ResolvedExecutionRoute;
    startResult: StartHookResult;
    baseInput: Record<string, unknown>;
  }) {
    if (input.route.executionMode !== "codex-resumable") {
      return this.runLeasedGenericAttempt(input);
    }
    const attemptId = this.harness.startAttempt({
      taskId: input.task.id,
      input: {
        ...input.baseInput,
        startHookEvidence: startHookEvidence(input.startResult),
      },
    });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "running",
      agentSessionId: genericAgentSessionId(input.route, input.sessionName),
    });
    const recorder = this.createAttemptEventRecorder(attemptId);
    const result = await this.client({
      model: input.route.model?.model,
      reasoningEffort: input.route.model?.reasoning_effort,
      cwd: input.cwd,
      task: input.task,
      route: input.route,
    }).start({
      prompt: input.prompt,
      sessionName: input.sessionName,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    this.harness.updateAttemptInput({
      attemptId,
      input: {
        ...(this.harness.getAttempt(attemptId)?.input ?? input.baseInput),
        ...codexAttemptInput({ prompt: input.prompt, sessionName: input.sessionName, result, model: input.route.model, cwd: input.cwd }),
        resumableRunningContinuations: 0,
        threadId: threadIdForAttempt(attemptId),
      },
    });
    this.updateAttemptThread({
      attemptId,
      status: result.status === "running" ? "running" : undefined,
      agentSessionId: result.sessionId ?? this.sessionIdFromAttemptEvents(attemptId),
      heartbeat: true,
    });
    if (result.status === "running") {
      const sessionId = result.sessionId ?? this.sessionIdForAttempt(this.harness.getAttempt(attemptId)!);
      if (!sessionId) {
        return this.blockAttemptWithoutResumableSession({
          attemptId,
          task: input.task,
          sessionName: input.sessionName,
          result,
        });
      }
      return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: "running" as const, codexSessionId: sessionId };
    }
    const recoveredControlPlaneFailure = this.finishRecoverableControlPlaneFailure({
      attemptId,
      task: input.task,
      rawOutput: result.output,
      codexSessionId: result.sessionId,
    });
    if (recoveredControlPlaneFailure) {
      return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: "blocked" as const, codexSessionId: result.sessionId };
    }
    const output = await this.finishCodexAttempt({
      attemptId,
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      prompt: input.prompt,
      rawOutput: result.output,
      codexSessionId: result.sessionId,
      startResult: input.startResult,
    });
    return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: output.status, codexSessionId: result.sessionId };
  }

  private async finishCodexAttempt(input: {
    attemptId: string;
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    prompt: string;
    rawOutput: AttemptOutput;
    codexSessionId: string | null;
    startResult?: StartHookResult;
  }) {
    const stopResult = await this.applyStopHooks({
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      prompt: input.prompt,
      output: withCodexArtifacts(input.rawOutput, input.codexSessionId),
    });
    const output = stopResult.output;
    const decision = stopResult.decision;
    const persistedStartResult = input.startResult ?? startHookEvidenceFromAttempt(this.harness.getAttempt(input.attemptId));
    const outputWithStartEvidence: AttemptOutput = {
      ...output,
      checks: [...(persistedStartResult.checks ?? []), ...(output.checks ?? [])],
      artifacts: [...(persistedStartResult.artifacts ?? []), ...(output.artifacts ?? [])],
    };
    const finishedOutput = withVerifierExecutionEnvironmentReceipt(
      outputWithStartEvidence,
      preparedVerifierExecutionEnvironmentFromAttempt(this.harness.getAttempt(input.attemptId)?.input ?? {}),
    );
    this.harness.finishAttempt({ attemptId: input.attemptId, output: finishedOutput });
    const finishedAttempt = this.harness.getAttempt(input.attemptId);
    applyPostAttemptRunEffects(this.harness, input.run.id, input.task, finishedAttempt?.output ?? finishedOutput);
    this.updateAttemptThread({
      attemptId: input.attemptId,
      status: finishedOutput.status,
      agentSessionId: input.codexSessionId,
      heartbeat: true,
    });
    if (decision === "retry") {
      this.harness.retryTask({ taskId: input.task.id });
    }
    return finishedOutput;
  }

  private async runLeasedGenericAttempt(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    prompt: string;
    cwd: string;
    route: ResolvedExecutionRoute;
    startResult: StartHookResult;
    baseInput: Record<string, unknown>;
  }) {
    const attemptId = this.harness.startAttempt({ taskId: input.task.id, input: input.baseInput });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "running",
    });
    const recorder = this.createAttemptEventRecorder(attemptId, "system");
    const startedAt = Date.now();
    recorder.event({
      type: "generic.attempt.started",
      role: input.task.role,
      sessionName: input.sessionName,
      backend: input.route.backend.kind,
      agent: (input.route.backend as { agent?: string }).agent ?? null,
      agentCommand: (input.route.backend as { agentCommand?: string }).agentCommand ?? null,
      executionMode: input.route.executionMode,
      cwd: input.cwd,
      idleTimeoutMs: this.genericIdleMs,
      hardTimeoutMs: this.genericHardMs,
      heartbeatMs: this.genericHeartbeatMs,
    });
    const heartbeat = setInterval(() => {
      recorder.event({
        type: "generic.attempt.heartbeat",
        role: input.task.role,
        sessionName: input.sessionName,
        backend: input.route.backend.kind,
        agent: (input.route.backend as { agent?: string }).agent ?? null,
        agentCommand: (input.route.backend as { agentCommand?: string }).agentCommand ?? null,
        executionMode: input.route.executionMode,
        cwd: input.cwd,
        elapsedMs: Date.now() - startedAt,
      });
      this.updateAttemptThread({ attemptId, heartbeat: true });
    }, this.genericHeartbeatMs);
    unrefTimer(heartbeat);
    const executorFactory = this.input.genericExecutorFactory ?? ((factoryInput) =>
      createRouteExecutor({
        cwd: factoryInput.cwd,
        route: factoryInput.route,
        approval: "approve-reads",
        sandbox: "read-only",
        timeoutMs: this.genericHardMs,
        idleTimeoutMs: this.genericIdleMs,
        replayCache: this.replayCache,
        hostExecutionCapabilities: factoryInput.task.config?.hostExecutionCapabilities,
        taskRole: factoryInput.task.role,
        verifierContract: factoryInput.task.config?.verifierContract,
        dshProfileIsolation: factoryInput.task.config?.dshProfileIsolation === "base-headless"
          ? "base-headless"
          : undefined,
      }));
    const executor = executorFactory({
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      cwd: input.cwd,
      route: input.route,
    });
    let rawOutput: AttemptOutput;
    try {
      rawOutput = await executor({
        prompt: input.prompt,
        run: input.run,
        task: input.task,
        sessionName: input.sessionName,
        route: input.route,
        attemptId,
        recorder,
      });
    } catch (error) {
      recorder.event({
        type: "generic.attempt.executor_threw",
        error: error instanceof Error ? error.message : String(error),
      });
      rawOutput = {
        status: "blocked",
        summary: "generic executor threw before producing output",
        changedFiles: [],
        checks: [{ name: "generic executor", status: "failed" }],
        artifacts: [],
        problems: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      clearInterval(heartbeat);
    }
    const stopResult = await this.applyStopHooks({
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      prompt: input.prompt,
      output: rawOutput,
    });
    let output = stopResult.output;
    const decision = stopResult.decision;
    output.checks = [...(input.startResult.checks ?? []), ...(output.checks ?? [])];
    output.artifacts = [...(input.startResult.artifacts ?? []), ...(output.artifacts ?? [])];
    output = withVerifierExecutionEnvironmentReceipt(
      output,
      preparedVerifierExecutionEnvironmentFromAttempt(this.harness.getAttempt(attemptId)?.input ?? {}),
    );
    this.harness.finishAttempt({ attemptId, output });
    const finishedAttempt = this.harness.getAttempt(attemptId);
    applyPostAttemptRunEffects(this.harness, input.run.id, input.task, finishedAttempt?.output ?? output);
    this.updateAttemptThread({
      attemptId,
      status: output.status,
      agentSessionId: genericAgentSessionId(input.route, input.sessionName),
      heartbeat: true,
    });
    if (decision === "retry") {
      this.harness.retryTask({ taskId: input.task.id });
    }
    return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: output.status, codexSessionId: null };
  }

  private promptForTask(
    run: NonNullable<ReturnType<Harness["getRun"]>>,
    task: Task,
    loadedHarnessRevision: LoadedHarnessRevision | null = null,
    hostCapabilityReadback: HostCapabilityReadback | null = null,
  ) {
    return buildTaskPrompt({
      run,
      task,
      dependencyAttempts: task.dependsOn.length > 0 ? this.harness.listLatestAttemptsForTasks(task.dependsOn) : [],
      lessons: this.harness.listLessons({ runId: run.id }),
      template: this.harness.getPromptTemplate("task")?.contentMd,
      loadedHarnessRevision: loadedHarnessRevision?.harnessRevision ?? null,
      hostCapabilityReadback,
    });
  }

  private async hostReadbackForTask(
    run: NonNullable<ReturnType<Harness["getRun"]>>,
    task: Task,
    cwd: string,
  ) {
    return this.input.hostReadbackForTask?.({ run, task, cwd }) ?? null;
  }

  private blockNewAttemptForHarnessRevision(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    cwd: string;
    route: ResolvedExecutionRoute;
    error: unknown;
  }) {
    const attemptId = this.harness.recordAttempt({
      taskId: input.task.id,
      input: {
        sessionName: input.sessionName,
        cwd: input.cwd,
        executor: input.route.backend.kind,
        harnessRevisionValidation: "failed",
      },
      output: blockedHarnessRevisionOutput(input.error),
    });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "blocked",
    });
    return {
      taskId: input.task.id,
      attemptId,
      sessionName: input.sessionName,
      status: "blocked" as const,
      codexSessionId: null,
    };
  }

  private blockNewAttemptForHostExecutionCapability(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    cwd: string;
    route: ResolvedExecutionRoute;
    hostCapabilityInput: Record<string, unknown>;
  }) {
    const problem = hostExecutionCapabilityProblem(input.hostCapabilityInput) ?? "host execution capability is invalid";
    const attemptId = this.harness.recordAttempt({
      taskId: input.task.id,
      input: {
        sessionName: input.sessionName,
        cwd: input.cwd,
        executor: input.route.backend.kind,
        ...input.hostCapabilityInput,
      },
      output: {
        status: "blocked",
        summary: "Host execution capability validation failed before task startup.",
        problems: [problem],
        checks: [{ name: "host execution capability", status: "failed", evidence: problem }],
      },
    });
    this.upsertAttemptThread({ runId: input.run.id, task: input.task, attemptId, sessionName: input.sessionName, cwd: input.cwd, status: "blocked" });
    return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: "blocked" as const, codexSessionId: null };
  }

  private verifierExecutionEnvironmentFor(
    _run: NonNullable<ReturnType<Harness["getRun"]>>,
    task: Task,
    cwd: string,
    route: ResolvedExecutionRoute,
  ) {
    return prepareVerifierExecutionEnvironment({
      verifierContract: task.config?.verifierContract,
      role: task.role,
      backendKind: route.backend.kind,
      cwd,
      databasePath: this.harness.dbPath,
      hostExecutionCapabilities: task.config?.hostExecutionCapabilities,
      host: this.input.verifierExecutionEnvironmentHost,
    });
  }

  private blockNewAttemptForVerifierExecutionEnvironment(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    cwd: string;
    route: ResolvedExecutionRoute;
    error: unknown;
  }) {
    const attemptId = this.harness.recordAttempt({
      taskId: input.task.id,
      input: {
        sessionName: input.sessionName,
        cwd: input.cwd,
        executor: input.route.backend.kind,
        verifierExecutionEnvironmentValidation: "failed",
      },
      output: blockedVerifierExecutionEnvironmentOutput(input.error),
    });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "blocked",
    });
    return {
      taskId: input.task.id,
      attemptId,
      sessionName: input.sessionName,
      status: "blocked" as const,
      codexSessionId: null,
    };
  }

  private blockLeasedTaskPreparationFailure(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    cwd: string;
    error: unknown;
  }) {
    const problem = redactSensitiveText(errorMessage(input.error));
    const attemptId = this.harness.recordAttempt({
      taskId: input.task.id,
      input: {
        sessionName: input.sessionName,
        cwd: input.cwd,
        preparation: "failed-after-lease",
      },
      output: {
        status: "blocked",
        summary: "task preparation failed after its lease was recorded",
        changedFiles: [],
        checks: [{ name: "attempt preparation", status: "failed", evidence: problem }],
        artifacts: [{ type: "leased_task_preparation_failure", taskId: input.task.id }],
        problems: [problem],
      },
    });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "blocked",
    });
    return {
      taskId: input.task.id,
      attemptId,
      sessionName: input.sessionName,
      status: "blocked" as const,
      codexSessionId: null,
    };
  }

  private finishRecoverableControlPlaneFailure(input: {
    attemptId: string;
    task: Task;
    rawOutput: AttemptOutput;
    codexSessionId: string | null;
  }) {
    if (!isRecoverableResumableControlPlaneFailure(input.rawOutput)) {
      return null;
    }
    const reason = resumableControlPlaneFailureReason(input.rawOutput);
    const recovered = this.harness.recoverRunningAttempt({
      attemptId: input.attemptId,
      reason,
      maxRecoveries: 1,
      output: input.rawOutput,
    });
    if (!recovered) {
      return null;
    }
    this.updateAttemptThread({
      attemptId: input.attemptId,
      status: "orphaned",
      agentSessionId: input.codexSessionId,
      heartbeat: true,
    });
    return input.rawOutput;
  }

  private resolveRoute(run: NonNullable<ReturnType<Harness["getRun"]>>, task: Task) {
    return resolveExecutionRoute({
      run,
      task,
      cliAgentBackend: this.input.cliAgentBackend,
      cliExecutor: this.input.cliExecutor ?? "codex-resumable",
      globalModel: this.input.model,
    });
  }

  private createGoalReviewTask(runId: string) {
    const taskId = this.harness.createTask({
      runId,
      role: "goal-review",
      goal: GOAL_REVIEW_TASK_GOAL,
      prompt: GOAL_REVIEW_TASK_PROMPT,
      doneWhen: GOAL_REVIEW_TASK_DONE_WHEN,
    });
    return { created: true as const, taskId };
  }

  private async applyStopHooks(input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: Task;
    sessionName: string;
    prompt: string;
    output: AttemptOutput;
  }) {
    let output = {
      ...input.output,
      checks: [...(input.output.checks ?? [])],
      artifacts: [...(input.output.artifacts ?? [])],
      problems: [...(input.output.problems ?? [])],
    };
    let decision: "continue" | "retry" | "exit" = "exit";
    const hooks = [...(this.input.stopHooksByRole?.[input.task.role] ?? [])];
    for (const hook of hooks) {
      let result: StopHookResult;
      try {
        result = await hook({ ...input, output });
      } catch (error) {
        return { output: stopHookErrorOutput(output, error), decision: "exit" as const };
      }
      output.checks = [...(output.checks ?? []), ...(result.checks ?? [])];
      output.artifacts = [...(output.artifacts ?? []), ...(result.artifacts ?? [])];
      if (result.outputPatch) {
        output = { ...output, ...result.outputPatch };
      }
      if (result.problems && result.problems.length > 0) {
        output.problems = [...(output.problems ?? []), ...result.problems];
        output.status = "blocked";
      }
      if (result.decision === "retry") {
        decision = "retry";
        output.status = "blocked";
      } else if (result.decision === "continue" && decision !== "retry") {
        decision = "continue";
      } else if (result.decision === "exit" && decision !== "retry") {
        decision = "exit";
      }
    }
    return { output, decision };
  }

  private client(input: { model?: string; reasoningEffort?: string; cwd: string; task?: Task; route?: ResolvedExecutionRoute }) {
    if (this.input.clientFactory) {
      return this.input.clientFactory(input);
    }
    return createCodexResumableClient({
      cwd: input.cwd,
      sandbox: input.task?.config?.readOnly === true ? "read-only" : "workspace-write",
      ...this.input.codexOptions,
      browserProcessPolicy: input.task?.role === "goal-review" ? "deny" : this.input.codexOptions?.browserProcessPolicy,
      hostExecutionCapabilities: input.task?.config?.hostExecutionCapabilities,
      taskRole: input.task?.role,
      verifierContract: input.task?.config?.verifierContract,
      timeoutMs: this.input.codexOptions?.timeoutMs ?? this.genericHardMs,
      idleTimeoutMs: this.input.codexOptions?.idleTimeoutMs ?? this.genericIdleMs,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });
  }

  private createAttemptEventRecorder(attemptId: string, eventStream: "codex-json" | "system" = "codex-json"): ExecutorEventRecorder {
    let sequence = Date.now() * 1000;
    const nextSequence = () => {
      sequence += 1;
      return sequence;
    };
    return {
      stdout: (chunk: string) => {
        this.harness.recordAttemptEvent({ attemptId, stream: "stdout", sequence: nextSequence(), text: chunk });
      },
      stderr: (chunk: string) => {
        this.harness.recordAttemptEvent({ attemptId, stream: "stderr", sequence: nextSequence(), text: chunk });
      },
      event: (event: Record<string, unknown>) => {
        this.harness.recordAttemptEvent({ attemptId, stream: eventStream, sequence: nextSequence(), payload: event });
        const sessionId = sessionIdFromEvents([event]);
        if (sessionId) {
          this.rememberAttemptSessionId(attemptId, sessionId);
        }
      },
    };
  }

  private rememberAttemptSessionId(attemptId: string, sessionId: string) {
    const attempt = this.harness.getAttempt(attemptId);
    if (attempt && attempt.input.codexSessionId !== sessionId) {
      this.harness.updateAttemptInput({
        attemptId,
        input: {
          ...attempt.input,
          codexSessionId: sessionId,
        },
      });
    }
    this.updateAttemptThread({ attemptId, agentSessionId: sessionId, heartbeat: true });
  }

  private blockAttemptWithoutResumableSession(input: {
    attemptId: string;
    task: Task;
    sessionName: string;
    result: Extract<CodexResumableResult, { status: "running" }>;
  }) {
    const output: AttemptOutput = {
      status: "blocked",
      summary: "Agent returned running without an agent session id",
      changedFiles: [],
      checks: [{ name: "agent session id", status: "failed" }],
      artifacts: input.result.outputPath ? [{ kind: "codex_output", path: input.result.outputPath }] : [],
      problems: [
        "codex-resumable returned a running state without a session id; automatic retry is disabled because this attempt cannot be resumed",
      ],
    };
    this.harness.finishAttempt({ attemptId: input.attemptId, output });
    this.updateAttemptThread({
      attemptId: input.attemptId,
      status: "blocked",
      agentSessionId: null,
      heartbeat: true,
    });
    return {
      taskId: input.task.id,
      attemptId: input.attemptId,
      sessionName: input.sessionName,
      status: "blocked" as const,
      codexSessionId: null,
    };
  }

  private upsertAttemptThread(input: {
    runId: string;
    task: Task;
    attemptId: string;
    sessionName: string;
    cwd: string;
    status?: ExecutionThreadStatus;
    agentSessionId?: string | null;
  }) {
    return this.harness.upsertExecutionThread({
      id: threadIdForAttempt(input.attemptId),
      runId: input.runId,
      taskId: input.task.id,
      attemptId: input.attemptId,
      ownerType: "runner",
      ownerId: this.ownerId,
      role: input.task.role,
      status: input.status ?? "running",
      pid: this.pid,
      sessionName: input.sessionName,
      agentSessionId: input.agentSessionId ?? null,
      worktreePath: input.cwd,
    });
  }

  private updateAttemptThread(input: {
    attemptId: string;
    status?: ExecutionThreadStatus;
    agentSessionId?: string | null;
    heartbeat?: boolean;
  }) {
    this.harness.updateExecutionThread({
      id: threadIdForAttempt(input.attemptId),
      status: input.status,
      ownerId: this.ownerId,
      pid: this.pid,
      agentSessionId: input.agentSessionId ?? null,
      heartbeat: input.heartbeat,
    });
  }

  private sessionIdForAttempt(attempt: Attempt, thread?: ExecutionThread) {
    const sessionId = typeof attempt.input.codexSessionId === "string" ? attempt.input.codexSessionId : "";
    if (sessionId) {
      return sessionId;
    }

    const recoveredSessionId = thread?.agentSessionId ?? "";
    const eventSessionId = recoveredSessionId || this.sessionIdFromAttemptEvents(attempt.id);
    if (!eventSessionId) {
      return "";
    }

    this.harness.updateAttemptInput({
      attemptId: attempt.id,
      input: {
        ...attempt.input,
        codexSessionId: eventSessionId,
      },
    });
    this.updateAttemptThread({ attemptId: attempt.id, agentSessionId: eventSessionId, heartbeat: true });
    return eventSessionId;
  }

  private sessionIdFromAttemptEvents(attemptId: string) {
    const events = this.harness.listAttemptEvents(attemptId);
    return sessionIdFromEvents(events.flatMap((event) => [
      event.payload,
      ...jsonObjectsFromText(event.text),
    ]));
  }

  private runningAttemptIsFresh(
    session: { startedAt: string | null; events: Array<{ createdAt: string }> } | undefined,
    thread?: { pid: number | null; heartbeatAt?: string | null },
  ) {
    if (thread?.pid && !processIsAlive(thread.pid)) {
      return false;
    }
    const lastEventAt = session?.events.at(-1)?.createdAt;
    const heartbeatAt = parseTimestampMs(lastEventAt) ?? parseTimestampMs(thread?.heartbeatAt) ?? parseTimestampMs(session?.startedAt);
    return heartbeatAt !== null && Date.now() - heartbeatAt < this.staleMs;
  }

  private worktreeFor(task: Task) {
    return this.input.worktreeForTask?.(task);
  }

  private taskOrThrow(taskId: string) {
    const task = this.harness.getTask(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    return task;
  }

  private runOrThrow(runId: string) {
    const run = this.harness.getRun(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }
    return run;
  }
}

function blockedByStartHooks(startResult: StartHookResult): AttemptOutput {
  return {
    status: "blocked",
    summary: "start hooks blocked task execution",
    changedFiles: [],
    checks: startResult.checks ?? [],
    artifacts: startResult.artifacts ?? [],
    problems: startResult.problems ?? [],
  };
}

function attemptInputForRoute(route: ResolvedExecutionRoute, cwd: string) {
  return {
    route,
    backend: route.backend,
    cwd,
    model: route.model,
  };
}

function codexAttemptInput(input: {
  prompt: string;
  sessionName: string;
  result: Pick<CodexResumableResult, "sessionId" | "outputPath" | "stdout" | "stderr" | "events">;
  model: unknown;
  cwd?: string;
}) {
  return {
    prompt: input.prompt,
    sessionName: input.sessionName,
    cwd: input.cwd,
    executor: "codex-resumable",
    model: input.model,
    codexSessionId: input.result.sessionId,
    outputPath: input.result.outputPath,
    stdout: input.result.stdout,
    stderr: input.result.stderr,
    events: input.result.events,
    childEnv: childToolchainEnvEvidence(),
  };
}

function missingResumableSessionOutput(source: string): AttemptOutput {
  return {
    status: "blocked",
    summary: "Running attempt cannot be resumed because it has no agent session id",
    changedFiles: [],
    checks: [{ name: "agent session id", status: "failed", evidence: source }],
    artifacts: [],
    problems: [
      "running attempt is missing an agent session id; automatic retry is disabled because this attempt cannot be resumed safely",
    ],
  };
}

function resumableRunningContinuationCount(input: Record<string, unknown>) {
  const value = input.resumableRunningContinuations;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function resumableContinuationBudgetOutput(limit: number): AttemptOutput {
  const problem = `resumable attempt exhausted ${limit} running continuations without reaching a terminal result`;
  return {
    status: "blocked",
    summary: "Resumable attempt exhausted its bounded continuation budget",
    changedFiles: [],
    checks: [{ name: "resumable continuation budget", status: "failed", evidence: `${limit}/${limit}` }],
    artifacts: [{ kind: "resumable_continuation_budget", limit }],
    problems: [problem],
  };
}

function genericAgentSessionId(route: ResolvedExecutionRoute, sessionName: string) {
  if (route.backend.kind === "acpx") {
    return sessionName;
  }
  return null;
}

function jsonObjectsFromText(text: string | null) {
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function attemptModelPreference(input: Record<string, unknown>): { model: string; reasoning_effort?: string } | null {
  const model = input.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return null;
  }
  const record = model as Record<string, unknown>;
  return typeof record.model === "string" && record.model.trim().length > 0
    ? (record as { model: string; reasoning_effort?: string })
    : null;
}

function withCodexArtifacts(output: AttemptOutput, sessionId: string | null): AttemptOutput {
  if (!sessionId) {
    return output;
  }
  return {
    ...output,
    artifacts: [...(output.artifacts ?? []), { kind: "codex_session", sessionId }],
  };
}

function startHookEvidence(result: StartHookResult) {
  return {
    checks: [...(result.checks ?? [])],
    artifacts: [...(result.artifacts ?? [])],
  };
}

function startHookEvidenceFromAttempt(attempt: Attempt | null): StartHookResult {
  const evidence = attempt?.input.startHookEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {};
  }
  const record = evidence as Record<string, unknown>;
  return {
    checks: Array.isArray(record.checks) ? record.checks : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
  };
}

function applyPostAttemptRunEffects(
  harness: Harness,
  runId: string,
  task: Pick<Task, "role">,
  output: AttemptOutput,
) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
    const completion = describeRunCompletionReadiness(harness.getRunOverview({ runId, eventLimit: 0 }));
    if (completion.blockers.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingVerificationTaskIds: completion.blockers.map((blocker) => blocker.taskId),
          pendingVerificationReason: completion.blockers.map((blocker) => blocker.reason).join("; "),
          goalReviewRefreshedAt: new Date().toISOString(),
        },
      });
      return;
    }
    const readiness = describeIntegrationReadiness(harness, runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
          goalReviewRefreshedAt: new Date().toISOString(),
        },
      });
    } else {
      harness.updateRun({
        runId,
        status: "done",
        contextPatch: {
          goalReviewInvalidatedByIntegration: false,
          goalReviewRefreshedAt: new Date().toISOString(),
        },
      });
    }
  }
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
  }
}

function threadIdForAttempt(attemptId: string) {
  return `thread_${attemptId}`;
}

function runnableRuns(harness: Harness, input: { limit: number; rootRunId?: string | null }) {
  const allRuns = harness.listRuns({ limit: 1000 });
  const scoped = input.rootRunId ? runsInScope(allRuns, input.rootRunId) : allRuns;
  const runnable = [];
  for (const run of scoped) {
    if (run.context.retired === true) {
      continue;
    }
    if (run.status !== "todo" && run.status !== "running") {
      continue;
    }
    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId: run.id, eventLimit: 0 }));
    if (diagnosis.state === "paused" || diagnosis.state === "complete") {
      continue;
    }
    runnable.push(run);
  }
  return selectResourceAwareRuns(runnable, input.limit);
}

function resourceAllocationForRun(run: Run): FrozenResourceAllocationV0 | null {
  if (run.context.resourceAllocation === undefined) {
    return null;
  }
  return parseFrozenResourceAllocationV0(
    run.context.resourceAllocation,
    `run ${run.id} resourceAllocation`,
  );
}

function maybeIntegrateCompletedRun(
  input: Pick<SuperviseCodexRunsInput, "harness" | "cwd" | "integrateCompletedRuns">,
  overview: RunOverview,
): Array<HarnessActionResult & { eventId: string }> | null {
  if (!input.integrateCompletedRuns || !overview.run) {
    return null;
  }
  const boundary = frozenIntegrationBoundary(overview.run.context);
  if (!boundary) {
    return null;
  }
  const preCompletion = overview.run.status !== "done";
  const results: Array<HarnessActionResult & { eventId: string }> = [];
  let integrated = successfulIntegrationState(input.harness, overview.run.id);
  while (true) {
    const worker = selectIntegrationCandidate(overview, integrated);
    if (!worker) {
      break;
    }
    const result = applyHarnessAction(input.harness, {
      type: "integrateVerifiedRun",
      runId: overview.run.id,
      workerTaskId: worker.id,
      repoPath: overview.run.projectRoot ?? overview.project?.rootPath ?? input.cwd,
      targetBranch: boundary.targetBranch,
      push: boundary.push,
      reason: preCompletion
        ? "supervisor integrated verified worker before goal review"
        : "supervisor integrated a completed verified run",
    });
    results.push(result);
    if (result.status !== "done") {
      break;
    }
    integrated = successfulIntegrationState(input.harness, overview.run.id);
  }
  if (results.some((result) => result.status === "done")) {
    input.harness.updateRun({
      runId: overview.run.id,
      status: "todo",
      contextPatch: {
        goalReviewInvalidatedByIntegration: true,
        goalReviewInvalidatedAt: new Date().toISOString(),
      },
    });
  }
  return results;
}

function frozenIntegrationBoundary(context: Record<string, unknown>): { targetBranch: string; push: false } | null {
  const raw = context.integrationBoundary;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const boundary = raw as Record<string, unknown>;
  if (boundary.push !== false) {
    return null;
  }
  const targetBranch = typeof boundary.targetBranch === "string" ? boundary.targetBranch.trim() : "";
  if (!targetBranch) {
    return null;
  }
  return { targetBranch, push: false };
}

function assertNoAmbientIntegrationOverrides(
  input: Pick<RunCodexResumableLoopInput, "integrationTargetBranch" | "integrationPush">,
) {
  if (input.integrationTargetBranch !== undefined || input.integrationPush !== undefined) {
    throw new Error("automatic integration cannot accept ambient target branch or push overrides");
  }
}

interface SuccessfulIntegrationState {
  workerIds: ReadonlySet<string>;
  changedFiles: ReadonlySet<string>;
}

function selectIntegrationCandidate(overview: RunOverview, integrated: SuccessfulIntegrationState = emptyIntegrationState()): Task | null {
  return [...overview.tasks].reverse().find((task) => {
    if (["planner", "verifier", "goal-review"].includes(task.role) || task.status !== "done" || !task.worktreePath) {
      return false;
    }
    if (integrated.workerIds.has(task.id)) {
      return false;
    }
    if (isSupersededByVerifiedRepair(overview, task.id)) {
      return false;
    }
    const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === task.id && candidate.status === "done");
    if (!Array.isArray(session?.output.changedFiles) || session.output.changedFiles.length === 0) {
      return false;
    }
    if (session.output.changedFiles.every((file) => integrated.changedFiles.has(file))) {
      return false;
    }
    return overview.tasks.some((candidate) =>
      candidate.role === "verifier" &&
      candidate.status === "done" &&
      candidate.dependsOn.includes(task.id)
    );
  }) ?? null;
}

function isSupersededByVerifiedRepair(overview: RunOverview, workerTaskId: string) {
  const blockedVerifierIds = overview.tasks
    .filter((task) => task.role === "verifier" && task.status === "blocked" && task.dependsOn.includes(workerTaskId))
    .map((task) => task.id);
  if (blockedVerifierIds.length === 0) {
    return false;
  }

  const repairTaskIds = new Set<string>();
  for (const session of overview.sessions) {
    if (!blockedVerifierIds.includes(session.taskId) || session.status !== "blocked") {
      continue;
    }
    const artifacts = Array.isArray(session.output.artifacts) ? session.output.artifacts : [];
    for (const artifact of artifacts) {
      if (isCreatedRepairTaskArtifact(artifact)) {
        repairTaskIds.add(artifact.taskId);
      }
    }
  }

  for (const repairTaskId of repairTaskIds) {
    const repairTask = overview.tasks.find((task) => task.id === repairTaskId);
    if (repairTask?.status !== "done") {
      continue;
    }
    const repairVerifier = overview.tasks.find((task) =>
      task.role === "verifier" &&
      task.status === "done" &&
      task.dependsOn.includes(repairTaskId)
    );
    if (repairVerifier) {
      return true;
    }
  }
  return false;
}

function successfulIntegrationState(harness: Harness, runId: string): SuccessfulIntegrationState {
  const workerIds = new Set<string>();
  const changedFiles = new Set<string>();
  for (const event of harness.listHarnessActionEvents({ limit: 200 })) {
    if (event.actionType !== "integrateVerifiedRun" || event.status !== "done") {
      continue;
    }
    const request = event.request as Record<string, unknown>;
    if (request.runId !== runId || typeof request.workerTaskId !== "string") {
      continue;
    }
    workerIds.add(request.workerTaskId);
    const result = event.result as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    for (const artifact of artifacts) {
      if (!isIntegrationArtifact(artifact)) {
        continue;
      }
      for (const file of artifact.changedFiles) {
        changedFiles.add(file);
      }
    }
  }
  return { workerIds, changedFiles };
}

function emptyIntegrationState(): SuccessfulIntegrationState {
  return { workerIds: new Set(), changedFiles: new Set() };
}

function isIntegrationArtifact(value: unknown): value is { kind: "integration"; changedFiles: string[] } {
  return typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "integration" &&
    Array.isArray((value as { changedFiles?: unknown }).changedFiles) &&
    (value as { changedFiles: unknown[] }).changedFiles.every((file) => typeof file === "string");
}

function isCreatedRepairTaskArtifact(value: unknown): value is { kind: "created_repair_task"; taskId: string } {
  return typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "created_repair_task" &&
    typeof (value as { taskId?: unknown }).taskId === "string";
}

function runsInScope(runs: ReturnType<Harness["listRuns"]>, rootRunId: string) {
  const included = new Set([rootRunId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      const parentRunId = typeof run.context.parentRunId === "string" ? run.context.parentRunId : null;
      if (parentRunId && included.has(parentRunId) && !included.has(run.id)) {
        included.add(run.id);
        changed = true;
      }
    }
  }
  return runs.filter((run) => included.has(run.id));
}

function runStatusCounts(harness: Harness) {
  const counts = { todo: 0, running: 0, done: 0, blocked: 0 };
  for (const run of harness.listRuns({ limit: 1000 })) {
    counts[run.status] += 1;
  }
  return counts;
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecoverableResumableControlPlaneFailure(output: AttemptOutput) {
  if (output.status !== "blocked") {
    return false;
  }
  if ((output.artifacts ?? []).some((artifact) => (
    artifact != null
    && typeof artifact === "object"
    && (artifact as Record<string, unknown>).kind === "local_process_termination"
  ))) {
    return true;
  }
  return (output.problems ?? []).some((problem) => /no rollout found for thread id/i.test(problem));
}

function resumableControlPlaneFailureReason(output: AttemptOutput) {
  const missingRollout = [...(output.problems ?? [])].reverse().find((problem) =>
    /no rollout found for thread id/i.test(problem)
  );
  if (missingRollout) {
    return "resumable session rollout is missing; source attempt was terminalized before bounded same-role recovery";
  }
  const termination = (output.artifacts ?? []).find((artifact) => (
    artifact != null
    && typeof artifact === "object"
    && (artifact as Record<string, unknown>).kind === "local_process_termination"
  )) as Record<string, unknown> | undefined;
  const reason = typeof termination?.reason === "string" ? termination.reason : "child-exited";
  return `local resumable child exited without terminal output (${reason}); source attempt was terminalized before bounded same-role recovery`;
}

function directResumeClaimFromAttempt(attempt: Attempt) {
  const value = attempt.input.directResumeClaim;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const claim = value as Record<string, unknown>;
  if (
    typeof claim.token !== "string"
    || claim.token.length === 0
    || typeof claim.pid !== "number"
    || !Number.isInteger(claim.pid)
    || claim.pid <= 0
  ) {
    return null;
  }
  return { token: claim.token, pid: claim.pid };
}

function stopHookErrorOutput(rawOutput: AttemptOutput, error: unknown): AttemptOutput {
  const rawSummary = typeof rawOutput.summary === "string" && rawOutput.summary.length > 0
    ? rawOutput.summary
    : "Codex output";
  return {
    ...rawOutput,
    status: "blocked",
    summary: `stop hook failed after ${rawSummary}`,
    checks: [...(rawOutput.checks ?? []), { name: "stop hook", status: "failed" }],
    problems: [...(rawOutput.problems ?? []), `stop hook threw: ${redactSensitiveText(errorMessage(error))}`],
  };
}

function redactSensitiveText(value: string) {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|lin_api|lin_oauth)[_-][A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(
      /(\bauthorization\b\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(x-access-token\s*:\s*)[^@\s]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\])]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s+)(?=[^\s,;}\])]*[._~+\/-])[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unrefTimer(timer: ReturnType<typeof setInterval>) {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hostExecutionCapabilityProblem(input: Record<string, unknown>) {
  const receipt = input.hostExecutionCapability;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const record = receipt as Record<string, unknown>;
  return record.status === "invalid"
    ? (typeof record.problem === "string" ? record.problem : "host execution capability is invalid")
    : null;
}

function blockedResumeContractOutput(error: unknown): AttemptOutput {
  const problem = errorMessage(error);
  return {
    status: "blocked",
    summary: "Frozen execution contract validation failed before resume.",
    problems: [problem],
    checks: [{ name: "frozen execution contract", status: "failed", evidence: problem }],
  };
}

/**
 * The resume path intentionally calls this only after existing attempts have
 * been resumed. A stale generation may drain those attempts, but it cannot
 * claim a new task until a fresh process has attested its source.
 */
export function runtimeGenerationAllowsLeasing(run: Run | null, cwd: string, harness?: Harness): boolean {
  const runtimeRun = runtimeGenerationRun(run, harness);
  const raw = runtimeRun?.context.controlPlaneRuntime;
  if (raw === undefined) {
    return true;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const runtime = raw as RuntimeGenerationContext;
  if (runtime.state !== "current" && runtime.state !== "reloaded") {
    return false;
  }
  if (
    typeof runtime.generation !== "number" || !Number.isInteger(runtime.generation) || runtime.generation < 1
    || typeof runtime.sourceRoot !== "string" || runtime.sourceRoot.length === 0
    || typeof runtime.launchHead !== "string" || runtime.launchHead.length === 0
    || typeof runtime.promptContractHash !== "string" || runtime.promptContractHash.length === 0
    || runtime.attestedGeneration !== runtime.generation
    || runtime.attestedHead !== runtime.launchHead
    || runtime.attestedPromptContractHash !== runtime.promptContractHash
    || runtime.processIdentity !== String(process.pid)
    || runtime.attestedProcessIdentity !== String(process.pid)
  ) {
    return false;
  }
  const observedHead = gitHead(runtime.sourceRoot || cwd);
  return observedHead === runtime.launchHead
    && protectedPromptContractFingerprintForSource(runtime.sourceRoot) === runtime.promptContractHash;
}

function runtimeGenerationRun(run: Run | null, harness?: Harness): Run | null {
  if (!run || !harness) {
    return run;
  }
  const chain: Run[] = [];
  const visited = new Set<string>();
  let current: Run | null = run;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    const parentRunId: string | null = typeof current.context.parentRunId === "string"
      ? current.context.parentRunId
      : null;
    current = parentRunId ? harness.getRun(parentRunId) : null;
  }
  return [...chain].reverse().find((candidate) => candidate.context.controlPlaneRuntime !== undefined) ?? run;
}

function gitHead(cwd: string): string | null {
  try {
    const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd, stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    const head = new TextDecoder().decode(result.stdout).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}
