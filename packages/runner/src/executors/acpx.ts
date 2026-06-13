import { parseAttemptOutput } from "./output";
import { runLocalCommand } from "./command";
import type { AcpxCodexExecutorFactory, ApprovalMode } from "./types";

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = options.runCommand ?? runLocalCommand;

  return async ({ prompt, sessionName }) => {
    const base = ["acpx", "--cwd", options.cwd, approvalFlag(approval), "--format", "text", "codex"];
    const existing = await runCommand({
      cmd: [...base, "sessions", "show", sessionName],
      stdin: "",
    });
    if (commandFailed(existing)) {
      const created = await runCommand({
        cmd: [...base, "sessions", "new", "--name", sessionName],
        stdin: "",
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
    }

    const result = await runCommand({
      cmd: [...base, "-s", sessionName],
      stdin: prompt,
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

function commandFailed(result: { exitCode: number; stderr: string }) {
  return result.exitCode !== 0 || result.stderr.includes("Error:");
}
