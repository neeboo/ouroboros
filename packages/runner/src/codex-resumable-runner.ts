import {
  applyHarnessAction,
  describeIntegrationReadiness,
  diagnoseRunOverview,
  type Attempt,
  type AttemptOutput,
  type ExecutionThread,
  type ExecutionThreadStatus,
  type Harness,
  type HarnessActionResult,
  type RunOverview,
  type Task,
} from "@ouroboros/harness";
import { buildTaskPrompt } from "./prompt";
import { applyStartHooks } from "./runner";
import { createCodexResumableClient, sessionIdFromEvents } from "./executors/codex-resumable";
import type { CodexResumableClientOptions, CodexResumableResult } from "./executors/codex-resumable";
import { childToolchainEnvEvidence } from "./executors/proxy-env";
import { createRouteExecutor } from "./route-executor";
import { resolveExecutionRoute } from "./execution-routing";
import type { ResolvedExecutionRoute } from "./execution-routing";
import type { ExecutorEventRecorder, StartHook, StartHookResult, StopHook, TaskExecutorFactory } from "./types";

const DEFAULT_RUNNING_ATTEMPT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HEARTBEAT_MS = 30 * 1000;

export type CodexResumableClientFactory = (input: {
  model?: string;
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
  codexOptions?: Partial<CodexResumableClientOptions>;
  ownerId?: string;
  pid?: number;
  runningAttemptStaleMs?: number;
  genericAttemptIdleTimeoutMs?: number;
  genericAttemptHardTimeoutMs?: number;
  genericAttemptHeartbeatMs?: number;
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
  const orchestrator = new CodexResumableOrchestrator(input);
  const rounds = [];
  for (let index = 0; index < input.maxRounds; index += 1) {
    const reclaimed = input.harness.reclaimRunningTasksWithoutAttempts({ runId: input.runId });
    const resumed = await orchestrator.resumeRunningAttempts({ runId: input.runId, limit: input.limit });
    if (resumed.length > 0) {
      rounds.push({ index, tasks: resumed, reclaimed });
      if (resumed.some((task) => task.status === "running")) {
        break;
      }
      continue;
    }

    const started = await orchestrator.startReadyAttempts({ runId: input.runId, limit: input.limit });
    if (started.length === 0) {
      const overviewBeforeReview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
      const integration = maybeIntegrateCompletedRun(input, overviewBeforeReview);
      if (integration?.some((result) => result.status === "done")) {
        rounds.push({ index, tasks: started, integration, reclaimed });
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
          rounds.push({ index, tasks: reviewed, goalReview: drain, reclaimed });
          if (reviewed.some((task) => task.status === "running")) {
            break;
          }
          continue;
        }
      }
      break;
    }
    rounds.push({ index, tasks: started, reclaimed });
    if (started.some((task) => task.status === "running")) {
      break;
    }
  }
  return { rounds };
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
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const candidates = runnableRuns(input.harness, { limit: input.runConcurrency, rootRunId: input.rootRunId ?? null });
    if (candidates.length === 0) {
      return { status: "idle" as const, cycles };
    }
    const results = await Promise.all(candidates.map(async (run) => {
      const result = await runCodexResumableLoop({
        ...input,
        runId: run.id,
        maxRounds: input.maxRounds,
        limit: input.taskConcurrency,
        maxTries: input.maxTries,
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

  constructor(private readonly input: CodexResumableOrchestrationInput) {
    this.harness = input.harness;
    this.cwd = input.cwd ?? process.cwd();
    this.ownerId = input.ownerId ?? String(process.pid);
    this.pid = input.pid ?? process.pid;
    this.staleMs = input.runningAttemptStaleMs ?? DEFAULT_RUNNING_ATTEMPT_STALE_MS;
    this.genericIdleMs = input.genericAttemptIdleTimeoutMs ?? DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS;
    this.genericHardMs = input.genericAttemptHardTimeoutMs ?? DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS;
    this.genericHeartbeatMs = input.genericAttemptHeartbeatMs ?? DEFAULT_GENERIC_ATTEMPT_HEARTBEAT_MS;
  }

  async startAttempt(taskId: string) {
    const task = this.taskOrThrow(taskId);
    const run = this.runOrThrow(task.runId);
    this.harness.clearRunPause(run.id);
    const sessionName = task.sessionRef ?? `task-${task.id}`;
    const prompt = this.promptForTask(run, task);
    const route = this.resolveRoute(run, task);
    const cwd = task.worktreePath ?? this.worktreeFor(task) ?? this.cwd;
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
    const attempt = this.harness.getAttempt(attemptId);
    if (!attempt) {
      throw new Error(`attempt not found: ${attemptId}`);
    }
    const task = this.taskOrThrow(attempt.taskId);
    const run = this.runOrThrow(task.runId);
    this.harness.clearRunPause(run.id);
    const sessionId = this.sessionIdForAttempt(
      attempt,
      this.harness.listExecutionThreads({ runId: run.id }).find((thread) => thread.attemptId === attemptId),
    );
    if (!sessionId) {
      const output = missingResumableSessionOutput("direct resume");
      this.harness.finishAttempt({ attemptId, output });
      this.updateAttemptThread({ attemptId, status: "blocked", agentSessionId: null, heartbeat: true });
      return { attemptId, status: "blocked" as const, codexSessionId: null };
    }
    const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attemptId}`;
    const prompt = promptOverride ?? "Continue until you can return the required structured JSON.";
    const resolvedModel = attemptModelPreference(attempt.input);
    const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? this.cwd;
    const recorder = this.createAttemptEventRecorder(attemptId);
    const result = await this.client({ model: resolvedModel?.model, cwd, task }).resume({
      sessionId,
      sessionName,
      prompt,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    this.harness.updateAttemptInput({
      attemptId,
      input: {
        ...attempt.input,
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
      return { attemptId, status: "running" as const, codexSessionId: resumedSessionId };
    }
    this.harness.finishAttempt({
      attemptId,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    return { attemptId, status: result.status, codexSessionId: result.sessionId };
  }

  async resumeRunningAttempts(input: { runId: string; limit: number }) {
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
      const thread = threadsByAttemptId.get(attempt.id);
      const sessionId = this.sessionIdForAttempt(attempt, thread);
      if (!sessionId) {
        const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
        const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? this.cwd;
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
      const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
      const prompt =
        typeof attempt.input.prompt === "string"
          ? attempt.input.prompt
          : "Continue until you can return the required structured JSON.";
      const resolvedModel = attemptModelPreference(attempt.input);
      const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? this.cwd;
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
      const result = await this.client({ model: resolvedModel?.model, cwd, task }).resume({
        sessionId,
        sessionName,
        prompt,
        onStdout: recorder.stdout,
        onStderr: recorder.stderr,
        onEvent: recorder.event,
      });
      this.harness.updateAttemptInput({
        attemptId: attempt.id,
        input: {
          ...attempt.input,
          ...codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
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
        return { taskId: task.id, attemptId: attempt.id, sessionName, status: "running" as const, codexSessionId: resumedSessionId };
      }
      const { output, decision } = await this.applyStopHooks({
        run,
        task,
        sessionName,
        prompt,
        output: withCodexArtifacts(result.output, result.sessionId),
      });
      this.harness.finishAttempt({ attemptId: attempt.id, output });
      applyPostAttemptRunEffects(this.harness, run.id, task, output);
      this.updateAttemptThread({ attemptId: attempt.id, status: output.status, agentSessionId: result.sessionId, heartbeat: true });
      if (decision === "retry") {
        this.harness.retryTask({ taskId: task.id });
      }
      return { taskId: task.id, attemptId: attempt.id, sessionName, status: output.status, codexSessionId: result.sessionId };
    }));
    return tasks.filter((task) => task !== null);
  }

  async startReadyAttempts(input: { runId: string; limit: number }) {
    const run = this.runOrThrow(input.runId);
    this.harness.clearRunPause(run.id);
    const leased = this.harness.leaseReadyTasks({
      runId: input.runId,
      limit: input.limit,
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: this.input.worktreeForTask,
    });
    return Promise.all(leased.map(async (task) => {
      const sessionName = task.sessionRef ?? `task-${task.id}`;
      const prompt = this.promptForTask(run, task);
      const route = this.resolveRoute(run, task);
      const cwd = task.worktreePath ?? this.cwd;
      const baseInput = {
        prompt,
        sessionName,
        executor: route.backend.kind,
        ...attemptInputForRoute(route, cwd),
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
    const attemptId = this.harness.startAttempt({ taskId: input.task.id, input: input.baseInput });
    this.upsertAttemptThread({
      runId: input.run.id,
      task: input.task,
      attemptId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      status: "running",
    });
    const recorder = this.createAttemptEventRecorder(attemptId);
    const result = await this.client({
      model: input.route.model?.model,
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
        ...codexAttemptInput({ prompt: input.prompt, sessionName: input.sessionName, result, model: input.route.model, cwd: input.cwd }),
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
    const { output, decision } = await this.applyStopHooks({
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      prompt: input.prompt,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    this.harness.finishAttempt({
      attemptId,
      output: {
        ...output,
        checks: [...(input.startResult.checks ?? []), ...(output.checks ?? [])],
        artifacts: [...(input.startResult.artifacts ?? []), ...(output.artifacts ?? [])],
      },
    });
    const finishedAttempt = this.harness.getAttempt(attemptId);
    applyPostAttemptRunEffects(this.harness, input.run.id, input.task, finishedAttempt?.output ?? output);
    this.updateAttemptThread({ attemptId, status: output.status, agentSessionId: result.sessionId, heartbeat: true });
    if (decision === "retry") {
      this.harness.retryTask({ taskId: input.task.id });
    }
    return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: output.status, codexSessionId: result.sessionId };
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
    const { output, decision } = await this.applyStopHooks({
      run: input.run,
      task: input.task,
      sessionName: input.sessionName,
      prompt: input.prompt,
      output: rawOutput,
    });
    output.checks = [...(input.startResult.checks ?? []), ...(output.checks ?? [])];
    output.artifacts = [...(input.startResult.artifacts ?? []), ...(output.artifacts ?? [])];
    this.harness.finishAttempt({ attemptId, output });
    const finishedAttempt = this.harness.getAttempt(attemptId);
    applyPostAttemptRunEffects(this.harness, input.run.id, input.task, finishedAttempt?.output ?? output);
    this.updateAttemptThread({ attemptId, status: output.status, heartbeat: true });
    if (decision === "retry") {
      this.harness.retryTask({ taskId: input.task.id });
    }
    return { taskId: input.task.id, attemptId, sessionName: input.sessionName, status: output.status, codexSessionId: null };
  }

  private promptForTask(run: NonNullable<ReturnType<Harness["getRun"]>>, task: Task) {
    return buildTaskPrompt({
      run,
      task,
      dependencyAttempts: task.dependsOn.length > 0 ? this.harness.listLatestAttemptsForTasks(task.dependsOn) : [],
      lessons: this.harness.listLessons({ runId: run.id }),
      template: this.harness.getPromptTemplate("task")?.contentMd,
    });
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
      goal: "Review whether the run goal is complete",
      prompt: [
        "Answer this before creating more work: are we sure the original run goal has been reached?",
        "",
        "Inspect the repository, README, tests, dashboard state, recent attempts, and run lessons.",
        "Before choosing a runDecision, cite concrete evidence from repository files or docs, tests or commands, dashboard or run overview state, and recent lessons.",
        "Do not declare runDecision complete unless the summary, checks, artifacts, or problems cite that evidence before declaring complete.",
        "Return structured JSON with one of these decisions:",
        "- runDecision complete: the run goal is satisfied; do not include nextTasks.",
        "- runDecision continue: the run goal is not satisfied; include one to five nextTasks items, usually planners or workers with verifiers.",
        "- runDecision verify: completion is uncertain; include one to five verifier nextTasks items.",
        "- runDecision defer: the run goal is not satisfied, but progress is blocked by an external dependency or missing user/system action; do not include nextTasks.",
      ].join("\n"),
      doneWhen: [
        "runDecision is complete, continue, verify, or defer",
        "completion decision cites concrete evidence from repository files or docs, tests or commands, dashboard or run overview state, and recent lessons",
        "complete does not create nextTasks",
        "defer does not create nextTasks and cites the external dependency or missing action",
        "continue or verify includes one to five nextTasks items",
      ],
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
      const result = await hook({ ...input, output });
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

  private client(input: { model?: string; cwd: string; task?: Task; route?: ResolvedExecutionRoute }) {
    if (this.input.clientFactory) {
      return this.input.clientFactory(input);
    }
    return createCodexResumableClient({
      cwd: input.cwd,
      sandbox: "workspace-write",
      ...this.input.codexOptions,
      model: input.model,
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

function attemptModelPreference(input: Record<string, unknown>): { model: string } | null {
  const model = input.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return null;
  }
  const record = model as Record<string, unknown>;
  return typeof record.model === "string" && record.model.trim().length > 0 ? (record as { model: string }) : null;
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

function applyPostAttemptRunEffects(
  harness: Harness,
  runId: string,
  task: Pick<Task, "role">,
  output: AttemptOutput,
) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
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
  const runs = harness.listRuns({ statuses: ["todo", "running"], limit: 500 });
  const scoped = input.rootRunId ? runsInScope(runs, input.rootRunId) : runs;
  const runnable = [];
  for (const run of scoped) {
    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId: run.id, eventLimit: 0 }));
    if (diagnosis.state === "paused" || diagnosis.state === "blocked" || diagnosis.state === "complete") {
      continue;
    }
    runnable.push(run);
    if (runnable.length >= input.limit) {
      break;
    }
  }
  return runnable;
}

function maybeIntegrateCompletedRun(
  input: Pick<SuperviseCodexRunsInput, "harness" | "cwd" | "integrateCompletedRuns" | "integrationTargetBranch" | "integrationPush">,
  overview: RunOverview,
): Array<HarnessActionResult & { eventId: string }> | null {
  if (!input.integrateCompletedRuns || !overview.run) {
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
      targetBranch: input.integrationTargetBranch ?? "main",
      push: input.integrationPush ?? false,
      reason: preCompletion
        ? "supervisor integrated verified worker before goal review"
        : "supervisor integrated a completed verified run",
    });
    results.push(result);
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
