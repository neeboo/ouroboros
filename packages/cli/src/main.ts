#!/usr/bin/env bun
import {
  acceptGuardrailProposal as acceptGuardrailProposalInContext,
  applyHarnessAction,
  describeIntegrationReadiness,
  diagnoseRunOverview,
  Harness,
  proposeGuardrailsFromLessons as buildGuardrailProposalsFromLessons,
  refreshGuardrailProposalsForRun,
  readableList,
  readableValue,
} from "@ouroboros/harness";
import type { AttemptOutput } from "@ouroboros/harness";
import {
  buildTaskPrompt,
  createContextSummaryHook,
  createGitWorktreeHook,
  createGoalReviewDecisionHook,
  createRefreshGuardrailProposalsHook,
  createRepairTaskHook,
  createRunsFromOutputHook,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  childEnvForProcess,
  createRouteExecutor,
  resolveExecutionRoute,
  resumeCodexResumableAttempt,
  runCodexAutopilot,
  runCodexResumableLoop,
  runReadyTasks,
  runUntilIdle,
  startCodexResumableAttempt,
  superviseCodexDaemon,
  superviseCodexRuns,
  terminateProcessTreeSync,
} from "@ouroboros/runner";
import type { CodexSandbox, ResolvedExecutionRoute, StopHook } from "@ouroboros/runner";
import { fail, flag, parseArgs, required } from "./args";
import { loadOuroborosConfig } from "./config";
import { parseArray, parseObject, printJson } from "./json";
import { checkLinearAccess, ingestLinearEvent, linkLinearIssue } from "./linear";
import { serveDashboard } from "./dashboard";
import { requestHarnessAction, serveHarnessActions } from "./action-server";
import { formatRunEvidence } from "./run-evidence";
import { formatAttemptExplanation } from "./explain-attempt";
import { formatRunGraph } from "./run-graph";
import { buildAgentMatrix, doctorAgent } from "../../../scripts/acpx-agent-smoke";
import { join } from "node:path";
import type { Task } from "@ouroboros/harness";

const parsed = parseArgs(Bun.argv.slice(2));
const harness = new Harness(parsed.db);
const DEFAULT_MAX_TRIES = 3;
const DEFAULT_SELF_ITERATION_CONCURRENCY = 3;
const DEFAULT_SELF_ITERATION_WORKTREE_ROOT = ".ouroboros/worktrees";
const DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const SELF_ITERATION_GOAL = "Use Ouroboros to plan its own next self-iteration cycle";
const SELF_ITERATION_PLAN_DOC = "docs/self-iteration-plan.md";
const DEFAULT_STOP_HOOKS = "create-runs,create-tasks,create-verifier,create-repair,context-summary";
const SELF_ITERATION_GOAL_CONTRACT = {
  desiredState: "Ouroboros can plan and drain its own next improvement cycle before it asks for human intervention.",
  successCriteria: [
    "a new Ouroboros run exists for self-iteration",
    "its planner has produced a fine-grained task graph or a justified verifier task",
    "the dashboard shows the active goal, task stream, todos, and runner state for that run",
    "the generated graph points to concrete files and checks",
    "no implementation task starts from an underspecified prompt",
    "the run-loop can drain the generated graph to either done tasks, blocked tasks with repair paths, or a goal-review decision",
  ],
  constraints: [
    "Do not change database schema or dependency sets in this slice",
    "Do not start implementation from a vague task",
    "Prefer small JSON contracts stored in run context or task config",
    "Execution must not quietly weaken the contract",
  ],
  requiredEvidence: [
    "orbs run-overview --run-id <run_id>",
    "orbs list-lessons --run-id <run_id>",
    "task graph with concrete files and checks",
    "verifier decisions based on evidence",
  ],
  budget: {
    maxRounds: 8,
    maxAttemptsPerTask: DEFAULT_MAX_TRIES,
  },
  stopPolicy: {
    completeWhen: [
      "all generated work is drained and goal-review marks the run complete",
      "completion criteria are satisfied with cited evidence",
    ],
    blockWhen: [
      "verifier failures cannot be repaired inside the retry budget",
      "the generated graph cannot be drained by run-loop",
    ],
    askHumanWhen: [
      "a task wants to change repository structure",
      "a task wants to introduce a new dependency",
      "a task wants to alter the prompt contract or database schema",
      "a verifier finds ambiguous product behavior",
      "the run is done and the dashboard claims there is no queued work",
    ],
  },
};
const SELF_ITERATION_PLANNER_DONE_WHEN = [
  "Planner output contains a small nextTasks graph, usually two to five tasks across two to three independent areas when possible",
  "Every planned task has one role, one concrete goal, and one prompt with exact files or commands to inspect first",
  "The task graph includes explicit dependsOn when ordering matters and each task has three to five doneWhen checks",
  "Every planned task identifies a clear artifact, code change, test, or decision",
  "The graph includes natural failure paths through verifier, repair, or another planner and can be drained by run-loop",
];
const SELF_ITERATION_ROLE_AGENT_DEFAULTS: Record<"planner" | "verifier" | "goal-review", string> = {
  planner: "codex-resumable",
  verifier: "codex-resumable",
  "goal-review": "codex-resumable",
};

switch (parsed.command) {
  case "init": {
    harness.init();
    printJson({ db: parsed.db, status: "initialized" });
    break;
  }
  case "self-iterate": {
    const { runId, taskId } = await createSelfIterationBootstrap();
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
    const { runId, taskId } = await createSelfIterationBootstrap();
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
    const config = await loadCliConfig();
    const id = harness.createRun({
      goal,
      context: withConfigDefaults(context, config),
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
    const result = await createIntakeRun({ title, document });
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
  case "overseer-tick": {
    harness.init();
    const result = await runOverseerTick({
      runId: required(parsed, "run-id"),
      eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      interruptAttemptId: flag(parsed, "interrupt-attempt") ?? null,
      reason: flag(parsed, "reason") ?? null,
      followUpJson: flag(parsed, "follow-up-json") ?? null,
    });
    printJson(result);
    break;
  }
  case "doctor-agent": {
    printJson(await doctorAgent(parseDoctorAgentId(required(parsed, "agent"))));
    break;
  }
  case "linear-check": {
    harness.init();
    const config = await loadCliConfig();
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
  case "linear-ingest-event": {
    harness.init();
    try {
      const stored = ingestLinearEvent({
        harness,
        eventType: required(parsed, "event-type"),
        externalId: required(parsed, "external-id"),
        payloadJson: required(parsed, "payload-json"),
      });
      printJson(stored);
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "list-lessons": {
    printJson(harness.listLessons({ runId: required(parsed, "run-id") }));
    break;
  }
  case "propose-guardrails": {
    printJson(proposeGuardrailsFromLessons({
      runId: required(parsed, "run-id"),
      minCount: parsePositiveInteger(flag(parsed, "min-count") ?? "2", "--min-count"),
    }));
    break;
  }
  case "accept-guardrail": {
    printJson(acceptGuardrailProposal({
      runId: required(parsed, "run-id"),
      proposalId: required(parsed, "proposal-id"),
      acceptedBy: required(parsed, "accepted-by"),
    }));
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
      const result = await runCodexResumableLoop({ ...codexRunnerInput(), runId, maxRounds: 1, limit, maxTries });
      printJson({ tasks: result.rounds.flatMap((round) => round.tasks) });
      break;
    }
    const result = await runReadyTasks({
      harness,
      runId,
      limit,
      model: flag(parsed, "model"),
      cliAgentBackend: flag(parsed, "agent-backend"),
      cliExecutor: executorName,
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
      printJson(await runCodexResumableLoop({ ...codexRunnerInput(), runId, maxRounds, limit, maxTries }));
      break;
    }
    const result = await runUntilIdle({
      harness,
      runId,
      limit,
      maxRounds,
      model: flag(parsed, "model"),
      cliAgentBackend: flag(parsed, "agent-backend"),
      cliExecutor: executorName,
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
      await runCodexAutopilot({
        ...codexRunnerInput(),
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
      await superviseCodexRuns({
        ...codexRunnerInput(),
        rootRunId: flag(parsed, "root-run-id") ?? null,
        runConcurrency: parsePositiveInteger(flag(parsed, "run-concurrency") ?? "2", "--run-concurrency"),
        taskConcurrency: parseConcurrency(),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
        integrateCompletedRuns: flag(parsed, "integrate-complete-runs") !== undefined,
        integrationTargetBranch: flag(parsed, "integration-target-branch") ?? "main",
        integrationPush: flag(parsed, "integration-push") !== undefined,
      }),
    );
    break;
  }
  case "supervise-daemon": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("supervise-daemon currently supports codex-resumable");
    }
    const maxTicks = parseNonNegativeInteger(flag(parsed, "max-ticks") ?? "0", "--max-ticks");
    const result = await superviseCodexDaemon({
      ...codexRunnerInput(),
      rootRunId: flag(parsed, "root-run-id") ?? null,
      runConcurrency: parsePositiveInteger(flag(parsed, "run-concurrency") ?? "2", "--run-concurrency"),
      taskConcurrency: parseConcurrency(),
      tickCycles: parsePositiveInteger(flag(parsed, "tick-cycles") ?? flag(parsed, "max-cycles") ?? "1", "--tick-cycles"),
      maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
      maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
      intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      idleMs: parseNonNegativeInteger(flag(parsed, "idle-ms") ?? flag(parsed, "interval-ms") ?? "1500", "--idle-ms"),
      maxTicks,
      integrateCompletedRuns: flag(parsed, "integrate-complete-runs") !== undefined,
      integrationTargetBranch: flag(parsed, "integration-target-branch") ?? "main",
      integrationPush: flag(parsed, "integration-push") !== undefined,
      onTick: maxTicks === 0 ? (tick) => console.log(JSON.stringify(tick)) : undefined,
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
        summary: readableValue(output.summary),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: readableList(output.problems),
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
        summary: readableValue(output.summary),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: readableList(output.problems),
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
  case "run-evidence": {
    const runId = required(parsed, "run-id");
    const overview = harness.getRunOverview({
      runId,
      eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
    });
    if (!overview.run) {
      fail(`run not found: ${runId}`);
    }
    console.log(
      formatRunEvidence(overview, {
        lessonLimit: parsePositiveInteger(flag(parsed, "limit") ?? "10", "--limit"),
      }),
    );
    break;
  }
  case "explain-attempt": {
    const attemptId = required(parsed, "attempt-id");
    const attempt = harness.getAttempt(attemptId);
    if (!attempt) {
      fail(`attempt not found: ${attemptId}`);
    }
    const task = harness.getTask(attempt.taskId);
    const explicitStdout = flag(parsed, "stdout");
    const events = explicitStdout === undefined ? harness.listAttemptEvents(attemptId) : [];
    console.log(
      formatAttemptExplanation(attempt, {
        stdout: explicitStdout ?? null,
        events,
        role: task?.role ?? null,
        eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      }),
    );
    break;
  }
  case "run-graph": {
    const runId = required(parsed, "run-id");
    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    if (!overview.run) {
      fail(`run not found: ${runId}`);
    }
    console.log(formatRunGraph(overview));
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
    printJson(await startCodexResumableAttempt({ ...codexRunnerInput(), taskId }));
    break;
  }
  case "codex-resume-attempt": {
    const attemptId = required(parsed, "attempt-id");
    printJson(await resumeCodexResumableAttempt({ ...codexRunnerInput(), attemptId, prompt: flag(parsed, "prompt") }));
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

function parseSandbox(raw: string): CodexSandbox {
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
  if (raw === "done") {
    return "complete";
  }
  if (raw !== "complete" && raw !== "continue" && raw !== "verify" && raw !== "defer") {
    fail("attempt output runDecision must be complete, continue, verify, or defer");
  }
  return raw;
}

function parseDoctorAgentId(raw: string) {
  const agent = buildAgentMatrix().find((candidate) => candidate.id === raw);
  if (!agent) {
    fail(`unsupported doctor agent: ${raw}`);
  }
  return agent.id;
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
    "- recent run lessons from the harness database using `orbs list-lessons --run-id <run_id>`",
    "",
    `Use the split-enough rule and first planning prompt in \`${SELF_ITERATION_PLAN_DOC}\`.`,
    "",
    "Return structured JSON with a small `nextTasks` graph. Prefer two to three independent improvement areas in the same graph when the areas can be verified separately and safely run under concurrency. Use one area only when dependencies or product decisions are still unclear.",
    "",
    "Use planner tasks for unclear subproblems, worker tasks for concrete implementation, and verifier tasks for independent validation. Give each task concrete files or commands to inspect first, explicit dependencies when ordering matters, three to five `doneWhen` checks, and a natural failure path through verifier, repair, or another planner. The run-loop should be able to drain the graph without manual task injection.",
  ].join("\n");
}

function cliCommand(command: string, ...args: string[]) {
  return ["orbs", "--db", parsed.db, command, ...args].map(shellQuote).join(" ");
}

async function loadCliConfig() {
  if (flag(parsed, "config")) {
    return loadOuroborosConfig(flag(parsed, "config")!);
  }
  const primary = await loadOuroborosConfig("ouroboros.toml");
  if (hasConfigContent(primary)) {
    return primary;
  }
  return loadOuroborosConfig("config.toml");
}

function withConfigDefaults(context: Record<string, unknown>, config: Awaited<ReturnType<typeof loadOuroborosConfig>>) {
  return {
    ...context,
    ...(config.modelDefaults && context.modelDefaults === undefined ? { modelDefaults: config.modelDefaults } : {}),
    ...(config.agentDefaults && context.agentDefaults === undefined ? { agentDefaults: config.agentDefaults } : {}),
    ...(config.agentBackends && context.agentBackends === undefined ? { agentBackends: config.agentBackends } : {}),
  };
}

function withSelfIterationConfigDefaults(
  context: Record<string, unknown>,
  config: Awaited<ReturnType<typeof loadOuroborosConfig>>,
) {
  const merged = withConfigDefaults(context, config);
  const configAgentDefaults = recordValue(config.agentDefaults);
  const configRoles = recordValue(configAgentDefaults.roles);
  const mergedAgentDefaults = recordValue(merged.agentDefaults);
  const mergedRoles = recordValue(mergedAgentDefaults.roles);
  return {
    ...merged,
    agentDefaults: {
      ...mergedAgentDefaults,
      roles: {
        ...SELF_ITERATION_ROLE_AGENT_DEFAULTS,
        ...configRoles,
        ...mergedRoles,
      },
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasConfigContent(config: Awaited<ReturnType<typeof loadOuroborosConfig>>) {
  return Boolean(config.linear || config.modelDefaults || config.agentDefaults || config.agentBackends);
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

function proposeGuardrailsFromLessons(input: { runId: string; minCount: number }) {
  const run = harness.getRun(input.runId);
  if (!run) {
    fail(`run not found: ${input.runId}`);
  }
  const proposalResult = buildGuardrailProposalsFromLessons({
    lessons: harness.listLessons({ runId: input.runId }),
    existingProposals: run.context.guardrailProposals,
    minCount: input.minCount,
  });

  harness.updateRun({
    runId: input.runId,
    contextPatch: {
      guardrailProposals: proposalResult.nextProposals,
    },
  });

  return {
    runId: input.runId,
    minCount: input.minCount,
    proposed: proposalResult.proposed,
    proposals: proposalResult.proposals,
  };
}

function acceptGuardrailProposal(input: { runId: string; proposalId: string; acceptedBy: string }) {
  const run = harness.getRun(input.runId);
  if (!run) {
    fail(`run not found: ${input.runId}`);
  }
  const accepted = acceptGuardrailProposalInContext({
    context: run.context,
    proposalId: input.proposalId,
    acceptedBy: input.acceptedBy,
  });
  if (!accepted) {
    fail(`guardrail proposal not found: ${input.proposalId}`);
  }

  harness.updateRun({
    runId: input.runId,
    contextPatch: {
      guardrailProposals: accepted.nextProposals,
      guardrails: accepted.nextGuardrails,
    },
  });

  return {
    runId: input.runId,
    proposalId: input.proposalId,
    guardrail: accepted.guardrail,
  };
}

function executorFactory(_executorName: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable") {
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    route: ResolvedExecutionRoute;
  }) =>
    createRouteExecutor({
      cwd: input.cwd,
      route: input.route,
      approval: parseApproval(flag(parsed, "approval") ?? "approve-reads"),
      sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
      codexBin: flag(parsed, "codex-bin"),
      timeoutMs: genericHardTimeoutMs(),
      idleTimeoutMs: genericIdleTimeoutMs(),
    });
}

function attemptInputFactory(_executorName: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable") {
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    route: ResolvedExecutionRoute;
  }) => attemptInputForRoute(input.route, input.cwd);
}

function resolveCliExecutionRoute(input: {
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  cliExecutor: "noop" | "acpx-codex" | "codex-cli" | "codex-resumable";
}) {
  return resolveExecutionRoute({
    run: input.run,
    task: input.task,
    cliAgentBackend: flag(parsed, "agent-backend"),
    cliExecutor: input.cliExecutor,
    globalModel: flag(parsed, "model"),
  });
}

function attemptInputForRoute(route: ResolvedExecutionRoute, cwd: string) {
  return {
    route,
    backend: route.backend,
    cwd,
    model: route.model,
  };
}

function codexRunnerInput() {
  return {
    harness,
    cwd: runnerCwd(),
    worktreeForTask: worktreeForTask(),
    startHooks: startHooks(),
    stopHooksByRole: stopHooksByRole(),
    cliAgentBackend: flag(parsed, "agent-backend"),
    cliExecutor: "codex-resumable" as const,
    model: flag(parsed, "model"),
    genericExecutorFactory: executorFactory("codex-resumable"),
    codexOptions: {
      sandbox: parseCodexResumableSandbox(),
      codexBin: flag(parsed, "codex-bin"),
      timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
      idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
    },
  };
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

function createPlannerFollowUpTask(goal: string) {
  return {
    role: "planner",
    goal: `Replan after user interruption: ${goal}`,
    prompt: [
      "The user interrupted the current run and gave a new requirement.",
      "",
      "User request:",
      goal,
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
  };
}

function createRepairFollowUpTask(task: NonNullable<ReturnType<Harness["getTask"]>>, reason: string) {
  return {
    role: "worker",
    goal: `Repair interrupted work: ${task.goal}`,
    prompt: [
      "The user stopped the current task from the dashboard.",
      "",
      "Stopped task:",
      task.goal,
      "",
      "Stop reason:",
      reason,
      "",
      "Inspect the current run state, recent attempts, lessons, and repository state before repairing.",
      "Return structured JSON with the smallest repair increment that can be run safely after the interruption.",
    ].join("\n"),
    doneWhen: [
      "the stopped attempt has been reviewed",
      "the repair task is runnable after the interruption",
      "the next repair step is small enough for the run-loop",
    ],
  };
}

function createdTaskIdFromActionResult(result: { artifacts: Array<Record<string, unknown>> }): string | undefined {
  const created = result.artifacts.find((artifact) => artifact.kind === "task" && typeof artifact.taskId === "string");
  return typeof created?.taskId === "string" ? created.taskId : undefined;
}

async function createSelfIterationBootstrap() {
  harness.init();
  const config = await loadCliConfig();
  const runId = harness.createRun({
    goal: SELF_ITERATION_GOAL,
    context: withSelfIterationConfigDefaults({
      source: "self-iterate",
      planDoc: SELF_ITERATION_PLAN_DOC,
      goalContract: SELF_ITERATION_GOAL_CONTRACT,
    }, config),
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

async function createIntakeRun(input: { title: string; document: string }) {
  harness.init();
  const config = await loadCliConfig();
  const runId = harness.createRun({
    goal: `Intake: ${input.title}`,
    context: withConfigDefaults({
      source: "intake",
      title: input.title,
      document: input.document,
    }, config),
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

async function runOverseerTick(input: {
  runId: string;
  eventLimit: number;
  interruptAttemptId: string | null;
  reason: string | null;
  followUpJson: string | null;
}) {
  try {
    const overview = harness.getRunOverview({ runId: input.runId, eventLimit: input.eventLimit });
    if (!overview.run) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: `Run not found: ${input.runId}`,
        problems: [`run not found: ${input.runId}`],
      });
    }

    const diagnosis = diagnoseRunOverview(overview);
    if (!input.interruptAttemptId) {
      return doneOverseerTick({
        runId: input.runId,
        summary: `Diagnosed run ${input.runId}.`,
        diagnosis,
      });
    }

    if (!input.reason || !input.followUpJson) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: "Missing overseer intervention arguments.",
        problems: [
          !input.reason ? "--reason is required when --interrupt-attempt is set" : null,
          !input.followUpJson ? "--follow-up-json is required when --interrupt-attempt is set" : null,
        ].filter((problem): problem is string => problem !== null),
      });
    }

    let followUpTask: Record<string, unknown>;
    try {
      followUpTask = parseJsonObject(input.followUpJson);
    } catch (error) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: "Invalid overseer follow-up JSON.",
        problems: [cliErrorMessage(error)],
      });
    }

    const intervention = applyHarnessAction(harness, {
      type: "interruptAttemptAndCreateTask",
      attemptId: input.interruptAttemptId,
      reason: input.reason,
      followUpTask,
    });
    const refreshedOverview = harness.getRunOverview({ runId: input.runId, eventLimit: input.eventLimit });
    const refreshedDiagnosis = diagnoseRunOverview(refreshedOverview);

    return {
      ...intervention,
      runId: input.runId,
      diagnosis: refreshedDiagnosis,
      intervention,
    };
  } catch (error) {
    return blockedOverseerTick({
      runId: input.runId,
      summary: "Overseer tick failed.",
      problems: [cliErrorMessage(error)],
    });
  }
}

function doneOverseerTick(input: {
  runId: string;
  summary: string;
  diagnosis: ReturnType<typeof diagnoseRunOverview>;
}) {
  return {
    status: "done" as const,
    summary: input.summary,
    checks: [],
    artifacts: [],
    problems: [],
    runId: input.runId,
    diagnosis: input.diagnosis,
    intervention: null,
  };
}

function blockedOverseerTick(input: { runId: string; summary: string; problems: string[] }) {
  return {
    status: "blocked" as const,
    summary: input.summary,
    checks: [{ name: "overseer tick", status: "failed" as const, evidence: input.problems[0] ?? input.summary }],
    artifacts: [],
    problems: input.problems,
    runId: input.runId,
    diagnosis: null,
    intervention: null,
  };
}

function cliErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonObject(raw: string) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
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
      env: childEnvForProcess(),
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
      env: childEnvForProcess(),
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
      if (pid) {
        terminateProcessTreeSync(pid);
      }
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
      if (pid) {
        terminateProcessTreeSync(pid);
      }
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
  const dashboardEventLimit = () => parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit");
  const childRunOverviews = () =>
    harness
      .listRuns({ limit: 500 })
      .filter((run) => run.id !== input.runId)
      .filter((run) => run.context.parentRunId === input.runId || run.context.rootRunId === input.runId)
      .map((run) => harness.getRunOverview({ runId: run.id, eventLimit: dashboardEventLimit() }));
  const recentRunsForDashboard = (limit: number) =>
    harness
      .listRuns({ limit: Math.max(1, Math.min(limit, 100)) })
      .slice()
      .sort((left, right) => {
        const leftCreated = left.createdAt ?? "";
        const rightCreated = right.createdAt ?? "";
        if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);
        return right.id.localeCompare(left.id);
      })
      .map((run) => ({
        id: run.id,
        status: run.status,
        goal: run.goal,
        projectId: run.projectId ?? null,
        createdAt: run.createdAt ?? null,
      }));
  const server = serveDashboard({
    runId: input.runId,
    port: input.port,
    overview: () =>
      harness.getRunOverview({
        runId: input.runId,
        eventLimit: dashboardEventLimit(),
      }),
    runOverview: (runId: string) =>
      harness.getRunOverview({
        runId,
        eventLimit: dashboardEventLimit(),
      }),
    childOverviews: childRunOverviews,
    recentRuns: recentRunsForDashboard,
    globalRunCounts: () => harness.countRunsByStatus(),
    runnerStatus,
    supervisorStatus,
    autoStartRunner: (overview, runner) => {
      if (flag(parsed, "disable-auto-runner") !== undefined) {
        return false;
      }
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
      createIntake: async (document, title) => {
        const result = await createIntakeRun({ title: title || compactForTitle(document, 80), document });
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
        const running = harness.listRunningAttempts({ runId: input.runId });
        if (running.length === 0) {
          harness.updateRunStatus({ runId: input.runId, status: "todo" });
          const taskId = createPlannerFromUserGoal({ runId: input.runId, goal, interrupted: true });
          return { taskId, status: "todo", interrupted: 0 };
        }
        const actionResult = applyHarnessAction(harness, {
          type: "interruptRunningAttemptsAndCreateTask",
          attemptIds: running.map((attempt) => attempt.id),
          reason: goal,
          followUpTask: createPlannerFollowUpTask(goal),
        });
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        const taskId = createdTaskIdFromActionResult(actionResult);
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
        const actionResult = applyHarnessAction(harness, {
          type: "interruptAttemptAndCreateTask",
          attemptId,
          reason: "user stopped the current task from the dashboard",
          followUpTask: createRepairFollowUpTask(task, "user stopped the current task from the dashboard"),
        });
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        return {
          attemptId,
          taskId: task.id,
          followUpTaskId: createdTaskIdFromActionResult(actionResult),
          status: "blocked",
        };
      },
      acceptGuardrailProposal: (proposalId, acceptedBy) => {
        const actionResult = applyHarnessAction(harness, {
          type: "acceptGuardrailProposal",
          runId: input.runId,
          proposalId,
          acceptedBy: acceptedBy || "dashboard",
          reason: "dashboard guardrail proposal accept control",
        });
        if (actionResult.status === "blocked") {
          fail(actionResult.problems.join("; ") || "guardrail proposal was not accepted");
        }
        return {
          runId: input.runId,
          status: actionResult.status,
          proposalId,
        };
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

function threadIdForAttempt(attemptId: string) {
  return `thread_${attemptId}`;
}

function markAttemptThreadInterrupted(attemptId: string, reason: string) {
  harness.updateExecutionThread({
    id: threadIdForAttempt(attemptId),
    status: "interrupted",
    interruptReason: reason,
    heartbeat: true,
  });
}

function parseCodexResumableSandbox() {
  return parseSandbox(flag(parsed, "sandbox") ?? "workspace-write");
}

function applyCliPostAttemptRunEffects(runId: string, task: Pick<Task, "role">, output: AttemptOutput) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
    const readiness = describeIntegrationReadiness(harness, runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
        },
      });
    } else {
      harness.updateRunStatus({ runId, status: "done" });
    }
  }
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
  }
  if (task.role === "goal-review" && output.status === "done") {
    refreshGuardrailProposalsForRun({ harness, runId });
  }
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
  const refreshGuardrailProposalsHook = createRefreshGuardrailProposalsHook({ harness });
  const hooks = {
    planner: [],
    worker: [],
    verifier: [],
    "goal-review": [goalReviewDecisionHook, taskCreationHook, refreshGuardrailProposalsHook],
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

function genericIdleTimeoutMs() {
  return parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms") ?? DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS;
}

function genericHardTimeoutMs() {
  return parseTimeoutMs(flag(parsed, "timeout-ms")) ?? DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS;
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
