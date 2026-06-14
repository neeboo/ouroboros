#!/usr/bin/env bun
import { Harness } from "@ouroboros/harness";
import type { AttemptOutput } from "@ouroboros/harness";
import {
  buildTaskPrompt,
  createAcpxCodexExecutor,
  createCodexCliExecutor,
  createCodexResumableClient,
  createContextSummaryHook,
  createGitWorktreeHook,
  createRepairTaskHook,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  runReadyTasks,
  runUntilIdle,
} from "@ouroboros/runner";
import { fail, flag, parseArgs, required } from "./args";
import { parseArray, parseObject, printJson } from "./json";
import { serveDashboard } from "./dashboard";
import { join } from "node:path";

const parsed = parseArgs(Bun.argv.slice(2));
const harness = new Harness(parsed.db);

switch (parsed.command) {
  case "init": {
    harness.init();
    printJson({ db: parsed.db, status: "initialized" });
    break;
  }
  case "create-run": {
    const goal = required(parsed, "goal");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const id = harness.createRun({ goal, context });
    printJson({ id, goal, status: "todo" });
    break;
  }
  case "create-task": {
    const runId = required(parsed, "run-id");
    const role = required(parsed, "role");
    const goal = required(parsed, "goal");
    const prompt = required(parsed, "prompt");
    const dependsOn = parseArray(flag(parsed, "depends-on-json") ?? "[]");
    const doneWhen = parseArray(flag(parsed, "done-when-json") ?? "[]");
    const parentId = flag(parsed, "parent-id") ?? null;
    const id = harness.createTask({
      runId,
      role,
      goal,
      prompt,
      dependsOn,
      doneWhen,
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
    const executorName = parseExecutorName(required(parsed, "executor"));
    const runId = required(parsed, "run-id");
    const limit = parsePositiveInteger(flag(parsed, "limit") ?? "1", "--limit");
    if (executorName === "codex-resumable") {
      const result = await runCodexResumableLoop({ runId, maxRounds: 1, limit });
      printJson({ tasks: result.rounds.flatMap((round) => round.tasks) });
      break;
    }
    const result = await runReadyTasks({
      harness,
      runId,
      limit,
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
      stopHooksByRole: stopHooksByRole(),
    });
    printJson({ tasks: result });
    break;
  }
  case "run-loop": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    const runId = required(parsed, "run-id");
    const limit = parsePositiveInteger(flag(parsed, "limit") ?? "1", "--limit");
    const maxRounds = parsePositiveInteger(flag(parsed, "max-rounds") ?? "10", "--max-rounds");
    if (executorName === "codex-resumable") {
      printJson(await runCodexResumableLoop({ runId, maxRounds, limit }));
      break;
    }
    const result = await runUntilIdle({
      harness,
      runId,
      limit,
      maxRounds,
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
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
        limit: parsePositiveInteger(flag(parsed, "limit") ?? "1", "--limit"),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      }),
    );
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
        summary: String(output.summary ?? ""),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: Array.isArray(output.problems) ? output.problems.map(String) : [],
      },
    });
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
    const server = serveDashboard({
      runId,
      port,
      overview: () =>
        harness.getRunOverview({
          runId,
          eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
        }),
      renderTaskPrompt,
    });
    console.log(`Ouroboros dashboard: http://localhost:${server.port}`);
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
    const input = {
      prompt,
      sessionName,
      executor: "codex-resumable",
    };
    const attemptId = harness.startAttempt({ taskId, input });
    const recorder = createAttemptEventRecorder(attemptId);
    const result = await codexResumableClient().start({
      prompt,
      sessionName,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    harness.updateAttemptInput({
      attemptId,
      input: codexAttemptInput({ prompt, sessionName, result }),
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
    harness.finishAttempt({
      attemptId,
      output: withCodexArtifacts(result.output, result.sessionId),
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
    const result = await codexResumableClient().resume({
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
  return ({ cwd }: { cwd: string }) => {
    if (executorName === "noop") {
      return async ({ task }: { task: { id: string } }) => ({
        status: "done" as const,
        summary: `Noop executor completed ${task.id}`,
        changedFiles: [],
        checks: [{ name: "noop executor", status: "passed" as const }],
        artifacts: [],
        problems: [],
      });
    }
    if (executorName === "acpx-codex") {
      return createAcpxCodexExecutor({
        cwd,
        approval: parseApproval(flag(parsed, "approval") ?? "approve-reads"),
        timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
        idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
      });
    }
    if (executorName === "codex-resumable") {
      fail("codex-resumable uses the resumable loop path");
    }
    return createCodexCliExecutor({
      cwd,
      sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
      codexBin: flag(parsed, "codex-bin"),
      model: flag(parsed, "model"),
      timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
      idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
    });
  };
}

async function runCodexResumableLoop(input: { runId: string; maxRounds: number; limit: number }) {
  const rounds = [];
  for (let index = 0; index < input.maxRounds; index += 1) {
    const resumed = await resumeRunningCodexAttempts({ runId: input.runId, limit: input.limit });
    if (resumed.length > 0) {
      rounds.push({ index, tasks: resumed });
      if (resumed.some((task) => task.status === "running")) {
        break;
      }
      continue;
    }

    const started = await startReadyCodexAttempts({ runId: input.runId, limit: input.limit });
    if (started.length === 0) {
      const review = ensureGoalReviewTask(input.runId);
      if (review.created) {
        const reviewed = await startReadyCodexAttempts({ runId: input.runId, limit: input.limit });
        if (reviewed.length > 0) {
          rounds.push({ index, tasks: reviewed, goalReview: review });
          if (reviewed.some((task) => task.status === "running")) {
            break;
          }
          continue;
        }
      }
      break;
    }
    rounds.push({ index, tasks: started });
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
  intervalMs: number;
}) {
  const cycles = [];
  for (let index = 0; index < input.maxCycles; index += 1) {
    const result = await runCodexResumableLoop({
      runId: input.runId,
      maxRounds: input.maxRounds,
      limit: input.limit,
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

function ensureGoalReviewTask(runId: string) {
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
  const taskId = harness.createTask({
    runId,
    role: "goal-review",
    goal: "Review whether the run goal is complete",
    prompt: [
      "Answer this before creating more work: are we sure the original run goal has been reached?",
      "",
      "Inspect the repository, README, tests, dashboard state, recent attempts, and run lessons.",
      "Return structured JSON with one of these decisions:",
      "- runDecision complete: the run goal is satisfied; do not include nextTasks.",
      "- runDecision continue: the run goal is not satisfied; include exactly one nextTasks item, usually a planner.",
      "- runDecision verify: completion is uncertain; include exactly one verifier nextTasks item.",
    ].join("\n"),
    doneWhen: [
      "runDecision is complete, continue, or verify",
      "complete does not create nextTasks",
      "continue or verify includes exactly one nextTasks item",
    ],
  });
  return { created: true as const, taskId };
}

async function resumeRunningCodexAttempts(input: { runId: string; limit: number }) {
  const attempts = harness.listRunningAttempts({ runId: input.runId }).slice(0, input.limit);
  const tasks = [];
  for (const attempt of attempts) {
    const task = harness.getTask(attempt.taskId);
    if (!task) {
      continue;
    }
    const run = harness.getRun(task.runId);
    if (!run) {
      continue;
    }
    const sessionId = typeof attempt.input.codexSessionId === "string" ? attempt.input.codexSessionId : "";
    if (!sessionId) {
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
      tasks.push({
        taskId: task.id,
        attemptId: attempt.id,
        sessionName: typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`,
        status: "blocked",
        codexSessionId: null,
      });
      continue;
    }
    const sessionName = typeof attempt.input.sessionName === "string" ? attempt.input.sessionName : `attempt-${attempt.id}`;
    const prompt =
      typeof attempt.input.prompt === "string"
        ? attempt.input.prompt
        : "Continue until you can return the required structured JSON.";
    const recorder = createAttemptEventRecorder(attempt.id);
    const result = await codexResumableClient().resume({
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
        ...codexAttemptInput({ prompt, sessionName, result }),
      },
    });
    if (result.status === "running") {
      tasks.push({
        taskId: task.id,
        attemptId: attempt.id,
        sessionName,
        status: "running",
        codexSessionId: result.sessionId,
      });
      continue;
    }
    const { output, decision } = await applyCliStopHooks({
      run,
      task,
      sessionName,
      prompt,
      output: withCodexArtifacts(result.output, result.sessionId),
    });
    harness.finishAttempt({ attemptId: attempt.id, output });
    if (decision === "retry") {
      harness.retryTask({ taskId: task.id });
    }
    tasks.push({
      taskId: task.id,
      attemptId: attempt.id,
      sessionName,
      status: output.status,
      codexSessionId: result.sessionId,
    });
  }
  return tasks;
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
  const tasks = [];
  for (const task of leased) {
    const sessionName = task.sessionRef ?? `task-${task.id}`;
    const prompt = buildTaskPrompt({
      run,
      task,
      dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
      lessons: harness.listLessons({ runId: run.id }),
      template: harness.getPromptTemplate("task")?.contentMd,
    });
    const baseInput = {
      prompt,
      sessionName,
      executor: "codex-resumable",
    };
    const attemptId = harness.startAttempt({ taskId: task.id, input: baseInput });
    const recorder = createAttemptEventRecorder(attemptId);
    const result = await codexResumableClient().start({
      prompt,
      sessionName,
      onStdout: recorder.stdout,
      onStderr: recorder.stderr,
      onEvent: recorder.event,
    });
    const attemptInput = codexAttemptInput({ prompt, sessionName, result });
    harness.updateAttemptInput({ attemptId, input: attemptInput });
    if (result.status === "running") {
      tasks.push({
        taskId: task.id,
        attemptId,
        sessionName,
        status: "running",
        codexSessionId: result.sessionId,
      });
      continue;
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
      output,
    });
    if (decision === "retry") {
      harness.retryTask({ taskId: task.id });
    }
    tasks.push({
      taskId: task.id,
      attemptId,
      sessionName,
      status: output.status,
      codexSessionId: result.sessionId,
    });
  }
  return tasks;
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
  if (input.task.role === "goal-review") {
    const result = applyGoalReviewDecision(input);
    return {
      output: result.output,
      decision: result.decision,
    };
  }
  const hooks = [
    ...(stopHooksByRole()[input.task.role as "planner" | "worker" | "verifier"] ?? []),
  ];
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

function applyGoalReviewDecision(input: {
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  output: AttemptOutput;
}) {
  const output = {
    ...input.output,
    checks: [...(input.output.checks ?? [])],
    artifacts: [...(input.output.artifacts ?? [])],
    problems: [...(input.output.problems ?? [])],
  };
  if (!output.runDecision) {
    output.status = "blocked";
    output.problems = [...(output.problems ?? []), "goal-review output must include runDecision"];
    return { output, decision: "exit" as const };
  }
  output.artifacts = [
    ...(output.artifacts ?? []),
    {
      kind: "goal_review",
      runDecision: output.runDecision,
      taskId: input.task.id,
    },
  ];

  if (output.runDecision === "complete") {
    if ((output.nextTasks ?? []).length > 0) {
      output.status = "blocked";
      output.problems = [...(output.problems ?? []), "complete goal-review must not include nextTasks"];
      return { output, decision: "exit" as const };
    }
    harness.updateRunStatus({ runId: input.run.id, status: "done" });
    return { output, decision: "exit" as const };
  }

  const nextTasks = output.nextTasks ?? [];
  if (nextTasks.length !== 1) {
    output.status = "blocked";
    output.problems = [
      ...(output.problems ?? []),
      `${output.runDecision} goal-review must include exactly one nextTasks item`,
    ];
    return { output, decision: "exit" as const };
  }

  const created = nextTasks.map((plannedTask) => {
    const taskId = harness.createTask({
      runId: input.run.id,
      role: plannedTask.role,
      goal: plannedTask.goal,
      prompt: plannedTask.prompt,
      dependsOn: plannedTask.dependsOn ?? [input.task.id],
      doneWhen: plannedTask.doneWhen ?? [],
    });
    return {
      kind: "created_task",
      taskId,
      sourceTaskId: input.task.id,
    };
  });
  output.artifacts = [...(output.artifacts ?? []), ...created];
  return { output, decision: "exit" as const };
}

function codexResumableClient() {
  return createCodexResumableClient({
    cwd: runnerCwd(),
    sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
    codexBin: flag(parsed, "codex-bin"),
    model: flag(parsed, "model"),
    timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
    idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
  });
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
}) {
  return {
    prompt: input.prompt,
    sessionName: input.sessionName,
    executor: "codex-resumable",
    codexSessionId: input.result.sessionId,
    outputPath: input.result.outputPath,
    stdout: input.result.stdout,
    stderr: input.result.stderr,
    events: input.result.events,
  };
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
  return (task: { id: string }) => join(root, task.id);
}

function stopHooksByRole() {
  const raw = flag(parsed, "stop-hook");
  const hooks = {
    planner: [],
    worker: [],
    verifier: [],
  } as {
    planner: ReturnType<typeof createTasksFromOutputHook>[];
    worker: ReturnType<typeof createVerifierTaskHook>[];
    verifier: Array<ReturnType<typeof createRepairTaskHook> | ReturnType<typeof createContextSummaryHook>>;
  };
  if (!raw) {
    return hooks;
  }
  for (const hook of raw.split(",")) {
    if (hook === "create-tasks") {
      hooks.planner.push(createTasksFromOutputHook({ harness }));
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
    fail("--stop-hook must contain create-tasks, create-verifier, create-repair, or context-summary");
  }
  return hooks;
}

function startHooks() {
  const hook = flag(parsed, "start-hook");
  if (!hook) {
    return [];
  }
  if (hook !== "git-worktree") {
    fail("--start-hook must be git-worktree");
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
