import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import { Database } from "bun:sqlite";

describe("CLI", () => {
  let dir: string;
  let dbPath: string;
  let nextPortOffset = 0;

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

  test("runs through the root orbs executable wrapper", async () => {
    const result = await runRootOrbsJson("init");

    expect(result).toMatchObject({
      db: dbPath,
      status: "initialized",
    });
  });

  test("creates projects and shows project metadata in run overview", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Ouroboros",
      "--root-path",
      dir,
      "--context-json",
      '{"source":"cli-test"}',
    );
    const run = await runCliJson("create-run", "--goal", "Project scoped run", "--project-id", project.id);
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(project).toMatchObject({
      name: "Ouroboros",
      rootPath: dir,
      context: { source: "cli-test" },
    });
    expect(run).toMatchObject({
      goal: "Project scoped run",
      projectId: project.id,
      projectRoot: dir,
    });
    expect(overview.project).toMatchObject({
      id: project.id,
      name: "Ouroboros",
      rootPath: dir,
    });
  });

  test("creates a project-bound run from project root", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Root scoped run", "--project-root", dir);
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(run.projectId).toBeString();
    expect(run.projectRoot).toBe(dir);
    expect(overview.project).toMatchObject({
      id: run.projectId,
      rootPath: dir,
    });
  });

  test("seeds create-run model defaults from config without explicit context defaults", async () => {
    await runCli("init");
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[models.roles.worker]",
        'model = "gpt-5.4-mini"',
        'provider = "openai"',
        'profile = "fast"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "OPENAI_API_KEY"',
        "",
        "[models.roles.verifier]",
        'model = "gpt-5.5"',
      ].join("\n"),
    );

    const run = await runCliJson("create-run", "--goal", "Config seeded run", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.context.modelDefaults).toEqual({
      roles: {
        worker: {
          model: "gpt-5.4-mini",
          provider: "openai",
          profile: "fast",
          base_url: "https://api.example.test/v1",
          env_key: "OPENAI_API_KEY",
        },
        verifier: {
          model: "gpt-5.5",
        },
      },
    });
  });

  test("keeps explicit context model defaults ahead of config defaults", async () => {
    await runCli("init");
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[models.roles.worker]",
        'model = "gpt-5.4-mini"',
      ].join("\n"),
    );

    const run = await runCliJson(
      "create-run",
      "--goal",
      "Explicit context run",
      "--config",
      configPath,
      "--context-json",
      '{"modelDefaults":{"roles":{"worker":{"model":"explicit-worker"}}}}',
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.context.modelDefaults).toEqual({
      roles: {
        worker: {
          model: "explicit-worker",
        },
      },
    });
  });

  test("seeds create-run agent backend defaults from config without explicit context defaults", async () => {
    await runCli("init");
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults.roles]",
        'worker = "opencode"',
        'verifier = "claude-code"',
        "",
        "[agentBackends.opencode]",
        'kind = "acpx"',
        'agent = "opencode"',
        'approval = "approve-reads"',
        "",
        '["agentBackends"."claude-code"]',
        'kind = "acpx"',
        'agent = "claude"',
      ].join("\n"),
    );

    const run = await runCliJson("create-run", "--goal", "Config seeded agent run", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.context.agentDefaults).toEqual({
      roles: {
        worker: "opencode",
        verifier: "claude-code",
      },
    });
    expect(overview.run.context.agentBackends).toMatchObject({
      opencode: {
        kind: "acpx",
        agent: "opencode",
        approval: "approve-reads",
      },
      "claude-code": {
        kind: "acpx",
        agent: "claude",
      },
    });
  });

  test("bootstraps a self-iteration planning run", async () => {
    const configPath = join(dir, "self-iterate.toml");
    await writeFile(configPath, "[models.roles.worker]\nmodel = \"gpt-5.4-mini\"\n");
    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(result.runId).toBeString();
    expect(result.taskId).toBeString();
    expect(result.dashboardCommand).toBeString();
    expect(result.runnerCommand).toBeString();
    expect(result.dashboardCommand).toContain(`dashboard --run-id ${result.runId}`);
    expect(result.runnerCommand).toContain(`run-loop --run-id ${result.runId}`);
    expect(result.launchCommand).toContain("self-iterate-launch");
    expect(result.launchCommand).toContain("--concurrency 3");
    expect(result.launchCommand).toContain("--worktree-root .ouroboros/worktrees");
    expect(result.launchCommand).toContain("--start-hook git-worktree");
    expect(result.dashboardCommand).toContain("--port 7331");
    expect(result.runnerCommand).toContain("--executor codex-resumable");
    expect(result.runnerCommand).toContain("--concurrency 3");
    expect(result.runnerCommand).toContain("--worktree-root .ouroboros/worktrees");
    expect(result.runnerCommand).toContain("--start-hook git-worktree");
    expect(result.runnerCommand).toContain("--stop-hook create-runs,create-tasks,create-verifier,create-repair,context-summary");

    expect(overview.run).toMatchObject({
      id: result.runId,
      goal: "Use Ouroboros to plan its own next self-iteration cycle",
      context: expect.objectContaining({
        source: "self-iterate",
        planDoc: "docs/self-iteration-plan.md",
        modelDefaults: {
          roles: {
            worker: {
              model: "gpt-5.4-mini",
            },
          },
        },
      }),
    });
    expect(overview.tasks).toHaveLength(1);
    expect(overview.tasks[0]).toMatchObject({
      id: result.taskId,
      runId: result.runId,
      role: "planner",
      status: "todo",
      dependsOn: [],
    });
    expect(overview.tasks[0].prompt).toContain("docs/self-iteration-plan.md");
    expect(overview.tasks[0].prompt).toContain("recent run lessons from the harness database");
    expect(overview.tasks[0].prompt).toContain("small `nextTasks` graph");
    expect(overview.tasks[0].prompt).toContain("two to three independent improvement areas");
    expect(overview.tasks[0].doneWhen).toEqual([
      "Planner output contains a small nextTasks graph, usually two to five tasks across two to three independent areas when possible",
      "Every planned task has one role, one concrete goal, and one prompt with exact files or commands to inspect first",
      "The task graph includes explicit dependsOn when ordering matters and each task has three to five doneWhen checks",
      "Every planned task identifies a clear artifact, code change, test, or decision",
      "The graph includes natural failure paths through verifier, repair, or another planner and can be drained by run-loop",
    ]);
  });

  test("launches the self-iteration dashboard and runner together", async () => {
    await runCli("init");
    const dashboardPort = nextTestPort();
    if (!canStartServerOn(dashboardPort)) {
      expect(Bun.version).toBeString();
      return;
    }
    const codexBin = join(dir, "fake-codex-launch");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "if (args.includes('resume')) {",
        "  console.log(JSON.stringify({ type: 'session.started', session_id: 'session_launch_resume' }));",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"launch resumed\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_launch' }));",
        "await new Promise((resolve) => setTimeout(resolve, 1500));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"launch started\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "packages/cli/src/main.ts",
        "--db",
        dbPath,
        "self-iterate-launch",
        "--port",
        String(dashboardPort),
        "--codex-bin",
        codexBin,
        "--cwd",
        "/repo",
        "--sandbox",
        "read-only",
        "--max-cycles",
        "1",
        "--max-rounds",
        "1",
        "--interval-ms",
        "1",
        "--start-hook",
        "none",
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const launch = JSON.parse(await readFirstLine(proc.stdout));
      const overviewResponse = await fetch(`${launch.dashboardUrl}/api/runs/${launch.runId}/overview`);
      const overview = await overviewResponse.json();

      expect(launch).toMatchObject({
        runId: expect.any(String),
        taskId: expect.any(String),
        dashboardUrl: `http://localhost:${dashboardPort}`,
        runnerPid: expect.any(Number),
        runnerStatus: expect.objectContaining({ status: "running" }),
      });
      expect(launch.runnerCommand).toContain("--concurrency 3");
      expect(launch.runnerCommand).toContain("--start-hook none");
      expect(overview.runner).toMatchObject({ status: "running" });
      expect(overview.run).toMatchObject({
        id: launch.runId,
        goal: "Use Ouroboros to plan its own next self-iteration cycle",
      });
      expect(overview.tasks).toHaveLength(1);
      expect(overview.tasks[0]).toMatchObject({
        id: launch.taskId,
        role: "planner",
        status: "todo",
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("intakes a requirement document into a planner run", async () => {
    await runCli("init");
    const configPath = join(dir, "intake.toml");
    await writeFile(configPath, "[models.roles.verifier]\nmodel = \"gpt-5.5\"\n");

    const result = await runCliJson(
      "intake",
      "--title",
      "React dashboard migration",
      "--document",
      "Migrate the dashboard to React and add a Vercel AI Elements style composer.",
      "--config",
      configPath,
    );
    const runId = result.runId;
    const overview = await runCliJson("run-overview", "--run-id", runId);
    const runs = await runCliJson("list-runs", "--status", "todo");

    expect(result).toMatchObject({
      runId: expect.any(String),
      taskId: expect.any(String),
    });
    expect(result.supervisorCommand).toContain("supervise-runs");
    expect(result.supervisorCommand).toContain(`--root-run-id ${runId}`);
    expect(result.supervisorCommand).toContain("create-runs");
    expect(overview.run.goal).toBe("Intake: React dashboard migration");
    expect(overview.run.context.document).toContain("Vercel AI Elements style composer");
    expect(overview.run.context.modelDefaults).toEqual({
      roles: {
        verifier: {
          model: "gpt-5.5",
        },
      },
    });
    expect(overview.tasks[0]).toMatchObject({
      id: result.taskId,
      role: "planner",
      goal: "Split requirement document into executable runs",
      status: "todo",
    });
    expect(runs.some((run: { id: string }) => run.id === runId)).toBe(true);
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

  test("checks Linear access from config and records the run project ref", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const tokenPath = join(dir, "linear-token");
    const configPath = join(dir, "ouroboros.toml");
    const projectUrl = "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview";
    let authorization = "";
    const server = startTestServer({
      fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        return Response.json({
          data: {
            viewer: { id: "viewer_1", name: "Ouroboros Bot", email: "bot@example.com" },
            projects: {
              nodes: [
                {
                  id: "project_1",
                  name: "Ouroboros",
                  slugId: "ouroboros-acd5df2ef1da",
                  url: projectUrl,
                  teams: { nodes: [{ id: "team_1", key: "PAN", name: "PanCat" }] },
                },
              ],
            },
          },
        });
      },
    });
    if (!server) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      await writeFile(tokenPath, "lin_api_test_token");
      await writeFile(
        configPath,
        [
          "[linear]",
          `api_url = "http://127.0.0.1:${server.port}/graphql"`,
          `token_file = "${tokenPath}"`,
          `project_url = "${projectUrl}"`,
          'project_id = "ouroboros-acd5df2ef1da"',
          'team_key = "PAN"',
          "",
        ].join("\n"),
      );

      const result = await runCliJson("linear-check", "--config", configPath, "--run-id", run.id);
      const harness = new Harness(dbPath);

      expect(authorization).toBe("lin_api_test_token");
      expect(result).toMatchObject({
        status: "ok",
        tokenSource: tokenPath,
        viewer: { name: "Ouroboros Bot" },
        project: { name: "Ouroboros", slugId: "ouroboros-acd5df2ef1da", url: projectUrl },
        team: { key: "PAN" },
      });
      expect(harness.listExternalRefs({ localType: "run", localId: run.id })).toEqual([
        expect.objectContaining({
          localType: "run",
          localId: run.id,
          provider: "linear",
          externalType: "project",
          externalId: "ouroboros-acd5df2ef1da",
          externalUrl: projectUrl,
        }),
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("rejects Linear project ref for a missing local run", async () => {
    await runCli("init");
    const tokenPath = join(dir, "linear-token");
    const configPath = join(dir, "ouroboros.toml");
    const projectUrl = "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview";
    const server = startTestServer({
      fetch() {
        return Response.json({
          data: {
            viewer: { id: "viewer_1", name: "Ouroboros Bot", email: "bot@example.com" },
            projects: {
              nodes: [
                {
                  id: "project_1",
                  name: "Ouroboros",
                  slugId: "ouroboros-acd5df2ef1da",
                  url: projectUrl,
                  teams: { nodes: [{ id: "team_1", key: "PAN", name: "PanCat" }] },
                },
              ],
            },
          },
        });
      },
    });
    if (!server) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      await writeFile(tokenPath, "lin_api_test_token");
      await writeFile(
        configPath,
        [
          "[linear]",
          `api_url = "http://127.0.0.1:${server.port}/graphql"`,
          `token_file = "${tokenPath}"`,
          `project_url = "${projectUrl}"`,
          'project_id = "ouroboros-acd5df2ef1da"',
          'team_key = "PAN"',
          "",
        ].join("\n"),
      );

      const missingRun = await runCliRaw("linear-check", "--config", configPath, "--run-id", "run_missing");

      expect(missingRun.exitCode).toBe(1);
      expect(missingRun.stderr).toContain("run not found: run_missing");
    } finally {
      server.stop(true);
    }
  });

  test("maps a local run to a Linear issue", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");

    const ref = await runCliJson(
      "linear-link-issue",
      "--local-type",
      "run",
      "--local-id",
      run.id,
      "--issue-id",
      "LIN-123",
      "--issue-url",
      "https://linear.app/pancat/issue/LIN-123/bootstrap-ouroboros",
    );

    expect(ref).toMatchObject({
      localType: "run",
      localId: run.id,
      provider: "linear",
      externalType: "issue",
      externalId: "LIN-123",
      externalUrl: "https://linear.app/pancat/issue/LIN-123/bootstrap-ouroboros",
      created: true,
    });
    expect(new Harness(dbPath).listExternalRefs({ localType: "run", localId: run.id })).toEqual([
      expect.objectContaining({
        id: ref.id,
        provider: "linear",
        externalType: "issue",
        externalId: "LIN-123",
      }),
    ]);
  });

  test("maps a local task to a Linear issue by key", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement issue mapping",
      "--prompt",
      "Map the task.",
    );

    const ref = await runCliJson(
      "linear-link-issue",
      "--local-type",
      "task",
      "--local-id",
      task.id,
      "--issue-key",
      "LIN-456",
    );

    expect(ref).toMatchObject({
      localType: "task",
      localId: task.id,
      provider: "linear",
      externalType: "issue",
      externalId: "LIN-456",
      externalUrl: null,
      created: true,
    });
  });

  test("reuses an existing Linear issue mapping for the same local entity", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");

    const first = await runCliJson(
      "linear-link-issue",
      "--local-type",
      "run",
      "--local-id",
      run.id,
      "--issue-url",
      "https://linear.app/pancat/issue/LIN-789/reuse-mapping",
    );
    const second = await runCliJson(
      "linear-link-issue",
      "--local-type",
      "run",
      "--local-id",
      run.id,
      "--issue-url",
      "https://linear.app/pancat/issue/LIN-789/reuse-mapping",
    );
    const refs = new Harness(dbPath).listExternalRefs({ localType: "run", localId: run.id });

    expect(second).toMatchObject({
      id: first.id,
      externalId: "https://linear.app/pancat/issue/LIN-789/reuse-mapping",
      created: false,
    });
    expect(refs).toHaveLength(1);
  });

  test("rejects invalid Linear issue mapping input", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");

    const invalidType = await runCliRaw(
      "linear-link-issue",
      "--local-type",
      "attempt",
      "--local-id",
      run.id,
      "--issue-id",
      "LIN-999",
    );
    const missingIssue = await runCliRaw(
      "linear-link-issue",
      "--local-type",
      "run",
      "--local-id",
      run.id,
    );

    expect(invalidType.exitCode).toBe(1);
    expect(invalidType.stderr).toContain("--local-type must be run or task");
    expect(missingIssue.exitCode).toBe(1);
    expect(missingIssue.stderr).toContain("Linear issue identifier is required");
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

  test("shows candidate guardrails for repeated blocked attempts while keeping run lessons JSON", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"repo":"ouroboros"}',
    );
    const firstTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "First blocked attempt",
      "--prompt",
      "Record the first failure.",
    );
    const secondTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Second blocked attempt",
      "--prompt",
      "Record the second failure.",
    );

    await runCliJson(
      "record-attempt",
      "--task-id",
      firstTask.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"blocked","summary":"First blocked attempt","problems":["missing workspace link."]}',
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      secondTask.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"blocked","summary":"Second blocked attempt","problems":["Missing workspace link"]}',
    );

    const thirdTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Render prompt after repeated lessons",
      "--prompt",
      "Show the prompt.",
    );

    const prompt = await runCli("show-task-prompt", "--task-id", thirdTask.id);

    expect(prompt).toContain("## Candidate Guardrails");
    expect(prompt).toContain("Seen 2 times");
    expect(prompt).toContain("missing workspace link");
    expect(prompt).toContain("## Run Lessons");
    expect(prompt).toContain("\"kind\": \"lesson\"");
  });

  test("runs Claude Code agent doctor from the CLI without starting a prompt smoke", async () => {
    const binDir = join(dir, "doctor-bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "acpx"),
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "if (args.join(' ') === 'config show --format json') {",
        "  console.log(JSON.stringify({ authMethods: ['custom'] }));",
        "  process.exit(0);",
        "}",
        "console.error('unexpected acpx args: ' + args.join(' '));",
        "process.exit(2);",
      ].join("\n"),
    );
    await writeFile(join(binDir, "claude"), "#!/usr/bin/env bun\nprocess.exit(0);\n");
    await writeFile(join(binDir, "npm"), "#!/usr/bin/env bun\nprocess.exit(0);\n");
    await Promise.all(["acpx", "claude", "npm"].map((name) => chmod(join(binDir, name), 0o755)));

    const result = await runCliJson("doctor-agent", "--agent", "claude-code", {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result).toMatchObject({
      agent: "claude-code",
      status: "passed",
      experimental: false,
    });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`acpx: ${binDir}/acpx`),
        "agent: claude-code",
        "acpx agent: claude",
        "adapter: available",
        "acpx authMethods: custom",
        expect.stringContaining(`claude: ${binDir}/claude`),
        "scope: ACP/acpx doctor only; no task session, prompt smoke, or write probe enabled",
      ]),
    );
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

  test("records and finishes attempts with readable structured summaries and problems", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Serialize verifier failure");
    const recordTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Record structured failure",
      "--prompt",
      "Record it.",
    );

    const recorded = await runCliJson(
      "record-attempt",
      "--task-id",
      recordTask.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "blocked",
        summary: { summary: "Record verifier blocked", status: "blocked" },
        problems: [
          {
            severity: "high",
            path: "packages/cli/src/main.ts",
            message: "record-attempt coerced object problem",
          },
        ],
      }),
    );

    const finishTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Finish structured failure",
      "--prompt",
      "Finish it.",
    );
    const started = await runCliJson("start-attempt", "--task-id", finishTask.id, "--input-json", "{}");
    await runCliJson(
      "finish-attempt",
      "--attempt-id",
      started.attemptId,
      "--output-json",
      JSON.stringify({
        status: "blocked",
        summary: { message: "Finish verifier blocked", status: "blocked" },
        problems: [
          {
            severity: "medium",
            command: "bun test tests/cli.test.ts",
            error: "finish-attempt coerced object problem",
          },
        ],
      }),
    );

    const harness = new Harness(dbPath);
    const recordAttempt = harness.getAttempt(recorded.attemptId)!;
    const finishAttempt = harness.getAttempt(started.attemptId)!;

    expect(recordAttempt.output.summary).toContain("Record verifier blocked");
    expect(recordAttempt.output.problems?.[0]).toContain("record-attempt coerced object problem");
    expect(recordAttempt.error).not.toContain("[object Object]");
    expect(finishAttempt.output.summary).toContain("Finish verifier blocked");
    expect(finishAttempt.output.problems?.[0]).toContain("finish-attempt coerced object problem");
    expect(finishAttempt.output.problems?.[0]).toContain("bun test tests/cli.test.ts");
    expect(finishAttempt.error).not.toContain("[object Object]");
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

    const result = await runCliJson("run-next", "--run-id", run.id, "--executor", "noop", "--concurrency", "2");

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
    await writeFile(
      join(binDir, "git"),
      [
        "#!/bin/sh",
        "set -eu",
        "target=\"$5\"",
        "mkdir -p \"$target/packages/cli\" \"$target/packages/harness\" \"$target/packages/runner\"",
        "cp package.json bun.lock \"$target/\"",
        "cp packages/cli/package.json \"$target/packages/cli/package.json\"",
        "cp packages/harness/package.json \"$target/packages/harness/package.json\"",
        "cp packages/runner/package.json \"$target/packages/runner/package.json\"",
      ].join("\n"),
    );
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
    expect(attempt.output.checks).toContainEqual({ name: "bun install", status: "passed" });
    expect(attempt.output.artifacts).toContainEqual({
      kind: "worktree",
      path: join(dir, "worktrees", task.id),
      branch: `ouroboros/${task.id}`,
    });
  });

  test("runs git worktree start hook before codex-resumable attempts", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task with resumable worktree",
      "--prompt",
      "Do work.",
    );
    const binDir = join(dir, "bin-resumable-worktree");
    const codexBin = join(dir, "fake-codex-resumable-worktree");
    const worktreeRoot = join(dir, "worktrees");
    const expectedCwd = join(worktreeRoot, task.id);
    await mkdir(binDir);
    await writeFile(
      join(binDir, "git"),
      [
        "#!/bin/sh",
        "set -eu",
        "target=\"$5\"",
        "mkdir -p \"$target/packages/cli\" \"$target/packages/harness\" \"$target/packages/runner\"",
        "cp package.json bun.lock \"$target/\"",
        "cp packages/cli/package.json \"$target/packages/cli/package.json\"",
        "cp packages/harness/package.json \"$target/packages/harness/package.json\"",
        "cp packages/runner/package.json \"$target/packages/runner/package.json\"",
      ].join("\n"),
    );
    await chmod(join(binDir, "git"), 0o755);
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "const cwdIndex = args.indexOf('-C');",
        `if (cwdIndex === -1 || args[cwdIndex + 1] !== ${JSON.stringify(expectedCwd)}) process.exit(9);`,
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_worktree' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"worktree cwd used\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--worktree-root",
      worktreeRoot,
      "--start-hook",
      "git-worktree",
      "--cwd",
      "/repo",
      "--codex-bin",
      codexBin,
      "--max-rounds",
      "1",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const attempt = new Harness(dbPath).getAttempt(result.rounds[0].tasks[0].attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId: task.id,
      status: "done",
      codexSessionId: "session_worktree",
    });
    expect(attempt.input.cwd).toBe(expectedCwd);
    expect(attempt.output.checks).toContainEqual({ name: "git worktree add", status: "passed" });
    expect(attempt.output.checks).toContainEqual({ name: "bun install", status: "passed" });
    expect(attempt.output.artifacts).toContainEqual({
      kind: "worktree",
      path: expectedCwd,
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

  test("selects an acpx backend from run role defaults and records it", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"agentDefaults":{"roles":{"worker":"opencode"}}}',
    );
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Run through opencode",
      "--prompt",
      "Use the fake opencode executor.",
    );
    const binDir = join(dir, "bin-agent-backend");
    const logPath = join(dir, "acpx-args.json");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "acpx"),
      [
        "#!/usr/bin/env bun",
        "const { writeFileSync } = await import('node:fs');",
        "const args = Bun.argv.slice(2);",
        `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));`,
        "await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({ status: 'done', summary: 'opencode selected', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
      ].join("\n"),
    );
    await chmod(join(binDir, "acpx"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "codex-cli",
      "--cwd",
      "/repo",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const attempt = new Harness(dbPath).getAttempt(result.tasks[0].attemptId)!;

    expect(result.tasks[0].taskId).toBe(task.id);
    expect(JSON.parse(await Bun.file(logPath).text())).toContain("opencode");
    expect(attempt.input.backend).toMatchObject({
      id: "opencode",
      kind: "acpx",
      agent: "opencode",
      source: "role-default",
    });
    expect(attempt.input.cwd).toBe("/repo");
  });

  test("run-loop dispatches role backend workers through acpx even with codex-resumable fallback", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"agentDefaults":{"roles":{"worker":"claude-code"}},"agentBackends":{"claude-code":{"kind":"acpx","agent":"claude","approval":"approve-all"}}}',
    );
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Run through Claude Code",
      "--prompt",
      "Use the fake Claude Code executor.",
    );
    const binDir = join(dir, "bin-resumable-agent-backend");
    const logPath = join(dir, "acpx-resumable-args.jsonl");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "acpx"),
      [
        "#!/usr/bin/env bun",
        "const { appendFileSync } = await import('node:fs');",
        "const args = Bun.argv.slice(2);",
        `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
        "await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({ status: 'done', summary: 'claude selected', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
      ].join("\n"),
    );
    await chmod(join(binDir, "acpx"), 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const attemptId = result.rounds[0].tasks[0].attemptId;
    const attempt = new Harness(dbPath).getAttempt(attemptId)!;
    const loggedCalls = (await Bun.file(logPath).text()).trim().split("\n").map((line) => JSON.parse(line));
    const promptCall = loggedCalls.find((args: string[]) => args.includes("claude") && args.includes("-s"));

    expect(result.rounds[0].tasks[0].taskId).toBe(task.id);
    expect(result.rounds[0].tasks[0].status).toBe("done");
    expect(promptCall).toContain("--approve-all");
    expect(promptCall).toContain("claude");
    expect(promptCall).not.toContain("--model");
    expect(attempt.input.backend).toMatchObject({
      id: "claude-code",
      kind: "acpx",
      agent: "claude",
      approval: "approve-all",
      source: "role-default",
    });
    expect(attempt.input.executor).toBe("acpx");
    expect(attempt.output.summary).toBe("claude selected");
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
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"modelDefaults":{"roles":{"planner":{"model":"gpt-5-mini","reason":"cheap planning"}}}}',
    );
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
        "if (!args.includes('-m') || !args.includes('gpt-5-mini')) process.exit(9);",
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
      "--model",
      "gpt-5-codex",
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
      "--model",
      "gpt-5-codex",
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
    const attempt = new Harness(dbPath).getAttempt(started.attemptId)!;
    expect(attempt.input.model).toEqual({
      model: "gpt-5-mini",
      reason: "cheap planning",
      source: "role-default",
      role: "planner",
    });
    expect(attempt.input.childEnv).toEqual({
      PATH: expect.stringContaining(join(homedir(), ".bun/bin")),
      tools: {
        bun: expect.any(Object),
        node: expect.any(Object),
        npm: expect.any(Object),
        npx: expect.any(Object),
      },
    });
    expect(attempt.output.summary).toBe("resumed planner");
  });

  test("codex resumable attempts store and reuse config-seeded role model metadata", async () => {
    await runCli("init");
    const configPath = join(dir, "role-models.toml");
    await writeFile(
      configPath,
      [
        "[models.roles.worker]",
        'model = "gpt-5.4-mini"',
        'provider = "openai"',
        'profile = "fast"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "OPENAI_API_KEY"',
      ].join("\n"),
    );
    const run = await runCliJson("create-run", "--goal", "Config model run", "--config", configPath);
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Async worker",
      "--prompt",
      "Work asynchronously.",
    );
    const argsPath = join(dir, "codex-args.jsonl");
    const codexBin = join(dir, "fake-codex-config-model");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { appendFileSync } from 'node:fs';",
        "const args = Bun.argv.slice(2);",
        `appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + "\\n");`,
        "const modelIndex = args.indexOf('-m');",
        "if (modelIndex === -1 || args[modelIndex + 1] !== 'gpt-5.4-mini') process.exit(9);",
        "if (args.includes('resume')) {",
        "  console.log(JSON.stringify({ type: 'session.started', session_id: 'session_config_model' }));",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"resumed config model\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_config_model' }));",
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
      "--model",
      "gpt-5-codex",
    );
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
      "--model",
      "wrong-resume-model",
    );
    const attempt = new Harness(dbPath).getAttempt(started.attemptId)!;
    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const recordedArgs = (await Bun.file(argsPath).text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(resumed).toMatchObject({
      attemptId: started.attemptId,
      status: "done",
    });
    expect(recordedArgs).toHaveLength(2);
    expect(recordedArgs.every((args: string[]) => args.includes("gpt-5.4-mini"))).toBe(true);
    expect(recordedArgs.some((args: string[]) => args.includes("wrong-resume-model"))).toBe(false);
    expect(attempt.input.model).toEqual({
      model: "gpt-5.4-mini",
      provider: "openai",
      profile: "fast",
      base_url: "https://api.example.test/v1",
      env_key: "OPENAI_API_KEY",
      source: "role-default",
      role: "worker",
    });
    expect(overview.sessions[0].model).toEqual(attempt.input.model);
    expect(attempt.output.summary).toBe("resumed config model");
  });

  test("uses task model preference before role defaults and cli model", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Bootstrap ouroboros",
      "--context-json",
      '{"modelDefaults":{"roles":{"worker":{"model":"gpt-5-mini","reason":"cheap worker default"}}}}',
    );
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Async worker",
      "--prompt",
      "Work asynchronously.",
      "--config-json",
      '{"modelPreference":{"model":"gpt-5-task","reason":"task needs stronger model"}}',
    );
    const codexBin = join(dir, "fake-codex-task-model");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const args = Bun.argv.slice(2);",
        "const modelIndex = args.indexOf('-m');",
        "if (modelIndex === -1 || args[modelIndex + 1] !== 'gpt-5-task') process.exit(9);",
        "if (args.includes('gpt-5-mini') || args.includes('gpt-5-codex')) process.exit(8);",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_task_model' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"task model used\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const started = await runCliJson(
      "codex-start-attempt",
      "--task-id",
      task.id,
      "--codex-bin",
      codexBin,
      "--model",
      "gpt-5-codex",
    );

    expect(started).toMatchObject({
      taskId: task.id,
      status: "done",
      codexSessionId: "session_task_model",
    });
    expect(new Harness(dbPath).getAttempt(started.attemptId)?.input.model).toEqual({
      model: "gpt-5-task",
      reason: "task needs stronger model",
      source: "task",
      role: "worker",
    });
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

  test("run-loop reclaims leased tasks that have no running attempt", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Recover orphaned lease",
      "--prompt",
      "Finish recovered task.",
    );
    new Harness(dbPath).leaseReadyTasks({
      runId: run.id,
      limit: 1,
      sessionForTask: (leased) => `task-${leased.id}`,
    });
    const codexBin = join(dir, "fake-codex-reclaimed-lease");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_reclaimed' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"recovered orphaned lease\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
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
      "--sandbox",
      "read-only",
      "--max-rounds",
      "1",
    );
    const harness = new Harness(dbPath);

    expect(result.rounds[0].reclaimed).toEqual([
      expect.objectContaining({
        taskId: task.id,
        reason: "running task has no running attempt",
      }),
    ]);
    expect(result.rounds[0].tasks).toEqual([
      expect.objectContaining({
        taskId: task.id,
        status: "done",
        codexSessionId: "session_reclaimed",
      }),
    ]);
    expect(harness.getTask(task.id)?.status).toBe("done");
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
        "if (!prompt.includes('cite concrete evidence')) process.exit(3);",
        "if (!prompt.includes('repository files or docs')) process.exit(4);",
        "if (!prompt.includes('tests or commands')) process.exit(5);",
        "if (!prompt.includes('dashboard or run overview state')) process.exit(6);",
        "if (!prompt.includes('recent lessons')) process.exit(7);",
        "if (!prompt.includes('before declaring complete')) process.exit(8);",
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

  test("run-loop recovers explicit textual goal-review runDecision", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap role model defaults");
    const codexBin = join(dir, "fake-codex-goal-text-decision");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', summary: 'Tests passed and the runDecision complete is clear.', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
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
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.status).toBe("done");
    expect(overview.sessions[0].output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("run-loop defers a run when goal-review is waiting on external recovery", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Prove Hermes provider readiness");
    const codexBin = join(dir, "fake-codex-goal-defer");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('runDecision defer:')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'defer', summary: 'Provider connectivity is down; pause until external recovery.', changedFiles: [], checks: [{ name: 'provider smoke', status: 'failed' }], artifacts: [], problems: ['API call failed after 3 retries.'] }));",
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
    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const second = await runCliJson(
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

    expect(overview.run.status).toBe("blocked");
    expect(overview.tasks).toHaveLength(1);
    expect(overview.sessions[0].output).toMatchObject({
      status: "done",
      runDecision: "defer",
    });
    expect(second.rounds).toEqual([]);
  });

  test("run-loop restores a maxed blocked goal review with explicit textual completion", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap role model defaults");
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review whether the run goal is complete",
      "--prompt",
      "Review the completed run.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "blocked",
        summary: "Repository checks passed; runDecision complete.",
        problems: ["goal-review output must include runDecision"],
      }),
    );

    await runCliJson(
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
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.status).toBe("done");
  });

  test("run-loop restores a run completed by an existing goal review", async () => {
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
      "Review the completed run.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"done","runDecision":"complete","summary":"goal reached","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
    );

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      join(dir, "missing-codex-should-not-run"),
      "--max-rounds",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.rounds).toEqual([]);
    expect(overview.run.status).toBe("done");
    expect(overview.tasks).toHaveLength(1);
  });

  test("goal-review prompt allows bounded multi-task continue and verify plans", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const codexBin = join(dir, "fake-codex-goal-prompt-contract");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('runDecision continue:')) process.exit(2);",
        "if (!prompt.includes('include one to five nextTasks items')) process.exit(3);",
        "if (!prompt.includes('runDecision verify:')) process.exit(4);",
        "if (!prompt.includes('include one to five verifier nextTasks items')) process.exit(5);",
        "if (!prompt.includes('runDecision defer:')) process.exit(6);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'verify', summary: 'needs independent checks', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'verifier', goal: 'Verify goal completion evidence', prompt: 'Inspect the evidence.', doneWhen: ['evidence checked'] }, { role: 'verifier', goal: 'Verify dashboard evidence', prompt: 'Inspect dashboard evidence.', doneWhen: ['dashboard checked'] }] }));",
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
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.tasks).toContainEqual(expect.objectContaining({ role: "verifier", goal: "Verify goal completion evidence" }));
    expect(overview.tasks).toContainEqual(expect.objectContaining({ role: "verifier", goal: "Verify dashboard evidence" }));
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

  test("run-loop creates a fresh goal review after newer work supersedes a maxed blocked review", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const staleReview = await runCliJson(
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
        staleReview.id,
        "--input-json",
        "{}",
        "--output-json",
        JSON.stringify({ status: "blocked", summary: problem, problems: [problem] }),
      );
    }
    const newerWorker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Repair after stale review",
      "--prompt",
      "Repair.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      newerWorker.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"done","summary":"newer work done","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
    );
    const codexBin = join(dir, "fake-codex-fresh-review");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"runDecision\":\"complete\",\"summary\":\"fresh review completed\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
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
    const freshReview = overview.tasks.find(
      (task: { role: string; id: string }) => task.role === "goal-review" && task.id !== staleReview.id,
    );

    expect(freshReview).toBeDefined();
    expect(result.rounds[0].tasks[0].taskId).toBe(freshReview!.id);
    expect(freshReview!).toMatchObject({
      role: "goal-review",
      status: "done",
    });
    expect(overview.run.status).toBe("done");
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

  test("supervise-runs drains an intake run and generated child run", async () => {
    await runCli("init");
    const stale = await runCliJson("create-run", "--goal", "Unrelated stale run");
    await runCliJson(
      "create-task",
      "--run-id",
      stale.id,
      "--role",
      "worker",
      "--goal",
      "Should not run",
      "--prompt",
      "This task is outside the supervisor root scope.",
    );
    const intake = await runCliJson(
      "intake",
      "--title",
      "React dashboard migration",
      "--document",
      "Migrate dashboard to React shadcn and add an attachment composer.",
    );
    const codexBin = join(dir, "fake-codex-supervisor");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({ type: 'session.started', session_id: prompt.includes('Role: goal-review') ? 'session_goal' : prompt.includes('Split requirement document') ? 'session_intake' : 'session_child' }));",
        "if (prompt.includes('Role: goal-review')) {",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"runDecision\":\"complete\",\"summary\":\"goal reached\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Split requirement document')) {",
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"split runs\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[],\"nextRuns\":[{\"goal\":\"Build React shadcn dashboard composer\",\"prompt\":\"Plan the React dashboard composer work.\",\"doneWhen\":[\"composer planned\",\"verifier planned\"],\"context\":{\"area\":\"dashboard\"}}]}' }));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"child planner finished\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "supervise-runs",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      intake.runId,
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-runs,create-tasks,create-verifier,create-repair,context-summary",
      "--run-concurrency",
      "2",
      "--concurrency",
      "1",
      "--max-cycles",
      "6",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
    );
    const runs = await runCliJson("list-runs");
    const staleOverview = await runCliJson("run-overview", "--run-id", stale.id);
    const intakeOverview = await runCliJson("run-overview", "--run-id", intake.runId);
    const child = runs.find((run: { goal: string }) => run.goal === "Build React shadcn dashboard composer");

    expect(result.cycles.length).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe("idle");
    expect(intakeOverview.run.status).toBe("done");
    expect(staleOverview.run.status).toBe("todo");
    expect(staleOverview.tasks[0].status).toBe("todo");
    expect(child).toMatchObject({
      goal: "Build React shadcn dashboard composer",
      status: "done",
      context: expect.objectContaining({
        parentRunId: intake.runId,
        source: "nextRuns",
        area: "dashboard",
      }),
    });
  });

  test("supervise-daemon runs bounded ticks and reports queue counts", async () => {
    await runCli("init");
    const result = await runCliJson(
      "supervise-daemon",
      "--executor",
      "codex-resumable",
      "--run-concurrency",
      "2",
      "--concurrency",
      "1",
      "--max-ticks",
      "2",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--idle-ms",
      "1",
      "--interval-ms",
      "1",
    );

    expect(result.status).toBe("tick_limit");
    expect(result.ticks).toHaveLength(2);
    expect(result.ticks[0]).toMatchObject({
      type: "daemon.tick",
      index: 0,
      result: expect.objectContaining({ status: "idle" }),
      runCounts: expect.objectContaining({ todo: 0 }),
    });
  });

  test("supervise-daemon records failed ticks without crashing", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Run with missing executor");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Attempt work with a missing codex binary",
      "--prompt",
      "Return structured JSON after this simulated executor call.",
    );

    const result = await runCliJson(
      "supervise-daemon",
      "--executor",
      "codex-resumable",
      "--codex-bin",
      join(dir, "missing-codex"),
      "--run-concurrency",
      "1",
      "--concurrency",
      "1",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--idle-ms",
      "1",
      "--interval-ms",
      "1",
    );

    expect(result.status).toBe("tick_limit");
    expect(result.ticks).toHaveLength(1);
    expect(result.ticks[0]).toMatchObject({
      type: "daemon.tick",
      index: 0,
      status: "error",
      error: expect.any(String),
      runCounts: expect.objectContaining({ todo: 1 }),
    });
  });

  test("supervise-daemon defaults resumable codex to workspace-write sandbox", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Run with writable daemon default");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Capture daemon sandbox",
      "--prompt",
      "Capture sandbox arguments.",
    );
    const argsPath = join(dir, "codex-args.json");
    const codexBin = join(dir, "fake-codex-sandbox");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(Bun.argv.slice(2)));`,
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        "const payload = { status: 'done', summary: 'captured sandbox', changedFiles: [], checks: [], artifacts: [], problems: [] };",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_sandbox_default' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    await runCliJson(
      "supervise-daemon",
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--run-concurrency",
      "1",
      "--concurrency",
      "1",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--idle-ms",
      "1",
      "--interval-ms",
      "1",
    );
    const args = JSON.parse(await Bun.file(argsPath).text());
    const sandboxIndex = args.indexOf("--sandbox");

    expect(sandboxIndex).toBeGreaterThanOrEqual(0);
    expect(args[sandboxIndex + 1]).toBe("workspace-write");
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
    const db = new Database(dbPath);
    db.query("update attempts set started_at = datetime('now', '-10 minutes') where id = $attemptId").run({
      $attemptId: stale.attemptId,
    });
    db.close();
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

  test("run-loop waits for fresh running attempts without a codex session id", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Wait for in-flight task",
      "--prompt",
      "Continue the in-flight task.",
    );
    const fresh = await runCliJson(
      "start-attempt",
      "--task-id",
      task.id,
      "--input-json",
      '{"sessionName":"fresh-session","executor":"codex-resumable"}',
    );
    new Harness(dbPath).recordAttemptEvent({
      attemptId: fresh.attemptId,
      sequence: 1,
      stream: "stdout",
      text: "still working",
    });

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      run.id,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      join(dir, "missing-codex-should-not-run"),
      "--cwd",
      "/repo",
      "--max-rounds",
      "1",
    );
    const harness = new Harness(dbPath);

    expect(result.rounds[0].tasks).toContainEqual(
      expect.objectContaining({
        attemptId: fresh.attemptId,
        status: "running",
        codexSessionId: null,
      }),
    );
    expect(harness.getAttempt(fresh.attemptId)?.status).toBe("running");
    expect(harness.getTask(task.id)?.status).toBe("running");
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

  test("applies harness actions from the CLI and records action events", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Repair leased task");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Recover lease",
      "--prompt",
      "Recover this task.",
    );
    new Harness(dbPath).leaseReadyTasks({
      runId: run.id,
      limit: 1,
      sessionForTask: (leased) => `task-${leased.id}`,
    });

    const result = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({ type: "reclaimRunningTasks", runId: run.id }),
    );
    const events = await runCliJson("action-events", "--limit", "1");

    expect(result).toMatchObject({
      status: "done",
      actionType: "reclaimRunningTasks",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "reclaimed_task", taskId: task.id }));
    expect((await runCliJson("next-task", "--run-id", run.id)).id).toBe(task.id);
    expect(events[0]).toMatchObject({
      actionType: "reclaimRunningTasks",
      status: "done",
    });
  });

  test("overseer-tick prints diagnosis JSON with empty-run and queue starvation signals", async () => {
    await runCli("init");
    const emptyRun = await runCliJson("create-run", "--goal", "Empty overseer run");
    const queuedRun = await runCliJson("create-run", "--goal", "Queued overseer run");
    const queuedTask = await runCliJson(
      "create-task",
      "--run-id",
      queuedRun.id,
      "--role",
      "worker",
      "--goal",
      "Queued work",
      "--prompt",
      "Wait for a runner.",
    );

    const emptyTick = await runCliJson("overseer-tick", "--run-id", emptyRun.id);
    const queuedTick = await runCliJson("overseer-tick", "--run-id", queuedRun.id);

    expect(emptyTick).toMatchObject({
      status: "done",
      runId: emptyRun.id,
      summary: `Diagnosed run ${emptyRun.id}.`,
      diagnosis: expect.objectContaining({
        state: "waiting",
        emptyRunGoalReviewRaceRisk: true,
        queueStarvation: false,
      }),
      intervention: null,
    });
    expect(queuedTick).toMatchObject({
      status: "done",
      runId: queuedRun.id,
      diagnosis: expect.objectContaining({
        emptyRunGoalReviewRaceRisk: false,
        queueStarvation: true,
        activeWork: expect.objectContaining({
          readyTaskIds: [queuedTask.id],
        }),
      }),
      intervention: null,
    });
  });

  test("overseer-tick interrupts a running attempt through the harness action layer", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Interrupt overseer run");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Interrupted work",
      "--prompt",
      "Keep going.",
    );
    const attemptId = await runCliJson("start-attempt", "--task-id", task.id, "--input-json", "{}");
    new Harness(dbPath).upsertExecutionThread({
      runId: run.id,
      taskId: task.id,
      attemptId: attemptId.attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "task-interrupt",
      agentSessionId: "codex_interrupt",
    });

    const result = await runCliJson(
      "overseer-tick",
      "--run-id",
      run.id,
      "--interrupt-attempt",
      attemptId.attemptId,
      "--reason",
      "overseer observed stale work",
      "--follow-up-json",
      '{"role":"planner","goal":"Replan after interruption","prompt":"Inspect the interrupted run and produce the next plan.","doneWhen":["next plan emitted"]}',
    );
    const events = await runCliJson("action-events", "--limit", "1");
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result).toMatchObject({
      status: "done",
      runId: run.id,
      intervention: expect.objectContaining({
        status: "done",
        actionType: "interruptAttemptAndCreateTask",
        eventId: expect.any(String),
      }),
    });
    expect(events[0]).toMatchObject({
      id: result.eventId,
      actionType: "interruptAttemptAndCreateTask",
      status: "done",
    });
    expect(overview.tasks).toHaveLength(2);
    expect(overview.tasks).toContainEqual(
      expect.objectContaining({
        role: "planner",
        status: "todo",
        parentId: task.id,
      }),
    );
    expect(new Harness(dbPath).getAttempt(attemptId.attemptId)?.status).toBe("blocked");
  });

  test("overseer-tick reports blocked JSON when the intervention cannot be applied", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Blocked overseer tick");

    const result = await runCliJson(
      "overseer-tick",
      "--run-id",
      run.id,
      "--interrupt-attempt",
      "attempt_missing",
      "--reason",
      "overseer observed stale work",
      "--follow-up-json",
      '{"role":"planner","goal":"Replan after interruption","prompt":"Inspect the interrupted run and produce the next plan.","doneWhen":["next plan emitted"]}',
    );
    const events = await runCliJson("action-events", "--limit", "1");

    expect(result).toMatchObject({
      status: "blocked",
      runId: run.id,
      diagnosis: expect.objectContaining({
        state: "waiting",
      }),
      intervention: expect.objectContaining({
        status: "blocked",
        actionType: "interruptAttemptAndCreateTask",
        eventId: expect.any(String),
      }),
      problems: [expect.stringContaining("attempt not found")],
    });
    expect(events[0]).toMatchObject({
      id: result.eventId,
      actionType: "interruptAttemptAndCreateTask",
      status: "blocked",
    });
  });

  test("retires stale runs through the harness action CLI", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Duplicate historical self-iteration");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Old planner",
      "--prompt",
      "Old duplicate planner.",
    );

    const result = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({ type: "retireRun", runId: run.id, reason: "duplicate historical self-iteration run" }),
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const todoRuns = await runCliJson("list-runs", "--status", "todo");

    expect(result).toMatchObject({
      status: "done",
      actionType: "retireRun",
    });
    expect(overview.run.status).toBe("blocked");
    expect(overview.tasks[0].status).toBe("blocked");
    expect(todoRuns.some((todoRun: { id: string }) => todoRun.id === run.id)).toBe(false);
  });

  async function runCli(...rawArgs: Array<string | Record<string, string>>) {
    const result = await runCliRaw(...rawArgs);
    if (result.exitCode !== 0) {
      throw new Error(`CLI failed with ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async function runCliRaw(...rawArgs: Array<string | Record<string, string>>) {
    const envOverride =
      typeof rawArgs.at(-1) === "object" ? (rawArgs.pop() as Record<string, string>) : {};
    const args = rawArgs as string[];
    const configArgs = args.includes("--config") ? [] : ["--config", join(dir, "missing-config.toml")];
    const proc = Bun.spawn({
      cmd: ["bun", "run", "packages/cli/src/main.ts", "--db", dbPath, ...configArgs, ...args],
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
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }

  async function runCliJson(...args: Array<string | Record<string, string>>) {
    return JSON.parse(await runCli(...args));
  }

  async function runRootOrbsJson(...args: string[]) {
    const proc = Bun.spawn({
      cmd: ["bun", "./bin/orbs", "--db", dbPath, ...args],
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`orbs wrapper failed with ${exitCode}\n${stdout}\n${stderr}`);
    }
    return JSON.parse(stdout.trim());
  }

  async function readFirstLine(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          return buffer.slice(0, newline).trim();
        }
      }
      return buffer.trim();
    } finally {
      reader.releaseLock();
    }
  }

  function nextTestPort() {
    return 30000 + process.pid % 10000 + nextPortOffset++;
  }

  function canStartServerOn(port: number) {
    const server = startTestServer({ port, fetch: () => new Response("ok") });
    if (!server) {
      return false;
    }
    server.stop(true);
    return true;
  }

  function startTestServer(input: { port?: number; fetch: (request: Request) => Response | Promise<Response> }) {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      try {
        return Bun.serve({
          hostname: "127.0.0.1",
          port: input.port ?? nextTestPort(),
          fetch: input.fetch,
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Failed to start server")) {
          throw error;
        }
      }
    }
    return null;
  }
});
