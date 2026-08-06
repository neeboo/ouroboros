import type { BrowserProcessPolicy, RunCommand, RunCommandInput } from "./types";

const DARWIN_BROWSER_DENY_PROFILE = [
  "(version 1)",
  "(allow default)",
  '(deny process-exec (literal "/usr/bin/open"))',
  '(deny process-exec (literal "/usr/bin/osascript"))',
  '(deny process-exec (regex #".*/(Google Chrome|Google Chrome Canary|Chromium|chrome|chromium|chrome-headless-shell|Safari|Microsoft Edge|Arc|Firefox|firefox|agent-browser[^/]*)$"))',
].join(" ");

export function applyBrowserProcessPolicy(cmd: string[], policy: BrowserProcessPolicy | undefined): string[] {
  if (policy !== "deny" || process.platform !== "darwin") {
    return cmd;
  }
  return ["/usr/bin/sandbox-exec", "-p", DARWIN_BROWSER_DENY_PROFILE, ...cmd];
}

export function withBrowserProcessPolicy(runCommand: RunCommand, policy: BrowserProcessPolicy | undefined): RunCommand {
  if (!policy) {
    return runCommand;
  }
  return (input: RunCommandInput) =>
    runCommand({
      ...input,
      cmd: applyBrowserProcessPolicy(input.cmd, policy),
      env: {
        ...(input.env ?? {}),
        ORBS_BROWSER_PROCESS_POLICY: policy,
      },
    });
}
