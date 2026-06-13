import { parseAttemptOutputOrBlocked } from "./output";
import { commandProblem, runLocalCommand } from "./command";
import type { AcpxCodexExecutorFactory, ApprovalMode, RunCommand } from "./types";

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = options.runCommand ?? runLocalCommand;

  return async ({ prompt, sessionName }) => {
    const base = [
      "acpx",
      "--cwd",
      options.cwd,
      approvalFlag(approval),
      "--format",
      "text",
      "codex",
    ];
    const session = await ensureSession({
      base,
      runCommand,
      sessionName,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    });
    if (session) {
      return session;
    }

    let result = await runPrompt({
      base,
      runCommand,
      sessionName,
      prompt,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    });
    if (commandFailed(result) && needsReconnect(result)) {
      await runCommand({
        cmd: [...base, "sessions", "close", sessionName],
        stdin: "",
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
      });
      const recreated = await ensureSession({
        base,
        runCommand,
        sessionName,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        forceCreate: true,
      });
      if (recreated) {
        return recreated;
      }
      result = await runPrompt({
        base,
        runCommand,
        sessionName,
        prompt,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
      });
    }

    if (commandFailed(result)) {
      return {
        status: "blocked",
        summary: "acpx codex executor failed",
        changedFiles: [],
        checks: [{ name: "acpx codex exec", status: "failed" }],
        artifacts: [],
        problems: [commandProblem(result)],
      };
    }

    return parseAttemptOutputOrBlocked({
      raw: result.stdout,
      summary: "acpx codex executor produced invalid output",
      checkName: "acpx output parse",
    });
  };
};

async function ensureSession(input: {
  base: string[];
  runCommand: RunCommand;
  sessionName: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  forceCreate?: boolean;
}) {
  const showSessionCommand = [...input.base, "sessions", "show", input.sessionName];
  if (!input.forceCreate) {
    const existing = await input.runCommand({
      cmd: showSessionCommand,
      stdin: "",
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    });
    if (!commandFailed(existing)) {
      return null;
    }
  }

  const created = await input.runCommand({
    cmd: [...input.base, "sessions", "new", "--name", input.sessionName],
    stdin: "",
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  });
  if (commandFailed(created)) {
    return {
      status: "blocked" as const,
      summary: "acpx session creation failed",
      changedFiles: [],
      checks: [{ name: "acpx sessions new", status: "failed" }],
      artifacts: [],
      problems: [commandProblem(created)],
    };
  }

  const verified = await input.runCommand({
    cmd: showSessionCommand,
    stdin: "",
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  });
  if (!commandFailed(verified)) {
    return null;
  }

  const diagnostic =
    created.stdout.trim().length === 0 && created.stderr.trim().length === 0
      ? await input.runCommand({
          cmd: ["acpx", "--verbose", ...input.base.slice(1), "sessions", "new", "--name", input.sessionName],
          stdin: "",
          timeoutMs: input.timeoutMs,
          idleTimeoutMs: input.idleTimeoutMs,
        })
      : null;
  return {
    status: "blocked" as const,
    summary: "acpx session creation failed",
    changedFiles: [],
    checks: [{ name: "acpx sessions new", status: "failed" }],
    artifacts: [],
    problems: [sessionCreationProblem(created, verified, diagnostic)],
  };
}

function runPrompt(input: {
  base: string[];
  runCommand: RunCommand;
  sessionName: string;
  prompt: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}) {
  return input.runCommand({
    cmd: [...input.base, "-s", input.sessionName],
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  });
}

function approvalFlag(approval: ApprovalMode) {
  return `--${approval}`;
}

function commandFailed(result: { exitCode: number; stdout: string; stderr: string }) {
  return result.exitCode !== 0 || result.stderr.includes("Error:") || result.stdout.includes("Error:");
}

function needsReconnect(result: { stdout: string; stderr: string }) {
  return `${result.stdout}\n${result.stderr}`.includes("needs reconnect");
}

function sessionCreationProblem(
  created: { exitCode: number; stdout: string; stderr: string },
  verified: { exitCode: number; stdout: string; stderr: string },
  diagnostic?: { exitCode: number; stdout: string; stderr: string } | null,
) {
  const parts = [
    ["sessions new stdout", created.stdout],
    ["sessions new stderr", created.stderr],
    ["sessions show stdout", verified.stdout],
    ["sessions show stderr", verified.stderr],
    ["verbose sessions new stdout", diagnostic?.stdout ?? ""],
    ["verbose sessions new stderr", diagnostic?.stderr ?? ""],
  ]
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `${label}:\n${value.trim()}`);

  return parts.length > 0 ? parts.join("\n\n") : `exit code ${verified.exitCode}`;
}
