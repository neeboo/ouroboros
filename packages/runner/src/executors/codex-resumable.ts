import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexBin } from "./codex-bin";
import { commandProblem, runLocalCommand } from "./command";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import { withBrowserProcessPolicy } from "./browser-process-policy";
import type { AttemptOutput } from "@ouroboros/harness";
import { parseAttemptOutput, parseAttemptOutputOrBlocked } from "./output";
import { hostSandboxCapabilityOutput } from "./host-sandbox-capability";
import { prepareCodexHostExecution } from "./codex-host-execution";
import type { CodexCliExecutorOptions, RunCommand } from "./types";

export interface CodexResumableClientOptions extends CodexCliExecutorOptions {}

export interface CodexResumableStartInput {
  prompt: string;
  sessionName: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface CodexResumableResumeInput {
  sessionId: string;
  prompt?: string;
  sessionName: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

export type CodexResumableResult =
  | {
      status: "running";
      sessionId: string | null;
      outputPath: string;
      stdout: string;
      stderr: string;
      events: Array<Record<string, unknown>>;
    }
  | {
      status: "done" | "blocked";
      sessionId: string | null;
      outputPath: string;
      stdout: string;
      stderr: string;
      events: Array<Record<string, unknown>>;
      output: ReturnType<typeof parseAttemptOutput>;
    };

export function createCodexResumableClient(options: CodexResumableClientOptions) {
  const sandbox = options.sandbox ?? "read-only";
  const rawRunCommand = options.runCommand ?? runLocalCommand;
  const policyRunCommand = withBrowserProcessPolicy(rawRunCommand, options.browserProcessPolicy);
  const codexBin = options.codexBin ?? defaultCodexBin();

  return {
    start: async (input: CodexResumableStartInput) => {
      const unavailableHost = hostSandboxCapabilityOutput(sandbox, "codex client start");
      if (unavailableHost) {
        return blockedCapabilityResult(unavailableHost);
      }
      const oversized = inputTooLargeResult(input.prompt, "codex client start");
      if (oversized) {
        return oversized;
      }
      const hostExecution = await prepareCodexHostExecution({
        cwd: options.cwd,
        sandbox,
        browserProcessPolicy: options.browserProcessPolicy,
        injectedRunCommand: options.runCommand,
        hostExecutionCapabilities: options.hostExecutionCapabilities,
        taskRole: options.taskRole,
        verifierContract: options.verifierContract,
      });
      const modelArgs = options.model ? ["-m", options.model] : [];
      const reasoningArgs = options.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`] : [];
      const stdoutObserver = createStdoutObserver(input);
      let result;
      let outputPath = "";
      try {
        outputPath = await makeOutputPath(hostExecution?.outputDir ?? options.outputDir, input.sessionName);
        result = await (hostExecution ? rawRunCommand : policyRunCommand)({
          cmd: [
          codexBin,
          "exec",
          ...modelArgs,
          ...reasoningArgs,
          "--json",
          "--skip-git-repo-check",
          ...(hostExecution ? ["--strict-config"] : []),
          ...(hostExecution ? [] : ["--ignore-user-config"]),
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          outputPath,
          "-C",
          options.cwd,
          ...(hostExecution ? [] : ["--sandbox", sandbox]),
          "-",
          ],
          stdin: input.prompt,
          env: hostExecution?.env,
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          onStdout: stdoutObserver,
          onStderr: input.onStderr,
        });
      } finally {
        await hostExecution?.cleanup?.();
      }
      return resumableResult({ result, outputPath, commandName: "codex exec" });
    },
    resume: async (input: CodexResumableResumeInput) => {
      const unavailableHost = hostSandboxCapabilityOutput(sandbox, "codex client resume");
      if (unavailableHost) {
        return blockedCapabilityResult(unavailableHost);
      }
      const oversized = inputTooLargeResult(input.prompt ?? "", "codex client resume");
      if (oversized) {
        return oversized;
      }
      const hostExecution = await prepareCodexHostExecution({
        cwd: options.cwd,
        sandbox,
        browserProcessPolicy: options.browserProcessPolicy,
        injectedRunCommand: options.runCommand,
        hostExecutionCapabilities: options.hostExecutionCapabilities,
        taskRole: options.taskRole,
        verifierContract: options.verifierContract,
      });
      const modelArgs = options.model ? ["-m", options.model] : [];
      const reasoningArgs = options.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`] : [];
      const stdoutObserver = createStdoutObserver(input);
      let result;
      let outputPath = "";
      try {
        outputPath = await makeOutputPath(hostExecution?.outputDir ?? options.outputDir, input.sessionName);
        result = await (hostExecution ? rawRunCommand : policyRunCommand)({
          cmd: [
          codexBin,
          "exec",
          ...modelArgs,
          ...reasoningArgs,
          "--json",
          "--skip-git-repo-check",
          ...(hostExecution ? ["--strict-config"] : []),
          ...(hostExecution ? [] : ["--ignore-user-config"]),
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          outputPath,
          "-C",
          options.cwd,
          ...(hostExecution ? [] : ["--sandbox", sandbox]),
          "resume",
          input.sessionId,
          "-",
          ],
          stdin: input.prompt ?? "",
          env: hostExecution?.env,
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          onStdout: stdoutObserver,
          onStderr: input.onStderr,
        });
      } finally {
        await hostExecution?.cleanup?.();
      }
      return resumableResult({ result, outputPath, commandName: "codex exec resume" });
    },
  };
}

function blockedCapabilityResult(output: AttemptOutput): CodexResumableResult {
  return {
    status: "blocked",
    sessionId: null,
    outputPath: "",
    stdout: "",
    stderr: "",
    events: [],
    output,
  };
}


function inputTooLargeResult(prompt: string, phase: string): CodexResumableResult | null {
  const evidence = promptBudgetEvidence(prompt, phase);
  if (!evidence) {
    return null;
  }
  return {
    status: "blocked",
    sessionId: null,
    outputPath: "",
    stdout: "",
    stderr: "",
    events: [],
    output: promptBudgetBlockedOutput(evidence),
  };
}

function createStdoutObserver(input: {
  onStdout?: (chunk: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}) {
  let buffer = "";
  return (chunk: string) => {
    input.onStdout?.(chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed) {
        input.onEvent?.(parsed);
      }
    }
  };
}

async function resumableResult(input: {
  result: Awaited<ReturnType<RunCommand>>;
  outputPath: string;
  commandName: string;
}): Promise<CodexResumableResult> {
  const events = parseJsonLines(input.result.stdout);
  const sessionId = sessionIdFromEvents(events);
  if (input.result.exitCode === 124 && sessionId) {
    return {
      status: "running",
      sessionId,
      outputPath: input.outputPath,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      events,
    };
  }

  if (input.result.exitCode !== 0) {
    return {
      status: "blocked",
      sessionId,
      outputPath: input.outputPath,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      events,
      output: {
        status: "blocked",
        summary: `${input.commandName} failed`,
        changedFiles: [],
        checks: [{ name: input.commandName, status: "failed" }],
        artifacts: sessionId ? [{ kind: "codex_session", sessionId }] : [],
        problems: [commandProblem(input.result)],
      },
    };
  }

  const raw = (await readOutputFile(input.outputPath)) || finalMessageFromEvents(events) || input.result.stdout;
  const output = parseAttemptOutputOrBlocked({
    raw,
    summary: `${input.commandName} produced invalid output`,
    checkName: `${input.commandName} output parse`,
  });
  return {
    status: output.status,
    sessionId,
    outputPath: input.outputPath,
    stdout: input.result.stdout,
    stderr: input.result.stderr,
    events,
    output,
  };
}

function parseJsonLines(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsed = parseJsonLine(line);
      return parsed ? [parsed] : [];
    });
}

function parseJsonLine(line: string) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sessionIdFromEvents(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    const value = sessionIdFromValue(event);
    if (value) {
      return value;
    }
  }
  return null;
}

function sessionIdFromValue(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const sessionId = sessionIdFromValue(entry, depth + 1);
      if (sessionId) {
        return sessionId;
      }
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "thread_id",
    "threadId",
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  for (const entry of Object.values(record)) {
    const sessionId = sessionIdFromValue(entry, depth + 1);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function finalMessageFromEvents(events: Array<Record<string, unknown>>) {
  for (const event of [...events].reverse()) {
    for (const key of ["message", "text", "content", "delta"]) {
      const value = event[key];
      if (typeof value === "string" && value.includes("{")) {
        return value;
      }
    }
  }
  return "";
}

async function makeOutputPath(outputDir: string | undefined, sessionName: string) {
  const dir = outputDir ?? tmpdir();
  await mkdir(dir, { recursive: true });
  const safeSession = sessionName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(dir, `ouroboros-${safeSession}-${Date.now()}.json`);
}

async function readOutputFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
