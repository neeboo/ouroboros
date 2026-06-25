import { describe, expect, test } from "bun:test";
import {
  acpxSubsessionBaseCommand,
  buildAcpxPromptCommand,
  createAcpxSubsessionRunner,
  SUBSESSION_DEFAULT_TIMEOUT_MS,
  SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS,
} from "../packages/runner/src/acpx-subsessions";
import type { CommandResult, RunCommand } from "../packages/runner/src/executors/types";

function fakeRunCommand(responses: Record<string, CommandResult>): RunCommand {
  return async (input) => {
    const key = input.cmd.join(" ");
    const matchKey = Object.keys(responses).find((candidate) => key.includes(candidate));
    return matchKey ? responses[matchKey] : { exitCode: 0, stdout: "", stderr: "" };
  };
}

function fakeRunSync(responses: Record<string, CommandResult>) {
  return (input: { cmd: string[] }) => {
    const key = input.cmd.join(" ");
    const matchKey = Object.keys(responses).find((candidate) => key.includes(candidate));
    return matchKey ? responses[matchKey] : { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("acpx subsession runner", () => {
  test("acpxSubsessionBaseCommand includes --cwd and a resolved acpx agent", () => {
    const base = acpxSubsessionBaseCommand(
      { id: "claude-code", kind: "acpx", agent: "claude", approval: "approve-reads" },
      "/repo/worktree",
    );
    expect(base).toContain("acpx");
    expect(base).toContain("--cwd");
    expect(base).toContain("/repo/worktree");
    expect(base).toContain("claude");
    expect(base).toContain("--approve-reads");
  });

  test("acpxSubsessionBaseCommand supports custom agentCommand backends", () => {
    const base = acpxSubsessionBaseCommand(
      { id: "custom-runner", kind: "acpx", agentCommand: "custom acp", approval: "deny-all" },
      "/repo/worktree",
    );
    expect(base).toContain("--agent");
    expect(base).toContain("custom acp");
    expect(base).toContain("--deny-all");
  });

  test("acpxSubsessionBaseCommand defaults to approve-reads when approval is missing", () => {
    const base = acpxSubsessionBaseCommand(
      { id: "codex", kind: "acpx", agent: "codex" },
      "/repo/worktree",
    );
    expect(base).toContain("--approve-reads");
  });

  test("buildAcpxPromptCommand emits a deterministic -s sessionName tail", () => {
    const prompt = buildAcpxPromptCommand(["acpx", "--cwd", "/x"], "task_x__research");
    expect(prompt).toEqual(["acpx", "--cwd", "/x", "-s", "task_x__research"]);
  });

  test("start spawns the prompt command after ensuring a named session exists", async () => {
    const calls: string[] = [];
    const runner = createAcpxSubsessionRunner({
      runCommand: fakeRunCommand({
        "sessions show": { exitCode: 0, stdout: "ok", stderr: "" },
      }),
      spawn: (input) => {
        calls.push(input.cmd.join(" "));
        return { pid: 999 };
      },
    });

    const result = runner.start({
      threadId: "thread_1",
      parentTaskId: "task_1",
      parentAttemptId: null,
      parentThreadId: null,
      runId: "run_1",
      worktreePath: "/repo/worktree",
      sessionName: "task_1__research",
      purpose: "research",
      prompt: "Inspect the protocol.",
      role: "subsession",
      backend: { id: "claude-code", kind: "acpx", agent: "claude", approval: "approve-reads" },
      timeoutMs: SUBSESSION_DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS,
    });

    expect(result.status).toBe("running");
    expect(result.sessionName).toBe("task_1__research");
    expect(result.agentSessionId).toBe("task_1__research");
    await Bun.sleep(0);
    expect(calls[0]).toContain("-s task_1__research");
  });

  test("collect reports a done status when acpx reports the session finished", () => {
    const runner = createAcpxSubsessionRunner({
      runSync: fakeRunSync({
        "sessions show": { exitCode: 0, stdout: 'status: done\n{"summary":"ok"}', stderr: "" },
      }),
    });

    const [result] = runner.collect([
      {
        threadId: "thread_1",
        sessionName: "child-1",
        agentSessionId: "child-1",
        backend: { id: "claude-code", kind: "acpx", agent: "claude", approval: "approve-reads" },
        worktreePath: "/repo/worktree",
      },
    ]);

    expect(result.status).toBe("done");
    expect(result.threadId).toBe("thread_1");
  });

  test("cancel closes the named session and reports canceled=true on exit 0", () => {
    const runner = createAcpxSubsessionRunner({
      runSync: fakeRunSync({
        "sessions close": { exitCode: 0, stdout: "closed", stderr: "" },
      }),
    });

    const [result] = runner.cancel(
      [
        {
          threadId: "thread_1",
          sessionName: "child-1",
          agentSessionId: "child-1",
          backend: { id: "claude-code", kind: "acpx", agent: "claude", approval: "approve-reads" },
          worktreePath: "/repo/worktree",
        },
      ],
      "parent attempt aborted",
    );

    expect(result.canceled).toBe(true);
    expect(result.threadId).toBe("thread_1");
  });

  test("collect reports blocked when the session show call fails", () => {
    const runner = createAcpxSubsessionRunner({
      runSync: fakeRunSync({
        "sessions show": { exitCode: 1, stdout: "", stderr: "session missing" },
      }),
    });

    const [result] = runner.collect([
      {
        threadId: "thread_1",
        sessionName: "child-1",
        agentSessionId: "child-1",
        backend: { id: "claude-code", kind: "acpx", agent: "claude", approval: "approve-reads" },
        worktreePath: "/repo/worktree",
      },
    ]);

    expect(result.status).toBe("blocked");
  });

  test("start returns blocked when the backend kind is not acpx", () => {
    const runner = createAcpxSubsessionRunner({
      runCommand: fakeRunCommand({}),
      spawn: () => ({ pid: null }),
    });

    const result = runner.start({
      threadId: "thread_1",
      parentTaskId: "task_1",
      parentAttemptId: null,
      parentThreadId: null,
      runId: "run_1",
      worktreePath: "/repo/worktree",
      sessionName: "task_1__research",
      purpose: "research",
      prompt: "Inspect the protocol.",
      role: "subsession",
      backend: { id: "codex-resumable", kind: "codex-resumable" },
      timeoutMs: SUBSESSION_DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS,
    });

    expect(result.status).toBe("blocked");
  });
});
