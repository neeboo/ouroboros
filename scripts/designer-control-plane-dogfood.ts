/**
 * Bounded dogfood for slice 7 of the Designer Control Plane.
 *
 * Demonstrates four required scenarios through the production transition
 * coordinator (no manual authority evaluation, decision recording, or status
 * mutation by this script):
 *  (A) Evidence-backed proposal: recordSignal + proposeDesign through the
 *      fixed Designer actions hook. The hook itself runs evaluateAuthority,
 *      records the approved decision, and transitions the proposal to
 *      `accepted` when the content is low-risk.
 *  (B) Accepted low-risk proposal creates a child planner run with the frozen
 *      evaluation contract and inherited design context, using only the
 *      createRunsFromDesign action.
 *  (C) High-risk proposal that has not passed its authority gate cannot
 *      create child runs through `createRunsFromDesign`; the production
 *      adapter's keyword matcher routes it to a human-required checkpoint
 *      with no delivery run.
 *  (D) Quiescence: when the Designer returns no design actions, the hook
 *      returns `decision: "exit"` without writing anything — silence is a
 *      valid, durable answer when evidence does not justify new work.
 *
 * The script prints run-overview and list-lessons style evidence for the
 * dogfood child run so the inherited frozen contract and planner graph can
 * be inspected after the cycle drains.
 *
 * This script uses a temporary on-disk database. It exits with status 1 if
 * any assertion fails so it can be wired into local smoke checks.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../packages/harness/src/harness";
import { createApplyDesignActionsHook } from "../packages/runner/src/hooks/apply-design-actions";
import type {
  AttemptOutput,
  DesignProposal,
} from "../packages/harness/src/types";
import type { StopHookInput, StopHookResult } from "../packages/runner/src/types";

const ACTIVE_CHARTER = {
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
    "Automatic charter amendments without human activation",
    "Production deployment, billing, or purchasing without a human checkpoint",
  ],
  constraints: [
    "Mission, capital limits, legal or privacy obligations, destructive operations, production deployment, schema migrations, unplanned dependencies, and recurring infrastructure commitments require a human checkpoint",
    "Recurring spend defaults to a zero threshold until a human raises it",
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
    requireHumanFor: [
      "mission-amendment",
      "capital-policy-amendment",
      "legal-or-privacy",
      "sensitive-data",
      "destructive-operation",
      "production-deployment",
      "unplanned-dependency",
      "schema-migration",
      "recurring-infrastructure",
    ],
  },
  reviewCadenceDays: 30,
};

interface Scenario {
  name: string;
  ok: boolean;
  details: string;
}

const results: Scenario[] = [];

// Representative frozen control context the root run seeds and every child
// planner run must inherit byte-for-byte. These fields mirror a real
// Designer control-plane run: goal budget, model routing, agent routing,
// the authenticated agent backends, the integration boundary, the goal
// contract, learned guardrails, and the pinned founder charter. The
// production hook's inheritedControlContext copies each of them from the
// parent run into the child, so seeding them here lets the dogfood prove
// the inheritance is durable end-to-end.
function buildRootRunContext(charterId: string): Record<string, unknown> {
  return {
    modelDefaults: {
      global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
      roles: {
        planner: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        worker: { model: "gpt-5.6-luna", reasoning_effort: "high" },
        verifier: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        "goal-review": { model: "gpt-5.6-sol", reasoning_effort: "high" },
      },
    },
    agentDefaults: {
      global: "claude-code",
      roles: {
        designer: "codex-resumable",
        planner: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
        "outcome-review": "codex-resumable",
      },
    },
    agentBackends: {
      "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
      "codex-resumable": { kind: "codex-resumable" },
    },
    integrationBoundary: {
      targetBranch: "main",
      push: false,
      allowedFiles: [
        "packages/runner/",
        "packages/harness/",
        "packages/cli/",
        "tests/",
        "docs/",
        "scripts/designer-control-plane-dogfood.ts",
      ],
      forbiddenPaths: [
        ".git/orbs/",
        ".ouroboros/",
        "ouroboros.toml",
        ".linear",
        "package.json",
        "bun.lock",
      ],
    },
    goalContract: {
      desiredState:
        "A Designer cycle drains through the existing fixed actions to exactly one evidence-backed child planner run, a recorded human checkpoint, or mutation-free quiescence.",
      successCriteria: [
        "A low-risk current signal drains through proposal, automatic approved decision, accepted status, and exactly one child planner run",
        "A high-risk or ambiguous proposal creates no delivery run and records an auditable checkpoint",
        "A no-action Designer result remains mutation-free and quiescent",
      ],
      budget: { maxRounds: 12, maxAttemptsPerTask: 3 },
    },
    guardrails: [
      {
        id: "guardrail_exit_code_1_stderr_error_no_such_file_or_directory_os_error_2",
        summary: "exit code: 1 stderr: Error: No such file or directory (os error 2)",
        active: false,
        accepted: false,
        source: "lesson",
        roles: ["*"],
      },
    ],
    founderCharterId: charterId,
  };
}

function record(name: string, ok: boolean, details: string) {
  results.push({ name, ok, details });
  const marker = ok ? "PASS" : "FAIL";
  console.log(`[${marker}] ${name}: ${details}`);
}

// Deep equality for the JSON-serializable control-context values. The child
// run inherits these via JSON round-trip through the strategy database, so a
// canonical JSON comparison reliably detects any field the hook dropped or a
// worker/verifier weakened.
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function summarizeChildRunInheritedContext(childRunId: string): Record<string, unknown> | null {
  const run = harness.getRun(childRunId);
  if (!run) return null;
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  return {
    runId: childRunId,
    parentRunId: ctx.parentRunId ?? null,
    sourceTaskId: ctx.sourceTaskId ?? null,
    source: ctx.source ?? null,
    designProposalId: ctx.designProposalId ?? null,
    designCharterId: ctx.designCharterId ?? null,
    designDecisionId: ctx.designDecisionId ?? null,
    inheritedModelDefaults: Boolean(ctx.modelDefaults),
    inheritedAgentDefaults: Boolean(ctx.agentDefaults),
    inheritedAgentBackends: Boolean(ctx.agentBackends),
    inheritedIntegrationBoundary: Boolean(ctx.integrationBoundary),
    inheritedGoalContract: Boolean(ctx.goalContract),
    inheritedGuardrails: Boolean(ctx.guardrails),
    inheritedFounderCharterId: Boolean(ctx.founderCharterId),
    designEvaluationContractKeys: Object.keys((ctx.designEvaluationContract as Record<string, unknown> | undefined) ?? {}),
    designProposalTitle: ((ctx.designProposal as { title?: string } | undefined))?.title ?? null,
    designApprovalAuthority: ((ctx.designApprovalAuthority as { decision?: string; actorKind?: string } | undefined)) ?? null,
  };
}

function printRunOverview(runId: string, label: string) {
  const overview = harness.getRunOverview({ runId, eventLimit: 25 });
  console.log("");
  console.log(`--- run-overview (${label}) runId=${runId} ---`);
  console.log(JSON.stringify(overview, null, 2));
}

function printRunLessons(runId: string, label: string) {
  const lessons = harness.listLessons({ runId });
  console.log("");
  console.log(`--- list-lessons (${label}) runId=${runId} count=${lessons.length} ---`);
  console.log(JSON.stringify(lessons, null, 2));
}

const harnessDir = await mkdtemp(join(tmpdir(), "ouroboros-designer-dogfood-"));
const dbPath = join(harnessDir, "ouroboros.db");
const harness = new Harness(dbPath);
harness.init();

try {
  await runDogfood();
} finally {
  await rm(harnessDir, { recursive: true, force: true });
}

async function runDogfood() {
  const projectId = harness.createProject({
    name: "Designer Dogfood",
    rootPath: process.cwd(),
  });
  if (!projectId) {
    throw new Error("createProject returned an empty project id");
  }

  const charter = harness.createFounderCharter({
    projectId,
    mission: ACTIVE_CHARTER.mission,
    charter: ACTIVE_CHARTER,
    activate: true,
  });

  if (!charter.isActive) {
    record("charter activation", false, "createFounderCharter did not activate the charter");
  } else {
    record(
      "charter activation",
      true,
      `v${charter.version} active for project ${charter.projectId}`,
    );
  }
  if (charter.projectId !== projectId) {
    record(
      "charter project linkage",
      false,
      `expected projectId ${projectId}, got ${charter.projectId}`,
    );
  } else {
    record("charter project linkage", true, `projectId=${projectId}`);
  }

  const rootRunId = harness.createRun({
    goal: "Designer control plane dogfood",
    projectId,
    context: buildRootRunContext(charter.id),
  });
  if (!rootRunId) {
    throw new Error("createRun returned an empty run id");
  }

  const designerTaskId = harness.createTask({
    runId: rootRunId,
    role: "designer",
    goal: "Run a designer cycle that emits a proposal or quiescent decision",
    prompt: "Inspect repo and propose (or quiesce).",
  });
  if (!designerTaskId) {
    throw new Error("createTask returned an empty task id");
  }

  const designActionsHook = createApplyDesignActionsHook({ harness });

  function runDesignActions(output: AttemptOutput, taskId: string = designerTaskId): StopHookResult {
    const overview = harness.getRunOverview({ runId: rootRunId, eventLimit: 0 });
    if (!overview.run) {
      throw new Error(`root run ${rootRunId} not found`);
    }
    const task = harness.getTask(taskId);
    if (!task) {
      throw new Error(`designer task ${taskId} not found`);
    }
    const hookInput: StopHookInput = {
      run: overview.run,
      task,
      sessionName: "designer-dogfood",
      prompt: "Inspect repo and propose (or quiesce).",
      output,
    };
    return designActionsHook(hookInput) as StopHookResult;
  }

  function createDesignerTask(goal: string): string {
    const taskId = harness.createTask({
      runId: rootRunId,
      role: "designer",
      goal,
      prompt: goal,
    });
    if (!taskId) {
      throw new Error("createTask returned an empty task id");
    }
    return taskId;
  }

  // ----------------------------------------------------------------------------
  // Scenario A: evidence-backed proposal (recordSignal + proposeDesign).
  // ----------------------------------------------------------------------------

  const signalOnlyOutput: AttemptOutput = {
    status: "done",
    summary: "Designer recorded a delivery signal.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "recordSignal",
        payload: {
          projectId,
          signalClass: "delivery",
          source: "dogfood-2026-08-02",
          title: "Idle timeout false positive under slow first chunk",
          summary:
            "Worker attempts report exit 124 when first output arrives after idle window even though the agent is healthy.",
          confidence: 0.7,
          observationTime: "2026-08-02T00:00:00Z",
          expiresAt: "2026-12-01T00:00:00Z",
          evidence: ["attempt_dogfood"],
          payload: {},
        },
      },
    ],
  };
  const signalResult = runDesignActions(signalOnlyOutput);
  if (signalResult.problems && signalResult.problems.length > 0) {
    record(
      "scenario A: record signal hook",
      false,
      `unexpected problems: ${signalResult.problems.join(" | ")}`,
    );
  } else {
    record("scenario A: record signal hook", true, "no problems");
  }

  const signalsList = harness.listStrategySignals({ projectId });
  const signal = signalsList[0];
  if (!signal) {
    record("scenario A: record signal", false, "no strategy signal recorded");
    throw new Error("scenario A signal missing; cannot continue");
  }
  record(
    "scenario A: record signal",
    true,
    `${signal.id} class=${signal.signalClass} status=${signal.status} projectId=${signal.projectId}`,
  );

  const proposeOutput: AttemptOutput = {
    status: "done",
    summary: "Designer emitted a low-risk proposal anchored to the recorded signal.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "proposeDesign",
        payload: {
          projectId,
          charterId: charter.id,
          title: "Defer initial idle deadline until first output chunk",
          proposal: {
            problem:
              "Worker attempts report exit 124 when the first output chunk arrives after the idle window.",
            targetOutcome:
              "Attempts that produce first output within the configured grace window are not killed by the idle timeout.",
            evidenceRefs: [signal.id],
            options: [
              {
                name: "Initial grace window before idle timeout",
                benefits: ["Removes the false positive"],
                costs: ["One runner config knob"],
                risks: ["A bad agent could run longer before being killed"],
                lockIn: ["Runner owns idle-window semantics"],
              },
            ],
            recommendation: "Initial grace window before idle timeout",
            additions: ["Runner config: idleInitialGraceMs"],
            removals: [],
            assumptions: ["Workers that produce no output for >60s are silent starts"],
            uncertainty: [],
            evaluationContract: {
              baseline: ["Self-iteration run 2026-08-01: 4 attempts exited 124 with empty event stream"],
              successMetrics: ["Attempts that produce first output within 60s no longer hit exit 124"],
              guardMetrics: ["Wall-clock timeout still bounds total runtime"],
              requiredEvidence: [
                "Replay of failing attempts passes with grace window",
                "New unit test covers grace-not-yet-expired path",
              ],
              reviewAt: "2026-09-15",
            },
            investment: {
              reversibility: "easy",
              portfolio: "core",
              oneTimeCost: 0,
              recurringCost: 0,
              timeBudget: "1 day",
            },
            experiment: {
              hypothesis: "False-positive exit 124 disappears when first-output grace is honored",
              smallestTest: "Replay two prior failing attempts and confirm pass",
              stopConditions: ["Any silent-start attempt runs past idle timeout + grace"],
              rollback: "git revert the runner change",
            },
          },
          status: "proposed",
        },
      },
    ],
  };
  const proposeResult = runDesignActions(proposeOutput);
  if (proposeResult.problems && proposeResult.problems.length > 0) {
    record(
      "scenario A: propose design hook",
      false,
      `unexpected problems: ${proposeResult.problems.join(" | ")}`,
    );
  } else {
    record("scenario A: propose design hook", true, "no problems");
  }

  const proposalList = harness.listDesignProposals({ projectId });
  const lowRiskProposal = proposalList.find(
    (proposal) => proposal.title === "Defer initial idle deadline until first output chunk",
  );
  if (!lowRiskProposal) {
    record("scenario A: propose design", false, "no design proposal recorded");
    throw new Error("scenario A proposal missing; cannot continue");
  }
  record(
    "scenario A: propose design",
    true,
    `${lowRiskProposal.id} status=${lowRiskProposal.status} refs=${lowRiskProposal.proposal.evidenceRefs?.length ?? 0}`,
  );

  // ----------------------------------------------------------------------------
  // Scenario B: the proposeDesign hook itself coordinates the transition —
  // it must run evaluateAuthority, record the approved decision, and transition
  // the proposal to `accepted`. This script performs NONE of those steps
  // manually; it only verifies the production coordinator's durable outcome.
  // ----------------------------------------------------------------------------

  const lowRiskProposalFresh = harness.listDesignProposals({ projectId }).find(
    (proposal) => proposal.id === lowRiskProposal.id,
  ) as DesignProposal | undefined;
  if (!lowRiskProposalFresh) {
    record("scenario B: proposeDesign production coordinator", false, "proposal missing before status check");
    throw new Error("scenario B proposal missing");
  }
  const lowRiskDecisions = harness.listDesignDecisions({ proposalId: lowRiskProposalFresh.id });
  const autoApproved = lowRiskDecisions.find(
    (decision) => decision.decision === "approved" && decision.actorKind === "auto",
  );
  const autoApprovedDisposition = (autoApproved?.authority as { disposition?: string } | undefined)?.disposition ?? "<none>";
  const coordinatorPassed =
    lowRiskProposalFresh.status === "accepted" &&
    Boolean(autoApproved) &&
    autoApprovedDisposition === "automatic";
  record(
    "scenario B: proposeDesign production coordinator",
    coordinatorPassed,
    `status=${lowRiskProposalFresh.status} decision=${autoApproved?.id ?? "<none>"} disposition=${autoApprovedDisposition}`,
  );

  const createRunsOutput: AttemptOutput = {
    status: "done",
    summary: "Spawn child planner run from accepted proposal.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "createRunsFromDesign",
        payload: {
          proposalId: lowRiskProposal.id,
          runs: [
            {
              goal: "Plan initial-grace runner change",
              prompt: "Sharpen the task graph and verifier contract for the idle-grace change.",
              doneWhen: [
                "Planner returns a small nextTasks graph for this run",
                "Every generated task honors the frozen design evaluation contract",
              ],
            },
          ],
        },
      },
    ],
  };
  const createRunsHookResult = runDesignActions(createRunsOutput);
  const createdRunArtifact = (createRunsHookResult.artifacts ?? []).find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "kind" in entry &&
      entry.kind === "created_run",
  );
  if (!createdRunArtifact) {
    record(
      "scenario B: createRunsFromDesign",
      false,
      `expected one created_run artifact; problems=${createRunsHookResult.problems?.join(" | ") ?? "<none>"}`,
    );
  } else {
    const artifact = createdRunArtifact as {
      runId: string;
      plannerTaskId: string;
      proposalId: string;
    };
    const childRun = harness.getRunOverview({ runId: artifact.runId, eventLimit: 0 }).run;
    if (!childRun) {
      record(
        "scenario B: createRunsFromDesign",
        false,
        `child run ${artifact.runId} not found`,
      );
      throw new Error(`child run ${artifact.runId} not found`);
    }
    const inheritsProposal = childRun.context?.designProposalId === lowRiskProposal.id;
    const inheritsFrozenContract = Boolean(childRun.context?.designEvaluationContract);
    const inheritsDesignProposal = Boolean(childRun.context?.designProposal);
    const inheritsCharter = Boolean(childRun.context?.designCharterId);
    const inheritsDecision = Boolean(childRun.context?.designDecisionId);
    const inheritsApprovalAuthority = Boolean(childRun.context?.designApprovalAuthority);
    const inheritedSummary = summarizeChildRunInheritedContext(artifact.runId);
    record(
      "scenario B: createRunsFromDesign",
      inheritsProposal && inheritsFrozenContract && inheritsDesignProposal && inheritsCharter && inheritsDecision && inheritsApprovalAuthority,
      `childRun=${artifact.runId} planner=${artifact.plannerTaskId} inheritsProposal=${inheritsProposal} inheritsContract=${inheritsFrozenContract} inheritsProposalEnvelope=${inheritsDesignProposal} inheritsCharter=${inheritsCharter} inheritsDecision=${inheritsDecision} inheritsApprovalAuthority=${inheritsApprovalAuthority}`,
    );

    // The child planner run must inherit the frozen control context the root
    // run seeded: goal budget, model routing, agent routing, agent backends,
    // the integration boundary, learned guardrails, and the pinned founder
    // charter. Each is copied byte-for-byte by the production hook's
    // inheritedControlContext, so deep-equality proves workers and verifiers
    // cannot weaken the frozen envelope.
    const childCtx = (childRun.context ?? {}) as Record<string, unknown>;
    const rootContext = buildRootRunContext(charter.id);
    const inheritedControlFields = [
      "modelDefaults",
      "agentDefaults",
      "agentBackends",
      "integrationBoundary",
      "goalContract",
      "guardrails",
      "founderCharterId",
    ] as const;
    const missingControlFields = inheritedControlFields.filter(
      (field) => childCtx[field] === undefined,
    );
    const weakenedControlFields = inheritedControlFields.filter(
      (field) => childCtx[field] !== undefined && !deepEqual(childCtx[field], rootContext[field]),
    );
    const inheritedControlsOk =
      missingControlFields.length === 0 && weakenedControlFields.length === 0;
    record(
      "scenario B: child run inherits frozen control context",
      inheritedControlsOk,
      `modelDefaults=${Boolean(childCtx.modelDefaults)} agentDefaults=${Boolean(childCtx.agentDefaults)} agentBackends=${Boolean(childCtx.agentBackends)} integrationBoundary=${Boolean(childCtx.integrationBoundary)} goalContract=${Boolean(childCtx.goalContract)} guardrails=${Boolean(childCtx.guardrails)} founderCharterId=${childCtx.founderCharterId ?? "<none>"} missing=${missingControlFields.join(",") || "<none>"} weakened=${weakenedControlFields.join(",") || "<none>"}`,
    );

    // Print run-overview and list-lessons evidence for the dogfood child run
    // so the inherited frozen contract and planner graph can be inspected.
    printRunOverview(artifact.runId, "child planner run");
    printRunLessons(artifact.runId, "child planner run");
    console.log("");
    console.log(`--- inherited-context summary for child run ${artifact.runId} ---`);
    console.log(JSON.stringify(inheritedSummary, null, 2));
  }

  // ----------------------------------------------------------------------------
  // Scenario C: high-risk proposal cannot create runs without approval.
  // The production transition coordinator must (a) record the proposal with
  // status `proposed`, (b) emit a human-required checkpoint decision via the
  // keyword-aware risk surface derivation, and (c) leave no continuation or
  // child run. This script does not call evaluateAuthority directly.
  // ----------------------------------------------------------------------------

  // Use a distinct designer task for scenario C: the audit-log identity for
  // proposeDesign is keyed on (actionType, runId, taskId, actionIndex). A
  // fresh task prevents the hook from replaying scenario A's accepted result.
  const highRiskDesignerTaskId = createDesignerTask("Designer cycle for high-risk managed-Postgres proposal");

  const highRiskProposeOutput: AttemptOutput = {
    status: "done",
    summary: "Designer proposed a high-risk managed-Postgres migration.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "proposeDesign",
        payload: {
          projectId,
          charterId: charter.id,
          title: "Move Ouroboros control plane to managed cloud Postgres",
          proposal: {
            problem: "Local SQLite limits cross-machine collaboration.",
            targetOutcome: "Multiple operators share one Ouroboros database.",
            evidenceRefs: [signal.id],
            options: [
              {
                name: "Managed cloud Postgres",
                benefits: ["Shared state"],
                costs: ["Recurring monthly spend", "New privacy obligations"],
                risks: ["Production deployment", "Recurring infrastructure commitment"],
                lockIn: ["Cloud vendor lock-in"],
              },
            ],
            recommendation: "Provision managed Postgres and migrate the harness schema.",
            additions: ["Cloud Postgres provider", "Schema migration tooling"],
            removals: [],
            assumptions: ["Single SQLite database is the bottleneck"],
            uncertainty: [],
            evaluationContract: {
              baseline: ["Single-user SQLite today"],
              successMetrics: ["Multiple operators can collaborate"],
              guardMetrics: ["No data loss"],
              requiredEvidence: ["Migration dry-run passes", "Cost projection within budget"],
              reviewAt: "2026-12-01",
            },
            investment: {
              reversibility: "hard",
              portfolio: "growth",
              // Costs kept within the dogfood charter's experiment budget
              // (experimentBudget=100, recurringSpendApprovalAbove=0) so the
              // proposal routes to a human-required checkpoint via reversibility
              // and risk keywords rather than being rejected for budget overrun.
              oneTimeCost: 50,
              recurringCost: 0,
              timeBudget: "2 weeks",
            },
            experiment: {
              hypothesis: "Managed Postgres unlocks multi-operator collaboration",
              smallestTest: "Provision a managed instance and migrate a copy",
              stopConditions: ["Any data loss", "Cost projection exceeds charter budget"],
              rollback: "Decommission the managed instance and restore SQLite",
            },
          },
          status: "proposed",
        },
      },
    ],
  };
  const highRiskProposeResult = runDesignActions(highRiskProposeOutput, highRiskDesignerTaskId);
  const highRiskProblems = highRiskProposeResult.problems ?? [];
  if (highRiskProblems.length > 0) {
    record(
      "scenario C: proposeDesign production coordinator",
      false,
      `unexpected problems: ${highRiskProblems.join(" | ")}`,
    );
  }

  const highRiskProposal = harness
    .listDesignProposals({ projectId })
    .find((proposal) => proposal.title === "Move Ouroboros control plane to managed cloud Postgres");
  if (!highRiskProposal) {
    record("scenario C: high-risk proposeDesign recorded", false, "no high-risk proposal recorded");
    throw new Error("scenario C proposal missing");
  }
  const highRiskDecisions = harness.listDesignDecisions({ proposalId: highRiskProposal.id });
  const highRiskCheckpoint = highRiskDecisions.find((decision) => decision.decision === "deferred");
  const highRiskAuthorityDisposition = (highRiskCheckpoint?.authority as { disposition?: string } | undefined)?.disposition;
  const highRiskCoordinatorPassed =
    highRiskProposal.status === "proposed" &&
    Boolean(highRiskCheckpoint) &&
    highRiskAuthorityDisposition === "human-required";
  record(
    "scenario C: high-risk proposeDesign production coordinator",
    highRiskCoordinatorPassed,
    `status=${highRiskProposal.status} checkpoint=${highRiskCheckpoint?.id ?? "<none>"} disposition=${highRiskAuthorityDisposition ?? "<none>"}`,
  );

  const blockedOutput: AttemptOutput = {
    status: "done",
    summary: "Attempt to spawn a run from an unaccepted proposal.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "createRunsFromDesign",
        payload: {
          proposalId: highRiskProposal.id,
          runs: [
            {
              goal: "Plan managed Postgres migration",
              prompt: "Plan the migration.",
            },
          ],
        },
      },
    ],
  };
  const blockedResult = runDesignActions(blockedOutput, highRiskDesignerTaskId);
  const blockedProblem = (blockedResult.problems ?? [])[0];
  const blockedArtifact = (blockedResult.artifacts ?? []).find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "kind" in entry &&
      entry.kind === "created_run",
  );
  if (blockedProblem && !blockedArtifact) {
    record(
      "scenario C: createRunsFromDesign rejected",
      true,
      `blocked with problem: ${blockedProblem}`,
    );
  } else {
    record(
      "scenario C: createRunsFromDesign rejected",
      false,
      `expected the hook to reject the action; artifacts=${JSON.stringify(blockedResult.artifacts)}`,
    );
  }

  // ----------------------------------------------------------------------------
  // Scenario D: quiescence — Designer emits no design actions.
  // ----------------------------------------------------------------------------

  const quiescentOutput: AttemptOutput = {
    status: "done",
    summary: "Designer reviewed signals and chose not to propose new work.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    // No designActions field — silence is the contract.
  };
  const quiescentResult = runDesignActions(quiescentOutput);
  const quiescentProblems = quiescentResult.problems ?? [];
  const quiescentArtifacts = quiescentResult.artifacts ?? [];
  const noQuiescentMutation =
    harness.listStrategySignals({ projectId }).length === 1 &&
    harness.listDesignProposals({ projectId }).length === 2;
  if (
    quiescentResult.decision === "exit" &&
    quiescentProblems.length === 0 &&
    quiescentArtifacts.length === 0 &&
    noQuiescentMutation
  ) {
    record(
      "scenario D: quiescence",
      true,
      `decision=${quiescentResult.decision} no mutations; signals/proposals unchanged`,
    );
  } else {
    record(
      "scenario D: quiescence",
      false,
      `decision=${quiescentResult.decision} problems=${quiescentProblems.length} artifacts=${quiescentArtifacts.length} signals=${harness.listStrategySignals({ projectId }).length} proposals=${harness.listDesignProposals({ projectId }).length}`,
    );
  }

  // ----------------------------------------------------------------------------
  // Scenario E: production envelope — proposeDesign omits charterId and
  // riskSurface (the format the production Designer prompt actually emits).
  // The coordinator must resolve the active charter, persist it on the
  // approved decision, and the child run must inherit the SAME non-null
  // charter ID in designCharterId and designApprovalAuthority.charterId.
  // ----------------------------------------------------------------------------

  const productionDesignerTaskId = createDesignerTask(
    "Designer cycle for production-envelope proposal (no charterId, no riskSurface)",
  );

  const productionProposeOutput: AttemptOutput = {
    status: "done",
    summary: "Designer emitted a production-format proposal omitting charterId and riskSurface.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "proposeDesign",
        payload: {
          projectId,
          title: "Tighten idle grace window",
          proposal: {
            problem: "Idle grace window is too generous under contention.",
            targetOutcome: "Idle timeout fires predictably under load.",
            evidenceRefs: [signal.id],
            options: [
              {
                name: "Shrink idleInitialGraceMs by 25%",
                benefits: ["Faster recovery from silent starts"],
                costs: ["Tighter deadline for slow agents"],
                risks: ["none"],
                lockIn: ["Runner owns idle-window semantics"],
              },
            ],
            recommendation: "Shrink idleInitialGraceMs by 25%",
            additions: ["Runner config: idleInitialGraceMs"],
            removals: [],
            assumptions: ["Workers that produce no output for >45s are silent starts"],
            uncertainty: [],
            evaluationContract: {
              baseline: ["Self-iteration run 2026-08-02: 2 attempts lingered past grace"],
              successMetrics: ["Silent-start attempts exit within 60s"],
              guardMetrics: ["Healthy attempts still complete"],
              requiredEvidence: ["Replay of lingering attempts exits within 60s"],
              reviewAt: "2026-10-01",
            },
            investment: {
              reversibility: "easy",
              portfolio: "core",
              oneTimeCost: 0,
              recurringCost: 0,
              timeBudget: "1 day",
            },
            experiment: {
              hypothesis: "Tighter grace window resolves lingering silent starts",
              smallestTest: "Replay two prior lingering attempts",
              stopConditions: ["Healthy attempt killed by tighter window"],
              rollback: "git revert the runner config change",
            },
          },
          status: "proposed",
          // NO charterId and NO riskSurface — this is the production envelope.
        },
      },
    ],
  };
  const productionProposeResult = runDesignActions(productionProposeOutput, productionDesignerTaskId);
  if (productionProposeResult.problems && productionProposeResult.problems.length > 0) {
    record(
      "scenario E: production proposeDesign",
      false,
      `unexpected problems: ${productionProposeResult.problems.join(" | ")}`,
    );
  } else {
    record("scenario E: production proposeDesign", true, "no problems");
  }

  const productionProposal = harness
    .listDesignProposals({ projectId })
    .find((proposal) => proposal.title === "Tighten idle grace window");
  if (!productionProposal) {
    record("scenario E: production proposal recorded", false, "no production proposal recorded");
    throw new Error("scenario E proposal missing");
  }
  const productionDecision = harness
    .listDesignDecisions({ proposalId: productionProposal.id })
    .find((decision) => decision.decision === "approved" && decision.actorKind === "auto");
  const productionCoordinatorPassed =
    productionProposal.status === "accepted" &&
    Boolean(productionDecision) &&
    productionDecision?.charterId === charter.id &&
    productionProposal.charterId === null;
  record(
    "scenario E: production proposeDesign coordinator",
    productionCoordinatorPassed,
    `status=${productionProposal.status} decision=${productionDecision?.id ?? "<none>"} decisionCharter=${productionDecision?.charterId ?? "<none>"} proposalCharter=${productionProposal.charterId}`,
  );

  // createRunsFromDesign — assert the child run inherits the resolved charter.
  const productionDeliverOutput: AttemptOutput = {
    status: "done",
    summary: "Spawn child planner run from production-envelope proposal.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    designActions: [
      {
        type: "createRunsFromDesign",
        payload: {
          proposalId: productionProposal.id,
          runs: [
            {
              goal: "Plan tighter idle grace window",
              prompt: "Sharpen the task graph for the tighter idle-grace change.",
              doneWhen: [
                "Planner returns a small nextTasks graph for this run",
                "Every generated task honors the frozen design evaluation contract",
              ],
            },
          ],
        },
      },
    ],
  };
  const productionDeliverResult = runDesignActions(productionDeliverOutput, productionDesignerTaskId);
  const productionCreatedArtifact = (productionDeliverResult.artifacts ?? []).find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "kind" in entry &&
      entry.kind === "created_run",
  );
  if (!productionCreatedArtifact) {
    record(
      "scenario E: createRunsFromDesign inherits resolved charter",
      false,
      `expected one created_run artifact; problems=${productionDeliverResult.problems?.join(" | ") ?? "<none>"}`,
    );
  } else {
    const artifact = productionCreatedArtifact as { runId: string };
    const child = harness.getRun(artifact.runId);
    const childCtx = (child?.context ?? {}) as Record<string, unknown>;
    const designCharterId = childCtx.designCharterId;
    const approvalAuthority = childCtx.designApprovalAuthority as { charterId?: string } | undefined;
    const inheritedContract = Boolean(childCtx.designEvaluationContract);
    const charterMatch =
      designCharterId === charter.id && approvalAuthority?.charterId === charter.id;
    record(
      "scenario E: createRunsFromDesign inherits resolved charter",
      charterMatch && inheritedContract,
      `childRun=${artifact.runId} designCharterId=${designCharterId ?? "<none>"} approvalCharterId=${approvalAuthority?.charterId ?? "<none>"} inheritedContract=${inheritedContract}`,
    );
  }

  // ----------------------------------------------------------------------------
  // Tally and exit code.
  // ----------------------------------------------------------------------------

  const failed = results.filter((entry) => !entry.ok);
  console.log("");
  console.log(`Dogfood summary: ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.log("Failed scenarios:");
    for (const entry of failed) {
      console.log(`  - ${entry.name}: ${entry.details}`);
    }
    process.exitCode = 1;
  }
}
