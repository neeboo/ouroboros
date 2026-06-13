#!/usr/bin/env bun
import { Harness } from "@ouroboros/harness";
import {
  createAcpxCodexExecutor,
  createCodexCliExecutor,
  createTasksFromOutputHook,
  runReadyTasks,
} from "@ouroboros/runner";
import { fail, flag, parseArgs, required } from "./args";
import { parseArray, parseObject, printJson } from "./json";

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
    const executorName = required(parsed, "executor");
    const runId = required(parsed, "run-id");
    const limit = Number(flag(parsed, "limit") ?? "1");
    if (!Number.isInteger(limit) || limit < 1) {
      fail("--limit must be a positive integer");
    }
    if (executorName !== "noop" && executorName !== "acpx-codex" && executorName !== "codex-cli") {
      fail(`unsupported executor: ${executorName}`);
    }
    const result = await runReadyTasks({
      harness,
      runId,
      limit,
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      executorFactory: () => {
        if (executorName === "noop") {
          return async ({ task }) => ({
            status: "done",
            summary: `Noop executor completed ${task.id}`,
            changedFiles: [],
            checks: [{ name: "noop executor", status: "passed" }],
            artifacts: [],
            problems: [],
          });
        }
        if (executorName === "acpx-codex") {
          return createAcpxCodexExecutor({
            cwd: runnerCwd(),
            approval: parseApproval(flag(parsed, "approval") ?? "approve-reads"),
            timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
          });
        }
        return createCodexCliExecutor({
          cwd: runnerCwd(),
          sandbox: parseSandbox(flag(parsed, "sandbox") ?? "read-only"),
          codexBin: flag(parsed, "codex-bin"),
          timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
        });
      },
      stopHooks: stopHooks(),
    });
    printJson({ tasks: result });
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

function runnerCwd() {
  return flag(parsed, "cwd") ?? process.cwd();
}

function stopHooks() {
  const hook = flag(parsed, "stop-hook");
  if (!hook) {
    return [];
  }
  if (hook !== "create-tasks") {
    fail("--stop-hook must be create-tasks");
  }
  return [createTasksFromOutputHook({ harness })];
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
