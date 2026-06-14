import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";

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

  test("shows and updates prompt templates", async () => {
    await runCli("init");

    const seeded = await runCliJson("show-prompt-template", "--key", "task");
    expect(seeded.contentMd).toContain("# Ouroboros Task");

    const updated = await runCliJson(
      "set-prompt-template",
      "--key",
      "task",
      "--content",
      "# Custom Task\n{{taskGoal}}",
    );

    expect(updated).toMatchObject({ key: "task" });
    expect((await runCliJson("show-prompt-template", "--key", "task")).contentMd).toBe("# Custom Task\n{{taskGoal}}");
  });

  test("shows the fully rendered task prompt with custom template and lessons", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"repo":"ouroboros"}',
    );
    const dependency = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement dependency",
      "--prompt",
      "Build the upstream piece.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      dependency.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"done","summary":"Dependency implemented","changedFiles":["src/dependency.ts"],"checks":[],"artifacts":[],"problems":[]}',
    );
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Preview prompt",
      "--prompt",
      "Render the current prompt.",
      "--depends-on-json",
      JSON.stringify([dependency.id]),
      "--done-when-json",
      '["prompt previewed"]',
    );
    await runCliJson(
      "set-prompt-template",
      "--key",
      "task",
      "--content",
      [
        "# Custom Preview Template",
        "Goal={{runGoal}}",
        "Task={{taskId}} {{taskRole}} {{taskGoal}}",
        "Prompt={{taskPrompt}}",
        "Done={{doneWhenMarkdown}}",
        "Dependencies={{dependencyAttemptsJson}}",
        "Lessons={{runLessonsJson}}",
      ].join("\n"),
    );

    const prompt = await runCli("show-task-prompt", "--task-id", task.id);

    expect(prompt).toContain("# Custom Preview Template");
    expect(prompt).toContain("Goal=Bootstrap ouroboros");
    expect(prompt).toContain(`Task=${task.id} worker Preview prompt`);
    expect(prompt).toContain("Prompt=Render the current prompt.");
    expect(prompt).toContain("- prompt previewed");
    expect(prompt).toContain("Dependency implemented");
    expect(prompt).toContain("src/dependency.ts");
    expect(prompt).toContain("Lessons=[");
    expect(prompt).toContain("experience");
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

  test("runs the context summary stop hook after verifier attempts from the CLI", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Archive context",
      "--prompt",
      "Run and archive context.",
    );

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "noop",
      "--stop-hook",
      "context-summary",
    );

    const attempt = new Harness(dbPath).getAttempt(result.tasks[0].attemptId)!;
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(attempt.output.checks).toContainEqual({ name: "context subagent", status: "passed" });
    expect(attempt.output.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "context_experience_archive",
        taskId: task.id,
      }),
    );
    expect(attempt.output.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "context_lesson_archive",
        taskId: task.id,
      }),
    );
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

  test("assigns worktree paths from the CLI", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task with worktree",
      "--prompt",
      "Do work.",
    );
    const worktreeRoot = join(dir, "worktrees");

    await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "noop",
      "--worktree-root",
      worktreeRoot,
    );

    expect(new Harness(dbPath).getTask(task.id)?.worktreePath).toBe(join(worktreeRoot, task.id));
  });

  test("runs git worktree start hook from the CLI", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task with git worktree",
      "--prompt",
      "Do work.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "git"), "#!/usr/bin/env bun\nprocess.exit(0);\n");
    await chmod(join(binDir, "git"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "noop",
      "--worktree-root",
      join(dir, "worktrees"),
      "--start-hook",
      "git-worktree",
      "--cwd",
      "/repo",
      "--git-base-ref",
      "main",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    const attempt = new Harness(dbPath).getAttempt(result.tasks[0].attemptId)!;
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(attempt.output.checks).toContainEqual({ name: "git worktree add", status: "passed" });
    expect(attempt.output.artifacts).toContainEqual({
      kind: "worktree",
      path: join(dir, "worktrees", task.id),
      branch: `ouroboros/${task.id}`,
    });
  });

  test("creates tasks from planner output when stop hook is enabled", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const planner = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan next task",
      "--prompt",
      "Plan.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env bun",
        "await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({",
        "  status: 'done',",
        "  summary: 'planned',",
        "  changedFiles: [],",
        "  checks: [],",
        "  artifacts: [],",
        "  problems: [],",
        "  nextTasks: [{ role: 'worker', goal: 'Generated task', prompt: 'Do generated task.', doneWhen: ['done'] }]",
        "}));",
      ].join("\n"),
    );
    await chmod(join(binDir, "codex"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-tasks",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const generated = await runCliJson("next-task", "--run-id", run.id);

    expect(result.tasks[0].taskId).toBe(planner.id);
    expect(generated.goal).toBe("Generated task");
    expect(generated.dependsOn).toEqual([planner.id]);
  });

  test("runs a loop until generated tasks are finished", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan worker",
      "--prompt",
      "Plan.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (prompt.includes('Role: planner')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'planned', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'worker', goal: 'Generated worker', prompt: 'Do generated work.' }] }));",
        "} else {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'worker done', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
        "}",
      ].join("\n"),
    );
    await chmod(join(binDir, "codex"), 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      "--stop-hook",
      "create-tasks",
      "--max-rounds",
      "3",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    expect(result.rounds).toHaveLength(2);
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("runs planner worker and verifier with multiple stop hooks", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan worker",
      "--prompt",
      "Plan.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (prompt.includes('Role: planner')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'planned', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'worker', goal: 'Generated worker', prompt: 'Do generated work.' }] }));",
        "} else if (prompt.includes('Role: worker')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'worker done', changedFiles: ['src/worker.ts'], checks: [{ name: 'worker check', status: 'passed' }], artifacts: [], problems: [] }));",
        "} else {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'verifier done', changedFiles: [], checks: [{ name: 'verify', status: 'passed' }], artifacts: [], problems: [] }));",
        "}",
      ].join("\n"),
    );
    await chmod(join(binDir, "codex"), 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      "--stop-hook",
      "create-tasks,create-verifier",
      "--max-rounds",
      "4",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    expect(result.rounds).toHaveLength(3);
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("runs repair after a blocked verifier", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan worker",
      "--prompt",
      "Plan.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (prompt.includes('Role: planner')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'planned', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'worker', goal: 'Generated worker', prompt: 'Do generated work.' }] }));",
        "} else if (prompt.includes('Role: verifier') && prompt.includes('Repair complete')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'verifier passed', changedFiles: [], checks: [{ name: 'verify', status: 'passed' }], artifacts: [], problems: [] }));",
        "} else if (prompt.includes('Role: verifier')) {",
        "  console.log(JSON.stringify({ status: 'blocked', summary: 'verifier failed', changedFiles: [], checks: [{ name: 'verify', status: 'failed' }], artifacts: [], problems: ['missing regression test'] }));",
        "} else if (prompt.includes('Repair the failed verifier result')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'Repair complete', changedFiles: ['tests/runner.test.ts'], checks: [{ name: 'repair check', status: 'passed' }], artifacts: [], problems: [] }));",
        "} else {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'worker done', changedFiles: ['src/worker.ts'], checks: [{ name: 'worker check', status: 'passed' }], artifacts: [], problems: [] }));",
        "}",
      ].join("\n"),
    );
    await chmod(join(binDir, "codex"), 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      "--stop-hook",
      "create-tasks,create-verifier,create-repair",
      "--max-rounds",
      "6",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    expect(result.rounds).toHaveLength(5);
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
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

  test("runs the next task with the codex cli executor", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Run through codex",
      "--prompt",
      "Use the fake codex executor.",
    );
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "codex"),
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({",
        "  status: 'done',",
        "  summary: `fake codex saw ${prompt.includes('Run through codex')}`,",
        "  changedFiles: [],",
        "  checks: [{ name: 'fake codex', status: 'passed' }],",
        "  artifacts: [],",
        "  problems: []",
        "}));",
      ].join("\n"),
    );
    await chmod(join(binDir, "codex"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      { PATH: `${binDir}:${process.env.PATH}` },
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(result.tasks[0].attemptId).toBeString();
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

  test("starts lists and finishes a running attempt", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Async planner",
      "--prompt",
      "Start asynchronously.",
    );

    const started = await runCliJson(
      "start-attempt",
      "--task-id",
      task.id,
      "--input-json",
      '{"sessionName":"planner-session"}',
    );
    const running = await runCliJson("list-running-attempts", "--run-id", run.id);
    const finished = await runCliJson(
      "finish-attempt",
      "--attempt-id",
      started.attemptId,
      "--output-json",
      '{"status":"done","summary":"Async planner finished","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
    );

    expect(started.taskId).toBe(task.id);
    expect(running).toEqual([
      expect.objectContaining({
        id: started.attemptId,
        taskId: task.id,
        status: "running",
      }),
    ]);
    expect(finished).toEqual({ attemptId: started.attemptId, status: "done" });
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("starts and resumes a codex running attempt", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Async planner",
      "--prompt",
      "Plan asynchronously.",
    );
    const codexBin = join(dir, "fake-codex");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "if (args.includes('resume')) {",
        "  console.log(JSON.stringify({ type: 'session.started', session_id: 'session_123' }));",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"resumed planner\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_123' }));",
        "console.log(JSON.stringify({ type: 'agent.message.delta', delta: 'working' }));",
        "console.error('command idle timed out after 300000ms');",
        "process.exit(124);",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const started = await runCliJson(
      "codex-start-attempt",
      "--task-id",
      task.id,
      "--codex-bin",
      codexBin,
      "--timeout-ms",
      "900000",
      "--idle-timeout-ms",
      "300000",
    );
    const running = await runCliJson("list-running-attempts", "--run-id", run.id);
    const resumed = await runCliJson(
      "codex-resume-attempt",
      "--attempt-id",
      started.attemptId,
      "--codex-bin",
      codexBin,
      "--timeout-ms",
      "900000",
      "--idle-timeout-ms",
      "300000",
    );

    expect(started).toMatchObject({
      taskId: task.id,
      status: "running",
      codexSessionId: "session_123",
    });
    expect(running).toEqual([
      expect.objectContaining({
        id: started.attemptId,
        status: "running",
      }),
    ]);
    expect(resumed).toMatchObject({
      attemptId: started.attemptId,
      status: "done",
    });
    expect(new Harness(dbPath).getAttempt(started.attemptId)?.output.summary).toBe("resumed planner");
  });

  test("run-loop automatically starts and resumes codex attempts", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const planner = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Async planner",
      "--prompt",
      "Plan asynchronously.",
    );
    const codexBin = join(dir, "fake-codex-loop");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "if (args.includes('resume')) {",
        "  console.log(JSON.stringify({ type: 'session.started', session_id: 'session_loop' }));",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"planned worker\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[],\"nextTasks\":[{\"role\":\"worker\",\"goal\":\"Generated worker\",\"prompt\":\"Do generated work.\",\"doneWhen\":[\"done\"]}]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_loop' }));",
        "console.log(JSON.stringify({ type: 'agent.message.delta', delta: 'working' }));",
        "console.error('command idle timed out after 300000ms');",
        "process.exit(124);",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const started = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-tasks",
      "--max-rounds",
      "1",
    );
    const running = await runCliJson("list-running-attempts", "--run-id", run.id);
    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const resumed = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-tasks",
      "--max-rounds",
      "1",
    );
    const next = await runCliJson("next-task", "--run-id", run.id);

    expect(started.rounds[0].tasks).toEqual([
      expect.objectContaining({
        taskId: planner.id,
        status: "running",
        codexSessionId: "session_loop",
      }),
    ]);
    expect(running).toEqual([
      expect.objectContaining({
        taskId: planner.id,
        status: "running",
      }),
    ]);
    expect(overview.sessions).toEqual([
      expect.objectContaining({
        role: "planner",
        taskId: planner.id,
        status: "running",
        codexSessionId: "session_loop",
        latestText: "working",
        events: expect.arrayContaining([
          expect.objectContaining({
            stream: "codex-json",
            payload: expect.objectContaining({ type: "agent.message.delta", delta: "working" }),
          }),
        ]),
      }),
    ]);
    expect(resumed.rounds[0].tasks).toEqual([
      expect.objectContaining({
        taskId: planner.id,
        status: "done",
      }),
    ]);
    expect(next).toMatchObject({
      role: "worker",
      goal: "Generated worker",
      dependsOn: [planner.id],
    });
  });

  test("run-loop reviews the goal when the queue is empty and can complete the run", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const codexBin = join(dir, "fake-codex-goal-complete");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'complete', summary: 'goal reached', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.rounds[0].tasks).toEqual([
      expect.objectContaining({
        status: "done",
      }),
    ]);
    expect(overview.run.status).toBe("done");
    expect(overview.tasks).toEqual([
      expect.objectContaining({
        role: "goal-review",
        status: "done",
      }),
    ]);
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("run-loop reviews the goal when idle and can create a planner when more work remains", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const codexBin = join(dir, "fake-codex-goal-continue");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'continue', summary: 'more work remains', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'planner', goal: 'Plan the gap', prompt: 'Choose the next gap.', doneWhen: ['gap planned'] }] }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
    );
    const next = await runCliJson("next-task", "--run-id", run.id);

    expect(next).toMatchObject({
      role: "planner",
      goal: "Plan the gap",
    });
  });

  test("run-loop retries a blocked goal review in the same cycle before creating a new one", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review whether the run goal is complete",
      "--prompt",
      "Review the goal.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"blocked","summary":"connection retry","problems":["connection timeout"]}',
    );
    const codexBin = join(dir, "fake-codex-retry-review");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'complete', summary: 'goal reached', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
      "--max-tries",
      "3",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.rounds[0].tasks[0].taskId).toBe(review.id);
    expect(overview.tasks).toHaveLength(1);
    expect(overview.tasks[0]).toMatchObject({
      id: review.id,
      status: "done",
      cycleId: review.id,
    });
  });

  test("run-loop stops retrying a blocked goal review after max tries", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review whether the run goal is complete",
      "--prompt",
      "Review the goal.",
    );
    for (const problem of ["first timeout", "second timeout", "third timeout"]) {
      await runCliJson(
        "record-attempt",
        "--task-id",
        review.id,
        "--input-json",
        "{}",
        "--output-json",
        JSON.stringify({ status: "blocked", summary: problem, problems: [problem] }),
      );
    }

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      "/should/not/run",
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
      "--max-tries",
      "3",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.rounds).toEqual([]);
    expect(overview.tasks).toHaveLength(1);
    expect(overview.tasks[0]).toMatchObject({
      id: review.id,
      status: "blocked",
      cycleId: review.id,
    });
    expect(overview.sessions.filter((session: { taskId: string }) => session.taskId === review.id)).toHaveLength(3);
  });

  test("autopilot drains active queue and then completes goal review", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Finish active queue item",
      "--prompt",
      "Complete the queued item.",
    );
    const codexBin = join(dir, "fake-codex-autopilot");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({ type: 'session.started', session_id: prompt.includes('Role: goal-review') ? 'session_goal' : 'session_worker' }));",
        "if (prompt.includes('Role: goal-review')) {",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"runDecision\":\"complete\",\"summary\":\"goal reached\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"worker done\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "autopilot",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--max-cycles",
      "4",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.cycles).toHaveLength(2);
    expect(result.status).toBe("done");
    expect(overview.run.status).toBe("done");
    expect(overview.tasks).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        status: "done",
      }),
    );
    expect(overview.tasks).toContainEqual(
      expect.objectContaining({
        role: "goal-review",
        status: "done",
      }),
    );
    expect(await runCliJson("next-task", "--run-id", run.id)).toBeNull();
  });

  test("autopilot retries stale running attempts without a codex session id", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Recover stale task",
      "--prompt",
      "Recover this task.",
    );
    const stale = await runCliJson(
      "start-attempt",
      "--task-id",
      task.id,
      "--input-json",
      '{"sessionName":"stale-session","executor":"codex-resumable"}',
    );
    const codexBin = join(dir, "fake-codex-stale");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_recovered' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"recovered stale task\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "autopilot",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--max-cycles",
      "2",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
    );
    const harness = new Harness(dbPath);

    expect(result.cycles[0].rounds[0].tasks).toContainEqual(
      expect.objectContaining({
        attemptId: stale.attemptId,
        status: "blocked",
      }),
    );
    expect(harness.getAttempt(stale.attemptId)?.status).toBe("blocked");
    expect(harness.getTask(task.id)?.status).toBe("done");
  });

  test("lists lessons recorded from attempts", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Record lesson",
      "--prompt",
      "Write result into the harness.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"blocked","summary":"Blocked","problems":["missing workspace link"]}',
    );

    const lessons = await runCliJson("list-lessons", "--run-id", run.id);

    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      runId: run.id,
      taskId: task.id,
      kind: "lesson",
      summary: "missing workspace link",
    });
  });

  test("retries a blocked task", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Retry task",
      "--prompt",
      "Retry me.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"blocked","summary":"Blocked","problems":["timeout"]}',
    );

    const retried = await runCliJson("retry-task", "--task-id", task.id);

    expect(retried).toEqual({ taskId: task.id, status: "todo" });
    expect((await runCliJson("next-task", "--run-id", run.id)).id).toBe(task.id);
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
