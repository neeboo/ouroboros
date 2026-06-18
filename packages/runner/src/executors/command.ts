import type { CommandResult, RunCommand } from "./types";
import { childEnvForProcess } from "./proxy-env";

export const runLocalCommand: RunCommand = async (input) => {
  const proc = Bun.spawn({
    cmd: input.cmd,
    env: commandEnv(input.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input.stdin);
  proc.stdin.end();

  let stdout = "";
  let stderr = "";
  let hardTimeout: Timer | undefined;
  let idleTimeout: Timer | undefined;
  const decoder = new TextDecoder();

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    let cleaned = false;

    const cleanup = async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await (input.cleanupProcessTree ?? terminateProcessTree)(proc.pid);
    };

    const finish = async (result: CommandResult, cleanupProcess = false) => {
      if (settled) {
        return;
      }
      settled = true;
      if (hardTimeout) {
        clearTimeout(hardTimeout);
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      if (cleanupProcess) {
        await cleanup();
      }
      resolve(result);
    };

    const resetIdleTimeout = () => {
      if (input.idleTimeoutMs === undefined || settled) {
        return;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        proc.kill();
        void finish({
          exitCode: 124,
          stdout,
          stderr: appendProblem(stderr, `command idle timed out after ${input.idleTimeoutMs}ms`),
        }, true);
      }, input.idleTimeoutMs);
    };

    if (input.timeoutMs !== undefined) {
      hardTimeout = setTimeout(() => {
        proc.kill();
        void finish({
          exitCode: 124,
          stdout,
          stderr: appendProblem(stderr, `command timed out after ${input.timeoutMs}ms`),
        }, true);
      }, input.timeoutMs);
    }

    resetIdleTimeout();
    drainStream(proc.stdout, (chunk) => {
      stdout += chunk;
      input.onStdout?.(chunk);
      resetIdleTimeout();
    });
    drainStream(proc.stderr, (chunk) => {
      stderr += chunk;
      input.onStderr?.(chunk);
      resetIdleTimeout();
    });
    proc.exited.then((exitCode) => {
      void finish({ exitCode, stdout, stderr }, input.cleanupOnFailure === true && exitCode !== 0);
    });
  });
};

export async function terminateProcessTree(pid: number) {
  if (!pid || process.platform === "win32") {
    return;
  }

  terminateProcessTreeSync(pid, "SIGTERM");
  await sleep(150);
  terminateProcessTreeSync(pid, "SIGKILL");
}

export function terminateProcessTreeSync(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid || process.platform === "win32") {
    return;
  }

  const processFamily = [{ pid, pgid: null }, ...collectDescendantProcesses(pid)];
  for (const processInfo of [...processFamily].reverse()) {
    signalProcess(processInfo, signal);
  }
}

function signalProcess(processInfo: { pid: number; pgid: number | null }, signal: NodeJS.Signals) {
  if (processInfo.pgid === processInfo.pid) {
    try {
      process.kill(-processInfo.pgid, signal);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "ESRCH") {
        return;
      }
    }
  }

  try {
    process.kill(processInfo.pid, signal);
  } catch {
    // The command may have already exited; cleanup is best-effort.
  }
}

function collectDescendantProcesses(pid: number) {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: ["/bin/ps", "-axo", "pid=,ppid=,pgid="],
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return [];
  }
  if (result.exitCode !== 0) {
    return [];
  }
  return descendantProcessesFromPsOutput(new TextDecoder().decode(result.stdout), pid);
}

function descendantProcessesFromPsOutput(output: string, rootPid: number) {
  const childrenByParent = new Map<number, Array<{ pid: number; pgid: number }>>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const pgid = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(pgid) ||
      pid === rootPid
    ) {
      continue;
    }
    const children = childrenByParent.get(parentPid) ?? [];
    children.push({ pid, pgid });
    childrenByParent.set(parentPid, children);
  }

  const descendants: Array<{ pid: number; pgid: number }> = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift()!;
    descendants.push(child);
    queue.push(...(childrenByParent.get(child.pid) ?? []));
  }
  return descendants;
}

export function descendantPidsFromPsOutputForTest(output: string, rootPid: number) {
  return descendantProcessesFromPsOutput(output, rootPid).map((processInfo) => processInfo.pid);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandEnv(overrides: Record<string, string | undefined> | undefined) {
  if (!overrides) {
    return childEnvForProcess();
  }
  const env = { ...childEnvForProcess() };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function drainStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onChunk(decoder.decode(value, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail.length > 0) {
    onChunk(tail);
  }
}

function appendProblem(stderr: string, problem: string) {
  return stderr.trim().length > 0 ? `${stderr.trim()}\n${problem}` : problem;
}

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
