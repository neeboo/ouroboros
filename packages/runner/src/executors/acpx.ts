import { parseAttemptOutput } from "./output";
import { runLocalCommand } from "./command";
import type { AcpxCodexExecutorFactory, ApprovalMode } from "./types";

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = options.runCommand ?? runLocalCommand;

  return async ({ prompt, sessionName }) => {
    const base = ["acpx", "--cwd", options.cwd, approvalFlag(approval), "--format", "text", "codex"];
    const showSessionCommand = [...base, "sessions", "show", sessionName];
    const existing = await runCommand({
      cmd: showSessionCommand,
      stdin: "",
      timeoutMs: options.timeoutMs,
    });
    if (commandFailed(existing)) {
      const created = await runCommand({
        cmd: [...base, "sessions", "new", "--name", sessionName],
        stdin: "",
        timeoutMs: options.timeoutMs,
      });
      if (commandFailed(created)) {
        return {
          status: "blocked",
          summary: "acpx session creation failed",
          changedFiles: [],
          checks: [{ name: "acpx sessions new", status: "failed" }],
          artifacts: [],
          problems: [created.stderr || created.stdout || `exit code ${created.exitCode}`],
        };
      }
      const verified = await runCommand({
        cmd: showSessionCommand,
        stdin: "",
        timeoutMs: options.timeoutMs,
      });
      if (commandFailed(verified)) {
        return {
          status: "blocked",
          summary: "acpx session creation failed",
          changedFiles: [],
          checks: [{ name: "acpx sessions new", status: "failed" }],
          artifacts: [],
          problems: [sessionCreationProblem(created, verified)],
        };
      }
    }

    const result = await runCommand({
      cmd: [...base, "-s", sessionName],
      stdin: prompt,
      timeoutMs: options.timeoutMs,
    });

    if (commandFailed(result)) {
      return {
        status: "blocked",
        summary: "acpx codex executor failed",
        changedFiles: [],
        checks: [{ name: "acpx codex exec", status: "failed" }],
        artifacts: [],
        problems: [result.stderr || result.stdout || `exit code ${result.exitCode}`],
      };
    }

    return parseAttemptOutput(result.stdout);
  };
};

function approvalFlag(approval: ApprovalMode) {
  return `--${approval}`;
}

function commandFailed(result: { exitCode: number; stdout: string; stderr: string }) {
  return result.exitCode !== 0 || result.stderr.includes("Error:") || result.stdout.includes("Error:");
}

function sessionCreationProblem(
  created: { exitCode: number; stdout: string; stderr: string },
  verified: { exitCode: number; stdout: string; stderr: string },
) {
  const parts = [
    ["sessions new stdout", created.stdout],
    ["sessions new stderr", created.stderr],
    ["sessions show stdout", verified.stdout],
    ["sessions show stderr", verified.stderr],
  ]
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `${label}:\n${value.trim()}`);

  return parts.length > 0 ? parts.join("\n\n") : `exit code ${verified.exitCode}`;
}
