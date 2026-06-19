import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexBin } from "./codex-bin";
import { commandProblem, runLocalCommand } from "./command";
import { parseAttemptOutput, parseAttemptOutputOrBlocked } from "./output";
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
  const runCommand = options.runCommand ?? runLocalCommand;
  const codexBin = options.codexBin ?? defaultCodexBin();

  return {
    start: async (input: CodexResumableStartInput) => {
      const outputPath = await makeOutputPath(options.outputDir, input.sessionName);
      const modelArgs = options.model ? ["-m", options.model] : [];
      const stdoutObserver = createStdoutObserver(input);
      const result = await runCommand({
        cmd: [
          codexBin,
          "exec",
          ...modelArgs,
          "--json",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          outputPath,
          "-C",
          options.cwd,
          "--sandbox",
          sandbox,
          "-",
        ],
        stdin: input.prompt,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        onStdout: stdoutObserver,
        onStderr: input.onStderr,
      });
      return resumableResult({ result, outputPath, commandName: "codex exec" });
    },
    resume: async (input: CodexResumableResumeInput) => {
      const outputPath = await makeOutputPath(options.outputDir, input.sessionName);
      const modelArgs = options.model ? ["-m", options.model] : [];
      const stdoutObserver = createStdoutObserver(input);
      const result = await runCommand({
        cmd: [
          codexBin,
          "exec",
          "resume",
          input.sessionId,
          ...modelArgs,
          "--json",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          outputPath,
          "-C",
          options.cwd,
          "--sandbox",
          sandbox,
          "-",
        ],
        stdin: input.prompt ?? "",
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        onStdout: stdoutObserver,
        onStderr: input.onStderr,
      });
      return resumableResult({ result, outputPath, commandName: "codex exec resume" });
    },
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

function sessionIdFromEvents(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
      const value = event[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
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
