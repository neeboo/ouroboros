import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import { formatRunEvidence } from "../packages/cli/src/run-evidence";
import { formatAttemptExplanation } from "../packages/cli/src/explain-attempt";
import { formatRunGraph } from "../packages/cli/src/run-graph";
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

  test("prints help without requiring a command or flag value", async () => {
    const help = await runCliRaw("--help");
    const shortHelp = await runCliRaw("-h");
    const commandHelp = await runCliRaw("init", "--help");

    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("orbs --help");
    expect(shortHelp).toMatchObject({ exitCode: 0, stderr: "" });
    expect(shortHelp.stdout).toContain("Core commands:");
    expect(commandHelp).toMatchObject({ exitCode: 0, stderr: "" });
    expect(commandHelp.stdout).toContain("init");
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

    expect(overview.run.id).toBe(result.runId);
    expect(overview.run.goal).toBe("Use Ouroboros to plan its own next self-iteration cycle");
    expect(overview.run.context.source).toBe("self-iterate");
    expect(overview.run.context.planDoc).toBe("docs/self-iteration-plan.md");
    expect(overview.run.context.modelDefaults.roles.worker.model).toBe("gpt-5.4-mini");
    const goalContract = overview.run.context.goalContract;
    expect(goalContract).toBeDefined();
    expect(typeof goalContract.desiredState).toBe("string");
    expect(goalContract.desiredState).toContain("plan and drain its own next improvement cycle");
    expect(Array.isArray(goalContract.successCriteria)).toBe(true);
    expect(goalContract.successCriteria.length).toBeGreaterThan(0);
    expect(goalContract.successCriteria).toContain("a new Ouroboros run exists for self-iteration");
    expect(goalContract.successCriteria).toContain("the generated graph points to concrete files and checks");
    expect(Array.isArray(goalContract.constraints)).toBe(true);
    expect(goalContract.constraints.length).toBeGreaterThan(0);
    expect(goalContract.constraints).toContain("Do not change database schema or dependency sets in this slice");
    expect(goalContract.constraints).toContain("Do not start implementation from a vague task");
    expect(Array.isArray(goalContract.requiredEvidence)).toBe(true);
    expect(goalContract.requiredEvidence.length).toBeGreaterThan(0);
    expect(goalContract.requiredEvidence).toContain("orbs run-overview --run-id <run_id>");
    expect(goalContract.requiredEvidence).toContain("orbs list-lessons --run-id <run_id>");
    expect(goalContract.budget.maxRounds).toBe(8);
    expect(goalContract.budget.maxAttemptsPerTask).toBe(3);
    expect(Array.isArray(goalContract.stopPolicy.completeWhen)).toBe(true);
    expect(goalContract.stopPolicy.completeWhen.length).toBeGreaterThan(0);
    expect(Array.isArray(goalContract.stopPolicy.blockWhen)).toBe(true);
    expect(goalContract.stopPolicy.blockWhen.length).toBeGreaterThan(0);
    expect(Array.isArray(goalContract.stopPolicy.askHumanWhen)).toBe(true);
    expect(goalContract.stopPolicy.askHumanWhen.length).toBeGreaterThan(0);
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

  test("self-iteration bootstrap routes planner, verifier, and goal-review through codex-resumable over a claude-code global default", async () => {
    await runCli("init");
    const configPath = join(dir, "self-iterate.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults]",
        'global = "claude-code"',
        "",
        "[agentBackends.claude-code]",
        'kind = "acpx"',
        'agent = "claude"',
        'approval = "approve-all"',
      ].join("\n"),
    );

    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.agentDefaults).toEqual({
      global: "claude-code",
      roles: {
        planner: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
      },
    });
    expect(overview.run.context.agentBackends).toMatchObject({
      "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
    });

    expect(result.runnerCommand).toContain("--executor codex-resumable");
    expect(result.runnerCommand).toContain(`run-loop --run-id ${result.runId}`);
    expect(result.runnerCommand).toContain("--stop-hook create-runs,create-tasks,create-verifier,create-repair,context-summary");
    expect(result.launchCommand).toContain("self-iterate-launch");

    const lessons = await runCliJson("list-lessons", "--run-id", result.runId);
    expect(Array.isArray(lessons)).toBe(true);
  });

  test("self-iteration bootstrap keeps explicit role agent backend overrides from config", async () => {
    await runCli("init");
    const configPath = join(dir, "self-iterate.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults]",
        'global = "claude-code"',
        "",
        "[agentDefaults.roles]",
        'planner = "claude-code"',
        "",
        "[agentBackends.claude-code]",
        'kind = "acpx"',
        'agent = "claude"',
        'approval = "approve-all"',
      ].join("\n"),
    );

    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.agentDefaults).toEqual({
      global: "claude-code",
      roles: {
        planner: "claude-code",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
      },
    });
  });

  test("self-iteration run drains a concrete planner actions graph to a goal-review decision", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const codexBin = join(dir, "fake-codex-self-iterate-drain");
    const plannerOutput = {
      status: "done",
      summary: "Planned two concrete worker tasks through actions createTasks",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      actions: [
        {
          type: "createTasks",
          payload: {
            tasks: [
              {
                role: "worker",
                goal: "Clarify dashboard task vs runner actions",
                prompt:
                  "Inspect packages/cli/src/dashboard.ts and packages/cli/src/main.ts first. Add a short label that distinguishes task-level actions from runner-level actions in the dashboard actions panel.",
                dependsOn: [],
                doneWhen: [
                  "packages/cli/src/dashboard.ts has been inspected for the actions panel",
                  "packages/cli/src/main.ts has been inspected for task and runner commands",
                  "the new label appears in the rendered dashboard actions panel",
                  "bun test tests/cli.test.ts still passes",
                ],
              },
              {
                role: "worker",
                goal: "Expose a graph view helper for run-overview",
                prompt:
                  "Inspect packages/cli/src/run-graph.ts and packages/cli/src/main.ts first. Expose a small graph view helper that returns the task graph used by run-overview without changing the database schema.",
                dependsOn: [],
                doneWhen: [
                  "packages/cli/src/run-graph.ts has been inspected",
                  "the graph view helper is exported and unit-checked",
                  "orbs run-overview --run-id <run_id> still returns the existing fields",
                  "bun test tests/cli.test.ts still passes",
                ],
              },
            ],
          },
        },
      ],
    };
    const goalReviewOutput = {
      status: "done",
      runDecision: "complete",
      summary:
        "Planner graph drained through worker, verifier, and goal-review with concrete files and checks cited.",
      changedFiles: [],
      checks: [
        { name: "graph drains without manual task insertion", status: "passed" },
        { name: "orbs run-overview --run-id shows done run", status: "passed" },
        { name: "orbs list-lessons --run-id returns lessons", status: "passed" },
      ],
      artifacts: [],
      problems: [],
    };
    const verifierOutput = {
      status: "done",
      summary: "Verified worker output against the cited files and reran the named checks.",
      changedFiles: [],
      checks: [
        { name: "bun test tests/cli.test.ts", status: "passed" },
        { name: "verifier cites source files", status: "passed" },
      ],
      artifacts: [],
      problems: [],
    };
    const workerOutput = {
      status: "done",
      summary: "Applied the planned dashboard and graph view changes and reran tests.",
      changedFiles: ["packages/cli/src/dashboard.ts", "packages/cli/src/run-graph.ts"],
      checks: [
        { name: "bun test tests/cli.test.ts", status: "passed" },
        { name: "worker cites inspected files", status: "passed" },
      ],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "const sessionId = prompt.includes('Role: goal-review') ? 'session_review' : prompt.includes('Role: planner') ? 'session_planner' : prompt.includes('Role: verifier') ? 'session_verifier' : 'session_worker';",
        "console.log(JSON.stringify({ type: 'session.started', session_id: sessionId }));",
        "if (prompt.includes('Role: planner')) {",
        `  console.log(JSON.stringify({ type: 'agent.message', message: ${JSON.stringify(JSON.stringify(plannerOutput))} }));`,
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Role: goal-review')) {",
        `  console.log(JSON.stringify({ type: 'agent.message', message: ${JSON.stringify(JSON.stringify(goalReviewOutput))} }));`,
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Role: verifier')) {",
        `  console.log(JSON.stringify({ type: 'agent.message', message: ${JSON.stringify(JSON.stringify(verifierOutput))} }));`,
        "  process.exit(0);",
        "}",
        `  console.log(JSON.stringify({ type: 'agent.message', message: ${JSON.stringify(JSON.stringify(workerOutput))} }));`,
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "run-loop",
      "--run-id",
      bootstrap.runId,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-runs,create-tasks,create-verifier,create-repair,context-summary",
      "--max-rounds",
      "8",
    );
    const overview = await runCliJson("run-overview", "--run-id", bootstrap.runId);
    const lessons = await runCliJson("list-lessons", "--run-id", bootstrap.runId);
    const next = await runCliJson("next-task", "--run-id", bootstrap.runId);
    const workers = overview.tasks.filter((task: { role: string }) => task.role === "worker");
    const verifiers = overview.tasks.filter((task: { role: string }) => task.role === "verifier");
    const review = overview.tasks.find((task: { role: string }) => task.role === "goal-review");

    expect(overview.run.status).toBe("done");
    expect(next).toBeNull();
    expect(Array.isArray(lessons)).toBe(true);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(workers).toHaveLength(2);
    for (const task of workers) {
      expect(task.prompt).toMatch(/packages\/cli\/src\//);
      expect(task.doneWhen.length).toBeGreaterThanOrEqual(3);
      expect(task.doneWhen.length).toBeLessThanOrEqual(5);
      expect(task.status).toBe("done");
    }
    expect(verifiers).toHaveLength(2);
    for (const task of verifiers) {
      expect(task.dependsOn).toHaveLength(1);
      expect(workers.some((worker: { id: string }) => worker.id === task.dependsOn[0])).toBe(true);
      expect(task.status).toBe("done");
    }
    expect(review).toMatchObject({ role: "goal-review", status: "done" });
    const reviewSession = overview.sessions.find(
      (session: { role: string }) => session.role === "goal-review",
    );
    expect(reviewSession?.output).toMatchObject({ status: "done", runDecision: "complete" });
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

  test("ingests a Linear event payload into inbox_events without mutating other state", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Seed",
      "--prompt",
      "Seed.",
    );

    const stored = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-123",
      "--payload-json",
      JSON.stringify({ action: "create", title: "Bootstrap ouroboros", url: "https://linear.app/pancat/issue/LIN-123/bootstrap" }),
    );

    expect(stored).toMatchObject({
      provider: "linear",
      eventType: "issue.created",
      externalId: "LIN-123",
      status: "todo",
      payload: {
        action: "create",
        title: "Bootstrap ouroboros",
        url: "https://linear.app/pancat/issue/LIN-123/bootstrap",
      },
    });
    expect(stored.id).toMatch(/^inbox_/);

    const harness = new Harness(dbPath);
    const inbox = harness.listInboxEvents({ provider: "linear" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: stored.id,
      provider: "linear",
      eventType: "issue.created",
      externalId: "LIN-123",
      status: "todo",
      payload: { action: "create", title: "Bootstrap ouroboros" },
    });
    expect(harness.listExternalRefs({ localType: "run", localId: run.id })).toEqual([]);
    expect(harness.getTask(task.id)?.status).toBe("todo");
  });

  test("rejects invalid Linear event intake without creating inbox rows", async () => {
    await runCli("init");

    const invalidJson = await runCliRaw(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-123",
      "--payload-json",
      "{not-json}",
    );
    const arrayPayload = await runCliRaw(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-123",
      "--payload-json",
      "[]",
    );
    const missingEventType = await runCliRaw(
      "linear-ingest-event",
      "--external-id",
      "LIN-123",
      "--payload-json",
      "{}",
    );
    const missingExternalId = await runCliRaw(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--payload-json",
      "{}",
    );
    const missingPayload = await runCliRaw(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-123",
    );

    expect(invalidJson.exitCode).toBe(1);
    expect(invalidJson.stderr).toContain("--payload-json must be valid JSON");
    expect(arrayPayload.exitCode).toBe(1);
    expect(arrayPayload.stderr).toContain("--payload-json must be a JSON object");
    expect(missingEventType.exitCode).toBe(1);
    expect(missingEventType.stderr).toContain("--event-type is required");
    expect(missingExternalId.exitCode).toBe(1);
    expect(missingExternalId.stderr).toContain("--external-id is required");
    expect(missingPayload.exitCode).toBe(1);
    expect(missingPayload.stderr).toContain("--payload-json is required");

    expect(new Harness(dbPath).listInboxEvents({ provider: "linear" })).toEqual([]);
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

  test("record-attempt normalizes done run decisions to complete", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Normalize manual run decision");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review completion",
      "--prompt",
      "Review the run.",
    );

    const recorded = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "done",
        summary: "Goal is done.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );

    const attempt = new Harness(dbPath).getAttempt(recorded.attemptId)!;

    expect(attempt.output.runDecision).toBe("complete");
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
      '{"modelDefaults":{"roles":{"worker":{"model":"gpt-5.4-mini","base_url":"https://api.example.test/v1","env_key":"OPENAI_API_KEY"}}},"agentDefaults":{"global":"claude-code"},"agentBackends":{"claude-code":{"kind":"acpx","agent":"claude","approval":"approve-all"}}}',
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
    const promptCall = loggedCalls.find(
      (args: string[]) => args.includes("claude") && args.includes("exec") && args.includes("-f"),
    );

    expect(result.rounds[0].tasks[0].taskId).toBe(task.id);
    expect(result.rounds[0].tasks[0].status).toBe("done");
    expect(promptCall).toContain("--approve-all");
    expect(promptCall).toContain("claude");
    expect(promptCall).toContain("-");
    expect(promptCall).not.toContain("--model");
    expect(promptCall).not.toContain("gpt-5.4-mini");
    expect(attempt.input.backend).toMatchObject({
      id: "claude-code",
      kind: "acpx",
      agent: "claude",
      approval: "approve-all",
      source: "run-default",
    });
    expect(attempt.input.model).toBeNull();
    expect(attempt.input.executor).toBe("acpx");
    expect(attempt.output.summary).toBe("claude selected");
    expect(
      new Harness(dbPath)
        .listAttemptEvents(attemptId)
        .some(
          (event) =>
            event.stream === "system" &&
            event.payload.type === "acpx.attempt.started" &&
            event.payload.idleTimeoutMs === 300000,
        ),
    ).toBe(true);
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

  test("run-loop restores a maxed blocked goal review with labeled textual completion", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Finish intake workflow");
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
        summary: "Latest verification passed. Decision: complete.",
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

  test("run-loop restores a blocked run when a goal review has labeled textual completion", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Finish blocked intake workflow");
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
        summary: "Latest verification passed. Decision: complete.",
        problems: ["goal-review output must include runDecision"],
      }),
    );
    await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({ type: "retireRun", runId: run.id, reason: "simulate maxed blocked review" }),
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

  test("run-loop blocks a run after too many non-terminal goal reviews", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Bootstrap ouroboros");
    for (const summary of ["more work remains", "still incomplete", "needs another repair"]) {
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
        JSON.stringify({ status: "done", runDecision: "continue", summary, nextTasks: [] }),
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
    expect(overview.run.status).toBe("blocked");
    expect(overview.tasks.filter((task: { role: string }) => task.role === "goal-review")).toHaveLength(3);
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

  test("run-loop creates a fresh goal review after newer work supersedes maxed non-terminal reviews", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Harden supervisor pause handling");
    const staleReviewIds: string[] = [];
    for (const summary of ["continue after first review", "verify remaining repair", "continue after verifier"]) {
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
      staleReviewIds.push(review.id);
      await runCliJson(
        "record-attempt",
        "--task-id",
        review.id,
        "--input-json",
        "{}",
        "--output-json",
        JSON.stringify({
          status: "done",
          runDecision: summary.startsWith("verify") ? "verify" : "continue",
          summary,
          nextTasks: [{ role: "worker", goal: "Historical task", prompt: "Already handled." }],
        }),
      );
    }
    const newerVerifier = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Verify repaired supervisor pause handling",
      "--prompt",
      "Verify.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      newerVerifier.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"done","summary":"newer verifier passed","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
    );
    const codexBin = join(dir, "fake-codex-fresh-review-after-non-terminal");
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
      (task: { role: string; id: string }) => task.role === "goal-review" && !staleReviewIds.includes(task.id),
    );

    expect(result.rounds[0].tasks[0].taskId).toBe(freshReview!.id);
    expect(freshReview).toMatchObject({
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

  test("proposes and accepts repeated lesson guardrails", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Promote repeated lessons",
      "--context-json",
      '{"guardrails":[{"id":"guardrail_existing","summary":"Preserve existing accepted guardrails.","source":"manual"}]}',
    );
    const lessonSummary =
      "running attempt is missing codexSessionId; task was returned to todo for a fresh attempt";
    const first = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "First blocked attempt",
      "--prompt",
      "Block with repeated lesson.",
    );
    const second = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Second blocked attempt",
      "--prompt",
      "Block with repeated lesson again.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      first.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({ status: "blocked", summary: "Blocked", problems: [lessonSummary] }),
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      second.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({ status: "blocked", summary: "Blocked", problems: [`${lessonSummary}.`] }),
    );

    const proposalResult = await runCliJson("propose-guardrails", "--run-id", run.id);
    const overviewAfterProposal = await runCliJson("run-overview", "--run-id", run.id);
    const proposal = proposalResult.proposals[0];

    expect(proposalResult).toMatchObject({ runId: run.id, proposed: 1 });
    expect(proposal).toMatchObject({
      summary: lessonSummary,
      count: 2,
      roles: ["*"],
      source: "lesson",
      active: false,
      accepted: false,
    });
    expect(proposal.sourceLessonIds).toHaveLength(2);
    expect(proposal.sourceAttemptIds).toHaveLength(2);
    expect(overviewAfterProposal.run.context.guardrailProposals).toEqual([expect.objectContaining({
      id: proposal.id,
      accepted: false,
      active: false,
    })]);

    const accepted = await runCliJson(
      "accept-guardrail",
      "--run-id",
      run.id,
      "--proposal-id",
      proposal.id,
      "--accepted-by",
      "goal-review",
    );
    const promptTask = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Use accepted guardrail",
      "--prompt",
      "Render the prompt.",
    );
    const overviewAfterAccept = await runCliJson("run-overview", "--run-id", run.id);
    const prompt = await runCli("show-task-prompt", "--task-id", promptTask.id);

    expect(accepted.guardrail).toMatchObject({
      id: proposal.id,
      summary: lessonSummary,
      source: "lesson",
      active: true,
      accepted: true,
      acceptedBy: "goal-review",
    });
    expect(overviewAfterAccept.run.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_existing" }),
      expect.objectContaining({ id: proposal.id, active: true, accepted: true }),
    ]);
    expect(overviewAfterAccept.run.context.guardrailProposals[0]).toMatchObject({
      id: proposal.id,
      active: false,
      accepted: true,
    });
    expect(prompt.indexOf("## Active Guardrails")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("## Active Guardrails")).toBeLessThan(prompt.indexOf("## Candidate Guardrails"));
    expect(prompt).toContain(`${proposal.id}: ${lessonSummary} (source: lesson)`);
  });

  test("record-attempt refreshes guardrail proposals when goal-review completes", async () => {
    await runCli("init");
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Refresh proposals from CLI goal-review drain",
      "--context-json",
      JSON.stringify({
        guardrails: [
          {
            id: "guardrail_manual",
            summary: "Preserve manually accepted guardrails.",
            source: "manual",
            active: true,
            accepted: true,
            acceptedBy: "manual",
            acceptedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const lessonSummary = "record-attempt CLI must refresh repeated lesson proposals during goal-review drain";
    const firstWorker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "First blocked worker",
      "--prompt",
      "Block with a repeated lesson.",
    );
    const secondWorker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Second blocked worker",
      "--prompt",
      "Block with the same repeated lesson.",
    );
    const successWorker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Successful worker",
      "--prompt",
      "Record a reusable experience.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      firstWorker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({ status: "blocked", summary: "Blocked", problems: [lessonSummary] }),
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      secondWorker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({ status: "blocked", summary: "Blocked", problems: [`${lessonSummary}.`] }),
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      successWorker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Reusable experience should not be promoted into a guardrail.",
        changedFiles: [],
        checks: [{ name: "experience", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review run completion",
      "--prompt",
      "Decide whether the goal is complete.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "continue",
        summary: "Need another pass with a follow-up worker.",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );

    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const proposals = (overview.run.context.guardrailProposals ?? []) as Array<Record<string, unknown>>;
    const proposal = proposals[0];

    expect(overview.run.status).toBe("todo");
    expect(overview.run.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_manual", active: true, accepted: true }),
    ]);
    expect(proposal).toMatchObject({
      summary: lessonSummary,
      count: 2,
      source: "lesson",
      active: false,
      accepted: false,
    });
    const proposalSummaries = proposals.map((entry) => entry.summary);
    expect(proposalSummaries).not.toContain("Reusable experience should not be promoted into a guardrail.");
  });

  test("formatRunEvidence prints a terminal summary seeded with a goal-review attempt", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-evidence summary");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      worker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        changedFiles: ["packages/cli/src/run-evidence.ts"],
        checks: [{ name: "typecheck", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review run completion",
      "--prompt",
      "Decide whether the goal is complete.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "complete",
        summary: "Goal reached; checks and files cite the change.",
        changedFiles: [],
        checks: [
          { name: "typecheck", status: "passed", evidence: "bun run typecheck" },
        ],
        artifacts: [
          { kind: "goal_review", runDecision: "complete", taskId: review.id },
          {
            kind: "verifier_contract",
            summary: "Worker output satisfies the task goal.",
            path: "packages/cli/src/run-evidence.ts",
          },
        ],
        problems: [],
      }),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain(`Run ${run.id}`);
    expect(summary).toContain("Status: done");
    expect(summary).toContain("Latest goal-review decision");
    expect(summary).toContain("decision: complete");
    expect(summary).toContain(`task: ${review.id}`);
    expect(summary).toMatch(/cited evidence:/);
    expect(summary).toContain("[check]");
    expect(summary).toContain("typecheck");
    expect(summary).toContain("[artifact:verifier_contract]");
    expect(summary).toContain("packages/cli/src/run-evidence.ts");
    expect(summary).toContain("Changed files");
  });

  test("run-evidence CLI prints the human-readable summary for a seeded run", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-evidence CLI output");
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review run completion",
      "--prompt",
      "Decide whether the goal is complete.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "complete",
        summary: "Goal reached.",
        checks: [{ name: "smoke", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );

    const stdout = await runCli("run-evidence", "--run-id", run.id);

    expect(stdout).toContain(`Run ${run.id}`);
    expect(stdout).toContain("Status: done");
    expect(stdout).toContain("decision: complete");
    expect(stdout).toContain("[check]");
  });

  test("run-evidence CLI fails with a helpful message when the run is missing", async () => {
    await runCli("init");
    const result = await runCliRaw("run-evidence", "--run-id", "run_missing");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("run not found: run_missing");
  });

  test("formatRunEvidence surfaces verifier and harness-action evidence in the Run evidence section", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-evidence evidence section");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      worker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        changedFiles: ["packages/cli/src/run-evidence.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );
    const verifier = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Verify the increment",
      "--prompt",
      "Check the worker output.",
      "--depends-on",
      worker.id,
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      verifier.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Worker output satisfies the task scope.",
        changedFiles: [],
        checks: [
          { name: "typecheck", status: "passed", evidence: "bun run typecheck" },
          { name: "unit tests", status: "passed" },
        ],
        artifacts: [
          {
            kind: "harness_action_event",
            actionEventId: "action_seed",
            actionType: "integrateVerifiedRun",
          },
        ],
        problems: [],
      }),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("Run evidence (");
    expect(summary).toContain(`[verifier:done] task ${verifier.id} · verifier done · 2 checks · 2 passed`);
    expect(summary).toContain("Worker output satisfies the task scope.");
    expect(summary).toContain("[verifier:harness_action_event]");
    expect(summary).toContain("integrateVerifiedRun");
    expect(summary).toContain("Changed files");
  });

  test("formatRunEvidence reports Run evidence as none when run has no verifier or harness artifacts", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate empty evidence section");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      worker.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        changedFiles: ["README.md"],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("Run evidence: (none recorded)");
    expect(summary).toContain("Latest goal-review decision: (none recorded)");
    expect(summary).toContain("Changed files (1)");
    expect(summary).toContain("README.md");
  });

  test("formatRunEvidence throws when the run is missing", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: "run_missing", eventLimit: 25 });

    expect(() => formatRunEvidence(overview)).toThrow("run not found");
  });

  test("overseer diagnosis surfaces draining state when a running attempt exists", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Draining overseer run");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Run work",
      "--prompt",
      "Keep working.",
    );
    const attemptId = new Harness(dbPath).startAttempt({ taskId: worker.id, input: {} });
    new Harness(dbPath).upsertExecutionThread({
      runId: run.id,
      taskId: worker.id,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "task-draining",
      agentSessionId: "codex_draining",
    });

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("Overseer diagnosis");
    expect(summary).toContain("state: draining");
    expect(summary).toContain("running attempts:");
    expect(summary).toContain(`attempt ${attemptId}`);
    expect(summary).toContain(`task ${worker.id}`);
  });

  test("overseer diagnosis surfaces waiting and queue starvation signals for ready work", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Waiting overseer run");
    await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Queued work",
      "--prompt",
      "Wait for a runner.",
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("state: orphaned");
    expect(summary).toContain("reason: ready work has no live runner");
    expect(summary).toContain("queue starvation: ready tasks exist without a live runner");
    expect(summary).toContain(`active work: ready 1 · running 0`);
  });

  test("overseer diagnosis surfaces blocked state when only blocked work remains", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Blocked overseer run");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Blocked work",
      "--prompt",
      "Cannot proceed.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "blocked",
        summary: "Stuck on missing dependency.",
        problems: ["missing dependency"],
      }),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("state: blocked");
    expect(summary).toContain("only blocked work remains");
  });

  test("overseer diagnosis surfaces complete state once the run is done", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Complete overseer run");
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review completion",
      "--prompt",
      "Decide completion.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "complete",
        summary: "Goal reached.",
      }),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 25 });
    const summary = formatRunEvidence(overview);

    expect(summary).toContain("state: complete");
    expect(summary).toContain("run status is done");
  });

  test("formatAttemptExplanation prints a categorized attempt summary", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate explain-attempt formatter");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    const result = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      JSON.stringify({
        route: { executionMode: "codex-resumable", backend: { kind: "codex-resumable" } },
        model: { model: "gpt-5.5" },
        codexSessionId: "session_explain_1",
      }),
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        changedFiles: ["packages/cli/src/explain-attempt.ts"],
        checks: [{ name: "typecheck", status: "passed" }],
        artifacts: [],
        problems: ["API rate limit hit"],
      }),
    );

    const harness = new Harness(dbPath);
    const attempt = harness.getAttempt(result.attemptId);
    const summary = formatAttemptExplanation(attempt, {
      role: "worker",
      stdout: [
        "[client] initialize (running)",
        "[client] session/new (running)",
        "[thinking] Considering the next step",
        "[tool] edited packages/cli/src/explain-attempt.ts",
        "[error] RUNTIME: Internal error: API Error: 529 Overloaded",
        "unstructured stdout line",
      ].join("\n"),
    });

    expect(summary).toContain(`Attempt ${result.attemptId}`);
    expect(summary).toContain(`Task: ${task.id}`);
    expect(summary).toContain("Role: worker");
    expect(summary).toContain("Status: done");
    expect(summary).toContain("Model: gpt-5.5");
    expect(summary).toContain("Route: codex-resumable");
    expect(summary).toContain("Codex session: session_explain_1");
    expect(summary).toContain("Events (6)");
    expect(summary).toContain("client:");
    expect(summary).toContain("[client] initialize (running)");
    expect(summary).toContain("[client] session/new (running)");
    expect(summary).toContain("thinking:");
    expect(summary).toContain("[thinking] Considering the next step");
    expect(summary).toContain("tool:");
    expect(summary).toContain("[tool] edited packages/cli/src/explain-attempt.ts");
    expect(summary).toContain("other:");
    expect(summary).toContain("unstructured stdout line");
    expect(summary).toContain("Errors and warnings (2)");
    expect(summary).toContain("[error] RUNTIME: Internal error: API Error: 529 Overloaded");
    expect(summary).toContain("API rate limit hit");
    expect(summary).toContain("Summary");
    expect(summary).toContain("Increment shipped");
  });

  test("formatAttemptExplanation categorizes recorded attempt events into the events section", () => {
    const summary = formatAttemptExplanation(
      {
        id: "attempt_synthetic_events",
        taskId: "task_synthetic_events",
        status: "done",
        input: { route: { executionMode: "codex-resumable" }, model: { model: "gpt-5.5" } },
        output: { status: "done", summary: "Synthetic done" },
        checks: [],
        artifacts: [],
        error: null,
      },
      {
        role: "worker",
        events: [
          {
            id: "event_1",
            attemptId: "attempt_synthetic_events",
            sequence: 1,
            stream: "stdout",
            text: "[client] initialize (running)",
            payload: {},
            createdAt: "2026-06-19T00:00:00.000Z",
          },
          {
            id: "event_2",
            attemptId: "attempt_synthetic_events",
            sequence: 2,
            stream: "stdout",
            text: "[error] RUNTIME: Internal error: API Error: 529 Overloaded",
            payload: {},
            createdAt: "2026-06-19T00:00:01.000Z",
          },
          {
            id: "event_3",
            attemptId: "attempt_synthetic_events",
            sequence: 3,
            stream: "stderr",
            text: "child process failed",
            payload: {},
            createdAt: "2026-06-19T00:00:02.000Z",
          },
          {
            id: "event_4",
            attemptId: "attempt_synthetic_events",
            sequence: 4,
            stream: "codex-json",
            text: "{\"type\":\"message\"}",
            payload: {},
            createdAt: "2026-06-19T00:00:03.000Z",
          },
        ],
      },
    );

    expect(summary).toContain("Events (3)");
    expect(summary).toContain("[client] initialize (running)");
    expect(summary).toContain("[error] RUNTIME: Internal error: API Error: 529 Overloaded");
    expect(summary).toContain("Errors and warnings (2)");
    expect(summary).toContain("[error] child process failed");
    expect(summary).not.toContain("message");
  });

  test("formatAttemptExplanation treats missing stdout as an empty events section", () => {
    const summary = formatAttemptExplanation(
      {
        id: "attempt_synthetic_1",
        taskId: "task_synthetic_1",
        status: "done",
        input: {},
        output: { status: "done", summary: "Synthetic done" },
        checks: [],
        artifacts: [],
        error: null,
      },
      { role: "verifier" },
    );

    expect(summary).toContain("Attempt attempt_synthetic_1");
    expect(summary).toContain("Task: task_synthetic_1");
    expect(summary).toContain("Role: verifier");
    expect(summary).toContain("Status: done");
    expect(summary).toContain("Events: (none captured)");
    expect(summary).toContain("Errors and warnings: (none)");
    expect(summary).toContain("Summary");
    expect(summary).toContain("Synthetic done");
  });

  test("formatAttemptExplanation throws when the attempt is missing", () => {
    expect(() => formatAttemptExplanation(null)).toThrow("attempt not found");
  });

  test("explain-attempt CLI prints the categorized summary for a real attempt using --stdout", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate explain-attempt CLI");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    const result = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      JSON.stringify({
        route: { executionMode: "codex-resumable" },
        model: { model: "gpt-5.5" },
      }),
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );

    const stdout = await runCli(
      "explain-attempt",
      "--attempt-id",
      result.attemptId,
      "--stdout",
      "[client] initialize (running)\n[error] API Error: 529",
    );

    expect(stdout).toContain(`Attempt ${result.attemptId}`);
    expect(stdout).toContain(`Task: ${task.id}`);
    expect(stdout).toContain("Role: worker");
    expect(stdout).toContain("Status: done");
    expect(stdout).toContain("Model: gpt-5.5");
    expect(stdout).toContain("Route: codex-resumable");
    expect(stdout).toContain("Events (2)");
    expect(stdout).toContain("[client] initialize (running)");
    expect(stdout).toContain("Errors and warnings (1)");
    expect(stdout).toContain("[error] API Error: 529");
    expect(stdout).toContain("Increment shipped");
  });

  test("explain-attempt CLI replays recorded attempt_events when --stdout is omitted", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate explain-attempt replay");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    const result = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      JSON.stringify({
        route: { executionMode: "codex-resumable" },
        model: { model: "gpt-5.5" },
        codexSessionId: "session_replay_1",
      }),
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Increment shipped",
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );

    const harness = new Harness(dbPath);
    harness.recordAttemptEvent({
      attemptId: result.attemptId,
      sequence: 1,
      stream: "stdout",
      text: "[client] initialize (running)",
    });
    harness.recordAttemptEvent({
      attemptId: result.attemptId,
      sequence: 2,
      stream: "stdout",
      text: "[thinking] Considering the next step",
    });
    harness.recordAttemptEvent({
      attemptId: result.attemptId,
      sequence: 3,
      stream: "stdout",
      text: "[error] API Error: 529 Overloaded",
    });
    harness.recordAttemptEvent({
      attemptId: result.attemptId,
      sequence: 4,
      stream: "stderr",
      text: "child process exited",
    });
    harness.recordAttemptEvent({
      attemptId: result.attemptId,
      sequence: 5,
      stream: "codex-json",
      text: '{"type":"message","role":"assistant"}',
    });

    const stdout = await runCli("explain-attempt", "--attempt-id", result.attemptId);

    expect(stdout).toContain(`Attempt ${result.attemptId}`);
    expect(stdout).toContain(`Task: ${task.id}`);
    expect(stdout).toContain("Role: worker");
    expect(stdout).toContain("Status: done");
    expect(stdout).toContain("Model: gpt-5.5");
    expect(stdout).toContain("Route: codex-resumable");
    expect(stdout).toContain("Codex session: session_replay_1");
    expect(stdout).toContain("Events (4)");
    expect(stdout).toContain("[client] initialize (running)");
    expect(stdout).toContain("[thinking] Considering the next step");
    expect(stdout).toContain("[error] API Error: 529 Overloaded");
    expect(stdout).toContain("Errors and warnings (2)");
    expect(stdout).toContain("[error] child process exited");
    expect(stdout).not.toContain("assistant");
    expect(stdout).toContain("Increment shipped");
  });

  test("explain-attempt CLI reports no captured events when the attempt has no recorded events", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate explain-attempt empty");
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement increment",
      "--prompt",
      "Make a small change.",
    );
    const result = await runCliJson(
      "record-attempt",
      "--task-id",
      task.id,
      "--input-json",
      JSON.stringify({}),
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "No output captured",
        checks: [],
        artifacts: [],
        problems: [],
      }),
    );

    const stdout = await runCli("explain-attempt", "--attempt-id", result.attemptId);

    expect(stdout).toContain("Events: (none captured)");
    expect(stdout).toContain("Errors and warnings: (none)");
    expect(stdout).toContain("No output captured");
  });

  test("explain-attempt CLI fails with a helpful message when the attempt is missing", async () => {
    await runCli("init");
    const result = await runCliRaw("explain-attempt", "--attempt-id", "attempt_missing");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("attempt not found: attempt_missing");
  });

  test("formatRunGraph prints a compact task graph seeded with planner, workers, verifier, and repair", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-graph formatter");
    const planner = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "planner",
      "--goal",
      "Plan the increment",
      "--prompt",
      "Plan the next slice.",
    );
    const workerA = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement worker A",
      "--prompt",
      "Do work A.",
    );
    const workerB = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement worker B",
      "--prompt",
      "Do work B.",
      "--depends-on-json",
      JSON.stringify([planner.id]),
    );
    const verifier = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Verify worker A output",
      "--prompt",
      "Validate worker A.",
      "--depends-on-json",
      JSON.stringify([workerA.id]),
    );
    const repair = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Repair verifier finding",
      "--prompt",
      "Fix the verifier finding.",
      "--depends-on-json",
      JSON.stringify([verifier.id]),
    );

    const harness = new Harness(dbPath);
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
    const summary = formatRunGraph(overview);

    expect(summary).toContain(`Run ${run.id}`);
    expect(summary).toContain(overview.run?.status ?? "");
    expect(summary).toContain("Goal: Validate run-graph formatter");
    expect(summary).toContain(shortTaskId(planner.id));
    expect(summary).toContain(shortTaskId(workerA.id));
    expect(summary).toContain(shortTaskId(workerB.id));
    expect(summary).toContain(shortTaskId(verifier.id));
    expect(summary).toContain(shortTaskId(repair.id));
    expect(summary).toContain(`deps=${shortTaskId(workerA.id)}`);
    expect(summary).toMatch(/Counts:.*todo:5/);
  });

  test("run-graph CLI prints a compact task graph for a seeded run", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-graph CLI output");
    const worker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Implement worker slice",
      "--prompt",
      "Do the work.",
    );

    const stdout = await runCli("run-graph", "--run-id", run.id);

    expect(stdout).toContain(`Run ${run.id}`);
    expect(stdout).toContain("Validate run-graph CLI output");
    expect(stdout).toContain(shortTaskId(worker.id));
    expect(stdout).toContain("worker");
    expect(stdout).toMatch(/Counts:/);
  });

  test("run-graph CLI fails with a helpful message when the run is missing", async () => {
    await runCli("init");
    const result = await runCliRaw("run-graph", "--run-id", "run_missing");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("run not found: run_missing");
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

  test("CLI smoke: integrateVerifiedRun records a done action event on a clean temporary repository", async () => {
    await runCli("init");
    const { repoPath, worktreePath, run, workerTask } = await prepareVerifiedIntegrationRepo({
      branch: "task-worker",
      workerFile: "src/app.ts",
      workerContent: "export const value = 1;\n",
    });

    const result = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: workerTask.id,
        commitMessage: "Integrate verified worker",
        reason: "CLI smoke for integrateVerifiedRun success",
      }),
    );
    const events = await runCliJson("action-events", "--limit", "1");
    const mergedFile = await readFile(join(repoPath, "src", "app.ts"), "utf8");
    const log = gitCli(repoPath, ["log", "--oneline", "-1"]).stdout;

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        workerTaskId: workerTask.id,
        targetBranch: "main",
        sourceBranch: "task-worker",
        pushed: false,
      }),
    );
    expect(mergedFile.trim()).toBe("export const value = 1;");
    expect(log).toContain("Integrate verified worker");
    expect(events[0]).toMatchObject({
      id: result.eventId,
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ runId: run.id, workerTaskId: workerTask.id }),
    });
    expect(worktreePath).toBe(worktreePath);
  });

  test("CLI smoke: integrateVerifiedRun treats an already-merged worker as an idempotent integration via the CLI", async () => {
    await runCli("init");
    const { repoPath, run, workerTask } = await prepareVerifiedIntegrationRepo({
      branch: "task-worker-idempotent",
      workerFile: "src/idempotent.ts",
      workerContent: "export const merged = true;\n",
    });

    const first = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: workerTask.id,
        commitMessage: "Integrate verified idempotent worker",
        reason: "first integration",
      }),
    );
    const headAfterFirst = gitCli(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

    const second = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: workerTask.id,
        commitMessage: "Integrate verified idempotent worker again",
        reason: "retry after interrupted integration bookkeeping",
      }),
    );
    const headAfterSecond = gitCli(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const events = await runCliJson("action-events", "--limit", "2");

    expect(first.status).toBe("done");
    expect(second).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("already integrated"),
    });
    expect(second.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        workerTaskId: workerTask.id,
        alreadyMerged: true,
      }),
    );
    expect(headAfterSecond).toBe(headAfterFirst);
    expect(events[0]).toMatchObject({
      id: second.eventId,
      actionType: "integrateVerifiedRun",
      status: "done",
    });
  });

  test("CLI smoke: integrateVerifiedRun blocks via the CLI when the target repository has uncommitted changes", async () => {
    await runCli("init");
    const { repoPath, run, workerTask } = await prepareVerifiedIntegrationRepo({
      branch: "task-worker-dirty",
      workerFile: "src/dirty.ts",
      workerContent: "export const dirty = true;\n",
    });

    await writeFile(join(repoPath, "uncommitted.txt"), "dirty target\n");

    const result = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: workerTask.id,
        commitMessage: "Should not merge into a dirty target",
        reason: "CLI smoke for blocked git preflight",
      }),
    );
    const events = await runCliJson("action-events", "--limit", "1");

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      eventId: expect.any(String),
      summary: "Target repository has uncommitted changes outside the verified worker output.",
      problems: expect.arrayContaining([expect.stringContaining("unexpected target changes: uncommitted.txt")]),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "integration preflight",
        status: "failed",
        evidence: expect.stringContaining("unexpected target changes: uncommitted.txt"),
      }),
    );
    expect(events[0]).toMatchObject({
      id: result.eventId,
      actionType: "integrateVerifiedRun",
      status: "blocked",
      request: expect.objectContaining({ runId: run.id, workerTaskId: workerTask.id }),
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

  function gitCli(cwd: string, args: string[]) {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode, `git ${args.join(" ")}\n${stderr || stdout}`).toBe(0);
    return { stdout, stderr };
  }

  async function prepareVerifiedIntegrationRepo(input: {
    branch: string;
    workerFile: string;
    workerContent: string;
  }) {
    const repoPath = join(dir, `repo-${input.branch}`);
    const worktreePath = join(dir, `worker-tree-${input.branch}`);
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    gitCli(repoPath, ["init", "-b", "main"]);
    gitCli(repoPath, ["config", "user.name", "Ouroboros Test"]);
    gitCli(repoPath, ["config", "user.email", "test@example.com"]);
    gitCli(repoPath, ["config", "commit.gpgSign", "false"]);
    gitCli(repoPath, ["add", "README.md"]);
    gitCli(repoPath, ["commit", "-m", "Initial commit"]);
    gitCli(repoPath, ["worktree", "add", "-b", input.branch, worktreePath, "main"]);
    const workerDir = join(worktreePath, input.workerFile.split("/").slice(0, -1).join("/"));
    if (workerDir !== worktreePath) {
      await mkdir(workerDir, { recursive: true });
    }
    await writeFile(join(worktreePath, input.workerFile), input.workerContent);

    const run = await runCliJson(
      "create-run",
      "--goal",
      "Integrate verified CLI smoke",
      "--project-root",
      repoPath,
    );
    const workerTaskId = new Harness(dbPath).createTask({
      runId: run.id,
      role: "worker",
      goal: `Implement ${input.workerFile}`,
      prompt: `Create ${input.workerFile}.`,
      worktreePath,
    });
    await runCliJson(
      "record-attempt",
      "--task-id",
      workerTaskId,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: `Created ${input.workerFile}`,
        changedFiles: [input.workerFile],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );
    const verifier = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "verifier",
      "--goal",
      "Verify worker",
      "--prompt",
      "Verify worker changes.",
      "--depends-on-json",
      JSON.stringify([workerTaskId]),
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      verifier.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        summary: "Verified worker changes.",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );
    const review = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "goal-review",
      "--goal",
      "Review completion",
      "--prompt",
      "Review run completion.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      review.id,
      "--input-json",
      "{}",
      "--output-json",
      JSON.stringify({
        status: "done",
        runDecision: "complete",
        summary: "Goal reached",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    );

    return {
      repoPath,
      worktreePath,
      run,
      workerTask: { id: workerTaskId },
      verifier,
      review,
    };
  }

  function shortTaskId(taskId: string) {
    return taskId.length <= 12 ? taskId : taskId.slice(-12);
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
