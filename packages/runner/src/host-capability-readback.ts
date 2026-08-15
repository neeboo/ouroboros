import type { Run, Task } from "@ouroboros/harness";
import { runLocalCommand } from "./executors/command";
import type { RunCommand } from "./executors/types";

export interface HostCapabilityReadback {
  docker?: {
    status: "available" | "unavailable";
    source: "host-owned-preflight";
    serverVersion?: string;
    problemCode?: "docker_cli_unavailable" | "docker_info_failed" | "invalid_server_version";
  };
}

export type HostReadbackForTask = (input: {
  run: Run;
  task: Task;
  cwd: string;
}) => Promise<HostCapabilityReadback | null>;

export async function readHostCapabilityReadback(input: {
  run: Run;
  task: Task;
  cwd: string;
  runCommand?: RunCommand;
}): Promise<HostCapabilityReadback | null> {
  if (!taskRequiresDocker(input.run, input.task)) {
    return null;
  }
  const runCommand = input.runCommand ?? runLocalCommand;
  let result;
  try {
    result = await runCommand({
      cmd: ["docker", "info", "--format", "{{.ServerVersion}}"],
      stdin: "",
      cwd: input.cwd,
      timeoutMs: 5_000,
      idleTimeoutMs: 5_000,
    });
  } catch {
    return { docker: { status: "unavailable", source: "host-owned-preflight", problemCode: "docker_cli_unavailable" } };
  }
  if (result.exitCode !== 0) {
    return { docker: { status: "unavailable", source: "host-owned-preflight", problemCode: "docker_info_failed" } };
  }
  const serverVersion = result.stdout.trim();
  if (!/^[0-9A-Za-z.+_-]{1,64}$/.test(serverVersion)) {
    return { docker: { status: "unavailable", source: "host-owned-preflight", problemCode: "invalid_server_version" } };
  }
  return { docker: { status: "available", source: "host-owned-preflight", serverVersion } };
}

export function renderHostCapabilityReadback(readback: HostCapabilityReadback | null | undefined) {
  if (!readback?.docker) {
    return "";
  }
  return [
    "## Host-Owned Capability Readback",
    "The harness ran this read-only probe outside the model sandbox before task start.",
    JSON.stringify({ docker: readback.docker }, null, 2),
    "A sandbox socket denial means this task lacks direct Docker capability; it does not prove that the host Docker daemon is unavailable.",
    "Use only the execution route and capabilities frozen for this task; do not bypass them.",
    "",
  ].join("\n");
}

function taskRequiresDocker(run: Run, task: Task) {
  return [run.goal, task.goal, task.prompt, ...task.doneWhen].some((value) => /\bdocker\b/i.test(value));
}
