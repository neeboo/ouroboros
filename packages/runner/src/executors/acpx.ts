import { parseAttemptOutput, parseAttemptOutputOrBlocked } from "./output";
import { commandProblem, runLocalCommand } from "./command";
import { createInMemoryAttemptReplayCache } from "./replay";
import { withBrowserProcessPolicy } from "./browser-process-policy";
import type {
  AcpxAgentExecutorFactory,
  AcpxCodexExecutorFactory,
  ApprovalMode,
  AttemptReplayCache,
  RunCommand,
  WorktreeEvidenceProbe,
} from "./types";
import type { ExecutorEventRecorder } from "../types";
import type { AttemptOutput } from "@ouroboros/harness";

const RECOVERY_PROMPT = [
  "Output only the existing attempt-result JSON envelope.",
  "Do not perform any additional work.",
  "Reply with a single JSON object that matches the AttemptOutput contract:",
  '{"status":"done"|"blocked","summary":string,"changedFiles":string[],"checks":[],"artifacts":[],"problems":string[]}',
  "Use the files, checks, and artifacts you already produced this turn.",
].join(" ");

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  return createAcpxAgentExecutor({ ...options, agent: "codex" });
};

export const createAcpxAgentExecutor: AcpxAgentExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = withBrowserProcessPolicy(options.runCommand ?? runLocalCommand, options.browserProcessPolicy);
  const label = agentLabel(options);
  const oneShotExec = options.agent === "claude" && !options.format;
  const replayCache: AttemptReplayCache = options.replayCache ?? createInMemoryAttemptReplayCache();

  return async ({ prompt, sessionName, recorder, attemptId, task }) => {
    if (attemptId) {
      const cached = replayCache.getTerminalResult(attemptId);
      if (cached) {
        recorder?.event({
          type: "acpx.attempt.replay.terminal",
          agent: label,
          sessionName,
          attemptId,
        });
        return cached;
      }
    }
    const ownsInitialRequest = !attemptId || replayCache.reserveInitialRequest(attemptId);
    if (!ownsInitialRequest) {
      recorder?.event({
        type: "acpx.attempt.replay.skip_initial",
        agent: label,
        sessionName,
        attemptId: attemptId ?? null,
      });
      return blockedFromReplaySkip({ label, sessionName, attemptId });
    }

    const env = await acpxCommandEnv({
      env: options.env,
    });
    const base = acpxBaseCommand({
      cwd: options.cwd,
      approval,
      format: options.format,
      model: options.model,
      agent: options.agent,
      agentCommand: options.agentCommand,
    });
    const worktreePath = task?.worktreePath ?? null;
    recorder?.event({
      type: "acpx.attempt.started",
      agent: label,
      sessionName,
      approval,
      cwd: options.cwd,
      model: options.model ?? null,
      format: options.format ?? "text",
      oneShot: oneShotExec,
      timeoutMs: options.timeoutMs ?? null,
      idleTimeoutMs: options.idleTimeoutMs ?? null,
      attemptId: attemptId ?? null,
      worktreePath,
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
        const output = session;
        if (attemptId) {
          replayCache.recordTerminalResult(attemptId, output);
        }
        return output;
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
    recorder?.event({
      type: "acpx.attempt.terminal",
      agent: label,
      sessionName,
      attemptId: attemptId ?? null,
      exitCode: result.exitCode,
    });
    if (!oneShotExec && commandFailed(result) && needsReconnect(result)) {
      const ownsRecovery = !attemptId || replayCache.reserveRecoveryRequest(attemptId);
      if (!ownsRecovery) {
        recorder?.event({
          type: "acpx.attempt.replay.skip_recovery",
          agent: label,
          sessionName,
          attemptId: attemptId ?? null,
        });
        const output = await blockedFromRecoveryExhausted({
          label,
          sessionName,
          attemptId,
          result,
          options,
          worktreePath,
        });
        if (attemptId) {
          replayCache.recordTerminalResult(attemptId, output);
        }
        return output;
      }
      recorder?.event({ type: "acpx.attempt.reconnect", sessionName, attemptId: attemptId ?? null });
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
        const output = recreated;
        if (attemptId) {
          replayCache.recordTerminalResult(attemptId, output);
        }
        return output;
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
      recorder?.event({
        type: "acpx.attempt.terminal",
        agent: label,
        sessionName,
        attemptId: attemptId ?? null,
        exitCode: result.exitCode,
      });
    }

    let output: AttemptOutput;
    if (isIdleTimeout(result)) {
      recorder?.event({
        type: "acpx.attempt.idle_timeout",
        sessionName,
        idleTimeoutMs: options.idleTimeoutMs ?? null,
        attemptId: attemptId ?? null,
      });
      output = await blockedFromIdleTimeout({
        label,
        sessionName,
        cwd: options.cwd,
        result,
        idleTimeoutMs: options.idleTimeoutMs,
        options,
        worktreePath,
      });
    } else if (isHardTimeout(result, options.timeoutMs)) {
      recorder?.event({
        type: "acpx.attempt.hard_timeout",
        sessionName,
        timeoutMs: options.timeoutMs ?? null,
        attemptId: attemptId ?? null,
      });
      output = await blockedFromHardTimeout({
        label,
        sessionName,
        cwd: options.cwd,
        result,
        timeoutMs: options.timeoutMs,
        options,
        worktreePath,
      });
    } else {
      const parsedOutput = parseSuccessfulPromptOutput(result);
      if (parsedOutput) {
        output = parsedOutput;
      } else if (commandFailed(result)) {
        output = await evidenceRichBlocked({
          label,
          sessionName,
          cwd: options.cwd,
          reason: `acpx ${label} executor failed`,
          result,
          options,
          worktreePath,
          terminalReason: "command_failed",
        });
      } else {
        const attempted = attemptId ? replayCache.reserveRecoveryRequest(attemptId) : false;
        if (attempted) {
          recorder?.event({
            type: "acpx.attempt.recovery.start",
            agent: label,
            sessionName,
            attemptId: attemptId ?? null,
          });
          const recoveryResult = await runRecoveryPrompt({
            base,
            runCommand,
            env,
            sessionName,
            oneShotExec,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            recorder,
          });
          recorder?.event({
            type: "acpx.attempt.recovery.terminal",
            agent: label,
            sessionName,
            attemptId: attemptId ?? null,
            exitCode: recoveryResult.exitCode,
          });
          const recovered = parseSuccessfulPromptOutput(recoveryResult);
          if (recovered) {
            recorder?.event({
              type: "acpx.attempt.recovery.succeeded",
              agent: label,
              sessionName,
              attemptId: attemptId ?? null,
            });
            output = recovered;
          } else {
            recorder?.event({
              type: "acpx.attempt.recovery.failed",
              agent: label,
              sessionName,
              attemptId: attemptId ?? null,
            });
            output = await evidenceRichBlocked({
              label,
              sessionName,
              cwd: options.cwd,
              reason: `acpx ${label} executor produced invalid output and recovery did not yield an envelope`,
              result,
              options,
              worktreePath,
              terminalReason: "recovery_failed",
              recoveryAttempted: true,
              fallback: () =>
                parseAttemptOutputOrBlocked({
                  raw: result.stdout,
                  summary: `acpx ${label} executor produced invalid output`,
                  checkName: "acpx output parse",
                }),
            });
          }
        } else {
          recorder?.event({
            type: "acpx.attempt.recovery.skip",
            agent: label,
            sessionName,
            attemptId: attemptId ?? null,
          });
          output = await evidenceRichBlocked({
            label,
            sessionName,
            cwd: options.cwd,
            reason: `acpx ${label} executor produced invalid output`,
            result,
            options,
            worktreePath,
            terminalReason: "terminal_no_envelope",
            fallback: () =>
              parseAttemptOutputOrBlocked({
                raw: result.stdout,
                summary: `acpx ${label} executor produced invalid output`,
                checkName: "acpx output parse",
              }),
          });
        }
      }
    }

    if (attemptId) {
      replayCache.recordTerminalResult(attemptId, output);
    }
    return output;
  };
};

function blockedFromReplaySkip(input: { label: string; sessionName: string; attemptId?: string }) {
  return {
    status: "blocked" as const,
    summary: `acpx ${input.label} executor skipped duplicate initial request`,
    changedFiles: [],
    checks: [
      {
        name: `acpx ${input.label} replay`,
        status: "skipped" as const,
      },
    ],
    artifacts: [],
    problems: [
      [
        `acpx ${input.label} executor saw a duplicate initial request for attempt ${input.attemptId ?? "?"}.`,
        `session: ${input.sessionName}`,
        "The initial command was not re-issued because the attempt already holds the initial-request slot.",
      ].join("\n\n"),
    ],
  };
}

async function blockedFromRecoveryExhausted(input: {
  label: string;
  sessionName: string;
  attemptId?: string;
  result: { exitCode: number; stdout: string; stderr: string };
  options: { worktreeEvidence?: WorktreeEvidenceProbe; cwd: string };
  worktreePath: string | null;
}): Promise<AttemptOutput> {
  return evidenceRichBlocked({
    label: input.label,
    sessionName: input.sessionName,
    cwd: input.options.cwd,
    reason: `acpx ${input.label} executor skipped duplicate recovery request`,
    result: input.result,
    options: input.options,
    worktreePath: input.worktreePath,
    terminalReason: "recovery_already_attempted",
  });
}

function acpxBaseCommand(input: {
  cwd: string;
  approval: ApprovalMode;
  format?: string;
  model?: string;
  agent?: string;
  agentCommand?: string;
}) {
  const modelArgs = input.model ? ["--model", input.model] : [];
  const agentArgs = input.agentCommand ? ["--agent", input.agentCommand] : [input.agent ?? "codex"];
  const format = input.format ?? "text";
  return ["acpx", "--cwd", input.cwd, approvalFlag(input.approval), "--format", format, ...modelArgs, ...agentArgs];
}

async function acpxCommandEnv(input: {
  env?: Record<string, string | undefined>;
}) {
  return { ...(input.env ?? {}) };
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

function runRecoveryPrompt(input: {
  base: string[];
  runCommand: RunCommand;
  env: Record<string, string | undefined>;
  sessionName: string;
  oneShotExec?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  recorder?: ExecutorEventRecorder;
}) {
  return input.runCommand({
    cmd: input.oneShotExec ? [...input.base, "exec", "-f", "-"] : [...input.base, "-s", input.sessionName],
    stdin: RECOVERY_PROMPT,
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
const HARD_TIMEOUT_PATTERN = /command timed out after (\d+)ms/;

function idleTimeoutMsFromResult(result: { exitCode: number; stdout: string; stderr: string }): number | null {
  if (result.exitCode !== 124) {
    return null;
  }
  const match = IDLE_TIMEOUT_PATTERN.exec(result.stderr);
  return match ? Number(match[1]) : null;
}

function hardTimeoutMsFromResult(result: { exitCode: number; stdout: string; stderr: string }): number | null {
  if (result.exitCode !== 124) {
    return null;
  }
  const match = HARD_TIMEOUT_PATTERN.exec(result.stderr);
  return match ? Number(match[1]) : null;
}

function isIdleTimeout(result: { exitCode: number; stdout: string; stderr: string }) {
  return idleTimeoutMsFromResult(result) !== null;
}

function isHardTimeout(result: { exitCode: number; stdout: string; stderr: string }, timeoutMs?: number) {
  if (hardTimeoutMsFromResult(result) !== null) {
    return true;
  }
  if (result.exitCode === 124 && timeoutMs !== undefined && IDLE_TIMEOUT_PATTERN.exec(result.stderr) === null) {
    return true;
  }
  return false;
}

async function collectWorktreeEvidence(input: {
  cwd: string;
  worktreePath: string | null;
  options: { worktreeEvidence?: WorktreeEvidenceProbe };
}): Promise<{ changedFiles: string[]; summary: string; checks: unknown[] }> {
  if (!input.options.worktreeEvidence) {
    return {
      changedFiles: [],
      summary: input.worktreePath ? `worktree:${input.worktreePath}` : `cwd:${input.cwd}`,
      checks: [],
    };
  }
  try {
    const probe = await input.options.worktreeEvidence({ cwd: input.cwd, worktreePath: input.worktreePath });
    return {
      changedFiles: probe.changedFiles,
      summary: probe.summary,
      checks: [
        {
          name: "worktree snapshot",
          status: probe.changedFiles.length > 0 ? "passed" : "skipped",
          evidence: probe.summary,
        },
      ],
    };
  } catch (error) {
    return {
      changedFiles: [],
      summary: `worktree snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      checks: [],
    };
  }
}

function mergeChangedFiles(existing: string[] | undefined, additional: string[]): string[] {
  const set = new Set<string>([...(existing ?? []), ...additional]);
  return [...set];
}

function truncate(value: string, limit = 4096) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…<truncated ${value.length - limit} bytes>`;
}

async function blockedFromIdleTimeout(input: {
  label: string;
  sessionName: string;
  cwd: string;
  result: { exitCode: number; stdout: string; stderr: string };
  idleTimeoutMs?: number;
  options: { worktreeEvidence?: WorktreeEvidenceProbe; cwd: string };
  worktreePath: string | null;
}): Promise<AttemptOutput> {
  const observedMs = idleTimeoutMsFromResult(input.result) ?? input.idleTimeoutMs;
  const summary = observedMs
    ? `acpx ${input.label} executor silent for ${observedMs}ms (idle timeout)`
    : `acpx ${input.label} executor silent (idle timeout)`;
  const evidence = await collectWorktreeEvidence({
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    options: input.options,
  });
  return {
    status: "blocked" as const,
    summary,
    changedFiles: evidence.changedFiles,
    checks: [
      { name: `acpx ${input.label} idle`, status: "failed" as const },
      ...(evidence.checks ?? []),
    ],
    artifacts: [
      {
        kind: "acpx_terminal_evidence",
        agent: input.label,
        sessionName: input.sessionName,
        cwd: input.cwd,
        terminalReason: "idle_timeout",
        timeoutReason: "idle_timeout",
        idleTimeoutMs: observedMs ?? null,
        lastStdout: truncate(input.result.stdout),
        lastStderr: truncate(input.result.stderr),
        worktreeSnapshot: evidence.summary,
      },
    ],
    problems: [
      [
        `acpx ${input.label} executor produced no output for the idle timeout window (${observedMs ?? "?"}ms).`,
        `agent: ${input.label}`,
        `session: ${input.sessionName}`,
        `cwd: ${input.cwd}`,
        `terminalReason: idle_timeout`,
        `worktree: ${evidence.summary}`,
        "exit code: 124",
        ...(input.result.stdout.trim().length > 0 ? [`stdout:\n${truncate(input.result.stdout.trim())}`] : []),
        ...(input.result.stderr.trim().length > 0 ? [`stderr:\n${truncate(input.result.stderr.trim())}`] : []),
      ].join("\n\n"),
    ],
  };
}

async function blockedFromHardTimeout(input: {
  label: string;
  sessionName: string;
  cwd: string;
  result: { exitCode: number; stdout: string; stderr: string };
  timeoutMs?: number;
  options: { worktreeEvidence?: WorktreeEvidenceProbe; cwd: string };
  worktreePath: string | null;
}): Promise<AttemptOutput> {
  const observedMs = hardTimeoutMsFromResult(input.result) ?? input.timeoutMs;
  const summary = observedMs
    ? `acpx ${input.label} executor hit the hard ceiling after ${observedMs}ms`
    : `acpx ${input.label} executor hit the hard ceiling`;
  const evidence = await collectWorktreeEvidence({
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    options: input.options,
  });
  return {
    status: "blocked" as const,
    summary,
    changedFiles: evidence.changedFiles,
    checks: [
      { name: `acpx ${input.label} hard_timeout`, status: "failed" as const },
      ...(evidence.checks ?? []),
    ],
    artifacts: [
      {
        kind: "acpx_terminal_evidence",
        agent: input.label,
        sessionName: input.sessionName,
        cwd: input.cwd,
        terminalReason: "hard_timeout",
        timeoutReason: "hard_timeout",
        timeoutMs: observedMs ?? null,
        lastStdout: truncate(input.result.stdout),
        lastStderr: truncate(input.result.stderr),
        worktreeSnapshot: evidence.summary,
      },
    ],
    problems: [
      [
        `acpx ${input.label} executor exceeded the non-extendable hard ceiling (${observedMs ?? "?"}ms).`,
        `agent: ${input.label}`,
        `session: ${input.sessionName}`,
        `cwd: ${input.cwd}`,
        `terminalReason: hard_timeout`,
        `worktree: ${evidence.summary}`,
        "exit code: 124",
        ...(input.result.stdout.trim().length > 0 ? [`stdout:\n${truncate(input.result.stdout.trim())}`] : []),
        ...(input.result.stderr.trim().length > 0 ? [`stderr:\n${truncate(input.result.stderr.trim())}`] : []),
      ].join("\n\n"),
    ],
  };
}

async function evidenceRichBlocked(input: {
  label: string;
  sessionName: string;
  cwd: string;
  reason: string;
  result: { exitCode: number; stdout: string; stderr: string };
  options: { worktreeEvidence?: WorktreeEvidenceProbe; cwd: string };
  worktreePath: string | null;
  terminalReason: string;
  recoveryAttempted?: boolean;
  fallback?: () => AttemptOutput;
}): Promise<AttemptOutput> {
  const evidence = await collectWorktreeEvidence({
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    options: input.options,
  });
  const fallback = input.fallback?.() ?? null;
  const terminalArtifact = {
    kind: "acpx_terminal_evidence",
    agent: input.label,
    sessionName: input.sessionName,
    cwd: input.cwd,
    terminalReason: input.terminalReason,
    timeoutReason: input.terminalReason,
    recoveryAttempted: input.recoveryAttempted === true,
    lastStdout: truncate(input.result.stdout),
    lastStderr: truncate(input.result.stderr),
    worktreeSnapshot: evidence.summary,
  };
  if (fallback) {
    return {
      ...fallback,
      changedFiles: mergeChangedFiles(fallback.changedFiles, evidence.changedFiles),
      artifacts: [...(fallback.artifacts ?? []), terminalArtifact],
      problems: [
        ...(fallback.problems ?? []),
        `terminal reason: ${input.reason}`,
        `worktree snapshot: ${evidence.summary}`,
      ],
    };
  }
  return {
    status: "blocked",
    summary: input.reason,
    changedFiles: evidence.changedFiles,
    checks: [
      { name: `acpx ${input.label} terminal`, status: "failed" },
      ...(evidence.checks ?? []),
    ],
    artifacts: [terminalArtifact],
    problems: [
      [
        input.reason,
        `agent: ${input.label}`,
        `session: ${input.sessionName}`,
        `cwd: ${input.cwd}`,
        `worktree: ${evidence.summary}`,
        ...(input.result.stdout.trim().length > 0 ? [`stdout:\n${truncate(input.result.stdout.trim())}`] : []),
        ...(input.result.stderr.trim().length > 0 ? [`stderr:\n${truncate(input.result.stderr.trim())}`] : []),
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

export const __testables = { RECOVERY_PROMPT };
