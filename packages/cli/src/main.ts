#!/usr/bin/env bun
import { applyHarnessAction, Harness } from "@ouroboros/harness";
import type { AttemptOutput } from "@ouroboros/harness";
import {
  buildTaskPrompt,
  applyStartHooks,
  createAcpxAgentExecutor,
  createCodexCliExecutor,
  createCodexResumableClient,
  createContextSummaryHook,
  createGitWorktreeHook,
  createGoalReviewDecisionHook,
  createRepairTaskHook,
  createRunsFromOutputHook,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  proxyEnvForChildProcess,
  resolveAgentBackend,
  resolveModelPreference,
  runReadyTasks,
  runUntilIdle,
} from "@ouroboros/runner";
import type { ResolvedAgentBackend, StopHook } from "@ouroboros/runner";
import { fail, flag, parseArgs, required } from "./args";
import { loadOuroborosConfig } from "./config";
import { parseArray, parseObject, printJson } from "./json";
import { checkLinearAccess, linkLinearIssue } from "./linear";
import { serveDashboard } from "./dashboard";
import { requestHarnessAction, serveHarnessActions } from "./action-server";
import { join } from "node:path";
import type { ExecutionThreadStatus, Task } from "@ouroboros/harness";

const parsed = parseArgs(Bun.argv.slice(2));
const harness = new Harness(parsed.db);
const DEFAULT_MAX_TRIES = 3;
const DEFAULT_SELF_ITERATION_CONCURRENCY = 3;
const DEFAULT_SELF_ITERATION_WORKTREE_ROOT = ".ouroboros/worktrees";
const RUNNING_ATTEMPT_STALE_MS = 5 * 60 * 1000;
const SELF_ITERATION_GOAL = "Use Ouroboros to plan its own next self-iteration cycle";
const SELF_ITERATION_PLAN_DOC = "docs/self-iteration-plan.md";
const DEFAULT_STOP_HOOKS = "create-runs,create-tasks,create-verifier,create-repair,context-summary";
const SELF_ITERATION_PLANNER_DONE_WHEN = [
  "Planner output contains a small nextTasks graph, usually two to five tasks across two to three independent areas when possible",
  "Every planned task has one role, one concrete goal, and one prompt with exact files or commands to inspect first",
  "The task graph includes explicit dependsOn when ordering matters and each task has three to five doneWhen checks",
  "Every planned task identifies a clear artifact, code change, test, or decision",
  "The graph includes natural failure paths through verifier, repair, or another planner and can be drained by run-loop",
];

switch (parsed.command) {
  case "init": {
    harness.init();
    printJson({ db: parsed.db, status: "initialized" });
    break;
  }
  case "self-iterate": {
    const { runId, taskId } = createSelfIterationBootstrap();
    printJson({
      runId,
      taskId,
      dashboardCommand: cliCommand("dashboard", "--run-id", runId, "--port", "7331"),
      runnerCommand: cliCommand(
        "run-loop",
        "--run-id",
        runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        "$(pwd)",
        "--sandbox",
        "workspace-write",
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--concurrency",
        String(DEFAULT_SELF_ITERATION_CONCURRENCY),
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
        "--max-rounds",
        "8",
      ),
      launchCommand: cliCommand(
        "self-iterate-launch",
        "--port",
        "7331",
        "--concurrency",
        String(DEFAULT_SELF_ITERATION_CONCURRENCY),
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
      ),
    });
    break;
  }
  case "self-iterate-launch": {
    const { runId, taskId } = createSelfIterationBootstrap();
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7331", "--port");
    const selfIterationWorktreeArgs = defaultSelfIterationWorktreeArgs();
    const dashboard = createDashboardRuntime({
      runId,
      port,
      defaultConcurrency: DEFAULT_SELF_ITERATION_CONCURRENCY,
      defaultWorktreeRoot: DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
      defaultStartHook: "git-worktree",
    });
    const runner = dashboard.startRunner();
    printJson({
      runId,
      taskId,
      dashboardUrl: `http://localhost:${dashboard.server.port}`,
      runnerPid: runner.pid ?? null,
      runnerStatus: dashboard.runnerStatus(),
      dashboardCommand: cliCommand("dashboard", "--run-id", runId, "--port", String(port)),
      runnerCommand: cliCommand(
        "run-loop",
        "--run-id",
        runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        "$(pwd)",
        "--sandbox",
        "workspace-write",
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--concurrency",
        flag(parsed, "concurrency") ?? flag(parsed, "limit") ?? String(DEFAULT_SELF_ITERATION_CONCURRENCY),
        ...selfIterationWorktreeArgs,
        "--max-rounds",
        "8",
      ),
    });
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "create-project": {
    const name = required(parsed, "name");
    const rootPath = required(parsed, "root-path");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const id = harness.createProject({ name, rootPath, context });
    printJson(harness.getProject(id));
    break;
  }
  case "create-run": {
    const goal = required(parsed, "goal");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const id = harness.createRun({
      goal,
      context,
      projectId: flag(parsed, "project-id") ?? null,
      projectRoot: flag(parsed, "project-root") ?? null,
    });
    const run = harness.getRun(id);
    printJson({ id, goal, status: "todo", projectId: run?.projectId ?? null, projectRoot: run?.projectRoot ?? null });
    break;
  }
  case "list-runs": {
    const statuses = (flag(parsed, "status") ?? "")
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean) as Array<"todo" | "running" | "done" | "blocked">;
    printJson(harness.listRuns({
      statuses: statuses.length ? statuses : undefined,
      limit: parsePositiveInteger(flag(parsed, "limit") ?? "100", "--limit"),
    }));
    break;
  }
  case "intake": {
    const document = required(parsed, "document");
    const title = flag(parsed, "title") ?? compactForTitle(document, 80);
    const result = createIntakeRun({ title, document });
    printJson({
      ...result,
      supervisorCommand: cliCommand(
        "supervise-runs",
        "--executor",
        "codex-resumable",
        "--root-run-id",
        result.runId,
        "--sandbox",
        "workspace-write",
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--run-concurrency",
        "2",
        "--concurrency",
        String(DEFAULT_SELF_ITERATION_CONCURRENCY),
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
      ),
    });
    break;
  }
  case "create-task": {
    const runId = required(parsed, "run-id");
    const role = required(parsed, "role");
    const goal = required(parsed, "goal");
    const prompt = required(parsed, "prompt");
    const dependsOn = parseArray(flag(parsed, "depends-on-json") ?? "[]");
    const doneWhen = parseArray(flag(parsed, "done-when-json") ?? "[]");
    const config = parseObject(flag(parsed, "config-json") ?? "{}");
    const parentId = flag(parsed, "parent-id") ?? null;
    const id = harness.createTask({
      runId,
      role,
      goal,
      prompt,
      dependsOn,
      doneWhen,
      config,
      parentId,
    });
    printJson({ id, runId, role, goal, status: "todo" });
    break;
  }
  case "next-task": {
    printJson(harness.nextReadyTask(required(parsed, "run-id")));
    break;
  }
  case "link-external": {
    const localType = required(parsed, "local-type");
    const localId = required(parsed, "local-id");
    const provider = required(parsed, "provider");
    const externalType = required(parsed, "external-type");
    const externalId = required(parsed, "external-id");
    const externalUrl = flag(parsed, "external-url") ?? null;
    const id = harness.createExternalRef({
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    printJson({
      id,
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    break;
  }
  case "action": {
    harness.init();
    const action = parseObject(required(parsed, "action-json"));
    printJson(applyHarnessAction(harness, action));
    break;
  }
  case "action-events": {
    harness.init();
    printJson(harness.listHarnessActionEvents({
      limit: parsePositiveInteger(flag(parsed, "limit") ?? "50", "--limit"),
    }));
    break;
  }
  case "action-server": {
    harness.init();
    const host = flag(parsed, "host") ?? "127.0.0.1";
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7332", "--port");
    const token = flag(parsed, "token") ?? process.env.ORBS_ACTION_TOKEN ?? null;
    const server = serveHarnessActions({ harness, host, port, token });
    printJson({
      status: "running",
      url: `http://${host}:${server.port}`,
      host,
      port: server.port,
      tokenRequired: Boolean(token),
    });
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "action-request": {
    const action = parseObject(required(parsed, "action-json"));
    const result = await requestHarnessAction({
      url: required(parsed, "url"),
      action,
      token: flag(parsed, "token") ?? process.env.ORBS_ACTION_TOKEN ?? null,
    });
    printJson(result);
    break;
  }
  case "linear-check": {
    harness.init();
    const config = await loadOuroborosConfig(flag(parsed, "config") ?? "ouroboros.toml");
    const linear = config.linear ?? {};
    const result = await checkLinearAccess({
      harness,
      runId: flag(parsed, "run-id") ?? null,
      projectUrl: flag(parsed, "project-url") ?? linear.projectUrl ?? null,
      projectId: flag(parsed, "project-id") ?? linear.projectId ?? null,
      teamKey: flag(parsed, "team-key") ?? linear.teamKey ?? null,
      tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
      tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
      apiUrl: flag(parsed, "api-url") ?? linear.apiUrl ?? null,
    });
    printJson(result);
    break;
  }
  case "linear-link-issue": {
    harness.init();
    try {
      const ref = linkLinearIssue({
        harness,
        localType: required(parsed, "local-type"),
        localId: required(parsed, "local-id"),
        issueId: flag(parsed, "issue-id") ?? null,
        issueKey: flag(parsed, "issue-key") ?? null,
        issueUrl: flag(parsed, "issue-url") ?? null,
      });
      printJson(ref);
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "list-lessons": {
    printJson(harness.listLessons({ runId: required(parsed, "run-id") }));
    break;
  }
  case "show-prompt-template": {
    const template = harness.getPromptTemplate(required(parsed, "key"));
    if (!template) {
      fail("prompt template not found");
    }
    printJson(template);
    break;
  }
  case "show-task-prompt": {
    console.log(renderTaskPrompt(required(parsed, "task-id")));
    break;
  }
  case "set-prompt-template": {
    const template = harness.setPromptTemplate({
      key: required(parsed, "key"),
      contentMd: required(parsed, "content"),
    });
    printJson(template);
    break;
  }
  case "run-next": {
    const executorName = cliExecutorName();
    const runId = required(parsed, "run-id");
    const limit = parseConcurrency();
    if (usesCodexResumablePath(executorName)) {
      const maxTries = parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries");
      const result = await runCodexResumableLoop({ runId, maxRounds: 1, limit, maxTries });
      printJson({ tasks: result.rounds.flatMap((round) => round.tasks) });
      break;
    }
    const result = await runReadyTasks({
      harness,
      runId,
      limit,
      model: flag(parsed, "model"),
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
      attemptInput: attemptInputFactory(executorName),
      stopHooksByRole: stopHooksByRole(),
    });
    printJson({ tasks: result });
    break;
  }
  case "run-loop": {
    const executorName = cliExecutorName();
    const runId = required(parsed, "run-id");
    const limit = parseConcurrency();
    const maxRounds = parsePositiveInteger(flag(parsed, "max-rounds") ?? "10", "--max-rounds");
    const maxTries = parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries");
    if (usesCodexResumablePath(executorName)) {
      printJson(await runCodexResumableLoop({ runId, maxRounds, limit, maxTries }));
      break;
    }
    const result = await runUntilIdle({
      harness,
      runId,
      limit,
      maxRounds,
      model: flag(parsed, "model"),
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
      attemptInput: attemptInputFactory(executorName),
      stopHooksByRole: stopHooksByRole(),
    });
    printJson(result);
    break;
  }
  case "autopilot": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("autopilot currently supports codex-resumable");
    }
    printJson(
      await runAutopilot({
        runId: required(parsed, "run-id"),
        limit: parseConcurrency(),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      }),
    );
    break;
  }
  case "supervise-runs": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("supervise-runs currently supports codex-resumable");
    }
    printJson(
      await superviseRuns({
        rootRunId: flag(parsed, "root-run-id") ?? null,
        runConcurrency: parsePositiveInteger(flag(parsed, "run-concurrency") ?? "2", "--run-concurrency"),
        taskConcurrency: parseConcurrency(),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      }),
    );
    break;
  }
  case "supervise-daemon": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("supervise-daemon currently supports codex-resumable");
    }
    const result = await superviseDaemon({
      rootRunId: flag(parsed, "root-run-id") ?? null,
      runConcurrency: parsePositiveInteger(flag(parsed, "run-concurrency") ?? "2", "--run-concurrency"),
      taskConcurrency: parseConcurrency(),
      tickCycles: parsePositiveInteger(flag(parsed, "tick-cycles") ?? flag(parsed, "max-cycles") ?? "1", "--tick-cycles"),
      maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
      maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
      intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      idleMs: parseNonNegativeInteger(flag(parsed, "idle-ms") ?? flag(parsed, "interval-ms") ?? "1500", "--idle-ms"),
      maxTicks: parseNonNegativeInteger(flag(parsed, "max-ticks") ?? "0", "--max-ticks"),
    });
    printJson(result);
    break;
  }
  case "record-attempt": {
    const taskId = required(parsed, "task-id");
    const input = parseObject(flag(parsed, "input-json") ?? "{}");
    const output = parseObject(flag(parsed, "output-json") ?? "{}");
    const attemptId = harness.recordAttempt({
      taskId,
      input,
      output: {
        status: output.status as "done" | "blocked",
        runDecision: parseOptionalRunDecision(output.runDecision),
        summary: String(output.summary ?? ""),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: Array.isArray(output.problems) ? output.problems.map(String) : [],
      },
    });
    const attempt = harness.getAttempt(attemptId);
    const task = attempt ? harness.getTask(attempt.taskId) : null;
    if (attempt && task) {
      applyCliPostAttemptRunEffects(task.runId, task, attempt.output);
    }
    printJson({
      attemptId,
      taskId,
      status: output.status,
    });
    break;
  }
  case "start-attempt": {
    const taskId = required(parsed, "task-id");
    const input = parseObject(flag(parsed, "input-json") ?? "{}");
    const attemptId = harness.startAttempt({
      taskId,
      input,
    });
    printJson({
      attemptId,
      taskId,
      status: "running",
    });
    break;
  }
  case "finish-attempt": {
    const attemptId = required(parsed, "attempt-id");
    const output = parseObject(flag(parsed, "output-json") ?? "{}");
    harness.finishAttempt({
      attemptId,
      output: {
        status: output.status as "done" | "blocked",
        summary: String(output.summary ?? ""),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: Array.isArray(output.problems) ? output.problems.map(String) : [],
      },
    });
    const attempt = harness.getAttempt(attemptId);
    const task = attempt ? harness.getTask(attempt.taskId) : null;
    if (attempt && task) {
      applyCliPostAttemptRunEffects(task.runId, task, attempt.output);
    }
    printJson({
      attemptId,
      status: output.status,
    });
    break;
  }
  case "list-running-attempts": {
    printJson(harness.listRunningAttempts({ runId: required(parsed, "run-id") }));
    break;
  }
  case "run-overview": {
    printJson(
      harness.getRunOverview({
        runId: required(parsed, "run-id"),
        eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      }),
    );
    break;
  }
  case "dashboard": {
    const runId = required(parsed, "run-id");
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7331", "--port");
    harness.init();
    const dashboard = createDashboardRuntime({ runId, port });
    console.log(`Ouroboros dashboard: http://localhost:${dashboard.server.port}`);
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "codex-start-attempt": {
    const taskId = required(parsed, "task-id");
    const task = harness.getTask(taskId);
    if (!task) {
      fail(`task not found: ${taskId}`);
    }
    const run = harness.getRun(task.runId);
    if (!run) {
      fail(`run not found: ${task.runId}`);
    }
    const sessionName = task.sessionRef ?? `task-${task.id}`;
    const prompt = buildTaskPrompt({
      run,
      task,
      dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
      lessons: harness.listLessons({ runId: run.id }),
      template: harness.getPromptTemplate("task")?.contentMd,
    });
    const resolvedModel = resolveModelPreference({ run, task, globalModel: flag(parsed, "model") });
    const input = {
      prompt,
      sessionName,
      executor: "codex-resumable",
      model: resolvedModel,
    };
    const cwd = task.worktreePath ?? worktreeForTask()?.(task) ?? runnerCwd();
    const startResult = await applyStartHooks({
      hooks: startHooks(),
      run,
      task,
      sessionName,
      cwd,
    });
    if ((startResult.problems ?? []).length > 0) {
      const attemptId = harness.recordAttempt({
        taskId,
        input: { ...input, cwd, startHooks: true },
        output: {
          status: "blocked",
          summary: "start hooks blocked task execution",
          changedFiles: [],
          checks: startResult.checks ?? [],
          artifacts: startResult.artifacts ?? [],
          problems: startResult.problems ?? [],
        },
      });
      printJson({
        attemptId,
        taskId,
        status: "blocked",
        codexSessionId: null,
      });
      break;
    }
    const attemptId = harness.startAttempt({ taskId, input: { ...input, cwd } });
    const recorder = createAttemptEventRecorder(attemptId);
    const result = await codexResumableClient(resolvedModel?.model, cwd).start({
      prompt,
      sessionName,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    harness.updateAttemptInput({
      attemptId,
      input: codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
    });
    if (result.status === "running") {
      printJson({
        attemptId,
        taskId,
        status: "running",
        codexSessionId: result.sessionId,
      });
      break;
    }
    const outputWithArtifacts = withCodexArtifacts(result.output, result.sessionId);
    harness.finishAttempt({
      attemptId,
      output: {
        ...outputWithArtifacts,
        checks: [...(startResult.checks ?? []), ...(result.output.checks ?? [])],
        artifacts: [...(startResult.artifacts ?? []), ...(outputWithArtifacts.artifacts ?? [])],
      },
    });
    printJson({
      attemptId,
      taskId,
      status: result.status,
      codexSessionId: result.sessionId,
    });
    break;
  }
  case "codex-resume-attempt": {
    const attemptId = required(parsed, "attempt-id");
    const attempt = harness.getAttempt(attemptId);
    if (!attempt) {
      fail(`attempt not found: ${attemptId}`);
    }
    const sessionId = typeof attempt.input.codexSessionId === "string" ? attempt.input.codexSessionId : "";
    if (!sessionId) {
      fail(`attempt has no codexSessionId: ${attemptId}`);
    }
    const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attemptId}`;
    const recorder = createAttemptEventRecorder(attemptId);
    const resolvedModel = attemptModelPreference(attempt.input);
    const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : runnerCwd();
    const result = await codexResumableClient(resolvedModel?.model, cwd).resume({
      sessionId,
      sessionName,
      prompt: flag(parsed, "prompt") ?? "Continue until you can return the required structured JSON.",
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    harness.updateAttemptInput({
      attemptId,
      input: {
        ...attempt.input,
          ...codexAttemptInput({
            prompt: flag(parsed, "prompt") ?? "Continue until you can return the required structured JSON.",
            sessionName,
            result,
            model: resolvedModel,
            cwd,
          }),
      },
    });
    if (result.status === "running") {
      printJson({
        attemptId,
        status: "running",
        codexSessionId: result.sessionId,
      });
      break;
    }
    harness.finishAttempt({
      attemptId,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    printJson({
      attemptId,
      status: result.status,
      codexSessionId: result.sessionId,
    });
    break;
  }
  case "retry-task": {
    const taskId = required(parsed, "task-id");
    harness.retryTask({ taskId });
    printJson({ taskId, status: "todo" });
    break;
  }
  default:
    fail(`unknown command: ${parsed.command}`);
}

function parseApproval(raw: string) {
  if (raw !== "approve-all" && raw !== "approve-reads" && raw !== "deny-all") {
    fail("--approval must be approve-all, approve-reads, or deny-all");
  }
  return raw;
}

function parseSandbox(raw: string) {
  if (raw !== "read-only" && raw !== "workspace-write" && raw !== "danger-full-access") {
    fail("--sandbox must be read-only, workspace-write, or danger-full-access");
  }
  return raw;
}

function parseExecutorName(raw: string) {
  if (raw !== "noop" && raw !== "acpx-codex" && raw !== "codex-cli" && raw !== "codex-resumable") {
    fail(`unsupported executor: ${raw}`);
  }
  return raw;
}

function parseOptionalRunDecision(raw: unknown): AttemptOutput["runDecision"] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (raw !== "complete" && raw !== "continue" && raw !== "verify") {
    fail("attempt output runDecision must be complete, continue, or verify");
  }
  return raw;
}

function cliExecutorName() {
  const executor = flag(parsed, "executor");
  if (executor) {
    return parseExecutorName(executor);
  }
  if (flag(parsed, "agent-backend")) {
    return "codex-cli" as const;
  }
  return parseExecutorName(required(parsed, "executor"));
}

function usesCodexResumablePath(executorName: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable") {
  return executorName === "codex-resumable" || flag(parsed, "agent-backend") === "codex-resumable";
}

function selfIterationPlannerPrompt() {
  return [
    "Create the first task for the next Ouroboros self-iteration planning cycle.",
    "",
    "Inspect these inputs before deciding:",
    "",
    "- `README.md`",
    "- `docs/protocol.md`",
    `- \`${SELF_ITERATION_PLAN_DOC}\``,
    "- `packages/cli/src/dashboard.ts`",
    "- `packages/cli/src/main.ts`",
    "- `packages/runner/src/runner.ts`",
    "- recent run lessons from the harness database using `bun run orbs -- list-lessons --run-id <run_id>`",
    "",
    `Use the split-enough rule and first planning prompt in \`${SELF_ITERATION_PLAN_DOC}\`.`,
    "",
    "Return structured JSON with a small `nextTasks` graph. Prefer two to three independent improvement areas in the same graph when the areas can be verified separately and safely run under concurrency. Use one area only when dependencies or product decisions are still unclear.",
    "",
    "Use planner tasks for unclear subproblems, worker tasks for concrete implementation, and verifier tasks for independent validation. Give each task concrete files or commands to inspect first, explicit dependencies when ordering matters, three to five `doneWhen` checks, and a natural failure path through verifier, repair, or another planner. The run-loop should be able to drain the graph without manual task injection.",
  ].join("\n");
}

function cliCommand(command: string, ...args: string[]) {
  return ["bun", "run", "orbs", "--", "--db", parsed.db, command, ...args].map(shellQuote).join(" ");
}

function compactForTitle(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text || "Requirement document";
  }
  return `${text.slice(0, max - 1)}…`;
}

function defaultSelfIterationWorktreeArgs() {
  const startHook = flag(parsed, "start-hook") ?? "git-worktree";
  if (startHook === "none") {
    return ["--start-hook", "none"];
  }
  return ["--worktree-root", flag(parsed, "worktree-root") ?? DEFAULT_SELF_ITERATION_WORKTREE_ROOT, "--start-hook", startHook];
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(value) || value === "$(pwd)") {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function once<T extends (...args: never[]) => void>(fn: T): T {
  let called = false;
  return ((...args: never[]) => {
    if (called) return;
    called = true;
    fn(...args);
  }) as T;
}

function renderTaskPrompt(taskId: string) {
  const task = harness.getTask(taskId);
  if (!task) {
    fail(`task not found: ${taskId}`);
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    fail(`run not found: ${task.runId}`);
  }
  return buildTaskPrompt({
    run,
    task,
    dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
    lessons: harness.listLessons({ runId: run.id }),
    template: harness.getPromptTemplate("task")?.contentMd,
  });
}

function executorFactory(executorName: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable") {
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    resolvedModel: { model: string } | null;
  }) => {
    const backend = resolvedBackendForTask({
      run: input.run,
      task: input.task,
      cliExecutor: executorName,
    });
    if (backend.kind === "noop") {
      return async ({ task }: { task: { id: string } }) => ({
        status: "done" as const,
        summary: `Noop executor completed ${task.id}`,
        changedFiles: [],
        checks: [{ name: "noop executor", status: "passed" as const }],
        artifacts: [],
        problems: [],
      });
    }
    if (backend.kind === "acpx") {
      return createAcpxAgentExecutor({
        cwd: input.cwd,
        ...acpxAgentConfig(backend),
        approval: backend.approval ?? parseApproval(flag(parsed, "approval") ?? "approve-reads"),
        model: input.resolvedModel?.model,
        timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
        idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
      });
    }
    if (backend.kind === "codex-resumable") {
      fail("codex-resumable uses the resumable loop path");
    }
    return createCodexCliExecutor({
      cwd: input.cwd,
      sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
      codexBin: flag(parsed, "codex-bin"),
      model: input.resolvedModel?.model,
      timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
      idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
    });
  };
}

function attemptInputFactory(executorName: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable") {
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    resolvedModel: unknown;
  }) => ({
    backend: resolvedBackendForTask({ run: input.run, task: input.task, cliExecutor: executorName }),
    cwd: input.cwd,
    model: input.resolvedModel,
  });
}

function resolvedBackendForTask(input: {
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  cliExecutor: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable";
}) {
  return resolveAgentBackend({
    run: input.run,
    task: input.task,
    cliAgentBackend: flag(parsed, "agent-backend"),
    cliExecutor: input.cliExecutor,
  });
}

function acpxAgentConfig(backend: ResolvedAgentBackend) {
  if (backend.agentCommand) {
    return { agentCommand: backend.agentCommand };
  }
  return { agent: backend.agent ?? "codex" };
}

async function runCodexResumableLoop(input: { runId: string; maxRounds: number; limit: number; maxTries: number }) {
  const rounds = [];
  for (let index = 0; index < input.maxRounds; index += 1) {
    const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId: input.runId });
    const resumed = await resumeRunningCodexAttempts({ runId: input.runId, limit: input.limit });
    if (resumed.length > 0) {
      rounds.push({ index, tasks: resumed, reclaimed });
      if (resumed.some((task) => task.status === "running")) {
        break;
      }
      continue;
    }

    const started = await startReadyCodexAttempts({ runId: input.runId, limit: input.limit });
    if (started.length === 0) {
      const review = ensureGoalReviewTask(input.runId, input.maxTries);
      if (review.created) {
        const reviewed = await startReadyCodexAttempts({ runId: input.runId, limit: input.limit });
        if (reviewed.length > 0) {
          rounds.push({ index, tasks: reviewed, goalReview: review, reclaimed });
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

async function runAutopilot(input: {
  runId: string;
  maxCycles: number;
  maxRounds: number;
  limit: number;
  maxTries: number;
  intervalMs: number;
}) {
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const result = await runCodexResumableLoop({
      runId: input.runId,
      maxRounds: input.maxRounds,
      limit: input.limit,
      maxTries: input.maxTries,
    });
    const overview = harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
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
  const overview = harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
  return {
    status: overview.run?.status ?? "unknown",
    cycles,
  };
}

function ensureGoalReviewTask(runId: string, maxTries: number) {
  const run = harness.getRun(runId);
  if (!run) {
    fail(`run not found: ${runId}`);
  }
  if (run.status === "done") {
    return { created: false as const, reason: "run_done" };
  }
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  if (overview.tasks.some((task) => task.status === "todo" || task.status === "running")) {
    return { created: false as const, reason: "active_tasks" };
  }
  const completedReview = [...overview.sessions].reverse().find(
    (session) =>
      session.role === "goal-review" &&
      session.status === "done" &&
      session.output.runDecision === "complete",
  );
  if (completedReview) {
    harness.updateRunStatus({ runId, status: "done" });
    return {
      created: false as const,
      reason: "completed_by_existing_goal_review",
      taskId: completedReview.taskId,
    };
  }
  const blockedReview = [...overview.tasks].reverse().find(
    (task) => task.role === "goal-review" && task.status === "blocked",
  );
  if (blockedReview) {
    const lastTask = overview.tasks[overview.tasks.length - 1];
    if (lastTask && lastTask.id !== blockedReview.id) {
      return createGoalReviewTask(runId);
    }
    const tries = overview.sessions.filter((session) => session.taskId === blockedReview.id).length;
    if (tries >= maxTries) {
      return { created: false as const, reason: "max_tries", taskId: blockedReview.id, tries, maxTries };
    }
    harness.retryTask({ taskId: blockedReview.id });
    return { created: true as const, taskId: blockedReview.id, retried: true as const, tries: tries + 1, maxTries };
  }
  return createGoalReviewTask(runId);
}

function createGoalReviewTask(runId: string) {
  const taskId = harness.createTask({
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
    ].join("\n"),
    doneWhen: [
      "runDecision is complete, continue, or verify",
      "completion decision cites concrete evidence from repository files or docs, tests or commands, dashboard or run overview state, and recent lessons",
      "complete does not create nextTasks",
      "continue or verify includes one to five nextTasks items",
    ],
  });
  return { created: true as const, taskId };
}

function createPlannerFromUserGoal(input: { runId: string; goal: string; interrupted: boolean }) {
  const prefix = input.interrupted ? "Replan after user interruption" : "Plan user goal";
  return harness.createTask({
    runId: input.runId,
    role: "planner",
    goal: `${prefix}: ${input.goal}`,
    prompt: [
      input.interrupted
        ? "The user interrupted the current run and gave a new requirement."
        : "The user added a new goal from the dashboard.",
      "",
      "User request:",
      input.goal,
      "",
      "Inspect the current run state, recent attempts, lessons, and repository state before planning.",
      "Return structured JSON with one to five nextTasks items for the next useful increment.",
      "Prefer a worker task when the next step is implementation, or a verifier task when the next step is validation.",
      "Keep the task small enough for the existing run-loop to execute and verify.",
    ].join("\n"),
    doneWhen: [
      "current run state has been inspected",
      "one to five nextTasks items are returned",
      "next task is small enough for the run-loop",
    ],
  });
}

function createSelfIterationBootstrap() {
  harness.init();
  const runId = harness.createRun({
    goal: SELF_ITERATION_GOAL,
    context: {
      source: "self-iterate",
      planDoc: SELF_ITERATION_PLAN_DOC,
    },
  });
  const taskId = harness.createTask({
    runId,
    role: "planner",
    goal: "Plan the next Ouroboros self-iteration increment",
    prompt: selfIterationPlannerPrompt(),
    doneWhen: SELF_ITERATION_PLANNER_DONE_WHEN,
  });
  return { runId, taskId };
}

function createIntakeRun(input: { title: string; document: string }) {
  harness.init();
  const runId = harness.createRun({
    goal: `Intake: ${input.title}`,
    context: {
      source: "intake",
      title: input.title,
      document: input.document,
    },
  });
  const taskId = harness.createTask({
    runId,
    role: "planner",
    goal: "Split requirement document into executable runs",
    prompt: intakePlannerPrompt(input.document),
    doneWhen: [
      "Planner output includes one to five nextRuns items unless the document is too small to split",
      "Every nextRuns item has a concrete goal and a prompt that tells its child planner what files or docs to inspect first",
      "Each child run has three to five doneWhen checks or a clear reason it needs another planner pass",
      "The split avoids overlapping ownership between child runs",
      "The generated runs can be supervised without manual run-id selection",
    ],
  });
  return { runId, taskId };
}

function intakePlannerPrompt(document: string) {
  return [
    "You are the portfolio planner for Ouroboros.",
    "",
    "Split the following requirement document into multiple executable Ouroboros runs.",
    "",
    "Return structured JSON with `status: \"done\"` and a `nextRuns` array.",
    "Use `nextRuns`, not `nextTasks`, when the work contains multiple independent goals or phases.",
    "Each nextRuns item must include:",
    "- `goal`: the child run goal",
    "- `prompt`: the initial planner prompt for that child run",
    "- `doneWhen`: three to five completion checks for the child run",
    "- optional `context`: small metadata such as phase, area, priority, or source",
    "- optional `modelPreference`",
    "",
    "For each child run prompt, instruct the child planner to create a small `nextTasks` graph with verifiers and repair paths.",
    "Keep child runs independent where possible so the global supervisor can run two or three runs at the same time.",
    "If the document is too small for multiple runs, create one nextRuns item rather than doing implementation in this intake run.",
    "",
    "Requirement document:",
    "```text",
    document,
    "```",
  ].join("\n");
}

async function superviseRuns(input: {
  rootRunId?: string | null;
  runConcurrency: number;
  taskConcurrency: number;
  maxCycles: number;
  maxRounds: number;
  maxTries: number;
  intervalMs: number;
}) {
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const candidates = runnableRuns({ limit: input.runConcurrency, rootRunId: input.rootRunId ?? null });
    if (candidates.length === 0) {
      return { status: "idle" as const, cycles };
    }
    const results = await Promise.all(candidates.map(async (run) => {
      const result = await runCodexResumableLoop({
        runId: run.id,
        maxRounds: input.maxRounds,
        limit: input.taskConcurrency,
        maxTries: input.maxTries,
      });
      const overview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
      return {
        runId: run.id,
        goal: run.goal,
        status: overview.run?.status ?? run.status,
        rounds: result.rounds,
        activeTasks: overview.tasks.filter((task) => task.status === "todo" || task.status === "running").length,
      };
    }));
    cycles.push({ index, runs: results });
    if (results.some((run) => run.status !== "done" && run.activeTasks > 0) && index < input.maxCycles - 1) {
      await sleep(input.intervalMs);
      continue;
    }
    if (index < input.maxCycles - 1) {
      await sleep(input.intervalMs);
    }
  }
  return { status: "cycle_limit" as const, cycles };
}

async function superviseDaemon(input: {
  rootRunId?: string | null;
  runConcurrency: number;
  taskConcurrency: number;
  tickCycles: number;
  maxRounds: number;
  maxTries: number;
  intervalMs: number;
  idleMs: number;
  maxTicks: number;
}) {
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
      const result = await superviseRuns({
        rootRunId: input.rootRunId ?? null,
        runConcurrency: input.runConcurrency,
        taskConcurrency: input.taskConcurrency,
        maxCycles: input.tickCycles,
        maxRounds: input.maxRounds,
        maxTries: input.maxTries,
        intervalMs: input.intervalMs,
      });
      waitMs = result.status === "idle" ? input.idleMs : input.intervalMs;
      tick = {
        type: "daemon.tick",
        index,
        status: "ok" as const,
        result,
        runCounts: runStatusCounts(),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      tick = {
        type: "daemon.tick",
        index,
        status: "error" as const,
        error: cliErrorMessage(error),
        runCounts: runStatusCounts(),
        createdAt: new Date().toISOString(),
      };
    }
    ticks.push(tick);
    if (input.maxTicks === 0) {
      console.log(JSON.stringify(tick));
    }
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
    runCounts: runStatusCounts(),
  };
}

function cliErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function runStatusCounts() {
  const counts = { todo: 0, running: 0, done: 0, blocked: 0 };
  for (const run of harness.listRuns({ limit: 1000 })) {
    counts[run.status] += 1;
  }
  return counts;
}

function runnableRuns(input: { limit: number; rootRunId?: string | null }) {
  const runs = harness.listRuns({ statuses: ["todo", "running"], limit: 500 });
  const scoped = input.rootRunId ? runsInScope(runs, input.rootRunId) : runs;
  return scoped.filter((run) => run.status !== "done").slice(0, input.limit);
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

function createDashboardRuntime(input: {
  runId: string;
  port: number;
  defaultConcurrency?: number;
  defaultWorktreeRoot?: string;
  defaultStartHook?: string;
}) {
  let runnerProcess: ReturnType<typeof Bun.spawn> | null = null;
  let supervisorProcess: ReturnType<typeof Bun.spawn> | null = null;
  let runnerAutoPaused = false;
  const runnerState: {
    status: "idle" | "running" | "exited";
    pid: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    lastOutput: string;
  } = {
    status: "idle",
    pid: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastOutput: "",
  };
  const runnerStatus = () => ({ ...runnerState });
  const supervisorState: {
    status: "idle" | "running" | "exited";
    pid: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    lastOutput: string;
  } = {
    status: "idle",
    pid: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastOutput: "",
  };
  const supervisorStatus = () => ({ ...supervisorState });
  const appendRunnerOutput = (chunk: string) => {
    const next = `${runnerState.lastOutput}${chunk}`;
    runnerState.lastOutput = next.length > 2000 ? next.slice(next.length - 2000) : next;
  };
  const appendSupervisorOutput = (chunk: string) => {
    const next = `${supervisorState.lastOutput}${chunk}`;
    supervisorState.lastOutput = next.length > 2000 ? next.slice(next.length - 2000) : next;
  };
  const finishRunningAttemptsFromDashboard = (summary: string, problem: string) => {
    for (const attempt of harness.listRunningAttempts({ runId: input.runId })) {
      harness.finishAttempt({
        attemptId: attempt.id,
        output: {
          status: "blocked",
          summary,
          changedFiles: [],
          checks: [{ name: "dashboard runner", status: "failed" }],
          artifacts: [],
          problems: [problem],
        },
      });
      markAttemptThreadInterrupted(attempt.id, problem);
    }
    harness.updateRunStatus({ runId: input.runId, status: "todo" });
  };
  const startRunner = () => {
    runnerAutoPaused = false;
    if (runnerProcess && runnerState.status === "running") {
      return { status: "running", pid: runnerState.pid ?? undefined };
    }
    runnerState.status = "running";
    runnerState.startedAt = new Date().toISOString();
    runnerState.finishedAt = null;
    runnerState.exitCode = null;
    runnerState.lastOutput = "";
    const cmd = dashboardRunnerCommand(input.runId, {
      defaultConcurrency: input.defaultConcurrency,
      defaultWorktreeRoot: input.defaultWorktreeRoot,
      defaultStartHook: input.defaultStartHook,
    });
    runnerProcess = Bun.spawn({
      cmd,
      cwd: process.cwd(),
      env: proxyEnvForChildProcess(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    runnerState.pid = runnerProcess.pid;
    if (runnerProcess.stdout instanceof ReadableStream) {
      drainDashboardRunnerStream(runnerProcess.stdout, appendRunnerOutput);
    }
    if (runnerProcess.stderr instanceof ReadableStream) {
      drainDashboardRunnerStream(runnerProcess.stderr, appendRunnerOutput);
    }
    runnerProcess.exited.then((exitCode) => {
      runnerState.status = "exited";
      runnerState.finishedAt = new Date().toISOString();
      runnerState.exitCode = exitCode;
      runnerProcess = null;
    });
    return { status: "running", pid: runnerState.pid ?? undefined };
  };
  const startSupervisor = () => {
    if (supervisorProcess && supervisorState.status === "running") {
      return { status: "running", pid: supervisorState.pid ?? undefined };
    }
    supervisorState.status = "running";
    supervisorState.startedAt = new Date().toISOString();
    supervisorState.finishedAt = null;
    supervisorState.exitCode = null;
    supervisorState.lastOutput = "";
    const cmd = supervisorCommand({
      defaultConcurrency: input.defaultConcurrency,
      defaultWorktreeRoot: input.defaultWorktreeRoot,
      defaultStartHook: input.defaultStartHook,
    });
    supervisorProcess = Bun.spawn({
      cmd,
      cwd: process.cwd(),
      env: proxyEnvForChildProcess(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    supervisorState.pid = supervisorProcess.pid;
    if (supervisorProcess.stdout instanceof ReadableStream) {
      drainDashboardRunnerStream(supervisorProcess.stdout, appendSupervisorOutput);
    }
    if (supervisorProcess.stderr instanceof ReadableStream) {
      drainDashboardRunnerStream(supervisorProcess.stderr, appendSupervisorOutput);
    }
    supervisorProcess.exited.then((exitCode) => {
      supervisorState.status = "exited";
      supervisorState.finishedAt = new Date().toISOString();
      supervisorState.exitCode = exitCode;
      supervisorProcess = null;
    });
    return { status: "running", pid: supervisorState.pid ?? undefined };
  };
  const stopRunner = () => {
    runnerAutoPaused = true;
    const pid = runnerState.pid;
    if (runnerProcess && runnerState.status === "running") {
      killDashboardRunnerChildren(pid);
      runnerProcess.kill();
    }
    runnerProcess = null;
    runnerState.status = "exited";
    runnerState.finishedAt = new Date().toISOString();
    runnerState.exitCode = null;
    finishRunningAttemptsFromDashboard(
      "Stopped by the dashboard runner control",
      "dashboard stopped the runner process before it could finish cleanly",
    );
    return { status: "blocked", pid: pid ?? undefined };
  };
  const stopSupervisor = () => {
    const pid = supervisorState.pid;
    if (supervisorProcess && supervisorState.status === "running") {
      killDashboardRunnerChildren(pid);
      supervisorProcess.kill();
    }
    supervisorProcess = null;
    supervisorState.status = "exited";
    supervisorState.finishedAt = new Date().toISOString();
    supervisorState.exitCode = null;
    return { status: "stopped", pid: pid ?? undefined };
  };
  const resumeAutomaticRunner = () => {
    runnerAutoPaused = false;
  };
  const server = serveDashboard({
    runId: input.runId,
    port: input.port,
    overview: () =>
      harness.getRunOverview({
        runId: input.runId,
        eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      }),
    globalRunCounts: () => harness.countRunsByStatus(),
    runnerStatus,
    supervisorStatus,
    autoStartRunner: (overview, runner) => {
      if (runnerAutoPaused || overview.run?.status === "done" || runner?.status === "running") {
        return false;
      }
      if (harness.listRunningAttempts({ runId: input.runId }).length > 0) {
        return true;
      }
      return harness.nextReadyTask(input.runId) !== null;
    },
    renderTaskPrompt,
    actions: {
      startRunner,
      stopRunner,
      startSupervisor,
      stopSupervisor,
      createIntake: (document, title) => {
        const result = createIntakeRun({ title: title || compactForTitle(document, 80), document });
        startSupervisor();
        return { ...result, status: "todo" };
      },
      createGoal: (goal) => {
        resumeAutomaticRunner();
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        const taskId = createPlannerFromUserGoal({ runId: input.runId, goal, interrupted: false });
        return { taskId, status: "todo" };
      },
      interruptAndCreateGoal: (goal) => {
        resumeAutomaticRunner();
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        const running = harness.listRunningAttempts({ runId: input.runId });
        for (const attempt of running) {
          const output: AttemptOutput = {
            status: "blocked",
            summary: "Interrupted by the dashboard user",
            changedFiles: [],
            checks: [{ name: "dashboard interrupt", status: "failed" }],
            artifacts: [],
            problems: [goal],
          };
          harness.finishAttempt({ attemptId: attempt.id, output });
          markAttemptThreadInterrupted(attempt.id, goal);
        }
        const taskId = createPlannerFromUserGoal({ runId: input.runId, goal, interrupted: true });
        return { taskId, status: "todo", interrupted: running.length };
      },
      resumeTask: (taskId) => {
        resumeAutomaticRunner();
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        harness.retryTask({ taskId });
        return { taskId, status: "todo" };
      },
      rerunTask: (taskId) => {
        resumeAutomaticRunner();
        const task = harness.getTask(taskId);
        if (!task) {
          fail(`task not found: ${taskId}`);
        }
        if (task.runId !== input.runId) {
          fail(`task does not belong to run: ${input.runId}`);
        }
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        harness.retryTask({ taskId });
        return { taskId, status: "todo" };
      },
      stopAttempt: (attemptId) => {
        runnerAutoPaused = true;
        const attempt = harness.getAttempt(attemptId);
        if (!attempt) {
          fail(`attempt not found: ${attemptId}`);
        }
        const task = harness.getTask(attempt.taskId);
        if (!task || task.runId !== input.runId) {
          fail(`attempt does not belong to run: ${input.runId}`);
        }
        harness.finishAttempt({
          attemptId,
          output: {
            status: "blocked",
            summary: "Stopped by the dashboard user",
            changedFiles: [],
            checks: [{ name: "dashboard stop", status: "failed" }],
            artifacts: [],
            problems: ["user stopped the current task from the dashboard"],
          },
        });
        markAttemptThreadInterrupted(attemptId, "user stopped the current task from the dashboard");
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        return { attemptId, taskId: task.id, status: "blocked" };
      },
    },
  });
  const shutdown = once(() => {
    stopRunner();
    stopSupervisor();
    server.stop();
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return {
    server,
    runnerStatus,
    startRunner,
    stopRunner,
    shutdown,
  };
}

async function resumeRunningCodexAttempts(input: { runId: string; limit: number }) {
  const attempts = harness.listRunningAttempts({ runId: input.runId }).slice(0, input.limit);
  const sessionsByAttemptId = new Map(
    harness.getRunOverview({ runId: input.runId, eventLimit: 1 }).sessions.map((session) => [session.attemptId, session]),
  );
  const tasks = await Promise.all(attempts.map(async (attempt) => {
    const task = harness.getTask(attempt.taskId);
    if (!task) {
      return null;
    }
    const run = harness.getRun(task.runId);
    if (!run) {
      return null;
    }
    const sessionId = typeof attempt.input.codexSessionId === "string" ? attempt.input.codexSessionId : "";
    if (!sessionId) {
      const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
      const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? runnerCwd();
      if (runningAttemptIsFresh(sessionsByAttemptId.get(attempt.id))) {
        upsertAttemptThread({
          runId: run.id,
          task,
          attemptId: attempt.id,
          sessionName,
          cwd,
          status: "running",
        });
        return {
          taskId: task.id,
          attemptId: attempt.id,
          sessionName,
          status: "running",
          codexSessionId: null,
        };
      }
      upsertAttemptThread({
        runId: run.id,
        task,
        attemptId: attempt.id,
        sessionName,
        cwd,
        status: "orphaned",
      });
      const output: AttemptOutput = {
        status: "blocked",
        summary: "Running attempt cannot be resumed because it has no Codex session id",
        changedFiles: [],
        checks: [{ name: "codex-resumable session id", status: "failed" }],
        artifacts: [],
        problems: ["running attempt is missing codexSessionId; task was returned to todo for a fresh attempt"],
      };
      harness.finishAttempt({ attemptId: attempt.id, output });
      harness.retryTask({ taskId: task.id });
      return {
        taskId: task.id,
        attemptId: attempt.id,
        sessionName,
        status: "blocked",
        codexSessionId: null,
      };
    }
    const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
    const prompt =
      typeof attempt.input.prompt === "string"
        ? attempt.input.prompt
        : "Continue until you can return the required structured JSON.";
    const recorder = createAttemptEventRecorder(attempt.id);
    const resolvedModel = attemptModelPreference(attempt.input);
    const cwd = typeof attempt.input.cwd === "string" ? attempt.input.cwd : task.worktreePath ?? runnerCwd();
    upsertAttemptThread({
      runId: run.id,
      task,
      attemptId: attempt.id,
      sessionName,
      cwd,
      agentSessionId: sessionId,
      status: "running",
    });
    const result = await codexResumableClient(resolvedModel?.model, cwd).resume({
      sessionId,
      sessionName,
      prompt,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    harness.updateAttemptInput({
      attemptId: attempt.id,
      input: {
        ...attempt.input,
        ...codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
        threadId: threadIdForAttempt(attempt.id),
      },
    });
    updateAttemptThread({
      attemptId: attempt.id,
      status: result.status === "running" ? "running" : undefined,
      agentSessionId: result.sessionId,
      heartbeat: true,
    });
    if (result.status === "running") {
      return {
        taskId: task.id,
        attemptId: attempt.id,
        sessionName,
        status: "running",
        codexSessionId: result.sessionId,
      };
    }
    const { output, decision } = await applyCliStopHooks({
      run,
      task,
      sessionName,
      prompt,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    harness.finishAttempt({ attemptId: attempt.id, output });
    applyCliPostAttemptRunEffects(run.id, task, output);
    updateAttemptThread({
      attemptId: attempt.id,
      status: output.status,
      agentSessionId: result.sessionId,
      heartbeat: true,
    });
    if (decision === "retry") {
      harness.retryTask({ taskId: task.id });
    }
    return {
      taskId: task.id,
      attemptId: attempt.id,
      sessionName,
      status: output.status,
      codexSessionId: result.sessionId,
    };
  }));
  return tasks.filter((task) => task !== null);
}

function runningAttemptIsFresh(session: { startedAt: string | null; events: Array<{ createdAt: string }> } | undefined) {
  const lastEventAt = session?.events.at(-1)?.createdAt;
  const heartbeatAt = parseTimestampMs(lastEventAt) ?? parseTimestampMs(session?.startedAt);
  return heartbeatAt !== null && Date.now() - heartbeatAt < RUNNING_ATTEMPT_STALE_MS;
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

async function startReadyCodexAttempts(input: { runId: string; limit: number }) {
  const run = harness.getRun(input.runId);
  if (!run) {
    fail(`run not found: ${input.runId}`);
  }
  const leased = harness.leaseReadyTasks({
    runId: input.runId,
    limit: input.limit,
    sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
    worktreeForTask: worktreeForTask(),
  });
  const tasks = await Promise.all(leased.map(async (task) => {
    const sessionName = task.sessionRef ?? `task-${task.id}`;
    const prompt = buildTaskPrompt({
      run,
      task,
      dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
      lessons: harness.listLessons({ runId: run.id }),
      template: harness.getPromptTemplate("task")?.contentMd,
    });
    const resolvedModel = resolveModelPreference({ run, task, globalModel: flag(parsed, "model") });
    const cwd = task.worktreePath ?? runnerCwd();
    const baseInput = {
      prompt,
      sessionName,
      executor: "codex-resumable",
      model: resolvedModel,
      cwd,
    };
    const startResult = await applyStartHooks({
      hooks: startHooks(),
      run,
      task,
      sessionName,
      cwd,
    });
    if ((startResult.problems ?? []).length > 0) {
      const attemptId = harness.recordAttempt({
        taskId: task.id,
        input: { ...baseInput, startHooks: true },
        output: {
          status: "blocked",
          summary: "start hooks blocked task execution",
          changedFiles: [],
          checks: startResult.checks ?? [],
          artifacts: startResult.artifacts ?? [],
          problems: startResult.problems ?? [],
        },
      });
      upsertAttemptThread({
        runId: run.id,
        task,
        attemptId,
        sessionName,
        cwd,
        status: "blocked",
      });
      return {
        taskId: task.id,
        attemptId,
        sessionName,
        status: "blocked",
        codexSessionId: null,
      };
    }
    const attemptId = harness.startAttempt({ taskId: task.id, input: baseInput });
    upsertAttemptThread({
      runId: run.id,
      task,
      attemptId,
      sessionName,
      cwd,
      status: "running",
    });
    const recorder = createAttemptEventRecorder(attemptId);
    const result = await codexResumableClient(resolvedModel?.model, cwd).start({
      prompt,
      sessionName,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    const attemptInput = {
      ...codexAttemptInput({ prompt, sessionName, result, model: resolvedModel, cwd }),
      threadId: threadIdForAttempt(attemptId),
    };
    harness.updateAttemptInput({ attemptId, input: attemptInput });
    updateAttemptThread({
      attemptId,
      status: result.status === "running" ? "running" : undefined,
      agentSessionId: result.sessionId,
      heartbeat: true,
    });
    if (result.status === "running") {
      return {
        taskId: task.id,
        attemptId,
        sessionName,
        status: "running",
        codexSessionId: result.sessionId,
      };
    }
    const { output, decision } = await applyCliStopHooks({
      run,
      task,
      sessionName,
      prompt,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    harness.finishAttempt({
      attemptId,
      output: {
        ...output,
        checks: [...(startResult.checks ?? []), ...(output.checks ?? [])],
        artifacts: [...(startResult.artifacts ?? []), ...(output.artifacts ?? [])],
      },
    });
    const finishedAttempt = harness.getAttempt(attemptId);
    applyCliPostAttemptRunEffects(run.id, task, finishedAttempt?.output ?? output);
    updateAttemptThread({
      attemptId,
      status: output.status,
      agentSessionId: result.sessionId,
      heartbeat: true,
    });
    if (decision === "retry") {
      harness.retryTask({ taskId: task.id });
    }
    return {
      taskId: task.id,
      attemptId,
      sessionName,
      status: output.status,
      codexSessionId: result.sessionId,
    };
  }));
  return tasks;
}

function threadIdForAttempt(attemptId: string) {
  return `thread_${attemptId}`;
}

function applyCliPostAttemptRunEffects(runId: string, task: Pick<Task, "role">, output: AttemptOutput) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
    harness.updateRunStatus({ runId, status: "done" });
  }
}

function upsertAttemptThread(input: {
  runId: string;
  task: Task;
  attemptId: string;
  sessionName: string;
  cwd: string;
  status?: ExecutionThreadStatus;
  agentSessionId?: string | null;
}) {
  return harness.upsertExecutionThread({
    id: threadIdForAttempt(input.attemptId),
    runId: input.runId,
    taskId: input.task.id,
    attemptId: input.attemptId,
    ownerType: "runner",
    ownerId: String(process.pid),
    role: input.task.role,
    status: input.status ?? "running",
    pid: process.pid,
    sessionName: input.sessionName,
    agentSessionId: input.agentSessionId ?? null,
    worktreePath: input.cwd,
  });
}

function updateAttemptThread(input: {
  attemptId: string;
  status?: ExecutionThreadStatus;
  agentSessionId?: string | null;
  heartbeat?: boolean;
}) {
  harness.updateExecutionThread({
    id: threadIdForAttempt(input.attemptId),
    status: input.status,
    ownerId: String(process.pid),
    pid: process.pid,
    agentSessionId: input.agentSessionId ?? null,
    heartbeat: input.heartbeat,
  });
}

function markAttemptThreadInterrupted(attemptId: string, reason: string) {
  harness.updateExecutionThread({
    id: threadIdForAttempt(attemptId),
    status: "interrupted",
    interruptReason: reason,
    heartbeat: true,
  });
}

async function applyCliStopHooks(input: {
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
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
  const hooksByRole: Record<string, StopHook[]> = stopHooksByRole();
  const hooks = [...(hooksByRole[input.task.role] ?? [])];
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

function codexResumableClient(model?: string | null, cwd = runnerCwd()) {
  return createCodexResumableClient({
    cwd,
    sandbox: parseCodexResumableSandbox(),
    codexBin: flag(parsed, "codex-bin"),
    model: model ?? undefined,
    timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
    idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
  });
}

function parseCodexResumableSandbox() {
  return parseSandbox(flag(parsed, "sandbox") ?? "workspace-write");
}

function codexAttemptInput(input: {
  prompt: string;
  sessionName: string;
  result: {
    sessionId: string | null;
    outputPath: string;
    stdout: string;
    stderr: string;
    events: Array<Record<string, unknown>>;
  };
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
  };
}

function attemptModelPreference(input: Record<string, unknown>): { model: string } | null {
  const model = input.model;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return null;
  }
  const record = model as Record<string, unknown>;
  return typeof record.model === "string" && record.model.trim().length > 0 ? (record as { model: string }) : null;
}

function createAttemptEventRecorder(attemptId: string) {
  let sequence = Date.now() * 1000;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  return {
    stdout: (chunk: string) => {
      harness.recordAttemptEvent({
        attemptId,
        stream: "stdout",
        sequence: nextSequence(),
        text: chunk,
      });
    },
    stderr: (chunk: string) => {
      harness.recordAttemptEvent({
        attemptId,
        stream: "stderr",
        sequence: nextSequence(),
        text: chunk,
      });
    },
    event: (event: Record<string, unknown>) => {
      harness.recordAttemptEvent({
        attemptId,
        stream: "codex-json",
        sequence: nextSequence(),
        payload: event,
      });
    },
  };
}

function dashboardRunnerCommand(
  runId: string,
  options: { defaultConcurrency?: number; defaultWorktreeRoot?: string; defaultStartHook?: string } = {},
) {
  const stopHook = flag(parsed, "stop-hook") ?? DEFAULT_STOP_HOOKS;
  const cmd = [
    Bun.argv[0],
    Bun.argv[1],
    "--db",
    parsed.db,
    "autopilot",
    "--run-id",
    runId,
    "--executor",
    "codex-resumable",
    "--stop-hook",
    stopHook,
  ];
  for (const name of [
    "limit",
    "concurrency",
    "max-rounds",
    "max-cycles",
    "max-tries",
    "interval-ms",
    "codex-bin",
    "sandbox",
    "timeout-ms",
    "idle-timeout-ms",
    "model",
    "cwd",
    "start-hook",
    "worktree-root",
  ]) {
    const value = flag(parsed, name);
    if (value !== undefined) {
      cmd.push(`--${name}`, value);
    }
  }
  if (flag(parsed, "concurrency") === undefined && flag(parsed, "limit") === undefined && options.defaultConcurrency) {
    cmd.push("--concurrency", String(options.defaultConcurrency));
  }
  if (flag(parsed, "worktree-root") === undefined && options.defaultWorktreeRoot && flag(parsed, "start-hook") !== "none") {
    cmd.push("--worktree-root", options.defaultWorktreeRoot);
  }
  if (flag(parsed, "start-hook") === undefined && options.defaultStartHook) {
    cmd.push("--start-hook", options.defaultStartHook);
  }
  return cmd;
}

function supervisorCommand(
  options: { defaultConcurrency?: number; defaultWorktreeRoot?: string; defaultStartHook?: string } = {},
) {
  const stopHook = flag(parsed, "stop-hook") ?? DEFAULT_STOP_HOOKS;
  const cmd = [
    Bun.argv[0],
    Bun.argv[1],
    "--db",
    parsed.db,
    "supervise-daemon",
    "--executor",
    "codex-resumable",
    "--stop-hook",
    stopHook,
  ];
  for (const name of [
    "limit",
    "concurrency",
    "run-concurrency",
    "max-rounds",
    "max-cycles",
    "max-tries",
    "interval-ms",
    "codex-bin",
    "sandbox",
    "timeout-ms",
    "idle-timeout-ms",
    "model",
    "cwd",
    "start-hook",
    "worktree-root",
  ]) {
    const value = flag(parsed, name);
    if (value !== undefined) {
      cmd.push(`--${name}`, value);
    }
  }
  if (flag(parsed, "concurrency") === undefined && flag(parsed, "limit") === undefined && options.defaultConcurrency) {
    cmd.push("--concurrency", String(options.defaultConcurrency));
  }
  if (flag(parsed, "worktree-root") === undefined && options.defaultWorktreeRoot && flag(parsed, "start-hook") !== "none") {
    cmd.push("--worktree-root", options.defaultWorktreeRoot);
  }
  if (flag(parsed, "start-hook") === undefined && options.defaultStartHook) {
    cmd.push("--start-hook", options.defaultStartHook);
  }
  return cmd;
}

function killDashboardRunnerChildren(pid: number | null) {
  if (!pid || process.platform === "win32") {
    return;
  }
  Bun.spawnSync({
    cmd: ["/bin/zsh", "-lc", `pkill -TERM -P ${pid} >/dev/null 2>&1 || true`],
    stdout: "ignore",
    stderr: "ignore",
  });
}

function drainDashboardRunnerStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const decoder = new TextDecoder();
  void (async () => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        onChunk(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) {
        onChunk(tail);
      }
    } catch (error) {
      onChunk(`\nrunner stream read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  })();
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

function parsePositiveInteger(raw: string, name: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function parseConcurrency() {
  return parsePositiveInteger(flag(parsed, "concurrency") ?? flag(parsed, "limit") ?? "1", "--concurrency");
}

function parseNonNegativeInteger(raw: string, name: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runnerCwd() {
  return flag(parsed, "cwd") ?? process.cwd();
}

function worktreeForTask() {
  const root = flag(parsed, "worktree-root");
  if (!root) {
    return undefined;
  }
  return (task: { id: string; worktreePath?: string | null }) => task.worktreePath ?? join(root, task.id);
}

function stopHooksByRole() {
  const raw = flag(parsed, "stop-hook");
  const taskCreationHook = createTasksFromOutputHook({ harness });
  const runCreationHook = createRunsFromOutputHook({ harness });
  const goalReviewDecisionHook = createGoalReviewDecisionHook({ harness });
  const hooks = {
    planner: [],
    worker: [],
    verifier: [],
    "goal-review": [goalReviewDecisionHook, taskCreationHook],
  } as Record<string, StopHook[]>;
  if (!raw) {
    return hooks;
  }
  for (const hook of raw.split(",")) {
    if (hook === "create-runs") {
      hooks.planner.push(runCreationHook);
      continue;
    }
    if (hook === "create-tasks") {
      hooks.planner.push(taskCreationHook);
      continue;
    }
    if (hook === "create-verifier") {
      hooks.worker.push(createVerifierTaskHook({ harness }));
      continue;
    }
    if (hook === "create-repair") {
      hooks.verifier.push(createRepairTaskHook({ harness }));
      continue;
    }
    if (hook === "context-summary" || hook === "context-subagent") {
      hooks.verifier.push(createContextSummaryHook());
      continue;
    }
    fail("--stop-hook must contain create-runs, create-tasks, create-verifier, create-repair, or context-summary");
  }
  return hooks;
}

function startHooks() {
  const hook = flag(parsed, "start-hook");
  if (!hook) {
    return [];
  }
  if (hook === "none") {
    return [];
  }
  if (hook !== "git-worktree") {
    fail("--start-hook must be git-worktree or none");
  }
  if (!flag(parsed, "worktree-root")) {
    fail("--start-hook git-worktree requires --worktree-root");
  }
  return [
    createGitWorktreeHook({
      repoPath: runnerCwd(),
      baseRef: flag(parsed, "git-base-ref") ?? "main",
    }),
  ];
}

function parseTimeoutMs(raw: string | undefined, name = "--timeout-ms") {
  if (raw === undefined) {
    return undefined;
  }
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    fail(`${name} must be a positive integer`);
  }
  return timeoutMs;
}
