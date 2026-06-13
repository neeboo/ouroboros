#!/usr/bin/env bun
import { Harness } from "@ouroboros/harness";
import {
  createAcpxCodexExecutor,
  createCodexCliExecutor,
  createGitWorktreeHook,
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
      stopHooks: stopHooks(),
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
      stopHooks: stopHooks(),
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
      });
    }
    return createCodexCliExecutor({
      cwd,
      sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
      codexBin: flag(parsed, "codex-bin"),
      model: flag(parsed, "model"),
      timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
    });
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

function stopHooks() {
  const raw = flag(parsed, "stop-hook");
  if (!raw) {
    return [];
  }
  return raw.split(",").map((hook) => {
    if (hook === "create-tasks") {
      return createTasksFromOutputHook({ harness });
    }
    if (hook === "create-verifier") {
      return createVerifierTaskHook({ harness });
    }
    fail("--stop-hook must contain create-tasks or create-verifier");
  });
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

function parseTimeoutMs(raw: string | undefined) {
  if (raw === undefined) {
    return undefined;
  }
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    fail("--timeout-ms must be a positive integer");
  }
  return timeoutMs;
}
