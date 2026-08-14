import { describe, expect, test } from "bun:test";
import { createDshCliExecutor } from "../packages/runner/src";
import type { ResolvedExecutionRoute, RunCommandInput } from "../packages/runner/src";

const runFixture = {
  id: "run_dsh",
  projectId: "project_dsh",
  projectRoot: "/repo",
  goal: "Evaluate DeepSeek Harness",
  status: "todo" as const,
  context: {},
};

const taskFixture = {
  id: "task_dsh",
  runId: "run_dsh",
  parentId: null,
  cycleId: "task_dsh",
  status: "todo" as const,
  role: "worker",
  goal: "Implement a bounded change",
  prompt: "Implement the task.",
  dependsOn: [],
  doneWhen: [],
  config: {},
  worktreePath: "/repo/.ouroboros/worktrees/task_dsh",
  sessionRef: null,
  contextVersion: 1,
};

const routeFixture: ResolvedExecutionRoute = {
  role: "worker",
  backend: {
    id: "deepseek-harness",
    kind: "dsh-cli",
    command: "/opt/deepseek/bin/dsh",
    profile: "headless",
    source: "task",
  },
  model: null,
  executionMode: "generic",
};

function executorInput(prompt = "Implement the bounded task and return the required JSON.") {
  return {
    prompt,
    sessionName: "task_dsh",
    run: runFixture,
    task: taskFixture,
    route: routeFixture,
  };
}

function availableDshResolution() {
  return {
    configuredCommand: "/opt/deepseek/bin/dsh",
    resolutionMode: "explicit" as const,
    selectedPath: "/opt/deepseek/bin/dsh",
    canonicalPath: "/opt/deepseek/bin/dsh",
    installationState: "available" as const,
    callable: true,
    diagnostic: null,
  };
}

describe("DeepSeek Harness CLI executor", () => {
  test("runs headless DSH in the exact task worktree and parses AttemptOutput", async () => {
    const calls: RunCommandInput[] = [];
    const events: Array<Record<string, unknown>> = [];
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      env: { DSH_HOME: "/tmp/dsh-home" },
      resolveCommand: () => ({
        configuredCommand: "/opt/deepseek/bin/dsh",
        resolutionMode: "explicit",
        selectedPath: "/opt/deepseek/bin/dsh",
        canonicalPath: "/opt/deepseek/bin/dsh",
        installationState: "available",
        callable: true,
        diagnostic: null,
      }),
      runCommand: async (input) => {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"dsh route ok","changedFiles":["src/a.ts"],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      ...executorInput(),
      recorder: { stdout() {}, stderr() {}, event: (event) => events.push(event) },
    });

    expect(output).toMatchObject({ status: "done", summary: "dsh route ok", changedFiles: ["src/a.ts"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: ["/opt/deepseek/bin/dsh", "--profile", "headless", executorInput().prompt],
      stdin: "",
      cwd: taskFixture.worktreePath,
      env: { DSH_HOME: "/tmp/dsh-home", DSH_PERMISSION_MODE: "workspace-write" },
    });
    expect(events.map((event) => event.type)).toEqual(["dsh.attempt.started", "dsh.attempt.terminal"]);
    expect(JSON.stringify(events)).not.toContain(executorInput().prompt);
  });

  test("fails closed before DSH for unsupported permissions and host capabilities", async () => {
    let calls = 0;
    const runCommand = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const dangerous = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      sandbox: "danger-full-access",
      runCommand,
    });
    const hostCapable = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      sandbox: "workspace-write",
      hostExecutionCapabilities: { schemaVersion: 1 },
      runCommand,
    });

    await expect(dangerous(executorInput())).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("danger-full-access"),
    });
    await expect(hostCapable(executorInput())).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("host execution capabilities"),
    });
    expect(calls).toBe(0);
  });

  test("blocks an oversized positional prompt before launching DSH", async () => {
    let calls = 0;
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const output = await executor(executorInput("x".repeat(100_001)));

    expect(output).toMatchObject({
      status: "blocked",
      artifacts: [expect.objectContaining({ kind: "dsh_prompt_argument_too_large", characters: 100_001 })],
    });
    expect(calls).toBe(0);
  });

  test("launches the resolver-selected executable while retaining one-shot arguments", async () => {
    const calls: RunCommandInput[] = [];
    const selectedPath = "/tmp/selected-dsh-wrapper";
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "dsh",
      profile: "headless",
      resolveCommand: () => ({
        configuredCommand: "dsh",
        resolutionMode: "path",
        selectedPath,
        canonicalPath: "/tmp/canonical-dsh-wrapper",
        installationState: "available",
        callable: true,
        diagnostic: null,
      }),
      runCommand: async (input) => {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"selected dsh","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor(executorInput());

    expect(calls[0]?.cmd).toEqual([selectedPath, "--profile", "headless", executorInput().prompt]);
  });

  test("bounds and redacts malformed or failed DSH output", async () => {
    const malformed = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => ({
        exitCode: 0,
        stdout: `not-json Authorization: Bearer dsh-secret ${"z".repeat(20_000)}`,
        stderr: "",
      }),
    });
    const failed = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => ({
        exitCode: 9,
        stdout: "",
        stderr: "token=dsh-failure-secret",
      }),
    });

    const malformedOutput = await malformed(executorInput());
    const failedOutput = await failed(executorInput());

    expect(malformedOutput).toMatchObject({ status: "blocked", summary: "DeepSeek Harness produced invalid output" });
    expect(JSON.stringify(malformedOutput)).not.toContain("dsh-secret");
    expect(JSON.stringify(malformedOutput).length).toBeLessThan(8_000);
    expect(failedOutput).toMatchObject({ status: "blocked", summary: "DeepSeek Harness CLI failed" });
    expect(JSON.stringify(failedOutput)).not.toContain("dsh-failure-secret");
  });

  test("converts a missing DSH binary into bounded blocked evidence", async () => {
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => {
        throw new Error("spawn dsh ENOENT Authorization: Bearer missing-binary-secret");
      },
    });

    const output = await executor(executorInput());

    expect(output).toMatchObject({ status: "blocked", summary: "DeepSeek Harness CLI could not start" });
    expect(JSON.stringify(output)).not.toContain("missing-binary-secret");
  });
});
