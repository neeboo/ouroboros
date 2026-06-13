import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CLI", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-cli-"));
    dbPath = join(dir, "ouroboros.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates a run, creates a task, and prints the next ready task", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros", "--context-json", '{"repo":"ouroboros"}');
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan v0",
      "--prompt",
      "Create the smallest useful next task.",
      "--done-when-json",
      '["task created"]',
    );
    const ready = await runCliJson("next-task", "--run-id", run.id);

    expect(run.goal).toBe("Bootstrap ouroboros");
    expect(task.runId).toBe(run.id);
    expect(ready.id).toBe(task.id);
    expect(ready.role).toBe("planner");
  });

  test("links a local run to a Linear project", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");

    const ref = await runCliJson(
      "link-external",
      "--local-type",
      "run",
      "--local-id",
      run.id,
      "--provider",
      "linear",
      "--external-type",
      "project",
      "--external-id",
      "ouroboros-acd5df2ef1da",
      "--external-url",
      "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview",
    );

    expect(ref).toMatchObject({
      localType: "run",
      localId: run.id,
      provider: "linear",
      externalType: "project",
      externalId: "ouroboros-acd5df2ef1da",
    });
  });

  test("runs the next task with the noop executor", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan v0",
      "--prompt",
      "Create the next small task.",
    );

    const result = await runCliJson("run-next", "--run-id", run.id, "--executor", "noop");
    const readyAfterRun = await runCliJson("next-task", "--run-id", run.id);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(result.tasks[0].attemptId).toBeString();
    expect(result.tasks[0].sessionName).toBe(`task-${task.id}`);
    expect(readyAfterRun).toBeNull();
  });

  test("runs multiple ready tasks with separate sessions", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const first = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task A",
      "--prompt",
      "Do A.",
    );
    const second = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task B",
      "--prompt",
      "Do B.",
    );

    const result = await runCliJson("run-next", "--run-id", run.id, "--executor", "noop", "--limit", "2");

    expect(result.tasks.map((task: { taskId: string }) => task.taskId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(result.tasks.map((task: { sessionName: string }) => task.sessionName).sort()).toEqual(
      [`task-${first.id}`, `task-${second.id}`].sort(),
    );
  });

  test("runs the next task with the acpx codex executor", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Run through acpx",
      "--prompt",
      "Use the fake acpx executor.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "acpx"),
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({",
        "  status: 'done',",
        "  summary: `fake acpx saw ${prompt.includes('Run through acpx')}`,",
        "  changedFiles: [],",
        "  checks: [{ name: 'fake acpx', status: 'passed' }],",
        "  artifacts: [],",
        "  problems: []",
        "}));",
      ].join("\n"),
    );
    await chmod(join(binDir, "acpx"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "acpx-codex",
      "--approval",
      "approve-all",
      "--cwd",
      "/repo",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(result.tasks[0].attemptId).toBeString();
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("records a structured attempt from JSON", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Record attempt",
      "--prompt",
      "Write result into the harness.",
    );

    const attempt = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      '{"source":"test"}',
      "--output-json",
      '{"status":"done","summary":"Recorded result","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
    );
    const readyAfterRecord = await runCliJson("next-task", "--run-id", run.id);

    expect(attempt.taskId).toBe(task.id);
    expect(attempt.status).toBe("done");
    expect(readyAfterRecord).toBeNull();
  });

  async function runCli(...rawArgs: Array<string | Record<string, string>>) {
    const envOverride =
      typeof rawArgs.at(-1) === "object" ? (rawArgs.pop() as Record<string, string>) : {};
    const args = rawArgs as string[];
    const proc = Bun.spawn({
      cmd: ["bun", "run", "packages/cli/src/main.ts", "--db", dbPath, ...args],
      cwd: process.cwd(),
      env: { ...process.env, ...envOverride },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`CLI failed with ${exitCode}\n${stdout}\n${stderr}`);
    }
    return stdout.trim();
  }

  async function runCliJson(...args: Array<string | Record<string, string>>) {
    return JSON.parse(await runCli(...args));
  }
});
