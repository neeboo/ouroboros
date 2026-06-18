import { access, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { parseAttemptOutput, parseAttemptOutputOrBlocked } from "./output";
import { commandProblem, runLocalCommand } from "./command";
import type { AcpxAgentExecutorFactory, AcpxCodexExecutorFactory, ApprovalMode, RunCommand } from "./types";
import type { ExecutorEventRecorder } from "../types";

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  return createAcpxAgentExecutor({ ...options, agent: "codex" });
};

export const createAcpxAgentExecutor: AcpxAgentExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = options.runCommand ?? runLocalCommand;
  const label = agentLabel(options);
  const oneShotExec = options.agent === "claude";

  return async ({ prompt, sessionName, recorder }) => {
    const env = await acpxCommandEnv({
      cwd: options.cwd,
      sessionName,
      agentCommand: options.agentCommand,
      env: options.env,
      prepareHermesHome: options.prepareHermesHome,
    });
    const base = acpxBaseCommand({
      cwd: options.cwd,
      approval,
      model: options.model,
      agent: options.agent,
      agentCommand: options.agentCommand,
    });
    recorder?.event({
      type: "acpx.attempt.started",
      agent: label,
      sessionName,
      approval,
      cwd: options.cwd,
      model: options.model ?? null,
      oneShot: oneShotExec,
      timeoutMs: options.timeoutMs ?? null,
      idleTimeoutMs: options.idleTimeoutMs ?? null,
    });
    if (!oneShotExec) {
      const session = await ensureSession({
        base,
        runCommand,
        env,
        sessionName,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        recorder,
      });
      if (session) {
        return session;
      }
    }

    let result = await runPrompt({
      base,
      runCommand,
      env,
      sessionName,
      prompt,
      oneShotExec,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      recorder,
    });
    if (!oneShotExec && commandFailed(result) && needsReconnect(result)) {
      recorder?.event({ type: "acpx.attempt.reconnect", sessionName });
      await runCommand({
        cmd: [...base, "sessions", "close", sessionName],
        stdin: "",
        env,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
      });
      const recreated = await ensureSession({
        base,
        runCommand,
        env,
        sessionName,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        forceCreate: true,
        recorder,
      });
      if (recreated) {
        return recreated;
      }
      result = await runPrompt({
        base,
        runCommand,
        env,
        sessionName,
        prompt,
        oneShotExec,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        recorder,
      });
    }

    if (isIdleTimeout(result)) {
      recorder?.event({
        type: "acpx.attempt.idle_timeout",
        sessionName,
        idleTimeoutMs: options.idleTimeoutMs ?? null,
      });
      return blockedFromIdleTimeout({
        label,
        result,
        idleTimeoutMs: options.idleTimeoutMs,
      });
    }

    const parsedOutput = parseSuccessfulPromptOutput(result);
    if (parsedOutput) {
      return parsedOutput;
    }

    if (commandFailed(result)) {
      return {
        status: "blocked",
        summary: `acpx ${label} executor failed`,
        changedFiles: [],
        checks: [{ name: `acpx ${label} exec`, status: "failed" }],
        artifacts: [],
        problems: [commandProblem(result)],
      };
    }

    return parseAttemptOutputOrBlocked({
      raw: result.stdout,
      summary: `acpx ${label} executor produced invalid output`,
      checkName: "acpx output parse",
    });
  };
};

function acpxBaseCommand(input: {
  cwd: string;
  approval: ApprovalMode;
  model?: string;
  agent?: string;
  agentCommand?: string;
}) {
  const modelArgs = input.model ? ["--model", input.model] : [];
  const agentArgs = input.agentCommand ? ["--agent", input.agentCommand] : [input.agent ?? "codex"];
  return ["acpx", "--cwd", input.cwd, approvalFlag(input.approval), "--format", "text", ...modelArgs, ...agentArgs];
}

async function acpxCommandEnv(input: {
  cwd: string;
  sessionName: string;
  agentCommand?: string;
  env?: Record<string, string | undefined>;
  prepareHermesHome?: (input: { cwd: string; sessionName: string; sourceHome: string }) => Promise<string | null>;
}) {
  const env = { ...(input.env ?? {}) };
  if (isHermesAgentCommand(input.agentCommand) && !env.HERMES_HOME) {
    const sourceHome = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
    const prepareHermesHome = input.prepareHermesHome ?? defaultPrepareHermesHome;
    const hermesHome = await prepareHermesHome({ cwd: input.cwd, sessionName: input.sessionName, sourceHome });
    if (hermesHome) {
      env.HERMES_HOME = hermesHome;
    }
  }
  return env;
}

function isHermesAgentCommand(agentCommand: string | undefined) {
  return agentCommand?.trim() === "hermes acp" || agentCommand?.trim() === "hermes-acp";
}

async function defaultPrepareHermesHome(input: { sessionName: string; sourceHome: string }) {
  const target = await mkdtemp(join(tmpdir(), `orbs-hermes-${safePathPart(input.sessionName)}-`));
  await mkdir(join(target, "logs"), { recursive: true });
  await mkdir(join(target, "sessions"), { recursive: true });
  await copyIfExists(join(input.sourceHome, ".env"), join(target, ".env"));
  await copyIfExists(join(input.sourceHome, "config.yaml"), join(target, "config.yaml"));
  await copyIfExists(join(input.sourceHome, "auth.json"), join(target, "auth.json"));
  return target;
}

async function copyIfExists(from: string, to: string) {
  try {
    await access(from);
    await copyFile(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "session";
}

function agentLabel(input: { agent?: string; agentCommand?: string }) {
  return input.agent ?? input.agentCommand ?? "codex";
}

async function ensureSession(input: {
  base: string[];
  runCommand: RunCommand;
  env: Record<string, string | undefined>;
  sessionName: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  forceCreate?: boolean;
  recorder?: ExecutorEventRecorder;
}) {
  const showSessionCommand = [...input.base, "sessions", "show", input.sessionName];
  if (!input.forceCreate) {
    const existing = await input.runCommand({
      cmd: showSessionCommand,
      stdin: "",
      env: input.env,
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
    env: input.env,
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
    env: input.env,
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
          env: input.env,
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
  env: Record<string, string | undefined>;
  sessionName: string;
  prompt: string;
  oneShotExec?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  recorder?: ExecutorEventRecorder;
}) {
  return input.runCommand({
    cmd: input.oneShotExec ? [...input.base, "exec", "-f", "-"] : [...input.base, "-s", input.sessionName],
    stdin: input.prompt,
    env: input.env,
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    cleanupOnFailure: true,
    onStdout: input.recorder ? (chunk) => input.recorder!.stdout(chunk) : undefined,
    onStderr: input.recorder ? (chunk) => input.recorder!.stderr(chunk) : undefined,
  });
}

function approvalFlag(approval: ApprovalMode) {
  return `--${approval}`;
}

function commandFailed(result: { exitCode: number; stdout: string; stderr: string }) {
  return result.exitCode !== 0 || result.stderr.includes("Error:") || result.stdout.includes("Error:");
}

const IDLE_TIMEOUT_PATTERN = /command idle timed out after (\d+)ms/;

function idleTimeoutMsFromResult(result: { exitCode: number; stdout: string; stderr: string }): number | null {
  if (result.exitCode !== 124) {
    return null;
  }
  const match = IDLE_TIMEOUT_PATTERN.exec(result.stderr);
  return match ? Number(match[1]) : null;
}

function isIdleTimeout(result: { exitCode: number; stdout: string; stderr: string }) {
  return idleTimeoutMsFromResult(result) !== null;
}

function blockedFromIdleTimeout(input: {
  label: string;
  result: { exitCode: number; stdout: string; stderr: string };
  idleTimeoutMs?: number;
}) {
  const observedMs = idleTimeoutMsFromResult(input.result) ?? input.idleTimeoutMs;
  const summary = observedMs
    ? `acpx ${input.label} executor silent for ${observedMs}ms (idle timeout)`
    : `acpx ${input.label} executor silent (idle timeout)`;
  return {
    status: "blocked" as const,
    summary,
    changedFiles: [],
    checks: [{ name: `acpx ${input.label} idle`, status: "failed" as const }],
    artifacts: [],
    problems: [
      [
        `acpx ${input.label} executor produced no output for the idle timeout window (${observedMs ?? "?"}ms).`,
        "The agent command stayed alive but emitted nothing on stdout or stderr.",
        "exit code: 124",
        ...(input.result.stdout.trim().length > 0 ? [`stdout:\n${input.result.stdout.trim()}`] : []),
        ...(input.result.stderr.trim().length > 0 ? [`stderr:\n${input.result.stderr.trim()}`] : []),
      ].join("\n\n"),
    ],
  };
}

function parseSuccessfulPromptOutput(result: { exitCode: number; stdout: string; stderr: string }) {
  if (result.exitCode !== 0) {
    return null;
  }
  try {
    return parseAttemptOutput(result.stdout);
  } catch {
    return null;
  }
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
