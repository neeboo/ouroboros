import type { CommandResult, RunCommand } from "./types";

export const runLocalCommand: RunCommand = async ({ cmd, stdin, timeoutMs, idleTimeoutMs }) => {
  const proc = Bun.spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();

  let stdout = "";
  let stderr = "";
  let hardTimeout: Timer | undefined;
  let idleTimeout: Timer | undefined;
  const decoder = new TextDecoder();

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;

    const finish = (result: CommandResult) => {
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
      resolve(result);
    };

    const resetIdleTimeout = () => {
      if (idleTimeoutMs === undefined || settled) {
        return;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        proc.kill();
        finish({
          exitCode: 124,
          stdout,
          stderr: appendProblem(stderr, `command idle timed out after ${idleTimeoutMs}ms`),
        });
      }, idleTimeoutMs);
    };

    if (timeoutMs !== undefined) {
      hardTimeout = setTimeout(() => {
        proc.kill();
        finish({
          exitCode: 124,
          stdout,
          stderr: appendProblem(stderr, `command timed out after ${timeoutMs}ms`),
        });
      }, timeoutMs);
    }

    resetIdleTimeout();
    drainStream(proc.stdout, (chunk) => {
      stdout += chunk;
      resetIdleTimeout();
    });
    drainStream(proc.stderr, (chunk) => {
      stderr += chunk;
      resetIdleTimeout();
    });
    proc.exited.then((exitCode) => {
      finish({ exitCode, stdout, stderr });
    });
  });
};

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
