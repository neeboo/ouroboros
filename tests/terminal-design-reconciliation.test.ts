import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import {
  createGoalReviewDecisionHook,
  createTasksFromOutputHook,
  reconcileTerminalDesignDeliveries,
  runNextReadyTask,
} from "../packages/runner/src";

describe("terminal design delivery reconciliation", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-terminal-design-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("integrates one verified terminal delivery before a new assessment", async () => {
    const repoPath = join(dir, "repo");
    const worktreePath = join(dir, "worker-tree");
    await initializeRepository(repoPath);
    git(repoPath, ["worktree", "add", "-b", "task-worker", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "feature.ts"), "export const delivered = true;\n");

    const { rootRunId, deliveryRunId, proposalId } = createDesignDelivery({ repoPath });
    const workerTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "worker",
      goal: "Implement the accepted design",
      prompt: "Create src/feature.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Implemented the accepted design",
        changedFiles: ["src/feature.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "verifier",
      goal: "Verify the accepted design",
      prompt: "Verify src/feature.ts.",
      dependsOn: [workerTaskId],
      worktreePath,
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified the accepted design",
        changedFiles: [],
        checks: [{ name: "verification", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "goal-review",
      goal: "Review terminal delivery",
      prompt: "Decide whether delivery is complete.",
    });
    harness.recordAttempt({
      taskId: goalReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Delivery is complete",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId: deliveryRunId, status: "done" });

    const result = reconcileTerminalDesignDeliveries({
      harness,
      rootRunId,
      runs: harness.listRuns({ limit: 100 }),
    });
    const delivery = harness.getRun(deliveryRunId);
    const proposal = harness.getDesignProposal({ id: proposalId });
    const overview = harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 });
    const events = harness.listHarnessActionEvents({ limit: 100 });
    const integrationEvent = events.find((event) => event.actionType === "integrateVerifiedRun");
    const completionEvent = events.find((event) => event.actionType === "completeSystemTask");

    expect(result).toMatchObject({
      blocksAssessment: true,
      state: "integrated",
      deliveryRunId,
      proposalId,
      actionEventId: integrationEvent?.id,
    });
    expect(await Bun.file(join(repoPath, "src", "feature.ts")).text()).toContain("delivered = true");
    expect(proposal?.status).toBe("measuring");
    expect(overview.tasks.filter((task) => task.role === "outcome-review")).toHaveLength(1);
    expect(overview.tasks.filter((task) => task.role === "system")).toHaveLength(1);
    expect(delivery?.context.terminalDesignReconciliation).toMatchObject({
      state: "integrated",
      actionEventId: integrationEvent?.id,
    });
    expect(completionEvent?.request).toMatchObject({ actionEventId: integrationEvent?.id });

    setupHistoricalReceiptReplay();
    const replay = reconcileTerminalDesignDeliveries({
      harness,
      rootRunId,
      runs: harness.listRuns({ limit: 100 }),
    });
    const replayOverview = harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 });
    const replayEvents = harness.listHarnessActionEvents({ limit: 100 });

    expect(replay).toMatchObject({
      blocksAssessment: true,
      state: "integrated",
      actionEventId: integrationEvent?.id,
      reason: "historical audited integration receipt reconciled",
    });
    expect(replayEvents.filter((event) => event.actionType === "integrateVerifiedRun")).toHaveLength(1);
    expect(replayOverview.tasks.filter((task) => task.role === "outcome-review")).toHaveLength(1);
    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("measuring");

    function setupHistoricalReceiptReplay() {
      const outcomeReview = harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 }).tasks.find(
        (task) => task.role === "outcome-review",
      );
      if (outcomeReview?.status === "todo") {
        harness.recordAttempt({
          taskId: outcomeReview.id,
          input: { executor: "test" },
          output: {
            status: "done",
            summary: "Historical outcome task drained for replay setup",
            changedFiles: [],
            checks: [{ name: "setup", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        });
      }
      harness.updateDesignProposalStatus({ proposalId, status: "accepted" });
      harness.updateRun({
        runId: deliveryRunId,
        status: "done",
        contextPatch: { terminalDesignReconciliation: null },
      });
    }
  });

  test("creates only one bounded repair for a terminal delivery without valid integration evidence", () => {
    const { rootRunId, deliveryRunId, proposalId } = createDesignDelivery({
      repairReplanBudget: { limit: 2, used: 0, entries: [] },
    });
    const verifierTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "verifier",
      goal: "Verify delivery",
      prompt: "Run the frozen checks.",
      worktreePath: join(dir, "source-tree"),
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Frozen verification failed",
        changedFiles: ["src/feature.ts"],
        checks: [{ name: "frozen suite", status: "failed" }],
        artifacts: [{ kind: "test_failure", command: "bun test" }],
        problems: ["full suite failed"],
      },
    });
    harness.updateRunStatus({ runId: deliveryRunId, status: "blocked" });

    const first = reconcileTerminalDesignDeliveries({ harness, rootRunId, runs: harness.listRuns({ limit: 100 }) });
    const second = reconcileTerminalDesignDeliveries({ harness, rootRunId, runs: harness.listRuns({ limit: 100 }) });
    const overview = harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 });
    const repairs = overview.tasks.filter((task) => task.config?.terminalDesignReconciliation);

    expect(first).toMatchObject({ blocksAssessment: true, state: "repairing", proposalId });
    expect(second).toMatchObject({ blocksAssessment: true, state: "repairing", repairTaskId: first.repairTaskId });
    expect(repairs.filter((task) => task.role === "worker")).toHaveLength(1);
    expect(overview.tasks.filter((task) => task.role === "system")).toHaveLength(0);
    expect(overview.run?.context.repairReplanBudget).toMatchObject({ limit: 2, used: 1 });
    expect(overview.run?.context.terminalDesignReconciliation).toMatchObject({
      state: "repairing",
      repairTaskId: first.repairTaskId,
      failureEvidence: expect.objectContaining({ sourceAttemptId: expect.any(String) }),
    });
  });

  test("blocks equivalent goal-review verification and records a terminal disposition after repair exhaustion", async () => {
    const { rootRunId, deliveryRunId, proposalId } = createDesignDelivery({
      repairReplanBudget: { limit: 3, used: 3, entries: [] },
    });
    const goalReviewTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "goal-review",
      goal: "Review exhausted delivery",
      prompt: "Do not exceed the frozen repair budget.",
    });
    const goalReview = await runNextReadyTask({
      harness,
      runId: deliveryRunId,
      stopHooksByRole: {
        "goal-review": [
          createGoalReviewDecisionHook({ harness }),
          createTasksFromOutputHook({ harness }),
        ],
      },
      executor: async () => ({
        status: "done",
        runDecision: "verify",
        summary: "Request equivalent verification after exhaustion",
        changedFiles: [],
        checks: [{ name: "repair budget", status: "failed" }],
        artifacts: [],
        problems: [],
        nextTasks: [{
          role: "verifier",
          goal: "Repeat exhausted verification",
          prompt: "Run the same frozen checks again.",
        }],
      }),
    });
    harness.updateRunStatus({ runId: deliveryRunId, status: "blocked" });

    const result = reconcileTerminalDesignDeliveries({ harness, rootRunId, runs: harness.listRuns({ limit: 100 }) });
    const delivery = harness.getRun(deliveryRunId);
    const proposal = harness.getDesignProposal({ id: proposalId });
    const dispositionEvent = harness.listHarnessActionEvents({ limit: 100 }).find(
      (event) => event.actionType === "updateRunContext" && event.request.runId === deliveryRunId,
    );

    expect(result).toMatchObject({
      blocksAssessment: true,
      state: "exhausted",
      deliveryRunId,
      proposalId,
      actionEventId: dispositionEvent?.id,
    });
    expect(proposal?.status).toBe("revise");
    expect(harness.getAttempt(goalReview!.attemptId)?.output).toMatchObject({
      status: "blocked",
      runDecision: "verify",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "repair_budget_exhausted", used: 3, limit: 3 }),
      ]),
    });
    expect(harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 }).tasks.filter(
      (task) => task.role === "verifier",
    )).toHaveLength(0);
    expect(delivery?.context.terminalDesignReconciliation).toMatchObject({
      state: "exhausted",
      terminalDisposition: "repair-budget-exhausted",
      actionEventId: dispositionEvent?.id,
    });
    expect(harness.getRunOverview({ runId: deliveryRunId, eventLimit: 0 }).tasks.filter(
      (task) => task.config?.terminalDesignReconciliation && task.role === "worker",
    )).toHaveLength(0);
  });

  test("ignores rejected proposals and terminal runs outside the root cycle", () => {
    const { rootRunId, deliveryRunId, proposalId } = createDesignDelivery();
    harness.updateDesignProposalStatus({ proposalId, status: "rejected" });
    harness.updateRunStatus({ runId: deliveryRunId, status: "done" });
    const unrelatedRunId = harness.createRun({ goal: "Unrelated terminal run", context: { source: "design" } });
    harness.updateRunStatus({ runId: unrelatedRunId, status: "done" });

    const result = reconcileTerminalDesignDeliveries({ harness, rootRunId, runs: harness.listRuns({ limit: 100 }) });

    expect(result).toMatchObject({ blocksAssessment: false, state: "clear" });
    expect(harness.getRun(deliveryRunId)?.context.terminalDesignReconciliation).toBeUndefined();
    expect(harness.getRun(unrelatedRunId)?.context.terminalDesignReconciliation).toBeUndefined();
    expect(harness.listHarnessActionEvents({ limit: 100 })).toHaveLength(0);
  });

  function createDesignDelivery(input: {
    repoPath?: string;
    repairReplanBudget?: { limit: number; used: number; entries: unknown[] };
  } = {}) {
    const projectId = harness.createProject({ name: "Terminal design project", rootPath: input.repoPath ?? dir });
    const rootRunId = harness.createRun({ goal: "Improve Ouroboros", projectId });
    const proposal = harness.createDesignProposal({
      projectId,
      title: "Close terminal design delivery",
      problem: "Accepted delivery can be skipped by reassessment.",
      recommendation: "Reconcile it before the next assessment.",
      proposal: {
        problem: "Accepted delivery can be skipped by reassessment.",
        recommendation: "Reconcile it before the next assessment.",
        evaluationContract: {
          baseline: ["accepted delivery is terminal without a receipt"],
          successMetrics: ["one audited terminal disposition"],
          guardMetrics: ["no duplicate repair or outcome review"],
          requiredEvidence: ["harness action event"],
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "one day",
        },
      },
      status: "accepted",
    });
    const deliveryRunId = harness.createRun({
      projectId,
      projectRoot: input.repoPath ?? dir,
      goal: "Deliver the accepted design",
      context: {
        parentRunId: rootRunId,
        source: "design",
        designProposalId: proposal.id,
        goalContract: { desiredState: "terminal delivery is reconciled" },
        designEvaluationContract: proposal.proposal.evaluationContract,
        verifierContract: { deterministicChecks: ["bun test"] },
        integrationBoundary: { targetBranch: "main", push: false },
        permissions: { filesystem: "workspace-write" },
        completionCriteria: ["one audited integration or bounded disposition"],
        repairReplanBudget: input.repairReplanBudget ?? { limit: 3, used: 0, entries: [] },
      },
    });
    return { rootRunId, deliveryRunId, proposalId: proposal.id };
  }
});

async function initializeRepository(repoPath: string) {
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "initial\n");
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.name", "Ouroboros Test"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "commit.gpgSign", "false"]);
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "Initial commit"]);
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
