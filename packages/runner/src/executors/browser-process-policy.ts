import type { BrowserProcessPolicy, RunCommand, RunCommandInput } from "./types";
import { runLocalCommand } from "./command";

const DARWIN_BROWSER_DENY_PROFILE = [
  "(version 1)",
  "(allow default)",
  '(deny process-exec (literal "/usr/bin/open"))',
  '(deny process-exec (literal "/usr/bin/osascript"))',
  '(deny process-exec (regex #".*/(Google Chrome|Google Chrome Canary|Chromium|chrome|chromium|chrome-headless-shell|Safari|Microsoft Edge|Arc|Firefox|firefox|agent-browser[^/]*)$"))',
].join(" ");

export function applyBrowserProcessPolicy(
  cmd: string[],
  policy: BrowserProcessPolicy | undefined,
  host: { platform?: NodeJS.Platform; nestedSeatbelt?: boolean } = {},
): string[] {
  if (policy !== "deny" || (host.platform ?? process.platform) !== "darwin") {
    return cmd;
  }
  if (host.nestedSeatbelt) {
    return isNestedBrowserEntryPoint(cmd[0] ?? "") ? ["/usr/bin/false"] : cmd;
  }
  return ["/usr/bin/sandbox-exec", "-p", DARWIN_BROWSER_DENY_PROFILE, ...cmd];
}

export function withBrowserProcessPolicy(runCommand: RunCommand, policy: BrowserProcessPolicy | undefined): RunCommand {
  if (!policy) {
    return runCommand;
  }
  const nestedSeatbelt = policy === "deny" && runCommand === runLocalCommand && process.env.CODEX_SANDBOX === "seatbelt";
  return (input: RunCommandInput) =>
    runCommand({
      ...input,
      cmd: applyBrowserProcessPolicy(input.cmd, policy, { nestedSeatbelt }),
      env: {
        ...(input.env ?? {}),
        ORBS_BROWSER_PROCESS_POLICY: policy,
      },
    });
}

function isNestedBrowserEntryPoint(executable: string) {
  const basename = executable.split("/").at(-1) ?? executable;
  return /^(?:open|osascript|sh|bash|zsh|Google Chrome(?: Canary)?|Chromium|chrome|chromium|chrome-headless-shell|Safari|Microsoft Edge|Arc|Firefox|firefox|agent-browser[^/]*)$/.test(
    basename,
  );
}
