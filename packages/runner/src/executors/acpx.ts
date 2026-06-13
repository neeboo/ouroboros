import { parseAttemptOutput } from "./output";
import { runLocalCommand } from "./command";
import type { AcpxCodexExecutorFactory, ApprovalMode } from "./types";

export const createAcpxCodexExecutor: AcpxCodexExecutorFactory = (options) => {
  const approval = options.approval ?? "approve-reads";
  const runCommand = options.runCommand ?? runLocalCommand;

  return async ({ prompt, sessionName }) => {
    const base = ["acpx", "--cwd", options.cwd, approvalFlag(approval), "--format", "text", "codex"];
    const ensure = await runCommand({
      cmd: [...base, "sessions", "ensure", "--name", sessionName],
      stdin: "",
    });
    if (ensure.exitCode !== 0) {
      return {
        status: "blocked",
        summary: "acpx session ensure failed",
        changedFiles: [],
        checks: [{ name: "acpx sessions ensure", status: "failed" }],
        artifacts: [],
        problems: [ensure.stderr || ensure.stdout || `exit code ${ensure.exitCode}`],
      };
    }

    const result = await runCommand({
      cmd: [...base, "-s", sessionName],
      stdin: prompt,
    });

    if (result.exitCode !== 0) {
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
