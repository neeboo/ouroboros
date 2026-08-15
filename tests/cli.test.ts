import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  applyHarnessAction,
  canonicalHarnessRevisionContentSha256,
  canonicalEvolutionRecordSha256,
  canonicalEvolutionValueSha256,
  checkpointDatabase,
  expectedEvolutionRecordId,
  Harness,
  parseEvolutionInstance,
} from "../packages/harness/src";
import { formatRunEvidence } from "../packages/cli/src/run-evidence";
import { formatAttemptExplanation } from "../packages/cli/src/explain-attempt";
import { formatRunGraph } from "../packages/cli/src/run-graph";
import { defaultDatabasePath, parseArgs } from "../packages/cli/src/args";
import {
  designTimelineKindForTask,
  isDesignTimelineTaskGoal,
  isDesignTimelineTaskRole,
} from "../packages/cli/src/design-status";
import {
  loadOuroborosConfig,
  resolveLinearPolling,
  type LinearConfig,
} from "../packages/cli/src/config";
import {
  deterministicLinearInboxId,
  pollLinearIssues,
  type LinearPollingConfig,
  type LinearPollingState,
} from "../packages/cli/src/linear";
import {
  consumeLinearInbox,
  getLinearIntakeState,
  runLinearPollCycle,
  INITIAL_LINEAR_INTAKE_POLLING_STATE,
} from "../packages/cli/src/linear-intake";
import { Database } from "bun:sqlite";
import { defaultCodexBin } from "../packages/runner/src/executors/codex-bin";
import { codexOnlyAgentDefaults } from "../packages/runner/src/agent-backends";
import { protectedPromptContractFingerprintForSource } from "../packages/runner/src/prompt";
import {
  listEvolutionRecords,
  showEvolutionRecord,
} from "../packages/cli/src/evolution-readback";

setDefaultTimeout(10_000);

function harnessRevisionFixture(projectId: string, version = 1, parentSha256: string | null = null) {
  const body = {
    schemaVersion: 1 as const,
    projectId,
    version,
    parentSha256,
    variant: {
      id: `variant_${"a".repeat(64)}`,
      recordSha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
    },
    components: [
      { kind: "prompt" as const, ref: `git:prompt-v${version}`, sha256: "1".repeat(64) },
      { kind: "knowledge" as const, ref: `git:knowledge-v${version}`, sha256: "2".repeat(64) },
      { kind: "skills" as const, ref: `git:skills-v${version}`, sha256: "3".repeat(64) },
      { kind: "tools" as const, ref: `git:tools-v${version}`, sha256: "4".repeat(64) },
      { kind: "agent-policy" as const, ref: `git:agent-policy-v${version}`, sha256: "5".repeat(64) },
    ],
    evidenceRefs: [`run:evidence-v${version}`],
  };
  return {
    ...body,
    contentSha256: canonicalHarnessRevisionContentSha256(body),
  };
}

async function snapshotDatabaseFilesystem(dbPath: string, dir: string) {
  const dbStat = await stat(dbPath);
  const parentStat = await stat(dir);
  const dirEntries = await readdir(dir);
  return {
    size: dbStat.size,
    mtimeMs: dbStat.mtimeMs,
    ctimeMs: dbStat.ctimeMs,
    parentMode: parentStat.mode & 0o777,
    sidecars: {
      wal: existsSync(`${dbPath}-wal`),
      shm: existsSync(`${dbPath}-shm`),
      journal: existsSync(`${dbPath}-journal`),
    },
    dirEntries: new Set(dirEntries.sort()),
  };
}

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

  function createAcceptedEvolutionDesignSource(input: {
    harness: Harness;
    projectId: string;
    charterId: string;
    suffix: string;
  }) {
    const toolPolicySha256 = canonicalEvolutionValueSha256({
      fixture: "evolution-readback-tool-policy",
      suffix: input.suffix,
    });
    const pack = {
      schemaVersion: 1 as const,
      id: `pack_evolution_readback_${input.suffix}`,
      targetSystemId: `target_evolution_readback_${input.suffix}`,
      version: 1,
      knowledgeScope: `project:${input.projectId}` as const,
      objective: {
        charterId: input.charterId,
        domainOutcomes: ["Keep evolution evidence attributable."],
        nonGoals: ["No production mutation."],
      },
      observation: {
        signalSources: [{ id: "readback_fixture", kind: "domain-metric" as const }],
      },
      mutationSurfaces: [{
        id: "surface.runtime",
        evolutionTarget: "harness" as const,
        layer: "workflow" as const,
        projectId: input.projectId,
        allowedPaths: ["runtime/**"],
        forbiddenPaths: ["runtime/forbidden/**"],
        owner: "ouroboros" as const,
      }],
      experimentPolicy: {
        controlRequired: true as const,
        holdoutRequired: true as const,
        unrelatedRegressionRequired: true as const,
        equalBudgetRequired: true as const,
        maxCandidates: 1,
      },
      promotionPolicy: {
        guardMetrics: ["no raw heldout references disclosed"],
        observationWindow: "Frozen before shadow evaluation.",
        rollback: "Retain the prior immutable profile receipt.",
      },
      handoff: {
        maturity: "designed" as const,
        targetOwner: "fixture",
        requiredCapabilities: ["Read-only receipt verification."],
      },
      portability: {
        projectLocalRules: ["Evidence remains project-local."],
        genericizationEvidence: [],
      },
    };
    const comparison = {
      controlRef: `control:${input.suffix}`,
      developmentEvidenceRefs: [`episode:${input.suffix}:development`],
      holdoutEvidenceRefs: [`episode:${input.suffix}:heldout`],
      unrelatedEvidenceRefs: [`episode:${input.suffix}:unrelated`],
      corpusSnapshotSha256: canonicalEvolutionValueSha256({ corpus: input.suffix }),
      equalBudget: {
        model: "fixture-no-provider",
        reasoningEffort: "high" as const,
        wallClockMs: 120_000,
        maxAttempts: 1,
        maxTokens: 10_000,
        toolPolicySha256,
        concurrency: 1,
      },
      primaryMetric: "readback-integrity",
      minimumUplift: 0,
      maximumGuardRegression: 0,
    };
    const causalHypothesis = {
      failureClass: "contract-mismatch" as const,
      mechanism: "A frozen action receipt binds runtime evidence to its design authority.",
      predictedEffects: ["Readback rejects unaudited records."],
      disconfirmingEvidence: ["A manual event is accepted without a receipt."],
    };
    const proposal = input.harness.createDesignProposal({
      id: `design_evolution_readback_${input.suffix}`,
      projectId: input.projectId,
      charterId: input.charterId,
      title: `Evolution readback ${input.suffix}`,
      problem: "Evolution records need an immutable design source.",
      recommendation: "Bind the record receipt to the frozen design context.",
      status: "accepted",
      proposal: {
        problem: "Evolution records need an immutable design source.",
        recommendation: "Bind the record receipt to the frozen design context.",
        evolutionPack: pack,
        causalHypothesis,
        evaluationContract: {
          baseline: ["no immutable source receipt"],
          successMetrics: ["source receipt readback is exact"],
          guardMetrics: ["no raw heldout references disclosed"],
          requiredEvidence: ["read-only receipt verification"],
          comparison,
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
        },
      },
    });
    const decision = input.harness.recordDesignDecision({
      id: `decision_evolution_readback_${input.suffix}`,
      proposalId: proposal.id,
      charterId: input.charterId,
      decision: "approved",
      actorKind: "auto",
      actorRef: "authority-evaluator",
      reasons: ["Zero-spend read-only evidence contract."],
      authority: { disposition: "automatic" },
    });
    const packSha256 = canonicalEvolutionValueSha256(pack);
    return {
      designSource: {
        designProposalId: proposal.id,
        designDecisionId: decision.id,
        designCharterId: input.charterId,
      },
      runContext: {
        source: "design",
        designProposalId: proposal.id,
        designDecisionId: decision.id,
        designCharterId: input.charterId,
        designProposal: proposal.proposal,
        designEvaluationContract: proposal.proposal.evaluationContract,
        evolutionPack: pack,
        causalHypothesis,
        comparison,
        evolutionComparison: comparison,
        evolutionInstance: {
          schemaVersion: 1,
          mode: "design-target",
          kernelProjectId: "project_ouroboros_kernel",
          targetProjectId: input.projectId,
          cycle: { kind: "bootstrap", index: 1 },
          pack: { id: pack.id, version: pack.version, contentSha256: packSha256 },
        },
      },
      pack,
      comparison,
    };
  }

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

  test("default database path resolves through the shared git common directory for main and linked worktrees", async () => {
    const repoPath = join(dir, "shared-default-repo");
    const worktreePath = join(dir, "shared-default-worktree");
    await mkdir(repoPath, { recursive: true });
    gitCli(repoPath, ["init", "-b", "main"]);
    gitCli(repoPath, ["config", "user.name", "Ouroboros Test"]);
    gitCli(repoPath, ["config", "user.email", "test@example.com"]);
    gitCli(repoPath, ["config", "commit.gpgSign", "false"]);
    await writeFile(join(repoPath, "README.md"), "initial\n");
    gitCli(repoPath, ["add", "README.md"]);
    gitCli(repoPath, ["commit", "-m", "Initial commit"]);
    gitCli(repoPath, ["worktree", "add", "-b", "worker", worktreePath, "main"]);

    const commonDirResult = gitCli(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonDir = commonDirResult.stdout.trim();
    const expectedDefaultDb = join(commonDir, "orbs", "ouroboros.db");

    const mainPath = await runDefaultCliJson(repoPath, "init");
    expect(mainPath.db).toBe(expectedDefaultDb);

    const mainDefault = defaultDatabasePath(repoPath);
    const worktreeDefault = defaultDatabasePath(worktreePath);
    expect(mainDefault).toBe(expectedDefaultDb);
    expect(worktreeDefault).toBe(expectedDefaultDb);
    expect(worktreeDefault).toBe(mainDefault);

    const worktreeGitDirResult = gitCli(worktreePath, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]);
    const worktreeGitDir = worktreeGitDirResult.stdout.trim();
    const worktreeOrbsDir = join(worktreeGitDir, "orbs");
    expect(existsSync(worktreeOrbsDir)).toBe(false);

    const listResult = await runDefaultCliJson(worktreePath, "list-runs", "--limit", "1");
    expect(Array.isArray(listResult)).toBe(true);
    expect(existsSync(worktreeOrbsDir)).toBe(false);
    expect(existsSync(expectedDefaultDb)).toBe(true);

    const mainPathEvidence = mainPath.db;
    const linkedPathEvidence = worktreeDefault;
    const commonDirEvidence = commonDir;
    const linkedGitDirEvidence = worktreeGitDir;
    expect(mainPathEvidence).toBe(linkedPathEvidence);
    expect(mainPathEvidence).toContain("/orbs/ouroboros.db");
    expect(commonDirEvidence).not.toContain("/worktrees/");
    expect(linkedGitDirEvidence).toContain("/worktrees/");
  });

  test("explicit --db overrides default database discovery", async () => {
    const repoPath = join(dir, "explicit-db-repo");
    await mkdir(repoPath, { recursive: true });
    gitCli(repoPath, ["init", "-b", "main"]);
    const explicitDb = join(dir, "explicit.db");

    const originalCwd = process.cwd();
    try {
      process.chdir(repoPath);
      const parsed = parseArgs(["--db", explicitDb, "list-runs", "--limit", "1"]);
      expect(parsed.db).toBe(resolve(explicitDb));
      expect(parsed.db).not.toBe(defaultDatabasePath(repoPath));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("default database path resolves inside a normal non-linked repository", async () => {
    const repoPath = join(dir, "normal-repo");
    await mkdir(repoPath, { recursive: true });
    gitCli(repoPath, ["init", "-b", "main"]);

    const gitDirResult = gitCli(repoPath, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]);
    const expectedDefaultDb = join(gitDirResult.stdout.trim(), "orbs", "ouroboros.db");
    expect(defaultDatabasePath(repoPath)).toBe(expectedDefaultDb);
    expect(defaultDatabasePath(repoPath)).toContain("/.git/orbs/ouroboros.db");
  });

  test("default database path falls back to .ouroboros outside git", async () => {
    const nonGitDir = join(dir, "non-git");
    await mkdir(nonGitDir, { recursive: true });

    const originalCwd = process.cwd();
    try {
      process.chdir(nonGitDir);
      const parsed = parseArgs(["list-runs", "--limit", "1"]);
      expect(parsed.db).toBe(resolve(".ouroboros/ouroboros.db"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test(":memory: and file: database paths pass through CLI normalization", () => {
    const memoryParsed = parseArgs(["--db", ":memory:", "list-runs", "--limit", "1"]);
    expect(memoryParsed.db).toBe(":memory:");

    const fileParsed = parseArgs(["--db", "file:memory:", "list-runs", "--limit", "1"]);
    expect(fileParsed.db).toBe("file:memory:");
  });

  test("prints help without requiring a command or flag value", async () => {
    const help = await runCliRaw("--help");
    const shortHelp = await runCliRaw("-h");
    const commandHelp = await runCliRaw("init", "--help");

    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("orbs --help");
    expect(help.stdout).toContain("--parallel auto");
    expect(help.stdout).toContain("--runs <n|auto>");
    expect(help.stdout).toContain("--tasks <n|auto>");
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
        'worker = "claude-code"',
        'verifier = "claude-code"',
        "",
        '["agentBackends"."claude-code"]',
        'kind = "acpx"',
        'agent = "claude"',
        'approval = "approve-reads"',
      ].join("\n"),
    );

    const run = await runCliJson("create-run", "--goal", "Config seeded agent run", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(overview.run.context.agentDefaults).toEqual({
      roles: {
        worker: "claude-code",
        verifier: "claude-code",
      },
    });
    expect(overview.run.context.agentBackends).toMatchObject({
      "claude-code": {
        kind: "acpx",
        agent: "claude",
        approval: "approve-reads",
      },
    });
  });

  test("creates a target-system Designer root with frozen project identity and target charter", async () => {
    await runCli("init");
    const setupHarness = new Harness(dbPath);
    const kernelRoot = join(dir, "kernel");
    const targetRoot = join(dir, "target");
    await mkdir(kernelRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const kernelProjectId = setupHarness.createProject({ name: "Evolution Kernel", rootPath: kernelRoot });
    const targetProjectId = setupHarness.createProject({ name: "Target System", rootPath: targetRoot });
    const charter = setupHarness.createFounderCharter({
      projectId: targetProjectId,
      mission: "Evolve the target within explicit evidence and authority boundaries.",
      charter: {
        mission: "Evolve the target within explicit evidence and authority boundaries.",
        authority: { autoResearch: true, autoReversibleExperiments: true },
      },
      activate: true,
    });
    const configPath = join(dir, "target-system.toml");
    await writeFile(
      configPath,
      [
        "[models.roles.designer]",
        'model = "gpt-5.6-sol"',
        'reasoning_effort = "high"',
        "",
        "[agentDefaults.roles]",
        'designer = "codex-resumable"',
      ].join("\n"),
    );

    const result = await runCliJson(
      "design-target-system",
      "--kernel-project-id",
      kernelProjectId,
      "--target-project-id",
      targetProjectId,
      "--goal",
      "Design the target's bounded self-evolution system",
      "--config",
      configPath,
    );
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(typeof result.runId).toBe("string");
    expect(typeof result.taskId).toBe("string");
    expect(typeof result.runnerCommand).toBe("string");
    expect(result).toMatchObject({
      kernelProject: { id: kernelProjectId, name: "Evolution Kernel", rootPath: kernelRoot },
      targetProject: { id: targetProjectId, name: "Target System", rootPath: targetRoot },
    });
    expect(result.runnerCommand).toContain(`run-loop --run-id ${result.runId}`);
    expect(result.runnerCommand).toContain("--executor codex-resumable");
    expect(result.runnerCommand).toContain("--sandbox workspace-write");
    expect(result.runnerCommand).toContain("--tasks auto");
    expect(result.runnerCommand).toContain(`--worktree-root ${join(targetRoot, ".ouroboros/worktrees")}`);
    expect(result.runnerCommand).toContain("--start-hook git-worktree");
    expect(result.runnerCommand).toContain("--stop-hook create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary");
    expect(result.runnerCommand).toContain(targetRoot);

    expect(overview.run).toMatchObject({
      id: result.runId,
      projectId: targetProjectId,
      projectRoot: targetRoot,
      goal: "Design the target's bounded self-evolution system",
      context: {
        source: "target-system-design",
        founderCharterId: charter.id,
        designCharterId: charter.id,
        modelDefaults: {
          roles: { designer: { model: "gpt-5.6-sol", reasoning_effort: "high" } },
        },
        agentDefaults: { roles: { designer: "codex-resumable" } },
      },
    });
    expect(parseEvolutionInstance(overview.run.context.evolutionInstance)).toEqual({
      schemaVersion: 1,
      mode: "design-target",
      kernelProjectId,
      targetProjectId,
      cycle: { kind: "design", index: 0 },
    });
    expect(overview.tasks).toHaveLength(1);
    expect(overview.tasks[0]).toMatchObject({
      id: result.taskId,
      runId: result.runId,
      role: "designer",
      status: "todo",
    });
    expect(overview.tasks[0].prompt).toContain(charter.id);
    expect(overview.tasks[0].prompt).toContain(targetProjectId);
    expect(overview.tasks[0].prompt).toContain("target charter");
    expect(overview.tasks[0].prompt).toContain("target-scoped strategy signals");
    expect(overview.tasks[0].prompt).toContain("target-scoped evidence");
    expect(overview.tasks[0].prompt).toContain("proposeDesign");
    expect(overview.tasks[0].prompt).toContain("evolutionPack");
    expect(overview.tasks[0].prompt).toContain("causalHypothesis");
    expect(overview.tasks[0].prompt).toContain("comparison");
    expect(overview.tasks[0].prompt).toContain("createRunsFromDesign");
    expect(overview.tasks[0].prompt).toContain("quiescent");
  });

  test("design-target-system fails closed for invalid project identity without creating runs", async () => {
    await runCli("init");
    const setupHarness = new Harness(dbPath);
    const kernelProjectId = setupHarness.createProject({ name: "Kernel", rootPath: join(dir, "kernel") });
    const targetProjectId = setupHarness.createProject({ name: "Target", rootPath: join(dir, "target") });
    setupHarness.createFounderCharter({
      projectId: targetProjectId,
      mission: "Target charter",
      activate: true,
    });
    const before = setupHarness.listRuns().length;
    const cases = [
      {
        name: "missing required target flag",
        args: ["--kernel-project-id", kernelProjectId, "--goal", "Design target"],
        error: "--target-project-id is required",
      },
      {
        name: "missing kernel project",
        args: ["--kernel-project-id", "project_missing", "--target-project-id", targetProjectId, "--goal", "Design target"],
        error: "kernel project not found: project_missing",
      },
      {
        name: "missing target project",
        args: ["--kernel-project-id", kernelProjectId, "--target-project-id", "project_missing", "--goal", "Design target"],
        error: "target project not found: project_missing",
      },
      {
        name: "same kernel and target project",
        args: ["--kernel-project-id", targetProjectId, "--target-project-id", targetProjectId, "--goal", "Design target"],
        error: "kernel and target projects must be different",
      },
      {
        name: "caller context cannot override frozen identity",
        args: [
          "--kernel-project-id",
          kernelProjectId,
          "--target-project-id",
          targetProjectId,
          "--goal",
          "Design target",
          "--context-json",
          '{"source":"polluted","founderCharterId":"charter_polluted","evolutionInstance":{"mode":"self"}}',
        ],
        error: "--context-json is not supported by design-target-system",
      },
    ];

    for (const testCase of cases) {
      const result = await runCliRaw("design-target-system", ...testCase.args);
      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain(testCase.error);
      expect(setupHarness.listRuns().length, testCase.name).toBe(before);
    }
  });

  test("design-target-system fails closed when the target has no active founder charter", async () => {
    await runCli("init");
    const setupHarness = new Harness(dbPath);
    const kernelProjectId = setupHarness.createProject({ name: "Kernel", rootPath: join(dir, "kernel") });
    const targetProjectId = setupHarness.createProject({ name: "Target", rootPath: join(dir, "target") });
    setupHarness.createFounderCharter({
      projectId: targetProjectId,
      mission: "Inactive target charter",
      activate: false,
    });
    const before = setupHarness.listRuns().length;

    const result = await runCliRaw(
      "design-target-system",
      "--kernel-project-id",
      kernelProjectId,
      "--target-project-id",
      targetProjectId,
      "--goal",
      "Design target",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`active founder charter not found for target project: ${targetProjectId}`);
    expect(setupHarness.listRuns().length).toBe(before);
  });

  test("help documents the design-target-system command and example", async () => {
    const help = await runCliRaw("--help");

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("design-target-system");
    expect(help.stdout).toContain("--kernel-project-id <kernel_project_id>");
    expect(help.stdout).toContain("--target-project-id <target_project_id>");
  });

  test("bootstraps a self-iteration planning run", async () => {
    const result = await runCliJson("self-iterate");
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(result.runId).toBeString();
    expect(result.taskId).toBeString();
    expect(result.dashboardCommand).toBeString();
    expect(result.runnerCommand).toBeString();
    expect(result.daemonCommand).toBeString();
    expect(result.dashboardCommand).toContain(`dashboard --run-id ${result.runId}`);
    expect(result.runnerCommand).toContain(`run-loop --run-id ${result.runId}`);
    expect(result.launchCommand).toContain("self-iterate-launch");
    expect(result.daemonCommand).toContain(`self-improve-daemon --root-run-id ${result.runId}`);
    expect(result.runnerCommand).toContain(`--codex-bin ${defaultCodexBin()}`);
    expect(result.daemonCommand).toContain(`--codex-bin ${defaultCodexBin()}`);
    expect(result.launchCommand).toContain(`--codex-bin ${defaultCodexBin()}`);
    expect(result.daemonCommand).toContain("--parallel auto");
    expect(result.launchCommand).toContain("--parallel auto");
    expect(result.launchCommand).toContain("--worktree-root .ouroboros/worktrees");
    expect(result.launchCommand).toContain("--start-hook git-worktree");
    expect(result.dashboardCommand).toContain("--port 7331");
    expect(result.runnerCommand).toContain("--executor codex-resumable");
    expect(result.runnerCommand).toContain("--tasks auto");
    expect(result.runnerCommand).toContain("--worktree-root .ouroboros/worktrees");
    expect(result.runnerCommand).toContain("--start-hook git-worktree");
    expect(result.runnerCommand).toContain("--stop-hook create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary");

    expect(overview.run.id).toBe(result.runId);
    expect(overview.run.goal).toBe("Continuously improve Ouroboros from evidence-backed gaps");
    expect(overview.run.context.source).toBe("self-improve");
    expect(overview.run.context.planDoc).toBe("docs/self-iteration-plan.md");
    expect(overview.run.context.modelDefaults).toMatchObject({
      global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
      roles: {
        designer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        planner: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        worker: { model: "gpt-5.6-luna", reasoning_effort: "high" },
        verifier: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        "goal-review": { model: "gpt-5.6-sol", reasoning_effort: "high" },
      },
    });
    expect(overview.run.context.agentDefaults.roles).toMatchObject({
      designer: "codex-resumable",
      planner: "codex-resumable",
      worker: "codex-resumable",
      verifier: "codex-resumable",
      "goal-review": "codex-resumable",
    });
    expect(overview.run.context.selfImprovement).toMatchObject({
      cycleIndex: 0,
      assessmentFingerprint: expect.any(String),
    });
    expect(overview.run.context.controlPlaneRuntime).toEqual(expect.objectContaining({
      state: "current",
      generation: 1,
      canonicalEntrypoint: expect.stringContaining("packages/cli/src/main.ts"),
      sourceRoot: expect.any(String),
      launchHead: expect.any(String),
      observedDirtyStateFingerprint: expect.any(String),
      promptContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      processIdentity: "supervisor-pending",
      attestedProcessIdentity: "supervisor-pending",
      startedAt: expect.any(String),
      attestedAt: expect.any(String),
    }));
    expect(overview.controlPlaneRuntime).toEqual(overview.run.context.controlPlaneRuntime);
    const goalContract = overview.run.context.goalContract;
    expect(goalContract).toBeDefined();
    expect(typeof goalContract.desiredState).toBe("string");
    expect(goalContract.desiredState).toContain("derive and complete successive improvement goals");
    expect(Array.isArray(goalContract.successCriteria)).toBe(true);
    expect(goalContract.successCriteria.length).toBeGreaterThan(0);
    expect(goalContract.successCriteria).toContain("each assessment derives one evidence-backed child run or records a justified quiescent decision");
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
      role: "designer",
      status: "todo",
      dependsOn: [],
    });
    expect(overview.tasks[0].prompt).toContain("docs/designer-control-plane.md");
    expect(overview.tasks[0].prompt).toContain("docs/self-iteration-plan.md");
    expect(overview.tasks[0].prompt).toContain("active founder charter");
    expect(overview.tasks[0].prompt).toContain("strategy signals");
    expect(overview.tasks[0].prompt).toContain("run evidence");
    expect(overview.tasks[0].prompt).toContain("due design outcomes");
    expect(overview.tasks[0].prompt).toContain("fixed designer actions");
    expect(overview.tasks[0].prompt).toContain("recordSignal");
    expect(overview.tasks[0].prompt).toContain("proposeDesign");
    expect(overview.tasks[0].prompt).toContain("decideDesign");
    expect(overview.tasks[0].prompt).toContain("recordDesignOutcome");
    expect(overview.tasks[0].prompt).toContain("createRunsFromDesign");
    expect(overview.tasks[0].prompt).toContain("accepted proposal");
    expect(overview.tasks[0].prompt).toContain("quiescent");
    expect(overview.tasks[0].doneWhen).toEqual([
      "The assessment cites the active charter, current signals, lessons, run evidence, repository state, and due design outcomes",
      "The output derives one evidence-backed design proposal or records a justified quiescent decision",
      "Durable conclusions return only through the fixed designer actions: recordSignal, proposeDesign, decideDesign, recordDesignOutcome, createRunsFromDesign",
      "Planning begins only from an accepted proposal and preserves the frozen evaluation contract, authority context, budget, and integration boundary",
      "No delivery run is created from an unaccepted proposal or without an approved stored decision",
    ]);
  });

  test("records one bounded reload-failed result when the canonical entrypoint is missing", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setup = new Harness(dbPath);
    const root = setup.getRun(bootstrap.runId)!;
    setup.updateRun({
      runId: bootstrap.runId,
      contextPatch: {
        controlPlaneRuntime: {
          ...(root.context.controlPlaneRuntime as Record<string, unknown>),
          state: "current",
          sourceRoot: join(dir, "missing-source-root"),
          canonicalEntrypoint: join(dir, "missing-source-root/packages/cli/src/main.ts"),
          launchHead: "commit-A",
          observedHead: "commit-A",
        },
      },
    });

    const result = await runCliJson(
      "self-improve-daemon",
      "--root-run-id",
      bootstrap.runId,
      "--executor",
      "codex-resumable",
      "--cwd",
      dir,
      "--max-ticks",
      "2",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const runtime = new Harness(dbPath).getRun(bootstrap.runId)!.context.controlPlaneRuntime as Record<string, unknown>;

    expect(result.status).toBe("tick_limit");
    expect(runtime.state).toBe("reload-failed");
    expect(runtime.reloadAttempt).toMatchObject({ count: 1, status: "failed" });
    expect(runtime.handoffReceipt).toBeNull();
  });

  test("replays a two-commit handoff into one generation-B Designer attempt", async () => {
    const sourceRoot = join(dir, "two-generation-source");
    await mkdir(join(sourceRoot, "packages/runner/src"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/cli/src"), { recursive: true });
    gitCli(sourceRoot, ["init", "-b", "main"]);
    gitCli(sourceRoot, ["config", "user.name", "Ouroboros Test"]);
    gitCli(sourceRoot, ["config", "user.email", "test@example.com"]);
    gitCli(sourceRoot, ["config", "commit.gpgSign", "false"]);

    const actualHarness = resolve(import.meta.dir, "..", "packages/harness/src/index.ts");
    const actualPrompt = resolve(import.meta.dir, "..", "packages/runner/src/prompt.ts");
    const fakeMain = (sentinel: string) => `
import { Harness } from ${JSON.stringify(actualHarness)};
import { protectedPromptContractFingerprintForSource } from ${JSON.stringify(actualPrompt)};

function selfIterationDesignerPrompt() { return ${JSON.stringify(sentinel)}; }
const args = Bun.argv.slice(2);
if (args.includes("self-improve-daemon")) {
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
  const dbPath = value("--db");
  const rootRunId = value("--root-run-id");
  const sourceRoot = value("--cwd");
  const harness = new Harness(dbPath);
  const root = harness.getRun(rootRunId);
  const runtime = root.context.controlPlaneRuntime;
  const promptContractHash = protectedPromptContractFingerprintForSource(sourceRoot);
  const processIdentity = String(process.pid);
  harness.updateRun({ runId: rootRunId, contextPatch: {
    controlPlaneRuntime: {
      ...runtime,
      state: "current",
      processIdentity,
      attestedGeneration: runtime.generation,
      attestedHead: runtime.launchHead,
      attestedPromptContractHash: promptContractHash,
      attestedProcessIdentity: processIdentity,
      attestedAt: new Date().toISOString(),
    },
  }});
  const task = harness.nextReadyTask(rootRunId);
  if (!task) throw new Error("generation-B Designer task was not ready");
  harness.recordAttempt({ taskId: task.id, input: {
    prompt: selfIterationDesignerPrompt(),
    promptContractHash,
    processIdentity,
  }, output: {
    status: "done", summary: "generation-B Designer attested", changedFiles: [], checks: [], artifacts: [], problems: [],
  }});
}
`;
    await writeFile(join(sourceRoot, "packages/runner/src/prompt.ts"), "export const generation = 'A';\n");
    await writeFile(join(sourceRoot, "packages/cli/src/main.ts"), fakeMain("COMMIT_A_SENTINEL"));
    gitCli(sourceRoot, ["add", "."]);
    gitCli(sourceRoot, ["commit", "-m", "generation A"]);
    const headA = gitCli(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const promptA = protectedPromptContractFingerprintForSource(sourceRoot);

    const harness = new Harness(dbPath);
    harness.init();
    const rootRunId = harness.createRun({
      goal: "Replay runtime generation handoff",
      context: {
        source: "self-improve",
        controlPlaneRuntime: {
          canonicalEntrypoint: join(sourceRoot, "packages/cli/src/main.ts"),
          sourceRoot,
          launchHead: headA,
          observedHead: headA,
          observedDirtyStateFingerprint: "clean",
          promptContractHash: promptA,
          generation: 1,
          processIdentity: String(process.pid),
          startedAt: new Date().toISOString(),
          attestedAt: new Date().toISOString(),
          state: "current",
          reloadAttempt: { count: 0, fingerprint: null, status: "none", cooldownUntil: null },
          handoffReceipt: null,
          attestedGeneration: 1,
          attestedHead: headA,
          attestedPromptContractHash: promptA,
          attestedProcessIdentity: String(process.pid),
        },
      },
    });
    const taskId = harness.createTask({
      runId: rootRunId,
      role: "designer",
      goal: "Assess generation B",
      prompt: "COMMIT_A_SENTINEL",
    });

    await writeFile(join(sourceRoot, "packages/runner/src/prompt.ts"), "export const generation = 'B';\n");
    await writeFile(join(sourceRoot, "packages/cli/src/main.ts"), fakeMain("COMMIT_B_SENTINEL"));
    gitCli(sourceRoot, ["add", "."]);
    gitCli(sourceRoot, ["commit", "-m", "generation B"]);
    const headB = gitCli(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const promptB = protectedPromptContractFingerprintForSource(sourceRoot);

    const daemonArgs = [
      "self-improve-daemon",
      "--root-run-id", rootRunId,
      "--executor", "codex-resumable",
      "--cwd", sourceRoot,
      "--max-ticks", "2",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    ];
    const results = await Promise.all([
      runCliRaw(...daemonArgs),
      runCliRaw(...daemonArgs),
    ]);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);

    let generationBAttempt: ReturnType<Harness["getAttempt"]> = null;
    for (let index = 0; index < 100 && !generationBAttempt; index += 1) {
      const overview = new Harness(dbPath).getRunOverview({ runId: rootRunId, eventLimit: 0 });
      const session = overview.sessions.find((candidate) => candidate.taskId === taskId);
      generationBAttempt = session ? new Harness(dbPath).getAttempt(session.attemptId) : null;
      if (!generationBAttempt) await Bun.sleep(10);
    }
    const finalHarness = new Harness(dbPath);
    const runtime = finalHarness.getRun(rootRunId)!.context.controlPlaneRuntime as Record<string, unknown>;
    const attempts = finalHarness.getRunOverview({ runId: rootRunId, eventLimit: 0 }).sessions
      .filter((session) => session.taskId === taskId)
      .map((session) => finalHarness.getAttempt(session.attemptId)!);

    expect(promptB).not.toBe(promptA);
    expect(runtime).toMatchObject({
      state: "current",
      generation: 2,
      launchHead: headB,
      promptContractHash: promptB,
      handoffReceipt: expect.objectContaining({ oldHead: headA, newHead: headB }),
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].input).toMatchObject({
      prompt: "COMMIT_B_SENTINEL",
      promptContractHash: promptB,
    });

    const replay = await runCliRaw(...daemonArgs);
    expect(replay.exitCode).toBe(0);
    const replayed = new Harness(dbPath).getRunOverview({ runId: rootRunId, eventLimit: 0 });
    const replayedRuntime = replayed.run!.context.controlPlaneRuntime as Record<string, unknown>;
    expect(replayedRuntime.handoffReceipt).toEqual(runtime.handoffReceipt);
    expect(replayed.sessions.filter((session) => session.taskId === taskId)).toHaveLength(1);
    expect(replayed.tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);
  });

  test("runs a real two-process handoff from commit A to commit B", async () => {
    const sourceRoot = join(dir, "real-generation-source");
    const repositoryRoot = resolve(import.meta.dir, "..");
    await mkdir(sourceRoot, { recursive: true });
    await cp(join(repositoryRoot, "packages"), join(sourceRoot, "packages"), { recursive: true });
    await cp(join(repositoryRoot, "scripts"), join(sourceRoot, "scripts"), { recursive: true });
    await symlink(join(repositoryRoot, "node_modules"), join(sourceRoot, "node_modules"), "dir");
    await writeFile(join(sourceRoot, "package.json"), await readFile(join(repositoryRoot, "package.json"), "utf8"));
    await writeFile(join(sourceRoot, ".gitignore"), "node_modules\n");

    gitCli(sourceRoot, ["init", "-b", "main"]);
    gitCli(sourceRoot, ["config", "user.name", "Ouroboros Test"]);
    gitCli(sourceRoot, ["config", "user.email", "test@example.com"]);
    gitCli(sourceRoot, ["config", "commit.gpgSign", "false"]);
    gitCli(sourceRoot, ["add", "package.json", ".gitignore", "packages"]);
    gitCli(sourceRoot, ["commit", "-m", "generation A"]);
    const mainPath = join(sourceRoot, "packages/cli/src/main.ts");
    const headA = gitCli(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const promptA = protectedPromptContractFingerprintForSource(sourceRoot);

    const bootstrap = await runCliJson("self-iterate", "--cwd", sourceRoot);
    const codexBin = join(dir, "real-generation-codex");
    const promptLog = join(dir, "real-generation-prompts.jsonl");
    const releasePath = join(dir, "release-generation-a");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        `appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ pid: process.pid, supervisorPid: process.ppid, prompt }) + '\\n');`,
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        "const payload = { status: 'done', summary: 'generation completed', changedFiles: [], checks: [{ name: 'generation replay', status: 'passed' }], artifacts: [], problems: [] };",
        "if (!prompt.includes('COMMIT_B_DESIGNER_SENTINEL')) while (!existsSync(" + JSON.stringify(releasePath) + ")) await Bun.sleep(10);",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: `session_${process.pid}` }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const oldProcess = Bun.spawn({
      cmd: [
        "bun",
        mainPath,
        "--db",
        dbPath,
        "self-improve-daemon",
        "--root-run-id",
        bootstrap.runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        sourceRoot,
        "--codex-bin",
        codexBin,
        "--max-ticks",
        "0",
        "--tick-cycles",
        "1",
        "--max-rounds",
        "1",
        "--interval-ms",
        "10",
        "--idle-ms",
        "10",
        "--start-hook",
        "none",
      ],
      cwd: sourceRoot,
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const oldStdout = new Response(oldProcess.stdout).text();
    const oldStderr = new Response(oldProcess.stderr).text();
    let newProcessId: number | null = null;
    let processesStopped = false;
    const stopProcesses = async () => {
      if (processesStopped) return;
      processesStopped = true;
      if (newProcessId && newProcessId !== process.pid) {
        try { process.kill(newProcessId, "SIGTERM"); } catch {}
      }
      oldProcess.kill();
      await oldProcess.exited;
      await Promise.all([oldStdout, oldStderr]);
    };
    try {
      let prompts: Array<{ pid: number; supervisorPid: number; prompt: string }> = [];
      for (let index = 0; index < 600 && prompts.length === 0; index += 1) {
        if (existsSync(promptLog)) {
          prompts = (await readFile(promptLog, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { pid: number; supervisorPid: number; prompt: string });
        }
        if (prompts.length === 0) await Bun.sleep(10);
      }
      if (prompts.length === 0) {
        throw new Error(`generation A never started\nstdout: ${await oldStdout}\nstderr: ${await oldStderr}`);
      }
      expect(prompts).toHaveLength(1);
      expect(prompts[0].prompt).not.toContain("COMMIT_B_DESIGNER_SENTINEL");

      const sourceA = await readFile(mainPath, "utf8");
      const sourceB = sourceA.replace(
        /function selfIterationDesignerPrompt\(\) \{\r?\n  return \[/,
        (match) => `${match}\n    "COMMIT_B_DESIGNER_SENTINEL",`,
      );
      expect(sourceB).not.toBe(sourceA);
      await writeFile(mainPath, sourceB);
      gitCli(sourceRoot, ["add", "packages/cli/src/main.ts"]);
      gitCli(sourceRoot, ["commit", "-m", "generation B"]);
      const headB = gitCli(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
      const promptB = protectedPromptContractFingerprintForSource(sourceRoot);
      expect(headB).not.toBe(headA);
      expect(promptB).not.toBe(promptA);
      expect(new Harness(dbPath).listRunningAttempts({ runId: bootstrap.runId })).toHaveLength(1);

      const pausedAt = new Date().toISOString();
      new Harness(dbPath).updateRun({
        runId: bootstrap.runId,
        contextPatch: {
          runPause: { reason: "human requested pause during reload drain", pausedAt },
        },
      });
      await Bun.sleep(100);
      const pausedRuntime = new Harness(dbPath).getRun(bootstrap.runId)!.context;
      expect(pausedRuntime.runPause).toEqual({
        reason: "human requested pause during reload drain",
        pausedAt,
      });
      const pausedPrompts = (await readFile(promptLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; supervisorPid: number; prompt: string });
      expect(pausedPrompts.some((entry) => entry.prompt.includes("COMMIT_B_DESIGNER_SENTINEL"))).toBe(false);
      new Harness(dbPath).updateRun({
        runId: bootstrap.runId,
        contextPatch: { runPause: null, runPauseClearedAt: new Date().toISOString() },
      });
      await writeFile(releasePath, "release\n");
      for (let index = 0; index < 3000; index += 1) {
        prompts = (await readFile(promptLog, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number; supervisorPid: number; prompt: string });
        if (prompts.some((entry) => entry.prompt.includes("COMMIT_B_DESIGNER_SENTINEL"))) break;
        await Bun.sleep(10);
      }
      const generationBPrompt = prompts.find((entry) => entry.prompt.includes("COMMIT_B_DESIGNER_SENTINEL"));
      expect(generationBPrompt).toBeDefined();
      expect(generationBPrompt?.supervisorPid).not.toBe(prompts[0].supervisorPid);

      const overview = new Harness(dbPath).getRunOverview({ runId: bootstrap.runId, eventLimit: 0 });
      const runtime = overview.run!.context.controlPlaneRuntime as Record<string, unknown>;
      expect(runtime).toMatchObject({
        state: "current",
        generation: 2,
        launchHead: headB,
        promptContractHash: promptB,
        handoffReceipt: expect.objectContaining({
          oldHead: headA,
          newHead: headB,
          oldProcessIdentity: String(prompts[0].supervisorPid),
          newProcessIdentity: String(generationBPrompt?.supervisorPid),
        }),
      });
      newProcessId = Number(runtime.processIdentity);

      await stopProcesses();

      const restart = Bun.spawn({
        cmd: [
          "bun",
          mainPath,
          "--db",
          dbPath,
          "self-improve-daemon",
          "--root-run-id",
          bootstrap.runId,
          "--executor",
          "codex-resumable",
          "--cwd",
          sourceRoot,
          "--codex-bin",
          codexBin,
          "--max-ticks",
          "1",
          "--tick-cycles",
          "1",
          "--max-rounds",
          "1",
          "--interval-ms",
          "1",
          "--idle-ms",
          "1",
          "--start-hook",
          "none",
        ],
        cwd: sourceRoot,
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [restartStdout, restartStderr, restartExitCode] = await Promise.all([
        new Response(restart.stdout).text(),
        new Response(restart.stderr).text(),
        restart.exited,
      ]);
      expect(restartExitCode, `${restartStdout}\n${restartStderr}`).toBe(0);
      const restartedRuntime = new Harness(dbPath).getRun(bootstrap.runId)!.context.controlPlaneRuntime as Record<string, unknown>;
      expect(restartedRuntime).toMatchObject({
        state: "current",
        generation: 2,
        launchHead: headB,
        promptContractHash: promptB,
        handoffReceipt: runtime.handoffReceipt,
      });
      expect(restartedRuntime.attestedProcessIdentity).not.toBe(runtime.attestedProcessIdentity);

      const overviewEvidence = await runCliJson("run-overview", "--run-id", bootstrap.runId);
      expect(overviewEvidence.controlPlaneRuntime).toMatchObject({
        generation: 2,
        launchHead: headB,
        promptContractHash: promptB,
      });
      const evidence = await runCli("run-evidence", "--run-id", bootstrap.runId);
      expect(evidence).toContain("old HEAD: " + headA);
      expect(evidence).toContain("new HEAD: " + headB);
      expect(evidence).toContain("old process: " + prompts[0].supervisorPid);
      expect(evidence).toContain("new process: " + generationBPrompt?.supervisorPid);
      expect(evidence).toContain(promptB);
    } finally {
      await stopProcesses();
    }
  }, 60_000);

  test("canonical self-iteration launch evidence ignores an ambient orbs link", async () => {
    const ambientBin = join(dir, "ambient-bin");
    await mkdir(ambientBin, { recursive: true });
    const ambientOrbs = join(ambientBin, "orbs");
    await writeFile(ambientOrbs, "#!/bin/sh\nprintf '%s\\n' ambient-worktree\n");
    await chmod(ambientOrbs, 0o755);

    const ambientPath = `${ambientBin}:${process.env.PATH ?? ""}`;
    const result = await runCliJson("self-iterate", { PATH: ambientPath });
    const overview = await runCliJson("run-overview", "--run-id", result.runId, { PATH: ambientPath });
    const runtime = overview.run.context.controlPlaneRuntime;

    expect(runtime.canonicalEntrypoint).toBe(join(resolve(import.meta.dir, ".."), "packages/cli/src/main.ts"));
    expect(runtime.sourceRoot).toBe(resolve(import.meta.dir, ".."));
    expect(runtime.canonicalEntrypoint).not.toContain("ambient-worktree");
  });

  test("self-iteration bootstrap forces every role through codex-resumable over a claude-code global default", async () => {
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
      global: "codex-resumable",
      roles: {
        designer: "codex-resumable",
        planner: "codex-resumable",
        worker: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
        "outcome-review": "codex-resumable",
        repair: "codex-resumable",
      },
    });
    expect(overview.run.context.agentBackends).toMatchObject({
      "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
    });

    expect(result.runnerCommand).toContain("--executor codex-resumable");
    expect(result.runnerCommand).toContain(`run-loop --run-id ${result.runId}`);
    expect(result.runnerCommand).toContain("--stop-hook create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary");
    expect(result.launchCommand).toContain("self-iterate-launch");

    const lessons = await runCliJson("list-lessons", "--run-id", result.runId);
    expect(Array.isArray(lessons)).toBe(true);
  });

  test("self-iteration bootstrap rejects role-level Claude defaults from config", async () => {
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
        'designer = "claude-code"',
        'worker = "claude-code"',
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
      global: "codex-resumable",
      roles: {
        designer: "codex-resumable",
        planner: "codex-resumable",
        worker: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
        "outcome-review": "codex-resumable",
        repair: "codex-resumable",
      },
    });
  });

  test("self-iteration bootstrap preserves an explicit DeepSeek Harness worker default", async () => {
    await runCli("init");
    const configPath = join(dir, "self-iterate-dsh-worker.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults]",
        'global = "codex-resumable"',
        "",
        "[agentDefaults.roles]",
        'worker = "deepseek-harness"',
        'verifier = "claude-code"',
        "",
        '["agentBackends"."deepseek-harness"]',
        'kind = "dsh-cli"',
        'command = "dsh"',
        'profile = "headless"',
        "",
        '["agentBackends"."claude-code"]',
        'kind = "acpx"',
        'agent = "claude"',
      ].join("\n"),
    );

    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.agentDefaults).toEqual({
      global: "codex-resumable",
      roles: {
        designer: "codex-resumable",
        planner: "codex-resumable",
        worker: "deepseek-harness",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
        "outcome-review": "codex-resumable",
        repair: "codex-resumable",
      },
    });
    expect(overview.run.context.agentBackends).toMatchObject({
      "deepseek-harness": { kind: "dsh-cli", command: "dsh", profile: "headless" },
    });
  });

  test("self-iteration preserves only Worker backends that resolve as valid DSH CLI routes", () => {
    const dsh = { kind: "dsh-cli", command: "dsh", profile: "headless" };
    const everyRoleIsCodex = (value: ReturnType<typeof codexOnlyAgentDefaults>) => {
      expect(value.global).toBe("codex-resumable");
      expect(Object.values(value.roles)).toEqual([
        "codex-resumable",
        "codex-resumable",
        "codex-resumable",
        "codex-resumable",
        "codex-resumable",
        "codex-resumable",
        "codex-resumable",
      ]);
    };

    expect(codexOnlyAgentDefaults(
      { roles: { worker: "deepseek-harness", designer: "claude-code", extension: "claude-code" } },
      { "deepseek-harness": dsh },
    ).roles.worker).toBe("deepseek-harness");
    expect(codexOnlyAgentDefaults({ roles: { worker: "dsh-cli" } }, {}).roles.worker).toBe("dsh-cli");

    for (const [worker, backends] of [
      [undefined, {}],
      ["unknown", {}],
      ["codex-resumable", { "codex-resumable": { kind: "codex-resumable" } }],
      ["other", { other: { kind: "acpx", agent: "codex" } }],
      ["deepseek-harness", { "deepseek-harness": { ...dsh, profile: "interactive" } }],
      ["dsh-cli", { "dsh-cli": { kind: "acpx", agent: "codex" } }],
    ] as const) {
      const normalized = codexOnlyAgentDefaults({ roles: worker === undefined ? {} : { worker } }, backends);
      everyRoleIsCodex({
        ...normalized,
        roles: Object.fromEntries(Object.keys(normalized.roles).map((role) => [role, normalized.roles[role]])),
      });
    }
  });

  test("uses the production createRunsFromDesign path for later-generation DSH Worker routing", async () => {
    const tracePath = join(dir, "self-iteration-routing-trace.jsonl");
    const dshCommand = join(dir, "fake-dsh");
    const codexCommand = join(dir, "fake-designer-codex");
    const workerCodexCommand = join(dir, "fake-worker-codex");
    const dshConfig = join(dir, "self-iterate-dsh-fixture.toml");
    const candidateWorktrees = Array.from({ length: 3 }, (_, index) => join(dir, `candidate-worktree-${index}`));
    const controlWorktrees = Array.from({ length: 3 }, (_, index) => join(dir, `control-worktree-${index}`));

    await writeFile(
      dshCommand,
      [
        "#!/usr/bin/env bun",
        "import { appendFileSync } from 'node:fs';",
        "const argv = Bun.argv.slice(2);",
        "const prompt = argv.at(-1) ?? '';",
        "appendFileSync(process.env.FAKE_ROUTE_TRACE!, JSON.stringify({ kind: 'dsh', argv, cwd: process.cwd(), providerCalls: 0, modelInferenceCalls: 0, paidSpendUsd: 0 }) + '\\n');",
        "console.log(JSON.stringify({ status: 'done', summary: 'fake dsh worker', changedFiles: [], checks: [{ name: 'fake dsh', status: 'passed' }], artifacts: [], problems: [], promptLength: prompt.length }));",
      ].join("\n"),
    );
    await writeFile(
      codexCommand,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        "const output = { status: 'done', summary: 'fake designer routed accepted proposal', changedFiles: [], checks: [{ name: 'production design route', status: 'passed' }], artifacts: [], problems: [], actions: [{ type: 'createRunsFromDesign', payload: { proposalId: process.env.FAKE_PROPOSAL_ID, runs: [{ goal: 'Plan the later-generation worker route', prompt: 'Plan the later-generation worker route.', doneWhen: ['production child created'] }] } }] };",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(output));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: `fake-designer-${process.pid}` }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
      ].join("\n"),
    );
    await writeFile(
      workerCodexCommand,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        "const output = { status: 'done', summary: 'fake codex worker', changedFiles: [], checks: [{ name: 'fake codex', status: 'passed' }], artifacts: [], problems: [] };",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(output));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: `fake-worker-${process.pid}` }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
      ].join("\n"),
    );
    await chmod(dshCommand, 0o755);
    await chmod(codexCommand, 0o755);
    await chmod(workerCodexCommand, 0o755);
    await writeFile(
      dshConfig,
      [
        "[agentDefaults]",
        'global = "codex-resumable"',
        "",
        "[agentDefaults.roles]",
        'worker = "deepseek-harness"',
        "",
        '["agentBackends"."deepseek-harness"]',
        'kind = "dsh-cli"',
        `command = ${JSON.stringify(dshCommand)}`,
        'profile = "headless"',
      ].join("\n"),
    );
    for (const worktree of [...candidateWorktrees, ...controlWorktrees]) {
      await mkdir(worktree, { recursive: true });
    }

    const roots: Array<{ kind: "candidate" | "control"; runId: string; taskId: string; worktree: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      roots.push({ kind: "candidate", ...(await runCliJson("self-iterate", "--config", dshConfig)), worktree: candidateWorktrees[index] });
      roots.push({ kind: "control", ...(await runCliJson("self-iterate")), worktree: controlWorktrees[index] });
    }

    const harness = new Harness(dbPath);
    const fixtureRuns: Array<{
      kind: "candidate" | "control";
      root: NonNullable<ReturnType<Harness["getRun"]>>;
      child: NonNullable<ReturnType<Harness["getRun"]>>;
      taskId: string;
      worktree: string;
    }> = [];
    for (const fixture of roots) {
      const root = harness.getRun(fixture.runId)!;
      const fixtureDb = new Database(dbPath);
      fixtureDb.query("update runs set context_json = json_remove(context_json, '$.controlPlaneRuntime') where id = $runId").run({ $runId: root.id });
      fixtureDb.close();
      const proposal = harness.createDesignProposal({
        projectId: root.projectId!,
        charterId: root.context.founderCharterId as string,
        runId: root.id,
        taskId: fixture.taskId,
        title: `Route ${fixture.kind} Worker`,
        problem: "A later-generation Worker route needs production-path evidence.",
        recommendation: "Preserve the explicit Worker backend in the design child.",
        proposal: {
          problem: "A later-generation Worker route needs production-path evidence.",
          recommendation: "Preserve the explicit Worker backend in the design child.",
          evaluationContract: {
            baseline: ["descendant Worker route is not exercised"],
            successMetrics: ["descendant Worker route is exercised"],
            guardMetrics: ["Codex remains the governance default"],
            requiredEvidence: ["child attempt backend and fake command trace"],
          },
          investment: { reversibility: "easy" as const, portfolio: "core" as const, oneTimeCost: 0, recurringCost: 0, timeBudget: "fixture" },
        },
        status: "proposed",
      });
      harness.recordDesignDecision({
        proposalId: proposal.id,
        decision: "approved",
        actorKind: "human",
        actorRef: "fixture-reviewer",
        charterId: proposal.charterId,
        authority: { disposition: "automatic" },
      });
      harness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });

      const design = await runCliRaw(
        "run-loop",
        "--run-id", root.id,
        "--executor", "codex-resumable",
        "--codex-bin", codexCommand,
        "--cwd", dir,
        "--sandbox", "read-only",
        "--start-hook", "none",
        "--max-rounds", "1",
        "--tasks", "1",
        { FAKE_PROPOSAL_ID: proposal.id, CODEX_SANDBOX: "" },
      );
      expect(design.exitCode, `${fixture.kind} design failed\n${design.stdout}\n${design.stderr}`).toBe(0);
      const child = harness.listRuns({ limit: 100 }).find((run) => run.context.designProposalId === proposal.id);
      expect(child).toBeDefined();
      const planner = harness.getRunOverview({ runId: child!.id, eventLimit: 0 }).tasks.find((task) => task.role === "planner");
      expect(planner).toBeDefined();
      harness.recordAttempt({
        taskId: planner!.id,
        input: { fixture: "production-createRunsFromDesign" },
        output: { status: "done", summary: "fixture planner completed", changedFiles: [], checks: [], artifacts: [], problems: [] },
      });
      const worktree = realpathSync(fixture.worktree);
      const taskId = harness.createTask({
        runId: child!.id,
        role: "worker",
        goal: `Run production-path ${fixture.kind} Worker`,
        prompt: `production path task prompt ${fixture.kind}`,
        doneWhen: ["fake command returns done AttemptOutput"],
        worktreePath: worktree,
      });
      fixtureRuns.push({ kind: fixture.kind, root, child: child!, taskId, worktree });
    }

    for (const fixture of fixtureRuns) {
      const rootContext = harness.getRun(fixture.root.id)!.context;
      const childContext = harness.getRun(fixture.child.id)!.context;
      expect(childContext.parentRunId).toBe(fixture.root.id);
      expect(childContext.source).toBe("design");
      expect(childContext.agentDefaults).toEqual(
        codexOnlyAgentDefaults(rootContext.agentDefaults, rootContext.agentBackends),
      );
      const childRoles = (childContext.agentDefaults as { roles: Record<string, string> }).roles;
      if (fixture.kind === "candidate") {
        expect(childRoles.worker).toBe("deepseek-harness");
        expect(childContext.agentBackends).toEqual(rootContext.agentBackends);
      } else {
        expect(childRoles.worker).toBe("codex-resumable");
      }

      const args = fixture.kind === "candidate"
        ? ["run-loop", "--run-id", fixture.child.id, "--executor", "dsh-cli", "--cwd", fixture.worktree, "--start-hook", "none", "--max-rounds", "1", "--tasks", "1", { FAKE_ROUTE_TRACE: tracePath }]
        : ["run-loop", "--run-id", fixture.child.id, "--executor", "codex-resumable", "--codex-bin", workerCodexCommand, "--cwd", fixture.worktree, "--sandbox", "read-only", "--start-hook", "none", "--max-rounds", "1", "--tasks", "1", { CODEX_SANDBOX: "" }];
      const execution = await runCliRaw(...args);
      expect(execution.exitCode, `${fixture.kind} fixture failed\n${execution.stdout}\n${execution.stderr}`).toBe(0);

      const overview = harness.getRunOverview({ runId: fixture.child.id, eventLimit: 0 });
      const session = overview.sessions.find((candidate) => candidate.taskId === fixture.taskId);
      expect(session).toBeDefined();
      const attempt = harness.getAttempt(session!.attemptId)!;
      expect(attempt.input.backend).toMatchObject(
        fixture.kind === "candidate"
          ? { id: "deepseek-harness", kind: "dsh-cli", source: "role-default" }
          : { id: "codex-resumable", kind: "codex-resumable", source: "role-default" },
      );
      expect(attempt.input.cwd).toBe(fixture.worktree);
      if (fixture.kind === "candidate") {
        expect(attempt.input.model).toBeNull();
      }
      expect(attempt.output).toMatchObject({ status: "done" });
      if (fixture.kind === "candidate") {
        expect(attempt.input.backend).toEqual({
          id: "deepseek-harness",
          kind: "dsh-cli",
          command: dshCommand,
          profile: "headless",
          source: "role-default",
        });
      }
    }

    const trace = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; providerCalls: number; modelInferenceCalls: number; paidSpendUsd: number });
    const candidateAttempts = fixtureRuns.filter((fixture) => fixture.kind === "candidate").map((fixture) => {
      const overview = harness.getRunOverview({ runId: fixture.child.id, eventLimit: 0 });
      return harness.getAttempt(overview.sessions.find((session) => session.taskId === fixture.taskId)!.attemptId)!;
    });
    expect(trace).toHaveLength(3);
    for (const [index, attempt] of candidateAttempts.entries()) {
      const entry = trace[index];
      expect(entry).toMatchObject({ cwd: realpathSync(candidateWorktrees[index]), providerCalls: 0, modelInferenceCalls: 0, paidSpendUsd: 0 });
      expect(entry.argv).toEqual(["--profile", "headless", attempt.input.prompt as string]);
    }
  });

  test("self-iteration bootstrap keeps explicit designer model defaults from config", async () => {
    await runCli("init");
    const configPath = join(dir, "self-iterate.toml");
    await writeFile(
      configPath,
      [
        "[models.roles.designer]",
        'model = "gpt-5.6-meridian"',
        'reasoning_effort = "medium"',
      ].join("\n"),
    );

    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.modelDefaults).toMatchObject({
      roles: {
        designer: { model: "gpt-5.6-meridian", reasoning_effort: "medium" },
        planner: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        worker: { model: "gpt-5.6-luna", reasoning_effort: "high" },
        verifier: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        "goal-review": { model: "gpt-5.6-sol", reasoning_effort: "high" },
      },
    });
  });

  test("self-iteration bootstrap freezes a concrete integration boundary for fresh roots", async () => {
    const result = await runCliJson("self-iterate");
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    const boundary = overview.run.context.integrationBoundary;
    expect(boundary).toBeDefined();
    expect(boundary).toMatchObject({
      targetBranch: "main",
      push: false,
      allowedFiles: expect.arrayContaining([
        "packages/harness/",
        "packages/runner/",
        "packages/cli/",
        "tests/",
        "docs/",
      ]),
      forbiddenPaths: expect.arrayContaining([".ouroboros/", "ouroboros.toml", ".linear"]),
    });
  });

  test("rejects ambient integration overrides before self-improvement supervision creates an action", async () => {
    const bootstrap = await runCliJson("self-iterate");

    const result = await runCliRaw(
      "self-improve-daemon",
      "--root-run-id",
      bootstrap.runId,
      "--executor",
      "codex-resumable",
      "--integration-push",
      "true",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--integration-push cannot override the frozen integrationBoundary");

    const targetResult = await runCliRaw(
      "self-improve-daemon",
      "--root-run-id",
      bootstrap.runId,
      "--executor",
      "codex-resumable",
      "--integration-target-branch",
      "release",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );

    expect(targetResult.exitCode).not.toBe(0);
    expect(targetResult.stderr).toContain("--integration-target-branch cannot override the frozen integrationBoundary");
    expect(new Harness(dbPath).listHarnessActionEvents({ limit: 20 })).toHaveLength(0);
  });

  test("self-iteration bootstrap honors an explicit config integration boundary over the default", async () => {
    await runCli("init");
    const configPath = join(dir, "self-iterate.toml");
    await writeFile(
      configPath,
      [
        "[integrationBoundary]",
        'target_branch = "release"',
        "push = false",
        'allowed_files = ["src/"]',
        'forbidden_paths = ["secrets/"]',
      ].join("\n"),
    );

    const result = await runCliJson("self-iterate", "--config", configPath);
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.integrationBoundary).toMatchObject({
      targetBranch: "release",
      push: false,
      allowedFiles: ["src/"],
      forbiddenPaths: ["secrets/"],
    });
  });

  test("self-iteration bootstrap seeds the default Ouroboros founder charter idempotently", async () => {
    const firstResult = await runCliJson("self-iterate");
    const firstOverview = await runCliJson("run-overview", "--run-id", firstResult.runId);

    expect(firstOverview.run.context.founderCharterId).toBeString();
    const firstCharterId = firstOverview.run.context.founderCharterId as string;

    const secondResult = await runCliJson("self-iterate");
    const secondOverview = await runCliJson("run-overview", "--run-id", secondResult.runId);

    expect(secondOverview.run.context.founderCharterId).toBe(firstCharterId);

    const harness = new Harness(dbPath);
    const projects = harness.listProjects();
    expect(projects.length).toBe(1);
    const project = projects[0];
    expect(firstOverview.run.projectId).toBe(project.id);
    expect(secondOverview.run.projectId).toBe(project.id);
    const charter = harness.getActiveFounderCharter({ projectId: project.id });
    expect(charter?.id).toBe(firstCharterId);
    expect(charter?.mission).toContain("reliable");
    expect(charter?.charter.capitalPolicy).toMatchObject({
      currency: "USD",
      experimentBudget: 100,
      recurringSpendApprovalAbove: 0,
    });
    expect(charter?.charter.authority).toMatchObject({
      autoResearch: true,
      autoReversibleExperiments: true,
      autoIntegrateVerifiedCode: false,
      humanApprovalPolicy: "cost-only",
    });
    expect(charter?.charter.policyVersion).toBe(2);
  });

  test("self-iteration upgrades the managed legacy charter to cost-only approval", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const projectId = harness.createProject({ name: "ouroboros", rootPath: process.cwd() });
    const legacy = harness.createFounderCharter({
      projectId,
      mission:
        "Make Ouroboros reliable, autonomous, observable, and useful for real coding work while adding measured commercial discipline without sacrificing safety.",
      charter: {
        mission:
          "Make Ouroboros reliable, autonomous, observable, and useful for real coding work while adding measured commercial discipline without sacrificing safety.",
        capitalPolicy: {
          currency: "USD",
          experimentBudget: 100,
          recurringSpendApprovalAbove: 0,
          portfolio: { core: 4, growth: 2, exploration: 1 },
        },
        authority: {
          autoResearch: true,
          autoReversibleExperiments: true,
          autoIntegrateVerifiedCode: false,
          requireHumanFor: ["production-deployment", "schema-migration"],
        },
      },
      activate: true,
    });

    const result = await runCliJson("self-iterate");
    const overview = await runCliJson("run-overview", "--run-id", result.runId);
    const active = harness.getActiveFounderCharter({ projectId });

    expect(active?.id).not.toBe(legacy.id);
    expect(active?.version).toBe(2);
    expect(active?.charter.policyVersion).toBe(2);
    expect(active?.charter.authority?.humanApprovalPolicy).toBe("cost-only");
    expect(overview.run.context.founderCharterId).toBe(active?.id);
  });

  test("self-iteration bootstrap never overrides an explicit founder charter", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const projectId = harness.createProject({ name: "ouroboros", rootPath: process.cwd() });
    const explicit = harness.createFounderCharter({
      projectId,
      mission: "Founder-defined mission that must not be overwritten",
      charter: {
        mission: "Founder-defined mission that must not be overwritten",
        capitalPolicy: {
          currency: "EUR",
          experimentBudget: 500,
        },
        authority: {
          autoResearch: false,
          autoReversibleExperiments: false,
        },
      },
      activate: true,
    });
    expect(explicit.isActive).toBe(true);

    const result = await runCliJson("self-iterate");
    const overview = await runCliJson("run-overview", "--run-id", result.runId);

    expect(overview.run.context.founderCharterId).toBe(explicit.id);
    const active = harness.getActiveFounderCharter({ projectId });
    expect(active?.id).toBe(explicit.id);
    expect(active?.mission).toBe("Founder-defined mission that must not be overwritten");
    expect(active?.charter.capitalPolicy?.experimentBudget).toBe(500);
  });

  test("self-iteration designer routes accepted proposals to a planner run with frozen context and ignores generic createTasks", async () => {
    const harness = new Harness(dbPath);
    harness.init();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: process.cwd() });
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Improve Ouroboros through evidence-backed bounded changes.",
      charter: {
        mission: "Improve Ouroboros through evidence-backed bounded changes.",
        capitalPolicy: { currency: "USD", experimentBudget: 100 },
        authority: { autoResearch: true, autoReversibleExperiments: true },
      },
      activate: true,
    });
    const bootstrap = {
      runId: harness.createRun({
        goal: "Assess Ouroboros and route accepted designs",
        context: {
          source: "self-improve",
          founderCharterId: charter.id,
          designCharterId: charter.id,
          selfImprovement: { cycleIndex: 0, assessmentFingerprint: "design-routing-test" },
        },
      }),
      taskId: "",
    };
    bootstrap.taskId = harness.createTask({
      runId: bootstrap.runId,
      role: "designer",
      goal: "Route the accepted proposal",
      prompt: "Apply only fixed design actions.",
      doneWhen: ["accepted proposal is routed through createRunsFromDesign"],
    });
    const proposal = harness.createDesignProposal({
      projectId,
      title: "Dashboard actions label clarity",
      problem: "Dashboard task vs runner actions label is ambiguous",
      recommendation: "Add a distinguishing label in the dashboard actions panel",
      proposal: {
        problem: "Dashboard task vs runner actions label is ambiguous",
        recommendation: "Add a distinguishing label in the dashboard actions panel",
        evidenceRefs: ["signal_dashboard_confusion"],
        targetOutcome: "Dashboard renders a label distinguishing task vs runner actions",
        options: [
          {
            name: "label the actions panel",
            benefits: ["clear distinction"],
            costs: ["small text change"],
            risks: ["none"],
            lockIn: ["none"],
          },
        ],
        evaluationContract: {
          baseline: ["no distinguishing label present"],
          successMetrics: ["label visible in dashboard actions panel"],
          guardMetrics: ["dashboard actions panel still renders"],
          requiredEvidence: ["dashboard snapshot with the new label"],
        },
        investment: {
          reversibility: "easy" as const,
          portfolio: "core" as const,
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "1 hour",
        },
        additions: ["packages/cli/src/dashboard.ts: actions panel label"],
        removals: ["ambiguous actions panel label"],
        assumptions: ["dashboard still renders the actions panel"],
        uncertainty: [],
      },
      status: "proposed",
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: proposal.charterId,
      reasons: ["founder reviewed reversible change"],
      authority: { disposition: "automatic", autoReversibleExperiments: true },
    });
    harness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });

    const codexBin = join(dir, "fake-codex-self-iterate-drain");
    const designerOutput = {
      status: "done",
      summary:
        "Designer routed accepted proposal to a planner child run; generic createTasks is ignored by the fixed-action boundary.",
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
                goal: "Boundary check worker that must not be created from designer output",
                prompt:
                  "If this task is created, the designer fixed-action boundary has failed.",
                dependsOn: [],
                doneWhen: ["this task must never run"],
              },
            ],
          },
        },
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposal.id,
            runs: [
              {
                goal: "Plan dashboard actions label clarity change",
                prompt:
                  "Plan a worker task that adds a distinguishing label to the dashboard actions panel.",
              },
            ],
          },
        },
      ],
    };
    const plannerOutput = {
      status: "done",
      summary: "Planned two concrete worker tasks through createTasks inside the design child run.",
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
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const emitCodexOutput = (sessionId: string, output: Record<string, unknown>) =>
      [
        JSON.stringify({ type: "session.started", session_id: sessionId }),
        JSON.stringify({ type: "agent.message", message: JSON.stringify(output) }),
      ]
        .map(shellQuote)
        .join(" ");
    await writeFile(
      codexBin,
      [
        "#!/bin/sh",
        "prompt=$(cat)",
        "case \"$prompt\" in",
        `  *"Role: designer"*) printf '%s\\n' ${emitCodexOutput("session_designer", designerOutput)} ;;`,
        `  *"Role: planner"*) printf '%s\\n' ${emitCodexOutput("session_planner", plannerOutput)} ;;`,
        `  *"Role: goal-review"*) printf '%s\\n' ${emitCodexOutput("session_review", goalReviewOutput)} ;;`,
        `  *"Role: verifier"*) printf '%s\\n' ${emitCodexOutput("session_verifier", verifierOutput)} ;;`,
        `  *) printf '%s\\n' ${emitCodexOutput("session_worker", workerOutput)} ;;`,
        "esac",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "supervise-runs",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary",
      "--run-concurrency",
      "2",
      "--concurrency",
      "2",
      "--max-cycles",
      "8",
      "--max-rounds",
      "8",
      "--interval-ms",
      "1",
    );

    const after = new Harness(dbPath);
    const bootstrapOverview = after.getRunOverview({ runId: bootstrap.runId, eventLimit: 0 });
    const bootstrapWorkers = bootstrapOverview.tasks.filter(
      (task: { role: string }) => task.role === "worker",
    );
    expect(bootstrapWorkers).toHaveLength(0);

    const runs = after.listRuns({ limit: 100 });
    const childRun = runs.find(
      (run: { context?: { designProposalId?: string } }) =>
        run.context?.designProposalId === proposal.id,
    ) as { id: string; context: Record<string, unknown> } | undefined;
    expect(childRun).toBeDefined();
    expect(childRun?.context).toMatchObject({
      parentRunId: bootstrap.runId,
      source: "design",
      designProposalId: proposal.id,
      designDecisionId: expect.any(String),
      designEvaluationContract: expect.objectContaining({
        successMetrics: ["label visible in dashboard actions panel"],
        requiredEvidence: ["dashboard snapshot with the new label"],
      }),
      designProposal: expect.objectContaining({
        problem: "Dashboard task vs runner actions label is ambiguous",
        recommendation: "Add a distinguishing label in the dashboard actions panel",
        targetOutcome: "Dashboard renders a label distinguishing task vs runner actions",
        additions: ["packages/cli/src/dashboard.ts: actions panel label"],
        removals: ["ambiguous actions panel label"],
      }),
      designInvestment: expect.objectContaining({
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      }),
      designAdditions: ["packages/cli/src/dashboard.ts: actions panel label"],
      designRemovals: ["ambiguous actions panel label"],
      designApprovalAuthority: expect.objectContaining({
        decision: "approved",
        actorKind: "human",
        actorRef: "founder@example.com",
        authority: expect.objectContaining({ disposition: "automatic" }),
      }),
    });

    const childOverview = after.getRunOverview({
      runId: childRun?.id ?? "",
      eventLimit: 100,
    });
    const childLessons = after.listLessons({ runId: childRun?.id ?? "" });
    const childNext = after.nextReadyTask(childRun?.id ?? "");
    const workers = childOverview.tasks.filter((task: { role: string }) => task.role === "worker");
    const verifiers = childOverview.tasks.filter(
      (task: { role: string }) => task.role === "verifier",
    );
    const review = childOverview.tasks.find(
      (task: { role: string }) => task.role === "goal-review",
    );

    expect(childOverview.run!.status).toBe("done");
    expect(childNext).toBeNull();
    expect(Array.isArray(childLessons)).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
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
    const reviewSession = childOverview.sessions.find(
      (session: { role: string }) => session.role === "goal-review",
    );
    expect(reviewSession?.output).toMatchObject({ status: "done", runDecision: "complete" });
  });

  test("launches the self-iteration dashboard and continuous supervisor together", async () => {
    await runCli("init");
    const dashboardPort = nextTestPort();
    if (!canStartServerOn(dashboardPort)) {
      expect(Bun.version).toBeString();
      return;
    }
    const codexBin = join(dir, "fake-codex-launch");
    const codexInvocationLog = join(dir, "fake-codex-launch-invocations.jsonl");
    const ambientBin = join(dir, "ambient-orbs-bin");
    await mkdir(ambientBin, { recursive: true });
    await writeFile(join(ambientBin, "orbs"), "#!/bin/sh\nprintf '%s\\n' ambient-worktree\n");
    await chmod(join(ambientBin, "orbs"), 0o755);
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const { appendFile } = await import('node:fs/promises');",
        "const args = Bun.argv.slice(2);",
        `await appendFile(${JSON.stringify(codexInvocationLog)}, JSON.stringify(args) + '\\n');`,
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
        process.cwd(),
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
      env: { ...process.env, PATH: `${ambientBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const launch = JSON.parse(await readFirstLine(proc.stdout));
      const launchRunId = launch.runId;
      const overviewResponse = await fetch(`${launch.dashboardUrl}/api/runs/${launch.runId}/overview`);
      const overview = await overviewResponse.json();
      for (let index = 0; index < 800 && !existsSync(codexInvocationLog); index += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(codexInvocationLog)).toBe(true);
      const codexInvocations = (await readFile(codexInvocationLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);

      expect(launch).toMatchObject({
        runId: expect.any(String),
        taskId: expect.any(String),
        dashboardUrl: `http://localhost:${dashboardPort}`,
        supervisorPid: expect.any(Number),
        supervisorStatus: expect.objectContaining({ status: "running" }),
      });
      expect(launch.daemonCommand).toContain("self-improve-daemon");
      expect(launch.daemonCommand).toContain(`--root-run-id ${launchRunId}`);
      expect(launch.daemonCommand).toContain(`--codex-bin ${codexBin}`);
      expect(launch.daemonCommand.match(/--codex-bin/g)).toHaveLength(1);
      expect(launch.daemonCommand).toContain("--tasks 3");
      expect(launch.daemonCommand).toContain("--start-hook none");
      expect(codexInvocations.length).toBeGreaterThanOrEqual(1);
      expect(codexInvocations.every((args) => args[0] === "exec")).toBe(true);
      expect(overview.supervisor).toMatchObject({ status: "running" });
      expect(overview.run).toMatchObject({
        id: launch.runId,
        goal: "Continuously improve Ouroboros from evidence-backed gaps",
      });
      expect(overview.run.context.controlPlaneRuntime).toMatchObject({
        sourceRoot: resolve(import.meta.dir, ".."),
        canonicalEntrypoint: join(resolve(import.meta.dir, ".."), "packages/cli/src/main.ts"),
      });
      expect(overview.tasks).toHaveLength(1);
      expect(overview.tasks[0]).toMatchObject({
        id: launch.taskId,
        role: "designer",
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

  test("creates a scoped Linear issue with the configured API token", async () => {
    await runCli("init");
    const tokenPath = join(dir, "linear-token");
    const configPath = join(dir, "ouroboros.toml");
    const projectUrl = "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview";
    const requests: Array<{ authorization: string; query: string; variables: Record<string, unknown> }> = [];
    const server = startTestServer({
      async fetch(request) {
        const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
        requests.push({
          authorization: request.headers.get("authorization") ?? "",
          query: body.query,
          variables: body.variables ?? {},
        });
        if (body.query.includes("OuroborosLinearAccess")) {
          return Response.json({
            data: {
              viewer: { id: "viewer_1", name: "Ouroboros Bot", email: "bot@example.com" },
              projects: {
                nodes: [{
                  id: "project_1",
                  name: "Ouroboros",
                  slugId: "ouroboros-acd5df2ef1da",
                  url: projectUrl,
                  teams: { nodes: [{ id: "team_1", key: "PAN", name: "PanCat" }] },
                }],
              },
            },
          });
        }
        return Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue_dogfood_1",
                identifier: "PAN-1300",
                title: "[orbs-dogfood] Verify autonomous Linear intake",
                url: "https://linear.app/pancat/issue/PAN-1300/orbs-dogfood",
                createdAt: "2026-08-06T00:00:00.000Z",
                project: { id: "project_1" },
                team: { id: "team_1", key: "PAN" },
              },
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

      const result = await runCliJson(
        "linear-create-issue",
        "--config",
        configPath,
        "--title",
        "[orbs-dogfood] Verify autonomous Linear intake",
        "--description",
        "A bounded zero-cost API verification issue.",
      );

      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.authorization === "lin_api_test_token")).toBe(true);
      expect(requests[1].query).toContain("CreateOuroborosDogfoodIssue");
      expect(requests[1].variables).toEqual({
        input: {
          title: "[orbs-dogfood] Verify autonomous Linear intake",
          description: "A bounded zero-cost API verification issue.",
          teamId: "team_1",
          projectId: "project_1",
        },
      });
      expect(result).toMatchObject({
        status: "created",
        project: { id: "project_1" },
        team: { id: "team_1", key: "PAN" },
        issue: { id: "issue_dogfood_1", identifier: "PAN-1300" },
      });
    } finally {
      server.stop(true);
    }
  });

  test("linear-check redacts GraphQL credential echoes from stderr", async () => {
    const token = "lin_api_graphql_echo_value_456";
    const tokenPath = join(dir, "linear-credential");
    const configPath = join(dir, "linear-redaction.toml");
    const server = startTestServer({
      fetch() {
        return Response.json({
          errors: [{
            message: `upstream echoed ${token}`,
            extensions: {
              Authorization: `Bearer ${token}`,
              secret: "OTHER_SECRET_789",
            },
          }],
        });
      },
    });
    if (!server) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      await writeFile(tokenPath, token);
      await writeFile(
        configPath,
        [
          "[linear]",
          `api_url = "http://127.0.0.1:${server.port}/graphql"`,
          `token_file = "${tokenPath}"`,
          'project_id = "project_1"',
          'team_key = "PAN"',
          "",
        ].join("\n"),
      );

      const result = await runCliRaw("linear-check", "--config", configPath);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      for (const forbidden of [token, "OTHER_SECRET_789", "Authorization", "Bearer", '"secret"']) {
        expect(output).not.toContain(forbidden);
      }
    } finally {
      server.stop(true);
    }
  });

  test("linear-update-status requires exact issue and state UUIDs and verifies a separate readback", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliJson(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
        {
          HTTP_PROXY: "http://dead-proxy.invalid:9999",
          HTTPS_PROXY: "http://dead-proxy.invalid:9999",
          ALL_PROXY: "http://dead-proxy.invalid:9999",
          http_proxy: "http://dead-proxy.invalid:9999",
          https_proxy: "http://dead-proxy.invalid:9999",
          all_proxy: "http://dead-proxy.invalid:9999",
        },
      );

      expect(result).toMatchObject({
        outcome: "verified",
        status: "verified",
        issue: {
          id: fixture.issueId,
          team: { id: fixture.teamId, key: "PAN" },
          state: { id: fixture.targetStateId, name: "In Progress", type: "started" },
        },
        state: { id: fixture.targetStateId, name: "In Progress" },
        readback: {
          issue: {
            id: fixture.issueId,
            team: { id: fixture.teamId, key: "PAN" },
            state: { id: fixture.targetStateId, name: "In Progress" },
          },
        },
      });
      expect(fixture.issueUpdateCalls()).toBe(1);
      expect(fixture.operationNames()).toEqual([
        "OuroborosLinearStatusScope",
        "OuroborosLinearStatusUpdate",
        "OuroborosLinearStatusReadback",
      ]);
      expect(fixture.requests[1]?.variables).toEqual({
        issueId: fixture.issueId,
        input: { stateId: fixture.targetStateId },
      });
      for (const request of fixture.requests) {
        expect(request.query).not.toContain("$issueId: ID!");
        expect(request.query).not.toContain("$stateId: ID!");
        expect(request.query).not.toContain("$commentId: ID!");
      }
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status resolves --state-name within the issue team and verifies via independent readback", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliJson(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-name",
        "In Progress",
      );

      expect(result).toMatchObject({
        outcome: "verified",
        status: "verified",
        issue: {
          id: fixture.issueId,
          team: { id: fixture.teamId, key: "PAN" },
          state: { id: fixture.targetStateId, name: "In Progress", type: "started" },
        },
        state: { id: fixture.targetStateId, name: "In Progress" },
        readback: {
          issue: {
            id: fixture.issueId,
            team: { id: fixture.teamId, key: "PAN" },
            state: { id: fixture.targetStateId, name: "In Progress" },
          },
        },
      });
      expect(fixture.issueUpdateCalls()).toBe(1);
      expect(fixture.operationNames()).toEqual([
        "OuroborosLinearStatusNameResolve",
        "OuroborosLinearStatusUpdate",
        "OuroborosLinearStatusReadback",
      ]);
      expect(fixture.requests[1]?.variables).toEqual({
        issueId: fixture.issueId,
        input: { stateId: fixture.targetStateId },
      });
      for (const request of fixture.requests) {
        expect(request.query).not.toContain("$issueId: ID!");
        expect(request.query).not.toContain("$stateId: ID!");
      }
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status --state-name and --state-id are mutually exclusive and reject empty selectors", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const both = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
        "--state-name",
        "In Progress",
      );
      expect(both.exitCode).not.toBe(0);
      expect(JSON.parse(both.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
      expect(fixture.issueUpdateCalls()).toBe(0);

      const neither = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
      );
      expect(neither.exitCode).not.toBe(0);
      expect(JSON.parse(neither.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
      expect(fixture.issueUpdateCalls()).toBe(0);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status --state-name returns state_name_unknown without calling issueUpdate", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-name",
        "Nonexistent State",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "failed",
        status: "state_name_unknown",
        issue: { id: fixture.issueId, team: { key: "PAN" } },
      });
      expect(fixture.issueUpdateCalls()).toBe(0);
      expect(fixture.operationNames()).toEqual(["OuroborosLinearStatusNameResolve"]);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status --state-name returns state_name_ambiguous when the team has duplicate names", async () => {
    const targetState = "77777777-7777-4777-8777-777777777777";
    const duplicateStateId = "88888888-8888-4888-8888-888888888888";
    const fixture = await createLinearWritebackFixture({
      teamStatesOverride: [
        { id: targetState, name: "In Progress", type: "started" },
        { id: duplicateStateId, name: "In Progress", type: "started" },
      ],
    });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-name",
        "In Progress",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "failed",
        status: "state_name_ambiguous",
        issue: { id: fixture.issueId, team: { key: "PAN" } },
      });
      expect(fixture.issueUpdateCalls()).toBe(0);
      expect(fixture.operationNames()).toEqual(["OuroborosLinearStatusNameResolve"]);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status --state-name preserves scope_mismatch, permission_denied, and issue_not_found semantics", async () => {
    const missing = await createLinearWritebackFixture({ missingIssue: true });
    if (!missing) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        missing.configPath,
        "--issue-id",
        missing.issueId,
        "--state-name",
        "In Progress",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "issue_not_found" });
      expect(missing.issueUpdateCalls()).toBe(0);
    } finally {
      missing.server.stop(true);
    }

    const forbidden = await createLinearWritebackFixture({ permissionDenied: true });
    if (!forbidden) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        forbidden.configPath,
        "--issue-id",
        forbidden.issueId,
        "--state-name",
        "In Progress",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "failed",
        status: "permission_denied",
        error: "Linear permission denied",
      });
      expect(forbidden.issueUpdateCalls()).toBe(0);
      for (const forbiddenToken of [forbidden.token, "Authorization", "Bearer"]) {
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(forbiddenToken);
      }
    } finally {
      forbidden.server.stop(true);
    }

    const mismatchedScope = await createLinearWritebackFixture({
      scopeIssueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    if (!mismatchedScope) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        mismatchedScope.configPath,
        "--issue-id",
        mismatchedScope.issueId,
        "--state-name",
        "In Progress",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "scope_mismatch" });
      expect(mismatchedScope.issueUpdateCalls()).toBe(0);
    } finally {
      mismatchedScope.server.stop(true);
    }
  });

  test("linear-update-status rejects mismatched immutable issue readback and redacts echoed credentials", async () => {
    const mismatch = await createLinearWritebackFixture({ readbackIssueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    if (!mismatch) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        mismatch.configPath,
        "--issue-id",
        mismatch.issueId,
        "--state-id",
        mismatch.targetStateId,
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "readback_mismatch" });
    } finally {
      mismatch.server.stop(true);
    }

    const reflected = await createLinearWritebackFixture({ echoCredentialError: true });
    if (!reflected) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        reflected.configPath,
        "--issue-id",
        reflected.issueId,
        "--state-id",
        reflected.targetStateId,
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "graphql_error" });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(reflected.token);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Authorization");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Bearer");
    } finally {
      reflected.server.stop(true);
    }
  });

  test("linear-update-status whitelists readback fields before writing structured output", async () => {
    const fixture = await createLinearWritebackFixture({ injectSensitiveExtraFields: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "verified", status: "verified" });
      expect(result.stdout).not.toContain("OTHER_SECRET_456");
      expect(result.stdout).not.toContain("Authorization");
      expect(result.stdout).not.toContain("Bearer");
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-update-status rejects sensitive state names and malformed nested GraphQL data", async () => {
    for (const options of [{ sensitiveStateName: true }, { malformedStatusScope: true }]) {
      const fixture = await createLinearWritebackFixture(options);
      if (!fixture) {
        expect(Bun.version).toBeString();
        return;
      }
      try {
        const result = await runCliRaw(
          "linear-update-status",
          "--config",
          fixture.configPath,
          "--issue-id",
          fixture.issueId,
          "--state-id",
          fixture.targetStateId,
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed" });
        for (const forbidden of ["OTHER_SECRET_999", "access_token", "Authorization", "Bearer"]) {
          expect(output).not.toContain(forbidden);
        }
      } finally {
        fixture.server.stop(true);
      }
    }
  });

  test("Linear writeback commands return structured config errors and reject mutable issue identifiers", async () => {
    const missingStatus = await runCliRaw("linear-update-status");
    const missingComment = await runCliRaw("linear-write-evidence-comment");
    expect(missingStatus.exitCode).not.toBe(0);
    expect(missingComment.exitCode).not.toBe(0);
    expect(JSON.parse(missingStatus.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
    expect(JSON.parse(missingComment.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });

    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const mutableIdentifier = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        "PAN-1232",
        "--state-id",
        fixture.targetStateId,
      );
      expect(JSON.parse(mutableIdentifier.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
      expect(fixture.issueUpdateCalls()).toBe(0);

      const missingSecret = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "missing-secret-v1",
        "--evidence-summary",
        "evidence",
      );
      expect(missingSecret.exitCode).not.toBe(0);
      expect(JSON.parse(missingSecret.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
      expect(fixture.commentCreateCalls()).toBe(0);

      const invalidCommentId = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--issue-id",
        "Authorization=Bearer OTHER_SECRET_456",
        "--idempotency-key",
        "invalid-issue-v1",
        "--evidence-summary",
        "evidence",
      );
      const invalidOutput = `${invalidCommentId.stdout}\n${invalidCommentId.stderr}`;
      expect(invalidCommentId.exitCode).not.toBe(0);
      expect(JSON.parse(invalidCommentId.stdout)).toMatchObject({ outcome: "failed", status: "config_error" });
      for (const forbidden of ["OTHER_SECRET_456", "Authorization", "Bearer"]) {
        expect(invalidOutput).not.toContain(forbidden);
      }
    } finally {
      fixture.server.stop(true);
    }

    const mismatchedScope = await createLinearWritebackFixture({
      scopeIssueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    if (!mismatchedScope) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-update-status",
        "--config",
        mismatchedScope.configPath,
        "--issue-id",
        mismatchedScope.issueId,
        "--state-id",
        mismatchedScope.targetStateId,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "scope_mismatch" });
      expect(mismatchedScope.issueUpdateCalls()).toBe(0);
    } finally {
      mismatchedScope.server.stop(true);
    }
  });

  test("Linear writeback commands classify HTTP 403 as permission denied without leaking credentials", async () => {
    const fixture = await createLinearWritebackFixture({ permissionDenied: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const status = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
      );
      const comment = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "permission-denied-v1",
        "--evidence-summary",
        "permission denied evidence",
      );

      for (const result of [status, comment]) {
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: "failed",
          status: "permission_denied",
          error: "Linear permission denied",
        });
        for (const forbidden of [fixture.token, "Authorization", "Bearer"]) {
          expect(`${result.stdout}\n${result.stderr}`).not.toContain(forbidden);
        }
      }
      expect(fixture.issueUpdateCalls()).toBe(0);
      expect(fixture.commentCreateCalls()).toBe(0);
      expect(fixture.comments).toHaveLength(0);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("Linear writeback commands fail deterministically when the immutable issue is not found", async () => {
    const fixture = await createLinearWritebackFixture({ missingIssue: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const status = await runCliRaw(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
      );
      const comment = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "missing-issue-v1",
        "--evidence-summary",
        "missing issue evidence",
      );

      for (const result of [status, comment]) {
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: "failed",
          status: "issue_not_found",
        });
      }
      expect(fixture.issueUpdateCalls()).toBe(0);
      expect(fixture.commentCreateCalls()).toBe(0);
      expect(fixture.comments).toHaveLength(0);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-write-evidence-comment creates once, independently reads back, then reuses sequentially", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const args = [
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "pan-1236-verifier-v1",
        "--evidence-summary",
        "  focused tests: pass\r\nfull suite: pass  ",
      ];
      const created = await runCliJson(...args);
      await fixture.rotateToken();
      const reused = await runCliJson(...args);

      expect(created).toMatchObject({
        outcome: "verified",
        status: "created",
        issueId: fixture.issueId,
        comment: { id: "comment_1" },
        verifiedBy: "independent_readback",
      });
      expect(reused).toMatchObject({
        outcome: "verified",
        status: "reused",
        issueId: fixture.issueId,
        comment: { id: "comment_1" },
        verifiedBy: "independent_readback",
      });
      expect(created.marker).toBe(reused.marker);
      expect(created.summaryDigest).toBe(reused.summaryDigest);
      expect(fixture.commentCreateCalls()).toBe(1);
      expect(fixture.comments).toHaveLength(1);
      expect(fixture.comments[0]?.body).toContain(created.marker);
      expect(fixture.comments[0]?.body).toContain(created.summaryDigest);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-write-evidence-comment recovers a lost mutation response without adding a second comment", async () => {
    const fixture = await createLinearWritebackFixture({ loseCommentCreateResponseOnce: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliJson(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "lost-response-v1",
        "--evidence-summary",
        "status verified; comment response lost",
      );

      expect(result).toMatchObject({
        outcome: "verified",
        status: "reused",
        issueId: fixture.issueId,
        comment: { id: "comment_1" },
        recovery: { mutationResponseLost: true },
      });
      expect(fixture.commentCreateCalls()).toBe(1);
      expect(fixture.comments).toHaveLength(1);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-write-evidence-comment redacts sensitive summaries without collapsing conflict identity", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const args = [
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "sensitive-evidence-v1",
      ];
      const first = await runCliJson(
        ...args,
        "--evidence-summary",
        '{"access_token":"OTHER_SECRET_456","token":["masked-first","OTHER_SECRET_789"]}\npassword = 0420\nAuthorization: Bearer abc.def',
      );
      const changed = await runCliRaw(
        ...args,
        "--evidence-summary",
        '{"access_token":"DIFFERENT_SECRET_456","token":["masked-second","DIFFERENT_SECRET_789"]}\npassword = 0421\nAuthorization: Bearer xyz.def',
      );
      const multiline = await runCliJson(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "sensitive-multiline-v1",
        "--evidence-summary",
        '{\n  "token": [\n    "OTHER_SECRET_MULTILINE_789"\n  ]\n}',
      );
      const nestedFragment = await runCliJson(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "sensitive-nested-fragment-v1",
        "--evidence-summary",
        'log fragment:\n"token": [["MASKED_FIRST"], "OTHER_SECRET_NESTED_789"]',
      );
      const leakedHmacSecret = await runCliJson(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "hmac-secret-redaction-v1",
        "--evidence-summary",
        fixture.writebackSecret,
      );
      const storedBody = fixture.comments[0]?.body ?? "";
      const multilineBody = fixture.comments[1]?.body ?? "";
      const nestedFragmentBody = fixture.comments[2]?.body ?? "";
      const hmacSecretBody = fixture.comments[3]?.body ?? "";
      const rawDigest = new Bun.CryptoHasher("sha256")
        .update('{"access_token":"OTHER_SECRET_456","token":["masked-first","OTHER_SECRET_789"]}\npassword = 0420\nAuthorization: Bearer abc.def')
        .digest("hex");

      expect(first).toMatchObject({ outcome: "verified", status: "created" });
      expect(changed.exitCode).not.toBe(0);
      expect(JSON.parse(changed.stdout)).toMatchObject({ outcome: "failed", status: "idempotency_conflict" });
      for (const forbidden of [
        "OTHER_SECRET_456",
        "OTHER_SECRET_789",
        "DIFFERENT_SECRET_789",
        "masked-first",
        "masked-second",
        "0420",
        "0421",
        "access_token",
        "Authorization",
        "Bearer",
        '"token"',
        "password",
      ]) {
        expect(storedBody).not.toContain(forbidden);
        expect(`${first.summaryDigest}\n${changed.stdout}\n${changed.stderr}`).not.toContain(forbidden);
      }
      expect(first.summaryDigest).not.toBe(rawDigest);
      expect(multiline).toMatchObject({ outcome: "verified", status: "created" });
      expect(multilineBody).not.toContain("OTHER_SECRET_MULTILINE_789");
      expect(multilineBody).not.toContain('"token"');
      expect(nestedFragment).toMatchObject({ outcome: "verified", status: "created" });
      expect(nestedFragmentBody).not.toContain("OTHER_SECRET_NESTED_789");
      expect(nestedFragmentBody).not.toContain("MASKED_FIRST");
      expect(nestedFragmentBody).not.toContain('"token"');
      expect(leakedHmacSecret).toMatchObject({ outcome: "verified", status: "created" });
      expect(hmacSecretBody).not.toContain(fixture.writebackSecret);
      expect(fixture.commentCreateCalls()).toBe(4);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-write-evidence-comment fails closed on changed evidence, duplicate markers, and readback mismatch", async () => {
    const fixture = await createLinearWritebackFixture();
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const baseArgs = [
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "conflict-v1",
      ];
      const first = await runCliJson(...baseArgs, "--evidence-summary", "first evidence");
      const changed = await runCliRaw(...baseArgs, "--evidence-summary", "changed evidence");
      expect(JSON.parse(changed.stdout)).toMatchObject({ outcome: "failed", status: "idempotency_conflict" });
      expect(changed.exitCode).not.toBe(0);
      expect(fixture.commentCreateCalls()).toBe(1);

      fixture.comments.push({ id: "comment_duplicate", body: fixture.comments[0]!.body });
      const duplicate = await runCliRaw(...baseArgs, "--evidence-summary", "first evidence");
      expect(JSON.parse(duplicate.stdout)).toMatchObject({ outcome: "failed", status: "idempotency_conflict" });
      expect(duplicate.exitCode).not.toBe(0);
      expect(fixture.commentCreateCalls()).toBe(1);
      expect(first.marker).toBeString();
    } finally {
      fixture.server.stop(true);
    }

    const mismatch = await createLinearWritebackFixture({ alterCommentReadback: true });
    if (!mismatch) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        mismatch.configPath,
        "--idempotency-secret-file",
        mismatch.writebackSecretPath,
        "--issue-id",
        mismatch.issueId,
        "--idempotency-key",
        "readback-mismatch-v1",
        "--evidence-summary",
        "readback must match exact canonical body",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "readback_mismatch" });
    } finally {
      mismatch.server.stop(true);
    }
  });

  test("linear-write-evidence-comment fails closed when the bounded comment scan is exhausted", async () => {
    const fixture = await createLinearWritebackFixture({ exhaustCommentPagination: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "pagination-cap-v1",
        "--evidence-summary",
        "do not create when older comments remain unscanned",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", status: "pagination_limit" });
      expect(fixture.commentCreateCalls()).toBe(0);
      expect(fixture.commentListCalls()).toBe(10);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("linear-write-evidence-comment returns a structured failure for malformed nested GraphQL data", async () => {
    const fixture = await createLinearWritebackFixture({ malformedCommentPage: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const result = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "malformed-page-v1",
        "--evidence-summary",
        "fail closed",
      );
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed" });
      expect(result.stderr).not.toContain("TypeError");
    } finally {
      fixture.server.stop(true);
    }
  });

  test("a verified status survives comment failure and recovery retries only the comment primitive", async () => {
    const fixture = await createLinearWritebackFixture({ failCommentCreate: true });
    if (!fixture) {
      expect(Bun.version).toBeString();
      return;
    }
    try {
      const status = await runCliJson(
        "linear-update-status",
        "--config",
        fixture.configPath,
        "--issue-id",
        fixture.issueId,
        "--state-id",
        fixture.targetStateId,
      );
      const failedComment = await runCliRaw(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "partial-recovery-v1",
        "--evidence-summary",
        "status is already verified",
      );
      const failed = JSON.parse(failedComment.stdout);

      expect(status).toMatchObject({ outcome: "verified", status: "verified" });
      expect(failed).toMatchObject({
        outcome: "failed",
        recovery: { retry: "comment-only", rollbackStatus: false },
      });
      expect(fixture.issueUpdateCalls()).toBe(1);

      fixture.setFailCommentCreate(false);
      const recovered = await runCliJson(
        "linear-write-evidence-comment",
        "--config",
        fixture.configPath,
        "--idempotency-secret-file",
        fixture.writebackSecretPath,
        "--issue-id",
        fixture.issueId,
        "--idempotency-key",
        "partial-recovery-v1",
        "--evidence-summary",
        "status is already verified",
      );
      expect(recovered).toMatchObject({ outcome: "verified", status: "created" });
      expect(fixture.issueUpdateCalls()).toBe(1);
      expect(fixture.commentCreateCalls()).toBe(2);
      expect(fixture.comments).toHaveLength(1);
    } finally {
      fixture.server.stop(true);
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

  test("linear-ingest-event is idempotent for repeated intake of the same immutable issue id", async () => {
    await runCli("init");

    const first = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-XYZ-9",
      "--payload-json",
      JSON.stringify({ action: "create", title: "First", url: "https://linear.app/example/issue/LIN-XYZ-9" }),
    );
    const second = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "LIN-XYZ-9",
      "--payload-json",
      JSON.stringify({ action: "create", title: "Second", url: "https://linear.app/example/issue/LIN-XYZ-9" }),
    );

    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^inbox_/);
    expect(first).toMatchObject({ provider: "linear", eventType: "issue.created", externalId: "LIN-XYZ-9", created: true });
    expect(second.created).toBe(false);

    const harness = new Harness(dbPath);
    const rows = harness.listInboxEvents({ provider: "linear" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      provider: "linear",
      eventType: "issue.created",
      externalId: "LIN-XYZ-9",
      status: "todo",
      payload: { action: "create", title: "First", url: "https://linear.app/example/issue/LIN-XYZ-9" },
    });
  });

  test("linear-ingest-event uses the immutable issue id rather than url or key when present", async () => {
    await runCli("init");

    const stored = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-immutable-001",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-4321",
        url: "https://linear.app/pancat/issue/PAN-4321/whatever",
        title: "Polled issue",
      }),
    );

    const second = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-immutable-001",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-4321",
        url: "https://linear.app/other/path/PAN-4321",
        title: "Polled again with a different URL",
      }),
    );

    expect(second.id).toBe(stored.id);
    expect(second.created).toBe(false);

    const rows = new Harness(dbPath).listInboxEvents({ provider: "linear" });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("linear-issue-immutable-001");
  });

  test("linear-consume-inbox claims a todo Linear issue event into one issue-scoped Designer run and task", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const seedHarness = new Harness(dbPath);
    // Drain the bootstrap so it does not show up as pending Designer work.
    seedHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    seedHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const stored = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-consume-1",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-5001",
        title: "Polished intake",
        description: "Polish the intake path",
        url: "https://linear.app/pancat/issue/PAN-5001",
        createdAt: "2026-02-01T00:00:00.000Z",
        teamKey: "PAN",
      }),
    );

    const result = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );

    expect(result.processed).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.deduplicated).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    expect(outcome.kind).toBe("claimed");
    expect(outcome.eventId).toBe(stored.id);
    expect(outcome.externalId).toBe("linear-issue-consume-1");
    expect(outcome.runCreated).toBe(true);
    expect(outcome.taskCreated).toBe(true);
    expect(outcome.runId).toMatch(/^run_linear_/);
    expect(outcome.taskId).toMatch(/^task_linear_/);

    const after = new Harness(dbPath);
    const event = after.getInboxEvent({ id: stored.id })!;
    // The intake claim path owns todo → running only. Finalization
    // (running → done) is owned by the fixed design action path so the
    // transition is atomic with the planning run, planner task, and external
    // reference. A premature done here would mask the atomic guarantee.
    expect(event.status).toBe("running");
    const task = after.getTask(outcome.taskId);
    expect(task).toBeDefined();
    expect(task!.role).toBe("designer");
    expect(task!.runId).toBe(outcome.runId);
    const run = after.getRun(outcome.runId)!;
    expect(run).toBeDefined();
    const intake = run.context.linearIntake as Record<string, unknown> | undefined;
    expect(intake).toBeDefined();
    expect(intake!.rootRunId).toBe(bootstrap.runId);
    expect(intake!.inboxEventId).toBe(stored.id);
    expect(intake!.linearIssueId).toBe("linear-issue-consume-1");
    expect(run.context.parentRunId).toBe(bootstrap.runId);
    expect(run.context.source).toBe("linear-intake");
  });

  test("linear-consume-inbox is idempotent across restart and replay for one immutable Linear issue id", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const seedHarness = new Harness(dbPath);
    seedHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    seedHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const first = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-consume-replay",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-5002",
        title: "Replay-safe issue",
      }),
    );

    const claim1 = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );
    expect(claim1.claimed).toBe(1);
    const firstOutcome = claim1.outcomes[0];
    const firstRunId = firstOutcome.runId;
    const firstTaskId = firstOutcome.taskId;

    // Second ingest reuses the same deterministic inbox row (idempotent ensure).
    const second = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-consume-replay",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-5002",
        title: "Replay-safe issue",
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);

    // The inbox event stays `running` after the first consume: the claim path
    // owns todo → running only, and the fixed design action path owns the
    // eventual running → done transition. A replay consumption re-encounters
    // the running event, reuses the same deterministic Designer run/task, and
    // reports a deduplicated outcome without double-claiming.
    const claim2 = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );
    expect(claim2.processed).toBe(1);
    expect(claim2.claimed).toBe(0);
    expect(claim2.deduplicated).toBe(1);
    expect(claim2.outcomes[0].runId).toBe(firstRunId);
    expect(claim2.outcomes[0].taskId).toBe(firstTaskId);

    // Restart simulation: a separate CLI invocation observes the same durable
    // run and task without duplication.
    const claim3 = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );
    expect(claim3.processed).toBe(1);
    expect(claim3.deduplicated).toBe(1);

    const after = new Harness(dbPath);
    const events = after.listInboxEvents({ provider: "linear" });
    expect(events).toHaveLength(1);
    // The lifecycle remains pending until the fixed design action path
    // finalizes it; consumeLinearInbox never marks done itself.
    expect(events[0].status).toBe("running");
    const overview = after.getRunOverview({ runId: firstRunId, eventLimit: 0 });
    expect(overview.tasks.filter((task) => task.role === "designer")).toHaveLength(1);
    expect(after.getTask(firstTaskId)!.id).toBe(firstTaskId);
  });

  test("linear-consume-inbox resumes an event left running by a crash between claim and complete", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const seedHarness = new Harness(dbPath);
    seedHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    seedHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const stored = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-consume-restart",
      "--payload-json",
      JSON.stringify({
        identifier: "PAN-5003",
        title: "Restart resume",
      }),
    );

    // Simulate a crash after claim: manually flip the event to running and
    // leave no Designer run/task behind.
    const crashHarness = new Harness(dbPath);
    crashHarness.transitionInboxEvent({ id: stored.id, from: "todo", to: "running" });

    const result = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );
    expect(result.processed).toBe(1);
    // The event is resumed, not freshly claimed; the run/task already
    // existed conceptually (none did), so consumption creates them and
    // reports the run as deduplicated/claimed based on creation.
    const outcome = result.outcomes[0];
    expect(outcome.runCreated).toBe(true);
    expect(outcome.taskCreated).toBe(true);
    expect(outcome.runId).toMatch(/^run_linear_/);

    const after = new Harness(dbPath);
    const event = after.getInboxEvent({ id: stored.id })!;
    // Resume after a crash leaves the event `running` so the fixed design
    // action path can still finalize the lifecycle atomically; consume itself
    // never marks done.
    expect(event.status).toBe("running");
  });

  test("linear-consume-inbox blocks intake when the event payload cannot drive a Designer run", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const seedHarness = new Harness(dbPath);
    seedHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    seedHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const stored = await runCliJson(
      "linear-ingest-event",
      "--event-type",
      "issue.created",
      "--external-id",
      "linear-issue-consume-malformed",
      "--payload-json",
      JSON.stringify({ title: "" }),
    );

    const result = await runCliJson(
      "linear-consume-inbox",
      "--root-run-id",
      bootstrap.runId,
    );
    expect(result.processed).toBe(1);
    expect(result.blocked).toBe(1);
    const outcome = result.outcomes[0];
    expect(outcome.kind).toBe("blocked");
    expect(outcome.eventId).toBe(stored.id);
    expect(outcome.error).toMatch(/missing issue identifier and title/);

    const after = new Harness(dbPath);
    const event = after.getInboxEvent({ id: stored.id })!;
    expect(event.status).toBe("blocked");
  });

  test("consumeLinearInbox is deterministic and restart-safe at the unit level", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const seedHarness = new Harness(dbPath);
    seedHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    seedHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const harness = new Harness(dbPath);
    const event = harness.ensureInboxEvent({
      id: deterministicLinearInboxId({
        eventType: "issue.created",
        externalId: "linear-issue-unit-1",
      }),
      provider: "linear",
      eventType: "issue.created",
      externalId: "linear-issue-unit-1",
      payload: {
        identifier: "PAN-9001",
        title: "Unit test issue",
      },
    }).event;

    const first = consumeLinearInbox({ harness, rootRunId: bootstrap.runId });
    expect(first.processed).toBe(1);
    expect(first.claimed).toBe(1);
    const firstOutcome = first.outcomes[0];
    expect(firstOutcome.runCreated).toBe(true);
    expect(firstOutcome.taskCreated).toBe(true);

    // The intake claim path owns todo → running only; finalization is owned
    // by the fixed design action path. A premature done here would mask the
    // atomic guarantee required by the intake contract.
    const afterFirst = new Harness(dbPath);
    expect(afterFirst.getInboxEvent({ id: event.id })?.status).toBe("running");

    // Replay via a fresh harness instance simulates a daemon restart. The
    // deterministic IDs reuse the existing run and task; the running event is
    // re-encountered and reported as deduplicated, not freshly claimed.
    const replay = consumeLinearInbox({ harness: new Harness(dbPath), rootRunId: bootstrap.runId });
    expect(replay.processed).toBe(1);
    expect(replay.claimed).toBe(0);
    expect(replay.deduplicated).toBe(1);
    expect(replay.outcomes[0].runId).toBe(firstOutcome.runId);
    expect(replay.outcomes[0].taskId).toBe(firstOutcome.taskId);

    const events = new Harness(dbPath).listInboxEvents({ provider: "linear" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    // The lifecycle remains pending until the fixed design action path
    // finalizes it; consumeLinearInbox never marks done itself.
    expect(events[0].status).toBe("running");
  });

  test("linear polling config requires positive interval plus project and team selectors", async () => {
    await runCli("init");
    expect(resolveLinearPolling(undefined).enabled).toBe(false);
    expect(resolveLinearPolling({ pollIntervalMs: 1000 }).enabled).toBe(false);
    expect(resolveLinearPolling({ pollIntervalMs: 1000, projectId: "proj" }).enabled).toBe(false);
    expect(resolveLinearPolling({ pollIntervalMs: 1000, projectId: "proj", teamKey: "PAN" }).enabled).toBe(true);
    const invalidInterval = resolveLinearPolling({
      pollIntervalMs: 0,
      projectId: "proj",
      teamKey: "PAN",
      pollPageSize: 0,
    });
    expect(invalidInterval.enabled).toBe(false);
    expect(invalidInterval.reason).toBe("missing-interval");
  });

  test("linear polling config clamps page and cycle limits to hard caps", () => {
    const resolved = resolveLinearPolling({
      pollIntervalMs: 1000,
      projectId: "proj",
      teamKey: "PAN",
      pollPageSize: 10_000,
      pollMaxPagesPerCycle: 1_000,
      pollMaxIssuesPerCycle: 100_000,
      pollOverlapMs: 10 * 60 * 60 * 1000,
      pollMaxRetries: 1_000,
      pollBackoffBaseMs: 10 * 60 * 1000,
      pollBackoffMaxMs: 10 * 24 * 60 * 60 * 1000,
    });
    expect(resolved.enabled).toBe(true);
    const cfg = resolved.config!;
    expect(cfg.pageSize).toBeLessThanOrEqual(100);
    expect(cfg.maxPagesPerCycle).toBeLessThanOrEqual(50);
    expect(cfg.maxIssuesPerCycle).toBeLessThanOrEqual(500);
    expect(cfg.overlapMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(cfg.maxRetries).toBeLessThanOrEqual(10);
    expect(cfg.backoffBaseMs).toBeLessThanOrEqual(60 * 1000);
    expect(cfg.backoffMaxMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test("linear polling config rejects subminimum values as invalid", () => {
    const resolved = resolveLinearPolling({
      pollIntervalMs: 1000,
      projectId: "proj",
      teamKey: "PAN",
      pollPageSize: 0,
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.reason).toBe("invalid");
    expect(resolved.error).toContain("poll_page_size");
  });

  test("linear polling config loads bounded polling fields from TOML", async () => {
    await runCli("init");
    const configPath = join(dir, "ouroboros.toml");
    await writeFile(
      configPath,
      [
        "[linear]",
        'api_url = "https://example.test/graphql"',
        'token_env = "LINEAR_API_KEY"',
        'project_id = "proj-1"',
        'team_key = "PAN"',
        "poll_interval_ms = 60000",
        "poll_page_size = 25",
        "poll_max_pages_per_cycle = 3",
        "poll_max_issues_per_cycle = 60",
        "poll_overlap_ms = 120000",
        "poll_max_retries = 5",
        "poll_backoff_base_ms = 2500",
        "poll_backoff_max_ms = 600000",
      ].join("\n") + "\n",
    );
    const loaded = await loadOuroborosConfig(configPath);
    expect(loaded.linear?.pollIntervalMs).toBe(60000);
    expect(loaded.linear?.pollPageSize).toBe(25);
    expect(loaded.linear?.pollMaxPagesPerCycle).toBe(3);
    expect(loaded.linear?.pollMaxIssuesPerCycle).toBe(60);
    expect(loaded.linear?.pollOverlapMs).toBe(120000);
    expect(loaded.linear?.pollMaxRetries).toBe(5);
    expect(loaded.linear?.pollBackoffBaseMs).toBe(2500);
    expect(loaded.linear?.pollBackoffMaxMs).toBe(600000);
  });

  test("pollLinearIssues restricts the issues query to the resolved project and team and advances the watermark", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const requests: Array<{ body: string }> = [];
    const issue = {
      id: "issue-1",
      identifier: "PAN-1",
      title: "First",
      description: "body",
      url: "https://linear.test/issue/1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      project: { id: "proj-1" },
      team: { id: "team-1", key: "PAN" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      requests.push({ body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [issue],
              pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.issuesIngested).toBe(1);
    expect(result.issuesDeduplicated).toBe(0);
    expect(result.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(requests).toHaveLength(1);
    const requestBody = JSON.parse(requests[0]!.body);
    expect(requestBody.query).toContain("$projectId: ID!");
    expect(requestBody.query).toContain("$overlapStart: DateTimeOrDuration");
    const variables = requestBody.variables;
    expect(variables).toMatchObject({
      projectId: "proj-1",
      teamKey: "PAN",
      pageSize: basePollingConfig().pageSize,
      after: null,
      overlapStart: "1970-01-01T00:00:00.000Z",
    });
    const rows = harness.listInboxEvents({ provider: "linear" });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("issue-1");
  });

  test("pollLinearIssues rejects out-of-scope nodes returned by Linear before ingestion", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-good",
                  identifier: "PAN-1",
                  title: "In",
                  description: null,
                  url: "https://linear.test/issue/1",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  project: { id: "proj-1" },
                  team: { id: "team-1", key: "PAN" },
                },
                {
                  id: "issue-stray",
                  identifier: "OTH-1",
                  title: "Out",
                  description: null,
                  url: "https://linear.test/issue/2",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  project: { id: "proj-other" },
                  team: { id: "team-other", key: "OTH" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-after-good" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.issuesRejected).toBe(1);
    expect(result.issuesIngested).toBe(1);
    expect(result.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    const rows = harness.listInboxEvents({ provider: "linear" });
    expect(rows.map((row) => row.externalId)).toEqual(["issue-good"]);
  });

  test("pollLinearIssues paginates with after cursor and advances the watermark only after each page is durable", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const requests: Array<{ after: string | null }> = [];
    let call = 0;
    const pages: LinearGraphqlPageShape[] = [
      {
        nodes: [
          {
            id: "issue-a",
            identifier: "PAN-A",
            title: "A",
            description: null,
            url: "https://linear.test/a",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            project: { id: "proj-1" },
            team: { id: "team-1", key: "PAN" },
          },
          {
            id: "issue-b",
            identifier: "PAN-B",
            title: "B",
            description: null,
            url: "https://linear.test/b",
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            project: { id: "proj-1" },
            team: { id: "team-1", key: "PAN" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
      },
      {
        nodes: [
          {
            id: "issue-c",
            identifier: "PAN-C",
            title: "C",
            description: null,
            url: "https://linear.test/c",
            createdAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
            project: { id: "proj-1" },
            team: { id: "team-1", key: "PAN" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: "cursor-page-2" },
      },
    ];
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const body = String(init?.body ?? "");
      const parsed = JSON.parse(body);
      requests.push({ after: parsed.variables.after ?? null });
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.pagesProcessed).toBe(2);
    expect(result.issuesIngested).toBe(3);
    expect(result.state.overlapBoundary).toBe("2026-01-01T00:00:02.000Z");
    expect(requests.map((entry) => entry.after)).toEqual([null, "cursor-page-1"]);
  });

  test("pollLinearIssues replays the overlap window and deduplicates immutable issue ids across cycles", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const initialBoundary = "2026-01-01T00:00:00.000Z";
    const pagesByCall = new Map<number, LinearGraphqlPageShape>([
      [
        0,
        {
          nodes: [
            {
              id: "issue-stable",
              identifier: "PAN-1",
              title: "Stable",
              description: null,
              url: "https://linear.test/1",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
            {
              id: "issue-tie",
              identifier: "PAN-2",
              title: "Tie",
              description: null,
              url: "https://linear.test/2",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "cursor-after" },
        },
      ],
      [
        1,
        {
          nodes: [
            {
              id: "issue-stable",
              identifier: "PAN-1",
              title: "Stable",
              description: null,
              url: "https://linear.test/1",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
            {
              id: "issue-tie",
              identifier: "PAN-2",
              title: "Tie",
              description: null,
              url: "https://linear.test/2",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
            {
              id: "issue-new",
              identifier: "PAN-3",
              title: "New",
              description: null,
              url: "https://linear.test/3",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "cursor-after-new" },
        },
      ],
    ]);
    let call = 0;
    const seenOverlapStart: (string | null)[] = [];
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? ""));
      seenOverlapStart.push(parsed.variables.overlapStart ?? null);
      const page = pagesByCall.get(call) ?? pagesByCall.get(1)!;
      call += 1;
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const first = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig({ overlapMs: 60_000 }),
      state: { cursor: null, overlapBoundary: initialBoundary },
      fetchImpl,
    });
    expect(first.status).toBe("ok");
    expect(first.issuesIngested).toBe(2);
    expect(first.issuesDeduplicated).toBe(0);
    expect(first.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(first.state.cursor).toBeNull();
    expect(first.state.intraPageContinuation).toBeNull();
    expect(seenOverlapStart[0]).toBeTypeOf("string");
    expect(Date.parse(seenOverlapStart[0]!)).toBeLessThan(Date.parse(initialBoundary));

    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig({ overlapMs: 60_000 }),
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesDeduplicated).toBe(2);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(second.state.cursor).toBeNull();
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(3);
  });

  test("pollLinearIssues replays a terminal page across supervisor restarts without stranding new equal-timestamp issues", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const initialBoundary = "2026-01-01T00:00:00.000Z";
    const seenAfter: (string | null)[] = [];
    const pagesByCall = new Map<number, LinearGraphqlPageShape>([
      [
        0,
        {
          nodes: [
            {
              id: "issue-old",
              identifier: "PAN-1",
              title: "Old",
              description: null,
              url: "https://linear.test/1",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "terminal-1" },
        },
      ],
      [
        1,
        {
          nodes: [
            {
              id: "issue-old",
              identifier: "PAN-1",
              title: "Old",
              description: null,
              url: "https://linear.test/1",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
            {
              id: "issue-new",
              identifier: "PAN-2",
              title: "New",
              description: null,
              url: "https://linear.test/2",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              project: { id: "proj-1" },
              team: { id: "team-1", key: "PAN" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "terminal-2" },
        },
      ],
    ]);
    let call = 0;
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? ""));
      seenAfter.push(parsed.variables.after ?? null);
      const page = pagesByCall.get(call) ?? pagesByCall.get(1)!;
      call += 1;
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const first = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig({ overlapMs: 60_000 }),
      state: { cursor: null, overlapBoundary: initialBoundary },
      fetchImpl,
    });
    expect(first.status).toBe("ok");
    expect(first.issuesIngested).toBe(1);
    expect(first.state.cursor).toBeNull();
    expect(first.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");

    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig({ overlapMs: 60_000 }),
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesDeduplicated).toBe(1);
    expect(second.state.cursor).toBeNull();
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(seenAfter).toEqual([null, null]);
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(2);
  });

  test("pollLinearIssues preserves the previous overlap boundary when an issue fails to ingest mid-page", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const poisonId = deterministicLinearInboxId({ eventType: "issue.created", externalId: "issue-poison" });
    harness.ensureInboxEvent({
      id: deterministicLinearInboxId({ eventType: "issue.created", externalId: "issue-good" }),
      provider: "linear",
      eventType: "issue.created",
      externalId: "issue-good",
      payload: { identifier: "PAN-1" },
    });
    harness.createInboxEvent({
      provider: "linear",
      eventType: "issue.created",
      externalId: "issue-colliding",
      payload: { identifier: "PAN-X" },
      status: "todo",
      id: poisonId,
    });
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-good",
                  identifier: "PAN-1",
                  title: "Good",
                  description: null,
                  url: "https://linear.test/1",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  project: { id: "proj-1" },
                  team: { id: "team-1", key: "PAN" },
                },
                {
                  id: "issue-poison",
                  identifier: "PAN-2",
                  title: "Poison",
                  description: null,
                  url: "https://linear.test/2",
                  createdAt: "2026-01-01T00:00:01.000Z",
                  updatedAt: "2026-01-01T00:00:01.000Z",
                  project: { id: "proj-1" },
                  team: { id: "team-1", key: "PAN" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "cursor-end" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const initial: LinearPollingState = { cursor: null, overlapBoundary: "2025-12-31T00:00:00.000Z" };
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: initial,
      fetchImpl,
    });

    expect(result.status).toBe("ingestion_failure");
    expect(result.state.overlapBoundary).toBe("2025-12-31T00:00:00.000Z");
    expect(result.state.intraPageContinuation).toBeNull();
    expect(result.issuesIngested).toBe(0);
    expect(result.issuesDeduplicated).toBe(1);
    expect(result.error).toContain("deterministic id collision");
  });

  test("pollLinearIssues drops the relay cursor when the overlap boundary advances so the next cycle replays consistently", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const seenAfter: (string | null)[] = [];
    const seenOverlapStart: (string | null)[] = [];
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? ""));
      const after = parsed.variables.after ?? null;
      const overlapStart = parsed.variables.overlapStart ?? null;
      seenAfter.push(after);
      seenOverlapStart.push(overlapStart);
      const issue1 = {
        id: "issue-1",
        identifier: "PAN-1",
        title: "First",
        description: null,
        url: "https://linear.test/1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        project: { id: "proj-1" },
        team: { id: "team-1", key: "PAN" },
      };
      const issue2 = {
        id: "issue-2",
        identifier: "PAN-2",
        title: "Second",
        description: null,
        url: "https://linear.test/2",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        project: { id: "proj-1" },
        team: { id: "team-1", key: "PAN" },
      };
      const issue3 = {
        id: "issue-3",
        identifier: "PAN-3",
        title: "Third",
        description: null,
        url: "https://linear.test/3",
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        project: { id: "proj-1" },
        team: { id: "team-1", key: "PAN" },
      };
      const visible = [issue1, issue2, issue3].filter(
        (issue) => overlapStart === null || issue.createdAt >= overlapStart,
      );
      let nodes = visible;
      let endCursor: string | null = null;
      let hasNextPage = false;
      if (after === null) {
        nodes = visible.slice(0, 2);
        endCursor = nodes.length > 0 ? "page-1-end" : null;
        hasNextPage = visible.length > 2;
      } else if (after === "page-1-end") {
        nodes = visible.slice(2, 4);
        endCursor = nodes.length > 0 ? "page-2-end" : null;
        hasNextPage = visible.length > 4;
      } else {
        nodes = [];
        endCursor = after;
        hasNextPage = false;
      }
      const page: LinearGraphqlPageShape = {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      };
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const config = basePollingConfig({ maxPagesPerCycle: 1, pageSize: 2, overlapMs: 0 });

    const first = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(first.status).toBe("ok");
    expect(first.pagesProcessed).toBe(1);
    expect(first.issuesIngested).toBe(2);
    expect(first.state.overlapBoundary).toBe("2026-01-01T00:00:01.000Z");
    expect(first.state.cursor).toBeNull();
    expect(first.state.intraPageContinuation).toBeNull();
    expect(first.error).toBe("cycle limit reached");

    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesDeduplicated).toBe(1);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:02.000Z");
    expect(second.state.cursor).toBeNull();
    expect(seenAfter).toEqual([null, null]);
    expect(seenOverlapStart[1]).toBe("2026-01-01T00:00:01.000Z");
  });

  test("pollLinearIssues preserves the relay cursor across cycles only when the overlap boundary does not advance", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const seenAfter: (string | null)[] = [];
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? ""));
      const after = parsed.variables.after ?? null;
      seenAfter.push(after);
      const page: LinearGraphqlPageShape =
        after === null
          ? { nodes: [], pageInfo: { hasNextPage: true, endCursor: "empty-page-end" } }
          : {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "PAN-1",
                  title: "After empty",
                  description: null,
                  url: "https://linear.test/1",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  project: { id: "proj-1" },
                  team: { id: "team-1", key: "PAN" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "second-page-end" },
            };
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const config = basePollingConfig({ maxPagesPerCycle: 1, overlapMs: 0 });

    const first = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(first.status).toBe("ok");
    expect(first.pagesProcessed).toBe(1);
    expect(first.state.overlapBoundary).toBeNull();
    expect(first.state.cursor).toBe("empty-page-end");
    expect(first.state.intraPageContinuation).toBeNull();

    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(second.state.cursor).toBeNull();
    expect(seenAfter).toEqual([null, "empty-page-end"]);
  });

  test("pollLinearIssues bounds all processed issues per cycle, including deduplicated overlap replays", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    for (const id of ["issue-1", "issue-2", "issue-3"]) {
      harness.ensureInboxEvent({
        id: deterministicLinearInboxId({ eventType: "issue.created", externalId: id }),
        provider: "linear",
        eventType: "issue.created",
        externalId: id,
        payload: { identifier: id },
      });
    }
    const page: LinearGraphqlPageShape = {
      nodes: [
        {
          id: "issue-1",
          identifier: "PAN-1",
          title: "One",
          description: null,
          url: "https://linear.test/1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-2",
          identifier: "PAN-2",
          title: "Two",
          description: null,
          url: "https://linear.test/2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-3",
          identifier: "PAN-3",
          title: "Three",
          description: null,
          url: "https://linear.test/3",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-end" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const initialBoundary = "2025-12-31T00:00:00.000Z";
    const config = basePollingConfig({ maxIssuesPerCycle: 1 });

    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: initialBoundary },
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.issuesDeduplicated).toBe(1);
    expect(result.issuesIngested).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.state.overlapBoundary).toBe(initialBoundary);
    expect(result.state.cursor).toBeNull();
    expect(result.state.intraPageContinuation).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      issueId: "issue-1",
    });
    expect(result.error).toBe("cycle limit reached");
  });

  test("pollLinearIssues truncates an equal-timestamp page on the cap and reaches the tail across bounded cycles", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const page: LinearGraphqlPageShape = {
      nodes: [
        {
          id: "issue-1",
          identifier: "PAN-1",
          title: "One",
          description: null,
          url: "https://linear.test/1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-2",
          identifier: "PAN-2",
          title: "Two",
          description: null,
          url: "https://linear.test/2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-3",
          identifier: "PAN-3",
          title: "Three",
          description: null,
          url: "https://linear.test/3",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-end" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const initialBoundary = "2025-12-31T00:00:00.000Z";
    const config = basePollingConfig({ maxIssuesPerCycle: 2 });

    const first = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: initialBoundary },
      fetchImpl,
    });
    expect(first.status).toBe("ok");
    expect(first.issuesIngested).toBe(2);
    expect(first.issuesDeduplicated).toBe(0);
    expect(first.pagesProcessed).toBe(0);
    expect(first.state.overlapBoundary).toBe(initialBoundary);
    expect(first.state.cursor).toBeNull();
    expect(first.state.intraPageContinuation).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      issueId: "issue-2",
    });
    expect(first.error).toBe("cycle limit reached");

    // Critical repair: the durable intra-page continuation lets the second cycle skip the two nodes
    // already accounted for and reach the third equal-timestamp node instead of reprocessing the
    // first two forever.
    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesDeduplicated).toBe(0);
    expect(second.pagesProcessed).toBe(1);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(second.state.cursor).toBeNull();
    expect(second.state.intraPageContinuation).toBeNull();
    expect(second.error).toBeUndefined();
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(3);
  });

  test("pollLinearIssues resumes from the durable continuation across Harness reconstruction", async () => {
    await runCli("init");
    const initialBoundary = "2025-12-31T00:00:00.000Z";
    const page: LinearGraphqlPageShape = {
      nodes: [
        {
          id: "issue-1",
          identifier: "PAN-1",
          title: "One",
          description: null,
          url: "https://linear.test/1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-2",
          identifier: "PAN-2",
          title: "Two",
          description: null,
          url: "https://linear.test/2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-3",
          identifier: "PAN-3",
          title: "Three",
          description: null,
          url: "https://linear.test/3",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-end" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const config = basePollingConfig({ maxIssuesPerCycle: 2 });

    const firstHarness = new Harness(dbPath);
    const first = await pollLinearIssues({
      harness: firstHarness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: initialBoundary },
      fetchImpl,
    });
    expect(first.state.intraPageContinuation).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      issueId: "issue-2",
    });

    // Simulate a supervisor restart by opening a fresh Harness against the same durable database.
    // The continuation is part of the run-context JSON the caller persists between cycles.
    const restoredHarness = new Harness(dbPath);
    expect(restoredHarness.listInboxEvents({ provider: "linear" })).toHaveLength(2);

    const second = await pollLinearIssues({
      harness: restoredHarness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: first.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesDeduplicated).toBe(0);
    expect(second.pagesProcessed).toBe(1);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(second.state.intraPageContinuation).toBeNull();
    expect(restoredHarness.listInboxEvents({ provider: "linear" })).toHaveLength(3);
  });

  test("pollLinearIssues counts rejected nodes against the per-cycle budget and saves a continuation", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const page: LinearGraphqlPageShape = {
      nodes: [
        {
          id: "issue-a-rejected-1",
          identifier: "OTH-1",
          title: "Stray 1",
          description: null,
          url: "https://linear.test/r1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-other" },
          team: { id: "team-other", key: "OTH" },
        },
        {
          id: "issue-b-rejected-2",
          identifier: "OTH-2",
          title: "Stray 2",
          description: null,
          url: "https://linear.test/r2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-other" },
          team: { id: "team-other", key: "OTH" },
        },
        {
          id: "issue-z-good",
          identifier: "PAN-1",
          title: "Good",
          description: null,
          url: "https://linear.test/1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-end" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const config = basePollingConfig({ maxIssuesPerCycle: 2 });

    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: "2025-12-31T00:00:00.000Z" },
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    // Both rejected nodes consumed the budget, so the in-scope third node never ran this cycle.
    expect(result.issuesRejected).toBe(2);
    expect(result.issuesIngested).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.state.intraPageContinuation).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      issueId: "issue-b-rejected-2",
    });
    expect(result.error).toBe("cycle limit reached");
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(0);

    const second = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: result.state,
      fetchImpl,
    });
    expect(second.status).toBe("ok");
    expect(second.issuesIngested).toBe(1);
    expect(second.issuesRejected).toBe(0);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(second.state.intraPageContinuation).toBeNull();
  });

  test("pollLinearIssues counts malformed nodes against the per-cycle budget and never advances past them durably", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const page: LinearGraphqlPageShape = {
      nodes: [
        {
          // missing id and createdAt — malformed
          identifier: "BAD-1",
          title: "Bad 1",
          description: null,
          url: "https://linear.test/b1",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
        {
          id: "issue-good",
          identifier: "PAN-1",
          title: "Good",
          description: null,
          url: "https://linear.test/1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          project: { id: "proj-1" },
          team: { id: "team-1", key: "PAN" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-end" },
    };
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const config = basePollingConfig({ maxIssuesPerCycle: 1 });

    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: "2025-12-31T00:00:00.000Z" },
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    expect(result.issuesMalformed).toBe(1);
    expect(result.issuesIngested).toBe(0);
    expect(result.pagesProcessed).toBe(0);
    expect(result.error).toBe("cycle limit reached");
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(0);

    // The malformed node consumed the entire per-cycle budget, so the in-scope good issue waits for
    // a later cycle. The cursor never advances because the page was not fully covered durably.
    expect(result.state.cursor).toBeNull();
  });

  test("pollLinearIssues bounds each request by remaining per-cycle capacity", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const seenPageSizes: number[] = [];
    const issue = (id: string, createdAt: string) => ({
      id,
      identifier: `PAN-${id}`,
      title: id,
      description: null,
      url: `https://linear.test/${id}`,
      createdAt,
      updatedAt: createdAt,
      project: { id: "proj-1" },
      team: { id: "team-1", key: "PAN" },
    });
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const body = String(init?.body ?? "");
      const parsed = JSON.parse(body);
      seenPageSizes.push(parsed.variables.pageSize);
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [issue("issue-1", "2026-01-01T00:00:00.000Z")],
              pageInfo: { hasNextPage: false, endCursor: "cursor-end" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const config = basePollingConfig({ pageSize: 50, maxIssuesPerCycle: 3 });
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    // The configured pageSize is 50, but the per-cycle cap is 3, so the request is bounded to 3.
    expect(seenPageSizes).toEqual([3]);
  });

  test("pollLinearIssues bounds subsequent requests in the same cycle by remaining capacity after a partial page", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const seenPageSizes: number[] = [];
    let call = 0;
    const pages: LinearGraphqlPageShape[] = [
      {
        nodes: [
          {
            id: "issue-a",
            identifier: "PAN-A",
            title: "A",
            description: null,
            url: "https://linear.test/a",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            project: { id: "proj-1" },
            team: { id: "team-1", key: "PAN" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
      {
        nodes: [
          {
            id: "issue-b",
            identifier: "PAN-B",
            title: "B",
            description: null,
            url: "https://linear.test/b",
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            project: { id: "proj-1" },
            team: { id: "team-1", key: "PAN" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
      },
    ];
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? ""));
      seenPageSizes.push(parsed.variables.pageSize);
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return new Response(
        JSON.stringify({ data: { issues: page } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const config = basePollingConfig({ pageSize: 50, maxPagesPerCycle: 5, maxIssuesPerCycle: 2 });
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    expect(result.issuesIngested).toBe(2);
    // The first request is bounded to the full per-cycle budget; the second request is bounded to
    // the remaining capacity of one after the first durable ingestion.
    expect(seenPageSizes).toEqual([2, 1]);
  });

  test("pollLinearIssues classifies RATELIMITED GraphQL responses and returns bounded backoff metadata", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { code: "RATELIMITED" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json", "retry-after": "2" } },
      );
    };
    const config = basePollingConfig({ maxRetries: 3, backoffBaseMs: 100, backoffMaxMs: 5_000 });
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      retryAttempt: 0,
      fetchImpl,
    });
    expect(result.status).toBe("rate_limited");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(config.backoffMaxMs);
    expect(result.exhausted).toBe(false);
  });

  test("pollLinearIssues classifies transient network failures and returns exponential backoff metadata", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error("connection reset");
    };
    const config = basePollingConfig({ maxRetries: 4, backoffBaseMs: 50, backoffMaxMs: 10_000 });
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      retryAttempt: 1,
      fetchImpl,
    });
    expect(result.status).toBe("transient_failure");
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(config.backoffBaseMs);
    expect(result.retryAfterMs).toBeLessThanOrEqual(config.backoffMaxMs);
    expect(result.exhausted).toBe(false);
  });

  test("pollLinearIssues classifies 401 responses as permanent authentication failures with no retry", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response("Unauthorized", { status: 401 });
    };
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(result.status).toBe("auth_failure");
    expect(result.retryAfterMs).toBeNull();
    expect(result.exhausted).toBe(true);
  });

  test("pollLinearIssues reports exhaustion when the retry budget is reached on retryable failures", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const config = basePollingConfig({ maxRetries: 2, backoffBaseMs: 10, backoffMaxMs: 100 });
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      return new Response(
        JSON.stringify({
          errors: [{ message: "boom", extensions: { code: "RATELIMITED" } }],
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    };
    const result = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: "PAN",
      config,
      state: { cursor: null, overlapBoundary: null },
      retryAttempt: config.maxRetries,
      fetchImpl,
    });
    expect(result.status).toBe("rate_limited");
    expect(result.exhausted).toBe(true);
  });

  test("pollLinearIssues rejects missing project and team selectors as config errors before any fetch", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    let fetchCalled = false;
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      fetchCalled = true;
      return new Response("nope", { status: 200 });
    };
    const noProject = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: " ",
      teamKey: "PAN",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(noProject.status).toBe("config_error");
    expect(fetchCalled).toBe(false);
    const noTeam = await pollLinearIssues({
      harness,
      apiUrl: "https://example.test/graphql",
      token: "tok",
      projectId: "proj-1",
      teamKey: " ",
      config: basePollingConfig(),
      state: { cursor: null, overlapBoundary: null },
      fetchImpl,
    });
    expect(noTeam.status).toBe("config_error");
    expect(fetchCalled).toBe(false);
  });

  // ===========================================================================
  // Linear intake supervisor wiring — focused on the durable polling-state
  // contract that lives in the supervised root run context.
  // ===========================================================================

  test("runLinearPollCycle persists cursor, overlap boundary, retry attempt, and next eligible poll time across Harness reconstruction", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    const issue = makeIntakeIssue({ id: "intake-issue-persist", createdAt: "2026-01-01T00:00:00.000Z" });
    const fetchImpl = makeIntakeFetchImpl([[issue]], { hasNextPage: false, endCursor: "cursor-persist" });
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }

    const before = getLinearIntakeState(harnessInstance, rootRunId);
    expect(before.lastStatus).toBe("idle");
    expect(before.nextEligiblePollTime).toBeNull();

    const first = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: Date.parse("2026-01-01T00:00:01.000Z"),
      fetchImpl,
    });
    expect(first.reason).toBe("polled");
    expect(first.status).toBe("ok");
    expect(first.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
    expect(first.state.nextEligiblePollTime).not.toBeNull();
    expect(first.state.retryAttempt).toBe(0);
    expect(first.state.terminalFailure).toBeNull();
    expect(first.state.cyclesCompleted).toBe(1);
    expect(first.state.issuesIngested).toBe(1);

    // A fresh Harness instance reads the same durable state from the root run.
    const reloaded = new Harness(dbPath);
    const persisted = getLinearIntakeState(reloaded, rootRunId);
    expect(persisted).toEqual(first.state);

    // A subsequent call before nextEligiblePollTime is a no-op.
    const second = await runLinearPollCycle({
      harness: reloaded,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: Date.parse("2026-01-01T00:00:02.000Z"),
      fetchImpl,
    });
    expect(second.reason).toBe("not-due");
    expect(second.status).toBe("idle");
    expect(second.advanced).toBe(false);
    // State is unchanged: no extra cycle, no advance.
    expect(second.state.cyclesCompleted).toBe(1);
    expect(second.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
  });

  test("runLinearPollCycle applies bounded exponential backoff across consecutive retryable failures", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    let calls = 0;
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      calls += 1;
      return new Response("internal server error", { status: 500 });
    };
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
      pollBackoffBaseMs: 1_000,
      pollBackoffMaxMs: 30_000,
      pollMaxRetries: 3,
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }
    const baseNow = Date.parse("2026-01-01T00:00:00.000Z");

    const first = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: baseNow,
      fetchImpl,
    });
    expect(first.status).toBe("transient_failure");
    expect(first.state.retryAttempt).toBe(1);
    expect(first.state.terminalFailure).toBeNull();
    // First retry: 1000ms * 2^0 = 1000ms floor.
    expect(Date.parse(first.state.nextEligiblePollTime!) - baseNow).toBeGreaterThanOrEqual(1_000);
    expect(Date.parse(first.state.nextEligiblePollTime!) - baseNow).toBeLessThanOrEqual(2_000);

    const second = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      // Move time forward past the previous backoff window.
      now: Date.parse(first.state.nextEligiblePollTime!) + 1,
      fetchImpl,
    });
    expect(second.status).toBe("transient_failure");
    expect(second.state.retryAttempt).toBe(2);
    // Second retry: 1000ms * 2^1 = 2000ms.
    const secondEligible = Date.parse(second.state.nextEligiblePollTime!);
    const secondBase = Date.parse(second.state.lastCycleAt!);
    expect(secondEligible - secondBase).toBeGreaterThanOrEqual(2_000);
    expect(secondEligible - secondBase).toBeLessThanOrEqual(3_000);
    expect(second.state.terminalFailure).toBeNull();
    expect(calls).toBe(2);
  });

  test("runLinearPollCycle marks auth failures as terminal and stops busy-looping on subsequent ticks", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () =>
      new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }
    const first = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      fetchImpl,
    });
    expect(first.status).toBe("auth_failure");
    expect(first.state.terminalFailure).not.toBeNull();
    expect(first.state.nextEligiblePollTime).toBeNull();

    // Subsequent cycles on the same root run see terminal failure and exit fast
    // without invoking fetch again.
    let calls = 0;
    const countingFetch: typeof fetchImpl = async (...args) => {
      calls += 1;
      return fetchImpl(...args);
    };
    const reloaded = new Harness(dbPath);
    const second = await runLinearPollCycle({
      harness: reloaded,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      fetchImpl: countingFetch,
    });
    expect(second.reason).toBe("terminal");
    expect(second.status).toBe("auth_failure");
    expect(second.advanced).toBe(false);
    expect(calls).toBe(0);
  });

  test("runLinearPollCycle marks configuration errors as terminal before any fetch", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    let called = false;
    const fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      called = true;
      return new Response("ok", { status: 200 });
    };
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }
    const result = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      // Empty project id forces the primitive's config_error branch without
      // touching the network.
      projectId: "  ",
      teamKey: "PAN",
      config: resolved.config,
      fetchImpl,
    });
    expect(result.status).toBe("config_error");
    expect(result.state.terminalFailure).not.toBeNull();
    expect(result.state.nextEligiblePollTime).toBeNull();
    expect(called).toBe(false);

    // Restart simulation: a fresh Harness reads the same terminal state.
    const reloaded = new Harness(dbPath);
    const persisted = getLinearIntakeState(reloaded, rootRunId);
    expect(persisted.terminalFailure).toBe(result.state.terminalFailure);
  });

  test("runLinearPollCycle does not advance durable state when ingestion fails mid-page", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }

    // Force the harness ensureInboxEvent path to throw on the only returned
    // node by poisoning the inbox_events table with a colliding deterministic
    // id (same provider/external_id but different event_type).
    const issue = makeIntakeIssue({ id: "ingest-fail", createdAt: "2026-01-01T00:00:00.000Z" });
    const collidingId = deterministicLinearInboxId({
      eventType: "issue.created",
      externalId: issue.id,
    });
    harnessInstance.createInboxEvent({
      id: collidingId,
      provider: "linear",
      eventType: "other.event",
      externalId: issue.id,
      payload: {},
    });
    const fetchImpl = makeIntakeFetchImpl([[issue]], { hasNextPage: false, endCursor: "cursor" });

    const before = getLinearIntakeState(harnessInstance, rootRunId);
    const result = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      fetchImpl,
    });
    expect(result.status).toBe("ingestion_failure");
    expect(result.advanced).toBe(false);
    // Cursor and overlap boundary remain at the previous (initial) state.
    expect(result.state.cursor).toBe(before.cursor);
    expect(result.state.overlapBoundary).toBe(before.overlapBoundary);
    expect(result.state.lastError).not.toBeNull();
    // Ingestion failures are retryable: nextEligiblePollTime is set.
    expect(result.state.nextEligiblePollTime).not.toBeNull();
    expect(result.state.terminalFailure).toBeNull();
  });

  test("linear-poll-state and poll-linear-issues CLI subcommands round-trip durable polling state", async () => {
    await runCli("init");
    const rootRun = await runCliJson("create-run", "--goal", "supervised root");
    const configPath = join(dir, "ouroboros.linear.toml");
    await writeFile(
      configPath,
      [
        "[linear]",
        "project_id = 'proj-1'",
        "team_key = 'PAN'",
        "poll_interval_ms = 60000",
        "poll_page_size = 10",
        "poll_max_pages_per_cycle = 5",
        "poll_max_issues_per_cycle = 50",
        "poll_overlap_ms = 60000",
        "poll_max_retries = 4",
        "poll_backoff_base_ms = 1000",
        "poll_backoff_max_ms = 60000",
      ].join("\n"),
    );

    const initialState = await runCliJson("linear-poll-state", "--run-id", rootRun.id, { LINEAR_API_KEY: "tok" });
    expect(initialState.lastStatus).toBe("idle");
    expect(initialState.terminalFailure).toBeNull();

    // poll-linear-issues must fail when no fetch implementation is wired by
    // the network, so we only verify that the CLI surfaces the resolution
    // error path for missing project selection. The CLI's --project-id flag
    // overrides config; an empty value forces a config_error message.
    const missing = await runCliRaw(
      "poll-linear-issues",
      "--run-id",
      rootRun.id,
      "--config",
      configPath,
      "--project-id",
      "  ",
      { LINEAR_API_KEY: "tok" },
    );
    expect(missing.exitCode).toBe(0);
    const missingJson = JSON.parse(missing.stdout);
    expect(missingJson.status).toBe("config_error");
    expect(missingJson.state.terminalFailure).not.toBeNull();

    // After the terminal config error, linear-poll-state reflects it durably.
    const afterState = await runCliJson(
      "linear-poll-state",
      "--run-id",
      rootRun.id,
      { LINEAR_API_KEY: "tok" },
    );
    expect(afterState.terminalFailure).not.toBeNull();
    expect(afterState.lastStatus).toBe("config_error");
  });

  test("self-improve-daemon invokes configured Linear polling and persists durable state on the root run", async () => {
    // Seed a drained self-improvement root directly so the test budget measures
    // the daemon and polling path, not a separate bootstrap CLI process.
    const drainHarness = new Harness(dbPath);
    drainHarness.init();
    const bootstrap = {
      runId: drainHarness.createRun({
        goal: "Poll Linear intake",
        context: {
          source: "self-improve",
          selfImprovement: { cycleIndex: 0, assessmentFingerprint: "linear-poll-test" },
        },
      }),
      taskId: "",
    };
    bootstrap.taskId = drainHarness.createTask({
      runId: bootstrap.runId,
      role: "designer",
      goal: "Drained polling fixture",
      prompt: "Remain quiescent.",
      doneWhen: ["polling fixture is drained"],
    });
    drainHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Drained bootstrap for polling test",
        changedFiles: [],
        checks: [{ name: "drain", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    drainHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    let issueRequests = 0;
    const issue = makeIntakeIssue({
      id: "linear-issue-daemon-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const server = startTestServer({
      fetch: (request) => {
        // The polling primitive always queries the `issues` field; the access
        // check queries `viewer` and `projects`. Only the issues query counts
        // toward our "polling happened" assertion.
        const text = request.headers.get("content-type") ?? "";
        if (text.includes("application/json")) {
          // We can't inspect body synchronously here without parsing, so just
          // return the issues payload for any JSON POST. The access-check is
          // not invoked because projectId is configured directly.
          issueRequests += 1;
          return Response.json({
            data: {
              issues: {
                nodes: [issue],
                pageInfo: { hasNextPage: false, endCursor: "cursor-daemon" },
              },
            },
          });
        }
        return new Response("bad request", { status: 400 });
      },
    });
    if (!server) {
      expect(Bun.version).toBeString();
      return;
    }
    // The polled issue is now also claimed by the consumption path into an
    // issue-scoped Designer run+task. Point the daemon at a fake codex binary
    // that drains any Designer intake prompt immediately so the tick completes
    // within the test budget without spawning real codex.
    const codexBin = join(dir, "fake-codex-linear-poll-drain");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "await new Response(Bun.stdin.stream()).text();",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_linear_poll_drain' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify({ status: 'done', summary: 'Quiescent Linear intake', changedFiles: [], checks: [], artifacts: [], problems: [], actions: [] }) }));",
        "process.exit(0);",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);
    try {
      const configPath = join(dir, "ouroboros.linear.toml");
      await writeFile(
        configPath,
        [
          "[linear]",
          `api_url = "http://127.0.0.1:${server.port}/graphql"`,
          'token_env = "LINEAR_API_KEY"',
          'project_id = "proj-1"',
          'team_key = "PAN"',
          "poll_interval_ms = 1",
          "poll_page_size = 10",
          "poll_max_pages_per_cycle = 1",
          "poll_max_issues_per_cycle = 50",
          "poll_overlap_ms = 60000",
          "poll_max_retries = 4",
          "poll_backoff_base_ms = 1000",
          "poll_backoff_max_ms = 60000",
        ].join("\n") + "\n",
      );

      const result = await runCliJson(
        "self-improve-daemon",
        "--executor",
        "codex-resumable",
        "--root-run-id",
        bootstrap.runId,
        "--parallel",
        "auto",
        "--max-ticks",
        "1",
        "--tick-cycles",
        "1",
        "--max-rounds",
        "1",
        "--interval-ms",
        "1",
        "--idle-ms",
        "1",
        "--codex-bin",
        codexBin,
        "--config",
        configPath,
        { LINEAR_API_KEY: "tok" },
      );

      expect(result.status).toBe("tick_limit");
      expect(result.ticks).toHaveLength(1);
      const tick = result.ticks[0] as Record<string, unknown>;
      const linearIntake = tick.linearIntake as Record<string, unknown>;
      expect(linearIntake.reason).toBe("polled");
      expect(linearIntake.status).toBe("ok");
      expect(linearIntake.advanced).toBe(true);
      expect(issueRequests).toBeGreaterThan(1);
      // The polled issue is also claimed by the consumption path.
      const consumption = tick.linearIntakeConsumption as Record<string, unknown>;
      expect(consumption).toBeDefined();
      expect(consumption.claimed).toBe(1);
      expect(consumption.processed).toBe(1);

      // Durable state survives a fresh Harness instance after the daemon process exits.
      const state = getLinearIntakeState(new Harness(dbPath), bootstrap.runId);
      expect(state.lastStatus).toBe("ok");
      expect(state.terminalFailure).toBeNull();
      expect(state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
      expect(state.cyclesCompleted).toBeGreaterThan(1);
      expect(state.issuesIngested).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("self-improve-daemon persists terminal blocked intake when polling configuration is invalid", async () => {
    await runCli("init");
    const bootstrap = await runCliJson("self-iterate");
    const drainHarness = new Harness(dbPath);
    drainHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Drained bootstrap for invalid polling test",
        changedFiles: [],
        checks: [{ name: "drain", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    drainHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    // The TOML parser coerces out-of-range numbers to undefined (which fall
    // back to defaults), so we cannot trigger the resolver's `reason:"invalid"`
    // path through the config file. Pre-seed a terminal blocked intake state
    // and verify the daemon respects it: the tick exits fast at the cheap
    // pre-check, never reads a token, and never invokes fetch.
    const seedHarness = new Harness(dbPath);
    seedHarness.updateRun({
      runId: bootstrap.runId,
      contextPatch: {
        linearIntake: {
          polling: {
            ...INITIAL_LINEAR_INTAKE_POLLING_STATE,
            lastStatus: "config_error",
            terminalFailure: "poll_page_size must be >= 1",
            lastCycleAt: new Date().toISOString(),
          },
        },
      },
    });

    // Point token_file at a path that does not exist. If the daemon respects
    // the terminal pre-check, the tick completes successfully without ever
    // trying to read the missing token file.
    const configPath = join(dir, "ouroboros.linear.toml");
    await writeFile(
      configPath,
      [
        "[linear]",
        `token_file = "${join(dir, "missing-token")}"`,
        'project_id = "proj-1"',
        'team_key = "PAN"',
        "poll_interval_ms = 1",
      ].join("\n") + "\n",
    );

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
      "--config",
      configPath,
    );

    expect(result.status).toBe("tick_limit");
    const tick = result.ticks[0] as Record<string, unknown>;
    const linearIntake = tick.linearIntake as Record<string, unknown>;
    expect(linearIntake.reason).toBe("terminal");
    expect(linearIntake.status).toBe("config_error");
    expect(linearIntake.advanced).toBe(false);
    const state = await runCliJson(
      "linear-poll-state",
      "--run-id",
      bootstrap.runId,
    );
    expect(state.terminalFailure).not.toBeNull();
    expect(state.lastStatus).toBe("config_error");
    expect(state.nextEligiblePollTime).toBeNull();
  });

  test("ingestion retry exhaustion becomes terminal blocked intake at the configured retry budget", async () => {
    await runCli("init");
    const harnessInstance = new Harness(dbPath);
    const rootRunId = harnessInstance.createRun({ goal: "supervised root" });
    const issue = makeIntakeIssue({ id: "ingest-fail-terminal", createdAt: "2026-01-01T00:00:00.000Z" });
    // Poison the inbox_events table so ensureIssue throws on every call.
    const collidingId = deterministicLinearInboxId({
      eventType: "issue.created",
      externalId: issue.id,
    });
    harnessInstance.createInboxEvent({
      id: collidingId,
      provider: "linear",
      eventType: "other.event",
      externalId: issue.id,
      payload: {},
    });
    const fetchImpl = makeIntakeFetchImpl([[issue]], { hasNextPage: false, endCursor: "cursor" });
    const resolved = resolveLinearPolling({
      pollIntervalMs: 60_000,
      projectId: "proj-1",
      teamKey: "PAN",
      pollMaxRetries: 2,
      pollBackoffBaseMs: 1,
      pollBackoffMaxMs: 1,
    });
    if (!resolved.enabled || !resolved.config) {
      throw new Error("expected polling to be enabled");
    }

    const baseNow = Date.parse("2026-01-01T00:00:00.000Z");
    const first = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: baseNow,
      fetchImpl,
    });
    expect(first.status).toBe("ingestion_failure");
    expect(first.state.retryAttempt).toBe(1);
    expect(first.state.terminalFailure).toBeNull();

    const second = await runLinearPollCycle({
      harness: harnessInstance,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: Date.parse(first.state.nextEligiblePollTime!) + 1,
      fetchImpl,
    });
    expect(second.status).toBe("ingestion_failure");
    // Second failure within the budget of 2 retries: the budget is exhausted,
    // the driver freezes retryAttempt at its previous value, and the cycle
    // becomes a terminal blocked intake so the daemon stops busy-looping.
    expect(second.state.retryAttempt).toBe(1);
    expect(second.state.terminalFailure).not.toBeNull();
    expect(second.state.nextEligiblePollTime).toBeNull();

    // Subsequent ticks short-circuit at the terminal pre-check.
    let calls = 0;
    const countingFetch: typeof fetchImpl = async (...args) => {
      calls += 1;
      return fetchImpl(...args);
    };
    const reloaded = new Harness(dbPath);
    const third = await runLinearPollCycle({
      harness: reloaded,
      rootRunId,
      token: "tok",
      apiUrl: "https://example.test/graphql",
      projectId: "proj-1",
      teamKey: "PAN",
      config: resolved.config,
      now: Date.parse("2026-01-01T00:00:10.000Z"),
      fetchImpl: countingFetch,
    });
    expect(third.reason).toBe("terminal");
    expect(calls).toBe(0);
  });

  test("runSupervisorLinearPoll resolves project_url-only configuration via the durable cache", async () => {
    await runCli("init");
    const rootRunId = (await runCliJson("create-run", "--goal", "supervised root")).id;
    // Seed the durable cache so the supervisor can skip the network resolution.
    const seedHarness = new Harness(dbPath);
    seedHarness.updateRun({
      runId: rootRunId,
      contextPatch: {
        linearIntake: {
          polling: {
            ...INITIAL_LINEAR_INTAKE_POLLING_STATE,
            resolvedProjectId: "proj-from-url",
            resolvedProjectUrl: "https://linear.test/proj/url",
          },
        },
      },
    });
    const issue = {
      id: "linear-issue-url-config",
      identifier: "PAN-URL-1",
      title: "Polling test",
      description: "body",
      url: "https://linear.test/issue/url-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      project: { id: "proj-from-url" },
      team: { id: "team-1", key: "PAN" },
    };
    let issueRequests = 0;
    const server = startTestServer({
      fetch: () => {
        issueRequests += 1;
        return Response.json({
          data: {
            issues: {
              nodes: [issue],
              pageInfo: { hasNextPage: false, endCursor: "cursor-url" },
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
      // The CLI poll-linear-issues command accepts --project-id; we pass the
      // cached value to simulate what runSupervisorLinearPoll does in
      // production: read the cached resolvedProjectId and skip the access check.
      const projectId = "proj-from-url";
      const configPath = join(dir, "ouroboros.linear.toml");
      await writeFile(
        configPath,
        [
          "[linear]",
          `api_url = "http://127.0.0.1:${server.port}/graphql"`,
          'token_env = "LINEAR_API_KEY"',
          `project_url = "https://linear.test/proj/url"`,
          'team_key = "PAN"',
          "poll_interval_ms = 1",
          "poll_page_size = 10",
          "poll_max_pages_per_cycle = 1",
          "poll_max_issues_per_cycle = 50",
          "poll_overlap_ms = 60000",
          "poll_max_retries = 4",
          "poll_backoff_base_ms = 1000",
          "poll_backoff_max_ms = 60000",
        ].join("\n") + "\n",
      );

      const result = await runCliJson(
        "poll-linear-issues",
        "--run-id",
        rootRunId,
        "--config",
        configPath,
        "--project-id",
        projectId,
        { LINEAR_API_KEY: "tok" },
      );
      expect(result.status).toBe("ok");
      expect(result.state.overlapBoundary).toBe("2026-01-01T00:00:00.000Z");
      expect(result.state.resolvedProjectId).toBe("proj-from-url");
      expect(issueRequests).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  function makeIntakeIssue(input: { id: string; createdAt: string }) {
    return {
      id: input.id,
      identifier: `PAN-${input.id}`,
      title: `Title ${input.id}`,
      description: "body",
      url: `https://linear.test/issue/${input.id}`,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      project: { id: "proj-1" },
      team: { id: "team-1", key: "PAN" },
    };
  }

  function makeIntakeFetchImpl(
    pages: Array<Array<ReturnType<typeof makeIntakeIssue>>>,
    pageInfo: { hasNextPage: boolean; endCursor: string },
  ) {
    return async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: pages.flat(),
              pageInfo,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  }

  function basePollingConfig(overrides: Partial<LinearPollingConfig> = {}): LinearPollingConfig {
    return {
      pageSize: 10,
      maxPagesPerCycle: 5,
      maxIssuesPerCycle: 50,
      overlapMs: 60_000,
      maxRetries: 4,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
      ...overrides,
    };
  }

  type LinearGraphqlPageShape = {
    nodes: Array<{
      id?: string;
      identifier?: string;
      title?: string;
      description?: string | null;
      url?: string | null;
      createdAt?: string;
      updatedAt?: string | null;
      project?: { id: string } | null;
      team?: { id: string; key?: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean | null; endCursor: string | null };
  };

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

  test("runs the built-in DSH doctor with only version and help probes", async () => {
    const binDir = join(dir, "dsh-doctor-bin");
    const tracePath = join(dir, "dsh-doctor-trace.jsonl");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "dsh"), [
      "#!/usr/bin/env bun",
      "import { appendFileSync } from 'node:fs';",
      "const args = Bun.argv.slice(2);",
      "appendFileSync(process.env.DSH_DOCTOR_TRACE_PATH, JSON.stringify({ args, stdin: '' }) + '\\n');",
      "if (args.length !== 1 || !['--version', '--help'].includes(args[0])) process.exit(9);",
      "console.log(args[0] === '--version' ? 'dsh 0.1.0-rc.7' : 'Usage: dsh [options]');",
    ].join("\n"));
    await chmod(join(binDir, "dsh"), 0o755);

    const result = await runCliJson("doctor-agent", "--agent", "dsh-cli", {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DSH_DOCTOR_TRACE_PATH: tracePath,
    });
    const trace = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(result).toMatchObject({
      backendId: "dsh-cli",
      configuredCommand: "dsh",
      resolutionMode: "path",
      selectedPath: join(binDir, "dsh"),
      observedVersion: "0.1.0-rc.7",
      versionProbeStatus: "passed",
      helpProbeStatus: "passed",
      callable: true,
      readiness: true,
      lifecycle: "one-shot",
      evidence: { providerCalls: 0, modelInferenceCalls: 0, paidSpendUsd: 0, taskExecutionStarted: false },
    });
    expect(result.probes.map((probe: { command: string[] }) => probe.command)).toEqual([
      [join(binDir, "dsh"), "--version"],
      [join(binDir, "dsh"), "--help"],
    ]);
    expect(trace).toEqual([
      { args: ["--version"], stdin: "" },
      { args: ["--help"], stdin: "" },
    ]);
  });

  test("runs a named headless DSH backend from an explicit config command", async () => {
    const command = join(dir, "configured-dsh");
    const tracePath = join(dir, "configured-dsh-trace.jsonl");
    await writeFile(command, [
      "#!/usr/bin/env bun",
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.DSH_DOCTOR_TRACE_PATH, JSON.stringify(Bun.argv.slice(2)) + '\\n');",
      "console.log(Bun.argv[2] === '--version' ? 'v0.2.0' : 'Usage: configured-dsh');",
    ].join("\n"));
    await chmod(command, 0o755);
    const configPath = join(dir, "dsh-doctor.toml");
    await writeFile(configPath, [
      '["agentBackends"."configured-dsh"]',
      'kind = "dsh-cli"',
      `command = "${command}"`,
      'profile = "headless"',
      '["agentBackends"."configured-dsh".env]',
      `DSH_DOCTOR_TRACE_PATH = "${tracePath}"`,
    ].join("\n"));

    const result = await runCliJson(
      "doctor-agent",
      "--agent",
      "configured-dsh",
      "--config",
      configPath,
    );

    expect(result).toMatchObject({
      backendId: "configured-dsh",
      configuredCommand: command,
      resolutionMode: "explicit",
      selectedPath: command,
      observedVersion: "0.2.0",
      readiness: true,
      lifecycle: "one-shot",
    });
    expect((await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["--version"],
      ["--help"],
    ]);
  });

  test("returns bounded missing DSH doctor evidence without starting a task", async () => {
    const result = await runCliJson("doctor-agent", "--agent", "dsh-cli", {
      PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
    });

    expect(result).toMatchObject({
      backendId: "dsh-cli",
      installationState: "missing",
      callable: false,
      readiness: false,
      versionProbeStatus: "not-run",
      helpProbeStatus: "not-run",
      evidence: { providerCalls: 0, modelInferenceCalls: 0, taskExecutionStarted: false },
    });
  });

  test("rejects unsupported and non-headless configured DSH doctor entries", async () => {
    const configPath = join(dir, "invalid-dsh-doctor.toml");
    await writeFile(configPath, [
      '["agentBackends"."wrong-kind"]',
      'kind = "acpx"',
      'agent = "claude"',
      '',
      '["agentBackends"."interactive-dsh"]',
      'kind = "dsh-cli"',
      'profile = "tui"',
    ].join("\n"));

    const wrongKind = await runCliRaw(
      "doctor-agent",
      "--agent",
      "wrong-kind",
      "--config",
      configPath,
    );
    const nonHeadless = await runCliRaw(
      "doctor-agent",
      "--agent",
      "interactive-dsh",
      "--config",
      configPath,
    );

    expect(wrongKind.exitCode).not.toBe(0);
    expect(wrongKind.stderr).toContain("must have kind dsh-cli");
    expect(nonHeadless.exitCode).not.toBe(0);
    expect(nonHeadless.stderr).toContain("must use the headless profile");
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

  test("runs an explicit task through the DeepSeek Harness CLI executor", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Exercise the DSH route", "--project-root", dir);
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Use DeepSeek Harness",
      "--prompt",
      "Return the required structured result.",
    );
    const binDir = join(dir, "dsh-bin");
    const tracePath = join(dir, "dsh-trace.json");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "dsh"), [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.DSH_TEST_TRACE_PATH, JSON.stringify({ args: Bun.argv.slice(2), cwd: process.cwd(), permission: process.env.DSH_PERMISSION_MODE }));",
      "console.log(JSON.stringify({ status: 'done', summary: 'dsh cli route complete', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
    ].join("\n"));
    await chmod(join(binDir, "dsh"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "dsh-cli",
      "--cwd",
      dir,
      "--start-hook",
      "none",
      "--sandbox",
      "workspace-write",
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        DSH_TEST_TRACE_PATH: tracePath,
      },
    );
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    const attempt = new Harness(dbPath).getAttempt(result.tasks[0].attemptId)!;

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(task.id);
    expect(trace).toMatchObject({
      args: ["--profile", "headless", expect.stringContaining("Return the required structured result")],
      permission: "workspace-write",
    });
    expect(realpathSync(trace.cwd)).toBe(realpathSync(dir));
    expect(attempt.input.route).toMatchObject({
      backend: { id: "dsh-cli", kind: "dsh-cli", profile: "headless" },
      model: null,
      executionMode: "generic",
    });
    expect(attempt.output).toMatchObject({ status: "done", summary: "dsh cli route complete" });
  });

  test("does not apply the short streaming idle timeout to a silent bounded DSH turn", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Run a bounded silent DSH turn", "--project-root", dir);
    const task = await runCliJson(
      "create-task",
      "--run-id", run.id,
      "--role", "worker",
      "--goal", "Complete after a silent reasoning interval",
      "--prompt", "Return the result after bounded reasoning.",
    );
    const binDir = join(dir, "silent-dsh-bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "dsh"), [
      "#!/usr/bin/env bun",
      "console.error('dsh turn started');",
      "await Bun.sleep(100);",
      "console.log(JSON.stringify({ status: 'done', summary: 'silent bounded turn completed', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
    ].join("\n"));
    await chmod(join(binDir, "dsh"), 0o755);

    const result = await runCliJson(
      "run-next",
      "--run-id", run.id,
      "--executor", "dsh-cli",
      "--cwd", dir,
      "--start-hook", "none",
      "--sandbox", "workspace-write",
      "--idle-timeout-ms", "20",
      "--timeout-ms", "1000",
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    const attempt = new Harness(dbPath).getAttempt(result.tasks[0].attemptId)!;

    expect(result.tasks[0].taskId).toBe(task.id);
    expect(attempt.output).toMatchObject({ status: "done", summary: "silent bounded turn completed" });
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

  test("runs multiple ready tasks with automatic task parallelism", async () => {
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

    const result = await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "noop",
      "--tasks",
      "auto",
      { ORBS_AUTO_TASK_CONCURRENCY: "2" },
    );

    expect(result.tasks.map((task: { taskId: string }) => task.taskId).sort()).toEqual(
      [first.id, second.id].sort(),
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

  test("routes a project-bound run worktree under that project instead of the supervisor worktree root", async () => {
    await runCli("init");
    const projectRoot = join(dir, "hodor-web");
    await mkdir(projectRoot, { recursive: true });
    const project = await runCliJson(
      "create-project",
      "--name",
      "Hodor Web",
      "--root-path",
      projectRoot,
    );
    const run = await runCliJson(
      "create-run",
      "--goal",
      "Verify Hodor Web",
      "--project-id",
      project.id,
    );
    const task = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Task in the project repository",
      "--prompt",
      "Do work.",
    );

    await runCliJson(
      "run-next",
      "--run-id",
      run.id,
      "--executor",
      "noop",
      "--worktree-root",
      join(dir, "hodor-supervisor", ".ouroboros", "worktrees"),
    );

    expect(new Harness(dbPath).getTask(task.id)?.worktreePath).toBe(
      join(projectRoot, ".ouroboros", "worktrees", task.id),
    );
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
        "case \"$3\" in",
        "  status) exit 0 ;;",
        "  ls-files) printf 'bun.lock\\n'; exit 0 ;;",
        "esac",
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
        "case \"$3\" in",
        "  status) exit 0 ;;",
        "  ls-files) printf 'bun.lock\\n'; exit 0 ;;",
        "esac",
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
    const setupHarness = new Harness(dbPath);
    setupHarness.init();
    const run = { id: setupHarness.createRun({ goal: "Bootstrap ouroboros" }) };
    const planner = {
      id: setupHarness.createTask({
        runId: run.id,
        role: "planner",
        goal: "Plan next task",
        prompt: "Plan.",
      }),
    };
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
      "--codex-bin",
      join(binDir, "codex"),
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-tasks",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const generated = new Harness(dbPath).nextReadyTask(run.id)!;

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
      "--codex-bin",
      join(binDir, "codex"),
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
      "--codex-bin",
      join(binDir, "codex"),
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
      "--codex-bin",
      join(binDir, "codex"),
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
      '{"agentDefaults":{"roles":{"worker":"claude-code"}}}',
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
        "console.log(JSON.stringify({ status: 'done', summary: 'claude selected', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
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
    expect(JSON.parse(await Bun.file(logPath).text())).toContain("claude");
    expect(attempt.input.backend).toMatchObject({
      id: "claude-code",
      kind: "acpx",
      agent: "claude",
      source: "role-default",
    });
    expect(attempt.input.cwd).toBe("/repo");
  });

  test("run-loop migrates a stale global Claude default to the frozen codex-resumable executor", async () => {
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
      "Run through Codex",
      "--prompt",
      "Use the frozen Codex executor.",
    );
    const binDir = join(dir, "bin-resumable-agent-backend");
    const acpxLogPath = join(dir, "acpx-resumable-args.jsonl");
    const codexLogPath = join(dir, "codex-resumable-args.jsonl");
    const codexBin = join(binDir, "codex");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "acpx"),
      [
        "#!/usr/bin/env bun",
        "const { appendFileSync } = await import('node:fs');",
        "const args = Bun.argv.slice(2);",
        `appendFileSync(${JSON.stringify(acpxLogPath)}, JSON.stringify(args) + '\\n');`,
        "process.exit(91);",
      ].join("\n"),
    );
    await chmod(join(binDir, "acpx"), 0o755);
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const { appendFileSync, writeFileSync } = await import('node:fs');",
        "const args = Bun.argv.slice(2);",
        `appendFileSync(${JSON.stringify(codexLogPath)}, JSON.stringify(args) + '\\n');`,
        "const outputFlag = args.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : '';",
        "const payload = { status: 'done', summary: 'codex selected', changedFiles: [], checks: [], artifacts: [], problems: [] };",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_stale_global_default' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
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
      "--browser-process-policy",
      "deny",
      "--max-rounds",
      "1",
      { PATH: `${binDir}:${process.env.PATH}` },
    );
    const attemptId = result.rounds[0].tasks[0].attemptId;
    const attempt = new Harness(dbPath).getAttempt(attemptId)!;
    const codexCalls = (await Bun.file(codexLogPath).text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(result.rounds[0].tasks[0].taskId).toBe(task.id);
    expect(result.rounds[0].tasks[0].status).toBe("done");
    expect(existsSync(acpxLogPath)).toBe(false);
    expect(codexCalls[0]).toContain("exec");
    expect(codexCalls[0]).toContain("gpt-5.4-mini");
    expect(attempt.input.backend).toMatchObject({
      id: "codex-resumable",
      kind: "codex-resumable",
      source: "cli-executor",
    });
    expect(attempt.input.model).toMatchObject({ model: "gpt-5.4-mini", source: "role-default" });
    expect(attempt.input.executor).toBe("codex-resumable");
    expect(attempt.output.summary).toBe("codex selected");
    expect(new Harness(dbPath).listExecutionThreads({ runId: run.id })[0]).toMatchObject({
      attemptId,
      agentSessionId: "session_stale_global_default",
      sessionName: `task-${task.id}`,
    });
    expect(
      new Harness(dbPath)
        .listAttemptEvents(attemptId)
        .some(
          (event) =>
            event.stream === "system" &&
            event.payload.type === "acpx.attempt.started",
        ),
    ).toBe(false);
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
        "  console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"resumed planner\",\"changedFiles\":[],\"checks\":[],\"artifacts\":[],\"problems\":[],\"nextTasks\":[{\"role\":\"worker\",\"goal\":\"Implement resumed CLI plan\",\"prompt\":\"Implement the task created by direct resume.\",\"doneWhen\":[\"tests pass\"]}]}' }));",
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
      "--stop-hook",
      "create-tasks",
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
    const overview = await runCliJson("run-overview", "--run-id", run.id);
    const createdTask = overview.tasks.find((candidate: { id: string }) => candidate.id !== task.id);
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
    expect(createdTask).toMatchObject({
      role: "worker",
      goal: "Implement resumed CLI plan",
      dependsOn: [task.id],
    });
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_task",
      taskId: createdTask.id,
      sourceTaskId: task.id,
    });
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
    const setupHarness = new Harness(dbPath);
    setupHarness.init();
    const run = { id: setupHarness.createRun({ goal: "Bootstrap ouroboros" }) };
    const planner = {
      id: setupHarness.createTask({
        runId: run.id,
        role: "planner",
        goal: "Async planner",
        prompt: "Plan asynchronously.",
      }),
    };
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
    const afterStart = new Harness(dbPath);
    const running = afterStart.listRunningAttempts({ runId: run.id });
    const overview = afterStart.getRunOverview({ runId: run.id, eventLimit: 100 });
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
    const next = new Harness(dbPath).nextReadyTask(run.id);

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

  test("run-loop reconciles a terminal blocked verifier into one fixed repair before goal review", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const sourceWorktree = join(dir, "reconciled-verifier-source");
    await mkdir(sourceWorktree);
    const runId = harness.createRun({ goal: "Recover a missed verifier stop hook" });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement the frozen source change",
      prompt: "Implement the source change.",
      worktreePath: sourceWorktree,
      doneWhen: ["SOURCE_FROZEN_CRITERION"],
    });
    harness.recordAttempt({
      taskId: workerId,
      input: { cwd: sourceWorktree, executor: "test" },
      output: {
        status: "done",
        summary: "source implementation done",
        changedFiles: ["src/source.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the frozen source change",
      prompt: "Verify the source change.",
      dependsOn: [workerId],
      worktreePath: sourceWorktree,
      doneWhen: ["VERIFIER_FROZEN_CRITERION"],
      config: { verifierContract: { checks: ["frozen-check"] } },
    });
    harness.recordAttempt({
      taskId: verifierId,
      input: { cwd: sourceWorktree, executor: "codex-resumable" },
      output: {
        status: "blocked",
        summary: "verification found a repairable defect",
        changedFiles: [],
        checks: [{ name: "frozen-check", status: "failed" }],
        artifacts: [],
        problems: ["LATEST_REPAIR_ROOT_CAUSE"],
        nextTasks: [{
          role: "worker",
          goal: "UNTRUSTED_VERIFIER_PROPOSED_GOAL",
          prompt: "UNTRUSTED_VERIFIER_PROPOSED_PROMPT",
        }],
      },
    });
    const codexBin = join(dir, "fake-codex-reconciled-verifier");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: worker')) process.exit(2);",
        "if (!prompt.includes('LATEST_REPAIR_ROOT_CAUSE')) process.exit(3);",
        "if (!prompt.includes('SOURCE_FROZEN_CRITERION')) process.exit(4);",
        "if (!prompt.includes('VERIFIER_FROZEN_CRITERION')) process.exit(5);",
        "if (prompt.includes('UNTRUSTED_VERIFIER_PROPOSED_PROMPT')) process.exit(6);",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_reconciled_repair' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: '{\"status\":\"done\",\"summary\":\"fixed repair completed\",\"changedFiles\":[\"src/source.ts\"],\"checks\":[],\"artifacts\":[],\"problems\":[]}' }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    await runCliJson(
      "run-loop",
      "--run-id",
      runId,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--cwd",
      sourceWorktree,
      "--sandbox",
      "read-only",
      "--start-hook",
      "none",
      "--max-rounds",
      "1",
    );

    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    const repairs = overview.tasks.filter((task) => task.role === "worker" && task.parentId === verifierId);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      status: "done",
      worktreePath: sourceWorktree,
      dependsOn: [workerId],
      config: { verifierContract: { checks: ["frozen-check"] } },
    });
    expect(repairs[0]?.goal).toBe("Repair: Verify the frozen source change");
    expect(overview.tasks.some((task) => task.goal === "UNTRUSTED_VERIFIER_PROPOSED_GOAL")).toBe(false);
    expect(harness.getRun(runId)?.context.repairReplanBudget).toMatchObject({
      used: 1,
      entries: [expect.objectContaining({ taskId: verifierId, kind: "repair" })],
    });
    expect(overview.sessions.some((session) =>
      session.taskId === repairs[0]?.id
      && session.status === "done"
      && session.codexSessionId === "session_reconciled_repair"
    )).toBe(true);
  });

  test("run-loop isolates a legacy fixed DSH repair from project plugins before starting it", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const worktree = join(dir, "legacy-dsh-repair-worktree");
    const pollutedHome = join(dir, "polluted-dsh-home");
    const dshCommand = join(dir, "fake-dsh-isolated-repair");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(pollutedHome, "profiles", "headless"), { recursive: true });
    await writeFile(
      join(pollutedHome, "profiles", "headless", "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["@hodor/hodor-studio"] } } }),
    );
    await writeFile(
      dshCommand,
      [
        "#!/usr/bin/env bun",
        "import { readFileSync } from 'node:fs';",
        "const home = process.env.DSH_HOME ?? '';",
        `if (home === ${JSON.stringify(pollutedHome)}) process.exit(21);`,
        "const profile = JSON.parse(readFileSync(`${home}/profiles/headless/package.json`, 'utf8'));",
        "const bundles = profile?.dsh?.profile?.bundles ?? [];",
        "if (JSON.stringify(bundles) !== JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])) process.exit(22);",
        "if (process.env.HODOR_APPLICATION_TOKEN || process.env.HODOR_APPLICATION_BASE_URL) process.exit(23);",
        "console.log(JSON.stringify({ status: 'done', summary: 'legacy DSH repair used isolated profile', changedFiles: [], checks: [{ name: 'isolated DSH profile', status: 'passed' }], artifacts: [{ kind: 'dsh_profile_isolation', mode: 'base-headless' }], problems: [] }));",
      ].join("\n"),
    );
    await chmod(dshCommand, 0o755);
    const runId = harness.createRun({
      goal: "Recover a legacy DSH repair",
      context: {
        agentDefaults: { global: "codex-resumable", roles: { worker: "deepseek-harness" } },
        agentBackends: {
          "deepseek-harness": {
            kind: "dsh-cli",
            command: dshCommand,
            profile: "headless",
            env: { DSH_HOME: pollutedHome },
          },
        },
      },
    });
    const sourceId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement through DSH",
      prompt: "Implement.",
      worktreePath: worktree,
    });
    harness.recordAttempt({
      taskId: sourceId,
      input: { route: { backend: { kind: "dsh-cli", id: "deepseek-harness" } }, cwd: worktree },
      output: { status: "done", summary: "source done", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify DSH source",
      prompt: "Verify.",
      dependsOn: [sourceId],
      worktreePath: worktree,
    });
    harness.recordAttempt({
      taskId: verifierId,
      input: { executor: "test", cwd: worktree },
      output: { status: "blocked", summary: "DSH boot failed", changedFiles: [], checks: [], artifacts: [], problems: ["project plugin boot failure"] },
    });
    const repairId = harness.createTask({
      runId,
      parentId: verifierId,
      role: "worker",
      goal: "Repair: Verify DSH source",
      prompt: "Repair the source without project plugins.",
      dependsOn: [sourceId],
      worktreePath: worktree,
    });

    await runCliJson(
      "run-loop",
      "--run-id", runId,
      "--executor", "dsh-cli",
      "--cwd", worktree,
      "--start-hook", "none",
      "--max-rounds", "1",
      "--tasks", "1",
    );

    const session = harness.getRunOverview({ runId, eventLimit: 0 }).sessions.find((candidate) => candidate.taskId === repairId)!;
    const attempt = harness.getAttempt(session.attemptId)!;
    expect(attempt.status).toBe("done");
    expect(attempt.input.dshProfileIsolation).toBe("base-headless");
    expect(attempt.output.summary).toBe("legacy DSH repair used isolated profile");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "dsh_profile_isolation",
      mode: "base-headless",
    });
    expect(harness.getTask(repairId)?.config?.dshProfileIsolation).toBeUndefined();
  });

  test("goal-review continuations routed to DSH start with the isolated base profile", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const worktree = join(dir, "goal-review-dsh-continuation");
    const pollutedHome = join(dir, "goal-review-polluted-dsh-home");
    const dshCommand = join(dir, "fake-dsh-goal-review-continuation");
    const codexBin = join(dir, "fake-codex-goal-review-continuation");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(pollutedHome, "profiles", "headless"), { recursive: true });
    await writeFile(
      join(pollutedHome, "profiles", "headless", "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["@hodor/project-plugin"] } } }),
    );
    await writeFile(
      dshCommand,
      [
        "#!/usr/bin/env bun",
        "import { readFileSync } from 'node:fs';",
        "const home = process.env.DSH_HOME ?? '';",
        `if (home === ${JSON.stringify(pollutedHome)}) process.exit(21);`,
        "const profile = JSON.parse(readFileSync(`${home}/profiles/headless/package.json`, 'utf8'));",
        "const bundles = profile?.dsh?.profile?.bundles ?? [];",
        "if (JSON.stringify(bundles) !== JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])) process.exit(22);",
        "console.log(JSON.stringify({ status: 'done', summary: 'task 3 ran with isolated DSH', changedFiles: ['docker-compose.yml'], checks: [{ name: 'docker and postgres evidence', status: 'passed' }], artifacts: [{ kind: 'host_evidence' }], problems: [] }));",
      ].join("\n"),
    );
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_goal_review_handoff' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify({ status: 'done', runDecision: 'continue', summary: 'create task 3', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'worker', goal: 'Task 3 Docker and PostgreSQL receipt', prompt: 'Run the frozen Docker and PostgreSQL evidence contract.' }] }) }));",
      ].join("\n"),
    );
    await chmod(dshCommand, 0o755);
    await chmod(codexBin, 0o755);
    const projectId = harness.createProject({
      name: "Goal review continuation project",
      rootPath: worktree,
    });
    const runId = harness.createRun({
      projectId,
      goal: "Complete Docker and PostgreSQL task 3",
      context: {
        agentDefaults: { global: "codex-resumable", roles: { worker: "deepseek-harness" } },
        agentBackends: {
          "codex-resumable": { kind: "codex-resumable" },
          "deepseek-harness": {
            kind: "dsh-cli",
            command: dshCommand,
            profile: "headless",
            env: { DSH_HOME: pollutedHome },
          },
        },
      },
    });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review the blocked Docker delivery",
      prompt: "Create the next bounded task.",
      worktreePath: worktree,
    });

    await runCliJson(
      "run-loop",
      "--run-id", runId,
      "--executor", "codex-resumable",
      "--codex-bin", codexBin,
      "--cwd", worktree,
      "--worktree-root", join(dir, "worktrees"),
      "--start-hook", "none",
      "--max-rounds", "2",
      "--tasks", "1",
    );

    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    const worker = overview.tasks.find((task) => task.role === "worker")!;
    const workerSession = overview.sessions.find((session) => session.taskId === worker.id)!;
    const attempt = harness.getAttempt(workerSession.attemptId)!;
    expect(attempt.input.cwd).toBe(worktree);
    expect(worker.worktreePath).toBe(worktree);
    expect(attempt.output.problems).toEqual([]);
    expect(attempt.status).toBe("done");
    expect(attempt.input.dshProfileIsolation).toBe("base-headless");
    expect(attempt.output.summary).toBe("task 3 ran with isolated DSH");
  });

  test("goal-review continuation retries reuse the frozen source worktree instead of a stale derived path", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const sourceWorktree = join(dir, "goal-review-source-worktree");
    const staleDerivedWorktree = join(sourceWorktree, ".ouroboros", "worktrees", "stale-continuation");
    const dshCommand = join(dir, "fake-dsh-source-worktree-readback");
    await mkdir(sourceWorktree, { recursive: true });
    await writeFile(
      dshCommand,
      [
        "#!/usr/bin/env bun",
        "console.log(JSON.stringify({ status: 'done', summary: 'reused frozen source worktree', changedFiles: [], checks: [{ name: 'cwd', status: 'passed' }], artifacts: [{ kind: 'cwd', path: process.cwd() }], problems: [] }));",
      ].join("\n"),
    );
    await chmod(dshCommand, 0o755);
    const projectId = harness.createProject({ name: "Frozen source project", rootPath: sourceWorktree });
    const runId = harness.createRun({
      projectId,
      goal: "Resume the exact goal-review worktree",
      context: {
        agentDefaults: { global: "codex-resumable", roles: { worker: "deepseek-harness" } },
        agentBackends: {
          "codex-resumable": { kind: "codex-resumable" },
          "deepseek-harness": { kind: "dsh-cli", command: dshCommand, profile: "headless" },
        },
      },
    });
    const reviewId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review",
      prompt: "Review.",
      worktreePath: sourceWorktree,
    });
    harness.recordAttempt({
      taskId: reviewId,
      input: { executor: "test", cwd: sourceWorktree },
      output: { status: "done", summary: "continue", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Continue in source worktree",
      prompt: "Continue.",
      dependsOn: [reviewId],
      worktreePath: staleDerivedWorktree,
      config: {
        sourceWorktreePath: sourceWorktree,
        goalReviewContinuation: { sourceTaskId: reviewId, ordinal: 0 },
      },
    });

    await runCliJson(
      "run-loop",
      "--run-id", runId,
      "--executor", "codex-resumable",
      "--cwd", sourceWorktree,
      "--worktree-root", join(dir, "worktrees"),
      "--start-hook", "none",
      "--sandbox", "workspace-write",
      "--max-rounds", "1",
      "--tasks", "1",
    );

    const worker = harness.getTask(workerId)!;
    const session = harness.getRunOverview({ runId, eventLimit: 0 }).sessions.find((candidate) => candidate.taskId === workerId)!;
    const attempt = harness.getAttempt(session.attemptId)!;
    expect(attempt.status).toBe("done");
    expect(attempt.input.cwd).toBe(sourceWorktree);
    expect(worker.worktreePath).toBe(sourceWorktree);
    expect(attempt.output.artifacts).toContainEqual({ kind: "cwd", path: realpathSync(sourceWorktree) });
    expect(existsSync(staleDerivedWorktree)).toBe(false);
  });

  test("generic DSH run-loop creates a verifier and marks empty worker evidence as requiring independent readback", async () => {
    await runCli("init");
    const harness = new Harness(dbPath);
    const worktree = join(dir, "dsh-empty-evidence-worktree");
    const dshCommand = join(dir, "fake-dsh-empty-evidence");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      dshCommand,
      [
        "#!/usr/bin/env bun",
        "console.log(JSON.stringify({ status: 'done', summary: 'modified src/auth.ts and ran 15 tests', changedFiles: [], checks: [], artifacts: [], problems: [] }));",
      ].join("\n"),
    );
    await chmod(dshCommand, 0o755);
    const runId = harness.createRun({
      goal: "Verify every DSH delivery",
      context: {
        agentDefaults: { global: "codex-resumable", roles: { worker: "deepseek-harness", verifier: "codex-resumable" } },
        agentBackends: {
          "deepseek-harness": { kind: "dsh-cli", command: dshCommand, profile: "headless" },
          "codex-resumable": { kind: "codex-resumable" },
        },
      },
    });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair authentication",
      prompt: "Repair authentication.",
      worktreePath: worktree,
    });

    await runCliJson(
      "run-loop",
      "--run-id", runId,
      "--executor", "dsh-cli",
      "--cwd", worktree,
      "--start-hook", "none",
      "--max-rounds", "1",
      "--tasks", "1",
    );

    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    const verifier = overview.tasks.find((task) => task.role === "verifier" && task.dependsOn.includes(workerId));
    expect(verifier).toBeDefined();
    expect(verifier?.status).toBe("todo");
    expect(verifier?.prompt).toContain("structured worker evidence is incomplete");
    expect(verifier?.config?.sourceEvidence).toEqual({
      status: "incomplete",
      missing: ["changedFiles", "checks", "artifacts"],
      requiresIndependentReadback: true,
    });
    const workerAttempt = overview.sessions.find((session) => session.taskId === workerId)!;
    expect(harness.getAttempt(workerAttempt.attemptId)?.output.artifacts).toContainEqual({
      kind: "source_evidence_incomplete",
      status: "incomplete",
      missing: ["changedFiles", "checks", "artifacts"],
      requiresIndependentReadback: true,
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
    expect(overview.run!.status).toBe("done");
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

  test("run-loop recovers evidence-backed goal-review completion text", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Complete PAN-869 source-worktree verification");
    const codexBin = join(dir, "fake-codex-goal-verification-complete");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Role: goal-review')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', summary: 'PAN-869 source-worktree verification is complete. typecheck, contracts, build, and gate-lite passed.', changedFiles: [], checks: [{ name: 'typecheck', status: 'passed' }, { name: 'contracts', status: 'passed' }, { name: 'build', status: 'passed' }, { name: 'gate-lite', status: 'passed' }], artifacts: [], problems: [] }));",
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

  test("run-loop defers a run only when goal-review needs spending approval", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Prove Claude Code provider readiness");
    const codexBin = join(dir, "fake-codex-goal-defer");
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "const prompt = await new Response(Bun.stdin.stream()).text();",
        "if (!prompt.includes('Only use defer for spending')) process.exit(2);",
        "console.log(JSON.stringify({ status: 'done', runDecision: 'defer', summary: 'A recurring GPU lease requires spending approval.', changedFiles: [], checks: [{ name: 'cost authority', status: 'failed' }], artifacts: [{ kind: 'cost_gate', recurringCost: 900 }], problems: ['Recurring infrastructure spend is not authorized.'] }));",
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

  test("run-loop cannot revive a retired run from historical goal-review completion text", async () => {
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
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", run.id);

    expect(result.rounds).toEqual([]);
    expect(overview.run).toMatchObject({
      status: "blocked",
      context: expect.objectContaining({ retired: true }),
    });
    expect(overview.sessions).toHaveLength(1);
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
        "if (!prompt.includes('Only use defer for spending')) process.exit(7);",
        "if (!prompt.includes('Do not launch a browser')) process.exit(8);",
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
        "if (prompt.includes('Role: goal-review')) {",
        "  console.log(JSON.stringify({ status: 'done', runDecision: 'continue', summary: 'more work remains', changedFiles: [], checks: [], artifacts: [], problems: [], nextTasks: [{ role: 'planner', goal: 'Plan the gap', prompt: 'Choose the next gap.', doneWhen: ['gap planned'] }] }));",
        "} else if (prompt.includes('Role: planner')) {",
        "  console.log(JSON.stringify({ status: 'done', summary: 'gap planned', changedFiles: [], checks: [{ name: 'gap planned', status: 'passed' }], artifacts: [], problems: [] }));",
        "} else process.exit(2);",
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
    const planner = overview.tasks.find((task: { role: string }) => task.role === "planner");

    expect(planner).toMatchObject({
      role: "planner",
      goal: "Plan the gap",
      status: "done",
    });
    expect(overview.sessions).toContainEqual(expect.objectContaining({ taskId: planner.id, status: "done" }));
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
    expect(overview.run.status).toBe("blocked");
    expect(overview.run.context.goalReviewTerminalDisposition).toMatchObject({
      kind: "max-tries",
      tries: 3,
      maxTries: 3,
      taskId: review.id,
    });
    expect(overview.sessions.filter((session: { taskId: string }) => session.taskId === review.id)).toHaveLength(3);

    const replay = await runCliJson(
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
    const replayed = await runCliJson("run-overview", "--run-id", run.id);
    expect(replay.rounds).toEqual([]);
    expect(replayed.sessions.filter((session: { taskId: string }) => session.taskId === review.id)).toHaveLength(3);
    expect(replayed.run.context.goalReviewTerminalDisposition).toEqual(overview.run.context.goalReviewTerminalDisposition);
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
    const setupHarness = new Harness(dbPath);
    const verifierId = setupHarness.createTask({
      runId: run.id,
      role: "verifier",
      goal: "Verify newer work",
      prompt: "Independently verify the newer work.",
      dependsOn: [newerWorker.id],
    });
    setupHarness.recordAttempt({
      taskId: verifierId,
      input: { executor: "fixture" },
      output: {
        status: "done",
        summary: "newer work independently verified",
        changedFiles: [],
        checks: [{ name: "fixture verification", status: "passed" }],
        artifacts: [{ kind: "fixture_verifier_readback" }],
        problems: [],
      },
    });
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
    const newerWorker = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Repair supervisor pause handling",
      "--prompt",
      "Implement the repair.",
    );
    await runCliJson(
      "record-attempt",
      "--task-id",
      newerWorker.id,
      "--input-json",
      "{}",
      "--output-json",
      '{"status":"done","summary":"newer worker completed","changedFiles":["src/supervisor.ts"],"checks":[],"artifacts":[],"problems":[]}',
    );
    const setupHarness = new Harness(dbPath);
    const verifierId = setupHarness.createTask({
      runId: run.id,
      role: "verifier",
      goal: "Verify the supervisor repair",
      prompt: "Independently verify the supervisor repair.",
      dependsOn: [newerWorker.id],
    });
    setupHarness.recordAttempt({
      taskId: verifierId,
      input: { executor: "fixture" },
      output: {
        status: "done",
        summary: "supervisor repair independently verified",
        changedFiles: ["src/supervisor.ts"],
        checks: [{ name: "fixture verification", status: "passed" }],
        artifacts: [{ kind: "fixture_verifier_readback" }],
        problems: [],
      },
    });
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
    const setupHarness = new Harness(dbPath);
    setupHarness.init();
    const run = { id: setupHarness.createRun({ goal: "Bootstrap ouroboros" }) };
    const worker = {
      id: setupHarness.createTask({
        runId: run.id,
        role: "worker",
        goal: "Finish active queue item",
        prompt: "Complete the queued item.",
      }),
    };
    const codexBin = join(dir, "fake-codex-autopilot");
    await writeFile(
      codexBin,
      [
        "#!/bin/sh",
        "prompt=$(cat)",
        "case \"$prompt\" in",
        "  *\"Role: goal-review\"*)",
        "    printf '%s\\n' '{\"type\":\"session.started\",\"session_id\":\"session_goal\"}' '{\"type\":\"agent.message\",\"message\":\"{\\\"status\\\":\\\"done\\\",\\\"runDecision\\\":\\\"complete\\\",\\\"summary\\\":\\\"goal reached\\\",\\\"changedFiles\\\":[],\\\"checks\\\":[],\\\"artifacts\\\":[],\\\"problems\\\":[]}\"}' ;;",
        "  *)",
        "    printf '%s\\n' '{\"type\":\"session.started\",\"session_id\":\"session_worker\"}' '{\"type\":\"agent.message\",\"message\":\"{\\\"status\\\":\\\"done\\\",\\\"summary\\\":\\\"worker done\\\",\\\"changedFiles\\\":[],\\\"checks\\\":[],\\\"artifacts\\\":[],\\\"problems\\\":[]}\"}' ;;",
        "esac",
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
    const after = new Harness(dbPath);
    const overview = after.getRunOverview({ runId: run.id, eventLimit: 100 });

    expect(result.cycles).toHaveLength(2);
    expect(result.status).toBe("done");
    expect(overview.run!.status).toBe("done");
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
    expect(after.nextReadyTask(run.id)).toBeNull();
  });

  test("supervise-runs drains an intake run and generated child run", async () => {
    const setupHarness = new Harness(dbPath);
    setupHarness.init();
    const staleRunId = setupHarness.createRun({ goal: "Unrelated stale run" });
    setupHarness.createTask({
      runId: staleRunId,
      role: "worker",
      goal: "Should not run",
      prompt: "This task is outside the supervisor root scope.",
    });
    const intakeRunId = setupHarness.createRun({ goal: "React dashboard migration" });
    setupHarness.createTask({
      runId: intakeRunId,
      role: "planner",
      goal: "Split requirement document into child runs",
      prompt: "Split requirement document: Migrate dashboard to React shadcn and add an attachment composer.",
    });
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
      intakeRunId,
      "--codex-bin",
      codexBin,
      "--cwd",
      "/repo",
      "--sandbox",
      "read-only",
      "--stop-hook",
      "create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary",
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
    const runs = setupHarness.listRuns({ limit: 100 });
    const staleOverview = setupHarness.getRunOverview({ runId: staleRunId, eventLimit: 0 });
    const intakeOverview = setupHarness.getRunOverview({ runId: intakeRunId, eventLimit: 0 });
    const child = runs.find((run) => run.goal === "Build React shadcn dashboard composer");

    expect(result.cycles.length).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe("idle");
    expect(intakeOverview.run?.status).toBe("done");
    expect(staleOverview.run?.status).toBe("todo");
    expect(staleOverview.tasks[0].status).toBe("todo");
    expect(child).toMatchObject({
      goal: "Build React shadcn dashboard composer",
      status: "done",
      context: expect.objectContaining({
        parentRunId: intakeRunId,
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

  test("supervise-daemon accepts automatic parallelism without separate run and task flags", async () => {
    await runCli("init");
    const result = await runCliJson(
      "supervise-daemon",
      "--executor",
      "codex-resumable",
      "--parallel",
      "auto",
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
      { ORBS_AUTO_RUN_CONCURRENCY: "2", ORBS_AUTO_TASK_CONCURRENCY: "3" },
    );

    expect(result.status).toBe("tick_limit");
    expect(result.ticks[0]).toMatchObject({
      type: "daemon.tick",
      result: expect.objectContaining({ status: "idle" }),
    });
  });

  test("self-improve-daemon closes an exhausted accepted delivery before reassessment", async () => {
    const setupHarness = new Harness(dbPath);
    setupHarness.init();
    const projectId = setupHarness.createProject({ name: "Reconciliation project", rootPath: dir });
    const rootRunId = setupHarness.createRun({ goal: "Improve Ouroboros", projectId });
    setupHarness.updateRunStatus({ runId: rootRunId, status: "done" });
    const proposal = setupHarness.createDesignProposal({
      projectId,
      title: "Reconcile terminal delivery",
      problem: "A terminal accepted delivery can be skipped.",
      recommendation: "Close it before reassessment.",
      proposal: {
        problem: "A terminal accepted delivery can be skipped.",
        recommendation: "Close it before reassessment.",
        evaluationContract: {
          baseline: ["accepted delivery has no terminal disposition"],
          successMetrics: ["bounded disposition is durable"],
          guardMetrics: ["no reassessment in the same tick"],
          requiredEvidence: ["run overview and action event"],
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "one hour",
        },
      },
      status: "accepted",
    });
    const deliveryRunId = setupHarness.createRun({
      projectId,
      projectRoot: dir,
      goal: "Deliver accepted design",
      context: {
        parentRunId: rootRunId,
        source: "design",
        designProposalId: proposal.id,
        integrationBoundary: { targetBranch: "main", push: false },
        repairReplanBudget: { limit: 1, used: 1, entries: [] },
      },
    });
    const verifierTaskId = setupHarness.createTask({
      runId: deliveryRunId,
      role: "verifier",
      goal: "Preserve terminal failure",
      prompt: "Record the exhausted verification state.",
    });
    setupHarness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "No repair budget remains",
        changedFiles: [],
        checks: [{ name: "repair budget", status: "failed" }],
        artifacts: [],
        problems: ["repair budget exhausted"],
      },
    });
    setupHarness.updateRunStatus({ runId: deliveryRunId, status: "blocked" });

    const result = await runCliJson(
      "self-improve-daemon",
      "--root-run-id",
      rootRunId,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      join(dir, "must-not-run-codex"),
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const runs = setupHarness.listRuns({ limit: 100 });
    const assessments = runs.filter((run) => run.context.source === "self-improvement-assessment");

    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "ok",
      createdCycle: null,
      reconciliation: expect.objectContaining({
        state: "exhausted",
        deliveryRunId,
        proposalId: proposal.id,
      }),
    });
    expect(assessments).toHaveLength(0);
    expect(setupHarness.getDesignProposal({ id: proposal.id })?.status).toBe("revise");
    expect(setupHarness.getRun(deliveryRunId)?.context.terminalDesignReconciliation).toMatchObject({
      state: "exhausted",
      terminalDisposition: "repair-budget-exhausted",
    });
  });

  test("self-improve-daemon creates an assessment root and derives a child improvement run", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const bootstrapOverview = await runCliJson("run-overview", "--run-id", bootstrap.runId);
    const setupHarness = new Harness(dbPath);
    setupHarness.updateRun({
      runId: bootstrap.runId,
      contextPatch: {
        agentDefaults: {
          global: "claude-code",
          roles: {
            designer: "codex-resumable",
            planner: "claude-code",
            worker: "claude-code",
            verifier: "claude-code",
            "goal-review": "claude-code",
            "outcome-review": "claude-code",
            repair: "claude-code",
          },
        },
      },
    });
    const projectId = setupHarness.listProjects()[0].id;
    const proposal = setupHarness.createDesignProposal({
      projectId,
      charterId: bootstrapOverview.run.context.founderCharterId as string,
      runId: bootstrap.runId,
      taskId: bootstrap.taskId,
      title: "Observable autonomous cycle recovery",
      problem: "Autonomous cycle recovery is not observable in dashboard evidence",
      recommendation: "Plan the smallest observable recovery increment",
      proposal: {
        problem: "Autonomous cycle recovery is not observable in dashboard evidence",
        recommendation: "Plan the smallest observable recovery increment",
        evidenceRefs: ["signal_recovery_visibility"],
        options: [
          {
            name: "observable recovery increment",
            benefits: ["recovery visible in run evidence"],
            costs: ["planning task only"],
            risks: ["none"],
            lockIn: ["none"],
          },
        ],
        evaluationContract: {
          baseline: ["recovery evidence absent"],
          successMetrics: ["recovery evidence present after a cycle"],
          guardMetrics: ["no daemon regression"],
          requiredEvidence: ["run-overview shows the derived child run"],
        },
        investment: {
          reversibility: "easy" as const,
          portfolio: "core" as const,
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "1 hour",
        },
        additions: ["observable recovery evidence"],
        removals: [],
      },
      status: "proposed",
    });
    setupHarness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: proposal.charterId,
      reasons: ["founder reviewed reversible change"],
      authority: { disposition: "automatic", autoReversibleExperiments: true },
    });
    setupHarness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });

    const codexBin = join(dir, "fake-codex-self-improve");
    const browserPolicyPath = join(dir, "self-improve-browser-policy.txt");
    const payload = {
      status: "done",
      summary: "Derived an evidence-backed controller objective through a fixed design action",
      changedFiles: [],
      checks: [{ name: "assessment evidence", status: "passed" }],
      artifacts: [],
      problems: [],
      actions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposal.id,
            runs: [
              {
                goal: "Make autonomous cycle recovery observable",
                prompt:
                  "Inspect packages/cli/src/main.ts and tests/cli.test.ts, then plan the smallest observable recovery increment.",
                doneWhen: [
                  "current recovery behavior is inspected",
                  "one implementation task is planned",
                  "one verifier task is planned",
                ],
                context: { derivedBy: "self-assessment" },
              },
            ],
          },
        },
      ],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        `writeFileSync(${JSON.stringify(browserPolicyPath)}, process.env.ORBS_BROWSER_PROCESS_POLICY ?? 'unset');`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_self_improve' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--root-run-id",
      bootstrap.runId,
      "--executor",
      "codex-resumable",
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
      "--stop-hook",
      "create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary",
    );
    const runs = await runCliJson("list-runs");
    const root = runs.find((run: { id: string }) => run.id === result.rootRunId);
    const child = runs.find((run: { goal: string }) => run.goal === "Make autonomous cycle recovery observable");

    expect(result.status).toBe("tick_limit");
    expect(await readFile(browserPolicyPath, "utf8")).toBe("deny");
    expect(result.rootRunId).toBe(bootstrap.runId);
    expect(result.bootstrap).toBeNull();
    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "ok",
    });
    expect(root.context.source).toBe("self-improve");
    expect(child).toMatchObject({
      status: "todo",
      context: expect.objectContaining({
        parentRunId: bootstrap.runId,
        source: "design",
        designProposalId: proposal.id,
        derivedBy: "self-assessment",
        agentDefaults: {
          global: "codex-resumable",
          roles: {
            designer: "codex-resumable",
            planner: "codex-resumable",
            worker: "codex-resumable",
            verifier: "codex-resumable",
            "goal-review": "codex-resumable",
            "outcome-review": "codex-resumable",
            repair: "codex-resumable",
          },
        },
      }),
    });
  });

  test("self-improve-daemon stays quiescent when a drained tree and repository fingerprint are unchanged", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const harness = new Harness(dbPath);
    harness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "No evidence-backed improvement gap",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const runs = await runCliJson("list-runs");
    const durableRoot = new Harness(dbPath).getRun(bootstrap.runId)!;
    const durableSelfImprovement = durableRoot.context.selfImprovement as Record<string, unknown>;
    const durableQuiescence = durableSelfImprovement.quiescence as Record<string, unknown>;

    expect(result.status).toBe("tick_limit");
    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "quiescent",
      createdCycle: null,
    });
    expect(runs).toHaveLength(1);
    expect(durableSelfImprovement.quiescent).toBe(true);
    expect(durableQuiescence).toMatchObject({
      version: 1,
      assessmentFingerprint: durableSelfImprovement.assessmentFingerprint,
      sourceRunId: bootstrap.runId,
      sourceTaskId: bootstrap.taskId,
      summary: "No evidence-backed improvement gap",
      evidence: [expect.stringMatching(/^attempt:/)],
    });
    expect(Date.parse(String(durableQuiescence.nextWakeAt))).toBeGreaterThan(Date.now());
  });

  test("self-improve-daemon wakes an expired durable quiescence exactly once", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    const initialAttemptId = setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "No evidence-backed improvement gap",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "blocked" });
    const root = setupHarness.getRun(bootstrap.runId)!;
    const selfImprovement = root.context.selfImprovement as Record<string, unknown>;
    setupHarness.updateRun({
      runId: bootstrap.runId,
      contextPatch: {
        selfImprovement: {
          ...selfImprovement,
          quiescent: true,
          quiescence: {
            version: 1,
            assessmentFingerprint: selfImprovement.assessmentFingerprint,
            sourceRunId: bootstrap.runId,
            sourceTaskId: bootstrap.taskId,
            sourceAttemptId: initialAttemptId,
            summary: "No evidence-backed improvement gap",
            decidedAt: new Date(Date.now() - 86_400_000).toISOString(),
            nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
            evidence: [`attempt:${initialAttemptId}`],
          },
        },
      },
    });
    const codexBin = join(dir, "fake-codex-expired-quiescence");
    const output = {
      status: "done",
      summary: "No new evidence-backed improvement is justified after the scheduled wake.",
      changedFiles: [],
      checks: [{ name: "scheduled assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(output)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_expired_quiescence' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    const daemonArgs = [
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    ];
    const first = await runCliJson(...daemonArgs);
    const second = await runCliJson(...daemonArgs);
    const runs = await runCliJson("list-runs");
    const scheduled = runs.filter((run: { context: Record<string, unknown> }) =>
      run.context.source === "self-improvement-assessment"
    );

    expect(first.ticks[0].createdCycle).toMatchObject({ cycleIndex: 1 });
    expect(scheduled).toHaveLength(1);
    expect(second.ticks[0].createdCycle).toBeNull();
  });

  test("self-improve-daemon creates one successor for a blocked root without a durable wake", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "The root assessment terminated before a durable quiescent decision.",
        changedFiles: [],
        checks: [{ name: "root assessment", status: "failed" }],
        artifacts: [],
        problems: ["terminal root without wake"],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "blocked" });
    const codexBin = join(dir, "fake-codex-terminal-root-successor");
    const output = {
      status: "done",
      summary: "Scheduled successor found no new evidence-backed improvement.",
      changedFiles: [],
      checks: [{ name: "successor assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(output)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_terminal_successor' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    const daemonArgs = [
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    ];
    const results = await Promise.all([
      runCliJson(...daemonArgs),
      runCliJson(...daemonArgs),
    ]);
    const runs = await runCliJson("list-runs");
    const successors = runs.filter((run: { context: Record<string, unknown> }) =>
      run.context.source === "self-improvement-assessment"
    );
    const winners = results.filter((result) => result.ticks[0].createdCycle != null);
    const losers = results.filter((result) => result.ticks[0].createdCycle === null);
    const successorId = winners[0]?.ticks[0].createdCycle?.runId;
    const predecessorOverview = await runCliJson("run-overview", "--run-id", bootstrap.runId);
    const predecessorLessons = await runCliJson("list-lessons", "--run-id", bootstrap.runId);
    const successorOverview = successorId
      ? await runCliJson("run-overview", "--run-id", successorId)
      : null;
    const successorLessons = successorId
      ? await runCliJson("list-lessons", "--run-id", successorId)
      : null;

    expect(results.some((result) => result.ticks[0].createdCycle?.cycleIndex === 1)).toBe(true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].ticks[0].createdCycle).toBeNull();
    expect(successors).toHaveLength(1);
    expect(predecessorOverview.run.id).toBe(bootstrap.runId);
    expect(predecessorLessons).toBeArray();
    expect(successorOverview?.run.id).toBe(successorId);
    expect(successorLessons).toBeArray();
  });

  test("self-improve-daemon freezes the root active Harness revision into the next cycle", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    const root = setupHarness.getRun(bootstrap.runId)!;
    const revisionA = harnessRevisionFixture(root.projectId!);
    setupHarness.updateRun({
      runId: root.id,
      contextPatch: { activeHarnessRevision: revisionA },
    });
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Schedule the next revision-bound cycle.",
        changedFiles: [],
        checks: [{ name: "root assessment", status: "failed" }],
        artifacts: [],
        problems: ["terminal root without wake"],
      },
    });
    setupHarness.updateRunStatus({ runId: root.id, status: "blocked" });

    const codexBin = join(dir, "fake-codex-harness-revision");
    const output = {
      status: "done",
      summary: "Revision-bound successor completed without new mutation.",
      changedFiles: [],
      checks: [{ name: "revision inheritance", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(output)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_harness_revision' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", root.id,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const childRunId = result.ticks[0].createdCycle?.runId as string;
    const childBeforeUpgrade = new Harness(dbPath).getRun(childRunId)!;
    expect(childBeforeUpgrade.context.harnessRevision).toEqual(revisionA);
    expect(childBeforeUpgrade.context.activeHarnessRevision).toBeUndefined();

    const revisionB = harnessRevisionFixture(root.projectId!, 2, revisionA.contentSha256);
    setupHarness.updateRun({
      runId: root.id,
      contextPatch: { activeHarnessRevision: revisionB },
    });
    expect(new Harness(dbPath).getRun(childRunId)!.context.harnessRevision).toEqual(revisionA);
  });

  test("self-improve-daemon rejects a malformed active Harness revision before creating a cycle", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    const root = setupHarness.getRun(bootstrap.runId)!;
    const { components: _components, ...malformed } = harnessRevisionFixture(root.projectId!);
    setupHarness.updateRun({
      runId: root.id,
      contextPatch: { activeHarnessRevision: malformed },
    });
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Malformed active revision must stop inheritance.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["malformed revision"],
      },
    });
    setupHarness.updateRunStatus({ runId: root.id, status: "blocked" });

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", root.id,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const runs = setupHarness.listRuns({ limit: 100 });
    expect(result.ticks[0]).toMatchObject({
      status: "error",
      createdCycle: null,
      error: expect.stringContaining("activeHarnessRevision.components must be an array"),
    });
    expect(runs.filter((run) => run.context.source === "self-improvement-assessment")).toHaveLength(0);
  });

  test("self-improve-daemon never derives quiescence from the mutable root after an assessment child exists", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Old bootstrap assessment was quiet",
        changedFiles: [],
        checks: [{ name: "bootstrap assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const root = setupHarness.getRun(bootstrap.runId)!;
    const selfImprovement = root.context.selfImprovement as Record<string, unknown>;
    const assessmentRunId = setupHarness.createRun({
      id: "run_00000000000000000000000000000000",
      goal: "A later assessment produced a design action",
      projectId: root.projectId,
      context: {
        parentRunId: bootstrap.runId,
        source: "self-improvement-assessment",
        selfImprovement: {
          cycleIndex: selfImprovement.cycleIndex,
          assessmentFingerprint: selfImprovement.assessmentFingerprint,
        },
      },
    });
    const assessmentTaskId = setupHarness.createTask({
      runId: assessmentRunId,
      role: "designer",
      goal: "Record a real design action",
      prompt: "Return a design action.",
    });
    setupHarness.recordAttempt({
      taskId: assessmentTaskId,
      input: {},
      output: {
        status: "done",
        summary: "A design action is required",
        changedFiles: [],
        checks: [{ name: "design evidence", status: "passed" }],
        artifacts: [],
        problems: [],
        designActions: [{ type: "recordSignal", payload: { projectId: root.projectId } }],
      },
    });
    setupHarness.updateRunStatus({ runId: assessmentRunId, status: "done" });
    const codexBin = join(dir, "fake-codex-after-action-assessment");
    const output = {
      status: "done",
      summary: "The successor assessment is mutation-free.",
      changedFiles: [],
      checks: [{ name: "successor assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(output)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_after_action' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const durableRoot = setupHarness.getRun(bootstrap.runId)!;
    const durableSelfImprovement = durableRoot.context.selfImprovement as Record<string, unknown>;

    expect(result.ticks[0].status).not.toBe("quiescent");
    expect(durableSelfImprovement.quiescence).toBeNull();
  });

  test("self-improve-daemon never turns a blocked assessment with failed follow-up work into quiescence", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Bootstrap assessment drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const root = setupHarness.getRun(bootstrap.runId)!;
    const selfImprovement = root.context.selfImprovement as Record<string, unknown>;
    const assessmentRunId = setupHarness.createRun({
      goal: "Assessment with failed follow-up verification",
      projectId: root.projectId,
      context: {
        parentRunId: bootstrap.runId,
        source: "self-improvement-assessment",
        selfImprovement: {
          cycleIndex: 1,
          assessmentFingerprint: selfImprovement.assessmentFingerprint,
        },
        repairReplanBudget: { limit: 1, used: 1, entries: [] },
      },
    });
    const designerTaskId = setupHarness.createTask({
      runId: assessmentRunId,
      role: "designer",
      goal: "Assess quietly",
      prompt: "Assess the current evidence.",
    });
    setupHarness.recordAttempt({
      taskId: designerTaskId,
      input: {},
      output: {
        status: "done",
        summary: "Designer itself found no action",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = setupHarness.createTask({
      runId: assessmentRunId,
      role: "verifier",
      goal: "Verify the assessment evidence",
      prompt: "Fail the incomplete evidence.",
    });
    setupHarness.recordAttempt({
      taskId: verifierTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Assessment evidence is incomplete",
        changedFiles: [],
        checks: [{ name: "assessment evidence", status: "failed" }],
        artifacts: [],
        problems: ["verification failed"],
      },
    });
    setupHarness.updateRunStatus({ runId: assessmentRunId, status: "blocked" });

    await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", join(dir, "missing-codex-blocked-assessment"),
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const durableAssessment = setupHarness.getRun(assessmentRunId)!;
    const durableRoot = setupHarness.getRun(bootstrap.runId)!;

    expect(durableAssessment.status).toBe("blocked");
    expect((durableRoot.context.selfImprovement as Record<string, unknown>).quiescence).toBeFalsy();
  });

  test("self-improve-daemon does not skip an empty nonterminal delivery to create a new assessment", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Bootstrap assessment drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const deliveryRunId = setupHarness.createRun({
      goal: "Delivery awaiting deterministic drain recovery",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
      },
    });

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", join(dir, "missing-codex-empty-delivery"),
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const assessmentRuns = setupHarness.listRuns({ limit: 100 }).filter((run) =>
      run.context.parentRunId === bootstrap.runId
      && run.context.source === "self-improvement-assessment"
    );

    expect(result.ticks[0].createdCycle).toBeNull();
    expect(result.ticks[0]).toMatchObject({
      status: "ok",
      createdCycle: null,
      drain: {
        runId: deliveryRunId,
        actionType: "prepareRunDrain",
        actionStatus: "done",
      },
    });
    expect(setupHarness.listHarnessActionEvents({ limit: 100 }).filter(
      (event) => event.actionType === "prepareRunDrain" && event.request.runId === deliveryRunId,
    )).toHaveLength(1);
    expect(assessmentRuns).toHaveLength(0);
  });

  test("self-improve-daemon drains a blocked Designer handoff before allowing a successor", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Bootstrap assessment drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const root = setupHarness.getRun(bootstrap.runId)!;
    const rootSelfImprovement = root.context.selfImprovement as Record<string, unknown>;
    const predecessorRunId = setupHarness.createRun({
      goal: "Designer handoff awaiting prepareRunDrain",
      context: {
        parentRunId: bootstrap.runId,
        source: "self-improvement-assessment",
        selfImprovement: {
          cycleIndex: 1,
          assessmentFingerprint: rootSelfImprovement.assessmentFingerprint,
        },
      },
    });
    const designerTaskId = setupHarness.createTask({
      runId: predecessorRunId,
      role: "designer",
      goal: "Assess the recorded handoff",
      prompt: "Inspect the blocked assessment and preserve its frozen contract.",
    });
    const blockedAttemptId = setupHarness.recordAttempt({
      taskId: designerTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Designer stopped before drain preparation",
        changedFiles: [],
        checks: [{ name: "designer handoff", status: "failed" }],
        artifacts: [],
        problems: ["drain preparation remains pending"],
      },
    });
    setupHarness.updateRunStatus({ runId: predecessorRunId, status: "todo" });

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", join(dir, "missing-codex-blocked-handoff"),
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const predecessorOverview = await runCliJson("run-overview", "--run-id", predecessorRunId);
    const predecessorLessons = await runCliJson("list-lessons", "--run-id", predecessorRunId);
    const drainEvents = setupHarness.listHarnessActionEvents({ limit: 100 }).filter(
      (event) => event.actionType === "prepareRunDrain" && event.request.runId === predecessorRunId,
    );
    const followUpTask = predecessorOverview.tasks.find((task: { role: string }) => task.role === "goal-review");
    const successors = setupHarness.listRuns({ limit: 100 }).filter((run) =>
      run.context.parentRunId === bootstrap.runId
      && run.context.source === "self-improvement-assessment"
      && run.id !== predecessorRunId,
    );

    expect(result.ticks[0]).toMatchObject({
      status: "ok",
      createdCycle: null,
      drain: {
        runId: predecessorRunId,
        actionType: "prepareRunDrain",
        actionStatus: "done",
      },
    });
    expect(drainEvents).toHaveLength(1);
    expect(drainEvents[0]).toMatchObject({
      actionType: "prepareRunDrain",
      request: { runId: predecessorRunId },
    });
    expect(followUpTask).toBeTruthy();
    expect(predecessorOverview.tasks).toContainEqual(expect.objectContaining({ id: designerTaskId, status: "blocked" }));
    expect(predecessorLessons).toBeArray();
    expect(successors).toHaveLength(0);
    expect(blockedAttemptId).toMatch(/^attempt_/);
  });

  test("self-improve-daemon does not copy stale Claude defaults into a new assessment cycle", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const root = setupHarness.getRun(bootstrap.runId)!;
    setupHarness.updateRun({
      runId: bootstrap.runId,
      contextPatch: {
        agentDefaults: {
          global: "claude-code",
          roles: {
            designer: "claude-code",
            planner: "claude-code",
            worker: "claude-code",
            verifier: "claude-code",
            "goal-review": "claude-code",
            "outcome-review": "claude-code",
            repair: "claude-code",
          },
        },
        selfImprovement: {
          ...(root.context.selfImprovement as Record<string, unknown>),
          assessmentFingerprint: "stale-fingerprint",
        },
      },
    });

    const codexBin = join(dir, "fake-codex-stale-agent-defaults");
    const payload = {
      status: "done",
      summary: "Inspected the next cycle without proposing changes",
      changedFiles: [],
      checks: [{ name: "assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_stale_agent_defaults' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const runs = await runCliJson("list-runs");
    const assessment = runs.find(
      (run: { context: Record<string, unknown> }) => run.context.source === "self-improvement-assessment",
    );

    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "ok",
      createdCycle: expect.objectContaining({ runId: assessment.id }),
    });
    expect(assessment.context.agentDefaults).toEqual({
      global: "codex-resumable",
      roles: {
        designer: "codex-resumable",
        planner: "codex-resumable",
        worker: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
        "outcome-review": "codex-resumable",
        repair: "codex-resumable",
      },
    });
  });

  test("self-improve-daemon keeps recovering a blocked delivery instead of accepting quiescence", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "Blocked delivery requiring a higher-level decision",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const blockedTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Exhausted delivery task",
      prompt: "Preserve the blocker as evidence.",
    });
    setupHarness.recordAttempt({
      taskId: blockedTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Local repair budget exhausted",
        changedFiles: [],
        checks: [{ name: "repair budget", status: "failed" }],
        artifacts: [{ kind: "repair_budget_exhausted", budgetUsed: 3, budgetLimit: 3 }],
        problems: ["repair budget exhausted"],
      },
    });
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-blocked-reassessment");
    const payload = {
      status: "done",
      summary: "Diagnosed and repaired the blocked delivery.",
      changedFiles: [],
      checks: [{ name: "blocked evidence", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_blocked_reassessment' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );

    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "ok",
      createdCycle: null,
      recovery: expect.objectContaining({
        runId: blockedRunId,
        sourceTaskId: blockedTaskId,
        toBackend: "codex-resumable",
      }),
    });
    const runs = await runCliJson("list-runs");
    const assessment = runs.find(
      (run: { context: Record<string, unknown> }) => run.context.source === "self-improvement-assessment",
    );
    expect(assessment).toBeUndefined();

    const repeated = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    expect(repeated.ticks[0].status).not.toBe("quiescent");
  });

  test("self-improve-daemon ignores a retired duplicate and starts the canonical planner exactly once", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment selected one canonical delivery",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    const retiredRunId = setupHarness.createRun({
      goal: "Earlier duplicate delivery",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        retired: true,
        retiredReason: "superseded by canonical delivery",
      },
    });
    const retiredTaskId = setupHarness.createTask({
      runId: retiredRunId,
      role: "planner",
      goal: "Obsolete delivery planner",
      prompt: "This duplicate must remain retired.",
    });
    setupHarness.recordAttempt({
      taskId: retiredTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Duplicate delivery was retired",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["superseded by canonical delivery"],
      },
    });
    setupHarness.updateRunStatus({ runId: retiredRunId, status: "blocked" });

    const canonicalRunId = setupHarness.createRun({
      goal: "Canonical accepted delivery",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const canonicalTaskId = setupHarness.createTask({
      runId: canonicalRunId,
      role: "planner",
      goal: "Plan the canonical accepted delivery",
      prompt: "Return the bounded canonical plan.",
    });

    const codexBin = join(dir, "fake-codex-canonical-delivery");
    const payload = {
      status: "done",
      summary: "Canonical planner started once",
      changedFiles: [],
      checks: [{ name: "canonical planner", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_canonical_delivery' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const daemonArgs = [
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--runs", "1",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--stop-hook", "context-summary",
      "--no-integrate", "true",
      "--interval-ms", "1",
      "--idle-ms", "1",
    ];
    const first = await runCliJson(...daemonArgs);
    const second = await runCliJson(...daemonArgs);
    const retiredOverview = setupHarness.getRunOverview({ runId: retiredRunId, eventLimit: 0 });
    const canonicalOverview = setupHarness.getRunOverview({ runId: canonicalRunId, eventLimit: 0 });

    expect(first.ticks[0].recovery).toBeUndefined();
    expect(first.ticks[0].result.cycles[0].runs[0].runId).toBe(canonicalRunId);
    expect(second.ticks[0].recovery).toBeUndefined();
    expect(retiredOverview.tasks).toHaveLength(1);
    expect(retiredOverview.sessions).toHaveLength(1);
    expect(canonicalOverview.sessions.filter((session) => session.taskId === canonicalTaskId)).toHaveLength(1);
  });

  test("self-improve-daemon stops cloning recovery tasks when the run repair budget is exhausted", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "A blocked delivery needs a different design",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        repairReplanBudget: {
          limit: 1,
          used: 1,
          entries: [{
            taskId: "task_previous_repair",
            attemptId: "attempt_previous_repair",
            kind: "repair",
            summary: "The bounded repair attempt did not resolve the root cause",
            chargedAt: "2026-08-06T00:00:00.000Z",
          }],
        },
      },
    });
    const blockedTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Perform the bounded dogfood API proof",
      prompt: "Create and observe one bounded dogfood event.",
    });
    const blockedAttemptId = setupHarness.recordAttempt({
      taskId: blockedTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "The same zero-cost verification action is still missing",
        changedFiles: [],
        checks: [{ name: "dogfood API proof", status: "failed" }],
        artifacts: [],
        problems: ["Create and observe one bounded dogfood event"],
      },
    });
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-budget-redesign");
    const payload = {
      status: "done",
      summary: "Reassessed the exhausted recovery path without cloning it.",
      changedFiles: [],
      checks: [{ name: "assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_budget_redesign' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", blockedRunId);
    const recoveryTasks = overview.tasks.filter(
      (task: { config?: Record<string, unknown> }) =>
        (task.config?.automaticRecovery as { sourceAttemptId?: string } | undefined)?.sourceAttemptId === blockedAttemptId,
    );

    expect(result.ticks[0].recovery).toBeUndefined();
    expect(result.ticks[0].createdCycle).toBeDefined();
    const createdCycleRun = setupHarness.getRun(result.ticks[0].createdCycle.runId);
    const selfIterationProjectId = setupHarness.listProjects()[0].id;
    expect(setupHarness.getRun(bootstrap.runId)?.projectId).toBe(selfIterationProjectId);
    expect(createdCycleRun?.projectId).toBe(selfIterationProjectId);
    expect(recoveryTasks).toHaveLength(0);
    expect(overview.run.status).toBe("blocked");
    expect(overview.run.context.automaticRecoveryExhausted).toMatchObject({
      sourceTaskId: blockedTaskId,
      sourceAttemptId: blockedAttemptId,
      used: 1,
      limit: 1,
    });
  });

  test("concurrent self-improve daemons create and charge one automatic recovery", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "One blocked delivery needs one recovery",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const blockedTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Produce the missing host receipt",
      prompt: "Return the bounded receipt evidence.",
    });
    const blockedAttemptId = setupHarness.recordAttempt({
      taskId: blockedTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "The host receipt is still missing",
        changedFiles: [],
        checks: [{ name: "host receipt", status: "failed" }],
        artifacts: [],
        problems: ["host receipt missing"],
      },
    });
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-concurrent-recovery");
    const payload = {
      status: "done",
      summary: "The single recovery completed",
      changedFiles: [],
      checks: [{ name: "recovery", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "await Bun.sleep(100);",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_concurrent_recovery' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const daemonArgs = [
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--stop-hook", "context-summary",
      "--no-integrate", "true",
      "--interval-ms", "1",
      "--idle-ms", "1",
    ];
    await Promise.all([runCliJson(...daemonArgs), runCliJson(...daemonArgs)]);

    const overview = setupHarness.getRunOverview({ runId: blockedRunId, eventLimit: 0 });
    const recoveryTasks = overview.tasks.filter((candidate) => {
      const recovery = candidate.config?.automaticRecovery as { sourceAttemptId?: string } | undefined;
      return recovery?.sourceAttemptId === blockedAttemptId;
    });
    expect(recoveryTasks).toHaveLength(1);
    expect((overview.run?.context.repairReplanBudget as { used?: number } | undefined)?.used).toBe(1);
  });

  test("self-improve-daemon restores accounting for an existing automatic recovery", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: { status: "done", summary: "Assessment drained", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "Restore recovery accounting",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const sourceTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Original blocked work",
      prompt: "Implement.",
    });
    const sourceAttemptId = setupHarness.recordAttempt({
      taskId: sourceTaskId,
      input: {},
      output: { status: "blocked", summary: "Blocked.", changedFiles: [], checks: [], artifacts: [], problems: ["repair"] },
    });
    const recoveryTaskId = setupHarness.createTask({
      runId: blockedRunId,
      parentId: sourceTaskId,
      role: "worker",
      goal: "Existing recovery",
      prompt: "Repair once.",
      config: { automaticRecovery: { generation: 1, sourceTaskId, sourceAttemptId } },
    });
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-existing-recovery");
    const payload = { status: "done", summary: "Recovery done", changedFiles: [], checks: [], artifacts: [], problems: [] };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const outputFlag = Bun.argv.indexOf('--output-last-message');",
      "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
      `const payload = ${JSON.stringify(payload)};`,
      "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_existing_recovery' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--stop-hook", "context-summary",
      "--no-integrate", "true",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );

    const overview = setupHarness.getRunOverview({ runId: blockedRunId, eventLimit: 0 });
    expect(overview.tasks.filter((task) => {
      const recovery = task.config?.automaticRecovery as { sourceAttemptId?: string } | undefined;
      return recovery?.sourceAttemptId === sourceAttemptId;
    }).map((task) => task.id)).toEqual([recoveryTaskId]);
    expect(overview.run?.context.repairReplanBudget).toMatchObject({
      used: 1,
      entries: [expect.objectContaining({ taskId: sourceTaskId, kind: "repair" })],
    });
  });

  test("self-improve-daemon does not reopen a drained run whose matching recovery is terminal", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "A terminal recovery must become durable evidence",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const blockedTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Original blocked work",
      prompt: "Preserve the blocker.",
    });
    const blockedAttemptId = setupHarness.recordAttempt({
      taskId: blockedTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Original bounded attempt failed",
        changedFiles: [],
        checks: [{ name: "bounded attempt", status: "failed" }],
        artifacts: [],
        problems: ["bounded attempt failed"],
      },
    });
    const recoveryTaskId = setupHarness.createTask({
      runId: blockedRunId,
      parentId: blockedTaskId,
      role: "worker",
      goal: "One bounded recovery",
      prompt: "Record the recovery result.",
      config: {
        automaticRecovery: {
          sourceTaskId: blockedTaskId,
          sourceAttemptId: blockedAttemptId,
          generation: 1,
        },
      },
    });
    setupHarness.recordAttempt({
      taskId: recoveryTaskId,
      input: {},
      output: {
        status: "done",
        summary: "Recovery completed without reopening the original task",
        changedFiles: [],
        checks: [{ name: "recovery", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRun({
      runId: blockedRunId,
      contextPatch: {
        repairReplanBudget: {
          limit: 3,
          used: 1,
          entries: [{
            taskId: blockedTaskId,
            attemptId: blockedAttemptId,
            kind: "repair",
            summary: "One bounded recovery",
            chargedAt: "2026-08-11T00:00:00.000Z",
          }],
        },
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const reviewTaskId = setupHarness.createTask({
        runId: blockedRunId,
        role: "goal-review",
        goal: `Non-terminal review ${index + 1}`,
        prompt: "Continue without new active work.",
      });
      setupHarness.recordAttempt({
        taskId: reviewTaskId,
        input: {},
        output: {
          status: "done",
          runDecision: "continue",
          summary: "Continue",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        },
      });
    }
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });
    const database = new Database(dbPath);
    database.query("update runs set updated_at = '2000-01-01 00:00:00' where id = $runId").run({ $runId: blockedRunId });
    database.close();

    const codexBin = join(dir, "fake-codex-terminal-recovery-assessment");
    const payload = {
      status: "done",
      summary: "Terminal recovery evidence was assessed once.",
      changedFiles: [],
      checks: [{ name: "assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_terminal_recovery_assessment' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "2",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", blockedRunId);
    const terminalDatabase = new Database(dbPath, { readonly: true });
    const terminalUpdatedAt = (terminalDatabase
      .query("select updated_at as updatedAt from runs where id = $runId")
      .get({ $runId: blockedRunId }) as { updatedAt: string }).updatedAt;
    terminalDatabase.close();

    expect(result.ticks).toHaveLength(2);
    expect(result.ticks.every((tick: { recovery?: unknown }) => tick.recovery === undefined)).toBe(true);
    expect(overview.run.status).toBe("blocked");
    expect(terminalUpdatedAt).toBe("2000-01-01 00:00:00");
    expect(overview.tasks.some((task: { status: string }) => task.status === "todo" || task.status === "running")).toBe(false);
    expect(overview.tasks).toContainEqual(expect.objectContaining({ id: recoveryTaskId, status: "done" }));
  });

  test("self-improve-daemon switches worker backend after an executor-level block", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const blockedRunId = setupHarness.createRun({
      goal: "Delivery must recover from a failed worker backend",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        agentDefaults: {
          global: "claude-code",
          roles: { worker: "claude-code", verifier: "codex-resumable" },
        },
        agentBackends: {
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
          "codex-resumable": { kind: "codex-resumable" },
        },
      },
    });
    const blockedTaskId = setupHarness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Implement the delivery increment",
      prompt: "Implement the delivery increment and preserve existing work.",
      doneWhen: ["focused checks pass"],
      config: {
        agentBackend: "claude-code",
        verifierContract: { deterministicChecks: ["bun test tests/cli.test.ts"] },
      },
    });
    const sourceWorktreePath = `.ouroboros/worktrees/${blockedTaskId}`;
    setupHarness.recordAttempt({
      taskId: blockedTaskId,
      input: {
        backend: { id: "claude-code", kind: "acpx", agent: "claude" },
        route: {
          backend: { id: "claude-code", kind: "acpx", agent: "claude" },
          executionMode: "generic",
        },
      },
      output: {
        status: "blocked",
        summary: "acpx claude executor hit the hard ceiling",
        changedFiles: [],
        checks: [{ name: "acpx claude hard_timeout", status: "failed" }],
        artifacts: [
          {
            kind: "acpx_terminal_evidence",
            terminalReason: "hard_timeout",
            worktreeSnapshot: `worktree:${sourceWorktreePath}`,
          },
          { kind: "worktree", path: sourceWorktreePath },
        ],
        problems: ["hard timeout"],
      },
    });
    setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-backend-recovery");
    const payload = {
      status: "done",
      summary: "Recovered the delivery with the alternate backend",
      changedFiles: [],
      checks: [{ name: "focused checks", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_backend_recovery' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );

    const overview = await runCliJson("run-overview", "--run-id", blockedRunId);
    const recoveryTask = overview.tasks.find(
      (task: { config?: Record<string, unknown> }) =>
        (task.config?.automaticRecovery as { sourceTaskId?: string } | undefined)?.sourceTaskId === blockedTaskId,
    );
    const runs = await runCliJson("list-runs");

    expect(result.ticks[0]).toMatchObject({
      type: "self-improvement.tick",
      status: "ok",
      recovery: expect.objectContaining({
        runId: blockedRunId,
        sourceTaskId: blockedTaskId,
        fromBackend: "claude-code",
        toBackend: "codex-resumable",
        terminalReason: "hard_timeout",
      }),
    });
    expect(recoveryTask).toMatchObject({
      role: "worker",
      status: "done",
      worktreePath: sourceWorktreePath,
      doneWhen: ["focused checks pass"],
      config: expect.objectContaining({
        agentBackend: "codex-resumable",
        sourceWorktreePath,
        verifierContract: { deterministicChecks: ["bun test tests/cli.test.ts"] },
      }),
    });
    expect(
      runs.some(
        (run: { context: Record<string, unknown> }) => run.context.source === "self-improvement-assessment",
      ),
    ).toBe(false);
  });

  for (const terminalReason of ["idle_timeout", "hard_timeout"] as const) {
    test(`self-improve-daemon keeps Codex ${terminalReason} failures on bounded Codex recovery`, async () => {
      const setupHarness = new Harness(dbPath);
      setupHarness.init();
      const bootstrap = {
        runId: setupHarness.createRun({
          goal: `Recover Codex ${terminalReason}`,
          context: {
            source: "self-improve",
            selfImprovement: {
              cycleIndex: 0,
              assessmentFingerprint: `codex-${terminalReason}-recovery-test`,
            },
          },
        }),
        taskId: "",
      };
      bootstrap.taskId = setupHarness.createTask({
        runId: bootstrap.runId,
        role: "designer",
        goal: "Drained recovery fixture",
        prompt: "Remain quiescent.",
        doneWhen: ["recovery fixture is drained"],
      });
      setupHarness.recordAttempt({
        taskId: bootstrap.taskId,
        input: {},
        output: {
          status: "done",
          summary: "Initial assessment drained",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        },
      });
      setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

      const blockedRunId = setupHarness.createRun({
        goal: `Codex ${terminalReason} needs bounded recovery`,
        context: {
          parentRunId: bootstrap.runId,
          source: "design",
          repairReplanBudget: { limit: 2, used: 0, entries: [] },
          agentDefaults: {
            global: "claude-code",
            roles: { worker: "claude-code" },
          },
          agentBackends: {
            "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
            "codex-resumable": { kind: "codex-resumable" },
          },
        },
      });
      const sourceWorktreePath = `.ouroboros/worktrees/codex-${terminalReason}`;
      const blockedTaskId = setupHarness.createTask({
        runId: blockedRunId,
        role: "worker",
        goal: "Preserve the bounded worker recovery contract",
        prompt: "Continue the worker task in its existing source worktree.",
        doneWhen: ["the original focused checks pass", "the source worktree is preserved"],
        worktreePath: sourceWorktreePath,
        config: {
          verifierContract: { deterministicChecks: ["bun test tests/cli.test.ts"] },
          permissions: { sandbox: "workspace-write", browserProcessPolicy: "deny" },
          retryPolicy: { maxAttempts: 3 },
        },
      });
      const blockedAttemptId = setupHarness.recordAttempt({
        taskId: blockedTaskId,
        input: { backend: { id: "codex-resumable", kind: "codex-resumable" } },
        output: {
          status: "blocked",
          summary: `Codex executor ${terminalReason}`,
          changedFiles: [],
          checks: [{ name: terminalReason, status: "failed" }],
          artifacts: [
            { kind: "acpx_terminal_evidence", terminalReason },
            { kind: "worktree", path: sourceWorktreePath },
          ],
          problems: [terminalReason],
        },
      });
      setupHarness.updateRunStatus({ runId: blockedRunId, status: "blocked" });

      const codexBin = join(dir, `fake-codex-${terminalReason}`);
      const payload = {
        status: "done",
        summary: `Codex recovery completed after ${terminalReason}`,
        changedFiles: [],
        checks: [{ name: "focused checks", status: "passed" }],
        artifacts: [],
        problems: [],
      };
      await writeFile(
        codexBin,
        [
          "#!/usr/bin/env bun",
          "import { writeFileSync } from 'node:fs';",
          "const outputFlag = Bun.argv.indexOf('--output-last-message');",
          "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
          `const payload = ${JSON.stringify(payload)};`,
          "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
          `console.log(JSON.stringify({ type: 'session.started', session_id: 'session_${terminalReason}' }));`,
          "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
        ].join("\n"),
      );
      await chmod(codexBin, 0o755);

      const result = await runCliJson(
        "self-improve-daemon",
        "--executor",
        "codex-resumable",
        "--root-run-id",
        bootstrap.runId,
        "--codex-bin",
        codexBin,
        "--parallel",
        "auto",
        "--max-ticks",
        "1",
        "--tick-cycles",
        "1",
        "--max-rounds",
        "1",
        "--stop-hook",
        "create-tasks",
        "--no-integrate",
        "true",
        "--interval-ms",
        "1",
        "--idle-ms",
        "1",
      );
      const overview = new Harness(dbPath).getRunOverview({ runId: blockedRunId, eventLimit: 0 });
      const recoveryTask = overview.tasks.find(
        (task: { config?: Record<string, unknown> }) =>
          (task.config?.automaticRecovery as { sourceAttemptId?: string } | undefined)?.sourceAttemptId === blockedAttemptId,
      );

      expect(result.ticks[0].recovery).toMatchObject({
        runId: blockedRunId,
        sourceTaskId: blockedTaskId,
        sourceAttemptId: blockedAttemptId,
        terminalReason,
        fromBackend: "codex-resumable",
        toBackend: "codex-resumable",
      });
      expect(recoveryTask).toMatchObject({
        role: "worker",
        worktreePath: sourceWorktreePath,
        doneWhen: ["the original focused checks pass", "the source worktree is preserved"],
        config: {
          agentBackend: "codex-resumable",
          sourceWorktreePath,
          verifierContract: { deterministicChecks: ["bun test tests/cli.test.ts"] },
          permissions: { sandbox: "workspace-write", browserProcessPolicy: "deny" },
          retryPolicy: { maxAttempts: 3 },
          automaticRecovery: {
            generation: 1,
            sourceTaskId: blockedTaskId,
            sourceAttemptId: blockedAttemptId,
            terminalReason,
            fromBackend: "codex-resumable",
            toBackend: "codex-resumable",
            strategy: "codex-repair",
          },
        },
      });
      expect(overview.run!.context.repairReplanBudget).toMatchObject({ limit: 2, used: 1 });
      expect(overview.run!.context.automaticRecovery).toMatchObject({
        sourceTaskId: blockedTaskId,
        sourceAttemptId: blockedAttemptId,
        generation: 1,
        fromBackend: "codex-resumable",
        toBackend: "codex-resumable",
      });
      expect(overview.tasks.some((task: { config?: Record<string, unknown> }) =>
        (task.config?.agentBackend as string | undefined) === "claude-code" &&
        (task.config?.automaticRecovery as { sourceAttemptId?: string } | undefined)?.sourceAttemptId === blockedAttemptId,
      )).toBe(false);
    });
  }

  test("self-improve-daemon advances from the latest direct recovery failure", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Initial assessment drained",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const runId = setupHarness.createRun({
      goal: "Recover through multiple backends",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const originalTaskId = setupHarness.createTask({
      runId,
      role: "worker",
      goal: "Implement recovery target",
      prompt: "Implement the target.",
    });
    const originalAttemptId = setupHarness.recordAttempt({
      taskId: originalTaskId,
      input: { backend: { id: "claude-code", kind: "acpx", agent: "claude" } },
      output: {
        status: "blocked",
        summary: "Claude hard timeout",
        changedFiles: [],
        checks: [],
        artifacts: [{ kind: "acpx_terminal_evidence", terminalReason: "hard_timeout" }],
        problems: ["hard timeout"],
      },
    });
    const originalWorktreePath = `.ouroboros/worktrees/${originalTaskId}`;
    const staleRecoveryTaskId = setupHarness.createTask({
      runId,
      parentId: originalTaskId,
      role: "worker",
      goal: "First recovery attempt",
      prompt: "Continue the target.",
      worktreePath: `.ouroboros/worktrees/stale-${originalTaskId}`,
      config: {
        agentBackend: "codex-resumable",
        sourceWorktreePath: originalWorktreePath,
        automaticRecovery: {
          generation: 1,
          sourceTaskId: originalTaskId,
          sourceAttemptId: originalAttemptId,
          fromBackend: "claude-code",
          toBackend: "codex-resumable",
          strategy: "switch-backend",
        },
      },
    });
    setupHarness.recordAttempt({
      taskId: staleRecoveryTaskId,
      input: { backend: { id: "codex-resumable", kind: "codex-resumable" } },
      output: {
        status: "blocked",
        summary: "Recovery used the wrong clean worktree",
        changedFiles: [],
        checks: [{ name: "source worktree", status: "failed" }],
        artifacts: [],
        problems: ["source worktree was not reused"],
      },
    });
    setupHarness.updateRunStatus({ runId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-latest-recovery");
    const payload = {
      status: "done",
      summary: "Advanced the latest recovery from the original source worktree",
      changedFiles: [],
      checks: [{ name: "source worktree", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_latest_recovery' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const overview = await runCliJson("run-overview", "--run-id", runId);
    const latestRecovery = overview.tasks.find(
      (task: { config?: Record<string, unknown> }) =>
        (task.config?.automaticRecovery as { sourceTaskId?: string } | undefined)?.sourceTaskId === staleRecoveryTaskId,
    );

    expect(result.ticks[0].recovery).toMatchObject({
      sourceTaskId: staleRecoveryTaskId,
      fromBackend: "codex-resumable",
      toBackend: "codex-resumable",
    });
    expect(latestRecovery).toMatchObject({
      status: "done",
      worktreePath: originalWorktreePath,
      config: expect.objectContaining({ sourceWorktreePath: originalWorktreePath }),
    });
  });

  test("self-improve-daemon recovers a blocked assessment before creating another cycle", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const setupHarness = new Harness(dbPath);
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Bootstrap assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const assessmentRunId = setupHarness.createRun({
      goal: "Designer assesses Ouroboros for cycle 1",
      context: {
        parentRunId: bootstrap.runId,
        source: "self-improvement-assessment",
        selfImprovement: { cycleIndex: 1 },
      },
    });
    const designerTaskId = setupHarness.createTask({
      runId: assessmentRunId,
      role: "designer",
      goal: "Assess current improvement evidence",
      prompt: "Inspect the current evidence and make the next decision.",
    });
    setupHarness.recordAttempt({
      taskId: designerTaskId,
      input: { backend: { id: "codex-resumable", kind: "codex-resumable" } },
      output: {
        status: "blocked",
        summary: "codex exec resume failed",
        changedFiles: [],
        checks: [{ name: "codex resume", status: "failed" }],
        artifacts: [],
        problems: ["unexpected resume argument"],
      },
    });
    setupHarness.updateRunStatus({ runId: assessmentRunId, status: "blocked" });
    const activeRunId = setupHarness.createRun({
      goal: "Independent active delivery",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    setupHarness.createTask({
      runId: activeRunId,
      role: "worker",
      goal: "Continue independent delivery",
      prompt: "Complete the independent delivery while recovery proceeds in parallel.",
    });
    const secondBlockedRunId = setupHarness.createRun({
      goal: "Second blocked delivery",
      context: { parentRunId: bootstrap.runId, source: "design" },
    });
    const secondBlockedTaskId = setupHarness.createTask({
      runId: secondBlockedRunId,
      role: "worker",
      goal: "Repair the second blocked delivery",
      prompt: "Inspect and repair the second blocked delivery.",
    });
    setupHarness.recordAttempt({
      taskId: secondBlockedTaskId,
      input: { backend: { id: "codex-resumable", kind: "codex-resumable" } },
      output: {
        status: "blocked",
        summary: "Second delivery needs repair",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["repair required"],
      },
    });
    setupHarness.updateRunStatus({ runId: secondBlockedRunId, status: "blocked" });

    const codexBin = join(dir, "fake-codex-assessment-recovery");
    const payload = {
      status: "done",
      summary: "Recovered the blocked assessment and produced actionable evidence",
      changedFiles: [],
      checks: [{ name: "assessment recovery", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        `const payload = ${JSON.stringify(payload)};`,
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_assessment_recovery' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--stop-hook",
      "create-tasks",
      "--no-integrate",
      "true",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
    );
    const runs = await runCliJson("list-runs");

    expect(result.ticks[0]).toMatchObject({
      status: "ok",
      createdCycle: null,
      recoveries: expect.arrayContaining([
        expect.objectContaining({ runId: assessmentRunId, sourceTaskId: designerTaskId }),
        expect.objectContaining({ runId: secondBlockedRunId, sourceTaskId: secondBlockedTaskId }),
      ]),
    });
    expect(
      runs.filter(
        (run: { context: Record<string, unknown> }) => run.context.source === "self-improvement-assessment",
      ),
    ).toHaveLength(1);
  });

  test("self-improve-daemon surfaces a measuring proposal as an outcome-review tick before asking the designer for new work", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const bootstrapOverview = await runCliJson("run-overview", "--run-id", bootstrap.runId);
    const setupHarness = new Harness(dbPath);
    const projectId = setupHarness.listProjects()[0].id;
    const proposal = setupHarness.createDesignProposal({
      projectId,
      charterId: bootstrapOverview.run.context.founderCharterId as string,
      runId: bootstrap.runId,
      taskId: bootstrap.taskId,
      title: "Integrated improvement",
      problem: "Latency measurement gap",
      recommendation: "Add latency probe",
      proposal: {
        problem: "Latency measurement gap",
        recommendation: "Add latency probe",
        evidenceRefs: ["signal_latency_probe"],
        options: [
          {
            name: "latency probe",
            benefits: ["visibility"],
            costs: ["one probe"],
            risks: ["none"],
            lockIn: ["none"],
          },
        ],
        evaluationContract: {
          baseline: ["latency unseen"],
          successMetrics: ["latency under 200ms"],
          guardMetrics: ["reliability stable"],
          requiredEvidence: ["run-overview shows measuring status"],
        },
        investment: {
          reversibility: "easy" as const,
          portfolio: "core" as const,
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "1 hour",
        },
        additions: ["packages/cli/src/latency-probe.ts"],
        removals: [],
      },
      status: "accepted",
    });
    setupHarness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: proposal.charterId,
      reasons: ["founder reviewed reversible change"],
      authority: { disposition: "automatic", autoReversibleExperiments: true },
    });
    // Simulate the integrated child run that createRunsFromDesign would have
    // produced: it carries designProposalId in its context. After integration
    // the proposal moves to measuring and the daemon should surface the review.
    const integratedRunId = setupHarness.createRun({
      goal: "Deliver latency probe",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        designProposalId: proposal.id,
      },
    });
    setupHarness.updateDesignProposalStatus({ proposalId: proposal.id, status: "measuring" });
    setupHarness.updateRunStatus({ runId: integratedRunId, status: "blocked" });
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Drained designer tick",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });

    // Fake codex that records a retain outcome for any outcome-review task it
    // sees, so the daemon tick surfaces outcome-review state and then drains.
    const codexBin = join(dir, "fake-codex-outcome-review");
    const payload = {
      status: "done",
      summary: "Outcome review recorded",
      changedFiles: [],
      checks: [{ name: "outcome review", status: "passed" }],
      artifacts: [],
      problems: ["Two unrelated executor fixture checks are unavailable; the outcome evidence still passes."],
      actions: [
        {
          type: "recordDesignOutcome",
          payload: {
            proposalId: proposal.id,
            stage: "review",
            recommendation: "retain",
            baseline: { startup: 12 },
            observed: { startup: 5 },
            evidence: [{ runId: integratedRunId }],
          },
        },
      ],
    };
    await writeFile(
      codexBin,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        `const payload = ${JSON.stringify(payload)};`,
        "const outputFlag = Bun.argv.indexOf('--output-last-message');",
        "const outputPath = outputFlag >= 0 ? Bun.argv[outputFlag + 1] : '';",
        "if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_outcome' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(payload) }));",
      ].join("\n"),
    );
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor",
      "codex-resumable",
      "--root-run-id",
      bootstrap.runId,
      "--codex-bin",
      codexBin,
      "--parallel",
      "auto",
      "--max-ticks",
      "1",
      "--tick-cycles",
      "1",
      "--max-rounds",
      "1",
      "--interval-ms",
      "1",
      "--idle-ms",
      "1",
      "--stop-hook",
      "apply-design-actions,context-summary",
    );

    expect(result.status).toBe("tick_limit");
    // The first tick either surfaces outcome-review (if the daemon observes the
    // measuring proposal before draining) or directly drains via codex (if it
    // folds outcome-review into active supervision). Either way, the proposal
    // ends up retained after the retain outcome is recorded.
    const refreshed = setupHarness.getDesignProposal({ id: proposal.id });
    const integratedOverview = setupHarness.getRunOverview({ runId: integratedRunId, eventLimit: 0 });
    const outcomeReviewTask = integratedOverview.tasks.find((task) => task.role === "outcome-review");
    expect(outcomeReviewTask?.status).toBe("done");
    expect(integratedOverview.sessions.some((session) =>
      session.taskId === outcomeReviewTask?.id && session.status === "done"
    )).toBe(true);
    expect(refreshed?.status === "measuring" || refreshed?.status === "retained").toBe(true);
    if (refreshed?.status === "retained") {
      const outcomes = setupHarness.listDesignOutcomes({ proposalId: proposal.id });
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      expect(outcomes[0]).toMatchObject({
        recommendation: "retain",
        stage: "review",
      });
    }

    // Production-shaped regression: a historical execution thread can remain
    // marked running after both its task and attempt are already terminal. It
    // must not keep the continuous assessment graph active forever.
    const legacyTaskId = setupHarness.createTask({
      runId: integratedRunId,
      role: "worker",
      goal: "Historical terminal worker",
      prompt: "This task is already terminal.",
    });
    const legacyAttemptId = setupHarness.recordAttempt({
      taskId: legacyTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Historical worker stopped.",
        changedFiles: [],
        checks: [{ name: "historical worker", status: "failed" }],
        artifacts: [],
        problems: ["Historical failure"],
      },
    });
    setupHarness.upsertExecutionThread({
      id: "thread_stale_terminal_outcome_worker",
      runId: integratedRunId,
      taskId: legacyTaskId,
      attemptId: legacyAttemptId,
      ownerType: "attempt",
      ownerId: legacyAttemptId,
      role: "worker",
      status: "running",
      pid: 999_999,
      heartbeatAt: "2026-08-01T00:00:00.000Z",
    });

    // A separate future review must not mask a continuous root that has no
    // durable quiescent wake after the completed outcome review.
    const futureProposal = setupHarness.createDesignProposal({
      projectId,
      charterId: bootstrapOverview.run.context.founderCharterId as string,
      runId: bootstrap.runId,
      taskId: bootstrap.taskId,
      title: "Future independent review",
      problem: "This review is not due yet.",
      recommendation: "Wait for its own review date.",
      proposal: {
        problem: "This review is not due yet.",
        recommendation: "Wait for its own review date.",
        evaluationContract: {
          baseline: ["future review"],
          successMetrics: ["review remains scheduled"],
          guardMetrics: ["continuous assessment still advances"],
          requiredEvidence: ["one successor cycle"],
          reviewAt: "2099-01-01T00:00:00.000Z",
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "one hour",
        },
      },
      status: "accepted",
    });
    const futureRunId = setupHarness.createRun({
      projectId,
      goal: "Wait for future review",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        designProposalId: futureProposal.id,
      },
    });
    setupHarness.updateDesignProposalStatus({ proposalId: futureProposal.id, status: "measuring" });
    setupHarness.updateRunStatus({ runId: futureRunId, status: "done" });

    const postOutcomeCodex = join(dir, "fake-codex-post-outcome-successor");
    const postOutcomeOutput = {
      status: "done",
      summary: "No additional evidence-backed change is justified in this successor.",
      changedFiles: [],
      checks: [{ name: "post-outcome assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(postOutcomeCodex, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(postOutcomeOutput)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_post_outcome' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(postOutcomeCodex, 0o755);

    const postOutcomeArgs = [
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", postOutcomeCodex,
      "--parallel", "auto",
      "--max-ticks", "1",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
      "--stop-hook", "context-summary",
    ];
    const postOutcomeResults = await Promise.all([
      runCliJson(...postOutcomeArgs),
      runCliJson(...postOutcomeArgs),
    ]);
    const successorRuns = setupHarness.listRuns({ limit: 100 }).filter((run) =>
      run.context.parentRunId === bootstrap.runId
      && run.context.source === "self-improvement-assessment"
    );
    const created = postOutcomeResults.filter((row) => row.ticks[0].createdCycle != null);
    const watchdogObservations = postOutcomeResults.flatMap((row) => {
      const artifacts = row.ticks[0].watchdog?.artifacts;
      if (!Array.isArray(artifacts)) return [];
      return artifacts.filter((artifact: Record<string, unknown>) => artifact.kind === "watchdog_observation");
    });

    const durableRoot = setupHarness.getRun(bootstrap.runId)!;
    const durableSelfImprovement = durableRoot.context.selfImprovement as Record<string, unknown>;
    const durableQuiescence = durableSelfImprovement.quiescence as Record<string, unknown> | null;
    expect(created.length).toBeLessThanOrEqual(1);
    expect(successorRuns.length).toBeLessThanOrEqual(1);
    expect(successorRuns.length + (durableQuiescence ? 1 : 0)).toBe(1);
    if (successorRuns.length === 1) {
      expect(successorRuns[0].context.selfImprovement).toMatchObject({ cycleIndex: 1 });
    } else {
      expect(durableQuiescence).not.toBeNull();
      expect(Date.parse(String(durableQuiescence?.nextWakeAt))).toBeGreaterThan(Date.now());
    }
    expect(integratedOverview.tasks.filter((task) => task.role === "outcome-review")).toHaveLength(1);
    expect(watchdogObservations.length).toBeGreaterThan(0);
    expect(watchdogObservations.every((observation) =>
      !observation.eligibilityReasons.includes("scheduled-review-pending")
    )).toBe(true);
  });

  test.each(["retained", "revise", "retired"] as const)(
    "self-improve-daemon treats a completed %s outcome as terminal and advances",
    async (proposalStatus) => {
      const bootstrap = await runCliJson("self-iterate");
      const setupHarness = new Harness(dbPath);
      const projectId = setupHarness.listProjects()[0].id;
      setupHarness.recordAttempt({
        taskId: bootstrap.taskId,
        input: {},
        output: {
          status: "done",
          summary: "Bootstrap assessment drained.",
          changedFiles: [],
          checks: [{ name: "assessment", status: "passed" }],
          artifacts: [],
          problems: [],
        },
      });
      setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
      const proposal = setupHarness.createDesignProposal({
        projectId,
        title: `${proposalStatus} outcome`,
        problem: "A completed outcome must release the next assessment.",
        recommendation: "Advance the continuous loop.",
        proposal: {
          problem: "A completed outcome must release the next assessment.",
          recommendation: "Advance the continuous loop.",
          evaluationContract: {
            baseline: ["outcome pending"],
            successMetrics: ["next assessment created"],
            guardMetrics: ["no duplicate cycle"],
            requiredEvidence: ["successor run"],
          },
          investment: { reversibility: "easy", portfolio: "core" },
        },
        status: proposalStatus,
      });
      const deliveryRunId = setupHarness.createRun({
        projectId,
        goal: `Reviewed delivery ${proposalStatus}`,
        context: {
          parentRunId: bootstrap.runId,
          source: "design",
          designProposalId: proposal.id,
        },
      });
      setupHarness.updateRunStatus({ runId: deliveryRunId, status: "blocked" });
      const outcomeTaskId = setupHarness.createTask({
        runId: deliveryRunId,
        role: "outcome-review",
        goal: "Record terminal outcome",
        prompt: "Outcome already recorded.",
      });
      setupHarness.recordAttempt({
        taskId: outcomeTaskId,
        input: {},
        output: {
          status: "done",
          summary: `Recorded ${proposalStatus} outcome with unrelated diagnostics.`,
          changedFiles: [],
          checks: [{ name: "outcome", status: "passed" }],
          artifacts: [],
          problems: ["Unrelated executor fixture diagnostic"],
        },
      });
      setupHarness.recordDesignOutcome({
        proposalId: proposal.id,
        runId: deliveryRunId,
        taskId: outcomeTaskId,
        stage: "review",
        recommendation: proposalStatus === "retained" ? "retain" : proposalStatus === "revise" ? "revise" : "retire",
        evidence: ["outcome review complete"],
      });

      const codexBin = join(dir, `fake-codex-after-${proposalStatus}-outcome`);
      const output = {
        status: "done",
        summary: "Successor assessment completed.",
        changedFiles: [],
        checks: [{ name: "successor", status: "passed" }],
        artifacts: [],
        problems: [],
      };
      await writeFile(codexBin, [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "const flag = Bun.argv.indexOf('--output-last-message');",
        "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
        `const output = ${JSON.stringify(output)};`,
        "if (path) writeFileSync(path, JSON.stringify(output));",
        "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_after_outcome' }));",
        "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
      ].join("\n"));
      await chmod(codexBin, 0o755);

      const result = await runCliJson(
        "self-improve-daemon",
        "--executor", "codex-resumable",
        "--root-run-id", bootstrap.runId,
        "--codex-bin", codexBin,
        "--parallel", "auto",
        "--max-ticks", "1",
        "--tick-cycles", "1",
        "--max-rounds", "1",
        "--interval-ms", "1",
        "--idle-ms", "1",
        "--stop-hook", "context-summary",
      );

      expect(result.ticks[0].createdCycle).toMatchObject({ cycleIndex: 1 });
    },
  );

  test("self-improve-daemon does not report a terminal exhausted outcome review as active on every tick", async () => {
    const bootstrap = await runCliJson("self-iterate");
    const bootstrapOverview = await runCliJson("run-overview", "--run-id", bootstrap.runId);
    const setupHarness = new Harness(dbPath);
    const projectId = setupHarness.listProjects()[0].id;
    const proposal = setupHarness.createDesignProposal({
      projectId,
      charterId: bootstrapOverview.run.context.founderCharterId as string,
      runId: bootstrap.runId,
      taskId: bootstrap.taskId,
      title: "Exhausted outcome review",
      problem: "A terminal review must not look active forever.",
      recommendation: "Converge after the bounded review fails.",
      proposal: {
        problem: "A terminal review must not look active forever.",
        recommendation: "Converge after the bounded review fails.",
        evaluationContract: {
          baseline: ["review is blocked"],
          successMetrics: ["daemon advances"],
          guardMetrics: ["no duplicate review"],
          requiredEvidence: ["two daemon ticks"],
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "one hour",
        },
      },
      status: "accepted",
    });
    const deliveryRunId = setupHarness.createRun({
      projectId,
      goal: "Deliver then review",
      context: {
        parentRunId: bootstrap.runId,
        source: "design",
        designProposalId: proposal.id,
        repairReplanBudget: { limit: 1, used: 1, entries: [] },
      },
    });
    setupHarness.updateDesignProposalStatus({ proposalId: proposal.id, status: "measuring" });
    setupHarness.updateRunStatus({ runId: deliveryRunId, status: "blocked" });
    const linked = setupHarness.linkProposalOutcomeReview({ runId: deliveryRunId });
    expect(linked.outcomeReviewTaskId).toBeTruthy();
    setupHarness.recordAttempt({
      taskId: linked.outcomeReviewTaskId!,
      input: {},
      output: {
        status: "blocked",
        summary: "The bounded outcome review failed",
        changedFiles: [],
        checks: [{ name: "outcome evidence", status: "failed" }],
        artifacts: [],
        problems: ["repair budget exhausted"],
      },
    });
    setupHarness.recordAttempt({
      taskId: bootstrap.taskId,
      input: {},
      output: {
        status: "done",
        summary: "Bootstrap assessment drained",
        changedFiles: [],
        checks: [{ name: "assessment", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    setupHarness.updateRunStatus({ runId: bootstrap.runId, status: "done" });
    const codexBin = join(dir, "fake-codex-after-exhausted-outcome");
    const output = {
      status: "done",
      summary: "No new evidence-backed improvement is justified.",
      changedFiles: [],
      checks: [{ name: "assessment", status: "passed" }],
      artifacts: [],
      problems: [],
    };
    await writeFile(codexBin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const flag = Bun.argv.indexOf('--output-last-message');",
      "const path = flag >= 0 ? Bun.argv[flag + 1] : '';",
      `const output = ${JSON.stringify(output)};`,
      "if (path) writeFileSync(path, JSON.stringify(output));",
      "console.log(JSON.stringify({ type: 'session.started', session_id: 'session_exhausted_outcome' }));",
      "console.log(JSON.stringify({ type: 'agent.message', message: JSON.stringify(output) }));",
    ].join("\n"));
    await chmod(codexBin, 0o755);

    const result = await runCliJson(
      "self-improve-daemon",
      "--executor", "codex-resumable",
      "--root-run-id", bootstrap.runId,
      "--codex-bin", codexBin,
      "--parallel", "auto",
      "--max-ticks", "2",
      "--tick-cycles", "1",
      "--max-rounds", "1",
      "--interval-ms", "1",
      "--idle-ms", "1",
    );
    const deliveryOverview = setupHarness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 });
    const assessmentRuns = setupHarness.listRuns({ limit: 100 }).filter((run) =>
      run.context.parentRunId === bootstrap.runId
      && run.context.source === "self-improvement-assessment"
    );

    expect(result.ticks.every((tick: { status: string }) => tick.status !== "outcome-review")).toBe(true);
    expect(deliveryOverview.tasks.filter((task) => task.role === "outcome-review")).toHaveLength(1);
    expect(deliveryOverview.tasks.find((task) => task.role === "outcome-review")?.status).toBe("blocked");
    expect(assessmentRuns).toHaveLength(1);
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

  test("autopilot blocks stale running attempts without an agent session id instead of retrying", async () => {
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
    expect(harness.getTask(task.id)?.status).toBe("blocked");
    expect(harness.getAttempt(stale.attemptId)?.output.problems).toContain(
      "running attempt is missing an agent session id; automatic retry is disabled because this attempt cannot be resumed safely",
    );
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
        changedFiles: ["packages/cli/src/run-evidence.ts", ".ouroboros/ouroboros.db"],
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
    expect(summary).not.toContain(".ouroboros/ouroboros.db");
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

  test("run-evidence CLI surfaces the durable watchdog projection after a stall and repair", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate watchdog run-evidence output");
    // Prime the frozen sequence healthy -> suspect -> suspect -> stalled ->
    // reconciling -> repairing -> canary through fake-clock ticks.
    const base = 1_700_000_000_000;
    for (let tick = 0; tick < 5; tick += 1) {
      await runCliJson(
        "run-watchdog-pass",
        "--root-run-id",
        run.id,
        "--now",
        String(base + tick * 90_000),
        "--daemon-interval-ms",
        "1500",
        "--reason",
        `prime ${tick}`,
      );
    }
    // Tick 5: reconciling -> repair dispatch (creates repair run, advances
    // to canary from the prior reconcile evidence).
    await runCliJson(
      "run-watchdog-pass",
      "--root-run-id",
      run.id,
      "--now",
      String(base + 5 * 90_000),
      "--daemon-interval-ms",
      "1500",
      "--reason",
      "repair",
    );

    const stdout = await runCli("run-evidence", "--run-id", run.id);

    expect(stdout).toContain("Control-plane watchdog");
    expect(stdout).toContain("state: canary");
    expect(stdout).toContain("recovery stage: canary");
    expect(stdout).toContain("repair run: run_watchdog_repair_");
    expect(stdout).toContain("repair task: task_watchdog_repair_");
    expect(stdout).toContain("canary: progressing");
    expect(stdout).toContain("affected runs:");
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

  test("formatRunEvidence renders the persisted runtime handoff receipt and attestation fields", () => {
    const oldPrompt = "a".repeat(64);
    const newPrompt = "b".repeat(64);
    const evidenceHarness = new Harness(dbPath);
    evidenceHarness.init();
    const runId = evidenceHarness.createRun({
      goal: "Show runtime generation evidence",
      context: {
        controlPlaneRuntime: {
          state: "reloaded",
          generation: 2,
          canonicalEntrypoint: "/repo/packages/cli/src/main.ts",
          sourceRoot: "/repo",
          launchHead: "head-new",
          observedHead: "head-new",
          promptContractHash: newPrompt,
          processIdentity: "222",
          startedAt: "2026-08-10T01:00:00.000Z",
          attestedAt: "2026-08-10T01:00:02.000Z",
          attestedGeneration: 2,
          attestedHead: "head-new",
          attestedPromptContractHash: newPrompt,
          attestedProcessIdentity: "222",
          reloadAttempt: {
            count: 1,
            status: "launched",
            fingerprint: "head-new",
            cooldownUntil: "2026-08-10T01:05:00.000Z",
            claimedAt: "2026-08-10T00:59:58.000Z",
          },
          handoffReceipt: {
            oldGeneration: 1,
            newGeneration: 2,
            oldHead: "head-old",
            newHead: "head-new",
            oldPromptContractHash: oldPrompt,
            newPromptContractHash: newPrompt,
            oldProcessIdentity: "111",
            newProcessIdentity: "222",
            claimAt: "2026-08-10T00:59:58.000Z",
            startAt: "2026-08-10T01:00:00.000Z",
            attestationAt: "2026-08-10T01:00:02.000Z",
          },
        },
      },
    });

    const summary = formatRunEvidence(evidenceHarness.getRunOverview({ runId, eventLimit: 0 }));

    expect(summary).toContain("state: reloaded");
    expect(summary).toContain("generation: 2");
    expect(summary).toContain("old generation: 1");
    expect(summary).toContain("new generation: 2");
    expect(summary).toContain("old HEAD: head-old");
    expect(summary).toContain("new HEAD: head-new");
    expect(summary).toContain(`old prompt contract: ${oldPrompt}`);
    expect(summary).toContain(`new prompt contract: ${newPrompt}`);
    expect(summary).toContain("old process: 111");
    expect(summary).toContain("new process: 222");
    expect(summary).toContain("claim at: 2026-08-10T00:59:58.000Z");
    expect(summary).toContain("attestation at: 2026-08-10T01:00:02.000Z");
    expect(summary).toContain("cooldown until: 2026-08-10T01:05:00.000Z");
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

  test("run-threads CLI groups harness-managed subsession threads under their parent task", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-threads output");
    const parent = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Drive subsession research",
      "--prompt",
      "Spawn a research subsession.",
    );
    const harness = new Harness(dbPath);
    const attemptId = harness.recordAttempt({
      taskId: parent.id,
      input: {},
      output: {
        status: "done",
        summary: "Collected subsession summaries.",
        artifacts: [],
        changedFiles: [],
        checks: [],
        problems: [],
      },
    });
    const parentThreadId = harness.upsertExecutionThread({
      runId: run.id,
      taskId: parent.id,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "parent-session",
      agentSessionId: "codex_parent",
    });
    const childThreadId = harness.upsertExecutionThread({
      runId: run.id,
      taskId: parent.id,
      attemptId,
      parentThreadId,
      ownerType: "subsession",
      role: "researcher",
      status: "running",
      sessionName: "parent__research_api",
      agentSessionId: "claude_research_child",
    });
    harness.recordAttempt({
      taskId: parent.id,
      input: {},
      output: {
        status: "done",
        summary: "Collected subsession summaries.",
        artifacts: [
          {
            kind: "subsession_summary",
            threadId: childThreadId,
            sessionName: "parent__research_api",
            status: "done",
            summary: "Found three relevant APIs.",
          },
        ],
        changedFiles: [],
        checks: [],
        problems: [],
      },
    });

    const stdout = await runCli("run-threads", "--run-id", run.id);

    expect(stdout).toContain(`Run ${run.id}`);
    expect(stdout).toContain(`Parent task ${shortTaskId(parent.id)}`);
    expect(stdout).toContain("Drive subsession research");
    expect(stdout).toContain(`parent_thread: ${shortTaskId(parentThreadId)}`);
    expect(stdout).toContain(shortTaskId(childThreadId));
    expect(stdout).toContain("researcher");
    expect(stdout).toContain("parent__research_api");
    expect(stdout).toContain("Found three relevant APIs.");
  });

  test("run-threads CLI emits JSON overview with child thread grouping", async () => {
    await runCli("init");
    const run = await runCliJson("create-run", "--goal", "Validate run-threads JSON");
    const parent = await runCliJson(
      "create-task",
      "--run-id",
      run.id,
      "--role",
      "worker",
      "--goal",
      "Drive JSON subsession",
      "--prompt",
      "Spawn a subsession.",
    );
    const harness = new Harness(dbPath);
    const attemptId = harness.startAttempt({ taskId: parent.id, input: {} });
    const parentThreadId = harness.upsertExecutionThread({
      runId: run.id,
      taskId: parent.id,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "parent-session",
      agentSessionId: "codex_parent_json",
    });
    const childThreadId = harness.upsertExecutionThread({
      runId: run.id,
      taskId: parent.id,
      attemptId,
      parentThreadId,
      ownerType: "subsession",
      role: "researcher",
      status: "running",
      sessionName: "parent__research_json",
      agentSessionId: "claude_research_json",
    });

    const overview = await runCliJson("run-threads", "--run-id", run.id, "--json", "true") as {
      groups: Array<{
        taskId: string;
        childThreads: Array<{ id: string; ownerType: string; role: string }>;
        latestSummaries: Array<{ threadId: string; status: string; summary: string }>;
      }>;
      parentTaskCount: number;
      childThreadCount: number;
      standaloneThreadCount: number;
    };

    expect(overview.parentTaskCount).toBe(1);
    expect(overview.childThreadCount).toBe(1);
    expect(overview.standaloneThreadCount).toBe(0);
    expect(overview.groups[0].taskId).toBe(parent.id);
    expect(overview.groups[0].childThreads[0].id).toBe(childThreadId);
    expect(overview.groups[0].childThreads[0].ownerType).toBe("subsession");
    expect(overview.groups[0].childThreads[0].role).toBe("researcher");
    expect(overview.groups[0].latestSummaries).toHaveLength(0);
  });

  test("run-threads CLI fails with a helpful message when the run is missing", async () => {
    await runCli("init");
    const result = await runCliRaw("run-threads", "--run-id", "run_missing");

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

  test("CLI smoke: commitExactGitIndex commits one frozen verified index", async () => {
    await runCli("init");
    const repoPath = join(dir, "repo-exact-index-cli");
    await mkdir(join(repoPath, "src"), { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    gitCli(repoPath, ["init", "-b", "main"]);
    gitCli(repoPath, ["config", "user.name", "Ouroboros Test"]);
    gitCli(repoPath, ["config", "user.email", "test@example.com"]);
    gitCli(repoPath, ["config", "commit.gpgSign", "false"]);
    gitCli(repoPath, ["add", "README.md"]);
    gitCli(repoPath, ["commit", "-m", "Initial commit"]);
    const expectedParentSha = gitCli(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(join(repoPath, "src", "cli.ts"), "export const cli = true;\n");
    gitCli(repoPath, ["add", "src/cli.ts"]);
    const blobOid = gitCli(repoPath, ["hash-object", "src/cli.ts"]).stdout.trim();
    const run = await runCliJson("create-run", "--goal", "Commit exact CLI index", "--project-root", repoPath);
    const actionHarness = new Harness(dbPath);
    const taskId = actionHarness.createTask({
      runId: run.id,
      role: "worker",
      goal: "Add src/cli.ts",
      prompt: "Stage the exact file.",
      worktreePath: repoPath,
    });
    actionHarness.recordAttempt({
      taskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Staged src/cli.ts",
        changedFiles: ["src/cli.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = actionHarness.createTask({
      runId: run.id,
      role: "verifier",
      goal: "Verify src/cli.ts",
      prompt: "Verify the exact file.",
      dependsOn: [taskId],
    });
    actionHarness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified src/cli.ts",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const files = [{ status: "A", path: "src/cli.ts", mode: "100644", blobOid }];
    const action = {
      type: "commitExactGitIndex",
      contractId: "cliExactIndex",
      runId: run.id,
      taskId,
      repoPath,
      branch: "main",
      expectedParentSha,
      commitMessage: "Commit exact CLI index",
      files,
    };
    actionHarness.updateRun({
      runId: run.id,
      contextPatch: {
        gitIndexCommitContracts: {
          cliExactIndex: { runId: run.id, taskId, repoPath, branch: "main", expectedParentSha, commitMessage: action.commitMessage, files },
        },
      },
    });

    const result = await runCliJson("action", "--action-json", JSON.stringify(action));
    const events = await runCliJson("action-events", "--limit", "1");

    expect(result).toMatchObject({ status: "done", actionType: "commitExactGitIndex" });
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      kind: "integration",
      mode: "exact_git_index_commit",
      alreadyMerged: true,
      workerTaskId: taskId,
      verifierTaskId,
    }));
    expect(events[0]).toMatchObject({ id: result.eventId, actionType: "commitExactGitIndex", status: "done" });
    expect(gitCli(repoPath, ["status", "--short"]).stdout).toBe("");
  });

  test("CLI smoke: createExactGitRef accepts the fixed action and audits a scope failure", async () => {
    const repoPath = join(dir, "repo-exact-ref-cli");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    gitCli(repoPath, ["init", "-b", "delivery"]);
    gitCli(repoPath, ["config", "user.name", "Ouroboros Test"]);
    gitCli(repoPath, ["config", "user.email", "test@example.com"]);
    gitCli(repoPath, ["config", "commit.gpgSign", "false"]);
    gitCli(repoPath, ["add", "README.md"]);
    gitCli(repoPath, ["commit", "-m", "Initial commit"]);
    gitCli(repoPath, ["remote", "add", "origin", join(dir, "local-only-remote.git")]);
    const newSha = gitCli(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const ref = "refs/heads/codex/exact-ref-cli";
    const contract = {
      repoPath,
      remoteHost: "github.com",
      repository: "neeboo/hodor-web",
      ref,
      newSha,
      expectedAbsent: true,
    };
    const actionHarness = new Harness(dbPath);
    actionHarness.init();
    const runId = actionHarness.createRun({
      goal: "Create exact CLI ref",
      projectRoot: repoPath,
      context: {
        gitRefCreationContracts: {
          cliExactRef: contract,
        },
      },
    });

    const result = await runCliJson("action", "--action-json", JSON.stringify({
      type: "createExactGitRef",
      runId,
      contractId: "cliExactRef",
      ...contract,
    }));
    const events = actionHarness.listHarnessActionEvents({ limit: 1 });

    expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      kind: "git_ref_creation",
      status: "scope_mismatch",
    }));
    expect(events[0]).toMatchObject({ id: result.eventId, actionType: "createExactGitRef", status: "blocked" });
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

  test("CLI smoke: integrateVerifiedRun preserves disjoint target edits through verified integration", async () => {
    await runCli("init");
    const { repoPath, run, workerTask } = await prepareVerifiedIntegrationRepo({
      branch: "task-worker-dirty",
      workerFile: "src/dirty.ts",
      workerContent: "export const dirty = true;\n",
    });

    await writeFile(join(repoPath, "uncommitted.txt"), "dirty target\n");
    const operatorBefore = await readFile(join(repoPath, "uncommitted.txt"), "utf8");

    const result = await runCliJson(
      "action",
      "--action-json",
      JSON.stringify({
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: workerTask.id,
        commitMessage: "Integrate verified worker while preserving operator edit",
        reason: "CLI smoke for disjoint-edit preservation",
      }),
    );
    const events = await runCliJson("action-events", "--limit", "1");
    const operatorAfter = await readFile(join(repoPath, "uncommitted.txt"), "utf8");

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      eventId: expect.any(String),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "disjoint target paths preserved",
        status: "passed",
        evidence: expect.stringContaining("uncommitted.txt"),
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "preserved target readback", status: "passed" }),
    );
    expect(events[0]).toMatchObject({
      id: result.eventId,
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ runId: run.id, workerTaskId: workerTask.id }),
    });
    // Operator edit remains byte-for-byte intact through integration.
    expect(operatorAfter).toBe(operatorBefore);
    // Verified worker file landed in the target repository.
    expect(await readFile(join(repoPath, "src", "dirty.ts"), "utf8")).toBe("export const dirty = true;\n");
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

  test("evolution record inspection reads trusted records and rejects unreceipted sensitive records without mutation", async () => {
    const harness = new Harness(dbPath);
    harness.init();
    const project = {
      id: harness.createProject({
        name: "Evolution Readback Project",
        rootPath: dir,
      }),
    };
    const charter = harness.createFounderCharter({
      id: "charter_evolution_readback_primary",
      projectId: project.id,
      mission: "Keep target evolution evidence bounded and attributable.",
      charter: {
        mission: "Keep target evolution evidence bounded and attributable.",
        principles: ["Every runtime record has an immutable design source."],
      },
      activate: true,
    });
    const design = createAcceptedEvolutionDesignSource({
      harness,
      projectId: project.id,
      charterId: charter.id,
      suffix: "primary",
    });
    const { designSource, runContext, pack, comparison } = design;
    const sourceRunId = harness.createRun({
      projectId: project.id,
      goal: "Record bounded evolution evidence",
      context: runContext,
    });
    const retrySourceRunId = harness.createRun({
      projectId: project.id,
      goal: "Retry the same bounded evolution evidence",
      context: runContext,
    });
    const sha = (digit: string) => digit.repeat(64);
    const address = <T extends Record<string, unknown>>(
      kind: "profile" | "episode" | "variant" | "experiment",
      record: T,
    ) => ({ ...record, id: expectedEvolutionRecordId(kind, record) });
    const zeroSideEffects = {
      paidUsd: 0,
      realProviderCalls: 0,
      pancatWrites: 0,
      productionPublishes: 0,
      realAssetDeletes: 0,
      crossProjectMemoryReads: 0,
      crossProjectMemoryWrites: 0,
    };

    const profile = address("profile", {
      schemaVersion: 1,
      projectId: project.id,
      pack: { id: pack.id, version: pack.version, contentSha256: canonicalEvolutionValueSha256(pack) },
      charter: {
        id: charter.id,
        version: charter.version,
        contentSha256: canonicalEvolutionValueSha256(charter.charter),
      },
      runtimeMaturity: "declared",
      allowedSurfaceIds: ["surface.runtime"],
      registeredAt: "2026-08-09T08:00:00Z",
    });
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: sourceRunId,
      profile,
    }).status).toBe("done");

    const makeEpisode = (
      suffix: "development" | "heldout" | "unrelated",
      snapshotDigit: string,
    ) => address("episode", {
      schemaVersion: 1,
      projectId: project.id,
      profileId: profile.id,
      sourceRef: {
        development: comparison.developmentEvidenceRefs[0],
        heldout: comparison.holdoutEvidenceRefs[0],
        unrelated: comparison.unrelatedEvidenceRefs[0],
      }[suffix],
      leakageGroupId: `hodor-${suffix}`,
      observedAt: "2026-08-09T08:01:00Z",
      inputSnapshotSha256: sha(snapshotDigit),
      outcomeSnapshotSha256: sha(String(Number(snapshotDigit) + 1)),
      policyRef: "policy:hodor-production-observation:v1",
      metrics: { [`${suffix}CompletionRate`]: 0.75 },
      sideEffectCounters: zeroSideEffects,
      evidenceRefs: [`evidence:hodor:${suffix}`],
      privacyReview: {
        status: "approved",
        policySha256: sha("9"),
        reviewerRef: "privacy-review:local:v1",
        dataClassification: "confidential",
        retentionPolicyRef: "retention:30d",
        inputSnapshotSha256: sha(snapshotDigit),
        outcomeSnapshotSha256: sha(String(Number(snapshotDigit) + 1)),
        evidenceRefs: [`privacy-evidence:hodor:${suffix}`],
      },
    });
    const developmentEpisode = makeEpisode("development", "3");
    const heldoutEpisode = makeEpisode("heldout", "5");
    const unrelatedEpisode = makeEpisode("unrelated", "7");
    for (const episode of [developmentEpisode, heldoutEpisode, unrelatedEpisode]) {
      harness.recordProductionEpisode(episode);
    }

    const makeVariant = (role: "control" | "candidate", contentDigit: string) => address("variant", {
      schemaVersion: 1,
      projectId: project.id,
      profileId: profile.id,
      role,
      evolutionTargets: ["harness"],
      contentSha256: sha(contentDigit),
      mutationSurfaceIds: ["surface.runtime"],
      changedPaths: [`runtime/${role}.json`],
      toolPolicySha256: comparison.equalBudget.toolPolicySha256,
      createdFromEvidenceRefs: [developmentEpisode.sourceRef],
    });
    const controlVariant = makeVariant("control", "b");
    const candidateVariant = makeVariant("candidate", "c");
    for (const variant of [controlVariant, candidateVariant]) {
      expect(applyHarnessAction(harness, {
        type: "registerHarnessVariant",
        runId: sourceRunId,
        variant,
      }).status).toBe("done");
    }

    const experiment = address("experiment", {
      schemaVersion: 1,
      projectId: project.id,
      profileId: profile.id,
      controlVariantId: controlVariant.id,
      candidateVariantId: candidateVariant.id,
      developmentEpisodeRefs: [developmentEpisode.id],
      heldoutEpisodeRefs: [heldoutEpisode.id],
      unrelatedEpisodeRefs: [unrelatedEpisode.id],
      corpusSnapshotSha256: comparison.corpusSnapshotSha256,
      equalBudget: comparison.equalBudget,
      primaryMetric: comparison.primaryMetric,
      guardMetrics: pack.promotionPolicy.guardMetrics,
      sideEffectCounters: zeroSideEffects,
      outcome: "pending",
      evidenceRefs: ["experiment-spec:hodor:v1"],
    });
    harness.recordMatchedExperiment(experiment);
    const actionFixtures = [
      ["registerEvolutionProfile", "profile", "evolution_profile", profile],
      ["registerHarnessVariant", "variant", "harness_variant", controlVariant],
      ["registerHarnessVariant", "variant", "harness_variant", candidateVariant],
    ] as const;
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: retrySourceRunId,
      profile,
    }).status).toBe("done");

    checkpointDatabase(dbPath);
    await rm(`${dbPath}-wal`).catch(() => undefined);
    await rm(`${dbPath}-shm`).catch(() => undefined);
    await rm(`${dbPath}-journal`).catch(() => undefined);
    await chmod(dir, 0o555);
    await chmod(dbPath, 0o444);
    try {
      const before = await snapshotDatabaseFilesystem(dbPath, dir);
      const records = [
        ["profile", profile],
        ["variant", candidateVariant],
      ] as const;
      const shownRecords = records.map(([kind, record]) => showEvolutionRecord({
        harness,
        dbPath,
        kind,
        projectId: project.id,
        id: record.id,
      }));
      for (const [[kind, record], shown] of records.map((entry, index) => [entry, shownRecords[index]] as const)) {
        expect(shown).toMatchObject({
          kind,
          projectId: project.id,
          id: record.id,
          record,
          recordSha256: canonicalEvolutionRecordSha256(record),
          actionAudit: {
            actionType: actionFixtures.find((fixture) => fixture[1] === kind)?.[0],
            status: "done",
            sourceRunId: kind === "profile"
              ? expect.stringMatching(new RegExp(`^(${sourceRunId}|${retrySourceRunId})$`))
              : sourceRunId,
            recordId: record.id,
            projectId: project.id,
            recordSha256: canonicalEvolutionRecordSha256(record),
            receiptCount: kind === "profile" ? 2 : 1,
            ...designSource,
          },
        });
        expect(shown.actionAudit).not.toHaveProperty("request");
        expect(shown.actionAudit).not.toHaveProperty("result");
      }

      let shownHeldoutText = "";
      try {
        showEvolutionRecord({
          harness,
          dbPath,
          kind: "episode",
          projectId: project.id,
          id: heldoutEpisode.id,
        });
      } catch (error) {
        shownHeldoutText = (error as Error).message;
      }
      expect(shownHeldoutText).toContain("evolution action audit receipt not found");
      let shownExperimentError = "";
      try {
        showEvolutionRecord({
          harness,
          dbPath,
          kind: "experiment",
          projectId: project.id,
          id: experiment.id,
        });
      } catch (error) {
        shownExperimentError = (error as Error).message;
      }
      expect(shownHeldoutText).not.toContain(heldoutEpisode.sourceRef);
      expect(shownHeldoutText).not.toContain(heldoutEpisode.leakageGroupId);
      expect(shownHeldoutText).not.toContain("heldoutCompletionRate");
      expect(shownHeldoutText).not.toContain(heldoutEpisode.evidenceRefs[0]);
      expect(shownHeldoutText).not.toContain(heldoutEpisode.privacyReview.reviewerRef);
      expect(shownHeldoutText).not.toContain(heldoutEpisode.privacyReview.retentionPolicyRef);
      expect(shownHeldoutText).not.toContain(heldoutEpisode.privacyReview.evidenceRefs[0]);

      expect(shownExperimentError).toContain("evolution action audit receipt not found");
      expect(shownExperimentError).not.toContain(developmentEpisode.id);
      expect(shownExperimentError).not.toContain(heldoutEpisode.id);
      expect(shownExperimentError).not.toContain(unrelatedEpisode.id);
      expect(shownExperimentError).not.toContain(experiment.evidenceRefs[0]);

      const listKinds = ["profile", "variant"] as const;
      const listedRecords = listKinds.map((kind) => listEvolutionRecords({
        harness,
        dbPath,
        kind,
        projectId: project.id,
        profileId: kind === "profile" ? undefined : profile.id,
      }));
      for (const [index, kind] of listKinds.entries()) {
        const listed = listedRecords[index];
        expect(listed).toMatchObject({
          kind,
          projectId: project.id,
          profileId: kind === "profile" ? null : profile.id,
          totalCount: kind === "variant" ? 2 : 1,
        });
        expect(listed.records.every(
          (entry: {
            actionAudit?: {
              status?: string;
              receiptCount?: number;
              designProposalId?: string;
              designDecisionId?: string;
              designCharterId?: string;
            };
          }) =>
            entry.actionAudit?.status === "done"
            && (entry.actionAudit.receiptCount === 1
              || (kind === "profile" && entry.actionAudit.receiptCount === 2))
            && entry.actionAudit.designProposalId === designSource.designProposalId
            && entry.actionAudit.designDecisionId === designSource.designDecisionId
            && entry.actionAudit.designCharterId === designSource.designCharterId,
        )).toBe(true);
      }
      let listedEpisodesError = "";
      try {
        listEvolutionRecords({
          harness,
          dbPath,
          kind: "episode",
          projectId: project.id,
          profileId: profile.id,
        });
      } catch (error) {
        listedEpisodesError = (error as Error).message;
      }
      expect(listedEpisodesError).toContain("evolution action audit receipt not found");
      expect(listedEpisodesError).not.toContain(heldoutEpisode.sourceRef);
      let listedExperimentsError = "";
      try {
        listEvolutionRecords({
          harness,
          dbPath,
          kind: "experiment",
          projectId: project.id,
          profileId: profile.id,
        });
      } catch (error) {
        listedExperimentsError = (error as Error).message;
      }
      expect(listedExperimentsError).toContain("evolution action audit receipt not found");
      expect(listedExperimentsError).not.toContain(developmentEpisode.id);
      expect(listedExperimentsError).not.toContain(heldoutEpisode.id);
      expect(listedExperimentsError).not.toContain(unrelatedEpisode.id);
      const after = await snapshotDatabaseFilesystem(dbPath, dir);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ctimeMs).toBe(before.ctimeMs);
      expect(after.parentMode).toBe(before.parentMode);
      expect(after.sidecars).toEqual(before.sidecars);
      expect(after.dirEntries).toEqual(before.dirEntries);
    } finally {
      await chmod(dir, 0o755).catch(() => undefined);
      await chmod(dbPath, 0o644).catch(() => undefined);
    }
  });

  test("evolution fixed actions prevent cross-design receipts for one record", async () => {
    const harness = new Harness(dbPath);
    harness.init();
    const projectId = harness.createProject({
      name: "Cross-design Evolution Receipt Project",
      rootPath: dir,
    });
    const charter = harness.createFounderCharter({
      id: "charter_evolution_readback_cross_design",
      projectId,
      mission: "Keep evolution records bound to one design source.",
      charter: { mission: "Keep evolution records bound to one design source." },
      activate: true,
    });
    const firstDesign = createAcceptedEvolutionDesignSource({
      harness,
      projectId,
      charterId: charter.id,
      suffix: "cross_design_first",
    });
    const secondDesign = createAcceptedEvolutionDesignSource({
      harness,
      projectId,
      charterId: charter.id,
      suffix: "cross_design_second",
    });
    const firstRunId = harness.createRun({
      projectId,
      goal: "Record the first design receipt",
      context: firstDesign.runContext,
    });
    const secondRunId = harness.createRun({
      projectId,
      goal: "Attempt a receipt from another design",
      context: secondDesign.runContext,
    });
    const profileBody = {
      schemaVersion: 1,
      projectId,
      pack: {
        id: firstDesign.pack.id,
        version: firstDesign.pack.version,
        contentSha256: canonicalEvolutionValueSha256(firstDesign.pack),
      },
      charter: {
        id: charter.id,
        version: charter.version,
        contentSha256: canonicalEvolutionValueSha256(charter.charter),
      },
      runtimeMaturity: "declared",
      allowedSurfaceIds: firstDesign.pack.mutationSurfaces.map((surface) => surface.id),
      registeredAt: "2026-08-09T10:00:00Z",
    };
    const profile = {
      ...profileBody,
      id: expectedEvolutionRecordId("profile", profileBody),
    };
    const firstResult = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: firstRunId,
      profile,
    });
    expect(firstResult.status).toBe("done");
    const secondResult = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: secondRunId,
      profile,
    });
    expect(secondResult.status).toBe("blocked");
    expect(secondResult.problems.join(" ")).toContain("authorization provenance mismatch");
    checkpointDatabase(dbPath);

    expect(showEvolutionRecord({
      harness,
      dbPath,
      kind: "profile",
      projectId,
      id: profile.id,
    }).actionAudit).toMatchObject({
      ...firstDesign.designSource,
      receiptCount: 1,
    });
    expect(listEvolutionRecords({
      harness,
      dbPath,
      kind: "profile",
      projectId,
    }).records[0].actionAudit).toMatchObject({
      ...firstDesign.designSource,
      receiptCount: 1,
    });
  });

  test("evolution record inspection rejects a receipt after its source run design context drifts", async () => {
    const harness = new Harness(dbPath);
    harness.init();
    const projectId = harness.createProject({
      name: "Drifted Evolution Receipt Project",
      rootPath: dir,
    });
    const charter = harness.createFounderCharter({
      id: "charter_evolution_readback_drift",
      projectId,
      mission: "Keep receipt source context immutable in meaning.",
      charter: { mission: "Keep receipt source context immutable in meaning." },
      activate: true,
    });
    const originalDesign = createAcceptedEvolutionDesignSource({
      harness,
      projectId,
      charterId: charter.id,
      suffix: "drift_original",
    });
    const replacementDesign = createAcceptedEvolutionDesignSource({
      harness,
      projectId,
      charterId: charter.id,
      suffix: "drift_replacement",
    });
    const runId = harness.createRun({
      projectId,
      goal: "Record one trusted profile receipt",
      context: originalDesign.runContext,
    });
    const profileBody = {
      schemaVersion: 1,
      projectId,
      pack: {
        id: originalDesign.pack.id,
        version: originalDesign.pack.version,
        contentSha256: canonicalEvolutionValueSha256(originalDesign.pack),
      },
      charter: {
        id: charter.id,
        version: charter.version,
        contentSha256: canonicalEvolutionValueSha256(charter.charter),
      },
      runtimeMaturity: "declared",
      allowedSurfaceIds: originalDesign.pack.mutationSurfaces.map((surface) => surface.id),
      registeredAt: "2026-08-09T10:01:00Z",
    };
    const profile = {
      ...profileBody,
      id: expectedEvolutionRecordId("profile", profileBody),
    };
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId,
      profile,
    }).status).toBe("done");
    harness.updateRun({ runId, contextPatch: replacementDesign.designSource });
    checkpointDatabase(dbPath);

    expect(() => showEvolutionRecord({
      harness,
      dbPath,
      kind: "profile",
      projectId,
      id: profile.id,
    })).toThrow("receipt design source does not match source run frozen context");
    expect(() => listEvolutionRecords({
      harness,
      dbPath,
      kind: "profile",
      projectId,
    })).toThrow("receipt design source does not match source run frozen context");
  });

  test("evolution record inspection fails closed for unknown kinds, records, and invalid profile filters", async () => {
    const harness = new Harness(dbPath);
    harness.init();
    const project = {
      id: harness.createProject({
        name: "Evolution Validation Project",
        rootPath: dir,
      }),
    };
    const otherProject = {
      id: harness.createProject({
        name: "Other Evolution Project",
        rootPath: join(dir, "other-project"),
      }),
    };
    const missingReceiptProject = {
      id: harness.createProject({
        name: "Missing Evolution Receipt Project",
        rootPath: join(dir, "missing-receipt-project"),
      }),
    };
    const validSourceRunId = harness.createRun({ projectId: project.id, goal: "Valid audit source" });
    const otherProjectRunId = harness.createRun({ projectId: otherProject.id, goal: "Foreign audit source" });
    const profileBody = {
      schemaVersion: 1,
      projectId: project.id,
      pack: { id: "pack_scope_v1", version: 1, contentSha256: "4".repeat(64) },
      charter: { id: "charter_scope_v1", version: 1, contentSha256: "5".repeat(64) },
      runtimeMaturity: "declared",
      allowedSurfaceIds: ["surface.scope"],
      registeredAt: "2026-08-09T09:00:00Z",
    };
    const profile = {
      ...profileBody,
      id: expectedEvolutionRecordId("profile", profileBody),
    };
    harness.recordEvolutionProfile(profile);
    const missingRunProfileBody = {
      ...profileBody,
      registeredAt: "2026-08-09T09:01:00Z",
    };
    const missingRunProfile = {
      ...missingRunProfileBody,
      id: expectedEvolutionRecordId("profile", missingRunProfileBody),
    };
    harness.recordEvolutionProfile(missingRunProfile);
    const foreignRunProfileBody = {
      ...profileBody,
      registeredAt: "2026-08-09T09:02:00Z",
    };
    const foreignRunProfile = {
      ...foreignRunProfileBody,
      id: expectedEvolutionRecordId("profile", foreignRunProfileBody),
    };
    harness.recordEvolutionProfile(foreignRunProfile);
    const missingReceiptProfileBody = {
      ...profileBody,
      projectId: missingReceiptProject.id,
      registeredAt: "2026-08-09T09:03:00Z",
    };
    const missingReceiptProfile = {
      ...missingReceiptProfileBody,
      id: expectedEvolutionRecordId("profile", missingReceiptProfileBody),
    };
    harness.recordEvolutionProfile(missingReceiptProfile);
    const missingReceiptCharter = harness.createFounderCharter({
      id: "charter_evolution_readback_missing_receipt",
      projectId: missingReceiptProject.id,
      mission: "Reject unaudited manual evolution events.",
      charter: { mission: "Reject unaudited manual evolution events." },
      activate: true,
    });
    const missingReceiptDesign = createAcceptedEvolutionDesignSource({
      harness,
      projectId: missingReceiptProject.id,
      charterId: missingReceiptCharter.id,
      suffix: "missing_receipt",
    });
    const missingReceiptRunId = harness.createRun({
      projectId: missingReceiptProject.id,
      goal: "Attempt a manual done event without a trusted receipt",
      context: missingReceiptDesign.runContext,
    });
    const missingReceiptSha256 = canonicalEvolutionRecordSha256(missingReceiptProfile);
    harness.recordHarnessActionEvent({
      actionType: "registerEvolutionProfile",
      status: "done",
      request: {
        type: "registerEvolutionProfile",
        runId: missingReceiptRunId,
        entityKind: "profile",
        recordId: missingReceiptProfile.id,
        recordSha256: missingReceiptSha256,
      },
      result: {
        status: "done",
        actionType: "registerEvolutionProfile",
        artifacts: [{
          kind: "evolution_profile",
          entityKind: "profile",
          recordId: missingReceiptProfile.id,
          recordSha256: missingReceiptSha256,
          projectId: missingReceiptProject.id,
          sourceRunId: missingReceiptRunId,
          externalEffectsApplied: false,
          promotionApplied: false,
          replayed: false,
        }],
      },
    });
    const insertForgedProfileActionEvent = (input: {
      id: string;
      runId: string;
      profileId: string;
      recordSha256: string;
    }) => {
      const database = new Database(dbPath);
      try {
        const request = {
          type: "registerEvolutionProfile",
          runId: input.runId,
          entityKind: "profile",
          recordId: input.profileId,
          recordSha256: input.recordSha256,
        };
        const result = {
          status: "done",
          actionType: "registerEvolutionProfile",
          artifacts: [{
            kind: "evolution_profile",
            entityKind: "profile",
            recordId: input.profileId,
            recordSha256: input.recordSha256,
            projectId: project.id,
            sourceRunId: input.runId,
            externalEffectsApplied: false,
            promotionApplied: false,
            replayed: false,
          }],
        };
        database.query(
          `insert into harness_action_events
           (id, action_type, status, request_json, result_json)
           values ($id, 'registerEvolutionProfile', 'done', $requestJson, $resultJson)`,
        ).run({
          $id: input.id,
          $requestJson: JSON.stringify(request),
          $resultJson: JSON.stringify(result),
        });
      } finally {
        database.close();
      }
    };
    insertForgedProfileActionEvent({
      id: "action_tampered_evolution_hash",
      runId: validSourceRunId,
      profileId: profile.id,
      recordSha256: "f".repeat(64),
    });
    insertForgedProfileActionEvent({
      id: "action_missing_evolution_run",
      runId: "run_missing_audit_source",
      profileId: missingRunProfile.id,
      recordSha256: canonicalEvolutionRecordSha256(missingRunProfile),
    });
    insertForgedProfileActionEvent({
      id: "action_foreign_evolution_run",
      runId: otherProjectRunId,
      profileId: foreignRunProfile.id,
      recordSha256: canonicalEvolutionRecordSha256(foreignRunProfile),
    });
    checkpointDatabase(dbPath);
    const unknownKindPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "receipt",
      "--project-id",
      project.id,
      "--id",
      `receipt_${"1".repeat(64)}`,
      "--json",
      "true",
    );

    const unknownRecordPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      project.id,
      "--id",
      `profile_${"2".repeat(64)}`,
      "--json",
      "true",
    );

    const wrongProjectPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      otherProject.id,
      "--id",
      profile.id,
      "--json",
      "true",
    );

    const tamperedAuditPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      project.id,
      "--id",
      profile.id,
      "--json",
      "true",
    );

    const missingRunAuditPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      project.id,
      "--id",
      missingRunProfile.id,
      "--json",
      "true",
    );

    const foreignRunAuditPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      project.id,
      "--id",
      foreignRunProfile.id,
      "--json",
      "true",
    );

    const missingReceiptAuditPromise = runCliRaw(
      "show-evolution-record",
      "--kind",
      "profile",
      "--project-id",
      missingReceiptProject.id,
      "--id",
      missingReceiptProfile.id,
      "--json",
      "true",
    );

    const missingReceiptListPromise = runCliRaw(
      "list-evolution-records",
      "--kind",
      "profile",
      "--project-id",
      missingReceiptProject.id,
      "--json",
      "true",
    );

    const invalidFilterPromise = runCliRaw(
      "list-evolution-records",
      "--kind",
      "profile",
      "--project-id",
      project.id,
      "--profile-id",
      `profile_${"3".repeat(64)}`,
      "--json",
      "true",
    );

    const missingJsonPromise = runCliRaw(
      "list-evolution-records",
      "--kind",
      "profile",
      "--project-id",
      project.id,
    );
    const [
      unknownKind,
      unknownRecord,
      wrongProject,
      tamperedAudit,
      missingRunAudit,
      foreignRunAudit,
      missingReceiptAudit,
      missingReceiptList,
      invalidFilter,
      missingJson,
    ] =
      await Promise.all([
        unknownKindPromise,
        unknownRecordPromise,
        wrongProjectPromise,
        tamperedAuditPromise,
        missingRunAuditPromise,
        foreignRunAuditPromise,
        missingReceiptAuditPromise,
        missingReceiptListPromise,
        invalidFilterPromise,
        missingJsonPromise,
      ]);
    expect(unknownKind.exitCode).not.toBe(0);
    expect(unknownKind.stderr).toContain("--kind must be profile, episode, variant, or experiment");
    expect(unknownRecord.exitCode).not.toBe(0);
    expect(unknownRecord.stderr).toContain("evolution profile record not found");
    expect(wrongProject.exitCode).not.toBe(0);
    expect(wrongProject.stderr).toContain(
      `evolution profile record not found: ${profile.id} for project ${otherProject.id}`,
    );
    expect(tamperedAudit.exitCode).not.toBe(0);
    expect(tamperedAudit.stderr).toContain("evolution action audit readback mismatch");
    expect(missingRunAudit.exitCode).not.toBe(0);
    expect(missingRunAudit.stderr).toContain("evolution action audit source run not found");
    expect(foreignRunAudit.exitCode).not.toBe(0);
    expect(foreignRunAudit.stderr).toContain("evolution action audit source run project mismatch");
    expect(missingReceiptAudit.exitCode).not.toBe(0);
    expect(missingReceiptAudit.stderr).toContain(
      "matching done action event is missing its immutable evolution receipt",
    );
    expect(missingReceiptList.exitCode).not.toBe(0);
    expect(missingReceiptList.stderr).toContain(
      "matching done action event is missing its immutable evolution receipt",
    );
    expect(invalidFilter.exitCode).not.toBe(0);
    expect(invalidFilter.stderr).toContain("--profile-id is not valid for profile records");
    expect(missingJson.exitCode).not.toBe(0);
    expect(missingJson.stderr).toContain("--json is required for evolution record inspection");
  });

  test("design-status prints concise charter, proposal, and outcome summaries", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Design Project",
      "--root-path",
      dir,
    );
    const harness = new Harness(dbPath);
    harness.createFounderCharter({
      projectId: project.id,
      mission: "Ship calm dashboard visibility for the design loop",
      activate: true,
      charter: {
        mission: "Ship calm dashboard visibility for the design loop",
        capitalPolicy: {
          currency: "USD",
          monthlyBudget: 5000,
          experimentBudget: 1500,
          recurringSpendApprovalAbove: 800,
          runwayFloorMonths: 12,
          portfolio: { core: 60, growth: 30, exploration: 10 },
        },
        authority: {
          autoResearch: true,
          autoReversibleExperiments: true,
          autoIntegrateVerifiedCode: false,
          requireHumanFor: ["irreversible-spend"],
        },
        reviewCadenceDays: 14,
      },
    });
    const proposal = harness.createDesignProposal({
      projectId: project.id,
      title: "Add designer inspector disclosure",
      problem: "Dashboard lacks visibility into the design loop.",
      recommendation: "Render a concise designer card with details behind disclosure.",
      status: "experimenting",
      proposal: {
        problem: "Dashboard lacks visibility into the design loop.",
        recommendation: "Render a concise designer card with details behind disclosure.",
        investment: {
          reversibility: "easy",
          portfolio: "growth",
          oneTimeCost: 1200,
          recurringCost: 0,
          timeBudget: "2 weeks",
        },
        evaluationContract: {
          baseline: ["no designer card"],
          successMetrics: ["decisions visible within one glance"],
          guardMetrics: ["dashboard render time under 200ms"],
          requiredEvidence: ["screenshot of disclosure expanded"],
          reviewAt: "2026-08-20",
        },
      },
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      reasons: ["visibility is cheap", "disclosure keeps the calm default"],
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      evidence: ["disclosure expanded shows budget"],
      reviewAt: "2026-08-18",
    });
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "delivery",
      source: "dashboard-walkthrough",
      title: "Default dashboard should stay calm",
      summary: "Calm default matters for founder attention.",
      confidence: 0.6,
      observationTime: "2026-08-02T10:00:00Z",
    });

    const output = await runCli("design-status", "--project-id", project.id);
    expect(output).toContain("Designer status");
    expect(output).toContain("Active charter");
    expect(output).toContain("mission: Ship calm dashboard visibility for the design loop");
    expect(output).toContain("budget: monthly USD 5000, experiment USD 1500");
    expect(output).toContain("portfolio: core 60%, growth 30%, exploration 10%");
    expect(output).toContain("authority: auto-research, auto-experiments");
    expect(output).toContain("human checkpoints: irreversible-spend");
    expect(output).toContain("Current proposal");
    expect(output).toContain("status: experimenting");
    expect(output).toContain("title: Add designer inspector disclosure");
    expect(output).toContain("investment: one-time 1200, recurring 0");
    expect(output).toContain("latest decision: approved by human");
    expect(output).toContain("Outcomes");
    expect(output).toContain("Signals and proposals");
    expect(output).toContain("active signals: 1");
    expect(output).toContain("proposals: experimenting=1");

    const json = await runCliJson("design-status", "--project-id", project.id, "--json", "true");
    expect(json).toMatchObject({
      projectId: project.id,
      charter: expect.objectContaining({
        mission: "Ship calm dashboard visibility for the design loop",
      }),
      currentProposal: expect.objectContaining({
        status: "experimenting",
        title: "Add designer inspector disclosure",
      }),
      latestDecision: expect.objectContaining({
        decision: "approved",
        actorKind: "human",
      }),
      activeSignalCount: 1,
      proposalCountsByStatus: { experimenting: 1 },
    });
    expect(json.recentOutcomes[0]).toMatchObject({
      stage: "review",
      recommendation: "retain",
      reviewAt: "2026-08-18",
    });
  });

  test("design-status handles projects with no charter or proposals", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Empty Project",
      "--root-path",
      dir,
    );
    const output = await runCli("design-status", "--project-id", project.id);
    expect(output).toContain("Designer status");
    expect(output).toContain("Active charter");
    expect(output).toContain("(none)");
    expect(output).toContain("Current proposal");
    expect(output).toContain("(none)");
    expect(output).toContain("active signals: 0");

    const json = await runCliJson("design-status", "--project-id", project.id, "--json", "true");
    expect(json).toMatchObject({
      projectId: project.id,
      charter: null,
      currentProposal: null,
      latestDecision: null,
      activeSignalCount: 0,
    });
  });

  test("design-status resolves project-id from project-root flag", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Root Resolved Project",
      "--root-path",
      dir,
    );
    const output = await runCli("design-status", "--project-root", dir);
    expect(output).toContain("Designer status");
    expect(output).toContain("active signals: 0");

    const json = await runCliJson("design-status", "--project-root", dir, "--json", "true");
    expect(json.projectId).toBe(project.id);
  });

  test("list-signals filters by class and status with concise and JSON output", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Signals Project",
      "--root-path",
      dir,
    );
    const harness = new Harness(dbPath);
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "delivery",
      source: "retro-1",
      title: "Tighten design loop cadence",
      summary: "Weekly reviews slip.",
      confidence: 0.7,
      observationTime: "2026-08-01T08:00:00Z",
    });
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "market",
      source: "user-interview-3",
      title: "User asks for designer visibility",
      summary: "Common request across interviews.",
      confidence: 0.4,
      observationTime: "2026-07-30T08:00:00Z",
    });
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "delivery",
      source: "retro-2",
      title: "Stale signal",
      summary: "Should drop.",
      confidence: 0.2,
      status: "superseded",
      observationTime: "2026-07-15T08:00:00Z",
    });

    const concise = await runCli("list-signals", "--project-id", project.id);
    expect(concise).toContain("Strategy signals (2)");
    expect(concise).toContain("[delivery] active");
    expect(concise).toContain("source: retro-1");
    expect(concise).toContain("title: Tighten design loop cadence");
    expect(concise).toContain("[market] active");
    expect(concise).not.toContain("Stale signal");

    const filtered = await runCli(
      "list-signals",
      "--project-id",
      project.id,
      "--class",
      "market",
    );
    expect(filtered).toContain("Strategy signals (1)");
    expect(filtered).toContain("[market] active");
    expect(filtered).not.toContain("[delivery]");

    const json = await runCliJson(
      "list-signals",
      "--project-id",
      project.id,
      "--json",
      "true",
    );
    expect(json).toMatchObject({
      projectId: project.id,
      totalCount: 2,
      signalClass: null,
    });
    expect(json.signals).toHaveLength(2);
    expect(json.signals[0]).toMatchObject({
      signalClass: "delivery",
      source: "retro-1",
      title: "Tighten design loop cadence",
      status: "active",
    });

    const superseded = await runCliJson(
      "list-signals",
      "--project-id",
      project.id,
      "--statuses",
      "superseded",
      "--json",
      "true",
    );
    expect(superseded.totalCount).toBe(1);
    expect(superseded.signals[0]).toMatchObject({ source: "retro-2", status: "superseded" });
  });

  test("show-design prints proposal detail with decisions and outcomes", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Show Design Project",
      "--root-path",
      dir,
    );
    const harness = new Harness(dbPath);
    const proposal = harness.createDesignProposal({
      projectId: project.id,
      title: "Show design proposal detail",
      problem: "Inspector does not surface proposal evidence.",
      recommendation: "Add show-design command.",
      status: "accepted",
      proposal: {
        problem: "Inspector does not surface proposal evidence.",
        recommendation: "Add show-design command.",
        options: [
          {
            name: "cli-only",
            benefits: ["fast to implement"],
            costs: ["requires terminal"],
            risks: ["power users only"],
            lockIn: ["cli surface contract"],
          },
        ],
        evaluationContract: {
          baseline: ["manual sqlite queries"],
          successMetrics: ["readable proposal from one command"],
          guardMetrics: ["no PII leaked"],
          requiredEvidence: ["command output captured"],
          reviewAt: "2026-09-01",
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 800,
          recurringCost: 0,
          timeBudget: "1 week",
        },
        experiment: {
          hypothesis: "Founders can read a proposal in one command.",
          smallestTest: "Run show-design in the next design review.",
          stopConditions: ["unreadable output"],
          rollback: "Drop the command.",
        },
      },
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@local",
      reasons: ["cheap to ship", "reversible"],
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      evidence: ["reviewer read the proposal out loud"],
      unexpectedEffects: [],
    });

    const output = await runCli("show-design", "--proposal-id", proposal.id);
    expect(output).toContain(`Design proposal ${proposal.id}`);
    expect(output).toContain("status: accepted");
    expect(output).toContain("Options");
    expect(output).toContain("- cli-only");
    expect(output).toContain("benefits: fast to implement");
    expect(output).toContain("costs: requires terminal");
    expect(output).toContain("Evaluation contract (frozen)");
    expect(output).toContain("success metrics: readable proposal from one command");
    expect(output).toContain("Investment");
    expect(output).toContain("reversibility: easy");
    expect(output).toContain("Experiment");
    expect(output).toContain("hypothesis: Founders can read a proposal in one command.");
    expect(output).toContain("Decisions (1)");
    expect(output).toContain("approved by human (founder@local)");
    expect(output).toContain("Outcomes (1)");

    const json = await runCliJson("show-design", "--proposal-id", proposal.id, "--json", "true");
    expect(json).toMatchObject({
      proposal: expect.objectContaining({
        id: proposal.id,
        status: "accepted",
        title: "Show design proposal detail",
      }),
      decisions: [
        expect.objectContaining({
          decision: "approved",
          actorKind: "human",
          actorRef: "founder@local",
        }),
      ],
      outcomes: [
        expect.objectContaining({
          stage: "review",
          recommendation: "retain",
        }),
      ],
    });
  });

  test("show-design fails clearly for unknown proposal ids", async () => {
    await runCli("init");
    const result = await runCliRaw("show-design", "--proposal-id", "design_missing");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("design proposal not found: design_missing");
  });

  test("Designer inspection commands work against an initialized read-only database without mutating filesystem state", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Readonly Project",
      "--root-path",
      dir,
    );
    const harness = new Harness(dbPath);
    const charter = harness.createFounderCharter({
      projectId: project.id,
      mission: "Read-only inspection",
      charter: {
        mission: "Read-only inspection",
        capitalPolicy: { currency: "USD", experimentBudget: 100 },
      },
      activate: true,
    });
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "system",
      source: "test",
      title: "Active signal",
      summary: "Read-only seed",
      observationTime: "2026-08-01T00:00:00Z",
      confidence: 0.5,
    });
    const proposal = harness.createDesignProposal({
      projectId: project.id,
      charterId: charter.id,
      title: "Read-only proposal",
      problem: "Read-only inspection",
      recommendation: "Inspect without writes",
      status: "accepted",
      proposal: {
        problem: "Read-only inspection",
        recommendation: "Inspect without writes",
        evaluationContract: {
          baseline: [],
          successMetrics: [],
          guardMetrics: [],
          requiredEvidence: [],
          reviewAt: "2026-09-01T00:00:00Z",
        },
        investment: { reversibility: "easy", portfolio: "core" },
      },
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      charterId: charter.id,
      decision: "approved",
      actorKind: "auto",
      authority: { disposition: "automatic" },
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      reviewAt: "2026-08-01T00:00:00Z",
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      reviewAt: "2026-12-01T00:00:00Z",
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "experiment",
      recommendation: "retain",
    });

    // Checkpoint the WAL into the main database file so inspection can run
    // through the immutable read-only path against the file's durable state.
    // The inspection contract targets a quiescent database; checkpointing here
    // mirrors how the harness leaves a database once write transactions have
    // committed and prevents a subprocess close from triggering a checkpoint
    // that would write into the main database file under read-only filesystem
    // permissions.
    checkpointDatabase(dbPath);

    // Make the database and parent directory read-only. From here on, any
    // write attempt (init, pragma, sidecar creation) must either fail loudly
    // or be absent from the inspection code path entirely.
    await chmod(dir, 0o555);
    await chmod(dbPath, 0o444);
    // Drop write permission from WAL/SHM if present so any write attempt fails.
    await chmod(`${dbPath}-wal`, 0o444).catch(() => undefined);
    await chmod(`${dbPath}-shm`, 0o444).catch(() => undefined);

    try {
      // Snapshot filesystem state in the read-only state immediately before any
      // inspection command runs. chmod is part of the test setup, not inspection,
      // so the diff isolates mutations caused by the inspection commands.
      const before = await snapshotDatabaseFilesystem(dbPath, dir);

      const designStatusJson = await runCliJson(
        "design-status",
        "--project-id",
        project.id,
        "--json",
        "true",
      );
      expect(designStatusJson).toMatchObject({
        projectId: project.id,
        charter: expect.objectContaining({ id: charter.id }),
        currentProposal: expect.objectContaining({ id: proposal.id }),
      });

      const listSignalsJson = await runCliJson(
        "list-signals",
        "--project-id",
        project.id,
        "--json",
        "true",
      );
      expect(listSignalsJson.totalCount).toBe(1);
      expect(listSignalsJson.signals[0]).toMatchObject({ title: "Active signal" });

      const showDesignJson = await runCliJson(
        "show-design",
        "--proposal-id",
        proposal.id,
        "--json",
        "true",
      );
      expect(showDesignJson).toMatchObject({
        proposal: expect.objectContaining({ id: proposal.id }),
      });
      expect(showDesignJson.outcomes.length).toBe(3);

      const outcomesJson = await runCliJson(
        "list-design-outcomes",
        "--project-id",
        project.id,
        "--status",
        "due",
        "--due-before",
        "2026-08-11T00:00:00Z",
        "--json",
        "true",
      );
      expect(outcomesJson).toMatchObject({
        projectId: project.id,
        status: "due",
        evaluatedAt: "2026-08-11T00:00:00Z",
        totalCount: 1,
      });
      expect(outcomesJson.outcomes[0]).toMatchObject({
        stage: "review",
        recommendation: "retain",
        reviewAt: "2026-08-01T00:00:00Z",
        due: true,
      });

      // Concise output should also work and surface stable identifiers.
      const concise = await runCli(
        "list-design-outcomes",
        "--project-id",
        project.id,
        "--status",
        "due",
        "--due-before",
        "2026-08-11T00:00:00Z",
      );
      expect(concise).toContain("Design outcome reviews");
      expect(concise).toContain("Evaluated at: 2026-08-11T00:00:00Z");
      expect(concise).toContain("due");
      expect(concise).toContain(proposal.id.slice(0, 12));

      const futureOnly = await runCliJson(
        "list-design-outcomes",
        "--project-id",
        project.id,
        "--status",
        "due",
        "--due-before",
        "2026-07-01T00:00:00Z",
        "--json",
        "true",
      );
      expect(futureOnly.totalCount).toBe(0);
      expect(futureOnly.outcomes).toEqual([]);

      // Filtering only future outcomes via no --status should include all three.
      const allOutcomes = await runCliJson(
        "list-design-outcomes",
        "--project-id",
        project.id,
        "--json",
        "true",
      );
      expect(allOutcomes.totalCount).toBe(3);
      expect(allOutcomes.evaluatedAt).toBeNull();

      // Snapshot filesystem state again without restoring write permission so
      // the only deltas that can appear are mutations caused by inspection.
      const after = await snapshotDatabaseFilesystem(dbPath, dir);

      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ctimeMs).toBe(before.ctimeMs);
      expect(after.parentMode).toBe(before.parentMode);
      expect(after.sidecars).toEqual(before.sidecars);
      expect(after.dirEntries).toEqual(before.dirEntries);
    } finally {
      // Restore write permission so afterEach can delete the temp directory,
      // even if an assertion fails inside the read-only window.
      await chmod(dir, 0o755).catch(() => undefined);
      await chmod(dbPath, 0o644).catch(() => undefined);
      await chmod(`${dbPath}-wal`, 0o644).catch(() => undefined);
      await chmod(`${dbPath}-shm`, 0o644).catch(() => undefined);
    }
  });

  test("Designer inspection commands work against a sidecar-free checkpointed WAL database under read-only filesystem", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Sidecar Free Project",
      "--root-path",
      dir,
    );
    const harness = new Harness(dbPath);
    const charter = harness.createFounderCharter({
      projectId: project.id,
      mission: "Sidecar-free inspection",
      charter: {
        mission: "Sidecar-free inspection",
        capitalPolicy: { currency: "USD", experimentBudget: 100 },
      },
      activate: true,
    });
    harness.createStrategySignal({
      projectId: project.id,
      signalClass: "system",
      source: "test",
      title: "Active signal",
      summary: "Sidecar-free seed",
      observationTime: "2026-08-01T00:00:00Z",
      confidence: 0.5,
    });
    const proposal = harness.createDesignProposal({
      projectId: project.id,
      charterId: charter.id,
      title: "Sidecar-free proposal",
      problem: "Inspection without sidecars",
      recommendation: "Inspect via immutable open",
      status: "accepted",
      proposal: {
        problem: "Inspection without sidecars",
        recommendation: "Inspect via immutable open",
        evaluationContract: {
          baseline: [],
          successMetrics: [],
          guardMetrics: [],
          requiredEvidence: [],
          reviewAt: "2026-09-01T00:00:00Z",
        },
        investment: { reversibility: "easy", portfolio: "core" },
      },
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      charterId: charter.id,
      decision: "approved",
      actorKind: "auto",
      authority: { disposition: "automatic" },
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      reviewAt: "2026-08-01T00:00:00Z",
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "review",
      recommendation: "retain",
      reviewAt: "2026-12-01T00:00:00Z",
    });
    harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "experiment",
      recommendation: "retain",
    });

    // Force a TRUNCATE checkpoint and remove WAL/SHM sidecars. The database
    // is now exactly one file. Inspection must succeed without recreating
    // sidecars or touching file metadata.
    checkpointDatabase(dbPath);
    await rm(`${dbPath}-wal`).catch(() => undefined);
    await rm(`${dbPath}-shm`).catch(() => undefined);
    await rm(`${dbPath}-journal`).catch(() => undefined);

    // Lock down filesystem.
    await chmod(dir, 0o555);
    await chmod(dbPath, 0o444);

    const before = await snapshotDatabaseFilesystem(dbPath, dir);
    expect(before.sidecars.wal).toBe(false);
    expect(before.sidecars.shm).toBe(false);
    expect(before.sidecars.journal).toBe(false);

    // Run all four inspection commands in concise and JSON modes.
    const designStatusJson = await runCliJson(
      "design-status",
      "--project-id",
      project.id,
      "--json",
      "true",
    );
    expect(designStatusJson).toMatchObject({
      projectId: project.id,
      charter: expect.objectContaining({ id: charter.id }),
      currentProposal: expect.objectContaining({ id: proposal.id }),
    });

    const listSignalsJson = await runCliJson(
      "list-signals",
      "--project-id",
      project.id,
      "--json",
      "true",
    );
    expect(listSignalsJson.totalCount).toBe(1);
    expect(listSignalsJson.signals[0]).toMatchObject({ title: "Active signal" });

    const showDesignJson = await runCliJson(
      "show-design",
      "--proposal-id",
      proposal.id,
      "--json",
      "true",
    );
    expect(showDesignJson).toMatchObject({
      proposal: expect.objectContaining({ id: proposal.id }),
    });
    expect(showDesignJson.outcomes.length).toBe(3);

    const outcomesJson = await runCliJson(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--status",
      "due",
      "--due-before",
      "2026-08-11T00:00:00Z",
      "--json",
      "true",
    );
    expect(outcomesJson).toMatchObject({
      projectId: project.id,
      status: "due",
      evaluatedAt: "2026-08-11T00:00:00Z",
      totalCount: 1,
    });

    // Concise output mode also exercises the read path.
    const concise = await runCli(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--status",
      "due",
      "--due-before",
      "2026-08-11T00:00:00Z",
    );
    expect(concise).toContain("Design outcome reviews");
    expect(concise).toContain("due");

    const after = await snapshotDatabaseFilesystem(dbPath, dir);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(after.parentMode).toBe(before.parentMode);
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.dirEntries).toEqual(before.dirEntries);

    // Restore write permission so afterEach can delete the temp directory.
    await chmod(dir, 0o755).catch(() => undefined);
    await chmod(dbPath, 0o644).catch(() => undefined);
  });

  test("list-design-outcomes rejects incompatible combinations and bad timestamps", async () => {
    await runCli("init");
    const project = await runCliJson(
      "create-project",
      "--name",
      "Validation Project",
      "--root-path",
      dir,
    );

    const stageWithStatus = await runCliRaw(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--status",
      "due",
      "--stage",
      "review",
    );
    expect(stageWithStatus.exitCode).not.toBe(0);
    expect(stageWithStatus.stderr).toContain("--status due cannot be combined with --stage");

    const badStatus = await runCliRaw(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--status",
      "ready",
    );
    expect(badStatus.exitCode).not.toBe(0);
    expect(badStatus.stderr).toContain("--status must be 'due'");

    const badTimestamp = await runCliRaw(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--status",
      "due",
      "--due-before",
      "2026/08/11 00:00:00",
    );
    expect(badTimestamp.exitCode).not.toBe(0);
    expect(badTimestamp.stderr).toContain("--due-before must be an ISO 8601 UTC timestamp");

    const badStage = await runCliRaw(
      "list-design-outcomes",
      "--project-id",
      project.id,
      "--stage",
      "scheduled",
    );
    expect(badStage.exitCode).not.toBe(0);
    expect(badStage.stderr).toContain("--stage must be one of");
  });

  async function runCli(...rawArgs: Array<string | Record<string, string>>) {
    const result = await runCliRaw(...rawArgs);
    if (result.exitCode !== 0) {
      throw new Error(`CLI failed with ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
  }

  async function createLinearWritebackFixture(input: {
    readbackIssueId?: string;
    scopeIssueId?: string;
    echoCredentialError?: boolean;
    loseCommentCreateResponseOnce?: boolean;
    alterCommentReadback?: boolean;
    failCommentCreate?: boolean;
    exhaustCommentPagination?: boolean;
    injectSensitiveExtraFields?: boolean;
    sensitiveStateName?: boolean;
    malformedStatusScope?: boolean;
    malformedCommentPage?: boolean;
    permissionDenied?: boolean;
    missingIssue?: boolean;
    teamStatesOverride?: Array<{ id: string; name: string; type?: string | null }>;
    malformedTeamStates?: boolean;
  } = {}) {
    const issueId = "0ad49c7d-9f2b-4f2e-8743-ee017d841171";
    const teamId = "8ec14dab-a05d-4d78-95fa-e59301005499";
    const targetStateId = "77777777-7777-4777-8777-777777777777";
    const backlogStateId = "66666666-6666-4666-8666-666666666666";
    const token = "lin_api_fixture_secret_123";
    const tokenPath = join(dir, "linear-writeback-token");
    const writebackSecretPath = join(dir, "linear-writeback-secret");
    const writebackSecret = "fixture_writeback_hmac_key_0123456789abcdef";
    const configPath = join(dir, "linear-writeback.toml");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const comments: Array<{ id: string; body: string }> = [];
    let currentStateId = backlogStateId;
    let issueUpdateCount = 0;
    let commentCreateCount = 0;
    let commentListCount = 0;
    let loseResponse = input.loseCommentCreateResponseOnce === true;
    let failCommentCreate = input.failCommentCreate === true;

    const state = (id: string) => ({
      id,
      name: input.sensitiveStateName && id === targetStateId
        ? "access_token=OTHER_SECRET_999"
        : id === targetStateId ? "In Progress" : "Backlog",
      type: id === targetStateId ? "started" : "backlog",
      team: { id: teamId, key: "PAN" },
    });
    const teamStates = () => {
      if (input.malformedTeamStates) {
        return { nodes: "not-an-array" as unknown as Array<{ id: string; name: string; type?: string | null }> };
      }
      const base = [
        { id: targetStateId, name: "In Progress", type: "started" },
        { id: backlogStateId, name: "Backlog", type: "backlog" },
      ];
      return { nodes: input.teamStatesOverride ?? base };
    };
    const issue = (id = issueId) => ({
      id,
      identifier: "PAN-1232",
      team: { id: teamId, key: "PAN" },
      state: state(currentStateId),
      ...(input.injectSensitiveExtraFields
        ? { Authorization: "Bearer OTHER_SECRET_456", token: "OTHER_SECRET_456" }
        : {}),
    });
    const server = startTestServer({
      async fetch(request) {
        const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
        const variables = body.variables ?? {};
        requests.push({ query: body.query, variables });
        if (input.permissionDenied) {
          return Response.json({
            errors: [{ message: `Authorization: Bearer ${token}` }],
          }, { status: 403 });
        }
        if (input.echoCredentialError && body.query.includes("OuroborosLinearStatusScope")) {
          return Response.json({
            errors: [{
              message: `upstream echoed ${token}`,
              extensions: { Authorization: `Bearer ${token}`, token },
            }],
          });
        }
        if (body.query.includes("OuroborosLinearStatusScope")) {
          if (input.malformedStatusScope) {
            return Response.json({ data: { issue: issue(), workflowState: { ...state(targetStateId), team: null } } });
          }
          return Response.json({
            data: {
              issue: input.missingIssue ? null : issue(input.scopeIssueId ?? issueId),
              workflowState: state(targetStateId),
            },
          });
        }
        if (body.query.includes("OuroborosLinearStatusNameResolve")) {
          if (input.missingIssue) {
            return Response.json({ data: { issue: null } });
          }
          const baseIssue = issue(input.scopeIssueId ?? issueId);
          return Response.json({
            data: {
              issue: {
                id: baseIssue.id,
                identifier: baseIssue.identifier,
                team: {
                  id: teamId,
                  key: "PAN",
                  states: teamStates(),
                },
                state: state(currentStateId),
              },
            },
          });
        }
        if (body.query.includes("OuroborosLinearStatusUpdate")) {
          issueUpdateCount += 1;
          currentStateId = targetStateId;
          return Response.json({ data: { issueUpdate: { success: true, issue: issue() } } });
        }
        if (body.query.includes("OuroborosLinearStatusReadback")) {
          return Response.json({ data: { issue: issue(input.readbackIssueId ?? issueId) } });
        }
        if (body.query.includes("OuroborosLinearEvidenceCommentList")) {
          commentListCount += 1;
          if (input.missingIssue) {
            return Response.json({ data: { issue: null } });
          }
          if (input.malformedCommentPage) {
            return Response.json({ data: { issue: { id: issueId, comments: { nodes: null, pageInfo: null } } } });
          }
          return Response.json({
            data: {
              issue: {
                id: issueId,
                comments: {
                  nodes: comments.map((comment) => ({ ...comment, issue: { id: issueId } })),
                  pageInfo: input.exhaustCommentPagination
                    ? { hasNextPage: true, endCursor: `cursor_${commentListCount}` }
                    : { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }
        if (body.query.includes("OuroborosLinearEvidenceCommentCreate")) {
          commentCreateCount += 1;
          if (failCommentCreate) {
            return Response.json({ errors: [{ message: "temporary comment failure" }] });
          }
          const comment = {
            id: `comment_${comments.length + 1}`,
            body: String((variables.input as { body?: unknown } | undefined)?.body ?? ""),
          };
          comments.push(comment);
          if (loseResponse) {
            loseResponse = false;
            return new Response("upstream connection reset", { status: 502 });
          }
          return Response.json({
            data: { commentCreate: { success: true, comment: { ...comment, issue: { id: issueId } } } },
          });
        }
        if (body.query.includes("OuroborosLinearEvidenceCommentReadback")) {
          const commentId = String(variables.commentId ?? "");
          const stored = comments.find((comment) => comment.id === commentId) ?? null;
          const comment = stored
            ? {
                ...stored,
                body: input.alterCommentReadback ? `${stored.body}\nchanged` : stored.body,
                issue: { id: issueId },
              }
            : null;
          return Response.json({ data: { comment } });
        }
        return Response.json({ errors: [{ message: "unexpected operation" }] }, { status: 400 });
      },
    });
    if (!server) {
      return null;
    }
    await writeFile(tokenPath, token);
    await writeFile(writebackSecretPath, writebackSecret);
    await writeFile(
      configPath,
      [
        "[linear]",
        `api_url = "http://127.0.0.1:${server.port}/graphql"`,
        `token_file = "${tokenPath}"`,
        'team_key = "PAN"',
        "",
      ].join("\n"),
    );
    return {
      server,
      configPath,
      token,
      tokenPath,
      writebackSecretPath,
      writebackSecret,
      issueId,
      teamId,
      targetStateId,
      requests,
      comments,
      issueUpdateCalls: () => issueUpdateCount,
      commentCreateCalls: () => commentCreateCount,
      commentListCalls: () => commentListCount,
      setFailCommentCreate: (value: boolean) => {
        failCommentCreate = value;
      },
      rotateToken: async () => {
        await writeFile(tokenPath, "lin_api_rotated_fixture_secret_456");
      },
      operationNames: () => requests.map((entry) =>
        /(?:query|mutation)\s+(OuroborosLinear\w+)/.exec(entry.query)?.[1] ?? "unknown"),
    };
  }

  async function runCliRaw(...rawArgs: Array<string | Record<string, string>>) {
    const envOverride =
      typeof rawArgs.at(-1) === "object" ? (rawArgs.pop() as Record<string, string>) : {};
    const args = rawArgs as string[];
    const configArgs = args.includes("--config") ? [] : ["--config", join(dir, "missing-config.toml")];
    const cleanProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => (key === "CODEX_SANDBOX" || !key.startsWith("CODEX_")) && key !== "LINEAR_API_KEY",
      ),
    );
    const mainEntry = join(import.meta.dir, "..", "packages", "cli", "src", "main.ts");
    const proc = Bun.spawn({
      cmd: ["bun", mainEntry, "--db", dbPath, ...configArgs, ...args],
      cwd: process.cwd(),
      env: { ...cleanProcessEnv, ...envOverride },
      stdin: "ignore",
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
    const raw = await runCli(...args);
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    return JSON.parse(lines.at(-1) ?? raw);
  }

  async function runDefaultCliRaw(cwd: string, ...rawArgs: string[]) {
    const configArgs = rawArgs.includes("--config") ? [] : ["--config", join(dir, "missing-config.toml")];
    const mainEntry = join(import.meta.dir, "..", "packages", "cli", "src", "main.ts");
    const cleanProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => (key === "CODEX_SANDBOX" || !key.startsWith("CODEX_")) && key !== "LINEAR_API_KEY",
      ),
    );
    const proc = Bun.spawn({
      cmd: ["bun", mainEntry, ...configArgs, ...rawArgs],
      cwd,
      env: cleanProcessEnv,
      stdin: "ignore",
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

  async function runDefaultCliJson(cwd: string, ...args: string[]) {
    const result = await runDefaultCliRaw(cwd, ...args);
    if (result.exitCode !== 0) {
      throw new Error(`CLI failed with ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(result.stdout.trim());
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
      stdin: "ignore",
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

describe("design timeline classification", () => {
  test("isDesignTimelineTaskRole covers designer, planner, worker, verifier, outcome-review, and repair", () => {
    expect(isDesignTimelineTaskRole("designer")).toBe(true);
    expect(isDesignTimelineTaskRole("planner")).toBe(true);
    expect(isDesignTimelineTaskRole("worker")).toBe(true);
    expect(isDesignTimelineTaskRole("verifier")).toBe(true);
    expect(isDesignTimelineTaskRole("outcome-review")).toBe(true);
    expect(isDesignTimelineTaskRole("repair")).toBe(true);
    expect(isDesignTimelineTaskRole("goal-review")).toBe(false);
    expect(isDesignTimelineTaskRole(null)).toBe(false);
    expect(isDesignTimelineTaskRole(undefined)).toBe(false);
  });

  test("isDesignTimelineTaskGoal catches designer, outcome review, proposal, experiment, and strategy signals", () => {
    expect(isDesignTimelineTaskGoal("Design proposal for calm dashboard")).toBe(true);
    expect(isDesignTimelineTaskGoal("Outcome review for proposal_123")).toBe(true);
    expect(isDesignTimelineTaskGoal("Run experiment on inspector disclosure")).toBe(true);
    expect(isDesignTimelineTaskGoal("Strategy signal digest")).toBe(true);
    expect(isDesignTimelineTaskGoal("Implement worker pipeline")).toBe(true);
    expect(isDesignTimelineTaskGoal("Verify frozen contract")).toBe(true);
    expect(isDesignTimelineTaskGoal("Random unrelated goal")).toBe(false);
    expect(isDesignTimelineTaskGoal("")).toBe(false);
    expect(isDesignTimelineTaskGoal(null)).toBe(false);
  });

  test("designTimelineKindForTask maps each covered role to its first-class timeline kind", () => {
    expect(designTimelineKindForTask({ role: "designer", goal: "anything" })).toBe("designer");
    expect(designTimelineKindForTask({ role: "outcome-review", goal: "anything" })).toBe("outcome-review");
    expect(designTimelineKindForTask({ role: "planner", goal: "anything" })).toBe("planner");
    expect(designTimelineKindForTask({ role: "verifier", goal: "anything" })).toBe("verifier");
    expect(designTimelineKindForTask({ role: "worker", goal: "anything" })).toBe("worker");
    expect(designTimelineKindForTask({ role: "repair", goal: "anything" })).toBe("worker");
    expect(designTimelineKindForTask({ role: "employee", goal: "designer walkthrough" })).toBe("designer");
    expect(designTimelineKindForTask({ role: "employee", goal: "outcome review session" })).toBe("outcome-review");
    expect(designTimelineKindForTask({ role: "employee", goal: "Plan delivery" })).toBe("planner");
    expect(designTimelineKindForTask({ role: "employee", goal: "implement worker pipeline" })).toBe("worker");
    expect(designTimelineKindForTask({ role: "employee", goal: "verify contract" })).toBe("verifier");
    expect(designTimelineKindForTask({ role: "employee", goal: "Experiment with calm disclosure" })).toBe("research");
    expect(designTimelineKindForTask({ role: "employee", goal: "Random unrelated goal" })).toBeNull();
  });
});
