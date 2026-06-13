import type { CommandResult, RunCommand } from "./types";

export const runLocalCommand: RunCommand = async ({ cmd, stdin, timeoutMs }) => {
  const proc = Bun.spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();

  let timeout: Timer | undefined;
  const completed = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
  const timedOut =
    timeoutMs === undefined
      ? undefined
      : new Promise<CommandResult>((resolve) => {
          timeout = setTimeout(() => {
            proc.kill();
            resolve({
              exitCode: 124,
              stdout: "",
              stderr: `command timed out after ${timeoutMs}ms`,
            });
          }, timeoutMs);
        });

  const result = timedOut ? await Promise.race([completed, timedOut]) : await completed;
  if (timeout) {
    clearTimeout(timeout);
  }
  return result;
};

export function commandProblem(result: CommandResult) {
  const parts = [
    ["exit code", String(result.exitCode)],
    ["stdout", result.stdout],
    ["stderr", result.stderr],
  ]
    .filter(([, value], index) => index === 0 || value.trim().length > 0)
    .map(([label, value]) => (label === "exit code" ? `${label}: ${value}` : `${label}:\n${value.trim()}`));

  return parts.join("\n\n");
}
