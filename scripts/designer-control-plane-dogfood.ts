/**
 * Bounded dogfood for slice 7 of the Designer Control Plane.
 *
 * Demonstrates four required scenarios:
 *  (A) Evidence-backed proposal: recordSignal + proposeDesign through the
 *      fixed Designer actions hook.
 *  (B) Accepted low-risk proposal creates a child planner run with the frozen
 *      evaluation contract and inherited design context.
 *  (C) High-risk proposal that has not passed its authority gate cannot
 *      create child runs through `createRunsFromDesign`.
 *  (D) Quiescence: when the Designer returns no design actions, the hook
 *      returns `decision: "exit"` without writing anything — silence is a
 *      valid, durable answer when evidence does not justify new work.
 *
 * This script uses a temporary on-disk database. It exits with status 1 if
 * any assertion fails so it can be wired into local smoke checks.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../packages/harness/src/harness";
import { evaluateAuthority } from "../packages/harness/src/design-authority";
import { createApplyDesignActionsHook } from "../packages/runner/src/hooks/apply-design-actions";
import type {
  AttemptOutput,
  AuthorityActorContext,
  AuthorityCharterContext,
  AuthorityEvidenceReference,
  AuthorityPortfolioUsage,
  AuthorityProposalRiskSurface,
  DesignProposal,
  FounderCharter,
  StrategySignal,
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

function record(name: string, ok: boolean, details: string) {
  results.push({ name, ok, details });
  const marker = ok ? "PASS" : "FAIL";
  console.log(`[${marker}] ${name}: ${details}`);
}

function buildRiskSurface(
  proposal: DesignProposal,
  signalsById: Map<string, StrategySignal>,
  overrides: Partial<AuthorityProposalRiskSurface> = {},
): AuthorityProposalRiskSurface {
  const investment = proposal.proposal.investment ?? {
    reversibility: "easy",
    portfolio: "core",
    oneTimeCost: 0,
    recurringCost: 0,
  };
  const evidenceRefs = proposal.proposal.evidenceRefs ?? [];
  const evidence = evidenceRefs
    .map((ref) => signalsById.get(ref))
    .filter((signal): signal is StrategySignal => Boolean(signal));
  const evidenceTitles = new Set(evidence.map((signal) => signal.title.toLowerCase()));
  const evidenceSummaries = new Set(evidence.map((signal) => signal.summary.toLowerCase()));
  const textMatches = (needles: string[]) =>
    needles.some((needle) =>
      evidenceTitles.has(needle.toLowerCase()) ||
      Array.from(evidenceSummaries).some((summary) => summary.includes(needle.toLowerCase())),
    );

  const optionRisks = (proposal.proposal.options ?? []).flatMap((option) => option.risks ?? []);
  const optionRiskText = optionRisks.join(" ").toLowerCase();
  const summaryText = `${proposal.title} ${proposal.problem} ${proposal.recommendation}`.toLowerCase();

  const amendsMission = /mission|charter/.test(summaryText);
  const amendsCapitalPolicy = /capital|recurring|spend|budget/.test(summaryText) && (investment.recurringCost ?? 0) > 0;
  const legalOrPrivacy =
    textMatches(["legal", "privacy", "gdpr", " pii "]) ||
    /legal|privacy|gdpr/.test(optionRiskText);
  const sensitiveData =
    textMatches(["sensitive", "credentials", "secrets", "personally identifiable"]) ||
    /sensitive|credentials|secrets/.test(optionRiskText);
  const destructiveOperation =
    textMatches(["destructive", "drop", "delete"]) || /destructive/.test(optionRiskText);
  const productionDeployment =
    textMatches(["production", "deploy"]) || /production|deploy/.test(optionRiskText);
  const unplannedDependency =
    textMatches(["dependency", "dependency"]) || /dependency/.test(optionRiskText);
  const schemaMigration =
    textMatches(["schema", "migration"]) || /schema|migration/.test(optionRiskText);
  const recurringInfrastructure =
    (investment.recurringCost ?? 0) > 0 || /recurring|infrastructure/.test(optionRiskText);

  return {
    proposalId: proposal.id,
    reversibility: investment.reversibility,
    portfolio: investment.portfolio,
    oneTimeCost: investment.oneTimeCost ?? 0,
    recurringCost: investment.recurringCost ?? 0,
    evidenceRefs,
    amendsMission,
    amendsCapitalPolicy,
    legalOrPrivacy,
    sensitiveData,
    destructiveOperation,
    productionDeployment,
    unplannedDependency,
    schemaMigration,
    recurringInfrastructure,
    declaredHumanCategories: [],
    ...overrides,
  };
}

function buildEvidence(
  proposal: DesignProposal,
  signalsById: Map<string, StrategySignal>,
): AuthorityEvidenceReference[] {
  const refs = proposal.proposal.evidenceRefs ?? [];
  return refs.map((ref) => {
    const signal = signalsById.get(ref);
    return {
      ref,
      kind: "signal" as const,
      expiresAt: signal?.expiresAt ?? null,
      hasConflict: Boolean(signal && signal.conflictingSignalIds.length > 0),
    };
  });
}

function charterContext(charter: FounderCharter): AuthorityCharterContext {
  return {
    id: charter.id,
    version: charter.version,
    isActive: charter.isActive === true,
    mission: charter.mission,
    capitalPolicy: charter.charter.capitalPolicy,
    authority: charter.charter.authority,
  };
}

function portfolioUsage(category: AuthorityPortfolioUsage["category"]): AuthorityPortfolioUsage {
  return { category, currentShare: 0 };
}

function actorFor(kind: AuthorityActorContext["kind"], isProposer: boolean): AuthorityActorContext {
  return { kind, ref: kind === "auto" ? null : "founder", isProposer };
}

const EVALUATED_AT = "2026-08-02T00:00:00.000Z";

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

  function runDesignActions(output: AttemptOutput): StopHookResult {
    const overview = harness.getRunOverview({ runId: rootRunId, eventLimit: 0 });
    if (!overview.run) {
      throw new Error(`root run ${rootRunId} not found`);
    }
    const hookInput: StopHookInput = {
      run: overview.run,
      task: harness.getTask(designerTaskId)!,
      sessionName: "designer-dogfood",
      prompt: "Inspect repo and propose (or quiesce).",
      output,
    };
    return designActionsHook(hookInput) as StopHookResult;
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
  // Scenario B: evaluate authority, record approved decision, create child run.
  // ----------------------------------------------------------------------------

  const signalsByProject = harness.listStrategySignals({ projectId, limit: 1000 });
  const signalsById = new Map<string, StrategySignal>(signalsByProject.map((signal) => [signal.id, signal]));

  const evaluation = evaluateAuthority({
    charter: charterContext(charter),
    proposal: buildRiskSurface(lowRiskProposal, signalsById),
    evidence: buildEvidence(lowRiskProposal, signalsById),
    portfolioUsage: portfolioUsage(lowRiskProposal.proposal.investment?.portfolio ?? "core"),
    actor: actorFor("auto", false),
    evaluatedAt: EVALUATED_AT,
  });

  if (evaluation.disposition === "automatic") {
    record(
      "scenario B: authority evaluator",
      true,
      `disposition=automatic charter=v${evaluation.charterVersion} reasons=${evaluation.reasons.length}`,
    );
  } else {
    record(
      "scenario B: authority evaluator",
      false,
      `expected automatic, got ${evaluation.disposition}; reasons=${evaluation.reasons.map((r) => r.message).join(" | ")}`,
    );
  }

  const approvedDecision = harness.recordDesignDecision({
    proposalId: lowRiskProposal.id,
    decision: "approved",
    actorKind: "auto",
    actorRef: null,
    charterId: charter.id,
    reasons: evaluation.reasons.map((reason) => reason.message),
    authority: evaluation as unknown as Record<string, unknown>,
  });
  harness.updateDesignProposalStatus({ proposalId: lowRiskProposal.id, status: "accepted" });
  record(
    "scenario B: approved decision recorded",
    true,
    `decision=${approvedDecision.id} actorKind=${approvedDecision.actorKind} proposal=accepted`,
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
    record(
      "scenario B: createRunsFromDesign",
      inheritsProposal && inheritsFrozenContract && inheritsDesignProposal,
      `childRun=${artifact.runId} planner=${artifact.plannerTaskId} inheritsProposal=${inheritsProposal} inheritsContract=${inheritsFrozenContract} inheritsProposalEnvelope=${inheritsDesignProposal}`,
    );
  }

  // ----------------------------------------------------------------------------
  // Scenario C: high-risk proposal cannot create runs without approval.
  // ----------------------------------------------------------------------------

  const highRiskProposal = harness.createDesignProposal({
    projectId,
    title: "Move Ouroboros control plane to managed cloud Postgres",
    problem: "Local SQLite limits cross-machine collaboration.",
    recommendation: "Provision managed Postgres and migrate the harness schema.",
    proposal: {
      problem: "Local SQLite limits cross-machine collaboration.",
      evidenceRefs: [signal.id],
      targetOutcome: "Multiple operators share one Ouroboros database.",
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
        oneTimeCost: 2000,
        recurringCost: 150,
        timeBudget: "2 weeks",
      },
    },
    charterId: charter.id,
    runId: rootRunId,
    taskId: designerTaskId,
    status: "proposed",
  });

  const highRiskEvaluation = evaluateAuthority({
    charter: charterContext(charter),
    proposal: buildRiskSurface(highRiskProposal, signalsById),
    evidence: buildEvidence(highRiskProposal, signalsById),
    portfolioUsage: portfolioUsage(highRiskProposal.proposal.investment?.portfolio ?? "growth"),
    actor: actorFor("auto", false),
    evaluatedAt: EVALUATED_AT,
  });

  if (
    highRiskEvaluation.disposition === "human-required" ||
    highRiskEvaluation.disposition === "rejected"
  ) {
    record(
      "scenario C: high-risk authority",
      true,
      `disposition=${highRiskEvaluation.disposition} (gated for human review)`,
    );
  } else {
    record(
      "scenario C: high-risk authority",
      false,
      `expected human-required or rejected; got ${highRiskEvaluation.disposition}`,
    );
  }

  const blockedOutput: AttemptOutput = {
    status: "done",
    summary: "Attempt to spawn a run from an unapproved proposal.",
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
  const blockedResult = runDesignActions(blockedOutput);
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
