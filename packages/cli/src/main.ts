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
    const result = await codexResumableClient().start({ prompt, sessionName });
    const input = codexAttemptInput({ prompt, sessionName, result });
    if (result.status === "running") {
      const attemptId = harness.startAttempt({ taskId, input });
      printJson({
        attemptId,
        taskId,
        status: "running",
        codexSessionId: result.sessionId,
      });
      break;
    }
    const attemptId = harness.recordAttempt({
      taskId,
      input,
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
    const result = await codexResumableClient().resume({
      sessionId,
      sessionName,
      prompt: flag(parsed, "prompt") ?? "Continue until you can return the required structured JSON.",
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
  if (raw !== "noop" && raw !== "acpx-codex" && raw !== "codex-cli") {
    fail(`unsupported executor: ${raw}`);
  }
  return raw;
}

function executorFactory(executorName: "noop" | "acpx-codex" | "codex-cli") {
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
