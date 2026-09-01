#!/usr/bin/env bun
import {
  acceptGuardrailProposal as acceptGuardrailProposalInContext,
  applyHarnessAction,
  canonicalEvolutionValueSha256,
  describeIntegrationReadiness,
  describeRunCompletionReadiness,
  diagnoseRunOverview,
  Harness,
  listResearchEvidenceLinks,
  makeId,
  proposeGuardrailsFromLessons as buildGuardrailProposalsFromLessons,
  refreshGuardrailProposalsForRun,
  readableList,
  readableValue,
  readSelfImprovementQuiescence,
  readResearchEvidenceArtifact,
  parseHarnessRevisionV1,
  requireStrictIsoTimestamp,
  validateDshFilePolicyAgainstFrozenRuntime,
} from "@ouroboros/harness";
import type {
  AttemptOutput,
  DesignDecision,
  DesignOutcome,
  DesignOutcomeRecommendation,
  DesignOutcomeStage,
  ExecutionThread,
  HarnessDatabase,
  FounderCharter,
  ResearchEvidenceLinkV1,
  RunOverview,
} from "@ouroboros/harness";
import {
  buildTaskPrompt,
  createApplyDesignActionsHook,
  createContextSummaryHook,
  defaultCodexBin,
  createDurableAttemptReplayCache,
  createGitWorktreeHook,
  createGoalReviewDecisionHook,
  createRefreshGuardrailProposalsHook,
  createRepairTaskHook,
  createRunsFromOutputHook,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  chargeRepairBudgetState,
  childEnvForProcess,
  codexOnlyAgentDefaults,
  createAcpxSubsessionRunner,
  createCollectSubsessionsHook,
  createRouteExecutor,
  inspectDshReadiness,
  hostExecutionCapabilityAttemptInput,
  reconcileDeferredDesignAuthority,
  reconcileGoalReviewRepairBudget,
  reconcileTerminalDesignDeliveries,
  resolveExecutionRoute,
  readRepairBudget,
  readHostCapabilityReadback,
  resumeCodexResumableAttempt,
  runCodexAutopilot,
  runCodexResumableLoop,
  runReadyTasks,
  runUntilIdle,
  startCodexResumableAttempt,
  superviseCodexDaemon,
  superviseCodexRuns,
  protectedPromptContractFingerprintForSource,
  terminateProcessTreeSync,
  DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT,
} from "@ouroboros/runner";
import type { CodexSandbox, DshFilePolicy, ResolvedExecutionRoute, StopHook } from "@ouroboros/runner";
import { fail, flag, parseArgs, required } from "./args";
import { loadOuroborosConfig, resolveLinearPolling, type LinearConfig } from "./config";
import { parseArray, parseObject, printJson } from "./json";
import {
  checkLinearAccess,
  createLinearIssue,
  ingestLinearEvent,
  linkLinearIssue,
  updateLinearIssueStatus,
  writeLinearEvidenceComment,
} from "./linear";
import {
  cacheResolvedProjectSelector,
  consumeLinearInbox,
  getLinearIntakeState,
  persistLinearIntakeTerminal,
  peekLinearPollCycle,
  readLinearToken,
  runLinearPollCycle,
  type LinearIntakePollingState,
} from "./linear-intake";
import { serveDashboard, buildDashboardDesignTimeline } from "./dashboard";
import type {
  DashboardDesignStatusSummary,
  DashboardDesignTimelineEntry,
  DashboardLinearIntakeLifecycle,
} from "./dashboard";
import { buildDashboardLinearIntakeLifecycle } from "./dashboard-linear-intake";
import { requestHarnessAction, serveHarnessActions } from "./action-server";
import { formatRunEvidence } from "./run-evidence";
import { formatAttemptExplanation } from "./explain-attempt";
import { formatRunGraph } from "./run-graph";
import { buildRunThreadOverview, formatRunThreads } from "./run-threads";
import {
  buildDesignStatus,
  formatDesignStatus,
  formatListSignals,
  formatShowDesign,
} from "./design-status";
import {
  listEvolutionRecords,
  parseEvolutionReadbackKind,
  showEvolutionRecord,
} from "./evolution-readback";
import { buildAgentMatrix, doctorAgent } from "../../../scripts/acpx-agent-smoke";
import { join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Task } from "@ouroboros/harness";

const HOST_FIXED_NETWORK_COMMANDS = new Set([
  "linear-check",
  "linear-create-issue",
  "linear-update-status",
  "linear-write-evidence-comment",
  "poll-linear-issues",
]);

async function reexecHostFixedNetworkCommandWithoutAmbientProxy(command: string) {
  if (!HOST_FIXED_NETWORK_COMMANDS.has(command) || process.env.ORBS_HOST_FIXED_NETWORK_ENV === "clean") return;
  const proxyKeys = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  ];
  if (!proxyKeys.some((key) => process.env[key] !== undefined)) return;
  const env: Record<string, string | undefined> = { ...process.env, ORBS_HOST_FIXED_NETWORK_ENV: "clean" };
  for (const key of proxyKeys) delete env[key];
  const child = Bun.spawn({
    cmd: [process.execPath, Bun.argv[1]!, ...Bun.argv.slice(2)],
    cwd: process.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

const parsed = parseArgs(Bun.argv.slice(2));
await reexecHostFixedNetworkCommandWithoutAmbientProxy(parsed.command);
const harness = new Harness(parsed.db);
const DEFAULT_MAX_TRIES = 3;
const DEFAULT_SELF_ITERATION_CONCURRENCY = 3;
const AUTO_MAX_RUN_CONCURRENCY = 3;
const AUTO_MAX_TASK_CONCURRENCY = 4;
const DEFAULT_SELF_ITERATION_WORKTREE_ROOT = ".ouroboros/worktrees";
const DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXECUTOR_FAILURE_TERMINAL_REASONS = new Set([
  "command_failed",
  "hard_timeout",
  "idle_timeout",
  "recovery_failed",
  "terminal_no_envelope",
]);
const SELF_ITERATION_GOAL = "Continuously improve Ouroboros from evidence-backed gaps";
const SELF_ITERATION_PLAN_DOC = "docs/self-iteration-plan.md";
const DEFAULT_STOP_HOOKS = "create-runs,create-tasks,create-verifier,create-repair,apply-design-actions,context-summary";
const SELF_ITERATION_MODEL_DEFAULTS = {
  global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
  roles: {
    designer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    planner: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    worker: { model: "gpt-5.6-luna", reasoning_effort: "high" },
    verifier: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    "goal-review": { model: "gpt-5.6-sol", reasoning_effort: "high" },
  },
};
const SELF_ITERATION_GOAL_CONTRACT = {
  desiredState: "Ouroboros can repeatedly assess its current capabilities, derive and complete successive improvement goals, verify and integrate the results, and pause safely when no evidence-backed gap remains.",
  successCriteria: [
    "each assessment derives one evidence-backed child run or records a justified quiescent decision",
    "each child run has a fine-grained task graph and frozen verification criteria",
    "the dashboard shows the active goal, task stream, todos, and runner state for that run",
    "the generated graph points to concrete files and checks",
    "no implementation task starts from an underspecified prompt",
    "the run-loop can drain the generated graph to either done tasks, blocked tasks with repair paths, or a goal-review decision",
  ],
  constraints: [
    "Do not change database schema or dependency sets in this slice",
    "Do not start implementation from a vague task",
    "Prefer small JSON contracts stored in run context or task config",
    "Execution must not quietly weaken the contract",
  ],
  requiredEvidence: [
    "orbs run-overview --run-id <run_id>",
    "orbs list-lessons --run-id <run_id>",
    "task graph with concrete files and checks",
    "verifier decisions based on evidence",
  ],
  budget: {
    maxRounds: 8,
    maxAttemptsPerTask: DEFAULT_MAX_TRIES,
  },
  stopPolicy: {
    completeWhen: [
      "all generated work is drained and goal-review marks the current child run complete",
      "completion criteria are satisfied with cited evidence",
    ],
    blockWhen: [
      "verifier failures cannot be repaired inside the retry budget",
      "the generated graph cannot be drained by run-loop",
    ],
    askHumanWhen: [
      "a proposal incurs one-time or recurring monetary cost",
      "a proposal changes capital policy or creates a purchasing commitment",
      "a proposal creates a recurring infrastructure commitment",
    ],
  },
};
const SELF_ITERATION_PLANNER_DONE_WHEN = [
  "The assessment cites the active charter, current signals, lessons, run evidence, repository state, and due design outcomes",
  "The output derives one evidence-backed design proposal or records a justified quiescent decision",
  "Durable conclusions return only through the fixed designer actions: recordSignal, proposeDesign, decideDesign, recordDesignOutcome, createRunsFromDesign",
  "Planning begins only from an accepted proposal and preserves the frozen evaluation contract, authority context, budget, and integration boundary",
  "No delivery run is created from an unaccepted proposal or without an approved stored decision",
];
const SELF_ITERATION_DESIGN_DOC = "docs/designer-control-plane.md";
const TARGET_SYSTEM_EVOLUTION_DOC = "docs/target-system-evolution.md";
const TARGET_SYSTEM_DESIGN_DONE_WHEN = [
  "The target founder charter, target-scoped strategy signals, and target-scoped evidence have been inspected",
  "The result is either one evidence-backed proposeDesign action or a justified quiescent decision",
  "Any proposal uses the target project id and includes a complete evolutionPack, causalHypothesis, and comparison",
  "No delivery task or run bypasses the authority gate or the fixed createRunsFromDesign action",
];
const SELF_ITERATION_DEFAULT_PROJECT_NAME = "ouroboros";
const SELF_ITERATION_CHARTER_POLICY_VERSION = 2;
const SELF_ITERATION_DEFAULT_CHARTER = {
  managedBy: "ouroboros",
  policyVersion: SELF_ITERATION_CHARTER_POLICY_VERSION,
  mission:
    "Make Ouroboros reliable, autonomous, observable, and useful for real coding work while adding measured commercial discipline without sacrificing safety.",
  targetUsers: [
    "Solo developers running autonomous coding loops on local repositories",
    "Small teams using Ouroboros for evidence-backed product and infrastructure changes",
  ],
  valueMetrics: [
    "time from goal to verified integrated change",
    "unattended completion rate",
    "human intervention and rescue rate",
    "cost per verified change",
  ],
  principles: [
    "Strategy owns product direction; the planner, worker, and verifier loop own delivery",
    "Every durable strategy conclusion returns through validated fixed actions",
    "Quiescence is the correct answer when evidence does not justify new work",
    "Removals and simplifications are first-class outcomes alongside additions",
  ],
  nonGoals: [
    "Incurring one-time or recurring monetary cost without a human spending decision",
    "Scraping competitor data or building a general finance system in this slice",
  ],
  constraints: [
    "Technical, architecture, protocol, product, and repository decisions are delegated to the Designer and deterministic verifier loop",
    "Any monetary spend, capital-policy change, purchasing action, or recurring infrastructure commitment requires a human spending decision",
  ],
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
    humanApprovalPolicy: "cost-only" as const,
    requireHumanFor: ["cost", "capital-policy-amendment", "purchase", "recurring-infrastructure"],
  },
  reviewCadenceDays: 30,
};
const SELF_ITERATION_INTEGRATION_BOUNDARY = {
  targetBranch: "main",
  push: false,
  allowedFiles: [
    "packages/harness/",
    "packages/runner/",
    "packages/cli/",
    "tests/",
    "docs/",
    "AGENTS.md",
    "README.md",
    "ouroboros.example.toml",
  ],
  forbiddenPaths: [
    ".git/orbs/",
    ".ouroboros/",
    "ouroboros.toml",
    ".linear",
  ],
};

if (parsed.command === "help" || flag(parsed, "help") !== undefined) {
  printHelp();
} else {
  rejectAmbientIntegrationOverrides();

  switch (parsed.command) {
  case "init": {
    harness.init();
    printJson({ db: parsed.db, status: "initialized" });
    break;
  }
  case "self-iterate": {
    const codexBin = flag(parsed, "codex-bin") ?? defaultCodexBin();
    const { runId, taskId } = await createSelfIterationBootstrap();
    printJson({
      runId,
      taskId,
      dashboardCommand: cliCommand("dashboard", "--run-id", runId, "--port", "7331"),
      runnerCommand: cliCommand(
        "run-loop",
        "--run-id",
        runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        "$(pwd)",
        "--sandbox",
        "workspace-write",
        "--codex-bin",
        codexBin,
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--tasks",
        "auto",
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
        "--max-rounds",
        "8",
      ),
      daemonCommand: cliCommand(
        "self-improve-daemon",
        "--root-run-id",
        runId,
        "--executor",
        "codex-resumable",
        "--codex-bin",
        codexBin,
        "--parallel",
        "auto",
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
      ),
      launchCommand: cliCommand(
        "self-iterate-launch",
        "--port",
        "7331",
        "--parallel",
        "auto",
        "--codex-bin",
        codexBin,
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
      ),
    });
    break;
  }
  case "design-target-system": {
    const kernelProjectId = required(parsed, "kernel-project-id");
    const targetProjectId = required(parsed, "target-project-id");
    const goal = required(parsed, "goal");
    if (flag(parsed, "context-json") !== undefined) {
      fail("--context-json is not supported by design-target-system");
    }
    const codexBin = flag(parsed, "codex-bin") ?? defaultCodexBin();
    const result = await createTargetSystemDesignBootstrap({ kernelProjectId, targetProjectId, goal });
    printJson({
      ...result,
      runnerCommand: cliCommand(
        "run-loop",
        "--run-id",
        result.runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        result.targetProject.rootPath,
        "--sandbox",
        "read-only",
        "--codex-bin",
        codexBin,
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--tasks",
        "auto",
        "--worktree-root",
        join(result.targetProject.rootPath, DEFAULT_SELF_ITERATION_WORKTREE_ROOT),
        "--start-hook",
        "git-worktree",
        "--max-rounds",
        "8",
        "--max-tries",
        String(DEFAULT_MAX_TRIES),
      ),
    });
    break;
  }
  case "self-iterate-launch": {
    const codexBin = flag(parsed, "codex-bin") ?? defaultCodexBin();
    const { runId, taskId } = await createSelfIterationBootstrap();
    const launchRoot = harness.getRun(runId);
    const launchRuntime = launchRoot?.context.controlPlaneRuntime;
    if (launchRuntime && typeof launchRuntime === "object" && !Array.isArray(launchRuntime)) {
      harness.updateRun({
        runId,
        contextPatch: {
          controlPlaneRuntime: {
            ...(launchRuntime as Record<string, unknown>),
            processIdentity: "supervisor-pending",
            attestedProcessIdentity: "supervisor-pending",
          },
        },
      });
    }
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7331", "--port");
    const selfIterationWorktreeArgs = defaultSelfIterationWorktreeArgs();
    const dashboard = createDashboardRuntime({
      runId,
      port,
      defaultConcurrency: DEFAULT_SELF_ITERATION_CONCURRENCY,
      defaultWorktreeRoot: DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
      defaultStartHook: "git-worktree",
      defaultCodexBin: codexBin,
      supervisorCommandName: "self-improve-daemon",
      defaultRootRunId: runId,
    });
    const supervisor = dashboard.startSupervisor();
    printJson({
      runId,
      taskId,
      dashboardUrl: `http://localhost:${dashboard.server.port}`,
      supervisorPid: supervisor.pid ?? null,
      supervisorStatus: dashboard.supervisorStatus(),
      dashboardCommand: cliCommand("dashboard", "--run-id", runId, "--port", String(port)),
      daemonCommand: cliCommand(
        "self-improve-daemon",
        "--root-run-id",
        runId,
        "--executor",
        "codex-resumable",
        "--cwd",
        "$(pwd)",
        "--sandbox",
        "workspace-write",
        "--codex-bin",
        codexBin,
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--tasks",
        firstFlag(["tasks", "task-concurrency", "concurrency", "limit"]) ?? (parallelModeIsAuto() ? "auto" : String(DEFAULT_SELF_ITERATION_CONCURRENCY)),
        ...selfIterationWorktreeArgs,
        "--max-rounds",
        "8",
      ),
    });
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "create-project": {
    const name = required(parsed, "name");
    const rootPath = required(parsed, "root-path");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const id = harness.createProject({ name, rootPath, context });
    printJson(harness.getProject(id));
    break;
  }
  case "create-run": {
    const goal = required(parsed, "goal");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const config = await loadCliConfig();
    const id = harness.createRun({
      goal,
      context: withConfigDefaults(context, config),
      projectId: flag(parsed, "project-id") ?? null,
      projectRoot: flag(parsed, "project-root") ?? null,
    });
    const run = harness.getRun(id);
    printJson({ id, goal, status: "todo", projectId: run?.projectId ?? null, projectRoot: run?.projectRoot ?? null });
    break;
  }
  case "list-runs": {
    const statuses = (flag(parsed, "status") ?? "")
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean) as Array<"todo" | "running" | "done" | "blocked">;
    printJson(harness.listRuns({
      statuses: statuses.length ? statuses : undefined,
      limit: parsePositiveInteger(flag(parsed, "limit") ?? "100", "--limit"),
    }));
    break;
  }
  case "intake": {
    const document = required(parsed, "document");
    const title = flag(parsed, "title") ?? compactForTitle(document, 80);
    const result = await createIntakeRun({ title, document });
    printJson({
      ...result,
      supervisorCommand: cliCommand(
        "supervise-runs",
        "--executor",
        "codex-resumable",
        "--root-run-id",
        result.runId,
        "--sandbox",
        "workspace-write",
        "--stop-hook",
        DEFAULT_STOP_HOOKS,
        "--parallel",
        "auto",
        "--worktree-root",
        DEFAULT_SELF_ITERATION_WORKTREE_ROOT,
        "--start-hook",
        "git-worktree",
      ),
    });
    break;
  }
  case "create-task": {
    const runId = required(parsed, "run-id");
    const role = required(parsed, "role");
    const goal = required(parsed, "goal");
    const prompt = required(parsed, "prompt");
    const dependsOn = parseArray(flag(parsed, "depends-on-json") ?? "[]");
    const doneWhen = parseArray(flag(parsed, "done-when-json") ?? "[]");
    const config = parseObject(flag(parsed, "config-json") ?? "{}");
    const parentId = flag(parsed, "parent-id") ?? null;
    const id = harness.createTask({
      runId,
      role,
      goal,
      prompt,
      dependsOn,
      doneWhen,
      config,
      parentId,
    });
    printJson({ id, runId, role, goal, status: "todo" });
    break;
  }
  case "next-task": {
    printJson(harness.nextReadyTask(required(parsed, "run-id")));
    break;
  }
  case "link-external": {
    const localType = required(parsed, "local-type");
    const localId = required(parsed, "local-id");
    const provider = required(parsed, "provider");
    const externalType = required(parsed, "external-type");
    const externalId = required(parsed, "external-id");
    const externalUrl = flag(parsed, "external-url") ?? null;
    const id = harness.createExternalRef({
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    printJson({
      id,
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    break;
  }
  case "action": {
    harness.init();
    const action = parseObject(required(parsed, "action-json"));
    const sealedDescriptorFile = flag(parsed, "sealed-descriptor-file");
    let sealedDescriptorJson: string | undefined;
    if (sealedDescriptorFile) {
      const stat = lstatSync(sealedDescriptorFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) {
        throw new Error("--sealed-descriptor-file must be one non-empty regular file of at most 65536 bytes");
      }
      sealedDescriptorJson = readFileSync(sealedDescriptorFile, { encoding: "utf8", flag: "r" });
    }
    const subsessionRunner = flag(parsed, "subsession-runner");
    const runner = subsessionRunner === "acpx"
      ? createAcpxSubsessionRunner()
      : subsessionRunner === "none"
        ? undefined
        : createAcpxSubsessionRunner();
    printJson(applyHarnessAction(harness, action, { subsessionRunner: runner, sealedDescriptorJson }));
    break;
  }
  case "action-events": {
    harness.init();
    printJson(harness.listHarnessActionEvents({
      limit: parsePositiveInteger(flag(parsed, "limit") ?? "50", "--limit"),
    }));
    break;
  }
  case "action-server": {
    harness.init();
    const host = flag(parsed, "host") ?? "127.0.0.1";
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7332", "--port");
    const token = flag(parsed, "token") ?? process.env.ORBS_ACTION_TOKEN ?? null;
    const server = serveHarnessActions({ harness, host, port, token, subsessionRunner: createAcpxSubsessionRunner() });
    printJson({
      status: "running",
      url: `http://${host}:${server.port}`,
      host,
      port: server.port,
      tokenRequired: Boolean(token),
    });
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "action-request": {
    const action = parseObject(required(parsed, "action-json"));
    const result = await requestHarnessAction({
      url: required(parsed, "url"),
      action,
      token: flag(parsed, "token") ?? process.env.ORBS_ACTION_TOKEN ?? null,
    });
    printJson(result);
    break;
  }
  case "overseer-tick": {
    harness.init();
    const result = await runOverseerTick({
      runId: required(parsed, "run-id"),
      eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      interruptAttemptId: flag(parsed, "interrupt-attempt") ?? null,
      reason: flag(parsed, "reason") ?? null,
      followUpJson: flag(parsed, "follow-up-json") ?? null,
    });
    printJson(result);
    break;
  }
  case "doctor-agent": {
    const agentId = required(parsed, "agent");
    if (agentId === "dsh-cli") {
      printJson(await inspectDshReadiness({
        backendId: "dsh-cli",
        command: "dsh",
        cwd: process.cwd(),
        profile: "headless",
      }));
      break;
    }
    const configuredDsh = await configuredDshDoctorBackend(agentId);
    if (configuredDsh) {
      printJson(await inspectDshReadiness({
        backendId: agentId,
        command: configuredDsh.command,
        cwd: process.cwd(),
        env: configuredDsh.env,
        profile: configuredDsh.profile,
      }));
      break;
    }
    printJson(await doctorAgent(parseDoctorAgentId(agentId)));
    break;
  }
  case "linear-check": {
    harness.init();
    const config = await loadCliConfig();
    const linear = config.linear ?? {};
    const result = await checkLinearAccess({
      harness,
      runId: flag(parsed, "run-id") ?? null,
      projectUrl: flag(parsed, "project-url") ?? linear.projectUrl ?? null,
      projectId: flag(parsed, "project-id") ?? linear.projectId ?? null,
      teamKey: flag(parsed, "team-key") ?? linear.teamKey ?? null,
      tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
      tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
      apiUrl: flag(parsed, "api-url") ?? linear.apiUrl ?? null,
    });
    printJson(result);
    break;
  }
  case "linear-create-issue": {
    const config = await loadCliConfig();
    const linear = config.linear ?? {};
    const result = await createLinearIssue({
      harness,
      title: required(parsed, "title"),
      description: flag(parsed, "description") ?? null,
      projectUrl: flag(parsed, "project-url") ?? linear.projectUrl ?? null,
      projectId: flag(parsed, "project-id") ?? linear.projectId ?? null,
      teamKey: flag(parsed, "team-key") ?? linear.teamKey ?? null,
      tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
      tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
      apiUrl: flag(parsed, "api-url") ?? linear.apiUrl ?? null,
    });
    printJson(result);
    break;
  }
  case "linear-update-status": {
    const config = await loadCliConfig();
    const linear = config.linear ?? {};
    const result = await updateLinearIssueStatus({
      issueId: flag(parsed, "issue-id") ?? "",
      stateId: flag(parsed, "state-id") ?? null,
      stateName: flag(parsed, "state-name") ?? null,
      teamKey: flag(parsed, "team-key") ?? linear.teamKey ?? null,
      tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
      tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
      apiUrl: flag(parsed, "api-url") ?? linear.apiUrl ?? null,
    });
    printJson(result);
    if (result.outcome !== "verified") {
      process.exitCode = 1;
    }
    break;
  }
  case "linear-write-evidence-comment": {
    const config = await loadCliConfig();
    const linear = config.linear ?? {};
    const result = await writeLinearEvidenceComment({
      issueId: flag(parsed, "issue-id") ?? "",
      idempotencyKey: flag(parsed, "idempotency-key") ?? "",
      evidenceSummary: flag(parsed, "evidence-summary") ?? "",
      idempotencySecretFile: flag(parsed, "idempotency-secret-file") ?? null,
      tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
      tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
      apiUrl: flag(parsed, "api-url") ?? linear.apiUrl ?? null,
    });
    printJson(result);
    if (result.outcome !== "verified") {
      process.exitCode = 1;
    }
    break;
  }
  case "linear-link-issue": {
    harness.init();
    try {
      const ref = linkLinearIssue({
        harness,
        localType: required(parsed, "local-type"),
        localId: required(parsed, "local-id"),
        issueId: flag(parsed, "issue-id") ?? null,
        issueKey: flag(parsed, "issue-key") ?? null,
        issueUrl: flag(parsed, "issue-url") ?? null,
      });
      printJson(ref);
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "linear-ingest-event": {
    harness.init();
    try {
      const stored = ingestLinearEvent({
        harness,
        eventType: required(parsed, "event-type"),
        externalId: required(parsed, "external-id"),
        payloadJson: required(parsed, "payload-json"),
      });
      printJson(stored);
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "linear-poll-state": {
    harness.init();
    const runId = required(parsed, "run-id");
    if (!harness.getRun(runId)) {
      fail(`run not found: ${runId}`);
    }
    printJson(getLinearIntakeState(harness, runId));
    break;
  }
  case "linear-consume-inbox": {
    harness.init();
    const rootRunId = required(parsed, "root-run-id");
    if (!harness.getRun(rootRunId)) {
      fail(`run not found: ${rootRunId}`);
    }
    const batchSizeFlag = flag(parsed, "batch-size");
    const batchSize = batchSizeFlag ? Number(batchSizeFlag) : undefined;
    printJson(
      consumeLinearInbox({
        harness,
        rootRunId,
        batchSize: Number.isFinite(batchSize) && batchSize !== undefined ? batchSize : undefined,
      }),
    );
    break;
  }
  case "poll-linear-issues": {
    harness.init();
    const runId = required(parsed, "run-id");
    if (!harness.getRun(runId)) {
      fail(`run not found: ${runId}`);
    }
    const config = await loadCliConfig();
    const resolution = resolveLinearPolling(config.linear);
    if (!resolution.enabled || !resolution.config) {
      fail(
        resolution.error
          ? `Linear polling disabled: ${resolution.error}`
          : `Linear polling disabled: ${resolution.reason ?? "missing configuration"}`,
      );
    }
    const linear = config.linear ?? {};
    const apiUrl = flag(parsed, "api-url") ?? linear.apiUrl ?? "https://api.linear.app/graphql";
    const projectId = flag(parsed, "project-id") ?? linear.projectId ?? null;
    const teamKey = flag(parsed, "team-key") ?? linear.teamKey ?? null;
    if (!projectId || !teamKey) {
      fail("Linear polling requires a resolved project id and team key");
    }
    let token: string;
    try {
      token = (
        await readLinearToken({
          tokenEnv: flag(parsed, "token-env") ?? linear.tokenEnv ?? null,
          tokenFile: flag(parsed, "token-file") ?? linear.tokenFile ?? null,
        })
      ).token;
    } catch (error) {
      fail((error as Error).message);
    }
    const cycle = await runLinearPollCycle({
      harness,
      rootRunId: runId,
      token: token!,
      apiUrl,
      projectId,
      teamKey,
      config: resolution.config!,
    });
    printJson(cycle);
    break;
  }
  case "list-lessons": {
    printJson(harness.listLessons({ runId: required(parsed, "run-id") }));
    break;
  }
  case "propose-guardrails": {
    printJson(proposeGuardrailsFromLessons({
      runId: required(parsed, "run-id"),
      minCount: parsePositiveInteger(flag(parsed, "min-count") ?? "2", "--min-count"),
    }));
    break;
  }
  case "accept-guardrail": {
    printJson(acceptGuardrailProposal({
      runId: required(parsed, "run-id"),
      proposalId: required(parsed, "proposal-id"),
      acceptedBy: required(parsed, "accepted-by"),
    }));
    break;
  }
  case "show-prompt-template": {
    const template = harness.getPromptTemplate(required(parsed, "key"));
    if (!template) {
      fail("prompt template not found");
    }
    printJson(template);
    break;
  }
  case "show-task-prompt": {
    console.log(renderTaskPrompt(required(parsed, "task-id")));
    break;
  }
  case "set-prompt-template": {
    const template = harness.setPromptTemplate({
      key: required(parsed, "key"),
      contentMd: required(parsed, "content"),
    });
    printJson(template);
    break;
  }
  case "run-next": {
    const executorName = cliExecutorName();
    const runId = required(parsed, "run-id");
    const limit = parseTaskConcurrency();
    if (usesCodexResumablePath(executorName)) {
      const maxTries = parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries");
      const result = await runCodexResumableLoop({ ...codexRunnerInput(), runId, maxRounds: 1, limit, maxTries });
      printJson({ tasks: result.rounds.flatMap((round) => round.tasks) });
      break;
    }
    const result = await runReadyTasks({
      harness,
      runId,
      limit,
      model: flag(parsed, "model"),
      cliAgentBackend: flag(parsed, "agent-backend"),
      cliExecutor: executorName,
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
      attemptInput: attemptInputFactory(executorName),
      stopHooksByRole: stopHooksByRole(),
    });
    printJson({ tasks: result });
    break;
  }
  case "run-loop": {
    const executorName = cliExecutorName();
    const runId = required(parsed, "run-id");
    const limit = parseTaskConcurrency();
    const maxRounds = parsePositiveInteger(flag(parsed, "max-rounds") ?? "10", "--max-rounds");
    const maxTries = parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries");
    if (usesCodexResumablePath(executorName)) {
      printJson(await runCodexResumableLoop({ ...codexRunnerInput(DEFAULT_STOP_HOOKS), runId, maxRounds, limit, maxTries }));
      break;
    }
    const result = await runUntilIdle({
      harness,
      runId,
      limit,
      maxRounds,
      model: flag(parsed, "model"),
      cliAgentBackend: flag(parsed, "agent-backend"),
      cliExecutor: executorName,
      cwd: runnerCwd(),
      sessionForTask: (task) => task.sessionRef ?? `task-${task.id}`,
      worktreeForTask: worktreeForTask(),
      startHooks: startHooks(),
      executorFactory: executorFactory(executorName),
      attemptInput: attemptInputFactory(executorName),
      stopHooksByRole: stopHooksByRole(DEFAULT_STOP_HOOKS),
    });
    printJson(result);
    break;
  }
  case "autopilot": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("autopilot currently supports codex-resumable");
    }
    printJson(
      await runCodexAutopilot({
        ...codexRunnerInput(),
        runId: required(parsed, "run-id"),
        limit: parseTaskConcurrency(),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      }),
    );
    break;
  }
  case "supervise-runs": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("supervise-runs currently supports codex-resumable");
    }
    printJson(
      await superviseCodexRuns({
        ...codexRunnerInput(),
        rootRunId: flag(parsed, "root-run-id") ?? null,
        runConcurrency: parseRunConcurrency(),
        taskConcurrency: parseTaskConcurrency(),
        maxCycles: parsePositiveInteger(flag(parsed, "max-cycles") ?? "100", "--max-cycles"),
        maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
        maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
        intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
        integrateCompletedRuns: flag(parsed, "integrate-complete-runs") !== undefined,
      }),
    );
    break;
  }
  case "supervise-daemon": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("supervise-daemon currently supports codex-resumable");
    }
    const maxTicks = parseNonNegativeInteger(flag(parsed, "max-ticks") ?? "0", "--max-ticks");
    const result = await superviseCodexDaemon({
      ...codexRunnerInput(),
      rootRunId: flag(parsed, "root-run-id") ?? null,
      runConcurrency: parseRunConcurrency(),
      taskConcurrency: parseTaskConcurrency(),
      tickCycles: parsePositiveInteger(flag(parsed, "tick-cycles") ?? flag(parsed, "max-cycles") ?? "1", "--tick-cycles"),
      maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
      maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
      intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      idleMs: parseNonNegativeInteger(flag(parsed, "idle-ms") ?? flag(parsed, "interval-ms") ?? "1500", "--idle-ms"),
      maxTicks,
      integrateCompletedRuns: flag(parsed, "integrate-complete-runs") !== undefined,
      onTick: maxTicks === 0 ? (tick) => console.log(JSON.stringify(tick)) : undefined,
    });
    printJson(result);
    break;
  }
  case "self-improve-daemon": {
    const executorName = parseExecutorName(required(parsed, "executor"));
    if (executorName !== "codex-resumable") {
      fail("self-improve-daemon currently supports codex-resumable");
    }
    const suppliedRootRunId = flag(parsed, "root-run-id") ?? null;
    const created = suppliedRootRunId ? null : await createSelfIterationBootstrap();
    const rootRunId = suppliedRootRunId ?? created!.runId;
    if (!harness.getRun(rootRunId)) {
      fail(`run not found: ${rootRunId}`);
    }
    const maxTicks = parseNonNegativeInteger(flag(parsed, "max-ticks") ?? "0", "--max-ticks");
    const result = await superviseSelfImprovementDaemon({
      ...codexRunnerInput(DEFAULT_STOP_HOOKS),
      rootRunId,
      runConcurrency: parseRunConcurrency(),
      taskConcurrency: parseTaskConcurrency(),
      tickCycles: parsePositiveInteger(flag(parsed, "tick-cycles") ?? flag(parsed, "max-cycles") ?? "1", "--tick-cycles"),
      maxRounds: parsePositiveInteger(flag(parsed, "max-rounds") ?? "1", "--max-rounds"),
      maxTries: parsePositiveInteger(flag(parsed, "max-tries") ?? String(DEFAULT_MAX_TRIES), "--max-tries"),
      intervalMs: parseNonNegativeInteger(flag(parsed, "interval-ms") ?? "1500", "--interval-ms"),
      idleMs: parseNonNegativeInteger(flag(parsed, "idle-ms") ?? flag(parsed, "interval-ms") ?? "1500", "--idle-ms"),
      maxTicks,
      integrateCompletedRuns: flag(parsed, "no-integrate") === undefined,
      onTick: maxTicks === 0 ? (tick) => console.log(JSON.stringify(tick)) : undefined,
    });
    printJson({
      ...result,
      rootRunId,
      bootstrap: created ? { runId: created.runId, taskId: created.taskId, cycleIndex: 0 } : null,
    });
    break;
  }
  case "record-attempt": {
    const taskId = required(parsed, "task-id");
    const input = parseObject(flag(parsed, "input-json") ?? "{}");
    const output = parseObject(flag(parsed, "output-json") ?? "{}");
    const attemptId = harness.recordAttempt({
      taskId,
      input,
      output: {
        status: output.status as "done" | "blocked",
        runDecision: parseOptionalRunDecision(output.runDecision),
        summary: readableValue(output.summary),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: readableList(output.problems),
      },
    });
    const attempt = harness.getAttempt(attemptId);
    const task = attempt ? harness.getTask(attempt.taskId) : null;
    if (attempt && task) {
      applyCliPostAttemptRunEffects(task.runId, task, attempt.output);
    }
    printJson({
      attemptId,
      taskId,
      status: output.status,
    });
    break;
  }
  case "start-attempt": {
    const taskId = required(parsed, "task-id");
    const input = parseObject(flag(parsed, "input-json") ?? "{}");
    const attemptId = harness.startAttempt({
      taskId,
      input,
    });
    printJson({
      attemptId,
      taskId,
      status: "running",
    });
    break;
  }
  case "finish-attempt": {
    const attemptId = required(parsed, "attempt-id");
    const output = parseObject(flag(parsed, "output-json") ?? "{}");
    harness.finishAttempt({
      attemptId,
      output: {
        status: output.status as "done" | "blocked",
        summary: readableValue(output.summary),
        changedFiles: Array.isArray(output.changedFiles) ? output.changedFiles : [],
        checks: Array.isArray(output.checks) ? output.checks : [],
        artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        problems: readableList(output.problems),
      },
    });
    const attempt = harness.getAttempt(attemptId);
    const task = attempt ? harness.getTask(attempt.taskId) : null;
    if (attempt && task) {
      applyCliPostAttemptRunEffects(task.runId, task, attempt.output);
    }
    printJson({
      attemptId,
      status: output.status,
    });
    break;
  }
  case "list-running-attempts": {
    printJson(harness.listRunningAttempts({ runId: required(parsed, "run-id") }));
    break;
  }
  case "run-overview": {
    const overview = harness.getRunOverview({
      runId: required(parsed, "run-id"),
      eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
    });
    const runtime = overview.run?.context?.controlPlaneRuntime;
    printJson(
      runtime && typeof runtime === "object" && !Array.isArray(runtime)
        ? { ...overview, controlPlaneRuntime: runtime }
        : overview,
    );
    break;
  }
  case "run-watchdog-pass": {
    const nowFlag = flag(parsed, "now");
    const rootRunId = required(parsed, "root-run-id");
    const result = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId,
      daemonIntervalMs: parsePositiveInteger(
        flag(parsed, "daemon-interval-ms") ?? flag(parsed, "interval-ms") ?? "1500",
        "--daemon-interval-ms",
      ),
      inboxEvents: readInboxEventsForWatchdog(),
      scheduledReviews: readScheduledReviewsForWatchdog(rootRunId),
      reason: flag(parsed, "reason") ?? "cli run-watchdog-pass",
      ...(nowFlag ? { now: parsePositiveInteger(nowFlag, "--now") } : {}),
    });
    printJson(result);
    break;
  }
  case "run-evidence": {
    const runId = required(parsed, "run-id");
    const overview = harness.getRunOverview({
      runId,
      eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
    });
    if (!overview.run) {
      fail(`run not found: ${runId}`);
    }
    console.log(
      formatRunEvidence(overview, {
        lessonLimit: parsePositiveInteger(flag(parsed, "limit") ?? "10", "--limit"),
      }),
    );
    break;
  }
  case "explain-attempt": {
    const attemptId = required(parsed, "attempt-id");
    const attempt = harness.getAttempt(attemptId);
    if (!attempt) {
      fail(`attempt not found: ${attemptId}`);
    }
    const task = harness.getTask(attempt.taskId);
    const explicitStdout = flag(parsed, "stdout");
    const events = explicitStdout === undefined ? harness.listAttemptEvents(attemptId) : [];
    console.log(
      formatAttemptExplanation(attempt, {
        stdout: explicitStdout ?? null,
        events,
        role: task?.role ?? null,
        eventLimit: parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit"),
      }),
    );
    break;
  }
  case "run-graph": {
    const runId = required(parsed, "run-id");
    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    if (!overview.run) {
      fail(`run not found: ${runId}`);
    }
    console.log(formatRunGraph(overview));
    break;
  }
  case "run-threads": {
    const runId = required(parsed, "run-id");
    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    if (!overview.run) {
      fail(`run not found: ${runId}`);
    }
    if (flag(parsed, "json") !== undefined) {
      printJson(buildRunThreadOverview(overview));
      break;
    }
    console.log(formatRunThreads(overview));
    break;
  }
  case "dashboard": {
    const runId = required(parsed, "run-id");
    const port = parsePositiveInteger(flag(parsed, "port") ?? "7331", "--port");
    harness.init();
    const dashboard = createDashboardRuntime({ runId, port });
    console.log(`Ouroboros dashboard: http://localhost:${dashboard.server.port}`);
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    break;
  }
  case "codex-start-attempt": {
    const taskId = required(parsed, "task-id");
    printJson(await startCodexResumableAttempt({ ...codexRunnerInput(), taskId }));
    break;
  }
  case "codex-resume-attempt": {
    const attemptId = required(parsed, "attempt-id");
    printJson(await resumeCodexResumableAttempt({ ...codexRunnerInput(), attemptId, prompt: flag(parsed, "prompt") }));
    break;
  }
  case "retry-task": {
    const taskId = required(parsed, "task-id");
    harness.retryTask({ taskId });
    printJson({ taskId, status: "todo" });
    break;
  }
  case "show-evolution-record": {
    requireEvolutionJsonOutput();
    try {
      printJson(showEvolutionRecord({
        harness,
        dbPath: parsed.db,
        kind: parseEvolutionReadbackKind(required(parsed, "kind")),
        projectId: required(parsed, "project-id"),
        id: required(parsed, "id"),
      }));
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "list-evolution-records": {
    requireEvolutionJsonOutput();
    try {
      printJson(listEvolutionRecords({
        harness,
        dbPath: parsed.db,
        kind: parseEvolutionReadbackKind(required(parsed, "kind")),
        projectId: required(parsed, "project-id"),
        profileId: flag(parsed, "profile-id"),
      }));
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "design-status": {
    const projectId = resolveDesignProjectId(parsed);
    const asJson = flag(parsed, "json") !== undefined;
    const summary = buildDesignStatus({
      projectId,
      loadCharter: () => (projectId ? harness.getActiveFounderCharter({ projectId }) : null),
      loadCurrentProposal: () => loadCurrentDesignProposal(projectId),
      loadLatestDecision: (proposalId) =>
        harness.listDesignDecisions({ proposalId, limit: 50 }).at(-1) ?? null,
      loadOutcomes: (proposalId) =>
        harness.listDesignOutcomes({ proposalId, limit: 50 }).slice().reverse(),
      countActiveSignals: () =>
        harness.listStrategySignals({ projectId, statuses: ["active"], limit: 1000 }).length,
      loadProposalCounts: () => tallyDesignProposalStatuses(projectId),
    });
    if (asJson) {
      printJson(designStatusJson(summary, projectId));
      break;
    }
    console.log(formatDesignStatus(summary));
    break;
  }
  case "list-signals": {
    const projectId = resolveDesignProjectId(parsed);
    const signalClassRaw = flag(parsed, "class");
    const signalClass = signalClassRaw
      ? parseStrategySignalClass(signalClassRaw)
      : undefined;
    const statusesRaw = flag(parsed, "statuses") ?? "active";
    const statuses = statusesRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) as Array<"active" | "expired" | "superseded">;
    const limit = parsePositiveInteger(flag(parsed, "limit") ?? "25", "--limit");
    const signals = harness.listStrategySignals({
      projectId,
      signalClass,
      statuses: statuses.length > 0 ? statuses : undefined,
      limit,
    });
    const totalCount = harness.listStrategySignals({
      projectId,
      signalClass,
      statuses: statuses.length > 0 ? statuses : undefined,
      limit: 100000,
    }).length;
    if (flag(parsed, "json") !== undefined) {
      printJson({
        projectId,
        signalClass: signalClass ?? null,
        statuses: statuses.length > 0 ? statuses : null,
        totalCount,
        signals,
      });
      break;
    }
    console.log(formatListSignals({ signals, totalCount }));
    break;
  }
  case "list-research-evidence": {
    const projectId = required(parsed, "project-id");
    const links = listResearchEvidenceLinks(harness, {
      projectId,
      includeExpired: flag(parsed, "include-expired") === "true",
      limit: parsePositiveInteger(flag(parsed, "limit") ?? "100", "--limit"),
    });
    printJson({ projectId, totalCount: links.length, links });
    break;
  }
  case "show-research-evidence": {
    const projectId = required(parsed, "project-id");
    try {
      printJson(readResearchEvidenceArtifact(harness, {
        projectId,
        signalId: required(parsed, "signal-id"),
        artifactId: required(parsed, "artifact-id"),
      }));
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }
  case "show-design": {
    const proposalId = required(parsed, "proposal-id");
    const proposal = harness.getDesignProposal({ id: proposalId });
    if (!proposal) {
      fail(`design proposal not found: ${proposalId}`);
    }
    const decisions = harness.listDesignDecisions({ proposalId, limit: 100 });
    const outcomes = harness.listDesignOutcomes({ proposalId, limit: 100 }).slice().reverse();
    if (flag(parsed, "json") !== undefined) {
      printJson({ proposal, decisions, outcomes });
      break;
    }
    console.log(formatShowDesign({ proposal, decisions, outcomes }));
    break;
  }
  case "list-design-outcomes": {
    const projectIdRaw = flag(parsed, "project-id") ?? flag(parsed, "project-root");
    const projectId = projectIdRaw ? resolveDesignProjectId(parsed) : resolveImplicitDesignProjectId();
    const proposalId = flag(parsed, "proposal-id");
    const stageRaw = flag(parsed, "stage");
    const stage = stageRaw ? parseDesignOutcomeStage(stageRaw) : undefined;
    const statusRaw = flag(parsed, "status");
    const dueBeforeRaw = flag(parsed, "due-before");
    const asJson = flag(parsed, "json") !== undefined;
    if (statusRaw !== undefined && statusRaw !== "due") {
      fail("--status must be 'due' when set");
    }
    if (statusRaw === "due" && stageRaw !== undefined) {
      fail("--status due cannot be combined with --stage; due outcomes are review-stage records");
    }
    const evaluatedAt = resolveDesignOutcomeEvaluatedAt(dueBeforeRaw, statusRaw);
    const limit = parsePositiveInteger(flag(parsed, "limit") ?? "100", "--limit");
    const outcomes = harness.listDesignOutcomes({
      projectId: projectId ?? undefined,
      proposalId,
      stage,
      dueBefore: evaluatedAt ?? undefined,
      limit,
    });
    const rows = outcomes.map((outcome) => ({
      id: outcome.id,
      proposalId: outcome.proposalId,
      stage: outcome.stage,
      recommendation: outcome.recommendation,
      reviewAt: outcome.reviewAt,
      due: outcome.reviewAt !== null && evaluatedAt !== null && outcome.reviewAt <= evaluatedAt,
      createdAt: outcome.createdAt,
    }));
    if (asJson) {
      printJson({
        projectId: projectId ?? null,
        proposalId: proposalId ?? null,
        stage: stage ?? null,
        status: statusRaw ?? null,
        evaluatedAt: evaluatedAt ?? null,
        totalCount: rows.length,
        outcomes: rows,
      });
      break;
    }
    console.log(formatListDesignOutcomes({ rows, evaluatedAt: evaluatedAt ?? null }));
    break;
  }
  default:
    fail(`unknown command: ${parsed.command}`);
  }
}

function printHelp() {
  console.log([
    "orbs - local control loop for long-running coding-agent work",
    "",
    "Usage:",
    "  orbs [--db <path>] <command> [options]",
    "  orbs --help",
    "  Default DB: .git/orbs/ouroboros.db inside Git repositories, otherwise .ouroboros/ouroboros.db",
    "",
    "Core commands:",
    "  init                 Initialize the local SQLite database",
    "  create-project       Register a project root",
    "  create-run           Create a goal run",
    "  design-target-system Create a target-bound Designer root run from a separate kernel project",
    "  create-task          Create a task in a run",
    "  run-loop             Drain ready tasks for one run",
    "  supervise-runs       Drain multiple runnable runs",
    "  supervise-daemon     Keep supervising runs until stopped",
    "  self-iterate         Create an autonomous self-assessment root run",
    "  self-iterate-launch  Start the self-improvement dashboard and daemon",
    "  self-improve-daemon  Continuously derive and supervise improvement cycles",
    "  dashboard            Start the dashboard",
    "  intake               Split a requirement document into child runs",
    "  action               Apply a fixed harness action such as integrateVerifiedRun or pushExactGitRef",
    "  poll-linear-issues   Run one bounded Linear polling cycle for a supervised run",
    "  linear-create-issue  Create a scoped Linear issue through the configured API token",
    "  linear-update-status Update one issue via --state-id or team-scoped --state-name and verify via independent readback",
    "  linear-write-evidence-comment Create or sequentially reuse one bounded evidence comment and verify readback (requires --idempotency-secret-file)",
    "  linear-poll-state    Print the durable Linear polling state for a supervised run",
    "  linear-consume-inbox Claim durable Linear issue events into issue-scoped Designer runs",
    "",
    "Inspection:",
    "  list-runs            List recent runs",
    "  run-overview         Print run state as JSON",
    "  run-watchdog-pass    Run one durable control-plane watchdog pass for a root run",
    "  run-evidence         Print readable run evidence",
    "  run-graph            Print a compact task graph",
    "  run-threads          Print harness-managed subsession threads grouped by parent task",
    "  show-task-prompt     Render a task prompt",
    "  explain-attempt      Explain an attempt from captured events",
    "  design-status        Print active charter, current proposal, and outcome review state",
    "  list-signals         List strategy signals filtered by class and status",
    "  list-research-evidence List project-owned immutable research artifact references",
    "  show-research-evidence Read one linked original research artifact with hash verification",
    "  show-design          Print a design proposal with decisions and outcomes",
    "  list-design-outcomes List design outcomes filtered by proposal, stage, or due status",
    "  show-evolution-record Read one project-scoped evolution record and its successful action audit",
    "  list-evolution-records List project-scoped evolution records with recomputed content hashes",
    "",
    "Examples:",
    "  orbs init",
    "  orbs create-run --goal 'Refactor platform admin' --project-root $(pwd)",
    "  orbs design-target-system --kernel-project-id <kernel_project_id> --target-project-id <target_project_id> --goal 'Design bounded target evolution'",
    "  orbs run-loop --run-id <run_id> --executor codex-resumable --cwd $(pwd)",
    "  orbs supervise-daemon --executor codex-resumable --parallel auto",
    "  orbs self-iterate-launch --parallel auto",
    "  orbs supervise-daemon --executor codex-resumable --runs 2 --tasks 3",
    "  orbs dashboard --run-id <run_id> --port 7331",
    "  orbs run-threads --run-id <run_id>",
    "  orbs run-threads --run-id <run_id> --json true",
    "  orbs action --action-json '{\"type\":\"collectSubsessions\",\"parentTaskId\":\"task_...\"}'",
    "  orbs action --action-json '{\"type\":\"cancelSubsessions\",\"parentTaskId\":\"task_...\",\"reason\":\"manual stop\"}'",
    "",
    "Parallelism:",
    "  --parallel auto       Pick conservative run/task slots from local CPU and memory size",
    "  --runs <n|auto>       Runnable runs to supervise together; alias for --run-concurrency",
    "  --tasks <n|auto>      Ready tasks per run; alias for --concurrency",
  ].join("\n"));
}

function parseApproval(raw: string) {
  if (raw !== "approve-all" && raw !== "approve-reads" && raw !== "deny-all") {
    fail("--approval must be approve-all, approve-reads, or deny-all");
  }
  return raw;
}

function requireEvolutionJsonOutput() {
  if (flag(parsed, "json") === undefined) {
    fail("--json is required for evolution record inspection");
  }
}

function parseSandbox(raw: string): CodexSandbox {
  if (raw !== "read-only" && raw !== "workspace-write" && raw !== "danger-full-access") {
    fail("--sandbox must be read-only, workspace-write, or danger-full-access");
  }
  return raw;
}

type CliExecutorName = "noop" | "acpx-codex" | "codex-cli" | "codex-resumable" | "dsh-cli";

function parseExecutorName(raw: string): CliExecutorName {
  if (raw !== "noop" && raw !== "acpx-codex" && raw !== "codex-cli" && raw !== "codex-resumable" && raw !== "dsh-cli") {
    fail(`unsupported executor: ${raw}`);
  }
  return raw;
}

function parseOptionalRunDecision(raw: unknown): AttemptOutput["runDecision"] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (raw === "done") {
    return "complete";
  }
  if (raw !== "complete" && raw !== "continue" && raw !== "verify" && raw !== "defer") {
    fail("attempt output runDecision must be complete, continue, verify, or defer");
  }
  return raw;
}

function parseDoctorAgentId(raw: string) {
  const agent = buildAgentMatrix().find((candidate) => candidate.id === raw);
  if (!agent) {
    fail(`unsupported doctor agent: ${raw}`);
  }
  return agent.id;
}

async function configuredDshDoctorBackend(agentId: string) {
  if (!flag(parsed, "config")) {
    return null;
  }
  if (buildAgentMatrix().some((agent) => agent.id === agentId)) {
    return null;
  }
  const config = await loadOuroborosConfig(flag(parsed, "config")!);
  const backend = config.agentBackends?.[agentId];
  if (!backend) {
    return null;
  }
  if (backend.kind !== "dsh-cli") {
    fail(`doctor-agent configured backend ${agentId} must have kind dsh-cli`);
  }
  const profile = backend.profile ?? "headless";
  if (profile !== "headless") {
    fail(`doctor-agent DSH backend ${agentId} must use the headless profile`);
  }
  return {
    command: backend.command ?? "dsh",
    profile: profile as "headless",
    env: backend.env,
  };
}

function cliExecutorName() {
  const executor = flag(parsed, "executor");
  if (executor) {
    return parseExecutorName(executor);
  }
  if (flag(parsed, "agent-backend")) {
    return "codex-cli" as const;
  }
  return parseExecutorName(required(parsed, "executor"));
}

function usesCodexResumablePath(executorName: CliExecutorName) {
  return executorName === "codex-resumable" || flag(parsed, "agent-backend") === "codex-resumable";
}

function selfIterationDesignerPrompt() {
  return [
    "Act as Ouroboros' Designer. Decide whether to record strategy signals, propose a design, defer an existing proposal, or stay quiescent for this cycle. Do not invent a new product direction from prompt prose: every durable conclusion must return through one of the five fixed designer actions.",
    "",
    "Inspect these inputs before deciding:",
    "",
    `- the active founder charter referenced by \`founderCharterId\` in this run context (see \`${SELF_ITERATION_DESIGN_DOC}\` for the contract)`,
    "- current strategy signals (`orbs list-signals`) and any conflicting or expired entries that need follow-up",
    "- recent run evidence, attempts, verifier decisions, lessons, and integration outcomes in the local harness database",
    "- repository state and recent commits (`README.md`, `docs/protocol.md`, `docs/control-loop-contracts.md`, `packages/runner/src/runner.ts`, `packages/cli/src/main.ts`)",
    "- due design outcomes (`orbs list-design-outcomes --status due`) that may reopen accepted decisions",
    `- the autonomous self-assessment contract in \`${SELF_ITERATION_PLAN_DOC}\``,
    "",
    "Use the harness-managed research subsessions when current evidence is missing. Durable conclusions still return through the fixed actions; do not mutate strategy records directly through prose.",
    "",
    "Return one of the following outcomes through the `actions` array:",
    "",
    "- `recordSignal` to capture a sourced, time-bound observation from user, delivery, technology, market, economics, or system evidence",
    "- `proposeDesign` to record a proposal with frozen evaluation contract, evidence references, options, recommendation, additions, removals, and an investment envelope; the deterministic authority gate decides technical risk autonomously and reserves human checkpoints for monetary spend, capital-policy changes, purchasing, and recurring infrastructure commitments",
    "- `decideDesign` only with `auto` actor kind for `rejected`, `deferred`, `retired`, or `revise`; approvals are recorded by the authority evaluator or human CLI path, never from this output",
    "- `recordDesignOutcome` for `experiment`, `release`, or `review` stages with baseline, observed metrics, evidence, and unexpected effects",
    "- `createRunsFromDesign` only when the named proposal is `accepted` and a stored approved decision exists; each planned run inherits the frozen evaluation contract, charter, proposal, decision, budget, and integration boundary",
    "",
    "Planning begins only from an accepted proposal. Never create a delivery run for an unaccepted proposal, and never bypass the authority gate by adding `nextRuns` for a design conclusion.",
    "",
    "Record a justified quiescent decision (no actions, summary explains the absence of evidence-backed work) when the current signals, run evidence, repository state, and due outcomes do not justify a new proposal or a delivery run. The controller will wait for repository state to change.",
  ].join("\n");
}

function targetSystemDesignerPrompt(input: {
  kernelProject: NonNullable<ReturnType<Harness["getProject"]>>;
  targetProject: NonNullable<ReturnType<Harness["getProject"]>>;
  charterId: string;
  researchEvidenceLinks: ResearchEvidenceLinkV1[];
  evidenceBundle: TargetSystemEvidenceBundleV1;
}) {
  const hasUnrealizableFrozenCorpus = input.evidenceBundle.blockedSignals.some(
    (signal) => signal.payload.defectKind === "frozen-corpus-unrealizable",
  );
  const hostCorpusReceipt = input.evidenceBundle.hostCorpusReceipts[0];
  const researchEvidence = input.researchEvidenceLinks.length === 0
    ? ["- no project-owned research evidence links are currently registered"]
    : input.researchEvidenceLinks.flatMap((link) => [
        `- signal ${link.signalId}; source run ${link.sourceRunId}; attempt ${link.sourceAttemptId}; expires ${link.expiresAt}`,
        ...link.artifacts.map((artifact) =>
          `  - artifact ${artifact.artifactId}; sha256 ${artifact.sha256}; grade ${artifact.evidenceGrade}`),
      ]);
  return [
    `Act as the Ouroboros Evolution Kernel Designer for target project ${input.targetProject.name} (${input.targetProject.id}).`,
    `The kernel project is ${input.kernelProject.name} (${input.kernelProject.id}); it supplies the reusable control lifecycle but does not own the target's domain decisions.`,
    "",
    "Before deciding, inspect only target-owned design inputs:",
    `- the active target charter ${input.charterId}`,
    `- target-scoped strategy signals for project ${input.targetProject.id}`,
    "- target-scoped evidence, lessons, repository state, and due outcomes",
    `- the target-system contract in ${TARGET_SYSTEM_EVOLUTION_DOC}`,
    "",
    "Durable target-owned research evidence is frozen below as references only:",
    ...researchEvidence,
    "",
    "The following host-built evidence bundle is authoritative for this design. Its bundleSha256 binds the complete JSON object except bundleSha256:",
    JSON.stringify(input.evidenceBundle, null, 2),
    "Do not read any control database discovered inside the target worktree. In particular, do not inspect .orbs/harness.db, .git/orbs, or another locally discovered database.",
    `Refresh the project index only with: ${authoritativeEvidenceCommand(input.evidenceBundle, "list-research-evidence", "--project-id", input.targetProject.id)}`,
    `Read any original artifact only with: ${authoritativeEvidenceCommand(input.evidenceBundle, "show-research-evidence", "--project-id", input.targetProject.id, "--signal-id", "<signal_id>", "--artifact-id", "<artifact_id>")}`,
    "Read the original evaluation-contract artifact before constructing comparison. If it lacks a precise corpus snapshot and hash, propose the smallest zero-cost evidence-building step; do not claim the research is absent.",
    ...(hasUnrealizableFrozenCorpus ? [
      "The accepted version 4 comparison named by the frozen-corpus-unrealizable signal is immutable failed evidence and must remain unchanged. Do not copy or amend it for a successor proposal.",
      ...(hostCorpusReceipt ? [
        `The host has produced action ${hostCorpusReceipt.actionId}, a sanitized version ${hostCorpusReceipt.targetVersion} corpus-manifest receipt. A full successor proposal must set evolutionPack.version=${hostCorpusReceipt.targetVersion}, cite the corrected evidence-defect signal and this action, and copy receipt.comparison exactly. Do not read or hash fixture bytes yourself.`,
      ] : [
        "No host corpus-manifest receipt is available. The only allowed proposal is a zero-cost host-receipt construction proposal for version 5 so the host can build a canonical manifest from verifiable real fixture bytes; set investment.classification=evidence-maintenance, omit evolutionPack, causalHypothesis, and evaluationContract.comparison. Do not read fixture bytes or self-report a corpus hash.",
      ]),
      "Keep the holdout inside the host private descriptor channel. Ordinary Designer, Planner, Worker, and Verifier roles may receive count and commitment only, with no holdout reference, path, or content.",
      "Do not submit or commit the existing staged exact-seven tree. This Designer may propose one zero-cost evidence-contract correction or stay quiescent; it must not create a Repair, Worker, Verifier, or delivery run.",
    ] : [
      "When acceptedProposals is non-empty, copy its comparison exactly. Never substitute an output hash, placeholder hash, example reference, or newly invented metric.",
    ]),
    "When exactFileBoundary is present, preserve exactPaths byte-for-byte as the only candidate file list. The host must remove every unexpectedPaths entry before delivery; do not replace the list with newly invented paths.",
    "When an evolutionPack cites a frozen research evidence strategy signal, encode its observation.signalSources kind as external-ref. research-evidence is not a valid enum value.",
    "",
    "Return either a justified quiescent result with no actions, or one fixed proposeDesign action.",
    `For proposeDesign, payload.projectId must equal ${input.targetProject.id}. ${hasUnrealizableFrozenCorpus && !hostCorpusReceipt ? "A host-receipt construction proposal must omit the target-evolution group until the host receipt exists." : "The proposal must include the complete target-evolution group: evolutionPack, causalHypothesis, and evaluationContract.comparison."}`,
    ...(!hasUnrealizableFrozenCorpus || hostCorpusReceipt ? [
      "The evolutionPack must keep knowledge, mutation surfaces, evidence, and evaluation scoped to the target project and must name maintenance cost and removals.",
    ] : []),
    "Do not create delivery tasks or runs from this design step. Do not use createTasks, createRuns, or generic nextRuns to bypass authority.",
    "Only an accepted stored proposal with an approved authority decision may later create delivery runs through the fixed createRunsFromDesign action.",
  ].join("\n");
}

interface TargetSystemEvidenceBundleV1 {
  schemaVersion: 1;
  targetProjectId: string;
  authoritativeDatabase: {
    path: string;
    bindingSha256: string;
  };
  referencedSignals: Array<{
    id: string;
    projectId: string | null;
    status: string;
    source: string;
    summary: string;
    evidence: unknown[];
    payloadSha256: string;
  }>;
  blockedSignals: Array<{
    id: string;
    projectId: string | null;
    status: string;
    source: string;
    summary: string;
    evidence: unknown[];
    payload: Record<string, unknown>;
    payloadSha256: string;
  }>;
  acceptedProposals: Array<{
    id: string;
    projectId: string | null;
    status: string;
    approvedDecisionIds: string[];
    comparison: unknown;
    comparisonSha256: string;
  }>;
  hostCorpusReceipts: Array<{
    actionId: string;
    projectId: string;
    sourceRunId: string;
    sourceVersion: number;
    targetVersion: number;
    sourceComparisonSha256: string;
    manifestSha256: string;
    comparison: unknown;
    comparisonSha256: string;
    noHoldoutDisclosure: true;
  }>;
  exactFileBoundary?: {
    sourceRunId: string;
    sourceWorkerTaskId: string;
    sourceWorkerAttemptId: string;
    expectedFileCount: number;
    exactPaths: string[];
    unexpectedRepairAttemptId: string | null;
    unexpectedPaths: string[];
    policy: {
      removeUnexpectedPathsBeforeDelivery: true;
      requireWorkerPerFileSha256: true;
      oldRunMustRemainBlocked: true;
    };
  };
  bundleSha256: string;
}

function authoritativeEvidenceCommand(
  bundle: TargetSystemEvidenceBundleV1,
  command: string,
  ...args: string[]
) {
  return ["orbs", "--db", bundle.authoritativeDatabase.path, command, ...args].map(shellQuote).join(" ");
}

function referencedIds(text: string, prefix: "signal" | "design" | "action") {
  return [...new Set(text.match(new RegExp(`\\b${prefix}_[A-Za-z0-9_]+\\b`, "g")) ?? [])];
}

function evidenceAttemptIds(evidence: unknown[]) {
  return evidence.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const match = /^attempt:(attempt_[A-Za-z0-9_]+)$/.exec(entry);
    return match ? [match[1]!] : [];
  });
}

function buildTargetSystemEvidenceBundle(input: {
  targetProjectId: string;
  charterId: string;
  goal: string;
}): TargetSystemEvidenceBundleV1 {
  const authoritativePath = resolve(parsed.db);
  const rawReferencedSignals = referencedIds(input.goal, "signal").map((id) => {
    const signal = harness.getStrategySignal({ id });
    if (!signal) fail(`referenced strategy signal not found in authoritative database: ${id}`);
    if (signal.projectId !== input.targetProjectId) {
      fail(`referenced strategy signal belongs to another project: ${id}`);
    }
    return signal;
  });
  const referencedSignals = rawReferencedSignals.map((signal) => ({
      id: signal.id,
      projectId: signal.projectId,
      status: signal.status,
      source: signal.source,
      summary: signal.summary,
      evidence: signal.evidence,
      payloadSha256: canonicalEvolutionValueSha256(signal.payload),
    }));
  const blockedSignals = rawReferencedSignals
    .filter((signal) => signal.source.startsWith("blocked-run-outcome:")
      || signal.payload.outcome === "blocked-evidence-conflict")
    .map((signal) => ({
      id: signal.id,
      projectId: signal.projectId,
      status: signal.status,
      source: signal.source,
      summary: signal.summary,
      evidence: signal.evidence,
      payload: signal.payload,
      payloadSha256: canonicalEvolutionValueSha256(signal.payload),
    }));
  const acceptedProposals = referencedIds(input.goal, "design").map((id) => {
    const proposal = harness.getDesignProposal({ id });
    if (!proposal) fail(`referenced design proposal not found in authoritative database: ${id}`);
    if (proposal.projectId !== input.targetProjectId) {
      fail(`referenced design proposal belongs to another project: ${id}`);
    }
    if (proposal.status !== "accepted") {
      fail(`referenced design proposal is not accepted: ${id}`);
    }
    const approvedDecisionIds = harness.listDesignDecisions({ proposalId: id })
      .filter((decision) => decision.decision === "approved")
      .map((decision) => decision.id);
    if (approvedDecisionIds.length === 0) {
      fail(`referenced accepted design proposal has no approved decision: ${id}`);
    }
    const comparison = proposal.proposal.evaluationContract.comparison;
    if (!comparison) fail(`referenced accepted design proposal has no comparison: ${id}`);
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      status: proposal.status,
      approvedDecisionIds,
      comparison,
      comparisonSha256: canonicalEvolutionValueSha256(comparison),
    };
  });
  const hostCorpusReceipts = referencedIds(input.goal, "action").flatMap((actionId) => {
    const event = harness.getHarnessActionEvent({ id: actionId });
    if (!event || event.actionType !== "buildVersionedCorpusManifest" || event.status !== "done") return [];
    const result = recordValue(event.result);
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const artifact = artifacts.find((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).kind === "versioned_corpus_manifest_receipt");
    if (!artifact) fail(`versioned corpus manifest action has no receipt artifact: ${actionId}`);
    const receipt = artifact as Record<string, unknown>;
    if (receipt.projectId !== input.targetProjectId || receipt.noHoldoutDisclosure !== true) {
      fail(`versioned corpus manifest receipt is outside the target project or discloses holdout data: ${actionId}`);
    }
    if (typeof receipt.comparisonSha256 !== "string"
      || canonicalEvolutionValueSha256(receipt.comparison) !== receipt.comparisonSha256) {
      fail(`versioned corpus manifest receipt comparison hash mismatch: ${actionId}`);
    }
    return [{
      actionId,
      projectId: String(receipt.projectId),
      sourceRunId: String(receipt.sourceRunId),
      sourceVersion: Number(receipt.sourceVersion),
      targetVersion: Number(receipt.targetVersion),
      sourceComparisonSha256: String(receipt.sourceComparisonSha256),
      manifestSha256: String(receipt.manifestSha256),
      comparison: receipt.comparison,
      comparisonSha256: receipt.comparisonSha256,
      noHoldoutDisclosure: true as const,
    }];
  });
  for (const receipt of hostCorpusReceipts) {
    if (!acceptedProposals.some((proposal) => proposal.comparisonSha256 === receipt.sourceComparisonSha256)) {
      fail(`versioned corpus manifest receipt is not bound to a referenced accepted proposal: ${receipt.actionId}`);
    }
  }
  const exactFileBoundary = deriveExactTargetFileBoundary(blockedSignals);
  const authoritativeDatabase = {
    path: authoritativePath,
    bindingSha256: canonicalEvolutionValueSha256({
      path: authoritativePath,
      targetProjectId: input.targetProjectId,
      charterId: input.charterId,
    }),
  };
  const body = {
    schemaVersion: 1 as const,
    targetProjectId: input.targetProjectId,
    authoritativeDatabase,
    referencedSignals,
    blockedSignals,
    acceptedProposals,
    hostCorpusReceipts,
    ...(exactFileBoundary ? { exactFileBoundary } : {}),
  };
  return {
    ...body,
    bundleSha256: canonicalEvolutionValueSha256(body),
  };
}

function deriveExactTargetFileBoundary(
  blockedSignals: TargetSystemEvidenceBundleV1["blockedSignals"],
): TargetSystemEvidenceBundleV1["exactFileBoundary"] | undefined {
  for (const signal of blockedSignals) {
    const evidenceBoundary = recordValue(signal.payload.evidenceBoundary);
    const expectedFileCount = evidenceBoundary.expectedFileCount;
    if (!Number.isInteger(expectedFileCount) || Number(expectedFileCount) <= 0) continue;
    const attempts = evidenceAttemptIds(signal.evidence)
      .map((attemptId) => harness.getAttempt(attemptId))
      .filter((attempt): attempt is NonNullable<ReturnType<Harness["getAttempt"]>> => attempt !== null)
      .map((attempt) => ({ attempt, task: harness.getTask(attempt.taskId) }))
      .filter((entry) => entry.task?.role === "worker" && entry.attempt.status === "done");
    const source = attempts.find((entry) => {
      const paths = entry.attempt.output.changedFiles ?? [];
      return paths.length === Number(expectedFileCount) && new Set(paths).size === paths.length;
    });
    if (!source || !source.task) {
      fail(`blocked signal ${signal.id} has no done Worker attempt with exactly ${expectedFileCount} changed files`);
    }
    const exactPaths = [...(source.attempt.output.changedFiles ?? [])];
    const exactSet = new Set(exactPaths);
    const repair = attempts.find((entry) => {
      if (entry.attempt.id === source.attempt.id) return false;
      const paths = entry.attempt.output.changedFiles ?? [];
      return paths.length > exactPaths.length && exactPaths.every((path) => paths.includes(path));
    });
    const unexpectedPaths = repair
      ? (repair.attempt.output.changedFiles ?? []).filter((path) => !exactSet.has(path))
      : [];
    const sourceRun = harness.getRun(source.task.runId);
    if (!sourceRun || sourceRun.projectId !== signal.projectId) {
      fail(`blocked signal ${signal.id} Worker evidence is not owned by the target project`);
    }
    return {
      sourceRunId: source.task.runId,
      sourceWorkerTaskId: source.task.id,
      sourceWorkerAttemptId: source.attempt.id,
      expectedFileCount: Number(expectedFileCount),
      exactPaths,
      unexpectedRepairAttemptId: repair?.attempt.id ?? null,
      unexpectedPaths,
      policy: {
        removeUnexpectedPathsBeforeDelivery: true,
        requireWorkerPerFileSha256: true,
        oldRunMustRemainBlocked: true,
      },
    };
  }
  return undefined;
}

function cliCommand(command: string, ...args: string[]) {
  return ["orbs", "--db", parsed.db, command, ...args].map(shellQuote).join(" ");
}

async function loadCliConfig() {
  if (flag(parsed, "config")) {
    return loadOuroborosConfig(flag(parsed, "config")!);
  }
  const primary = await loadOuroborosConfig("ouroboros.toml");
  if (hasConfigContent(primary)) {
    return primary;
  }
  return loadOuroborosConfig("config.toml");
}

function withConfigDefaults(context: Record<string, unknown>, config: Awaited<ReturnType<typeof loadOuroborosConfig>>) {
  return {
    ...context,
    ...(config.modelDefaults && context.modelDefaults === undefined ? { modelDefaults: config.modelDefaults } : {}),
    ...(config.agentDefaults && context.agentDefaults === undefined ? { agentDefaults: config.agentDefaults } : {}),
    ...(config.agentBackends && context.agentBackends === undefined ? { agentBackends: config.agentBackends } : {}),
  };
}

function withSelfIterationConfigDefaults(
  context: Record<string, unknown>,
  config: Awaited<ReturnType<typeof loadOuroborosConfig>>,
) {
  const merged = withConfigDefaults(context, config);
  const configModelDefaults = recordValue(config.modelDefaults);
  const configModelRoles = recordValue(configModelDefaults.roles);
  const mergedModelDefaults = recordValue(merged.modelDefaults);
  const mergedModelRoles = recordValue(mergedModelDefaults.roles);
  // A fresh self-iteration root must hand its descendants a concrete
  // integration boundary. Caller-supplied context wins, then config, then the
  // built-in default — never undefined, so design-spawned planner runs always
  // inherit a non-null boundary.
  const contextBoundary = context.integrationBoundary;
  const configBoundary = config.integrationBoundary;
  const integrationBoundary =
    contextBoundary ?? configBoundary ?? SELF_ITERATION_INTEGRATION_BOUNDARY;
  return {
    ...merged,
    integrationBoundary,
    modelDefaults: {
      ...SELF_ITERATION_MODEL_DEFAULTS,
      ...configModelDefaults,
      ...mergedModelDefaults,
      roles: {
        ...SELF_ITERATION_MODEL_DEFAULTS.roles,
        ...configModelRoles,
        ...mergedModelRoles,
      },
    },
    agentDefaults: codexOnlyAgentDefaults(merged.agentDefaults, merged.agentBackends),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasConfigContent(config: Awaited<ReturnType<typeof loadOuroborosConfig>>) {
  return Boolean(
    config.linear ||
      config.modelDefaults ||
      config.agentDefaults ||
      config.agentBackends ||
      config.integrationBoundary,
  );
}

function compactForTitle(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text || "Requirement document";
  }
  return `${text.slice(0, max - 1)}…`;
}

function defaultSelfIterationWorktreeArgs() {
  const startHook = flag(parsed, "start-hook") ?? "git-worktree";
  if (startHook === "none") {
    return ["--start-hook", "none"];
  }
  return ["--worktree-root", flag(parsed, "worktree-root") ?? DEFAULT_SELF_ITERATION_WORKTREE_ROOT, "--start-hook", startHook];
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(value) || value === "$(pwd)") {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function once<T extends (...args: never[]) => void>(fn: T): T {
  let called = false;
  return ((...args: never[]) => {
    if (called) return;
    called = true;
    fn(...args);
  }) as T;
}

function renderTaskPrompt(taskId: string) {
  const task = harness.getTask(taskId);
  if (!task) {
    fail(`task not found: ${taskId}`);
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    fail(`run not found: ${task.runId}`);
  }
  return buildTaskPrompt({
    run,
    task,
    dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
    lessons: harness.listLessons({ runId: run.id }),
    template: harness.getPromptTemplate("task")?.contentMd,
  });
}

function proposeGuardrailsFromLessons(input: { runId: string; minCount: number }) {
  const run = harness.getRun(input.runId);
  if (!run) {
    fail(`run not found: ${input.runId}`);
  }
  const proposalResult = buildGuardrailProposalsFromLessons({
    lessons: harness.listLessons({ runId: input.runId }),
    existingProposals: run.context.guardrailProposals,
    minCount: input.minCount,
  });

  harness.updateRun({
    runId: input.runId,
    contextPatch: {
      guardrailProposals: proposalResult.nextProposals,
    },
  });

  return {
    runId: input.runId,
    minCount: input.minCount,
    proposed: proposalResult.proposed,
    proposals: proposalResult.proposals,
  };
}

function acceptGuardrailProposal(input: { runId: string; proposalId: string; acceptedBy: string }) {
  const run = harness.getRun(input.runId);
  if (!run) {
    fail(`run not found: ${input.runId}`);
  }
  const accepted = acceptGuardrailProposalInContext({
    context: run.context,
    proposalId: input.proposalId,
    acceptedBy: input.acceptedBy,
  });
  if (!accepted) {
    fail(`guardrail proposal not found: ${input.proposalId}`);
  }

  harness.updateRun({
    runId: input.runId,
    contextPatch: {
      guardrailProposals: accepted.nextProposals,
      guardrails: accepted.nextGuardrails,
    },
  });

  return {
    runId: input.runId,
    proposalId: input.proposalId,
    guardrail: accepted.guardrail,
  };
}

function executorFactory(_executorName: CliExecutorName) {
  const replayCache = createDurableAttemptReplayCache({ harness });
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    route: ResolvedExecutionRoute;
  }) => {
    const hardTimeoutMs = genericHardTimeoutMs();
    return createRouteExecutor({
      cwd: input.cwd,
      route: input.route,
      approval: parseApproval(flag(parsed, "approval") ?? "approve-reads"),
      browserProcessPolicy: input.task.role === "goal-review" ? "deny" : parseBrowserProcessPolicy(),
      sandbox: taskPermissionMode(input.task, parseSandbox(flag(parsed, "sandbox") ?? "read-only")),
      codexBin: flag(parsed, "codex-bin"),
      timeoutMs: hardTimeoutMs,
      idleTimeoutMs: input.route.backend.kind === "dsh-cli" ? hardTimeoutMs : genericIdleTimeoutMs(),
      replayCache,
      hostExecutionCapabilities: input.task.config?.hostExecutionCapabilities,
      taskRole: input.task.role,
      verifierContract: input.task.config?.verifierContract,
      dshProfileIsolation: dshProfileIsolationForRoute(input.route),
      dshRequiredPlugins: stringArrayConfig(input.task.config?.dshRequiredPlugins),
      dshFilePolicy: dshFilePolicyConfig(input.run, input.task),
      dshInstallationReceipt: input.task.config?.dshInstallationReceipt as Record<string, unknown> | undefined,
      dshNoWriteProgressPolicy: input.task.config?.dshNoWriteProgressPolicy as {
        maxStallMs: number;
        minModelRequests: number;
        probeIntervalMs: number;
      } | undefined,
    });
  };
}

function attemptInputFactory(_executorName: CliExecutorName) {
  return (input: {
    run: NonNullable<ReturnType<Harness["getRun"]>>;
    task: NonNullable<ReturnType<Harness["getTask"]>>;
    cwd: string;
    route: ResolvedExecutionRoute;
  }) => {
    const dshProfileIsolation = dshProfileIsolationForRoute(input.route);
    const dshRequiredPlugins = stringArrayConfig(input.task.config?.dshRequiredPlugins);
    const permissionMode = taskPermissionMode(input.task, parseSandbox(flag(parsed, "sandbox") ?? "read-only"));
    const dshNoWriteProgressPolicy = input.task.config?.dshNoWriteProgressPolicy as {
      maxStallMs: number;
      minModelRequests: number;
      probeIntervalMs: number;
    } | undefined;
    return {
      ...attemptInputForRoute(input.route, input.cwd),
      permissionMode,
      ...(dshProfileIsolation ? { dshProfileIsolation } : {}),
      ...(dshRequiredPlugins?.length ? { dshRequiredPlugins } : {}),
      ...(dshNoWriteProgressPolicy ? { dshNoWriteProgressPolicy } : {}),
      ...hostExecutionCapabilityAttemptInput(input.task.config?.hostExecutionCapabilities, {
        role: input.task.role,
        verifierContract: input.task.config?.verifierContract,
      }),
    };
  };
}

function dshProfileIsolationForRoute(route?: ResolvedExecutionRoute) {
  return route?.backend.kind === "dsh-cli" ? "base-headless" as const : undefined;
}

function stringArrayConfig(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return ["<invalid dshRequiredPlugins configuration>"];
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function taskPermissionMode(task: NonNullable<ReturnType<Harness["getTask"]>>, fallback: CodexSandbox): CodexSandbox {
  const configured = task.config?.permissionMode;
  if (configured === undefined) return fallback;
  if (configured !== "read-only" && configured !== "workspace-write") {
    fail(`task ${task.id} has invalid permissionMode`);
  }
  if ((task.role === "planner" || task.role === "verifier" || task.role === "goal-review") && configured !== "read-only") {
    fail(`task ${task.id} role ${task.role} cannot request ${configured}`);
  }
  return configured;
}

function dshFilePolicyConfig(
  run: NonNullable<ReturnType<Harness["getRun"]>>,
  task: NonNullable<ReturnType<Harness["getTask"]>>,
): DshFilePolicy | undefined {
  const value = task.config?.dshFilePolicy;
  if (value === undefined) return undefined;
  if (run.context.source !== "design") return value as DshFilePolicy;
  const proposal = recordValue(run.context.designProposal);
  const pack = recordValue(proposal.evolutionPack);
  try {
    return validateDshFilePolicyAgainstFrozenRuntime({
      policy: value,
      repositoryId: task.config?.repositoryId,
      boundary: task.config?.runtimeIntegrationBoundary ?? run.context.runtimeIntegrationBoundary,
      mutationSurfaces: pack.mutationSurfaces,
    });
  } catch {
    fail(`task ${task.id} DSH file policy exceeds or drifts from the frozen design mutation surfaces`);
  }
}

function resolveCliExecutionRoute(input: {
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  cliExecutor: CliExecutorName;
}) {
  return resolveExecutionRoute({
    run: input.run,
    task: input.task,
    cliAgentBackend: flag(parsed, "agent-backend"),
    cliExecutor: input.cliExecutor,
    globalModel: flag(parsed, "model"),
  });
}

function attemptInputForRoute(route: ResolvedExecutionRoute, cwd: string) {
  return {
    route,
    backend: route.backend,
    cwd,
    model: route.model,
  };
}

function codexRunnerInput(defaultStopHooks?: string) {
  const stopHookNames = (flag(parsed, "stop-hook") ?? defaultStopHooks)?.split(",") ?? [];
  return {
    harness,
    cwd: runnerCwd(),
    worktreeForTask: worktreeForTask(),
    startHooks: startHooks(),
    stopHooksByRole: stopHooksByRole(defaultStopHooks),
    reconcileTerminalDoneWorkerVerifiers: stopHookNames.includes("create-verifier"),
    reconcileTerminalBlockedVerifierRepairs: stopHookNames.includes("create-repair"),
    cliAgentBackend: flag(parsed, "agent-backend"),
    cliExecutor: "codex-resumable" as const,
    model: flag(parsed, "model"),
    genericExecutorFactory: executorFactory("codex-resumable"),
    genericAttemptInput: attemptInputFactory("codex-resumable"),
    hostReadbackForTask: readHostCapabilityReadback,
    codexOptions: {
      sandbox: parseCodexResumableSandbox(),
      browserProcessPolicy: parseBrowserProcessPolicy(),
      codexBin: flag(parsed, "codex-bin"),
      timeoutMs: parseTimeoutMs(flag(parsed, "timeout-ms")),
      idleTimeoutMs: parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms"),
    },
  };
}

function rejectAmbientIntegrationOverrides() {
  const automaticIntegrationCommand = parsed.command === "supervise-runs"
    || parsed.command === "supervise-daemon"
    || parsed.command === "self-improve-daemon";
  if (!automaticIntegrationCommand) {
    return;
  }
  if (flag(parsed, "integration-push") !== undefined) {
    fail("--integration-push cannot override the frozen integrationBoundary; use pushExactGitRef for remote publication");
  }
  if (flag(parsed, "integration-target-branch") !== undefined) {
    fail("--integration-target-branch cannot override the frozen integrationBoundary");
  }
}

function parseBrowserProcessPolicy(): "allow" | "deny" | undefined {
  const raw = flag(parsed, "browser-process-policy");
  if (raw === undefined) {
    return parsed.command === "self-improve-daemon" ? "deny" : undefined;
  }
  if (raw === "allow" || raw === "deny") {
    return raw;
  }
  fail("--browser-process-policy must be allow or deny");
}

function createPlannerFromUserGoal(input: { runId: string; goal: string; interrupted: boolean }) {
  const prefix = input.interrupted ? "Replan after user interruption" : "Plan user goal";
  return harness.createTask({
    runId: input.runId,
    role: "planner",
    goal: `${prefix}: ${input.goal}`,
    prompt: [
      input.interrupted
        ? "The user interrupted the current run and gave a new requirement."
        : "The user added a new goal from the dashboard.",
      "",
      "User request:",
      input.goal,
      "",
      "Inspect the current run state, recent attempts, lessons, and repository state before planning.",
      "Return structured JSON with one to five nextTasks items for the next useful increment.",
      "Prefer a worker task when the next step is implementation, or a verifier task when the next step is validation.",
      "Keep the task small enough for the existing run-loop to execute and verify.",
    ].join("\n"),
    doneWhen: [
      "current run state has been inspected",
      "one to five nextTasks items are returned",
      "next task is small enough for the run-loop",
    ],
  });
}

function createPlannerFollowUpTask(goal: string) {
  return {
    role: "planner",
    goal: `Replan after user interruption: ${goal}`,
    prompt: [
      "The user interrupted the current run and gave a new requirement.",
      "",
      "User request:",
      goal,
      "",
      "Inspect the current run state, recent attempts, lessons, and repository state before planning.",
      "Return structured JSON with one to five nextTasks items for the next useful increment.",
      "Prefer a worker task when the next step is implementation, or a verifier task when the next step is validation.",
      "Keep the task small enough for the existing run-loop to execute and verify.",
    ].join("\n"),
    doneWhen: [
      "current run state has been inspected",
      "one to five nextTasks items are returned",
      "next task is small enough for the run-loop",
    ],
  };
}

function createRepairFollowUpTask(task: NonNullable<ReturnType<Harness["getTask"]>>, reason: string) {
  return {
    role: "worker",
    goal: `Repair interrupted work: ${task.goal}`,
    prompt: [
      "The user stopped the current task from the dashboard.",
      "",
      "Stopped task:",
      task.goal,
      "",
      "Stop reason:",
      reason,
      "",
      "Inspect the current run state, recent attempts, lessons, and repository state before repairing.",
      "Return structured JSON with the smallest repair increment that can be run safely after the interruption.",
    ].join("\n"),
    doneWhen: [
      "the stopped attempt has been reviewed",
      "the repair task is runnable after the interruption",
      "the next repair step is small enough for the run-loop",
    ],
  };
}

function createdTaskIdFromActionResult(result: { artifacts: Array<Record<string, unknown>> }): string | undefined {
  const created = result.artifacts.find((artifact) => artifact.kind === "task" && typeof artifact.taskId === "string");
  return typeof created?.taskId === "string" ? created.taskId : undefined;
}

async function createSelfIterationBootstrap() {
  harness.init();
  const config = await loadCliConfig();
  const sourceRoot = resolve(runnerCwd());
  const assessmentFingerprint = repositoryFingerprint(sourceRoot);
  const projectId = ensureSelfIterationProject();
  const charterId = ensureSelfIterationFounderCharter(projectId);
  const runId = harness.createRun({
    goal: SELF_ITERATION_GOAL,
    projectId,
    context: withSelfIterationConfigDefaults({
      source: "self-improve",
      planDoc: SELF_ITERATION_PLAN_DOC,
      designDoc: SELF_ITERATION_DESIGN_DOC,
      goalContract: SELF_ITERATION_GOAL_CONTRACT,
      founderCharterId: charterId,
      designCharterId: charterId,
      selfImprovement: {
        cycleIndex: 0,
        assessmentFingerprint,
      },
      controlPlaneRuntime: initialControlPlaneRuntime(sourceRoot),
    }, config),
  });
  const taskId = harness.createTask({
    runId,
    role: "designer",
    goal: "Decide whether Ouroboros should record signals, propose a design, defer, or stay quiescent",
    prompt: selfIterationDesignerPrompt(),
    doneWhen: SELF_ITERATION_PLANNER_DONE_WHEN,
  });
  return { runId, taskId };
}

async function createTargetSystemDesignBootstrap(input: {
  kernelProjectId: string;
  targetProjectId: string;
  goal: string;
}) {
  harness.init();
  const kernelProject = harness.getProject(input.kernelProjectId);
  if (!kernelProject) {
    fail(`kernel project not found: ${input.kernelProjectId}`);
  }
  const targetProject = harness.getProject(input.targetProjectId);
  if (!targetProject) {
    fail(`target project not found: ${input.targetProjectId}`);
  }
  if (kernelProject.id === targetProject.id) {
    fail("kernel and target projects must be different");
  }
  const targetCharter = harness.getActiveFounderCharter({ projectId: targetProject.id });
  if (!targetCharter) {
    fail(`active founder charter not found for target project: ${targetProject.id}`);
  }
  const config = await loadCliConfig();
  const researchEvidenceLinks = listResearchEvidenceLinks(harness, { projectId: targetProject.id, limit: 100 });
  const targetSystemEvidenceBundle = buildTargetSystemEvidenceBundle({
    targetProjectId: targetProject.id,
    charterId: targetCharter.id,
    goal: input.goal,
  });
  const runId = harness.createRun({
    goal: input.goal,
    projectId: targetProject.id,
    context: withConfigDefaults({
      source: "target-system-design",
      founderCharterId: targetCharter.id,
      designCharterId: targetCharter.id,
      evolutionInstance: {
        schemaVersion: 1,
        mode: "design-target",
        kernelProjectId: kernelProject.id,
        targetProjectId: targetProject.id,
        cycle: { kind: "design", index: 0 },
      },
      researchEvidenceLinks,
      targetSystemEvidenceBundle,
    }, config),
  });
  const taskId = harness.createTask({
    runId,
    role: "designer",
    goal: `Design a bounded self-evolution system for ${targetProject.name}`,
    prompt: targetSystemDesignerPrompt({
      kernelProject,
      targetProject,
      charterId: targetCharter.id,
      researchEvidenceLinks,
      evidenceBundle: targetSystemEvidenceBundle,
    }),
    doneWhen: TARGET_SYSTEM_DESIGN_DONE_WHEN,
    config: {
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      targetSystemEvidenceBundle,
    },
  });
  return {
    runId,
    taskId,
    kernelProject: {
      id: kernelProject.id,
      name: kernelProject.name,
      rootPath: kernelProject.rootPath,
    },
    targetProject: {
      id: targetProject.id,
      name: targetProject.name,
      rootPath: targetProject.rootPath,
    },
  };
}

function ensureSelfIterationProject() {
  const projects = harness.listProjects();
  const cwd = runnerCwd();
  const existing = projects.find((project) => project.rootPath === cwd);
  if (existing) {
    return existing.id;
  }
  return harness.createProject({ name: SELF_ITERATION_DEFAULT_PROJECT_NAME, rootPath: cwd });
}

function ensureSelfIterationFounderCharter(projectId: string) {
  const existing = harness.getActiveFounderCharter({ projectId });
  if (existing && !shouldUpgradeManagedSelfIterationCharter(existing)) {
    return existing.id;
  }
  const created = harness.createFounderCharter({
    projectId,
    mission: SELF_ITERATION_DEFAULT_CHARTER.mission,
    charter: SELF_ITERATION_DEFAULT_CHARTER,
    activate: true,
  });
  return created.id;
}

function shouldUpgradeManagedSelfIterationCharter(charter: FounderCharter): boolean {
  if (charter.charter.managedBy === "ouroboros") {
    return charter.charter.policyVersion !== SELF_ITERATION_CHARTER_POLICY_VERSION;
  }
  const authority = charter.charter.authority;
  const legacyHumanCategories = authority?.requireHumanFor;
  return charter.mission === SELF_ITERATION_DEFAULT_CHARTER.mission
    && authority?.humanApprovalPolicy === undefined
    && Array.isArray(legacyHumanCategories)
    && legacyHumanCategories.includes("schema-migration")
    && legacyHumanCategories.includes("production-deployment")
    && charter.charter.capitalPolicy?.experimentBudget === 100
    && charter.charter.capitalPolicy?.recurringSpendApprovalAbove === 0;
}

type SelfImprovementDaemonInput = Omit<Parameters<typeof superviseCodexRuns>[0], "maxCycles"> & {
  rootRunId: string;
  tickCycles: number;
  idleMs: number;
  maxTicks: number;
  onTick?: (tick: Record<string, unknown>) => void;
};

async function superviseSelfImprovementDaemon(input: SelfImprovementDaemonInput) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Resolve the Linear polling configuration once. The daemon reuses the same
  // resolved config across every tick; per-tick it consults the durable
  // polling state in the root run context to decide whether to actually poll.
  const linearConfig = await loadCliConfig();
  const linearPollingResolution = resolveLinearPolling(linearConfig.linear);
  const linearConfigSection = linearConfig.linear ?? {};

  // An invalid polling configuration (clamp failures, bad numeric fields) is a
  // permanent operator error. Persist it once as terminal blocked intake so the
  // dashboard surfaces the failure and the daemon stops re-reading the broken
  // config every tick. Missing-* reasons are silent operator-configuration
  // gaps and stay idle.
  if (!linearPollingResolution.enabled && linearPollingResolution.reason === "invalid") {
    persistLinearIntakeTerminal(harness, input.rootRunId, {
      status: "config_error",
      error: linearPollingResolution.error ?? "Linear polling configuration is invalid",
    });
  }

  const linearIntakePump = createLinearIntakePump({
    rootRunId: input.rootRunId,
    pollingResolution: linearPollingResolution,
    linear: linearConfigSection,
    intervalMs: input.idleMs,
  });
  await linearIntakePump.run();
  linearIntakePump.start();

  const ticks: Array<Record<string, unknown>> = [];
  let index = 0;
  try {
    while (!stopping && (input.maxTicks === 0 || index < input.maxTicks)) {
      let waitMs = input.intervalMs;
      let tick: Record<string, unknown>;
      try {
        await linearIntakePump.run();
        const projectId = ensureSelfIterationProject();
        const activeCharterId = ensureSelfIterationFounderCharter(projectId);
        const rootRun = harness.getRun(input.rootRunId);
        if (rootRun && rootRun.context.founderCharterId !== activeCharterId) {
          harness.updateRun({
            runId: input.rootRunId,
            contextPatch: {
              founderCharterId: activeCharterId,
              designCharterId: activeCharterId,
            },
          });
        }
        const runtime = ensureControlPlaneRuntime(input.rootRunId, input.cwd ?? process.cwd(), {
          maxTicks: input.maxTicks,
        });
        if (runtime.state === "stale" || runtime.state === "draining-for-reload") {
          const drainResult = await superviseCodexRuns({
            ...input,
            rootRunId: input.rootRunId,
            maxCycles: input.tickCycles,
            shouldStop: () => stopping || input.shouldStop?.() === true,
          });
          waitMs = input.idleMs;
          tick = {
            type: "self-improvement.tick",
            index,
            status: "draining-for-reload",
            createdCycle: null,
            runtime,
            result: drainResult,
            runCounts: harness.countRunsByStatus(),
            ...linearIntakePump.tickFields(),
            createdAt: new Date().toISOString(),
          };
        } else if (runtime.state === "reloaded" || runtime.state === "reload-failed") {
          if (runtime.handoffLaunched) {
            stopping = true;
          }
          waitMs = input.idleMs;
          tick = {
            type: "self-improvement.tick",
            index,
            status: runtime.state,
            createdCycle: null,
            runtime,
            runCounts: harness.countRunsByStatus(),
            ...linearIntakePump.tickFields(),
            createdAt: new Date().toISOString(),
          };
        } else if (runtime.leaseAllowed === false) {
          waitMs = input.idleMs;
          tick = {
            type: "self-improvement.tick",
            index,
            status: "current-owner-active",
            createdCycle: null,
            runtime,
            runCounts: harness.countRunsByStatus(),
            ...linearIntakePump.tickFields(),
            createdAt: new Date().toISOString(),
          };
        } else {
          const authorityReconciliation = reconcileDeferredDesignAuthority({
            harness,
            projectId,
          });
          const cycle = ensureSelfImprovementCycle(input.rootRunId, input.cwd ?? process.cwd());
          if (cycle.state === "quiescent") {
            waitMs = input.idleMs;
            tick = {
              type: "self-improvement.tick",
              index,
              status: "quiescent",
              createdCycle: null,
              authorityReconciliation,
              repositoryFingerprint: cycle.repositoryFingerprint,
              runCounts: harness.countRunsByStatus(),
              ...linearIntakePump.tickFields(),
              createdAt: new Date().toISOString(),
            };
          } else if (cycle.state === "reconciliation") {
            waitMs = input.idleMs;
            tick = {
              type: "self-improvement.tick",
              index,
              status: "ok",
              createdCycle: null,
              reconciliation: cycle.reconciliation,
              authorityReconciliation,
              runCounts: harness.countRunsByStatus(),
              ...linearIntakePump.tickFields(),
              createdAt: new Date().toISOString(),
            };
          } else if (cycle.state === "drain-required") {
            waitMs = input.idleMs;
            tick = {
              type: "self-improvement.tick",
              index,
              status: "ok",
              createdCycle: null,
              drain: cycle.drain,
              authorityReconciliation,
              runCounts: harness.countRunsByStatus(),
              ...linearIntakePump.tickFields(),
              createdAt: new Date().toISOString(),
            };
          } else {
            const result = await superviseCodexRuns({
              ...input,
              rootRunId: input.rootRunId,
              maxCycles: input.tickCycles,
              shouldStop: () => stopping || input.shouldStop?.() === true,
            });
            waitMs = result.status === "idle" ? input.idleMs : input.intervalMs;
            tick = {
              type: "self-improvement.tick",
              index,
              status: "ok",
              createdCycle: cycle.createdCycle,
              ...(cycle.state === "recovery"
                ? { recovery: cycle.recovery, recoveries: cycle.recoveries }
                : {}),
              authorityReconciliation,
              result,
              runCounts: harness.countRunsByStatus(),
              ...linearIntakePump.tickFields(),
              createdAt: new Date().toISOString(),
            };
          }
        }
      } catch (error) {
        tick = {
          type: "self-improvement.tick",
          index,
          status: "error",
          createdCycle: null,
          error: cliErrorMessage(error),
          runCounts: harness.countRunsByStatus(),
          ...linearIntakePump.tickFields(),
          createdAt: new Date().toISOString(),
        };
      }
      try {
        const watchdogResult = applyHarnessAction(harness, {
          type: "runWatchdogPass",
          rootRunId: input.rootRunId,
          daemonIntervalMs: input.intervalMs,
          inboxEvents: readInboxEventsForWatchdog(),
          scheduledReviews: readScheduledReviewsForWatchdog(input.rootRunId),
          reason: "self-improvement.tick",
        });
        tick = { ...tick, watchdog: watchdogResult };
      } catch (error) {
        tick = { ...tick, watchdog: { error: cliErrorMessage(error) } };
      }
      ticks.push(tick);
      input.onTick?.(tick);
      index += 1;
      if (!stopping && (input.maxTicks === 0 || index < input.maxTicks)) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  } finally {
    linearIntakePump.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  return {
    status: stopping ? "stopped" as const : input.maxTicks > 0 ? "tick_limit" as const : "stopped" as const,
    ticks,
    runCounts: harness.countRunsByStatus(),
  };
}

function createLinearIntakePump(input: {
  rootRunId: string;
  pollingResolution: ReturnType<typeof resolveLinearPolling>;
  linear: NonNullable<Awaited<ReturnType<typeof loadCliConfig>>["linear"]>;
  intervalMs: number;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let pollResult: Awaited<ReturnType<typeof runSupervisorLinearPoll>> = {
    reason: "disabled",
    status: "idle",
    advanced: false,
  };
  let intake: ReturnType<typeof consumeLinearInbox> | null = null;
  let intakeOutcomesSinceRead = new Map<
    string,
    ReturnType<typeof consumeLinearInbox>["outcomes"][number]
  >();
  let error: string | null = null;
  let advancedSinceRead = false;

  const run = () => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      pollResult = input.pollingResolution.enabled && input.pollingResolution.config
        ? await runSupervisorLinearPoll({
            rootRunId: input.rootRunId,
            pollingConfig: input.pollingResolution.config,
            linear: input.linear,
          })
        : { reason: "disabled" as const, status: "idle", advanced: false };
      advancedSinceRead ||= pollResult.advanced;
      intake = consumeLinearInbox({ harness, rootRunId: input.rootRunId });
      for (const outcome of intake.outcomes) {
        if (!intakeOutcomesSinceRead.has(outcome.eventId)) {
          intakeOutcomesSinceRead.set(outcome.eventId, outcome);
        }
      }
      error = null;
    })()
      .catch((cause) => {
        error = cliErrorMessage(cause);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    run,
    start() {
      if (timer) return;
      const configuredInterval = input.pollingResolution.config?.intervalMs ?? input.intervalMs;
      timer = setInterval(() => void run(), Math.max(25, Math.min(configuredInterval, input.intervalMs)));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tickFields() {
      const outcomes = [...intakeOutcomesSinceRead.values()];
      const aggregateIntake = outcomes.length > 0
        ? {
            processed: outcomes.length,
            claimed: outcomes.filter((outcome) => outcome.kind === "claimed").length,
            deduplicated: outcomes.filter((outcome) => outcome.kind === "deduplicated").length,
            skipped: outcomes.filter((outcome) => outcome.kind === "skipped").length,
            blocked: outcomes.filter((outcome) => outcome.kind === "blocked").length,
            outcomes,
          }
        : intake;
      const fields = {
        linearIntake: { ...pollResult, advanced: advancedSinceRead || pollResult.advanced },
        linearIntakeConsumption: aggregateIntake,
        ...(error ? { linearIntakeError: error } : {}),
      };
      advancedSinceRead = false;
      intakeOutcomesSinceRead = new Map();
      return fields;
    },
  };
}

async function runSupervisorLinearPoll(input: {
  rootRunId: string;
  pollingConfig: Exclude<ReturnType<typeof resolveLinearPolling>["config"], undefined>;
  linear: NonNullable<Awaited<ReturnType<typeof loadCliConfig>>["linear"]>;
}): Promise<{
  reason: "polled" | "not-due" | "terminal" | "disabled" | "error";
  status: string;
  advanced: boolean;
  error?: string;
  state?: LinearIntakePollingState;
}> {
  const apiUrl = input.linear.apiUrl ?? "https://api.linear.app/graphql";
  const configuredProjectId = input.linear.projectId ?? null;
  const configuredProjectUrl = input.linear.projectUrl ?? null;
  const teamKey = input.linear.teamKey ?? null;
  if (!teamKey) {
    return { reason: "disabled", status: "idle", advanced: false };
  }
  if (!configuredProjectId && !configuredProjectUrl) {
    return { reason: "disabled", status: "idle", advanced: false };
  }

  // Cheap pre-check: do not pay for a token read or network IO when the
  // durable polling state already says we are terminal or not due.
  const peek = peekLinearPollCycle(harness, input.rootRunId);
  if (peek.reason === "terminal") {
    return {
      reason: "terminal",
      status: peek.state.lastStatus,
      advanced: false,
      state: peek.state,
    };
  }
  if (peek.reason === "not-due") {
    return {
      reason: "not-due",
      status: "idle",
      advanced: false,
      state: peek.state,
    };
  }

  // Resolve the durable project ID. When the operator supplied a project_url
  // only, resolve it via Linear once and cache the result so subsequent ticks
  // reuse the ID without paying for another access check.
  let resolvedProjectId = configuredProjectId;
  if (!resolvedProjectId && configuredProjectUrl) {
    const cached =
      peek.state.resolvedProjectUrl === configuredProjectUrl
        ? peek.state.resolvedProjectId
        : null;
    if (cached) {
      resolvedProjectId = cached;
    } else {
      let tokenForLookup: string;
      try {
        tokenForLookup = (
          await readLinearToken({
            tokenEnv: input.linear.tokenEnv ?? null,
            tokenFile: input.linear.tokenFile ?? null,
          })
        ).token;
      } catch (error) {
        const message = (error as Error).message;
        const nextState = persistLinearIntakeTerminal(harness, input.rootRunId, {
          status: "config_error",
          error: message,
        });
        return {
          reason: "error",
          status: "config_error",
          advanced: false,
          error: message,
          state: nextState,
        };
      }
      try {
        const access = await checkLinearAccess({
          harness,
          projectUrl: configuredProjectUrl,
          teamKey,
          tokenEnv: input.linear.tokenEnv ?? null,
          tokenFile: input.linear.tokenFile ?? null,
          apiUrl,
        });
        resolvedProjectId = access.project.id;
        cacheResolvedProjectSelector(harness, input.rootRunId, {
          projectUrl: configuredProjectUrl,
          projectId: access.project.id,
        });
      } catch (error) {
        const message = (error as Error).message;
        const nextState = persistLinearIntakeTerminal(harness, input.rootRunId, {
          status: "config_error",
          error: message,
        });
        return {
          reason: "error",
          status: "config_error",
          advanced: false,
          error: message,
          state: nextState,
        };
      }
    }
  }
  if (!resolvedProjectId) {
    return { reason: "disabled", status: "idle", advanced: false };
  }

  try {
    const tokenSource = await readLinearToken({
      tokenEnv: input.linear.tokenEnv ?? null,
      tokenFile: input.linear.tokenFile ?? null,
    });
    const result = await runLinearPollCycle({
      harness,
      rootRunId: input.rootRunId,
      token: tokenSource.token,
      apiUrl,
      projectId: resolvedProjectId,
      teamKey,
      config: input.pollingConfig,
    });
    return {
      reason: result.reason,
      status: result.status,
      advanced: result.advanced,
      state: result.state,
    };
  } catch (error) {
    // Persistent token read failures (missing token file, etc.) become a
    // visible blocked intake state on the root run so the daemon does not
    // busy-loop on the same configuration error every tick.
    const message = (error as Error).message;
    const nextState = persistLinearIntakeTerminal(harness, input.rootRunId, {
      status: "config_error",
      error: message,
    });
    return { reason: "error", status: "config_error", advanced: false, error: message, state: nextState };
  }
}

function ensureSelfImprovementCycle(rootRunId: string, cwd: string) {
  let scopedRuns = selfImprovementRuns(rootRunId);
  const recoveries = recoverBlockedSelfImprovementRuns(rootRunId, scopedRuns);
  if (recoveries.length > 0) {
    return {
      state: "recovery" as const,
      createdCycle: null,
      recovery: recoveries[0],
      recoveries,
    };
  }
  scopedRuns = selfImprovementRuns(rootRunId);

  const root = harness.getRun(rootRunId);
  if (!root) {
    fail(`run not found: ${rootRunId}`);
  }
  const repositoryState = repositoryFingerprint(cwd);
  const assessmentState = selfImprovementAssessmentFingerprint(repositoryState, scopedRuns);
  const reviewCadenceDays = selfIterationReviewCadenceDays(root);
  const lifecycle = classifySelfImprovementAssessment({
    rootRunId,
    runs: scopedRuns,
    assessmentFingerprint: assessmentState,
    reviewCadenceDays,
  });
  if (lifecycle.state === "active") {
    return { state: "active" as const, createdCycle: null };
  }
  if (lifecycle.state === "drain-required") {
    return {
      state: "drain-required" as const,
      createdCycle: null,
      drain: prepareSelfImprovementDrain(lifecycle),
    };
  }

  // Before asking the designer for a new proposal, surface any measuring
  // design proposal whose outcome review is due. Linking them reopens the
  // measuring run with a bounded outcome-review task; the next tick observes
  // active work and stays out of the designer path until the review drains.
  const dueOutcomes = linkDueOutcomeReviews(scopedRuns);
  if (dueOutcomes.length > 0) {
    return {
      state: "outcome-review" as const,
      createdCycle: null,
      dueOutcomes,
    };
  }

  const reconciliation = reconcileTerminalDesignDeliveries({
    harness,
    rootRunId,
    runs: scopedRuns,
  });
  if (reconciliation.blocksAssessment) {
    return {
      state: "reconciliation" as const,
      createdCycle: null,
      reconciliation,
    };
  }

  const selfImprovement = recordValue(root.context.selfImprovement);
  if (selfImprovement.assessmentFingerprint === assessmentState) {
    const now = Date.now();
    const existingQuiescence = readSelfImprovementQuiescence(root.context);
    if (existingQuiescence && Date.parse(existingQuiescence.nextWakeAt) > now) {
      return {
        state: "quiescent" as const,
        createdCycle: null,
        repositoryFingerprint: repositoryState,
        assessmentFingerprint: assessmentState,
        quiescence: existingQuiescence,
      };
    }
    const reviewCadenceDays = selfIterationReviewCadenceDays(root);
    const derivedQuiescence = latestQuiescentAssessmentDecision({
      rootRunId,
      runs: scopedRuns,
      assessmentFingerprint: assessmentState,
      reviewCadenceDays,
    });
    if (derivedQuiescence && Date.parse(derivedQuiescence.nextWakeAt) > now) {
      const persisted = persistSelfImprovementQuiescence({
        rootRunId,
        assessmentFingerprint: assessmentState,
        reviewCadenceDays,
        quiescence: derivedQuiescence,
      });
      if (persisted) {
        return {
          state: "quiescent" as const,
          createdCycle: null,
          repositoryFingerprint: repositoryState,
          assessmentFingerprint: assessmentState,
          quiescence: persisted,
        };
      }
    }
  }

  const projectId = ensureSelfIterationProject();
  const charterId = ensureSelfIterationFounderCharter(projectId);
  const createdCycle = harness.runInImmediateTransaction((db) => {
    const liveRoot = harness.getRunWithDb(db, rootRunId);
    if (!liveRoot) {
      throw new Error(`run not found: ${rootRunId}`);
    }
    const liveScopedRuns = selfImprovementRunsWithDb(db, rootRunId);
    const liveRepositoryState = repositoryFingerprint(cwd);
    const liveAssessmentState = selfImprovementAssessmentFingerprint(
      liveRepositoryState,
      liveScopedRuns,
      db,
    );
    const liveLifecycle = classifySelfImprovementAssessment({
      rootRunId,
      runs: liveScopedRuns,
      assessmentFingerprint: liveAssessmentState,
      reviewCadenceDays,
      db,
    });
    if (liveLifecycle.state !== "terminal") {
      return null;
    }
    const liveQuiescence = readSelfImprovementQuiescence(liveRoot.context);
    if (liveQuiescence && Date.parse(liveQuiescence.nextWakeAt) > Date.now()) {
      return null;
    }
    const liveSelfImprovement = recordValue(liveRoot.context.selfImprovement);
    const cycleIndex = Math.max(
      Number(liveSelfImprovement.cycleIndex) || 0,
      ...liveScopedRuns.map((run) => Number(recordValue(run.context.selfImprovement).cycleIndex) || 0),
    ) + 1;
    const cycleIdentity = createHash("sha256")
      .update(`${rootRunId}\n${cycleIndex}\n${liveAssessmentState}`)
      .digest("hex");
    const runId = `run_${cycleIdentity.slice(0, 32)}`;
    const taskId = `task_${cycleIdentity.slice(32)}`;
    const existingCycle = harness.getRunWithDb(db, runId);
    if (existingCycle) {
      return null;
    }
    harness.createRunWithDb(db, {
      id: runId,
      goal: `Designer assesses Ouroboros for cycle ${cycleIndex}`,
      projectId,
      context: {
        ...selfImprovementControlContext(liveRoot.context, projectId),
        parentRunId: rootRunId,
        source: "self-improvement-assessment",
        planDoc: SELF_ITERATION_PLAN_DOC,
        designDoc: SELF_ITERATION_DESIGN_DOC,
        goalContract: SELF_ITERATION_GOAL_CONTRACT,
        founderCharterId: charterId,
        designCharterId: charterId,
        selfImprovement: {
          cycleIndex,
          assessmentFingerprint: liveAssessmentState,
        },
      },
    });
    harness.createTaskWithDb(db, {
      id: taskId,
      runId,
      role: "designer",
      goal: `Decide whether Ouroboros should record signals, propose a design, defer, or stay quiescent for cycle ${cycleIndex}`,
      prompt: selfIterationDesignerPrompt(),
      doneWhen: SELF_ITERATION_PLANNER_DONE_WHEN,
    });
    harness.updateRunWithDb(db, {
      runId: rootRunId,
      contextPatch: {
        founderCharterId: charterId,
        designCharterId: charterId,
        selfImprovement: {
          ...liveSelfImprovement,
          cycleIndex: Math.max(Number(liveSelfImprovement.cycleIndex) || 0, cycleIndex),
          assessmentFingerprint: liveAssessmentState,
          quiescent: false,
          nextWakeAt: null,
          quiescence: null,
        },
      },
    });
    return {
      runId,
      taskId,
      cycleIndex,
      repositoryFingerprint: liveRepositoryState,
      assessmentFingerprint: liveAssessmentState,
    };
  });
  if (!createdCycle) {
    return {
      state: "terminal" as const,
      createdCycle: null,
      repositoryFingerprint: repositoryState,
      assessmentFingerprint: assessmentState,
    };
  }
  return {
    state: "created" as const,
    createdCycle: {
      runId: createdCycle.runId,
      taskId: createdCycle.taskId,
      cycleIndex: createdCycle.cycleIndex,
    },
    repositoryFingerprint: createdCycle.repositoryFingerprint,
    assessmentFingerprint: createdCycle.assessmentFingerprint,
  };
}

type SelfImprovementAssessmentLifecycle =
  | { state: "active"; runId: string | null; reason: string }
  | { state: "drain-required"; runId: string; reason: string }
  | { state: "terminal"; runId: string | null; reason: string };

function classifySelfImprovementAssessment(input: {
  rootRunId: string;
  runs: ReturnType<typeof selfImprovementRuns>;
  assessmentFingerprint: string;
  reviewCadenceDays: number;
  db?: HarnessDatabase;
}): SelfImprovementAssessmentLifecycle {
  const assessments = input.runs
    .filter((run) => run.id === input.rootRunId || run.context.source === "self-improvement-assessment")
    .sort((left, right) => {
      const leftCycle = Number(recordValue(left.context.selfImprovement).cycleIndex) || 0;
      const rightCycle = Number(recordValue(right.context.selfImprovement).cycleIndex) || 0;
      return rightCycle - leftCycle || right.id.localeCompare(left.id);
    });
  const latestAssessment = assessments[0] ?? null;
  const overviews = new Map<string, RunOverview>();
  const overviewFor = (runId: string) => {
    const existing = overviews.get(runId);
    if (existing) return existing;
    const overview = input.db
      ? harness.getRunOverviewWithDb(input.db, { runId, eventLimit: 0 })
      : harness.getRunOverview({ runId, eventLimit: 0 });
    overviews.set(runId, overview);
    return overview;
  };

  for (const run of input.runs) {
    const overview = overviewFor(run.id);
    if (runHasActiveAssessmentWork(overview)) {
      return {
        state: "active",
        runId: run.id,
        reason: `active task, attempt, session, or execution lease remains for ${run.id}`,
      };
    }
  }

  const unresolved = input.runs.filter((run) => {
    const overview = overviewFor(run.id);
    return !hasAssessmentTerminalEvidence({
      rootRunId: input.rootRunId,
      latestAssessment,
      run,
      overview,
      assessmentFingerprint: input.assessmentFingerprint,
      reviewCadenceDays: input.reviewCadenceDays,
      db: input.db,
    });
  });
  if (unresolved.length > 0) {
    const candidate = unresolved.find((run) => run.id === latestAssessment?.id)
      ?? unresolved.find((run) => run.status !== "done" && run.status !== "blocked")
      ?? unresolved[0]!;
    return {
      state: "drain-required",
      runId: candidate.id,
      reason: `assessment graph lacks terminal evidence for ${candidate.id}`,
    };
  }

  return {
    state: "terminal",
    runId: latestAssessment?.id ?? null,
    reason: "assessment and descendant delivery graph has explicit terminal evidence",
  };
}

function runHasActiveAssessmentWork(overview: RunOverview) {
  const activeTaskIds = new Set(
    overview.tasks
      .filter((task) => task.status === "todo" || task.status === "running")
      .map((task) => task.id),
  );
  const activeAttemptIds = new Set(
    overview.sessions
      .filter((session) => session.status === "running")
      .map((session) => session.attemptId),
  );
  return activeTaskIds.size > 0
    || activeAttemptIds.size > 0
    || overview.threads.some((thread) =>
      thread.status === "running"
      && (
        (thread.taskId != null && activeTaskIds.has(thread.taskId))
        || (thread.attemptId != null && activeAttemptIds.has(thread.attemptId))
        || (thread.taskId == null && thread.attemptId == null)
      )
    );
}

function hasAssessmentTerminalEvidence(input: {
  rootRunId: string;
  latestAssessment: ReturnType<typeof selfImprovementRuns>[number] | null;
  run: ReturnType<typeof selfImprovementRuns>[number];
  overview: RunOverview;
  assessmentFingerprint: string;
  reviewCadenceDays: number;
  db?: HarnessDatabase;
}) {
  const context = input.run.context;
  if (context.terminal === true || context.terminalEvidence != null) {
    return true;
  }
  if (
    input.run.id === input.rootRunId
    && input.overview.tasks.length === 0
    && input.overview.sessions.length === 0
  ) {
    return true;
  }
  const quiescence = readSelfImprovementQuiescence(context);
  if (quiescence && quiescence.assessmentFingerprint === input.assessmentFingerprint) {
    return true;
  }
  if (context.goalReviewTerminalDisposition != null) {
    return true;
  }
  const reconciliation = recordValue(context.terminalDesignReconciliation);
  if (reconciliation.state === "integrated" || reconciliation.state === "exhausted") {
    return true;
  }
  const exhaustion = recordValue(context.automaticRecoveryExhausted);
  if (typeof exhaustion.used === "number" && typeof exhaustion.limit === "number" && exhaustion.used >= exhaustion.limit) {
    return true;
  }
  const repairBudget = recordValue(context.repairReplanBudget);
  if (typeof repairBudget.used === "number" && typeof repairBudget.limit === "number" && repairBudget.used >= repairBudget.limit) {
    return true;
  }

  const proposalId = typeof context.designProposalId === "string" ? context.designProposalId : null;
  if (proposalId) {
    const proposal = input.db
      ? harness.getDesignProposalWithDb(input.db, { id: proposalId })
      : harness.getDesignProposal({ id: proposalId });
    if (
      proposal
      && (
        proposal.status === "accepted"
        || proposal.status === "measuring"
        || proposal.status === "retained"
        || proposal.status === "revise"
        || proposal.status === "retired"
      )
    ) {
      return true;
    }
  }

  const completedGoalReview = input.overview.sessions.some((session) =>
    session.role === "goal-review"
    && session.status === "done"
    && (session.output.runDecision === "complete" || session.output.runDecision === "defer")
  );
  if (completedGoalReview) {
    return true;
  }
  const nonTerminalGoalReviews = input.overview.sessions.filter((session) =>
    session.role === "goal-review"
    && session.status === "done"
    && (session.output.runDecision === "continue" || session.output.runDecision === "verify")
  );
  if (nonTerminalGoalReviews.length >= 3) {
    return true;
  }

  const designerSessions = input.overview.sessions.filter((session) => session.role === "designer" && session.status === "done");
  const latestDesigner = designerSessions.at(-1);
  const designerOutput = latestDesigner?.output ?? {};
  const designActions = Array.isArray(designerOutput.designActions) ? designerOutput.designActions : [];
  if (designActions.length > 0 && (designerOutput.problems?.length ?? 0) === 0) {
    return true;
  }

  const isBootstrapRoot = input.run.id === input.rootRunId && input.run.context.source === "self-improve";
  if (isBootstrapRoot && input.run.status === "blocked" && input.overview.sessions.some((session) => session.status === "blocked")) {
    return true;
  }

  const storedAssessmentFingerprint = recordValue(context.selfImprovement).assessmentFingerprint;
  const quiescent = quiescenceFromAssessmentOverview({
    sourceRun: input.run,
    overview: input.overview,
    assessmentFingerprint: typeof storedAssessmentFingerprint === "string"
      ? storedAssessmentFingerprint
      : input.assessmentFingerprint,
    reviewCadenceDays: input.reviewCadenceDays,
  });
  if (quiescent) {
    return true;
  }
  return false;
}

function prepareSelfImprovementDrain(lifecycle: Extract<SelfImprovementAssessmentLifecycle, { state: "drain-required" }>) {
  const run = harness.getRun(lifecycle.runId);
  if (!run) {
    return { runId: lifecycle.runId, action: null, reason: lifecycle.reason };
  }
  if (run.status === "done") {
    harness.updateRunStatus({ runId: run.id, status: "todo" });
  }
  const action = applyHarnessAction(harness, {
    type: "prepareRunDrain",
    runId: run.id,
    reason: `self-improvement assessment drain fence: ${lifecycle.reason}`,
  });
  return {
    runId: run.id,
    actionType: action.actionType,
    actionStatus: action.status,
    actionEventId: action.eventId,
    followUpTaskId: action.artifacts.find((artifact) =>
      artifact.kind === "task" && typeof artifact.taskId === "string"
    )?.taskId ?? null,
    reason: lifecycle.reason,
  };
}

function selfIterationReviewCadenceDays(root: NonNullable<ReturnType<Harness["getRun"]>>) {
  const charterId = typeof root.context.founderCharterId === "string"
    ? root.context.founderCharterId
    : null;
  const projectId = root.projectId ?? ensureSelfIterationProject();
  const charter = charterId
    ? harness.getFounderCharter({ id: charterId })
    : harness.getActiveFounderCharter({ projectId });
  const configured = Number(charter?.charter.reviewCadenceDays);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(365, Math.floor(configured))
    : SELF_ITERATION_DEFAULT_CHARTER.reviewCadenceDays;
}

function latestQuiescentAssessmentDecision(input: {
  rootRunId: string;
  runs: ReturnType<typeof selfImprovementRuns>;
  assessmentFingerprint: string;
  reviewCadenceDays: number;
}) {
  const assessmentRuns = input.runs.filter(
    (run) => run.context.source === "self-improvement-assessment",
  );
  const candidates = input.runs
    .filter((run) => {
      if (run.context.source === "self-improvement-assessment") return true;
      // The bootstrap root owns the first Designer assessment. Once a real
      // assessment child exists, the mutable root context must never be used
      // as evidence for a later cycle.
      return assessmentRuns.length === 0 && run.id === input.rootRunId && run.status === "done";
    })
    .filter((run) =>
      recordValue(run.context.selfImprovement).assessmentFingerprint === input.assessmentFingerprint
    )
    .sort((left, right) => {
      const leftCycle = Number(recordValue(left.context.selfImprovement).cycleIndex) || 0;
      const rightCycle = Number(recordValue(right.context.selfImprovement).cycleIndex) || 0;
      return leftCycle - rightCycle || left.id.localeCompare(right.id);
    });
  const sourceRun = candidates.at(-1);
  if (!sourceRun) return null;
  const overview = harness.getRunOverview({ runId: sourceRun.id, eventLimit: 0 });
  return quiescenceFromAssessmentOverview({
    sourceRun,
    overview,
    assessmentFingerprint: input.assessmentFingerprint,
    reviewCadenceDays: input.reviewCadenceDays,
  });
}

function quiescenceFromAssessmentOverview(input: {
  sourceRun: NonNullable<RunOverview["run"]>;
  overview: RunOverview;
  assessmentFingerprint: string;
  reviewCadenceDays: number;
}) {
  const { sourceRun, overview } = input;
  if (
    (sourceRun.status !== "done" && sourceRun.status !== "todo")
    || recordValue(sourceRun.context.selfImprovement).assessmentFingerprint !== input.assessmentFingerprint
    || overview.tasks.length === 0
    || overview.tasks.some((task) => task.role !== "designer" || task.status !== "done")
    || overview.sessions.length === 0
    || overview.sessions.some((session) => session.role !== "designer" || session.status !== "done")
  ) {
    return null;
  }
  const designerSessions = overview.sessions.filter((session) => session.role === "designer");
  const hasDesignAction = designerSessions.some((session) => {
    const output = recordValue(session.output);
    const designActions = Array.isArray(output.designActions) ? output.designActions : [];
    const actions = Array.isArray(output.actions) ? output.actions : [];
    return designActions.length > 0 || actions.length > 0;
  });
  if (hasDesignAction) return null;
  const source = [...designerSessions]
    .sort((left, right) =>
      String(left.finishedAt ?? "").localeCompare(String(right.finishedAt ?? ""))
      || left.attemptId.localeCompare(right.attemptId)
    )
    .at(-1)!;
  const summary = typeof source.output.summary === "string" ? source.output.summary.trim() : "";
  if (summary.length === 0 || (source.output.problems?.length ?? 0) > 0) return null;
  const decidedAt = source.finishedAt ? normalizeDatabaseTimestamp(source.finishedAt) : null;
  if (!decidedAt) return null;
  const nextWakeAt = new Date(Date.parse(decidedAt) + input.reviewCadenceDays * DAY_MS).toISOString();
  return {
    version: 1 as const,
    assessmentFingerprint: input.assessmentFingerprint,
    sourceRunId: sourceRun.id,
    sourceTaskId: source.taskId,
    sourceAttemptId: source.attemptId,
    summary: summary.slice(0, 2_000),
    decidedAt,
    nextWakeAt,
    evidence: [`attempt:${source.attemptId}`],
  };
}

function persistSelfImprovementQuiescence(input: {
  rootRunId: string;
  assessmentFingerprint: string;
  reviewCadenceDays: number;
  quiescence: NonNullable<ReturnType<typeof latestQuiescentAssessmentDecision>>;
}) {
  return harness.runInImmediateTransaction((db) => {
    const root = harness.getRunWithDb(db, input.rootRunId);
    if (!root) return null;
    const selfImprovement = recordValue(root.context.selfImprovement);
    if (selfImprovement.assessmentFingerprint !== input.assessmentFingerprint) {
      return null;
    }
    const existing = readSelfImprovementQuiescence(root.context);
    if (existing) return existing;
    const sourceOverview = harness.getRunOverviewWithDb(db, {
      runId: input.quiescence.sourceRunId,
      eventLimit: 0,
    });
    if (!sourceOverview.run) return null;
    const quiescence = quiescenceFromAssessmentOverview({
      sourceRun: sourceOverview.run,
      overview: sourceOverview,
      assessmentFingerprint: input.assessmentFingerprint,
      reviewCadenceDays: input.reviewCadenceDays,
    });
    if (!quiescence || JSON.stringify(quiescence) !== JSON.stringify(input.quiescence)) {
      return null;
    }
    harness.updateRunWithDb(db, {
      runId: sourceOverview.run.id,
      status: "done",
    });
    harness.updateRunWithDb(db, {
      runId: input.rootRunId,
      contextPatch: {
        selfImprovement: {
          ...selfImprovement,
          quiescent: true,
          nextWakeAt: quiescence.nextWakeAt,
          quiescence,
        },
      },
    });
    return quiescence;
  });
}

function normalizeDatabaseTimestamp(value: string) {
  const candidate = value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function recoverBlockedSelfImprovementRuns(
  rootRunId: string,
  scopedRuns: ReturnType<typeof selfImprovementRuns>,
) {
  const recoveries: Array<{
    runId: string;
    taskId: string;
    sourceTaskId: string;
    sourceAttemptId: string | null;
    terminalReason: string | null;
    fromBackend: string;
    toBackend: string;
    resumed: boolean;
  }> = [];
  const blockedRuns = [...scopedRuns]
    .reverse()
    .filter((run) => {
      if (run.id === rootRunId || run.status !== "blocked") return false;
      if (run.context.retired === true) return false;
      const source = typeof run.context.source === "string" ? run.context.source : null;
      return source !== "self-improve";
    });

  for (const run of blockedRuns) {
    const overview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
    const blockedSessions = [...overview.sessions]
      .filter((session) => session.status === "blocked")
      .reverse();
    const sourceSession = blockedSessions.find((session) => session.backend != null) ?? blockedSessions[0] ?? null;
    const sourceTask = sourceSession
      ? overview.tasks.find((task) => task.id === sourceSession.taskId)
      : [...overview.tasks].reverse().find((task) => task.status === "blocked");
    if (!sourceTask) {
      continue;
    }

    const sourceAttemptId = sourceSession?.attemptId ?? null;
    const terminalReason = sourceSession ? terminalReasonForSession(sourceSession) : null;
    const isExecutorFailure = terminalReason != null && EXECUTOR_FAILURE_TERMINAL_REASONS.has(terminalReason);
    const fromBackend = sourceSession ? backendIdForSession(sourceSession) : configuredBackendForTask(run.context, sourceTask);
    const toBackend = "codex-resumable";

    const previousRecovery = recordValue(sourceTask.config?.automaticRecovery);
    const inheritedSourceWorktreePath = typeof sourceTask.config?.sourceWorktreePath === "string"
      && typeof previousRecovery.sourceTaskId === "string"
      ? sourceTask.config.sourceWorktreePath
      : null;
    const sourceWorktreePath = inheritedSourceWorktreePath ?? (sourceSession
      ? worktreePathForSession(sourceSession) ?? sourceTask.worktreePath
      : sourceTask.worktreePath);
    const generation = Math.max(0, Number(previousRecovery.generation) || 0) + 1;
    const { modelPreference: _modelPreference, automaticRecovery: _automaticRecovery, ...sourceConfig } = sourceTask.config ?? {};
    const proposedRecoveryTaskId = makeId("task");
    const atomic = harness.runInImmediateTransaction((db) => {
      const currentOverview = harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
      const currentRun = currentOverview.run;
      if (!currentRun || currentRun.context.retired === true) {
        return { kind: "blocked" as const, taskId: null };
      }
      const storedBudget = readRepairBudget(currentRun.context);
      const reconciled = reconcileGoalReviewRepairBudget(storedBudget, currentOverview);
      const budget = chargeRepairBudgetState(reconciled.nextBudget, {
        limit: DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT,
        taskId: sourceTask.id,
        ...(sourceAttemptId ? { attemptId: sourceAttemptId } : {}),
        kind: "repair",
        summary: sourceSession?.output.summary ?? `Automatic recovery for blocked ${sourceTask.role} task`,
        rootTaskId: typeof previousRecovery.sourceTaskId === "string" ? previousRecovery.sourceTaskId : sourceTask.id,
        rootCause: terminalReason ?? `${sourceTask.role}:blocked`,
      });
      const existing = currentOverview.tasks.find((candidate) => {
        const recovery = recordValue(candidate.config?.automaticRecovery);
        return recovery.sourceTaskId === sourceTask.id
          && (recovery.sourceAttemptId ?? null) === sourceAttemptId;
      });
      if (existing) {
        if (!budget.allowed) {
          harness.updateRunWithDb(db, {
            runId: run.id,
            status: "blocked",
            contextPatch: {
              repairReplanBudget: budget.nextBudget,
              automaticRecoveryExhausted: {
                sourceTaskId: sourceTask.id,
                sourceAttemptId,
                used: budget.nextBudget.used,
                limit: budget.nextBudget.limit,
                reason: budget.reason,
              },
            },
          });
          return { kind: "blocked" as const, taskId: null };
        }
        const active = existing.status === "todo" || existing.status === "running";
        if (budget.charged || reconciled.chargedTaskIds.length > 0 || (active && currentRun.status !== "todo")) {
          harness.updateRunWithDb(db, {
            runId: run.id,
            ...(active ? { status: "todo" as const } : {}),
            contextPatch: {
              repairReplanBudget: budget.nextBudget,
              ...(active ? { automaticRecoveryExhausted: null } : {}),
            },
          });
        }
        return { kind: active ? "existing-active" as const : "existing-terminal" as const, taskId: existing.id };
      }
      if (!budget.allowed || !budget.charged) {
        harness.updateRunWithDb(db, {
          runId: run.id,
          status: "blocked",
          contextPatch: {
            repairReplanBudget: budget.nextBudget,
            automaticRecoveryExhausted: {
              sourceTaskId: sourceTask.id,
              sourceAttemptId,
              used: budget.nextBudget.used,
              limit: budget.nextBudget.limit,
              reason: budget.allowed
                ? "repair budget was charged but the durable automatic recovery task is missing"
                : budget.reason,
            },
          },
        });
        return { kind: "blocked" as const, taskId: null };
      }
      const recoveryTaskId = harness.createTaskWithDb(db, {
        id: proposedRecoveryTaskId,
        runId: run.id,
        parentId: sourceTask.id,
        role: "worker",
        goal: isExecutorFailure
          ? `Continue ${sourceTask.goal} with ${toBackend} after ${fromBackend} failed`
          : `Diagnose and repair blocked work: ${sourceTask.goal}`,
        prompt: [
          "This task is an automatic recovery of blocked work in the same run.",
          "Do not defer, close, or replace the original goal. Diagnose the recorded failure and continue until the original acceptance evidence passes.",
          "Preserve useful uncommitted changes in the source worktree. Do not restart the implementation from an empty checkout.",
          "",
          `Blocked task: ${sourceTask.id}`,
          `Blocked goal: ${sourceTask.goal}`,
          `Blocked attempt: ${sourceAttemptId ?? "none recorded"}`,
          `Failure: ${sourceSession?.output.summary ?? "blocked without a terminal attempt summary"}`,
          `Executor route: ${fromBackend} -> ${toBackend}`,
          terminalReason ? `Terminal reason: ${terminalReason}` : "Terminal reason: logical or verification block",
          sourceWorktreePath ? `Source worktree: ${sourceWorktreePath}` : "Source worktree: inspect the current task and run evidence",
          "",
          "Original prompt:",
          sourceTask.prompt,
          "",
          "Inspect the run overview, recent lessons, repository diff, and failing checks before editing.",
          "Resolve the root cause, run the original deterministic checks, and return normal structured attempt output.",
        ].join("\n"),
        doneWhen: sourceTask.doneWhen.length > 0
          ? sourceTask.doneWhen
          : ["the blocking root cause is resolved", "the original goal has passing evidence"],
        worktreePath: sourceWorktreePath,
        config: {
          ...sourceConfig,
          agentBackend: toBackend,
          ...(sourceWorktreePath ? { sourceWorktreePath } : {}),
          automaticRecovery: {
            generation,
            sourceTaskId: sourceTask.id,
            sourceAttemptId,
            terminalReason,
            fromBackend,
            toBackend,
            strategy: isExecutorFailure && fromBackend === "claude-code"
              ? "switch-backend"
              : isExecutorFailure
                ? "codex-repair"
                : "diagnose-and-repair",
          },
        },
      });
      harness.updateRunWithDb(db, {
        runId: run.id,
        status: "todo",
        contextPatch: {
          repairReplanBudget: budget.nextBudget,
          automaticRecoveryExhausted: null,
          automaticRecovery: {
            taskId: recoveryTaskId,
            sourceTaskId: sourceTask.id,
            sourceAttemptId,
            terminalReason,
            fromBackend,
            toBackend,
            generation,
          },
        },
      });
      return { kind: "created" as const, taskId: recoveryTaskId };
    });
    if (atomic.kind === "blocked") {
      continue;
    }
    if (atomic.kind === "existing-terminal") {
      continue;
    }
    const recoveryTaskId = atomic.taskId;
    recoveries.push({
      runId: run.id,
      taskId: recoveryTaskId,
      sourceTaskId: sourceTask.id,
      sourceAttemptId,
      terminalReason,
      fromBackend,
      toBackend,
      resumed: atomic.kind === "existing-active",
    });
  }

  return recoveries;
}

function terminalReasonForSession(session: RunOverview["sessions"][number]) {
  const artifact = session.output.artifacts?.find((candidate) => {
    const value = recordValue(candidate);
    return value.kind === "acpx_terminal_evidence" && typeof value.terminalReason === "string";
  });
  const terminalReason = recordValue(artifact).terminalReason;
  return typeof terminalReason === "string" ? terminalReason : null;
}

function backendIdForSession(session: RunOverview["sessions"][number]) {
  const id = session.backend?.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  if (session.backend?.agent === "claude") {
    return "claude-code";
  }
  return session.backend?.kind === "codex-resumable" ? "codex-resumable" : "codex-resumable";
}

function configuredBackendForTask(context: Record<string, unknown>, task: Task) {
  if (typeof task.config?.agentBackend === "string" && task.config.agentBackend.length > 0) {
    return task.config.agentBackend;
  }
  const defaults = recordValue(context.agentDefaults);
  const roles = recordValue(defaults.roles);
  const roleBackend = roles[task.role];
  if (typeof roleBackend === "string" && roleBackend.length > 0) {
    return roleBackend;
  }
  return typeof defaults.global === "string" && defaults.global.length > 0
    ? defaults.global
    : "codex-resumable";
}

function worktreePathForSession(session: RunOverview["sessions"][number]) {
  const worktreeArtifact = session.output.artifacts?.find((candidate) => recordValue(candidate).kind === "worktree");
  const artifactPath = recordValue(worktreeArtifact).path;
  if (typeof artifactPath === "string" && artifactPath.length > 0) {
    return artifactPath;
  }
  return session.worktreePath ?? null;
}

function selfImprovementAssessmentFingerprint(
  repositoryState: string,
  scopedRuns: ReturnType<typeof selfImprovementRuns>,
  db?: HarnessDatabase,
) {
  const blockers = scopedRuns
    .filter((run) => {
      if (run.status !== "blocked") return false;
      const source = typeof run.context.source === "string" ? run.context.source : null;
      return source !== "self-improve" && source !== "self-improvement-assessment";
    })
    .map((run) => {
      const overview = db
        ? harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 })
        : harness.getRunOverview({ runId: run.id, eventLimit: 0 });
      const blockedTasks = overview.tasks
        .filter((task) => task.status === "blocked")
        .map((task) => {
          const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === task.id);
          return {
            taskId: task.id,
            attemptId: session?.attemptId ?? null,
            summary: session?.output.summary ?? null,
          };
        })
        .sort((left, right) => left.taskId.localeCompare(right.taskId));
      return { runId: run.id, blockedTasks };
    })
    .sort((left, right) => left.runId.localeCompare(right.runId));
  if (blockers.length === 0) {
    return repositoryState;
  }
  return createHash("sha256")
    .update(`${repositoryState}\nblocked:${JSON.stringify(blockers)}`)
    .digest("hex");
}

function selfImprovementRuns(rootRunId: string) {
  return collectSelfImprovementRuns(rootRunId, harness.listRuns({ limit: 1000 }));
}

function selfImprovementRunsWithDb(db: HarnessDatabase, rootRunId: string) {
  return collectSelfImprovementRuns(rootRunId, harness.listRunsWithDb(db, { limit: 1000 }));
}

function collectSelfImprovementRuns(rootRunId: string, allRuns: ReturnType<typeof harness.listRuns>) {
  const included = new Set([rootRunId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of allRuns) {
      const parentRunId = typeof run.context.parentRunId === "string" ? run.context.parentRunId : null;
      if (parentRunId && included.has(parentRunId) && !included.has(run.id)) {
        included.add(run.id);
        changed = true;
      }
    }
  }
  return allRuns.filter((run) => included.has(run.id));
}

function readInboxEventsForWatchdog() {
  return harness.listInboxEvents({ limit: 50 }).map((event) => ({
    id: event.id,
    status: event.status,
    provider: event.provider,
    eventType: event.eventType,
  }));
}

function readScheduledReviewsForWatchdog(rootRunId: string) {
  const scoped = selfImprovementRuns(rootRunId);
  const reviews: Array<{ runId: string; reviewAt: string | null }> = [];
  for (const run of scoped) {
    const proposalIdRaw = run.context?.designProposalId;
    if (typeof proposalIdRaw !== "string" || proposalIdRaw.length === 0) continue;
    const proposal = harness.getDesignProposal({ id: proposalIdRaw });
    if (!proposal || proposal.status !== "measuring") continue;
    const linked = harness.linkProposalOutcomeReview({ runId: run.id });
    if (linked.reviewAt) reviews.push({ runId: run.id, reviewAt: linked.reviewAt });
  }
  return reviews;
}

// Surfaces measuring proposals tied to scoped runs whose outcome review is now
// due. Idempotent: runs that already have an outcome-review task return the
// existing task id without creating a duplicate. Returns the proposals/tasks
// that were created or already linked so the daemon can report active work.
function linkDueOutcomeReviews(runs: ReturnType<typeof selfImprovementRuns>) {
  const created: Array<{ runId: string; taskId: string; proposalId: string }> = [];
  for (const run of runs) {
    if (run.status === "todo" || run.status === "running") {
      continue;
    }
    const proposalIdRaw = run.context?.designProposalId;
    if (typeof proposalIdRaw !== "string" || proposalIdRaw.length === 0) {
      continue;
    }
    const proposal = harness.getDesignProposal({ id: proposalIdRaw });
    if (!proposal || proposal.status !== "measuring") {
      continue;
    }
    const linked = harness.linkProposalOutcomeReview({ runId: run.id });
    if (linked.outcomeReviewTaskId && linked.reviewDue) {
      const reviewTask = harness.getTask(linked.outcomeReviewTaskId);
      if (
        reviewTask?.status === "todo"
        && (run.status === "done" || run.status === "blocked")
      ) {
        harness.updateRunStatus({ runId: run.id, status: "todo" });
        created.push({ runId: run.id, taskId: linked.outcomeReviewTaskId, proposalId: proposal.id });
      }
    }
  }
  return created;
}

function selfImprovementControlContext(context: Record<string, unknown>, projectId: string) {
  const activeHarnessRevision = context.activeHarnessRevision === undefined
    ? undefined
    : parseHarnessRevisionV1(
        context.activeHarnessRevision,
        projectId,
        "activeHarnessRevision",
      );
  return {
    ...Object.fromEntries(
      ["modelDefaults", "agentBackends", "guardrails", "integrationBoundary", "controlPlaneRuntime"]
        .filter((key) => context[key] !== undefined)
        .map((key) => [key, context[key]]),
    ),
    agentDefaults: codexOnlyAgentDefaults(context.agentDefaults, context.agentBackends),
    ...(activeHarnessRevision ? { harnessRevision: activeHarnessRevision } : {}),
  };
}

function repositoryFingerprint(cwd: string) {
  const git = (args: string[]) => {
    try {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
      return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
    } catch {
      return "";
    }
  };
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  return createHash("sha256").update(`${cwd}\n${head || "no-head"}\n${status}`).digest("hex");
}

type ControlPlaneRuntimeState = "current" | "stale" | "draining-for-reload" | "reloaded" | "reload-failed";

type ControlPlaneRuntime = {
  canonicalEntrypoint: string;
  sourceRoot: string;
  launchHead: string;
  observedHead: string;
  observedDirtyStateFingerprint: string;
  promptContractHash: string;
  generation: number;
  processIdentity: string;
  startedAt: string;
  attestedAt: string;
  state: ControlPlaneRuntimeState;
  reloadAttempt: Record<string, unknown>;
  handoffReceipt: Record<string, unknown> | null;
  attestedGeneration: number;
  attestedHead: string;
  attestedPromptContractHash: string;
  attestedProcessIdentity: string;
};

function ensureControlPlaneRuntime(
  rootRunId: string,
  cwd: string,
  input: { maxTicks: number },
): ControlPlaneRuntime & { handoffLaunched?: boolean; leaseAllowed?: boolean } {
  const root = harness.getRun(rootRunId);
  if (!root) {
    fail(`run not found: ${rootRunId}`);
  }
  const observation = repositoryObservation(resolve(cwd));
  const currentPromptHash = protectedPromptContractFingerprintForSource(resolve(cwd));
  const raw = root.context.controlPlaneRuntime;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const initial = initialControlPlaneRuntime(resolve(cwd));
    const claimed = updateControlPlaneRuntimeIf(rootRunId, null, initial);
    return (claimed ?? initial) as ControlPlaneRuntime;
  }
  let runtime = raw as ControlPlaneRuntime;

  if (
    runtime.state === "current"
    && runtime.launchHead === observation.head
    && runtime.promptContractHash === currentPromptHash
    && runtime.processIdentity !== String(process.pid)
  ) {
    if (processIdentityIsAlive(runtime.processIdentity)) {
      return { ...runtime, leaseAllowed: false };
    }
    if (!processCanAttestRuntimeGeneration(runtime)) {
      return { ...runtime, leaseAllowed: false };
    }
    const now = new Date().toISOString();
    const next = {
      ...runtime,
      processIdentity: String(process.pid),
      attestedGeneration: runtime.generation,
      attestedHead: observation.head,
      attestedPromptContractHash: currentPromptHash,
      attestedProcessIdentity: String(process.pid),
      attestedAt: now,
    };
    runtime = updateControlPlaneRuntimeIf(rootRunId, runtime, next) ?? runtime;
    return { ...runtime, leaseAllowed: true };
  }

  if (
    runtime.state === "reloaded"
    && runtime.processIdentity === String(process.pid)
    && runtime.launchHead === observation.head
  ) {
    const now = new Date().toISOString();
    const next = {
      ...runtime,
      state: "current" as const,
      promptContractHash: currentPromptHash,
      observedHead: observation.head,
      observedDirtyStateFingerprint: observation.dirtyStateFingerprint,
      attestedGeneration: runtime.generation,
      attestedHead: observation.head,
      attestedPromptContractHash: currentPromptHash,
      attestedProcessIdentity: String(process.pid),
      attestedAt: now,
      handoffReceipt: runtime.handoffReceipt
        ? { ...runtime.handoffReceipt, newPromptContractHash: currentPromptHash, attestationAt: now }
        : null,
    };
    runtime = updateControlPlaneRuntimeIf(rootRunId, runtime, next) ?? runtime;
    return runtime;
  }

  if (
    runtime.state === "reload-failed"
    && runtime.reloadAttempt?.fingerprint === observation.head
  ) {
    return runtime;
  }

  if (
    (runtime.state === "current" || runtime.state === "reloaded")
    && runtime.launchHead !== observation.head
  ) {
    const next = {
      ...runtime,
      observedHead: observation.head,
      observedDirtyStateFingerprint: observation.dirtyStateFingerprint,
      state: "draining-for-reload" as const,
      staleAt: new Date().toISOString(),
      staleGeneration: runtime.generation,
      reloadAttempt: {
        ...runtime.reloadAttempt,
        fingerprint: observation.head,
        status: "draining-for-reload",
        previousState: "stale",
      },
    };
    runtime = updateControlPlaneRuntimeIf(rootRunId, runtime, next) ?? (harness.getRun(rootRunId)?.context.controlPlaneRuntime as ControlPlaneRuntime);
    return runtime;
  }

  if (runtime.state === "stale") {
    const next = { ...runtime, state: "draining-for-reload" as const };
    runtime = updateControlPlaneRuntimeIf(rootRunId, runtime, next) ?? runtime;
  }
  if (runtime.state !== "draining-for-reload") {
    return { ...runtime, leaseAllowed: runtime.processIdentity === String(process.pid) };
  }

  // A contender may have launched a child between its CAS claim and the
  // receipt write. Treat that narrow persisted window as owned; replay must
  // wait for the claimant instead of launching a second supervisor.
  if (runtime.reloadAttempt?.status === "claimed") {
    return runtime;
  }

  if (selfImprovementRuns(rootRunId).some((run) => harness.listRunningAttempts({ runId: run.id }).length > 0)) {
    return runtime;
  }

  const targetHead = observation.head;
  if (runtime.reloadAttempt?.fingerprint === targetHead && runtime.reloadAttempt?.status === "failed") {
    return runtime;
  }
  const generation = Math.max(0, Number(runtime.generation) || 0) + 1;
  const claim = {
    ...runtime,
    state: "draining-for-reload" as const,
    observedHead: targetHead,
    observedDirtyStateFingerprint: observation.dirtyStateFingerprint,
    reloadAttempt: {
      ...runtime.reloadAttempt,
      count: (Number(runtime.reloadAttempt?.count) || 0) + 1,
      fingerprint: targetHead,
      status: "claimed",
      claimedAt: new Date().toISOString(),
      targetGeneration: generation,
      targetHead,
      targetPromptContractHash: currentPromptHash,
      targetEntrypoint: canonicalSelfIterationEntrypoint(resolve(cwd)),
    },
  };
  const claimed = updateControlPlaneRuntimeIf(rootRunId, runtime, claim);
  if (!claimed) {
    return (harness.getRun(rootRunId)?.context.controlPlaneRuntime as ControlPlaneRuntime) ?? runtime;
  }
  const entrypoint = canonicalSelfIterationEntrypoint(resolve(cwd));
  let childPid: number | null = null;
  try {
    if (!Bun.file(entrypoint).size) {
      throw new Error(`canonical self-improvement entrypoint is missing: ${entrypoint}`);
    }
    const command = [
      process.execPath,
      entrypoint,
      "--db",
      parsed.db,
      "self-improve-daemon",
      "--root-run-id",
      rootRunId,
      "--executor",
      "codex-resumable",
      "--stop-hook",
      flag(parsed, "stop-hook") ?? DEFAULT_STOP_HOOKS,
      "--cwd",
      resolve(cwd),
      ...(flag(parsed, "codex-bin") ? ["--codex-bin", flag(parsed, "codex-bin")!] : []),
      ...(flag(parsed, "tick-cycles") ? ["--tick-cycles", flag(parsed, "tick-cycles")!] : []),
      ...(flag(parsed, "max-rounds") ? ["--max-rounds", flag(parsed, "max-rounds")!] : []),
      ...(flag(parsed, "max-tries") ? ["--max-tries", flag(parsed, "max-tries")!] : []),
      ...(flag(parsed, "interval-ms") ? ["--interval-ms", flag(parsed, "interval-ms")!] : []),
      ...(flag(parsed, "idle-ms") ? ["--idle-ms", flag(parsed, "idle-ms")!] : []),
      ...(input.maxTicks > 0 ? ["--max-ticks", String(input.maxTicks)] : []),
    ];
    const child = Bun.spawn({
      cmd: command,
      cwd: resolve(cwd),
      env: childEnvForProcess(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    childPid = child.pid;
    (child as unknown as { unref?: () => void }).unref?.();
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failed = {
      ...claim,
      state: "reload-failed" as const,
      reloadAttempt: {
        ...claim.reloadAttempt,
        status: "failed",
        failedAt,
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        error: cliErrorMessage(error),
      },
    };
    return updateControlPlaneRuntimeIf(rootRunId, claim, failed) ?? failed;
  }
  const now = new Date().toISOString();
  const receipt = {
    oldGeneration: runtime.generation,
    newGeneration: generation,
    oldHead: runtime.launchHead,
    newHead: targetHead,
    oldPromptContractHash: runtime.promptContractHash,
    newPromptContractHash: currentPromptHash,
    oldProcessIdentity: runtime.processIdentity,
    newProcessIdentity: String(childPid ?? "unknown"),
    claimAt: claim.reloadAttempt.claimedAt,
    startAt: now,
    attestationAt: null,
  };
  const launched = {
    ...claim,
    canonicalEntrypoint: entrypoint,
    sourceRoot: resolve(cwd),
    launchHead: targetHead,
    observedHead: targetHead,
    generation,
    processIdentity: String(childPid ?? "unknown"),
    startedAt: now,
    attestedAt: runtime.attestedAt,
    state: "reloaded" as const,
    promptContractHash: currentPromptHash,
    attestedGeneration: runtime.generation,
    attestedHead: runtime.launchHead,
    attestedPromptContractHash: runtime.promptContractHash,
    attestedProcessIdentity: runtime.processIdentity,
    reloadAttempt: { ...claim.reloadAttempt, status: "launched", startedAt: now, childPid },
    handoffReceipt: receipt,
  };
  return { ...(updateControlPlaneRuntimeIf(rootRunId, claim, launched) ?? launched), handoffLaunched: true };
}

function updateControlPlaneRuntimeIf(
  rootRunId: string,
  expected: ControlPlaneRuntime | null,
  next: ControlPlaneRuntime,
) {
  return harness.runInImmediateTransaction((db) => {
    const row = db.query("select context_json from runs where id = $runId").get({ $runId: rootRunId }) as { context_json?: string } | null;
    if (!row || typeof row.context_json !== "string") return null;
    const context = JSON.parse(row.context_json) as Record<string, unknown>;
    const current = context.controlPlaneRuntime as ControlPlaneRuntime | undefined;
    if (expected && JSON.stringify(current) !== JSON.stringify(expected)) return null;
    if (!expected && current) return null;
    db.query(
      "update runs set context_json = $contextJson, updated_at = current_timestamp where id = $runId",
    ).run({
      $runId: rootRunId,
      $contextJson: JSON.stringify({ ...context, controlPlaneRuntime: next }),
    });
    return next;
  });
}

function processIdentityIsAlive(identity: string | undefined) {
  const pid = Number(identity);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCanAttestRuntimeGeneration(runtime: ControlPlaneRuntime) {
  const processEntrypoint = typeof process.argv[1] === "string" ? canonicalFilesystemPath(process.argv[1]) : "";
  if (processEntrypoint !== canonicalFilesystemPath(runtime.canonicalEntrypoint)) {
    return false;
  }
  const handoffStartedAt = runtime.handoffReceipt?.startAt;
  if (typeof handoffStartedAt !== "string") {
    return true;
  }
  const handoffStartedAtMs = Date.parse(handoffStartedAt);
  return Number.isFinite(handoffStartedAtMs) && performance.timeOrigin >= handoffStartedAtMs;
}

function canonicalFilesystemPath(value: string) {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

function initialControlPlaneRuntime(sourceRoot: string): ControlPlaneRuntime {
  const observation = repositoryObservation(sourceRoot);
  const now = new Date().toISOString();
  // Bootstrap commands are short-lived and must not advertise their PID as a
  // lease-owning daemon. The first canonical supervisor replaces this marker
  // with its attested process identity before it can start work.
  const processIdentity = "supervisor-pending";
  return {
    canonicalEntrypoint: canonicalSelfIterationEntrypoint(sourceRoot),
    sourceRoot,
    launchHead: observation.head,
    observedHead: observation.head,
    observedDirtyStateFingerprint: observation.dirtyStateFingerprint,
    promptContractHash: protectedPromptContractFingerprintForSource(sourceRoot),
    generation: 1,
    processIdentity,
    startedAt: now,
    attestedAt: now,
    state: "current",
    reloadAttempt: { count: 0, fingerprint: null, status: "none", cooldownUntil: null },
    handoffReceipt: null,
    attestedGeneration: 1,
    attestedHead: observation.head,
    attestedPromptContractHash: protectedPromptContractFingerprintForSource(sourceRoot),
    attestedProcessIdentity: processIdentity,
  };
}

function canonicalSelfIterationEntrypoint(sourceRoot: string) {
  return resolve(sourceRoot, "packages/cli/src/main.ts");
}

function repositoryObservation(cwd: string) {
  const git = (args: string[]) => {
    try {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
      return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
    } catch {
      return "";
    }
  };
  const head = git(["rev-parse", "HEAD"]) || "no-head";
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    head,
    dirtyStateFingerprint: createHash("sha256").update(status, "utf8").digest("hex"),
    repositoryFingerprint: createHash("sha256").update(`${cwd}\n${head}\n${status}`, "utf8").digest("hex"),
  };
}

async function createIntakeRun(input: { title: string; document: string }) {
  harness.init();
  const config = await loadCliConfig();
  const runId = harness.createRun({
    goal: `Intake: ${input.title}`,
    context: withConfigDefaults({
      source: "intake",
      title: input.title,
      document: input.document,
    }, config),
  });
  const taskId = harness.createTask({
    runId,
    role: "planner",
    goal: "Split requirement document into executable runs",
    prompt: intakePlannerPrompt(input.document),
    doneWhen: [
      "Planner output includes one to five nextRuns items unless the document is too small to split",
      "Every nextRuns item has a concrete goal and a prompt that tells its child planner what files or docs to inspect first",
      "Each child run has three to five doneWhen checks or a clear reason it needs another planner pass",
      "The split avoids overlapping ownership between child runs",
      "The generated runs can be supervised without manual run-id selection",
    ],
  });
  return { runId, taskId };
}

function intakePlannerPrompt(document: string) {
  return [
    "You are the portfolio planner for Ouroboros.",
    "",
    "Split the following requirement document into multiple executable Ouroboros runs.",
    "",
    "Return structured JSON with `status: \"done\"` and a `nextRuns` array.",
    "Use `nextRuns`, not `nextTasks`, when the work contains multiple independent goals or phases.",
    "Each nextRuns item must include:",
    "- `goal`: the child run goal",
    "- `prompt`: the initial planner prompt for that child run",
    "- `doneWhen`: three to five completion checks for the child run",
    "- optional `context`: small metadata such as phase, area, priority, or source",
    "- optional `modelPreference`",
    "",
    "For each child run prompt, instruct the child planner to create a small `nextTasks` graph with verifiers and repair paths.",
    "Keep child runs independent where possible so the global supervisor can run two or three runs at the same time.",
    "If the document is too small for multiple runs, create one nextRuns item rather than doing implementation in this intake run.",
    "",
    "Requirement document:",
    "```text",
    document,
    "```",
  ].join("\n");
}

async function runOverseerTick(input: {
  runId: string;
  eventLimit: number;
  interruptAttemptId: string | null;
  reason: string | null;
  followUpJson: string | null;
}) {
  try {
    const overview = harness.getRunOverview({ runId: input.runId, eventLimit: input.eventLimit });
    if (!overview.run) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: `Run not found: ${input.runId}`,
        problems: [`run not found: ${input.runId}`],
      });
    }

    const diagnosis = diagnoseRunOverview(overview);
    if (!input.interruptAttemptId) {
      return doneOverseerTick({
        runId: input.runId,
        summary: `Diagnosed run ${input.runId}.`,
        diagnosis,
      });
    }

    if (!input.reason || !input.followUpJson) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: "Missing overseer intervention arguments.",
        problems: [
          !input.reason ? "--reason is required when --interrupt-attempt is set" : null,
          !input.followUpJson ? "--follow-up-json is required when --interrupt-attempt is set" : null,
        ].filter((problem): problem is string => problem !== null),
      });
    }

    let followUpTask: Record<string, unknown>;
    try {
      followUpTask = parseJsonObject(input.followUpJson);
    } catch (error) {
      return blockedOverseerTick({
        runId: input.runId,
        summary: "Invalid overseer follow-up JSON.",
        problems: [cliErrorMessage(error)],
      });
    }

    const intervention = applyHarnessAction(harness, {
      type: "interruptAttemptAndCreateTask",
      attemptId: input.interruptAttemptId,
      reason: input.reason,
      followUpTask,
    });
    const refreshedOverview = harness.getRunOverview({ runId: input.runId, eventLimit: input.eventLimit });
    const refreshedDiagnosis = diagnoseRunOverview(refreshedOverview);

    return {
      ...intervention,
      runId: input.runId,
      diagnosis: refreshedDiagnosis,
      intervention,
    };
  } catch (error) {
    return blockedOverseerTick({
      runId: input.runId,
      summary: "Overseer tick failed.",
      problems: [cliErrorMessage(error)],
    });
  }
}

function doneOverseerTick(input: {
  runId: string;
  summary: string;
  diagnosis: ReturnType<typeof diagnoseRunOverview>;
}) {
  return {
    status: "done" as const,
    summary: input.summary,
    checks: [],
    artifacts: [],
    problems: [],
    runId: input.runId,
    diagnosis: input.diagnosis,
    intervention: null,
  };
}

function blockedOverseerTick(input: { runId: string; summary: string; problems: string[] }) {
  return {
    status: "blocked" as const,
    summary: input.summary,
    checks: [{ name: "overseer tick", status: "failed" as const, evidence: input.problems[0] ?? input.summary }],
    artifacts: [],
    problems: input.problems,
    runId: input.runId,
    diagnosis: null,
    intervention: null,
  };
}

function cliErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonObject(raw: string) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function createDashboardRuntime(input: {
  runId: string;
  port: number;
  defaultConcurrency?: number;
  defaultWorktreeRoot?: string;
  defaultStartHook?: string;
  defaultCodexBin?: string;
  supervisorCommandName?: "supervise-daemon" | "self-improve-daemon";
  defaultRootRunId?: string;
}) {
  let runnerProcess: ReturnType<typeof Bun.spawn> | null = null;
  let supervisorProcess: ReturnType<typeof Bun.spawn> | null = null;
  let runnerAutoPaused = false;
  const runnerState: {
    status: "idle" | "running" | "exited";
    pid: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    lastOutput: string;
  } = {
    status: "idle",
    pid: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastOutput: "",
  };
  const runnerStatus = () => ({ ...runnerState });
  const supervisorState: {
    status: "idle" | "running" | "exited";
    pid: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    lastOutput: string;
  } = {
    status: "idle",
    pid: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastOutput: "",
  };
  const supervisorStatus = () => ({ ...supervisorState });
  const appendRunnerOutput = (chunk: string) => {
    const next = `${runnerState.lastOutput}${chunk}`;
    runnerState.lastOutput = next.length > 2000 ? next.slice(next.length - 2000) : next;
  };
  const appendSupervisorOutput = (chunk: string) => {
    const next = `${supervisorState.lastOutput}${chunk}`;
    supervisorState.lastOutput = next.length > 2000 ? next.slice(next.length - 2000) : next;
  };
  const finishRunningAttemptsFromDashboard = (summary: string, problem: string) => {
    for (const attempt of harness.listRunningAttempts({ runId: input.runId })) {
      harness.finishAttempt({
        attemptId: attempt.id,
        output: {
          status: "blocked",
          summary,
          changedFiles: [],
          checks: [{ name: "dashboard runner", status: "failed" }],
          artifacts: [],
          problems: [problem],
        },
      });
      markAttemptThreadInterrupted(attempt.id, problem);
    }
    harness.updateRunStatus({ runId: input.runId, status: "todo" });
  };
  const startRunner = () => {
    runnerAutoPaused = false;
    if (runnerProcess && runnerState.status === "running") {
      return { status: "running", pid: runnerState.pid ?? undefined };
    }
    runnerState.status = "running";
    runnerState.startedAt = new Date().toISOString();
    runnerState.finishedAt = null;
    runnerState.exitCode = null;
    runnerState.lastOutput = "";
    const cmd = dashboardRunnerCommand(input.runId, {
      defaultConcurrency: input.defaultConcurrency,
      defaultWorktreeRoot: input.defaultWorktreeRoot,
      defaultStartHook: input.defaultStartHook,
      defaultCodexBin: input.defaultCodexBin,
    });
    runnerProcess = Bun.spawn({
      cmd,
      cwd: process.cwd(),
      env: childEnvForProcess(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    runnerState.pid = runnerProcess.pid;
    if (runnerProcess.stdout instanceof ReadableStream) {
      drainDashboardRunnerStream(runnerProcess.stdout, appendRunnerOutput);
    }
    if (runnerProcess.stderr instanceof ReadableStream) {
      drainDashboardRunnerStream(runnerProcess.stderr, appendRunnerOutput);
    }
    runnerProcess.exited.then((exitCode) => {
      runnerState.status = "exited";
      runnerState.finishedAt = new Date().toISOString();
      runnerState.exitCode = exitCode;
      runnerProcess = null;
    });
    return { status: "running", pid: runnerState.pid ?? undefined };
  };
  const startSupervisor = () => {
    if (supervisorProcess && supervisorState.status === "running") {
      return { status: "running", pid: supervisorState.pid ?? undefined };
    }
    supervisorState.status = "running";
    supervisorState.startedAt = new Date().toISOString();
    supervisorState.finishedAt = null;
    supervisorState.exitCode = null;
    supervisorState.lastOutput = "";
    const cmd = supervisorCommand({
      defaultConcurrency: input.defaultConcurrency,
      defaultWorktreeRoot: input.defaultWorktreeRoot,
      defaultStartHook: input.defaultStartHook,
      defaultCodexBin: input.defaultCodexBin,
      commandName: input.supervisorCommandName,
      rootRunId: input.defaultRootRunId,
    });
    supervisorProcess = Bun.spawn({
      cmd,
      cwd: process.cwd(),
      env: childEnvForProcess(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    supervisorState.pid = supervisorProcess.pid;
    if (supervisorProcess.stdout instanceof ReadableStream) {
      drainDashboardRunnerStream(supervisorProcess.stdout, appendSupervisorOutput);
    }
    if (supervisorProcess.stderr instanceof ReadableStream) {
      drainDashboardRunnerStream(supervisorProcess.stderr, appendSupervisorOutput);
    }
    supervisorProcess.exited.then((exitCode) => {
      supervisorState.status = "exited";
      supervisorState.finishedAt = new Date().toISOString();
      supervisorState.exitCode = exitCode;
      supervisorProcess = null;
    });
    return { status: "running", pid: supervisorState.pid ?? undefined };
  };
  const stopRunner = () => {
    runnerAutoPaused = true;
    const pid = runnerState.pid;
    if (runnerProcess && runnerState.status === "running") {
      if (pid) {
        terminateProcessTreeSync(pid);
      }
      runnerProcess.kill();
    }
    runnerProcess = null;
    runnerState.status = "exited";
    runnerState.finishedAt = new Date().toISOString();
    runnerState.exitCode = null;
    finishRunningAttemptsFromDashboard(
      "Stopped by the dashboard runner control",
      "dashboard stopped the runner process before it could finish cleanly",
    );
    return { status: "blocked", pid: pid ?? undefined };
  };
  const stopSupervisor = () => {
    const pid = supervisorState.pid;
    if (supervisorProcess && supervisorState.status === "running") {
      if (pid) {
        terminateProcessTreeSync(pid);
      }
      supervisorProcess.kill();
    }
    supervisorProcess = null;
    supervisorState.status = "exited";
    supervisorState.finishedAt = new Date().toISOString();
    supervisorState.exitCode = null;
    return { status: "stopped", pid: pid ?? undefined };
  };
  const resumeAutomaticRunner = () => {
    runnerAutoPaused = false;
  };
  const dashboardEventLimit = () => parsePositiveInteger(flag(parsed, "event-limit") ?? "25", "--event-limit");
  const childRunOverviews = () =>
    harness
      .listRuns({ limit: 500 })
      .filter((run) => run.id !== input.runId)
      .filter((run) => run.context.parentRunId === input.runId || run.context.rootRunId === input.runId)
      .map((run) => harness.getRunOverview({ runId: run.id, eventLimit: dashboardEventLimit() }));
  const recentRunsForDashboard = (limit: number) =>
    harness
      .listRuns({ limit: Math.max(1, Math.min(limit, 100)) })
      .slice()
      .sort((left, right) => {
        const leftCreated = left.createdAt ?? "";
        const rightCreated = right.createdAt ?? "";
        if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);
        return right.id.localeCompare(left.id);
      })
      .map((run) => ({
        id: run.id,
        status: run.status,
        goal: run.goal,
        projectId: run.projectId ?? null,
        createdAt: run.createdAt ?? null,
      }));
  const server = serveDashboard({
    runId: input.runId,
    port: input.port,
    overview: () =>
      harness.getRunOverview({
        runId: input.runId,
        eventLimit: dashboardEventLimit(),
      }),
    runOverview: (runId: string) =>
      harness.getRunOverview({
        runId,
        eventLimit: dashboardEventLimit(),
      }),
    childOverviews: childRunOverviews,
    recentRuns: recentRunsForDashboard,
    globalRunCounts: () => harness.countRunsByStatus(),
    runnerStatus,
    supervisorStatus,
    autoStartRunner: (overview, runner) => {
      if (flag(parsed, "disable-auto-runner") !== undefined) {
        return false;
      }
      if (runnerAutoPaused || overview.run?.status === "done" || runner?.status === "running") {
        return false;
      }
      if (harness.listRunningAttempts({ runId: input.runId }).length > 0) {
        return true;
      }
      return harness.nextReadyTask(input.runId) !== null;
    },
    renderTaskPrompt,
    actions: {
      startRunner,
      stopRunner,
      startSupervisor,
      stopSupervisor,
      createIntake: async (document, title) => {
        const result = await createIntakeRun({ title: title || compactForTitle(document, 80), document });
        startSupervisor();
        return { ...result, status: "todo" };
      },
      createGoal: (goal) => {
        resumeAutomaticRunner();
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        const taskId = createPlannerFromUserGoal({ runId: input.runId, goal, interrupted: false });
        return { taskId, status: "todo" };
      },
      interruptAndCreateGoal: (goal) => {
        resumeAutomaticRunner();
        const running = harness.listRunningAttempts({ runId: input.runId });
        if (running.length === 0) {
          harness.updateRunStatus({ runId: input.runId, status: "todo" });
          const taskId = createPlannerFromUserGoal({ runId: input.runId, goal, interrupted: true });
          return { taskId, status: "todo", interrupted: 0 };
        }
        const actionResult = applyHarnessAction(harness, {
          type: "interruptRunningAttemptsAndCreateTask",
          attemptIds: running.map((attempt) => attempt.id),
          reason: goal,
          followUpTask: createPlannerFollowUpTask(goal),
        });
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        const taskId = createdTaskIdFromActionResult(actionResult);
        return { taskId, status: "todo", interrupted: running.length };
      },
      resumeTask: (taskId) => {
        resumeAutomaticRunner();
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        harness.retryTask({ taskId });
        return { taskId, status: "todo" };
      },
      rerunTask: (taskId) => {
        resumeAutomaticRunner();
        const task = harness.getTask(taskId);
        if (!task) {
          fail(`task not found: ${taskId}`);
        }
        if (task.runId !== input.runId) {
          fail(`task does not belong to run: ${input.runId}`);
        }
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        harness.retryTask({ taskId });
        return { taskId, status: "todo" };
      },
      stopAttempt: (attemptId) => {
        runnerAutoPaused = true;
        const attempt = harness.getAttempt(attemptId);
        if (!attempt) {
          fail(`attempt not found: ${attemptId}`);
        }
        const task = harness.getTask(attempt.taskId);
        if (!task || task.runId !== input.runId) {
          fail(`attempt does not belong to run: ${input.runId}`);
        }
        const actionResult = applyHarnessAction(harness, {
          type: "interruptAttemptAndCreateTask",
          attemptId,
          reason: "user stopped the current task from the dashboard",
          followUpTask: createRepairFollowUpTask(task, "user stopped the current task from the dashboard"),
        });
        harness.updateRunStatus({ runId: input.runId, status: "todo" });
        return {
          attemptId,
          taskId: task.id,
          followUpTaskId: createdTaskIdFromActionResult(actionResult),
          status: "blocked",
        };
      },
      acceptGuardrailProposal: (proposalId, acceptedBy) => {
        const actionResult = applyHarnessAction(harness, {
          type: "acceptGuardrailProposal",
          runId: input.runId,
          proposalId,
          acceptedBy: acceptedBy || "dashboard",
          reason: "dashboard guardrail proposal accept control",
        });
        if (actionResult.status === "blocked") {
          fail(actionResult.problems.join("; ") || "guardrail proposal was not accepted");
        }
        return {
          runId: input.runId,
          status: actionResult.status,
          proposalId,
        };
      },
    },
    designStatus: (routeRunId: string) => buildDashboardDesignStatus(routeRunId),
    linearIntake: (routeRunId: string) => buildDashboardLinearIntakeLifecycleForRoute(routeRunId),
  });
  async function buildDashboardLinearIntakeLifecycleForRoute(routeRunId: string): Promise<DashboardLinearIntakeLifecycle | null> {
    if (!routeRunId) return null;
    let configured = false;
    try {
      const configSnapshot = await loadDashboardLinearConfig();
      const linearSection = readLinearConfigSection(configSnapshot);
      const resolution = resolveLinearPolling(linearSection);
      configured = resolution.enabled && Boolean(resolution.config);
    } catch {
      configured = false;
    }
    return buildDashboardLinearIntakeLifecycle({
      harness,
      rootRunId: routeRunId,
      configured,
      runner: runnerStatus(),
      supervisor: supervisorStatus(),
    });
  }
  let cachedDashboardLinearConfig: Record<string, unknown> | null = null;
  let cachedDashboardLinearConfigLoaded = false;
  async function loadDashboardLinearConfig(): Promise<Record<string, unknown>> {
    if (cachedDashboardLinearConfigLoaded) return cachedDashboardLinearConfig ?? {};
    cachedDashboardLinearConfigLoaded = true;
    try {
      const loaded = await loadCliConfig();
      cachedDashboardLinearConfig = loaded as Record<string, unknown>;
      return loaded as Record<string, unknown>;
    } catch {
      cachedDashboardLinearConfig = {};
      return {};
    }
  }
  function readLinearConfigSection(config: Record<string, unknown>): LinearConfig | undefined {
    const value = config.linear;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as LinearConfig)
      : undefined;
  }
  const shutdown = once(() => {
    stopRunner();
    stopSupervisor();
    server.stop();
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return {
    server,
    runnerStatus,
    supervisorStatus,
    startRunner,
    startSupervisor,
    stopRunner,
    shutdown,
  };
}

function threadIdForAttempt(attemptId: string) {
  return `thread_${attemptId}`;
}

function markAttemptThreadInterrupted(attemptId: string, reason: string) {
  harness.updateExecutionThread({
    id: threadIdForAttempt(attemptId),
    status: "interrupted",
    interruptReason: reason,
    heartbeat: true,
  });
}

function parseCodexResumableSandbox() {
  return parseSandbox(flag(parsed, "sandbox") ?? "workspace-write");
}

function parseStrategySignalClass(raw: string) {
  const allowed = ["user", "delivery", "technology", "market", "economics", "system"] as const;
  if (!allowed.includes(raw as (typeof allowed)[number])) {
    fail(`--class must be one of ${allowed.join(", ")}`);
  }
  return raw as (typeof allowed)[number];
}

function parseDesignOutcomeStage(raw: string) {
  const allowed = ["experiment", "release", "review"] as const;
  if (!allowed.includes(raw as (typeof allowed)[number])) {
    fail(`--stage must be one of ${allowed.join(", ")}`);
  }
  return raw as (typeof allowed)[number];
}

// Resolves the deterministic evaluation timestamp for list-design-outcomes.
// --due-before wins when provided. --status due falls back to the current UTC
// instant so the command can be used in operational automation without
// requiring the caller to format a timestamp. Returns null when neither input
// is set so the command lists every matching outcome without due filtering.
function resolveDesignOutcomeEvaluatedAt(
  dueBefore: string | undefined,
  status: string | undefined,
): string | null {
  if (dueBefore) {
    return requireStrictIsoTimestamp(dueBefore, "--due-before");
  }
  if (status === "due") {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}

interface ListDesignOutcomesRow {
  id: string;
  proposalId: string;
  stage: DesignOutcomeStage;
  recommendation: DesignOutcomeRecommendation;
  reviewAt: string | null;
  due: boolean;
  createdAt: string;
}

function formatListDesignOutcomes(input: {
  rows: ListDesignOutcomesRow[];
  evaluatedAt: string | null;
}): string {
  const lines: string[] = [];
  lines.push("Design outcome reviews");
  if (input.evaluatedAt) {
    lines.push(`Evaluated at: ${input.evaluatedAt}`);
  } else {
    lines.push("Evaluated at: not filtered (showing all matching outcomes)");
  }
  lines.push(`Total: ${input.rows.length}`);
  lines.push("");
  if (input.rows.length === 0) {
    lines.push("No matching design outcomes.");
    return lines.join("\n");
  }
  for (const row of input.rows) {
    const dueLabel = row.due ? "due" : "not-due";
    const reviewLabel = row.reviewAt ?? "no-review-time";
    lines.push(
      `${shortId(row.id)}  proposal=${shortId(row.proposalId)}  stage=${row.stage}  recommendation=${row.recommendation}  review_at=${reviewLabel}  ${dueLabel}`,
    );
  }
  return lines.join("\n");
}

function shortId(id: string) {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function resolveDesignProjectId(args: ReturnType<typeof parseArgs>) {
  const explicit = flag(args, "project-id");
  if (explicit) {
    return explicit;
  }
  const root = flag(args, "project-root");
  if (root) {
    return resolveProjectIdByRoot(root) ?? fail(`project not found for root: ${root}`);
  }
  const resolved = resolveImplicitDesignProjectId();
  if (!resolved) {
    fail("--project-id or --project-root is required outside a registered project root");
  }
  return resolved;
}

function resolveImplicitDesignProjectId() {
  if (!process.cwd()) {
    return null;
  }
  return resolveProjectIdByRoot(process.cwd());
}

function resolveProjectIdByRoot(rootPath: string) {
  const projects = harness.listProjects();
  const resolved = resolve(rootPath);
  const match = projects.find((project) => {
    try {
      return resolve(project.rootPath) === resolved;
    } catch {
      return false;
    }
  });
  return match?.id ?? null;
}

function loadCurrentDesignProposal(projectId: string | null) {
  if (!projectId) {
    return null;
  }
  const proposals = harness.listDesignProposals({
    projectId: projectId ?? undefined,
    statuses: ["proposed", "experimenting", "accepted", "implemented", "measuring"],
    limit: 100,
  });
  return proposals[0] ?? null;
}

function tallyDesignProposalStatuses(projectId: string | null) {
  const proposals = harness.listDesignProposals({ projectId: projectId ?? undefined, limit: 1000 });
  const counts: Record<string, number> = {};
  for (const proposal of proposals) {
    counts[proposal.status] = (counts[proposal.status] ?? 0) + 1;
  }
  return counts;
}

function designStatusJson(
  summary: ReturnType<typeof buildDesignStatus>,
  projectId: string,
) {
  return {
    projectId,
    charter: summary.charter,
    currentProposal: summary.currentProposal,
    latestDecision: summary.latestDecision,
    nextOutcomeReview: summary.nextOutcomeReview,
    recentOutcomes: summary.recentOutcomes,
    activeSignalCount: summary.activeSignalCount,
    proposalCountsByStatus: summary.proposalCountsByStatus,
  };
}

function buildDashboardDesignStatus(runId: string): DashboardDesignStatusSummary | null {
  const run = harness.getRun(runId);
  const projectId = run?.projectId ?? resolveImplicitDesignProjectId();
  if (!projectId) {
    return null;
  }
  const charter = harness.getActiveFounderCharter({ projectId });
  const proposals = harness.listDesignProposals({
    projectId,
    statuses: ["proposed", "experimenting", "accepted", "implemented", "measuring"],
    limit: 50,
  });
  const currentProposal = proposals[0] ?? null;
  const decisions = currentProposal
    ? harness.listDesignDecisions({ proposalId: currentProposal.id, limit: 50 })
    : [];
  const latestDecision = decisions.at(-1) ?? null;
  const outcomes = currentProposal
    ? harness
        .listDesignOutcomes({ proposalId: currentProposal.id, limit: 50 })
        .slice()
        .reverse()
    : [];
  const nextOutcomeReview = outcomes.find((outcome) => outcome.reviewAt) ?? null;
  const recentOutcomes = outcomes.slice(0, 5).map((outcome) => ({
    id: outcome.id,
    proposalId: outcome.proposalId,
    stage: outcome.stage,
    recommendation: outcome.recommendation,
    reviewAt: outcome.reviewAt,
    createdAt: outcome.createdAt,
  }));
  const recentSignals = harness
    .listStrategySignals({ projectId, statuses: ["active"], limit: 5 })
    .map((signal) => ({
      id: signal.id,
      signalClass: signal.signalClass,
      source: signal.source,
      title: signal.title,
      status: signal.status,
      confidence: signal.confidence,
      expiresAt: signal.expiresAt,
      observationTime: signal.observationTime,
    }));
  const proposalCountsByStatus = tallyDesignProposalStatuses(projectId);
  const timeline = buildDashboardDesignTimelineForCli(runId, projectId, currentProposal?.id ?? null);
  const summary: DashboardDesignStatusSummary = {
    projectId,
    charter: charter
      ? {
          ...charter,
          summary: {
            mission: charter.mission,
            version: charter.version,
            reviewCadenceDays: charter.charter.reviewCadenceDays,
          },
        }
      : null,
    currentProposal: currentProposal
      ? {
          ...currentProposal,
          summary: {
            title: currentProposal.title,
            status: currentProposal.status,
            recommendation: currentProposal.recommendation,
            reversibility: currentProposal.proposal.investment?.reversibility,
            portfolio: currentProposal.proposal.investment?.portfolio,
            nextReviewAt: currentProposal.proposal.evaluationContract?.reviewAt,
          },
        }
      : null,
    latestDecision: latestDecision
      ? {
          id: latestDecision.id,
          decision: latestDecision.decision,
          actorKind: latestDecision.actorKind,
          actorRef: latestDecision.actorRef,
          reasons: latestDecision.reasons,
          createdAt: latestDecision.createdAt,
        }
      : null,
    budget: charter?.charter.capitalPolicy
      ? {
          currency: charter.charter.capitalPolicy.currency,
          monthlyBudget: charter.charter.capitalPolicy.monthlyBudget,
          experimentBudget: charter.charter.capitalPolicy.experimentBudget,
          recurringSpendApprovalAbove: charter.charter.capitalPolicy.recurringSpendApprovalAbove,
          runwayFloorMonths: charter.charter.capitalPolicy.runwayFloorMonths,
          portfolio: charter.charter.capitalPolicy.portfolio,
        }
      : null,
    authority: charter?.charter.authority ?? null,
    nextOutcomeReview: nextOutcomeReview
      ? {
          id: nextOutcomeReview.id,
          proposalId: nextOutcomeReview.proposalId,
          stage: nextOutcomeReview.stage,
          recommendation: nextOutcomeReview.recommendation,
          reviewAt: nextOutcomeReview.reviewAt,
          createdAt: nextOutcomeReview.createdAt,
        }
      : null,
    recentOutcomes,
    recentSignals,
    proposalCountsByStatus,
    activeSignalCount: recentSignals.length === 0 ? 0 : harness.listStrategySignals({
      projectId,
      statuses: ["active"],
      limit: 1000,
    }).length,
    timeline,
  };
  return summary;
}

type DashboardDesignTimelineHarness = {
  getRunOverview(input: { runId: string; eventLimit?: number }): RunOverview;
  listExecutionThreads(input: { runId: string }): ExecutionThread[];
  listDesignDecisions(input: { proposalId: string; limit: number }): DesignDecision[];
  listDesignOutcomes(input: { proposalId: string; limit: number }): DesignOutcome[];
};

export function buildDashboardDesignTimelineForCli(
  runId: string,
  projectId: string,
  proposalId: string | null,
): DashboardDesignTimelineEntry[] {
  return buildDashboardDesignTimeline(runId, proposalId, harness as DashboardDesignTimelineHarness);
}

function applyCliPostAttemptRunEffects(runId: string, task: Pick<Task, "role">, output: AttemptOutput) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
    const completion = describeRunCompletionReadiness(harness.getRunOverview({ runId, eventLimit: 0 }));
    if (completion.blockers.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingVerificationTaskIds: completion.blockers.map((blocker) => blocker.taskId),
          pendingVerificationReason: completion.blockers.map((blocker) => blocker.reason).join("; "),
        },
      });
      return;
    }
    const readiness = describeIntegrationReadiness(harness, runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
        },
      });
    } else {
      harness.updateRunStatus({ runId, status: "done" });
    }
  }
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
  }
  if (task.role === "goal-review" && output.status === "done") {
    refreshGuardrailProposalsForRun({ harness, runId });
  }
}

function dashboardRunnerCommand(
  runId: string,
  options: {
    defaultConcurrency?: number;
    defaultWorktreeRoot?: string;
    defaultStartHook?: string;
    defaultCodexBin?: string;
  } = {},
) {
  const stopHook = flag(parsed, "stop-hook") ?? DEFAULT_STOP_HOOKS;
  const cmd = [
    Bun.argv[0],
    Bun.argv[1],
    "--db",
    parsed.db,
    "autopilot",
    "--run-id",
    runId,
    "--executor",
    "codex-resumable",
    "--stop-hook",
    stopHook,
  ];
  for (const name of [
    "limit",
    "concurrency",
    "tasks",
    "task-concurrency",
    "parallel",
    "max-rounds",
    "max-cycles",
    "max-tries",
    "interval-ms",
    "codex-bin",
    "sandbox",
    "timeout-ms",
    "idle-timeout-ms",
    "model",
    "cwd",
    "start-hook",
    "worktree-root",
  ]) {
    const value = flag(parsed, name);
    if (value !== undefined) {
      cmd.push(`--${name}`, value);
    }
  }
  if (
    firstFlag(["tasks", "task-concurrency", "concurrency", "limit", "parallel"]) === undefined &&
    options.defaultConcurrency
  ) {
    cmd.push("--tasks", String(options.defaultConcurrency));
  }
  if (flag(parsed, "worktree-root") === undefined && options.defaultWorktreeRoot && flag(parsed, "start-hook") !== "none") {
    cmd.push("--worktree-root", options.defaultWorktreeRoot);
  }
  if (flag(parsed, "start-hook") === undefined && options.defaultStartHook) {
    cmd.push("--start-hook", options.defaultStartHook);
  }
  if (flag(parsed, "codex-bin") === undefined && options.defaultCodexBin) {
    cmd.push("--codex-bin", options.defaultCodexBin);
  }
  return cmd;
}

function supervisorCommand(
  options: {
    defaultConcurrency?: number;
    defaultWorktreeRoot?: string;
    defaultStartHook?: string;
    defaultCodexBin?: string;
    commandName?: "supervise-daemon" | "self-improve-daemon";
    rootRunId?: string;
  } = {},
) {
  const stopHook = flag(parsed, "stop-hook") ?? DEFAULT_STOP_HOOKS;
  const selfImproveLaunch = options.commandName === "self-improve-daemon";
  const cmd = [
    selfImproveLaunch ? process.execPath : Bun.argv[0],
    selfImproveLaunch ? canonicalSelfIterationEntrypoint(resolve(runnerCwd())) : Bun.argv[1],
    "--db",
    parsed.db,
    options.commandName ?? "supervise-daemon",
    "--executor",
    "codex-resumable",
    "--stop-hook",
    stopHook,
  ];
  if (options.rootRunId) {
    cmd.push("--root-run-id", options.rootRunId);
  }
  for (const name of [
    "limit",
    "concurrency",
    "tasks",
    "task-concurrency",
    "runs",
    "run-concurrency",
    "parallel",
    "max-rounds",
    "max-cycles",
    "tick-cycles",
    "max-ticks",
    "max-tries",
    "interval-ms",
    "idle-ms",
    "codex-bin",
    "sandbox",
    "timeout-ms",
    "idle-timeout-ms",
    "model",
    "cwd",
    "start-hook",
    "worktree-root",
    "integration-target-branch",
    "no-integrate",
  ]) {
    const value = flag(parsed, name);
    if (value !== undefined) {
      cmd.push(`--${name}`, value);
    }
  }
  if (
    firstFlag(["tasks", "task-concurrency", "concurrency", "limit", "parallel"]) === undefined &&
    options.defaultConcurrency
  ) {
    cmd.push("--tasks", String(options.defaultConcurrency));
  }
  if (flag(parsed, "worktree-root") === undefined && options.defaultWorktreeRoot && flag(parsed, "start-hook") !== "none") {
    cmd.push("--worktree-root", options.defaultWorktreeRoot);
  }
  if (flag(parsed, "start-hook") === undefined && options.defaultStartHook) {
    cmd.push("--start-hook", options.defaultStartHook);
  }
  if (flag(parsed, "codex-bin") === undefined && options.defaultCodexBin) {
    cmd.push("--codex-bin", options.defaultCodexBin);
  }
  return cmd;
}

function drainDashboardRunnerStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const decoder = new TextDecoder();
  void (async () => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        onChunk(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) {
        onChunk(tail);
      }
    } catch (error) {
      onChunk(`\nrunner stream read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  })();
}

function parsePositiveInteger(raw: string, name: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function parseRunConcurrency() {
  return parseConcurrencyValue({
    names: ["runs", "run-concurrency"],
    fallback: parallelModeIsAuto() ? "auto" : "2",
    autoValue: autoRunConcurrency(),
    displayName: "--runs",
  });
}

function parseTaskConcurrency() {
  return parseConcurrencyValue({
    names: ["tasks", "task-concurrency", "concurrency", "limit"],
    fallback: parallelModeIsAuto() ? "auto" : "1",
    autoValue: autoTaskConcurrency(),
    displayName: "--tasks",
  });
}

function parseConcurrencyValue(input: { names: string[]; fallback: string; autoValue: number; displayName: string }) {
  const raw = firstFlag(input.names) ?? input.fallback;
  if (raw === "auto") {
    return input.autoValue;
  }
  return parsePositiveInteger(raw, input.displayName);
}

function firstFlag(names: string[]) {
  for (const name of names) {
    const value = flag(parsed, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parallelModeIsAuto() {
  const value = flag(parsed, "parallel");
  if (value === undefined) return false;
  if (value !== "auto") {
    fail("--parallel currently supports auto");
  }
  return true;
}

function autoTaskConcurrency() {
  const override = process.env.ORBS_AUTO_TASK_CONCURRENCY;
  if (override !== undefined) {
    return parsePositiveInteger(override, "ORBS_AUTO_TASK_CONCURRENCY");
  }
  const cpuCount = cpus().length || 1;
  const cpuSlots = cpuCount >= 12 ? 4 : cpuCount >= 8 ? 3 : cpuCount >= 4 ? 2 : 1;
  const memoryGiB = totalmem() / 1024 / 1024 / 1024;
  const memorySlots = memoryGiB >= 24 ? 4 : memoryGiB >= 12 ? 3 : memoryGiB >= 6 ? 2 : 1;
  return Math.max(1, Math.min(AUTO_MAX_TASK_CONCURRENCY, cpuSlots, memorySlots));
}

function autoRunConcurrency() {
  const override = process.env.ORBS_AUTO_RUN_CONCURRENCY;
  if (override !== undefined) {
    return parsePositiveInteger(override, "ORBS_AUTO_RUN_CONCURRENCY");
  }
  return Math.max(1, Math.min(AUTO_MAX_RUN_CONCURRENCY, Math.ceil(autoTaskConcurrency() / 2)));
}

function parseNonNegativeInteger(raw: string, name: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
}

function runnerCwd() {
  return flag(parsed, "cwd") ?? process.cwd();
}

function worktreeForTask() {
  const root = flag(parsed, "worktree-root");
  if (!root) {
    return undefined;
  }
  return (task: Task) => {
    const sourceWorktreePath = task.config?.sourceWorktreePath;
    if (typeof sourceWorktreePath === "string" && sourceWorktreePath.trim().length > 0) {
      return sourceWorktreePath;
    }
    if (task.worktreePath) {
      return task.worktreePath;
    }
    const projectRoot = harness.getRun(task.runId)?.projectRoot;
    return projectRoot
      ? join(projectRoot, ".ouroboros", "worktrees", task.id)
      : join(root, task.id);
  };
}

function stopHooksByRole(defaultRaw?: string) {
  const raw = flag(parsed, "stop-hook") ?? defaultRaw;
  const taskCreationHook = createTasksFromOutputHook({ harness });
  const runCreationHook = createRunsFromOutputHook({ harness });
  const applyDesignActionsHook = createApplyDesignActionsHook({ harness });
  const goalReviewDecisionHook = createGoalReviewDecisionHook({ harness });
  const refreshGuardrailProposalsHook = createRefreshGuardrailProposalsHook({ harness });
  const collectSubsessionsHook = createCollectSubsessionsHook({ harness, subsessionRunner: createAcpxSubsessionRunner() });
  const hooks = {
    planner: [collectSubsessionsHook, applyDesignActionsHook],
    worker: [collectSubsessionsHook],
    verifier: [collectSubsessionsHook],
    "goal-review": [goalReviewDecisionHook, taskCreationHook, refreshGuardrailProposalsHook, collectSubsessionsHook, applyDesignActionsHook],
    designer: [applyDesignActionsHook, collectSubsessionsHook],
    "outcome-review": [applyDesignActionsHook, collectSubsessionsHook],
  } as Record<string, StopHook[]>;
  if (!raw) {
    return hooks;
  }
  for (const hook of raw.split(",")) {
    if (hook === "create-runs") {
      hooks.planner.splice(Math.max(0, hooks.planner.length - 1), 0, runCreationHook);
      continue;
    }
    if (hook === "create-tasks") {
      hooks.planner.splice(Math.max(0, hooks.planner.length - 1), 0, taskCreationHook);
      continue;
    }
    if (hook === "create-verifier") {
      hooks.worker.splice(Math.max(0, hooks.worker.length - 1), 0, createVerifierTaskHook({ harness }));
      continue;
    }
    if (hook === "create-repair") {
      hooks.verifier.splice(Math.max(0, hooks.verifier.length - 1), 0, createRepairTaskHook({ harness }));
      continue;
    }
    if (hook === "apply-design-actions") {
      continue;
    }
    if (hook === "context-summary" || hook === "context-subagent") {
      hooks.verifier.splice(Math.max(0, hooks.verifier.length - 1), 0, createContextSummaryHook());
      continue;
    }
    fail("--stop-hook must contain create-runs, create-tasks, create-verifier, create-repair, apply-design-actions, or context-summary");
  }
  return hooks;
}

function startHooks() {
  const hook = flag(parsed, "start-hook");
  if (!hook) {
    return [];
  }
  if (hook === "none") {
    return [];
  }
  if (hook !== "git-worktree") {
    fail("--start-hook must be git-worktree or none");
  }
  if (!flag(parsed, "worktree-root")) {
    fail("--start-hook git-worktree requires --worktree-root");
  }
  return [
    createGitWorktreeHook({
      repoPath: runnerCwd(),
      baseRef: flag(parsed, "git-base-ref") ?? "main",
    }),
  ];
}

function genericIdleTimeoutMs() {
  return parseTimeoutMs(flag(parsed, "idle-timeout-ms"), "--idle-timeout-ms") ?? DEFAULT_GENERIC_ATTEMPT_IDLE_TIMEOUT_MS;
}

function genericHardTimeoutMs() {
  return parseTimeoutMs(flag(parsed, "timeout-ms")) ?? DEFAULT_GENERIC_ATTEMPT_HARD_TIMEOUT_MS;
}

function parseTimeoutMs(raw: string | undefined, name = "--timeout-ms") {
  if (raw === undefined) {
    return undefined;
  }
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    fail(`${name} must be a positive integer`);
  }
  return timeoutMs;
}
