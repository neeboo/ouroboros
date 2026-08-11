import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyHarnessAction,
  canonicalHarnessRevisionContentSha256,
  canonicalEvolutionRecordSha256,
  canonicalEvolutionValueSha256,
  describeAuthorityEvaluation,
  describeIntegrationReadiness,
  evaluateAuthority,
  expectedEvolutionRecordId,
  Harness,
  HARD_AUTHORITY_RULES,
  isHardAuthorityReason,
  observeWatchdogTree,
  parseEvolutionProfile,
  parseHarnessVariant,
  parseMatchedExperiment,
  parseProductionEpisode,
  withDatabase,
  type HarnessDatabase,
  type HarnessRevisionV1,
  type SubsessionRunner,
  type SubsessionRunnerCancelChild,
  type SubsessionRunnerCollectChild,
  type SubsessionRunnerStartInput,
  type SubsessionRunnerStartResult,
} from "../packages/harness/src";
import type {
  AuthorityActorContext,
  AuthorityCharterContext,
  AuthorityEvidenceReference,
  AuthorityEvaluationInput,
  AuthorityPortfolioUsage,
  AuthorityProposalRiskSurface,
} from "../packages/harness/src";
import { handleHarnessActionRequest } from "../packages/cli/src/action-server";

setDefaultTimeout(10_000);

describe("Harness actions", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-actions-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reclaims orphaned task leases and records an audit event", () => {
    const runId = harness.createRun({ goal: "Repair run state" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Leased without attempt",
      prompt: "Do work.",
    });
    harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `task-${task.id}`,
    });

    const result = applyHarnessAction(harness, {
      type: "reclaimRunningTasks",
      runId,
      reason: "runner exited before startAttempt",
    });
    const events = harness.listHarnessActionEvents({ limit: 1 });

    expect(result).toMatchObject({
      status: "done",
      actionType: "reclaimRunningTasks",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "reclaimed_task", taskId }));
    expect(harness.getTask(taskId)?.status).toBe("todo");
    expect(events[0]).toMatchObject({
      actionType: "reclaimRunningTasks",
      status: "done",
      request: expect.objectContaining({ runId }),
      result: expect.objectContaining({ status: "done" }),
    });
  });

  test("prepares a drained run by creating a goal-review task", () => {
    const runId = harness.createRun({ goal: "Review empty run" });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(overview.run?.status).toBe("todo");
    expect(overview.tasks).toContainEqual(expect.objectContaining({ role: "goal-review", status: "todo" }));
  });

  test("prepares a drained run by binding goal-review to the latest candidate worktree", () => {
    const runId = harness.createRun({ goal: "Review candidate implementation" });
    const worktreePath = "/tmp/ouroboros-candidate-worktree";
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement dashboard shell",
      prompt: "Move the dashboard to React.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Implemented dashboard shell",
        changedFiles: ["packages/cli/src/dashboard-shell.tsx"],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });
    const review = overview.tasks.find((task) => task.role === "goal-review");

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(review).toMatchObject({
      role: "goal-review",
      status: "todo",
      dependsOn: [workerTaskId],
      worktreePath,
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "goal_review",
        taskId: review?.id,
        sourceTaskId: workerTaskId,
        sourceWorktreePath: worktreePath,
      }),
    );
  });

  test("prepares a drained run by reviewing the project root after verified worker integration", () => {
    const runId = harness.createRun({ goal: "Review integrated implementation" });
    const worktreePath = "/tmp/ouroboros-integrated-worker";
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement dashboard shell",
      prompt: "Move the dashboard to React.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Implemented dashboard shell",
        changedFiles: ["packages/cli/src/dashboard-shell.tsx"],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify dashboard shell",
      prompt: "Verify the dashboard shell.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified dashboard shell",
        changedFiles: [],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.recordHarnessActionEvent({
      actionType: "integrateVerifiedRun",
      status: "done",
      request: { type: "integrateVerifiedRun", runId, workerTaskId },
      result: {
        status: "done",
        artifacts: [{ kind: "integration", mode: "branch_merge", runId, workerTaskId, mergeCommit: "abc123" }],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });
    const review = overview.tasks.find((task) => task.role === "goal-review");

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(review).toMatchObject({
      role: "goal-review",
      status: "todo",
      dependsOn: [],
      worktreePath: null,
    });
  });

  test("prepareRunDrain proposes repeated lesson guardrails before goal review", () => {
    const runId = harness.createRun({
      goal: "Promote repeated lessons while draining",
      context: {
        guardrails: [{ id: "guardrail_existing", summary: "Preserve accepted guardrails.", active: true }],
      },
    });
    const lessonSummary = "prepareRunDrain missed repeated lesson promotion";
    const firstTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "First blocked task",
      prompt: "Record a repeated lesson.",
    });
    const secondTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Second blocked task",
      prompt: "Record the same repeated lesson.",
    });
    harness.recordAttempt({
      taskId: firstTaskId,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [lessonSummary] },
    });
    harness.recordAttempt({
      taskId: secondTaskId,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [`${lessonSummary}.`] },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "guardrail proposals refreshed", status: "passed", evidence: "1 proposal(s)" }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "guardrail_proposals", runId, proposed: 1 }),
    );
    expect(overview.run?.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_existing", active: true }),
    ]);
    expect(overview.run?.context.guardrailProposals).toEqual([
      expect.objectContaining({
        summary: lessonSummary,
        count: 2,
        source: "lesson",
        active: false,
        accepted: false,
      }),
    ]);
    expect(overview.tasks.find((task) => task.role === "goal-review")?.status).toBe("todo");
  });

  test("prepares a drained run by accepting an existing complete goal-review", () => {
    const runId = harness.createRun({ goal: "Already reviewed run" });
    const reviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review completion.",
    });
    harness.recordAttempt({
      taskId: reviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Goal reached with evidence.",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed", evidence: "complete" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "completed goal review", status: "passed", evidence: reviewTaskId }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "run", runId, previousStatus: "todo", status: "done" }),
    );
    expect(overview.run?.status).toBe("done");
  });

  test("prepareRunDrain blocks completion while verified worker changes remain unintegrated", () => {
    const runId = harness.createRun({ goal: "Do not complete with pending worker integration" });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change code",
      prompt: "Edit src/pending.ts.",
      worktreePath: "/tmp/ouroboros-worker-pending",
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Worker changed code",
        changedFiles: ["src/pending.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify code",
      prompt: "Verify worker.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const reviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review completion.",
    });
    harness.recordAttempt({
      taskId: reviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Goal reached",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed", evidence: "complete" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("unintegrated verified worker"),
      problems: [expect.stringContaining(workerTaskId)],
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "pending_integration", taskId: workerTaskId, verifierTaskId, changedFiles: ["src/pending.ts"] }),
    );
    expect(overview.run?.status).toBe("blocked");
    expect(overview.run?.context.pendingIntegrationWorkerTaskIds).toEqual([workerTaskId]);
  });

  test("prepares a drained run by ignoring goal-review decisions invalidated by integration", () => {
    const runId = harness.createRun({
      goal: "Review after integration",
      context: { goalReviewInvalidatedByIntegration: true },
    });
    const oldReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Old review",
      prompt: "This review predates integration.",
    });
    harness.recordAttempt({
      taskId: oldReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Old complete decision",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed", evidence: "old" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });
    const goalReviews = overview.tasks.filter((task) => task.role === "goal-review");

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("Created goal-review task"),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "goal review invalidated", status: "passed", evidence: "integration" }),
    );
    expect(overview.run?.status).toBe("todo");
    expect(overview.run?.context.goalReviewInvalidatedByIntegration).toBe(false);
    expect(goalReviews).toHaveLength(2);
    expect(goalReviews.find((task) => task.id !== oldReviewTaskId)?.status).toBe("todo");

    const refreshedReview = goalReviews.find((task) => task.id !== oldReviewTaskId);
    if (!refreshedReview) {
      throw new Error("expected refreshed goal review");
    }
    harness.recordAttempt({
      taskId: refreshedReview.id,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "defer",
        summary: "A cost decision is required",
        changedFiles: [],
        checks: [{ name: "goal review", status: "failed", evidence: "cost approval" }],
        artifacts: [],
        problems: ["recurring infrastructure spend requires approval"],
      },
    });

    const repeated = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    expect(repeated).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("blocked by deferred goal-review"),
    });
    expect(harness.getRunOverview({ runId }).tasks.filter((task) => task.role === "goal-review")).toHaveLength(2);
  });

  test("prepares a drained run by ignoring invalidated non-terminal goal-review decisions", () => {
    const runId = harness.createRun({
      goal: "Review again after integration",
      context: { goalReviewInvalidatedByIntegration: true },
    });
    const oldReviewTaskIds = Array.from({ length: 3 }, (_, index) =>
      harness.createTask({
        runId,
        role: "goal-review",
        goal: `Old review ${index + 1}`,
        prompt: "This review predates integration.",
      }),
    );
    for (const taskId of oldReviewTaskIds) {
      harness.recordAttempt({
        taskId,
        input: { executor: "test" },
        output: {
          status: "done",
          runDecision: "continue",
          summary: "Old continue decision",
          changedFiles: [],
          checks: [{ name: "goal review", status: "failed", evidence: "old" }],
          artifacts: [],
          problems: ["old work remained"],
        },
      });
    }

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 3,
    });
    const overview = harness.getRunOverview({ runId });
    const goalReviews = overview.tasks.filter((task) => task.role === "goal-review");

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("Created goal-review task"),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "goal review invalidated", status: "passed", evidence: "integration" }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ name: "goal review continue limit", status: "failed" }),
    );
    expect(overview.run?.status).toBe("todo");
    expect(goalReviews).toHaveLength(4);
    expect(goalReviews.filter((task) => task.status === "todo")).toHaveLength(1);
  });

  test("verifier-only work does not reset the non-terminal goal-review budget", () => {
    const runId = harness.createRun({ goal: "Bound repeated verification" });
    const reviewTaskIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reviewTaskId = harness.createTask({
        runId,
        role: "goal-review",
        goal: `Review ${index + 1}`,
        prompt: "Request another verification pass.",
      });
      reviewTaskIds.push(reviewTaskId);
      harness.recordAttempt({
        taskId: reviewTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          runDecision: "verify",
          summary: "Verify again",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        },
      });
      const verifierTaskId = harness.createTask({
        runId,
        role: "verifier",
        goal: `Verifier ${index + 1}`,
        prompt: "Check existing evidence.",
      });
      harness.recordAttempt({
        taskId: verifierTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Verification completed",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        },
      });
    }

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 3,
    });

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("3/3 non-terminal goal-review decisions"),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "goal review continue limit", status: "failed", evidence: "3/3" }),
    );
    expect(harness.getRunOverview({ runId }).tasks.filter((task) => task.role === "goal-review").map((task) => task.id)).toEqual(reviewTaskIds);
  });

  test("prepareRunDrain keeps an exhausted drained run terminal without refreshing it", () => {
    const runId = harness.createRun({ goal: "Keep an exhausted run terminal" });
    for (let index = 0; index < 3; index += 1) {
      const taskId = harness.createTask({
        runId,
        role: "goal-review",
        goal: `Non-terminal review ${index + 1}`,
        prompt: "Continue without creating active work.",
      });
      harness.recordAttempt({
        taskId,
        input: { executor: "test" },
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
    harness.updateRunStatus({ runId, status: "blocked" });
    withDatabase(harness.dbPath, (db) => {
      db.query("update runs set updated_at = '2000-01-01 00:00:00' where id = $runId").run({ $runId: runId });
    });

    const first = applyHarnessAction(harness, { type: "prepareRunDrain", runId, maxTries: 1 });
    const firstDisposition = harness.getRun(runId)?.context.goalReviewTerminalDisposition;
    const firstTerminalUpdatedAt = withDatabase(harness.dbPath, (db) =>
      (db.query("select updated_at as updatedAt from runs where id = $runId").get({ $runId: runId }) as { updatedAt: string }).updatedAt,
    );
    const second = applyHarnessAction(harness, { type: "prepareRunDrain", runId, maxTries: 1 });
    const overview = harness.getRunOverview({ runId });
    const terminalUpdatedAt = withDatabase(harness.dbPath, (db) =>
      (db.query("select updated_at as updatedAt from runs where id = $runId").get({ $runId: runId }) as { updatedAt: string }).updatedAt,
    );

    expect(first).toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("3/1 non-terminal goal-review decisions"),
    });
    expect(second).toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("terminal goal-review disposition"),
    });
    expect(firstDisposition).toMatchObject({ kind: "max-tries", tries: 3, maxTries: 1 });
    expect(harness.getRun(runId)?.context.goalReviewTerminalDisposition).toEqual(firstDisposition);
    expect(overview.run?.status).toBe("blocked");
    expect(terminalUpdatedAt).toBe(firstTerminalUpdatedAt);
    expect(overview.tasks.some((task) => task.status === "todo" || task.status === "running")).toBe(false);
  });

  test("prepareRunDrain does not retry a blocked goal-review after the repair budget is exhausted", () => {
    const runId = harness.createRun({
      goal: "Stop bounded goal review recovery",
      context: {
        repairReplanBudget: {
          limit: 3,
          used: 3,
          entries: [],
        },
      },
    });
    const reviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review the exhausted delivery",
      prompt: "Do not create work beyond the frozen repair budget.",
    });
    harness.recordAttempt({
      taskId: reviewTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        runDecision: "continue",
        summary: "More delivery work remains",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["goal-review cannot create continue work after repair budget exhausted at 3/3"],
      },
    });
    harness.recordAttempt({
      taskId: reviewTaskId,
      input: { executor: "bounded-stop" },
      output: {
        status: "blocked",
        summary: "A later bounded stop has no new run decision",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["The prior exhausted goal-review evidence remains authoritative."],
      },
    });
    harness.updateRunStatus({ runId, status: "blocked" });
    withDatabase(harness.dbPath, (db) => {
      db.query("update runs set updated_at = '2000-01-01 00:00:00' where id = $runId").run({ $runId: runId });
    });

    const first = applyHarnessAction(harness, { type: "prepareRunDrain", runId, maxTries: 3 });
    const firstUpdatedAt = withDatabase(harness.dbPath, (db) =>
      (db.query("select updated_at as updatedAt from runs where id = $runId").get({ $runId: runId }) as { updatedAt: string }).updatedAt,
    );
    const second = applyHarnessAction(harness, { type: "prepareRunDrain", runId, maxTries: 3 });
    const overview = harness.getRunOverview({ runId });
    const secondUpdatedAt = withDatabase(harness.dbPath, (db) =>
      (db.query("select updated_at as updatedAt from runs where id = $runId").get({ $runId: runId }) as { updatedAt: string }).updatedAt,
    );

    expect(first).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("repair budget exhausted at 3/3"),
    });
    expect(second).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: expect.stringContaining("repair budget exhausted at 3/3"),
    });
    expect(harness.getTask(reviewTaskId)?.status).toBe("blocked");
    expect(overview.run?.status).toBe("blocked");
    expect(overview.sessions.filter((session) => session.taskId === reviewTaskId)).toHaveLength(2);
    expect(firstUpdatedAt).toBe("2000-01-01 00:00:00");
    expect(secondUpdatedAt).toBe(firstUpdatedAt);
  });

  test("prepares a drained run by blocking todo tasks whose dependencies are blocked", () => {
    const runId = harness.createRun({ goal: "Drain impossible dependency chain" });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Blocked worker",
      prompt: "This worker cannot finish.",
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Worker blocked permanently",
        changedFiles: [],
        checks: [{ name: "worker", status: "failed", evidence: "blocked" }],
        artifacts: [],
        problems: ["worker blocked permanently"],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify blocked worker",
      prompt: "This should not stay todo forever.",
      dependsOn: [workerTaskId],
    });

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 2,
    });
    const overview = harness.getRunOverview({ runId });
    const verifier = harness.getTask(verifierTaskId);
    const verifierAttempt = harness.listLatestAttemptsForTasks([verifierTaskId])[0];

    expect(result).toMatchObject({
      status: "done",
      actionType: "prepareRunDrain",
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "blocked dependency tasks", status: "passed", evidence: "1" }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "blocked_dependency_task",
        taskId: verifierTaskId,
        dependencyIds: [workerTaskId],
      }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "shared_root_cause",
        rootTaskId: workerTaskId,
        terminalReason: null,
        descendantTaskIds: [verifierTaskId],
      }),
    );
    expect(verifier?.status).toBe("blocked");
    expect(verifierAttempt).toBeUndefined();
    expect(overview.tasks.find((task) => task.role === "goal-review")?.status).toBe("todo");
  });

  test("completes a system task from a recorded harness action event", () => {
    const runId = harness.createRun({ goal: "Repair run state" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Run DB-writable repair",
      prompt: "Use a harness action.",
    });
    const drainResult = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      reason: "system repair",
    });

    const result = applyHarnessAction(harness, {
      type: "completeSystemTask",
      taskId,
      actionEventId: drainResult.eventId,
      reason: "bind DB-writable repair evidence",
    });
    const attempts = harness.listLatestAttemptsForTasks([taskId]);

    expect(result).toMatchObject({
      status: "done",
      actionType: "completeSystemTask",
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "attempt", taskId, status: "done" }));
    expect(harness.getTask(taskId)?.status).toBe("done");
    expect(attempts[0]).toMatchObject({
      taskId,
      status: "done",
      summary: expect.stringContaining(drainResult.eventId),
    });
    expect(attempts[0].checks).toContainEqual(
      expect.objectContaining({ name: "harness action event", evidence: drainResult.eventId }),
    );
  });

  test("integrates a verified worker worktree through an audited overseer action", async () => {
    const repoPath = join(dir, "repo");
    const worktreePath = join(dir, "worker-tree");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "app.ts"), "export const value = 1;\n");
    git(worktreePath, ["add", "src/app.ts"]);
    git(worktreePath, ["commit", "-m", "Worker implementation"]);
    await writeFile(join(repoPath, "target-only.txt"), "committed on target after worker branched\n");
    git(repoPath, ["add", "target-only.txt"]);
    git(repoPath, ["commit", "-m", "Target-only delivery"]);
    const targetHeadBefore = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const workerHead = git(worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(join(repoPath, "README.md"), "operator edit\n");
    git(repoPath, ["add", "README.md"]);
    await writeFile(join(repoPath, "NOTES.md"), "operator note\n");

    const runId = harness.createRun({ goal: "Integrate verified work", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement app file",
      prompt: "Create src/app.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created app file",
        changedFiles: ["src/app.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified app file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review completion",
      prompt: "Review run completion.",
    });
    harness.recordAttempt({
      taskId: goalReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Goal reached",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId, status: "done" });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate verified worker",
      reason: "overseer merge after verification",
    });
    const mergedFile = await readFile(join(repoPath, "src", "app.ts"), "utf8");
    const log = git(repoPath, ["log", "--oneline", "-1"]).stdout;
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];
    const readiness = describeIntegrationReadiness(harness, runId);

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        mode: "branch_merge",
        runId,
        workerTaskId,
        verifierTaskId,
        goalReviewTaskId,
        targetBranch: "main",
        sourceBranch: "task-worker",
        pushed: false,
      }),
    );
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("operator edit\n");
    expect(await readFile(join(repoPath, "NOTES.md"), "utf8")).toBe("operator note\n");
    expect(git(repoPath, ["status", "--short"]).stdout).toContain("M  README.md");
    expect(git(repoPath, ["status", "--short"]).stdout).toContain("?? NOTES.md");
    expect(git(repoPath, ["show", "HEAD:target-only.txt"]).stdout).toBe("committed on target after worker branched\n");
    expect(git(repoPath, ["show", "HEAD:src/app.ts"]).stdout).toBe("export const value = 1;\n");
    expect(git(repoPath, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ").slice(1)).toEqual([
      targetHeadBefore,
      workerHead,
    ]);
    expect(mergedFile.trim()).toBe("export const value = 1;");
    expect(log).toContain("Integrate verified worker");
    expect(readiness.unintegrated).toHaveLength(0);
    expect(readiness.integratedWorkerTaskIds.has(workerTaskId)).toBe(true);
    expect(event).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ runId, workerTaskId }),
    });
  });

  test("blocks target HEAD drift before recording an integration receipt", async () => {
    const scenario = await createDisjointBranchIntegrationScenario(harness, dir);
    let drifted = false;
    const runGit = (input: { cwd: string; args: string[] }) => {
      if (!drifted && input.cwd === scenario.repoPath && input.args[0] === "merge-tree") {
        writeFileSync(join(scenario.repoPath, "operator-drift.txt"), "drift\n");
        git(scenario.repoPath, ["add", "operator-drift.txt"]);
        git(scenario.repoPath, ["-c", "commit.gpgSign=false", "commit", "--only", "-m", "Operator drift", "--", "operator-drift.txt"]);
        drifted = true;
      }
      return rawGit(input.cwd, input.args);
    };

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId: scenario.runId,
      workerTaskId: scenario.workerTaskId,
      repoPath: scenario.repoPath,
      targetBranch: "main",
    }, { runGit });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join(" ")).toContain("target HEAD drifted");
    expect(result.artifacts).toHaveLength(0);
    expect(git(scenario.repoPath, ["show", "--format=", "--name-only", "HEAD"]).stdout).toContain("operator-drift.txt");
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);
  });

  test("rejects a closure whose commands replace the verifier task contract before Git mutation", async () => {
    const repoPath = join(dir, "repo-verifier-command-binding");
    const worktreePath = join(dir, "worker-verifier-command-binding");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-verifier-command-binding", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "verified.ts"), "export const verified = true;\n");

    const runId = harness.createRun({ goal: "Bind integration to the persisted verifier contract", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Create the verified file",
      prompt: "Create src/verified.ts.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created verified file",
        changedFiles: ["src/verified.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the file with the frozen failing command",
      prompt: "Run the persisted verifier contract.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["true", "false"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verifier evidence recorded",
        changedFiles: [],
        checks: [{ name: "verifier", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const targetHeadBefore = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const targetStatusBefore = git(repoPath, ["status", "--short"]).stdout;
    const path = "src/verified.ts";
    const pathHash = createHash("sha256").update(await readFile(join(worktreePath, path))).digest("hex");
    const closureManifest = {
      targetBaseSha: targetHeadBefore,
      sourceTaskIds: [workerTaskId],
      sourceAttemptIds: [workerAttemptId],
      paths: [path],
      pathHashes: { [path]: pathHash },
      verifierTaskId,
    };
    for (const frozenCommands of [
      ["true", "true"],
      ["true"],
      ["true", "false", "true"],
      ["false", "true"],
    ]) {
      const result = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId,
        workerTaskId,
        repoPath,
        targetBranch: "main",
        integrationClosure: { ...closureManifest, frozenCommands },
      });
      expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
      expect(result.problems.join(" ")).toContain("verifier commands");
    }
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetHeadBefore);
    expect(git(repoPath, ["status", "--short"]).stdout).toBe(targetStatusBefore);
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);

    const exactClosure = {
      ...closureManifest,
      frozenCommands: ["true", "false"],
    };
    const first = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure: exactClosure,
    });
    const second = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure: exactClosure,
    });

    expect(first).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(first.problems.join(" ")).toContain("frozen verifier command failed");
    expect(second).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetHeadBefore);
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);
  });

  test("rejects incomplete, stale, and hash-mismatched integration closures before Git mutation", async () => {
    for (const kind of ["missing-terminal", "command-only-terminal", "incomplete", "stale", "hash-mismatch", "unknown-field"] as const) {
      const fixtureDir = join(dir, `closure-${kind}`);
      const repoPath = join(fixtureDir, "repo");
      const worktreePath = join(fixtureDir, "worker");
      const fixtureHarness = new Harness(join(fixtureDir, "ouroboros.db"));
      fixtureHarness.init();
      await mkdir(repoPath, { recursive: true });
      await writeFile(join(repoPath, "README.md"), "initial\n");
      git(repoPath, ["init", "-b", "main"]);
      git(repoPath, ["config", "user.name", "Ouroboros Test"]);
      git(repoPath, ["config", "user.email", "test@example.com"]);
      git(repoPath, ["config", "commit.gpgSign", "false"]);
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);
      git(repoPath, ["worktree", "add", "-b", `task-closure-${kind}`, worktreePath, "main"]);
      await mkdir(join(worktreePath, "src"), { recursive: true });
      const path = "src/verified.ts";
      await writeFile(join(worktreePath, path), "export const verified = true;\n");

      const isTerminalKind = kind === "missing-terminal" || kind === "command-only-terminal";
      const runId = fixtureHarness.createRun({
        goal: "Reject an invalid integration closure",
        projectRoot: repoPath,
        context: isTerminalKind ? { source: "design", designProposalId: "design_terminal_fixture" } : {},
      });
      const workerTaskId = fixtureHarness.createTask({
        runId,
        role: "worker",
        goal: "Create the verified file",
        prompt: "Create src/verified.ts.",
        worktreePath,
      });
      const workerAttemptId = fixtureHarness.recordAttempt({
        taskId: workerTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Created verified file",
          changedFiles: [path],
          checks: [{ name: "worker", status: "passed" }],
          artifacts: [],
          problems: [],
        },
      });
      const verifierTaskId = fixtureHarness.createTask({
        runId,
        role: "verifier",
        goal: "Verify the complete closure",
        prompt: "Verify the complete closure.",
        dependsOn: [workerTaskId],
        config: { verifierContract: { deterministicChecks: ["true"] } },
      });
      fixtureHarness.recordAttempt({
        taskId: verifierTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Verified the complete closure",
          changedFiles: [],
          checks: [{ name: "verifier", status: "passed" }],
          artifacts: [],
          problems: [],
        },
      });

      if (isTerminalKind) {
        const goalReviewTaskId = fixtureHarness.createTask({
          runId,
          role: "goal-review",
          goal: "Review terminal delivery",
          prompt: "Return a terminal decision.",
        });
        fixtureHarness.recordAttempt({
          taskId: goalReviewTaskId,
          input: { executor: "test" },
          output: {
            status: "done",
            runDecision: "complete",
            summary: "Terminal delivery is complete",
            changedFiles: [],
            checks: [{ name: "goal", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        });
        fixtureHarness.updateRunStatus({ runId, status: "done" });
      }

      const targetBaseSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
      const pathHash = createHash("sha256").update(await readFile(join(worktreePath, path))).digest("hex");
      const integrationClosure: Record<string, unknown> = {
        targetBaseSha,
        sourceTaskIds: [workerTaskId],
        sourceAttemptIds: [workerAttemptId],
        paths: [path],
        pathHashes: { [path]: pathHash },
        verifierTaskId,
        frozenCommands: ["true"],
      };
      if (kind === "incomplete") {
        delete integrationClosure.pathHashes;
      } else if (kind === "stale") {
        integrationClosure.targetBaseSha = "0".repeat(40);
      } else if (kind === "hash-mismatch") {
        integrationClosure.pathHashes = { [path]: "f".repeat(64) };
      } else if (kind === "unknown-field") {
        integrationClosure.unfrozenOverride = true;
      }

      const result = applyHarnessAction(fixtureHarness, {
        type: "integrateVerifiedRun",
        runId,
        workerTaskId,
        repoPath,
        targetBranch: "main",
        ...(kind === "missing-terminal"
          ? {}
          : kind === "command-only-terminal"
            ? { integrationClosure: { verifierTaskId, frozenCommands: ["true"] } }
            : { integrationClosure }),
      });

      expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
      expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetBaseSha);
      expect(fixtureHarness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);
    }
  });

  test("verifies a complete closure on a clean candidate and integrates exactly once", async () => {
    const repoPath = join(dir, "repo-complete-closure");
    const worktreePath = join(dir, "worker-complete-closure");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    await mkdir(join(repoPath, "bin"), { recursive: true });
    await writeFile(join(repoPath, "bin", "orbs"), "#!/bin/sh\nexit 0\n");
    await chmod(join(repoPath, "bin", "orbs"), 0o755);
    await mkdir(join(repoPath, "node_modules"), { recursive: true });
    await mkdir(join(repoPath, "packages", "cli", "node_modules", "@fixture"), { recursive: true });
    await mkdir(join(repoPath, "packages", "shared"), { recursive: true });
    await writeFile(join(repoPath, "packages", "shared", "index.ts"), "export const local = true;\n");
    await symlink("../../../shared", join(repoPath, "packages", "cli", "node_modules", "@fixture", "shared"));
    await writeFile(join(repoPath, ".gitignore"), "node_modules/\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "core.autocrlf", "false"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md", "bin/orbs", ".gitignore", "packages/shared/index.ts"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-complete-closure", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    const path = "src/verified.ts";
    await writeFile(join(worktreePath, path), "export const verified = true;\n");
    await writeFile(join(repoPath, "TARGET.md"), "target branch advanced\n");
    git(repoPath, ["add", "TARGET.md"]);
    git(repoPath, ["commit", "-m", "Advance target branch"]);

    const runId = harness.createRun({ goal: "Verify a complete integration closure", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Create the verified file",
      prompt: "Create src/verified.ts.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created verified file",
        changedFiles: [path],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the complete closure",
      prompt: "Verify the complete closure.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["test -d node_modules && test -d packages/cli/node_modules && test \"$(cd packages/cli/node_modules/@fixture/shared && pwd -P)\" = \"$(cd packages/shared && pwd -P)\" && ./bin/orbs && test -f TARGET.md && test -f src/verified.ts"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified the complete closure",
        changedFiles: [],
        checks: [{ name: "verifier", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const targetBaseSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const pathHash = createHash("sha256").update(await readFile(join(worktreePath, path))).digest("hex");
    const integrationClosure = {
      targetBaseSha,
      sourceTaskIds: [workerTaskId],
      sourceAttemptIds: [workerAttemptId],
      paths: [path],
      pathHashes: { [path]: pathHash },
      verifierTaskId,
      frozenCommands: ["test -d node_modules && test -d packages/cli/node_modules && test \"$(cd packages/cli/node_modules/@fixture/shared && pwd -P)\" = \"$(cd packages/shared && pwd -P)\" && ./bin/orbs && test -f TARGET.md && test -f src/verified.ts"],
    };

    const first = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure,
    }, {
      runCommand: (input) => {
        expect(realpathSync(join(input.cwd, "packages", "cli", "node_modules", "@fixture", "shared")))
          .toBe(realpathSync(join(input.cwd, "packages", "shared")));
        const result = Bun.spawnSync({
          cmd: ["/bin/zsh", "-lc", input.command],
          cwd: input.cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: result.exitCode,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
        };
      },
    });
    const headAfterFirst = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const second = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure,
    });

    expect(first).toMatchObject({ status: "done", actionType: "integrateVerifiedRun" });
    expect(first.checks).toContainEqual(expect.objectContaining({ name: "clean candidate verifier", status: "passed" }));
    expect(first.artifacts).toContainEqual(expect.objectContaining({
      kind: "integration",
      targetBaseSha,
      sourceTaskIds: [workerTaskId],
      sourceAttemptIds: [workerAttemptId],
      verifierTaskId,
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      pathHashes: { [path]: pathHash },
      independentReadback: { [path]: pathHash },
      materializedReadback: { [path]: pathHash },
    }));
    expect(second).toMatchObject({ status: "done", actionType: "integrateVerifiedRun" });
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headAfterFirst);
    expect(await readFile(join(repoPath, "TARGET.md"), "utf8")).toBe("target branch advanced\n");
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(1);
  });

  test("blocks a clean candidate when an internal workspace dependency is absent from the candidate tree", async () => {
    const repoPath = join(dir, "repo-missing-candidate-workspace");
    const worktreePath = join(dir, "worker-missing-candidate-workspace");
    await mkdir(join(repoPath, "packages", "cli", "node_modules", "@fixture"), { recursive: true });
    await mkdir(join(repoPath, "packages", "missing-workspace"), { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    await writeFile(join(repoPath, ".gitignore"), "node_modules/\npackages/missing-workspace/\n");
    await writeFile(join(repoPath, "packages", "missing-workspace", "index.ts"), "export const uncommitted = true;\n");
    await symlink("../../../missing-workspace", join(repoPath, "packages", "cli", "node_modules", "@fixture", "missing-workspace"));
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "core.autocrlf", "false"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md", ".gitignore"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-missing-candidate-workspace", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    const path = "src/verified.ts";
    await writeFile(join(worktreePath, path), "export const verified = true;\n");

    const runId = harness.createRun({ goal: "Reject missing candidate workspace", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Create the verified file",
      prompt: "Create src/verified.ts.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created verified file",
        changedFiles: [path],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the complete closure",
      prompt: "Verify the complete closure.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["true"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified the complete closure",
        changedFiles: [],
        checks: [{ name: "verifier", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const targetBaseSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const pathHash = createHash("sha256").update(await readFile(join(worktreePath, path))).digest("hex");
    let ranFrozenCommand = false;
    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure: {
        targetBaseSha,
        sourceTaskIds: [workerTaskId],
        sourceAttemptIds: [workerAttemptId],
        paths: [path],
        pathHashes: { [path]: pathHash },
        verifierTaskId,
        frozenCommands: ["true"],
      },
    }, {
      runCommand: () => {
        ranFrozenCommand = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join("\n")).toContain("could not bind the existing dependency trees");
    expect(ranFrozenCommand).toBe(false);
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetBaseSha);
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);
  });

  test("blocks a stale source when its verified path overlaps a newer target commit", async () => {
    const repoPath = join(dir, "repo-overlapping-candidate-source");
    const worktreePath = join(dir, "worker-overlapping-candidate-source");
    await mkdir(join(repoPath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "shared.ts"), "export const value = 'base';\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "core.autocrlf", "false"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "src/shared.ts"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-overlapping-candidate-source", worktreePath, "main"]);
    await writeFile(join(worktreePath, "src", "shared.ts"), "export const value = 'worker';\n");
    await writeFile(join(repoPath, "src", "shared.ts"), "export const value = 'target';\n");
    git(repoPath, ["add", "src/shared.ts"]);
    git(repoPath, ["commit", "-m", "Advance target path"]);

    const runId = harness.createRun({ goal: "Reject overlapping source history", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change the shared file",
      prompt: "Change src/shared.ts.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Changed shared file",
        changedFiles: ["src/shared.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the shared file",
      prompt: "Verify src/shared.ts.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["true"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified shared file",
        changedFiles: [],
        checks: [{ name: "verifier", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const targetBaseSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const pathHash = createHash("sha256").update(await readFile(join(worktreePath, "src", "shared.ts"))).digest("hex");
    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure: {
        targetBaseSha,
        sourceTaskIds: [workerTaskId],
        sourceAttemptIds: [workerAttemptId],
        paths: ["src/shared.ts"],
        pathHashes: { "src/shared.ts": pathHash },
        verifierTaskId,
        frozenCommands: ["true"],
      },
    });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join("\n")).toContain("overlaps target branch changes: src/shared.ts");
    expect(await readFile(join(repoPath, "src", "shared.ts"), "utf8")).toBe("export const value = 'target';\n");
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetBaseSha);
    expect(harness.listHarnessActionEvents({ limit: 10 }).filter((event) => event.status === "done")).toHaveLength(0);
  });

  test("rolls back when the source drifts after candidate verification and post-integration readback fails", async () => {
    const repoPath = join(dir, "repo-post-readback-drift");
    const worktreePath = join(dir, "worker-post-readback-drift");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-post-readback-drift", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    const path = "src/drift.ts";
    await writeFile(join(worktreePath, path), "export const frozen = true;\n");

    const runId = harness.createRun({
      goal: "Fail closed on post-integration drift",
      projectRoot: repoPath,
      context: { source: "design", designProposalId: "design_post_readback_fixture" },
    });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Create the frozen file",
      prompt: "Create src/drift.ts.",
      worktreePath,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created the frozen file",
        changedFiles: [path],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify the frozen file",
      prompt: "Run the frozen command.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["true"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified the frozen file",
        changedFiles: [],
        checks: [{ name: "verifier", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review terminal delivery",
      prompt: "Return complete.",
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
    harness.updateRunStatus({ runId, status: "done" });
    const targetBaseSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const pathHash = createHash("sha256").update(await readFile(join(worktreePath, path))).digest("hex");

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      repoPath,
      targetBranch: "main",
      integrationClosure: {
        targetBaseSha,
        sourceTaskIds: [workerTaskId],
        sourceAttemptIds: [workerAttemptId],
        paths: [path],
        pathHashes: { [path]: pathHash },
        verifierTaskId,
        frozenCommands: ["true"],
      },
    }, {
      runCommand: () => {
        writeFileSync(join(worktreePath, path), "export const drifted = true;\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join(" ")).toContain("committed hash mismatch");
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(targetBaseSha);
    expect(await Bun.file(join(repoPath, path)).exists()).toBe(false);
    expect(harness.listHarnessActionEvents({ limit: 20 }).filter((event) => event.status === "done")).toHaveLength(0);
  });

  test("redacts Git credential echoes from blocked integration results and audits", async () => {
    const scenario = await createDisjointBranchIntegrationScenario(harness, dir);
    const secret = "watchdog-integration-secret";
    const runGit = (input: { cwd: string; args: string[] }) => {
      if (input.cwd === scenario.repoPath && input.args.join(" ") === "branch --show-current") {
        return {
          exitCode: 1,
          stdout: `token=${secret}`,
          stderr: `Authorization: Bearer ${secret}`,
        };
      }
      return rawGit(input.cwd, input.args);
    };

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId: scenario.runId,
      workerTaskId: scenario.workerTaskId,
      repoPath: scenario.repoPath,
      targetBranch: "main",
      push: false,
    }, { runGit });
    const event = harness.getHarnessActionEvent({ id: result.eventId });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).toContain("[REDACTED]");
  });

  test("blocks when independent preserved-path readback fails", async () => {
    const scenario = await createDisjointBranchIntegrationScenario(harness, dir);
    let sabotaged = false;
    const runGit = (input: { cwd: string; args: string[] }) => {
      const result = rawGit(input.cwd, input.args);
      if (!sabotaged && input.cwd === scenario.repoPath && input.args[0] === "hash-object") {
        sabotaged = true;
        return { ...result, stdout: `${"0".repeat(40)}\n` };
      }
      return result;
    };

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId: scenario.runId,
      workerTaskId: scenario.workerTaskId,
      repoPath: scenario.repoPath,
      targetBranch: "main",
    }, { runGit });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join(" ")).toContain("readback mismatch");
    expect(result.artifacts).toHaveLength(0);
    expect(sabotaged).toBe(true);
  });

  test("treats an already merged verified worker as an idempotent integration", async () => {
    const repoPath = join(dir, "repo-already-merged");
    const worktreePath = join(dir, "worker-tree-already-merged");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-already-merged", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "merged.ts"), "export const merged = true;\n");

    const runId = harness.createRun({ goal: "Integrate verified work idempotently", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement merged file",
      prompt: "Create src/merged.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created merged file",
        changedFiles: ["src/merged.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify merged file",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified merged file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const first = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate already merged worker",
      reason: "first integration",
    });
    const headAfterFirst = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const second = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate already merged worker again",
      reason: "retry after interrupted integration bookkeeping",
    });
    const headAfterSecond = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

    expect(first.status).toBe("done");
    expect(second).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("already integrated"),
    });
    expect(second.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        workerTaskId,
        verifierTaskId,
        alreadyMerged: true,
      }),
    );
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  test("integration readiness uses the latest verifier for a worker", () => {
    const runId = harness.createRun({ goal: "Use current verifier evidence" });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement current delivery",
      prompt: "Change src/current.ts.",
      worktreePath: join(dir, "worker-current-verifier"),
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Changed current delivery",
        changedFiles: ["src/current.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const firstVerifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "First verification",
      prompt: "Verify once.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: firstVerifierId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "First verification passed",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const blockedVerifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Current blocked verification",
      prompt: "Verify again.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: blockedVerifierId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Current verification failed",
        changedFiles: [],
        checks: [{ name: "verify", status: "failed" }],
        artifacts: [],
        problems: ["current verification failed"],
      },
    });

    expect(describeIntegrationReadiness(harness, runId).unintegrated).toHaveLength(0);

    const latestVerifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Latest successful verification",
      prompt: "Verify after repair.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: latestVerifierId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Latest verification passed",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    expect(describeIntegrationReadiness(harness, runId).unintegrated).toEqual([
      expect.objectContaining({
        taskId: workerTaskId,
        verifierTaskId: latestVerifierId,
        changedFiles: ["src/current.ts"],
      }),
    ]);
  });

  describe("same-branch contained worker commit bookkeeping", () => {
    async function createScenario(input: {
      artifactFactory?: (commits: { workerCommit: string; unrelatedCommit: string }) => unknown[];
      changedFiles?: string[];
      dirty?: boolean;
      foreignWorktree?: boolean;
      verifierFailed?: boolean;
    } = {}) {
      const repoPath = join(dir, `repo-contained-${crypto.randomUUID()}`);
      await mkdir(repoPath, { recursive: true });
      await writeFile(join(repoPath, "README.md"), "initial\n");
      git(repoPath, ["init", "-b", "main"]);
      git(repoPath, ["config", "user.name", "Ouroboros Test"]);
      git(repoPath, ["config", "user.email", "test@example.com"]);
      git(repoPath, ["config", "commit.gpgSign", "false"]);
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);

      git(repoPath, ["checkout", "-b", "unrelated-artifact"]);
      await writeFile(join(repoPath, "unrelated.txt"), "unrelated\n");
      git(repoPath, ["add", "unrelated.txt"]);
      git(repoPath, ["commit", "-m", "Unrelated artifact commit"]);
      const unrelatedCommit = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
      git(repoPath, ["checkout", "main"]);

      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(repoPath, "src", "contained.ts"), "export const contained = true;\n");
      git(repoPath, ["add", "src/contained.ts"]);
      git(repoPath, ["commit", "-m", "Worker artifact commit"]);
      const workerCommit = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
      await writeFile(join(repoPath, "later.txt"), "later delivery\n");
      git(repoPath, ["add", "later.txt"]);
      git(repoPath, ["commit", "-m", "Later delivery contains worker"]);
      const targetHead = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

      let worktreePath = repoPath;
      if (input.foreignWorktree) {
        worktreePath = join(dir, `repo-contained-foreign-${crypto.randomUUID()}`);
        await mkdir(worktreePath, { recursive: true });
        await writeFile(join(worktreePath, "README.md"), "foreign repository\n");
        git(worktreePath, ["init", "-b", "main"]);
        git(worktreePath, ["config", "user.name", "Ouroboros Test"]);
        git(worktreePath, ["config", "user.email", "test@example.com"]);
        git(worktreePath, ["config", "commit.gpgSign", "false"]);
        git(worktreePath, ["add", "README.md"]);
        git(worktreePath, ["commit", "-m", "Foreign repository commit"]);
      }

      const runId = harness.createRun({ goal: "Record contained worker integration", projectRoot: repoPath });
      const workerTaskId = harness.createTask({
        runId,
        role: "worker",
        goal: "Commit directly on the delivery branch",
        prompt: "Commit src/contained.ts on main.",
        worktreePath,
      });
      const artifacts = input.artifactFactory?.({ workerCommit, unrelatedCommit }) ?? [{
        kind: "git_commit",
        sha: workerCommit,
        branch: "main",
      }];
      harness.recordAttempt({
        taskId: workerTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Committed verified work directly on main",
          changedFiles: input.changedFiles ?? ["src/contained.ts"],
          checks: [{ name: "worker", status: "passed" }],
          artifacts,
          problems: [],
        },
      });
      const verifierTaskId = harness.createTask({
        runId,
        role: "verifier",
        goal: "Verify contained worker commit",
        prompt: "Verify src/contained.ts.",
        dependsOn: [workerTaskId],
      });
      harness.recordAttempt({
        taskId: verifierTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: input.verifierFailed ? "Verification failed" : "Contained commit verified",
          changedFiles: [],
          checks: [{ name: "verify", status: input.verifierFailed ? "failed" : "passed" }],
          artifacts: [],
          problems: input.verifierFailed ? ["verification failed"] : [],
        },
      });
      harness.updateRunStatus({ runId, status: "blocked" });
      if (input.dirty) {
        await writeFile(join(repoPath, "src", "contained.ts"), "export const contained = 'dirty';\n");
      }
      return { repoPath, worktreePath, runId, workerTaskId, verifierTaskId, workerCommit, unrelatedCommit, targetHead };
    }

    test("records an already-contained same-branch worker commit and replays idempotently", async () => {
      const scenario = await createScenario();

      const first = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: scenario.runId,
        workerTaskId: scenario.workerTaskId,
        repoPath: scenario.repoPath,
        targetBranch: "main",
      });
      const second = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: scenario.runId,
        workerTaskId: scenario.workerTaskId,
        repoPath: scenario.repoPath,
        targetBranch: "main",
      });
      const readiness = describeIntegrationReadiness(harness, scenario.runId);

      expect(first).toMatchObject({ status: "done", actionType: "integrateVerifiedRun" });
      expect(second).toMatchObject({ status: "done", actionType: "integrateVerifiedRun" });
      expect(first.artifacts).toContainEqual(expect.objectContaining({
        kind: "integration",
        mode: "contained_worker_commit",
        workerTaskId: scenario.workerTaskId,
        verifierTaskId: scenario.verifierTaskId,
        workerCommit: scenario.workerCommit,
        mergeCommit: scenario.targetHead,
        targetBranch: "main",
        sourceBranch: "main",
        alreadyMerged: true,
      }));
      expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.targetHead);
      expect(readiness.unintegrated).toHaveLength(0);
      expect(readiness.integratedWorkerTaskIds.has(scenario.workerTaskId)).toBe(true);
    });

    test("blocks missing and ambiguous git_commit artifacts", async () => {
      const cases = [
        await createScenario({ artifactFactory: () => [] }),
        await createScenario({
          artifactFactory: ({ workerCommit }) => [
            { kind: "git_commit", sha: workerCommit, branch: "main" },
            { kind: "git_commit", sha: workerCommit, branch: "main" },
          ],
        }),
      ];

      for (const scenario of cases) {
        const result = applyHarnessAction(harness, {
          type: "integrateVerifiedRun",
          runId: scenario.runId,
          workerTaskId: scenario.workerTaskId,
          repoPath: scenario.repoPath,
          targetBranch: "main",
        });
        expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
        expect(result.problems.join(" ")).toContain("exactly one git_commit artifact");
      }
    });

    test("blocks malformed and branch-mismatched git_commit artifacts", async () => {
      const cases = [
        await createScenario({
          artifactFactory: () => [{ kind: "git_commit", sha: "0000000000000000000000000000000000000000", branch: "main" }],
        }),
        await createScenario({
          artifactFactory: ({ workerCommit }) => [{ kind: "git_commit", sha: workerCommit, branch: "release" }],
        }),
      ];

      const malformed = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: cases[0].runId,
        workerTaskId: cases[0].workerTaskId,
        repoPath: cases[0].repoPath,
        targetBranch: "main",
      });
      const branchMismatch = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: cases[1].runId,
        workerTaskId: cases[1].workerTaskId,
        repoPath: cases[1].repoPath,
        targetBranch: "main",
      });

      expect(malformed.problems.join(" ")).toContain("non-zero full 40-character SHA");
      expect(branchMismatch.problems.join(" ")).toContain("does not match target branch main");
    });

    test("blocks a commit from another repository or a non-ancestor commit", async () => {
      const missingFromRepo = await createScenario({
        artifactFactory: () => [{ kind: "git_commit", sha: "3333333333333333333333333333333333333333", branch: "main" }],
      });
      const nonAncestor = await createScenario({
        artifactFactory: ({ unrelatedCommit }) => [{ kind: "git_commit", sha: unrelatedCommit, branch: "main" }],
      });

      const missingResult = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: missingFromRepo.runId,
        workerTaskId: missingFromRepo.workerTaskId,
        repoPath: missingFromRepo.repoPath,
        targetBranch: "main",
      });
      const nonAncestorResult = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: nonAncestor.runId,
        workerTaskId: nonAncestor.workerTaskId,
        repoPath: nonAncestor.repoPath,
        targetBranch: "main",
      });

      expect(missingResult.problems.join(" ")).toContain("does not belong to the target repository");
      expect(nonAncestorResult.problems.join(" ")).toContain("is not an ancestor of target HEAD");
    });

    test("blocks a same-named branch from a foreign worker repository", async () => {
      const scenario = await createScenario({ foreignWorktree: true });

      const result = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: scenario.runId,
        workerTaskId: scenario.workerTaskId,
        repoPath: scenario.repoPath,
        targetBranch: "main",
      });

      expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
      expect(result.problems.join(" ")).toContain("does not belong to the target repository");
    });

    test("blocks when attempt changedFiles do not match the contained commit", async () => {
      const scenario = await createScenario({ changedFiles: ["src/not-in-commit.ts"] });

      const result = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: scenario.runId,
        workerTaskId: scenario.workerTaskId,
        repoPath: scenario.repoPath,
        targetBranch: "main",
      });

      expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
      expect(result.problems.join(" ")).toContain("changedFiles do not match git_commit");
    });

    test("blocks dirty same-branch worktrees and failed verifier evidence", async () => {
      const dirty = await createScenario({ dirty: true });
      const failedVerifier = await createScenario({ verifierFailed: true });

      const dirtyResult = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: dirty.runId,
        workerTaskId: dirty.workerTaskId,
        repoPath: dirty.repoPath,
        targetBranch: "main",
      });
      const verifierResult = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: failedVerifier.runId,
        workerTaskId: failedVerifier.workerTaskId,
        repoPath: failedVerifier.repoPath,
        targetBranch: "main",
      });

      expect(dirtyResult.problems.join(" ")).toContain("target repository must be clean for same-branch integration");
      expect(verifierResult.problems.join(" ")).toContain("no completed verifier evidence");
    });
  });

  test("integrates an explicitly verified worker before the whole run is complete", async () => {
    const repoPath = join(dir, "repo-precomplete");
    const worktreePath = join(dir, "worker-tree-precomplete");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-precomplete", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "pause.ts"), "export const paused = true;\n");

    const runId = harness.createRun({ goal: "Integrate verified partial work", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement pause file",
      prompt: "Create src/pause.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created pause file",
        changedFiles: ["src/pause.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
      config: { verifierContract: { deterministicChecks: ["true"] } },
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified pause file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate verified partial worker",
      reason: "make verified partial work visible to goal review",
    });

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        workerTaskId,
        verifierTaskId,
        goalReviewTaskId: null,
        preCompletion: true,
      }),
    );
    const mergedFile = await readFile(join(repoPath, "src", "pause.ts"), "utf8");
    expect(mergedFile.trim()).toBe("export const paused = true;");
  });

  test("commits verified worker files that were already materialized in the target repository", async () => {
    const repoPath = join(dir, "repo-materialized");
    const worktreePath = join(dir, "worker-tree-materialized");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(worktreePath, "src", "landing.ts"), "export const landing = true;\n");

    const runId = harness.createRun({ goal: "Integrate materialized worker output", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing page",
      prompt: "Create src/landing.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created landing page file",
        changedFiles: ["src/landing.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing page",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing page",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate materialized landing page",
      reason: "worker files were copied to the target repository before integration",
    });
    const committedFile = await readFile(join(repoPath, "src", "landing.ts"), "utf8");
    const log = git(repoPath, ["log", "--oneline", "-1"]).stdout;

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("Committed materialized verified task"),
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "target path classification",
        status: "passed",
        evidence: "verified=src/landing.ts;preserved=none",
      }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        mode: "materialized_target_commit",
        workerTaskId,
        verifierTaskId,
        targetBranch: "main",
        materializedFiles: ["src/landing.ts"],
      }),
    );
    expect(committedFile.trim()).toBe("export const landing = true;");
    expect(log).toContain("Integrate materialized landing page");
    expect(git(repoPath, ["status", "--short"]).stdout.trim()).toBe("");
  });

  test("integrates disjoint materialized changes while preserving staged and untracked target edits", async () => {
    const repoPath = join(dir, "repo-materialized-unrelated");
    const worktreePath = join(dir, "worker-tree-materialized-unrelated");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized-unrelated", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(worktreePath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(repoPath, "README.md"), "operator edit\n");
    git(repoPath, ["add", "README.md"]);
    await writeFile(join(repoPath, "NOTES.md"), "human note\n");

    const runId = harness.createRun({ goal: "Preserve unrelated target changes", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing page",
      prompt: "Create src/landing.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created landing page file",
        changedFiles: ["src/landing.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing page",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing page",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate verified landing page",
      reason: "supervisor integrated verified worker before goal review",
    });

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("Committed materialized verified task"),
    });
    expect(await readFile(join(repoPath, "src", "landing.ts"), "utf8")).toBe("export const landing = true;\n");
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("operator edit\n");
    expect(await readFile(join(repoPath, "NOTES.md"), "utf8")).toBe("human note\n");
    expect(git(repoPath, ["status", "--short"]).stdout).toContain("M  README.md");
    expect(git(repoPath, ["status", "--short"]).stdout).toContain("?? NOTES.md");
    expect(git(repoPath, ["show", "--format=", "--name-only", "HEAD"]).stdout).toContain("src/landing.ts");
  });

  test("blocks overlapping target edits without changing target HEAD or status", async () => {
    const repoPath = join(dir, "repo-materialized-overlap");
    const worktreePath = join(dir, "worker-tree-materialized-overlap");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized-overlap", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "landing.ts"), "operator version\n");
    await writeFile(join(worktreePath, "src", "landing.ts"), "verified version\n");

    const runId = harness.createRun({ goal: "Reject overlapping target changes", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing page",
      prompt: "Create src/landing.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created landing page",
        changedFiles: ["src/landing.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing page",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing page",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const headBefore = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const statusBefore = git(repoPath, ["status", "--short"]).stdout;
    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Must reject overlap",
    });

    expect(result).toMatchObject({ status: "blocked", actionType: "integrateVerifiedRun" });
    expect(result.problems.join(" ")).toContain("overlap");
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
    expect(git(repoPath, ["status", "--short"]).stdout).toBe(statusBefore);
  });

  test("blocks materialized integration when a dirty path is a rename record", async () => {
    const repoPath = join(dir, "repo-materialized-rename");
    const worktreePath = join(dir, "worker-tree-materialized-rename");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    await writeFile(join(repoPath, "OPERATOR.md"), "operator note\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md", "OPERATOR.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized-rename", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(repoPath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(worktreePath, "src", "landing.ts"), "export const landing = true;\n");
    // Stage an unrelated operator rename so porcelain reports `R`.
    git(repoPath, ["mv", "OPERATOR.md", "OPERATOR-RENAMED.md"]);
    const headBefore = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
    const porcelainBefore = git(repoPath, ["status", "--short"]).stdout;

    const runId = harness.createRun({ goal: "Reject rename in target changes", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing page",
      prompt: "Create src/landing.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created landing page file",
        changedFiles: ["src/landing.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing page",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing page",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Should not integrate when a rename is staged",
    });

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("renamed path"),
    });
    expect(result.problems).toContainEqual(expect.stringContaining("rename detected"));
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
    expect(git(repoPath, ["status", "--short"]).stdout).toBe(porcelainBefore);
  });

  test("blocks materialized integration when dirty and verified paths collide as file and directory", async () => {
    const repoPath = join(dir, "repo-materialized-collision");
    const worktreePath = join(dir, "worker-tree-materialized-collision");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized-collision", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src", "landing"), { recursive: true });
    await writeFile(join(worktreePath, "src", "landing", "index.ts"), "export const nested = true;\n");
    // Operator dirty path `src/landing` (file) collides with worker `src/landing/index.ts` (under a directory).
    await writeFile(join(repoPath, "src", "landing"), "operator file\n");
    const headBefore = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

    const runId = harness.createRun({ goal: "Reject file/directory collision", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing nested module",
      prompt: "Create src/landing/index.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created nested module",
        changedFiles: ["src/landing/index.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing nested module",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing nested module",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Should not integrate a file/directory collision",
    });

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("overlap"),
    });
    expect(result.problems).toContainEqual(
      expect.stringContaining("overlap between verified src/landing/index.ts and disjoint src/landing"),
    );
    expect(git(repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
    expect(await readFile(join(repoPath, "src", "landing"), "utf8")).toBe("operator file\n");
  });

  test("ignores Ouroboros runtime files when integrating materialized target changes", async () => {
    const repoPath = join(dir, "repo-materialized-runtime-files");
    const worktreePath = join(dir, "worker-tree-materialized-runtime-files");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-materialized-runtime-files", worktreePath, "main"]);
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await mkdir(join(repoPath, ".ouroboros"), { recursive: true });
    await writeFile(join(repoPath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(worktreePath, "src", "landing.ts"), "export const landing = true;\n");
    await writeFile(join(repoPath, ".ouroboros", "ouroboros.db"), "runtime state\n");

    const runId = harness.createRun({ goal: "Ignore runtime files", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Build landing page",
      prompt: "Create src/landing.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created landing page file",
        changedFiles: ["src/landing.ts", ".ouroboros/ouroboros.db"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify landing page",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified landing page",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate materialized landing page",
    });

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
    });
    expect(git(repoPath, ["log", "--oneline", "-1"]).stdout).toContain("Integrate materialized landing page");
    expect(git(repoPath, ["status", "--short"]).stdout).toContain("?? .ouroboros/");
  });

  test("blocks integration when verifier evidence is missing", () => {
    const runId = harness.createRun({ goal: "Reject unverified integration" });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Unverified worker",
      prompt: "Do work.",
      worktreePath: "/tmp/unverified-worker",
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Changed files",
        changedFiles: ["src/app.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId, status: "done" });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      problems: [expect.stringContaining("no completed verifier evidence")],
    });
    expect(event).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "blocked",
    });
  });

  test("redirects integration to the source worker worktree when a verified repair worker has no diff", async () => {
    const repoPath = join(dir, "repo-repair-redirect");
    const sourceWorktreePath = join(dir, "worker-tree-source");
    const repairWorktreePath = join(dir, "worker-tree-repair");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-source-worker", sourceWorktreePath, "main"]);
    git(repoPath, ["worktree", "add", "-b", "task-repair-worker", repairWorktreePath, "main"]);
    // The actual change lands in the source worker worktree (uncommitted).
    await mkdir(join(sourceWorktreePath, "src"), { recursive: true });
    await writeFile(join(sourceWorktreePath, "src", "fixed.ts"), "export const fixed = true;\n");
    // The repair worker worktree is clean (the agent edited the source path, not its own).

    const runId = harness.createRun({ goal: "Integrate repair that edited the source worker worktree", projectRoot: repoPath });
    const sourceWorkerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Original source worker",
      prompt: "Edit src/fixed.ts.",
      worktreePath: sourceWorktreePath,
    });
    harness.recordAttempt({
      taskId: sourceWorkerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Edited source worker file",
        changedFiles: ["src/fixed.ts"],
        checks: [{ name: "source worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const blockingVerifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Reject initial source worker output",
      prompt: "Block the source worker.",
      dependsOn: [sourceWorkerTaskId],
    });
    harness.recordAttempt({
      taskId: blockingVerifierTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Initial source worker output needed repair",
        changedFiles: [],
        checks: [{ name: "verifier", status: "failed" }],
        artifacts: [
          { kind: "created_repair_task", taskId: "placeholder", verifierTaskId: blockingVerifierTaskId },
        ],
        problems: ["source worker output needed repair"],
      },
    });
    const repairWorkerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair: address verifier feedback",
      prompt: "Edit src/fixed.ts in the source worker worktree.",
      worktreePath: repairWorktreePath,
      parentId: blockingVerifierTaskId,
    });
    harness.recordAttempt({
      taskId: repairWorkerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Repair applied to source worker worktree",
        changedFiles: ["src/fixed.ts"],
        checks: [{ name: "repair", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const repairVerifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify repaired worker output",
      prompt: "Verify repair.",
      dependsOn: [repairWorkerTaskId],
    });
    harness.recordAttempt({
      taskId: repairVerifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Repair verified",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Mark repair run complete",
      prompt: "Mark the run complete.",
    });
    harness.recordAttempt({
      taskId: goalReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Repair complete",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId, status: "done" });

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId: repairWorkerTaskId,
      commitMessage: "Integrate redirected repair",
      reason: "supervisor picks verified repair",
    });
    const readinessAfter = describeIntegrationReadiness(harness, runId);
    const integratedFile = await readFile(join(repoPath, "src", "fixed.ts"), "utf8").catch(() => null);
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({ status: "done", actionType: "integrateVerifiedRun" });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "repair redirected to source worktree",
        status: "passed",
        evidence: expect.stringContaining(sourceWorkerTaskId),
      }),
    );
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        mode: "branch_merge",
        runId,
        workerTaskId: repairWorkerTaskId,
        verifierTaskId: repairVerifierTaskId,
        worktreePath: sourceWorktreePath,
        sourceBranch: "task-source-worker",
        changedFiles: ["src/fixed.ts"],
      }),
    );
    expect(integratedFile?.trim()).toBe("export const fixed = true;");
    expect(readinessAfter.unintegrated).toHaveLength(0);
    expect(readinessAfter.integratedWorkerTaskIds.has(repairWorkerTaskId)).toBe(true);
    expect(event).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ workerTaskId: repairWorkerTaskId }),
    });
  });

  test("blocks concurrent integrateVerifiedRun actions when MERGE_HEAD exists on the target repository", async () => {
    const repoPath = join(dir, "repo-concurrent");
    const worktreePath = join(dir, "worker-tree-concurrent");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-concurrent", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "merge.ts"), "export const merged = true;\n");

    const runId = harness.createRun({ goal: "Serialize integration actions", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Worker for merge-head test",
      prompt: "Edit src/merge.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Worker for merge-head test",
        changedFiles: ["src/merge.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Mark complete",
      prompt: "Mark run complete.",
    });
    harness.recordAttempt({
      taskId: goalReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Goal reached",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId, status: "done" });

    // Simulate a concurrent in-progress merge on the target repository by writing MERGE_HEAD.
    await writeFile(join(repoPath, ".git", "MERGE_HEAD"), "0123456789abcdef0123456789abcdef01234567\n");

    const result = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Should not run while MERGE_HEAD exists",
      reason: "concurrent integration attempt",
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("unfinished merge"),
    });
    expect(result.problems).toContainEqual(expect.stringContaining("MERGE_HEAD"));
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "integration preflight", status: "failed", evidence: expect.stringContaining("MERGE_HEAD") }),
    );
    expect(event).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "blocked",
    });
  });

  test("aborts a failed integration merge and suppresses an unchanged retry", async () => {
    const repoPath = join(dir, "repo-merge-conflict");
    const worktreePath = join(dir, "worker-tree-merge-conflict");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-conflict", worktreePath, "main"]);
    await writeFile(join(worktreePath, "README.md"), "worker change\n");
    git(worktreePath, ["add", "README.md"]);
    git(worktreePath, ["commit", "-m", "Worker change"]);
    await writeFile(join(repoPath, "README.md"), "main change\n");
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Main change"]);

    const runId = harness.createRun({ goal: "Bound conflicting integration", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change README",
      prompt: "Change README.md.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Changed README",
        changedFiles: ["README.md"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify README",
      prompt: "Verify README.md.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified README",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const first = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Conflicting integration",
    });
    const second = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Conflicting integration",
    });
    const integrationEvents = harness
      .listHarnessActionEvents({ limit: 10 })
      .filter((event) => event.actionType === "integrateVerifiedRun");

    expect(first.status).toBe("blocked");
    expect(second.eventId).toBe(first.eventId);
    expect(integrationEvents).toHaveLength(1);
    expect(git(repoPath, ["status", "--short"]).stdout.trim()).toBe("");
    expect((await readFile(join(repoPath, "README.md"), "utf8")).trim()).toBe("main change");
  });

  test("refuses to mark a run done while verified worker changes remain unintegrated", async () => {
    const repoPath = join(dir, "repo-unintegrated");
    const worktreePath = join(dir, "worker-tree-unintegrated");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-unintegrated", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "pending.ts"), "export const pending = true;\n");

    const runId = harness.createRun({ goal: "Block run completion until integration", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Worker for unintegrated test",
      prompt: "Edit src/pending.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Pending integration",
        changedFiles: ["src/pending.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker",
      prompt: "Verify worker changes.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const goalReviewTaskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Mark complete",
      prompt: "Mark run complete.",
    });
    harness.recordAttempt({
      taskId: goalReviewTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        runDecision: "complete",
        summary: "Goal reached but integration pending",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const readiness = describeIntegrationReadiness(harness, runId);
    expect(readiness.unintegrated).toHaveLength(1);
    expect(readiness.unintegrated[0]).toMatchObject({
      taskId: workerTaskId,
      verifierTaskId,
      changedFiles: ["src/pending.ts"],
    });

    const run = harness.getRun(runId);
    expect(run?.status).toBe("todo");

    const integration = applyHarnessAction(harness, {
      type: "integrateVerifiedRun",
      runId,
      workerTaskId,
      commitMessage: "Integrate pending verified worker",
      reason: "complete the run after integration",
    });
    expect(integration).toMatchObject({ status: "done" });

    const readinessAfter = describeIntegrationReadiness(harness, runId);
    expect(readinessAfter.unintegrated).toHaveLength(0);
    expect(readinessAfter.integratedWorkerTaskIds.has(workerTaskId)).toBe(true);
  });

  describe("commitExactGitIndex", () => {
    async function createScenario(input: {
      changedFiles?: string[];
      verifierFailed?: boolean;
      worktreeMode?: "missing" | "foreign";
    } = {}) {
      const repoPath = join(dir, `repo-exact-index-${crypto.randomUUID()}`);
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(repoPath, "README.md"), "initial\n");
      git(repoPath, ["init", "-b", "main"]);
      git(repoPath, ["config", "user.name", "Ouroboros Test"]);
      git(repoPath, ["config", "user.email", "test@example.com"]);
      git(repoPath, ["config", "commit.gpgSign", "false"]);
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);
      const expectedParentSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();

      const failingSigner = join(dir, "failing-gpg");
      await writeFile(failingSigner, "#!/bin/sh\nexit 93\n");
      await chmod(failingSigner, 0o755);
      git(repoPath, ["config", "commit.gpgSign", "true"]);
      git(repoPath, ["config", "gpg.program", failingSigner]);
      await mkdir(join(repoPath, ".git", "hooks"), { recursive: true });
      const failingHook = join(repoPath, ".git", "hooks", "pre-commit");
      await writeFile(failingHook, "#!/bin/sh\nexit 94\n");
      await chmod(failingHook, 0o755);

      await writeFile(join(repoPath, "src", "new.ts"), "export const value = 1;\n");
      git(repoPath, ["add", "src/new.ts"]);
      const blobOid = git(repoPath, ["hash-object", "src/new.ts"]).stdout.trim();
      const commitMessage = "Commit exact verified index";
      const branch = "main";
      const files = [{ status: "A", path: "src/new.ts", mode: "100644", blobOid }];
      const runId = harness.createRun({ goal: "Commit one exact staged index", projectRoot: repoPath });
      let worktreePath: string | null = repoPath;
      if (input.worktreeMode === "missing") {
        worktreePath = null;
      } else if (input.worktreeMode === "foreign") {
        worktreePath = join(dir, `foreign-exact-index-${crypto.randomUUID()}`);
        await mkdir(worktreePath, { recursive: true });
        await writeFile(join(worktreePath, "README.md"), "foreign\n");
        git(worktreePath, ["init", "-b", "main"]);
        git(worktreePath, ["config", "user.name", "Ouroboros Test"]);
        git(worktreePath, ["config", "user.email", "test@example.com"]);
        git(worktreePath, ["config", "commit.gpgSign", "false"]);
        git(worktreePath, ["add", "README.md"]);
        git(worktreePath, ["commit", "-m", "Foreign initial commit"]);
      }
      const taskId = harness.createTask({
        runId,
        role: "worker",
        goal: "Add src/new.ts",
        prompt: "Add the frozen file.",
        worktreePath,
      });
      harness.recordAttempt({
        taskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Staged the frozen file",
          changedFiles: input.changedFiles ?? ["src/new.ts"],
          checks: [{ name: "worker", status: "passed" }],
          artifacts: [],
          problems: [],
        },
      });
      const verifierTaskId = harness.createTask({
        runId,
        role: "verifier",
        goal: "Verify src/new.ts",
        prompt: "Verify the frozen file.",
        dependsOn: [taskId],
      });
      harness.recordAttempt({
        taskId: verifierTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: input.verifierFailed ? "Verifier rejected the frozen file" : "Verified the frozen file",
          changedFiles: [],
          checks: [{ name: "verify", status: input.verifierFailed ? "failed" : "passed" }],
          artifacts: [],
          problems: input.verifierFailed ? ["verification failed"] : [],
        },
      });
      const action = {
        type: "commitExactGitIndex",
        contractId: "exactIndex",
        runId,
        taskId,
        repoPath,
        branch,
        expectedParentSha,
        commitMessage,
        files,
      };
      const freeze = (nextAction: Record<string, unknown> = action) => {
        const contract = Object.fromEntries([
          "runId",
          "taskId",
          "repoPath",
          "branch",
          "expectedParentSha",
          "commitMessage",
          "files",
        ].map((key) => [key, nextAction[key]]));
        harness.updateRun({
          runId,
          contextPatch: { gitIndexCommitContracts: { exactIndex: contract } },
        });
      };
      freeze();
      return {
        action,
        blobOid,
        branch,
        commitMessage,
        expectedParentSha,
        files,
        freeze,
        repoPath,
        runId,
        taskId,
        verifierTaskId,
      };
    }

    function realGitRunner(input: { cwd: string; args: string[] }) {
      const result = Bun.spawnSync({
        cmd: ["git", ...input.args],
        cwd: input.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    }

    test("commits the frozen staged additions without hooks or configured signing", async () => {
      const scenario = await createScenario();
      const result = applyHarnessAction(harness, scenario.action);

      expect(result).toMatchObject({ status: "done", actionType: "commitExactGitIndex" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_commit",
        status: "committed",
        branch: scenario.branch,
        parentSha: scenario.expectedParentSha,
      }));
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "integration",
        mode: "exact_git_index_commit",
        alreadyMerged: true,
        workerTaskId: scenario.taskId,
        verifierTaskId: scenario.verifierTaskId,
      }));
      expect(git(scenario.repoPath, ["status", "--short"]).stdout).toBe("");
      expect(git(scenario.repoPath, ["show", "--format=%G?", "--no-patch", "HEAD"]).stdout.trim()).toBe("N");
      expect(describeIntegrationReadiness(harness, scenario.runId).unintegrated).toHaveLength(0);
      const drain = applyHarnessAction(harness, { type: "prepareRunDrain", runId: scenario.runId });
      expect(drain).toMatchObject({ status: "done", actionType: "prepareRunDrain" });
      expect(drain.artifacts).not.toContainEqual(expect.objectContaining({ kind: "pending_integration" }));
    });

    test("reuses a commit already created from the exact frozen index", async () => {
      const scenario = await createScenario();
      const first = applyHarnessAction(harness, scenario.action);
      const firstHead = git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim();
      const second = applyHarnessAction(harness, scenario.action);

      expect(first).toMatchObject({ status: "done", actionType: "commitExactGitIndex" });
      expect(second).toMatchObject({ status: "done", actionType: "commitExactGitIndex" });
      expect(second.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_commit",
        status: "reused",
        sha: firstHead,
      }));
      expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(firstHead);
    });

    test("recovers a lost update-ref response from independent readback", async () => {
      const scenario = await createScenario();
      const calls: string[][] = [];
      const runGit = (input: { cwd: string; args: string[] }) => {
        calls.push(input.args);
        const result = realGitRunner(input);
        if (input.args[0] === "update-ref") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "fatal: https://oauth2:github_pat_exact_secret@example.com/repo.git Authorization: Bearer exact-bearer",
          };
        }
        return result;
      };

      const result = applyHarnessAction(harness, scenario.action, { runGit });
      const serialized = JSON.stringify(result);

      expect(calls.some((args) => args[0] === "update-ref")).toBe(true);
      expect(result).toMatchObject({ status: "done", actionType: "commitExactGitIndex" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_commit",
        status: "response_loss_recovered",
      }));
      expect(serialized).not.toContain("github_pat_exact_secret");
      expect(serialized).not.toContain("exact-bearer");
    });

    test("blocks when any dependency verifier failed is blocked or is still pending", async () => {
      const mixedFailure = await createScenario();
      const failedVerifierId = harness.createTask({
        runId: mixedFailure.runId,
        role: "verifier",
        goal: "Reject the same worker",
        prompt: "Report a failed check.",
        dependsOn: [mixedFailure.taskId],
      });
      harness.recordAttempt({
        taskId: failedVerifierId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: "Rejected",
          changedFiles: [],
          checks: [{ name: "verify second opinion", status: "failed" }],
          artifacts: [],
          problems: ["verification failed"],
        },
      });

      const blocked = await createScenario();
      const blockedVerifierId = harness.createTask({
        runId: blocked.runId,
        role: "verifier",
        goal: "Blocked verifier",
        prompt: "Cannot complete verification.",
        dependsOn: [blocked.taskId],
      });
      harness.recordAttempt({
        taskId: blockedVerifierId,
        input: { executor: "test" },
        output: {
          status: "blocked",
          summary: "Blocked",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: ["blocked verifier"],
        },
      });

      const pending = await createScenario();
      harness.createTask({
        runId: pending.runId,
        role: "verifier",
        goal: "Pending verifier",
        prompt: "Still waiting.",
        dependsOn: [pending.taskId],
      });

      for (const scenario of [mixedFailure, blocked, pending]) {
        const result = applyHarnessAction(harness, scenario.action);
        expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
        expect(result.problems.join(" ")).toContain("verifier");
        expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "integration" }));
        expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.expectedParentSha);
      }
    }, 15_000);

    test("blocks an index change injected after staged validation before creating or updating a commit", async () => {
      const scenario = await createScenario();
      let polluted = false;
      const calls: string[][] = [];
      const runGit = (input: { cwd: string; args: string[] }) => {
        calls.push(input.args);
        if (!polluted && input.args.join(" ") === "write-tree") {
          polluted = true;
          writeFileSync(join(scenario.repoPath, "evil.ts"), "export const evil = true;\n");
          realGitRunner({ cwd: scenario.repoPath, args: ["add", "evil.ts"] });
        }
        return realGitRunner(input);
      };

      const result = applyHarnessAction(harness, scenario.action, { runGit });

      expect(polluted).toBe(true);
      expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "integration" }));
      expect(calls.some((args) => args.includes("commit-tree"))).toBe(false);
      expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
      expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.expectedParentSha);
      expect(git(scenario.repoPath, ["log", "--format=%s", "-1"]).stdout.trim()).toBe("Initial commit");
    });

    test("blocks an index change injected after commit-tree before updating the branch", async () => {
      const scenario = await createScenario();
      let polluted = false;
      const calls: string[][] = [];
      const runGit = (input: { cwd: string; args: string[] }) => {
        calls.push(input.args);
        const result = realGitRunner(input);
        if (!polluted && input.args.includes("commit-tree")) {
          polluted = true;
          writeFileSync(join(scenario.repoPath, "late-evil.ts"), "export const lateEvil = true;\n");
          realGitRunner({ cwd: scenario.repoPath, args: ["add", "late-evil.ts"] });
        }
        return result;
      };

      const result = applyHarnessAction(harness, scenario.action, { runGit });

      expect(polluted).toBe(true);
      expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "integration" }));
      expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
      expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.expectedParentSha);
      expect(git(scenario.repoPath, ["log", "--format=%s", "-1"]).stdout.trim()).toBe("Initial commit");
    });

    test("requires an exact matching integration receipt before clearing worker readiness", () => {
      const readinessFor = (
        artifactsFor: (runId: string, workerTaskId: string) => Array<Record<string, unknown>>,
      ) => {
        const runId = harness.createRun({ goal: "Validate exact integration receipt" });
        const workerTaskId = harness.createTask({
          runId,
          role: "worker",
          goal: "Produce verified change",
          prompt: "Produce one file.",
          worktreePath: "/tmp/exact-receipt-worker",
        });
        harness.recordAttempt({
          taskId: workerTaskId,
          input: { executor: "test" },
          output: {
            status: "done",
            summary: "Produced one file",
            changedFiles: ["src/new.ts"],
            checks: [{ name: "worker", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        });
        const verifierTaskId = harness.createTask({
          runId,
          role: "verifier",
          goal: "Verify change",
          prompt: "Verify one file.",
          dependsOn: [workerTaskId],
        });
        harness.recordAttempt({
          taskId: verifierTaskId,
          input: { executor: "test" },
          output: {
            status: "done",
            summary: "Verified",
            changedFiles: [],
            checks: [{ name: "verify", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        });
        harness.recordHarnessActionEvent({
          actionType: "commitExactGitIndex",
          status: "done",
          request: { type: "commitExactGitIndex", runId, taskId: workerTaskId },
          result: { status: "done", artifacts: artifactsFor(runId, workerTaskId) },
        });
        return { runId, workerTaskId };
      };

      const empty = readinessFor(() => []);
      const wrongWorker = readinessFor((runId) => [
        { kind: "integration", mode: "exact_git_index_commit", runId, workerTaskId: "task_other" },
      ]);
      const wrongRun = readinessFor((_runId, workerTaskId) => [
        { kind: "integration", mode: "exact_git_index_commit", runId: "run_other", workerTaskId },
      ]);
      const wrongMode = readinessFor((runId, workerTaskId) => [
        { kind: "integration", mode: "contained_worker_commit", runId, workerTaskId },
      ]);
      const valid = readinessFor((runId, workerTaskId) => [
        { kind: "integration", mode: "exact_git_index_commit", runId, workerTaskId },
      ]);

      expect(describeIntegrationReadiness(harness, empty.runId).unintegrated).toHaveLength(1);
      expect(describeIntegrationReadiness(harness, wrongWorker.runId).unintegrated).toHaveLength(1);
      expect(describeIntegrationReadiness(harness, wrongRun.runId).unintegrated).toHaveLength(1);
      expect(describeIntegrationReadiness(harness, wrongMode.runId).unintegrated).toHaveLength(1);
      expect(describeIntegrationReadiness(harness, valid.runId).unintegrated).toHaveLength(0);
    });

    test("rejects frozen contract and action scope mismatches before Git mutation", async () => {
      const scenario = await createScenario();
      const cases: Array<(scenario: Awaited<ReturnType<typeof createScenario>>) => Record<string, unknown>> = [
        (scenario) => ({ ...scenario.action, repoPath: join(scenario.repoPath, "src") }),
        (scenario) => ({ ...scenario.action, branch: "release" }),
        (scenario) => ({ ...scenario.action, expectedParentSha: "1111111111111111111111111111111111111111" }),
        (scenario) => ({ ...scenario.action, commitMessage: "Different message" }),
        (scenario) => ({ ...scenario.action, files: [{ ...scenario.files[0], path: "src/different.ts" }] }),
        (scenario) => ({ ...scenario.action, files: [{ ...scenario.files[0], blobOid: "2222222222222222222222222222222222222222" }] }),
      ];
      for (const change of cases) {
        const headBefore = git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim();
        const result = applyHarnessAction(harness, change(scenario));
        expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
        expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
      }
    });

    test("rejects an unsupported or malformed frozen contract", async () => {
      const scenario = await createScenario();
      harness.updateRun({
        runId: scenario.runId,
        contextPatch: {
          gitIndexCommitContracts: {
            exactIndex: {
              runId: scenario.runId,
              taskId: scenario.taskId,
              repoPath: scenario.repoPath,
              branch: scenario.branch,
              expectedParentSha: scenario.expectedParentSha,
              commitMessage: scenario.commitMessage,
              files: scenario.files,
              force: true,
            },
          },
        },
      });

      const result = applyHarnessAction(harness, scenario.action);

      expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(result.problems.join(" ")).toContain("frozen contract");
    });

    test("rejects repository top-level branch and parent mismatches", async () => {
      const repoScenario = await createScenario();
      const nestedAction = { ...repoScenario.action, repoPath: join(repoScenario.repoPath, "src") };
      repoScenario.freeze(nestedAction);
      const branchScenario = await createScenario();
      const branchAction = { ...branchScenario.action, branch: "release" };
      branchScenario.freeze(branchAction);
      const parentScenario = await createScenario();
      const parentAction = { ...parentScenario.action, expectedParentSha: "3333333333333333333333333333333333333333" };
      parentScenario.freeze(parentAction);

      for (const [scenario, action] of [
        [repoScenario, nestedAction],
        [branchScenario, branchAction],
        [parentScenario, parentAction],
      ] as const) {
        const result = applyHarnessAction(harness, action);
        expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
        expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.expectedParentSha);
      }
    });

    test("rejects worker evidence and verifier failures", async () => {
      const changedFiles = await createScenario({ changedFiles: ["src/other.ts"] });
      const failedVerifier = await createScenario({ verifierFailed: true });

      const changedResult = applyHarnessAction(harness, changedFiles.action);
      const verifierResult = applyHarnessAction(harness, failedVerifier.action);

      expect(changedResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(changedResult.problems.join(" ")).toContain("changedFiles");
      expect(verifierResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(verifierResult.problems.join(" ")).toContain("verifier");
    });

    test("rejects missing or foreign task worktrees before any Git command", async () => {
      const missing = await createScenario({ worktreeMode: "missing" });
      const foreign = await createScenario({ worktreeMode: "foreign" });
      let gitCalls = 0;
      const runGit = (input: { cwd: string; args: string[] }) => {
        gitCalls += 1;
        return realGitRunner(input);
      };

      const missingResult = applyHarnessAction(harness, missing.action, { runGit });
      const foreignResult = applyHarnessAction(harness, foreign.action, { runGit });

      expect(missingResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(foreignResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(gitCalls).toBe(0);
      expect(`${missingResult.problems.join(" ")} ${foreignResult.problems.join(" ")}`).toContain("worktree");
    });

    test("rejects extra staged unstaged untracked conflicted and MERGE_HEAD state", async () => {
      const staged = await createScenario();
      await writeFile(join(staged.repoPath, "extra.ts"), "extra\n");
      git(staged.repoPath, ["add", "extra.ts"]);
      const unstaged = await createScenario();
      await writeFile(join(unstaged.repoPath, "README.md"), "unstaged\n");
      const untracked = await createScenario();
      await writeFile(join(untracked.repoPath, "untracked.txt"), "untracked\n");
      const mergeHead = await createScenario();
      const mergeHeadPath = git(mergeHead.repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]).stdout.trim();
      await writeFile(mergeHeadPath, `${mergeHead.expectedParentSha}\n`);
      const conflicted = await createScenario();
      const conflictedRunner = (input: { cwd: string; args: string[] }) => {
        if (input.args.join(" ") === "ls-files --unmerged -z") {
          return { exitCode: 0, stdout: `100644 ${conflicted.blobOid} 1\tREADME.md\0`, stderr: "" };
        }
        return realGitRunner(input);
      };

      for (const scenario of [staged, unstaged, untracked, mergeHead]) {
        const result = applyHarnessAction(harness, scenario.action);
        expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
        expect(git(scenario.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(scenario.expectedParentSha);
      }
      const conflictResult = applyHarnessAction(harness, conflicted.action, { runGit: conflictedRunner });
      expect(conflictResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(conflictResult.problems.join(" ")).toContain("conflict");
    }, 15_000);

    test("rejects staged mode and blob mismatches", async () => {
      const mode = await createScenario();
      git(mode.repoPath, ["config", "core.fileMode", "false"]);
      git(mode.repoPath, ["update-index", "--chmod=+x", "src/new.ts"]);
      const blob = await createScenario();
      await writeFile(join(blob.repoPath, "src", "new.ts"), "export const value = 2;\n");
      git(blob.repoPath, ["add", "src/new.ts"]);

      const modeResult = applyHarnessAction(harness, mode.action);
      const blobResult = applyHarnessAction(harness, blob.action);

      expect(modeResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(blobResult).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(`${modeResult.problems.join(" ")} ${blobResult.problems.join(" ")}`).toContain("mode or blob");
      expect(git(mode.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(mode.expectedParentSha);
      expect(git(blob.repoPath, ["rev-parse", "HEAD"]).stdout.trim()).toBe(blob.expectedParentSha);
    });

    test("rejects invalid modes duplicate paths and unsupported action or file fields", async () => {
      const mode = await createScenario();
      const duplicate = await createScenario();
      const extraAction = await createScenario();
      const extraFile = await createScenario();
      const invalidActions: Array<Record<string, unknown>> = [
        { ...mode.action, files: [{ ...mode.files[0], mode: "100755" }] },
        { ...duplicate.action, files: [duplicate.files[0], duplicate.files[0]] },
        { ...extraAction.action, force: true },
        { ...extraFile.action, files: [{ ...extraFile.files[0], source: "worker" }] },
      ];

      for (const action of invalidActions) {
        const result = applyHarnessAction(harness, action);
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
      }
    });

    test("bounds commit messages file counts and path lengths", async () => {
      const message = await createScenario();
      const count = await createScenario();
      const path = await createScenario();
      const invalidActions = [
        { ...message.action, commitMessage: "m".repeat(4097) },
        { ...message.action, commitMessage: "multi\nline" },
        {
          ...count.action,
          files: Array.from({ length: 257 }, (_, index) => ({
            ...count.files[0],
            path: `src/file-${index}.ts`,
          })),
        },
        { ...path.action, files: [{ ...path.files[0], path: `src/${"p".repeat(1021)}` }] },
      ];

      for (const action of invalidActions) {
        const result = applyHarnessAction(harness, action);
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
      }
    }, 15_000);

    test("redacts credentials from structured Git failures", async () => {
      const scenario = await createScenario();
      const runGit = (input: { cwd: string; args: string[] }) => {
        if (input.args.join(" ") === "rev-parse --show-toplevel") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "fatal: https://x-access-token:ghp_exact_secret@example.com/repo.git Authorization: Basic exact-basic",
          };
        }
        return realGitRunner(input);
      };

      const result = applyHarnessAction(harness, scenario.action, { runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "blocked", actionType: "commitExactGitIndex" });
      expect(serialized).not.toContain("ghp_exact_secret");
      expect(serialized).not.toContain("exact-basic");
      expect(serialized).toContain("[REDACTED]");
    });
  });

  describe("pushExactGitRef", () => {
    const expectedOldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    const remoteHost = "github.com";
    const repository = "neeboo/hodor-web";
    const ref = "refs/heads/main";

    function frozenAction(
      overrides: Record<string, unknown> = {},
      frozenOverrides: Record<string, unknown> = {},
    ) {
      const repoPath = dir;
      const contract = {
        repoPath,
        remoteHost,
        repository,
        ref,
        expectedOldSha,
        newSha,
      };
      const runId = harness.createRun({
        goal: "Push one verified Git ref",
        context: {
          gitRemoteWriteContracts: {
            hodorWebMain: { ...contract, ...frozenOverrides },
          },
        },
      });
      return {
        action: {
          type: "pushExactGitRef",
          runId,
          contractId: "hodorWebMain",
          ...contract,
          ...overrides,
        },
        runId,
        repoPath,
      };
    }

    function gitRemoteRunner(input: {
      remoteReads?: string[];
      pushExitCode?: number;
      pushStderr?: string;
      ancestorExitCode?: number;
      remoteUrl?: string;
      head?: string;
    } = {}) {
      const calls: string[][] = [];
      const remoteReads = [...(input.remoteReads ?? [expectedOldSha, newSha])];
      return {
        calls,
        runGit: ({ args }: { cwd: string; args: string[] }) => {
          calls.push(args);
          const command = args.join(" ");
          if (command === "remote get-url --push origin") {
            return { exitCode: 0, stdout: `${input.remoteUrl ?? "git@github.com:neeboo/hodor-web.git"}\n`, stderr: "" };
          }
          if (command === "rev-parse HEAD") {
            return { exitCode: 0, stdout: `${input.head ?? newSha}\n`, stderr: "" };
          }
          if (command === `cat-file -e ${newSha}^{commit}`) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === `ls-remote --exit-code origin ${ref}`) {
            const sha = remoteReads.shift() ?? expectedOldSha;
            return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: "" };
          }
          if (command === `merge-base --is-ancestor ${expectedOldSha} ${newSha}`) {
            return { exitCode: input.ancestorExitCode ?? 0, stdout: "", stderr: "" };
          }
          if (command === `push --no-verify --porcelain origin ${newSha}:${ref}`) {
            return {
              exitCode: input.pushExitCode ?? 0,
              stdout: input.pushExitCode ? "" : `To github.com:neeboo/hodor-web.git\n\t${expectedOldSha.slice(0, 7)}..${newSha.slice(0, 7)}\t${newSha} -> main\n`,
              stderr: input.pushStderr ?? "",
            };
          }
          return { exitCode: 97, stdout: "", stderr: `unexpected git command: ${command}` };
        },
      };
    }

    test("allows one frozen host repository ref and verifies independent readback", () => {
      const { action, repoPath } = frozenAction();
      const remote = gitRemoteRunner();

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });

      expect(result).toMatchObject({
        status: "done",
        actionType: "pushExactGitRef",
        summary: expect.stringContaining("verified"),
      });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "verified",
        status: "pushed",
        repoPath,
        remoteHost,
        repository,
        ref,
        expectedOldSha,
        newSha,
        verifiedBy: "independent_readback",
      }));
      expect(remote.calls).toContainEqual(["push", "--no-verify", "--porcelain", "origin", `${newSha}:${ref}`]);
      expect(remote.calls.filter((args) => args[0] === "ls-remote")).toHaveLength(2);
    });

    test("reuses an already-pushed ref without issuing a second push", () => {
      const { action } = frozenAction();
      const remote = gitRemoteRunner({ remoteReads: [newSha] });

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "done", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "verified",
        status: "reused",
        verifiedBy: "independent_readback",
      }));
      expect(remote.calls.some((args) => args[0] === "push")).toBe(false);
    });

    test("fails closed when host repository or ref differs from the frozen run contract", () => {
      const mismatches = [
        { remoteHost: "gitlab.com" },
        { repository: "neeboo/another-repo" },
        { ref: "refs/heads/release" },
      ];
      for (const mismatch of mismatches) {
        const { action } = frozenAction(mismatch);
        const remote = gitRemoteRunner();
        const result = applyHarnessAction(harness, action, { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "pushExactGitRef" });
        expect(result.artifacts).toContainEqual(expect.objectContaining({
          kind: "git_remote_write",
          outcome: "failed",
          status: "scope_mismatch",
        }));
        expect(remote.calls).toHaveLength(0);
      }
    });

    test("rejects non-fast-forward ancestry before push", () => {
      const { action } = frozenAction();
      const remote = gitRemoteRunner({ ancestorExitCode: 1 });

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "blocked", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "failed",
        status: "non_fast_forward",
      }));
      expect(remote.calls.some((args) => args[0] === "push")).toBe(false);
    });

    test("recovers a lost push response from independent readback and redacts credentials", () => {
      const { action } = frozenAction();
      const remote = gitRemoteRunner({
        remoteReads: [expectedOldSha, newSha],
        pushExitCode: 1,
        pushStderr: "fatal: https://x-access-token:ghp_super_secret@github.com/neeboo/hodor-web.git Authorization: Bearer also-secret",
      });

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "done", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "verified",
        status: "response_loss_recovered",
        verifiedBy: "independent_readback",
      }));
      expect(serialized).not.toContain("ghp_super_secret");
      expect(serialized).not.toContain("also-secret");
    });

    test("redacts credentials from a structured push failure", () => {
      const { action } = frozenAction();
      const remote = gitRemoteRunner({
        remoteReads: [expectedOldSha, expectedOldSha],
        pushExitCode: 1,
        pushStderr: "fatal: https://oauth2:github_pat_super_secret@github.com/neeboo/hodor-web.git Authorization: Basic another-secret",
      });

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "blocked", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "failed",
        status: "push_failed",
      }));
      expect(serialized).not.toContain("github_pat_super_secret");
      expect(serialized).not.toContain("another-secret");
      expect(serialized).toContain("[REDACTED]");
    });

    test("fails when successful push is not confirmed by independent readback", () => {
      const unexpectedSha = "3333333333333333333333333333333333333333";
      const { action } = frozenAction();
      const remote = gitRemoteRunner({ remoteReads: [expectedOldSha, unexpectedSha] });

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "blocked", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "failed",
        status: "readback_mismatch",
        observedSha: unexpectedSha,
      }));
    });

    test("rejects force delete wildcard and non-commit inputs before any git command", () => {
      const invalidActions = [
        { force: true },
        { delete: true },
        { ref: "refs/heads/*" },
        { newSha: "0000000000000000000000000000000000000000" },
      ];
      for (const invalid of invalidActions) {
        const { action } = frozenAction(invalid);
        const remote = gitRemoteRunner();
        const result = applyHarnessAction(harness, action, { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
        expect(remote.calls).toHaveLength(0);
      }
    });

    test("rejects unsupported fields in the frozen run contract", () => {
      const { action } = frozenAction({}, { force: true });
      const remote = gitRemoteRunner();

      const result = applyHarnessAction(harness, action, { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "blocked", actionType: "pushExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_remote_write",
        outcome: "failed",
        status: "scope_mismatch",
      }));
      expect(remote.calls).toHaveLength(0);
    });

    test("rejects the legacy broad integrateVerifiedRun push flag before any Git mutation", () => {
      const remote = gitRemoteRunner();
      const result = applyHarnessAction(harness, {
        type: "integrateVerifiedRun",
        runId: "run_untrusted",
        repoPath: dir,
        targetBranch: "main",
        push: true,
      }, { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
      expect(result.problems.join(" ")).toContain("pushExactGitRef");
      expect(remote.calls).toHaveLength(0);
    });
  });

  describe("createExactGitRef", () => {
    const newSha = "2222222222222222222222222222222222222222";
    const remoteHost = "github.com";
    const repository = "neeboo/hodor-web";
    const ref = "refs/heads/codex/pan-1244-deterministic-contract-mainline";

    function frozenCreateAction(
      overrides: Record<string, unknown> = {},
      frozenOverrides: Record<string, unknown> = {},
    ) {
      const contract = {
        repoPath: dir,
        remoteHost,
        repository,
        ref,
        newSha,
        expectedAbsent: true,
      };
      const runId = harness.createRun({
        goal: "Create one frozen delivery branch",
        context: {
          gitRefCreationContracts: {
            deliveryBranch: { ...contract, ...frozenOverrides },
          },
        },
      });
      return {
        type: "createExactGitRef",
        runId,
        contractId: "deliveryBranch",
        ...contract,
        ...overrides,
      };
    }

    function gitRefCreationRunner(input: {
      remoteReads?: Array<string | null | { exitCode: number; stdout?: string; stderr?: string }>;
      pushExitCode?: number;
      pushStdout?: string;
      pushStderr?: string;
      remoteUrl?: string;
      head?: string;
      commitExitCode?: number;
    } = {}) {
      const calls: Array<{ args: string[]; timeoutMs?: number; maxOutputBytes?: number }> = [];
      const remoteReads = [...(input.remoteReads ?? [null, newSha])];
      return {
        calls,
        runGit: (commandInput: { cwd: string; args: string[]; timeoutMs?: number; maxOutputBytes?: number }) => {
          calls.push(commandInput);
          const command = commandInput.args.join(" ");
          if (command === "remote get-url --push origin") {
            return { exitCode: 0, stdout: `${input.remoteUrl ?? "git@github.com:neeboo/hodor-web.git"}\n`, stderr: "" };
          }
          if (command === "rev-parse HEAD") {
            return { exitCode: 0, stdout: `${input.head ?? newSha}\n`, stderr: "" };
          }
          if (command === `cat-file -e ${newSha}^{commit}`) {
            return { exitCode: input.commitExitCode ?? 0, stdout: "", stderr: input.commitExitCode ? "not a commit" : "" };
          }
          if (command === `ls-remote --exit-code origin ${ref}`) {
            const value = remoteReads.shift() ?? null;
            if (typeof value === "object" && value !== null) {
              return { exitCode: value.exitCode, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
            }
            return value
              ? { exitCode: 0, stdout: `${value}\t${ref}\n`, stderr: "" }
              : { exitCode: 2, stdout: "", stderr: "" };
          }
          if (command === `push --no-verify --porcelain origin ${newSha}:${ref}`) {
            return {
              exitCode: input.pushExitCode ?? 0,
              stdout: input.pushStdout ?? (input.pushExitCode ? "" : `To github.com:neeboo/hodor-web.git\n * [new branch] ${newSha} -> ${ref}\n`),
              stderr: input.pushStderr ?? "",
            };
          }
          return { exitCode: 97, stdout: "", stderr: `unexpected git command: ${command}` };
        },
      };
    }

    test("creates one frozen absent branch and verifies independent readback", () => {
      const remote = gitRefCreationRunner();

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });

      expect(result).toMatchObject({
        status: "done",
        actionType: "createExactGitRef",
      });
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "git_ref_creation",
        outcome: "verified",
        status: "created",
        remoteHost,
        repository,
        ref,
        newSha,
        expectedAbsent: true,
        verifiedBy: "independent_readback",
      }));
      expect(remote.calls.filter((call) => call.args[0] === "push")).toHaveLength(1);
      expect(remote.calls.filter((call) => call.args[0] === "ls-remote")).toHaveLength(2);
      expect(remote.calls.every((call) => call.timeoutMs === 30_000 && call.maxOutputBytes === 24 * 1024)).toBe(true);
      expect(remote.calls).toContainEqual(expect.objectContaining({
        args: ["push", "--no-verify", "--porcelain", "origin", `${newSha}:${ref}`],
      }));
    });

    test("reuses an existing exact ref without another push", () => {
      const remote = gitRefCreationRunner({ remoteReads: [newSha] });

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "done", actionType: "createExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "reused" }));
      expect(remote.calls.some((call) => call.args[0] === "push")).toBe(false);
    });

    test("blocks an existing different ref without mutation", () => {
      const otherSha = "3333333333333333333333333333333333333333";
      const remote = gitRefCreationRunner({ remoteReads: [otherSha] });

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });

      expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "conflict", observedSha: otherSha }));
      expect(remote.calls.some((call) => call.args[0] === "push")).toBe(false);
    });

    test("rejects main tags HEAD wildcard delete force and false absence before Git", () => {
      const invalid = [
        { ref: "refs/heads/main" },
        { ref: "refs/tags/v1" },
        { ref: "HEAD" },
        { ref: "refs/heads/codex/*" },
        { delete: true },
        { force: true },
        { expectedAbsent: false },
      ];
      for (const overrides of invalid) {
        const remote = gitRefCreationRunner();
        const result = applyHarnessAction(harness, frozenCreateAction(overrides), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
        expect(remote.calls).toHaveLength(0);
      }
    });

    test("redacts credential-bearing unsupported fields from the rejected action audit event", () => {
      const secret = "ghp_invalid_create_secret";
      const remote = gitRefCreationRunner();

      const result = applyHarnessAction(
        harness,
        frozenCreateAction({ authorization: `Bearer ${secret}` }),
        { runGit: remote.runGit },
      );
      const event = harness.listHarnessActionEvents({ limit: 1 })[0];
      const serialized = JSON.stringify({ result, event });

      expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("[REDACTED]");
      expect(remote.calls).toHaveLength(0);
    });

    test("redacts common camelCase underscored plural and prefixed credential keys", () => {
      const credentialFields = ["clientSecret", "client_secret", "apiToken", "credentials", "db_password"];
      for (const [index, key] of credentialFields.entries()) {
        const secret = `opaque-value-${index}`;
        const result = applyHarnessAction(
          harness,
          frozenCreateAction({ [key]: secret }),
          { runGit: gitRefCreationRunner().runGit },
        );
        const event = harness.listHarnessActionEvents({ limit: 1 })[0];
        const serialized = JSON.stringify({ result, event });
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain("[REDACTED]");
      }
    });

    test("preserves repeated shared audit objects while marking a true request cycle", () => {
      const shared = { diagnostic: "preserve twice" };
      const sharedResult = applyHarnessAction(
        harness,
        frozenCreateAction({ first: shared, second: shared }),
        { runGit: gitRefCreationRunner().runGit },
      );
      const sharedEvent = harness.getHarnessActionEvent({ id: sharedResult.eventId });
      expect(sharedEvent?.request).toMatchObject({ first: shared, second: shared });

      const cyclic: Record<string, unknown> = { diagnostic: "cycle" };
      cyclic.self = cyclic;
      const cyclicResult = applyHarnessAction(
        harness,
        frozenCreateAction({ cyclic }),
        { runGit: gitRefCreationRunner().runGit },
      );
      const cyclicEvent = harness.getHarnessActionEvent({ id: cyclicResult.eventId });
      expect(cyclicEvent?.request).toMatchObject({
        cyclic: { diagnostic: "cycle", self: "[CIRCULAR]" },
      });
    });

    test("rejects payload values that would require trimming or case normalization", () => {
      const invalid = [
        { contractId: " deliveryBranch" },
        { repoPath: `${dir} ` },
        { remoteHost: "GitHub.com" },
        { repository: " neeboo/hodor-web" },
        { ref: `${ref} ` },
        { newSha: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      ];
      for (const overrides of invalid) {
        const remote = gitRefCreationRunner();
        const result = applyHarnessAction(harness, frozenCreateAction(overrides), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "invalid" });
        expect(remote.calls).toHaveLength(0);
      }
    });

    test("fails closed on action or frozen scope mismatch and extra frozen fields", () => {
      const mismatches = [
        { remoteHost: "gitlab.com" },
        { repository: "neeboo/other" },
        { ref: "refs/heads/codex/other" },
        { newSha: "4444444444444444444444444444444444444444" },
      ];
      for (const overrides of mismatches) {
        const remote = gitRefCreationRunner();
        const result = applyHarnessAction(harness, frozenCreateAction(overrides), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
        expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "scope_mismatch" }));
        expect(remote.calls).toHaveLength(0);
      }
      const remote = gitRefCreationRunner();
      const extraFrozen = applyHarnessAction(
        harness,
        frozenCreateAction({}, { force: false }),
        { runGit: remote.runGit },
      );
      expect(extraFrozen).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
      expect(remote.calls).toHaveLength(0);
    });

    test("blocks origin identity and local HEAD mismatches before remote mutation", () => {
      const cases = [
        gitRefCreationRunner({ remoteUrl: "git@github.com:neeboo/other.git" }),
        gitRefCreationRunner({ head: "5555555555555555555555555555555555555555" }),
        gitRefCreationRunner({ commitExitCode: 1 }),
      ];
      for (const remote of cases) {
        const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
        expect(remote.calls.some((call) => call.args[0] === "push")).toBe(false);
      }
    });

    test("recovers response loss only from exact readback and redacts credentials", () => {
      const remote = gitRefCreationRunner({
        pushExitCode: 1,
        pushStderr: "fatal: https://x-access-token:ghp_create_secret@github.com/neeboo/hodor-web.git Authorization: Bearer other-secret",
      });

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "done", actionType: "createExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "response_loss_recovered" }));
      expect(serialized).not.toContain("ghp_create_secret");
      expect(serialized).not.toContain("other-secret");
    });

    test("bounds failed command output before recording a redacted audit result", () => {
      const remote = gitRefCreationRunner({
        remoteReads: [null, null],
        pushExitCode: 1,
        pushStderr: `Authorization: Bearer bounded-secret ${"x".repeat(100_000)}`,
      });

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "push_failed" }));
      expect(serialized).not.toContain("bounded-secret");
      expect(serialized).toContain("[TRUNCATED]");
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(70_000);
    });

    test("blocks successful push when independent readback is absent or mismatched", () => {
      const otherSha = "6666666666666666666666666666666666666666";
      for (const observed of [null, otherSha]) {
        const remote = gitRefCreationRunner({ remoteReads: [null, observed] });
        const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
        expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "readback_mismatch" }));
        expect(remote.calls.filter((call) => call.args[0] === "push")).toHaveLength(1);
      }
    });

    test("accepts absent exit 2 with the exact benign SSH transport notice", () => {
      const notice = "Connection to ssh.github.com port 443 [tcp/https] succeeded!";
      const remote = gitRefCreationRunner({
        remoteReads: [
          { exitCode: 2, stdout: "", stderr: `${notice}\n` },
          newSha,
        ],
      });

      const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({ status: "done", actionType: "createExactGitRef" });
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "created" }));
      expect(remote.calls.filter((call) => call.args[0] === "push")).toHaveLength(1);
      expect(serialized).not.toContain(notice);
    });

    test("does not treat authentication failure or nonempty stdout as absent", () => {
      const notice = "Connection to ssh.github.com port 443 [tcp/https] succeeded!";
      const cases = [
        {
          exitCode: 2,
          stdout: "",
          stderr: `${notice}\ngit@github.com: Permission denied (publickey).\n`,
        },
        {
          exitCode: 2,
          stdout: `${newSha}\trefs/heads/unexpected\n`,
          stderr: `${notice}\n`,
        },
        {
          exitCode: 2,
          stdout: " \n",
          stderr: `${notice}\n`,
        },
        {
          exitCode: 2,
          stdout: "",
          stderr: "Connection to attacker.example port 443 [tcp/https] succeeded!\n",
        },
        {
          exitCode: 2,
          stdout: "",
          stderr: ` ${notice}\n`,
        },
        {
          exitCode: 2,
          stdout: "",
          stderr: `\n${notice}\n`,
        },
        {
          exitCode: 2,
          stdout: "",
          stderr: `${notice}\n\n`,
        },
      ];
      for (const read of cases) {
        const remote = gitRefCreationRunner({ remoteReads: [read] });
        const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
        const serialized = JSON.stringify(result);
        expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
        expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "remote_read_failed" }));
        expect(remote.calls.some((call) => call.args[0] === "push")).toBe(false);
        expect(serialized).not.toContain(notice);
      }
    });

    test("treats ambiguous or failed absent readback as an error", () => {
      const cases = [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 2, stdout: "", stderr: "network unavailable" },
        { exitCode: 1, stdout: "", stderr: "permission denied" },
      ];
      for (const read of cases) {
        const remote = gitRefCreationRunner({ remoteReads: [read] });
        const result = applyHarnessAction(harness, frozenCreateAction(), { runGit: remote.runGit });
        expect(result).toMatchObject({ status: "blocked", actionType: "createExactGitRef" });
        expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "remote_read_failed" }));
        expect(remote.calls.some((call) => call.args[0] === "push")).toBe(false);
      }
    });
  });

  test("retires a stale run from the active queue without deleting task evidence", () => {
    const runId = harness.createRun({ goal: "Old duplicate self-iteration" });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Old planner",
      prompt: "Old duplicate planner.",
    });

    const result = applyHarnessAction(harness, {
      type: "retireRun",
      runId,
      reason: "duplicate historical self-iteration run",
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({
      status: "done",
      actionType: "retireRun",
      eventId: expect.any(String),
    });
    expect(harness.getRun(runId)).toMatchObject({
      status: "blocked",
      context: expect.objectContaining({
        retired: true,
        retiredReason: "duplicate historical self-iteration run",
        retiredAt: expect.any(String),
      }),
    });
    expect(harness.getTask(taskId)?.status).toBe("blocked");
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "run", retired: true }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "blocked_task", taskId }));
    expect(event).toMatchObject({
      actionType: "retireRun",
      status: "done",
      request: expect.objectContaining({ reason: "duplicate historical self-iteration run" }),
    });
  });

  test("treats a retired run as an execution tombstone across drain, lease, and attempt entry points", () => {
    const runId = harness.createRun({
      goal: "Retired duplicate delivery",
      context: {
        retired: true,
        retiredReason: "superseded by canonical delivery",
      },
    });
    harness.updateRunStatus({ runId, status: "blocked" });
    const staleTaskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Stale planner must never restart",
      prompt: "This task was created by an obsolete recovery path.",
    });

    const drain = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      reason: "replayed recovery against retired duplicate",
    });
    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `task-${task.id}`,
    });

    expect(drain).toMatchObject({
      status: "blocked",
      actionType: "prepareRunDrain",
      problems: [expect.stringContaining("retired")],
    });
    expect(harness.getRun(runId)).toMatchObject({ status: "blocked", context: { retired: true } });
    expect(leased).toEqual([]);
    expect(harness.getTask(staleTaskId)?.status).toBe("todo");
    expect(() => harness.startAttempt({ taskId: staleTaskId, input: {} })).toThrow("retired");
    expect(harness.getRunOverview({ runId, eventLimit: 0 }).sessions).toEqual([]);
  });

  test("updates run context through an audited action", () => {
    const runId = harness.createRun({
      goal: "Prove backend support",
      context: {
        targetBackends: ["codex", "claude-code"],
        keep: true,
      },
    });

    const result = applyHarnessAction(harness, {
      type: "updateRunContext",
      runId,
      goal: "Prove Claude Code support first",
      contextPatch: {
        targetBackends: ["claude-code"],
        scope: "claude-first",
      },
      reason: "narrow user scope to Claude Code",
    });
    const run = harness.getRun(runId)!;
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({
      status: "done",
      actionType: "updateRunContext",
      eventId: expect.any(String),
    });
    expect(run.goal).toBe("Prove Claude Code support first");
    expect(run.status).toBe("todo");
    expect(run.context).toEqual({
      targetBackends: ["claude-code"],
      keep: true,
      scope: "claude-first",
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "run_context_update",
        runId,
        previousGoal: "Prove backend support",
        goal: "Prove Claude Code support first",
        patchedKeys: ["scope", "targetBackends"],
      }),
    );
    expect(event).toMatchObject({
      actionType: "updateRunContext",
      status: "done",
      request: expect.objectContaining({ runId, reason: "narrow user scope to Claude Code" }),
    });
  });

  test("amends a run contract through an audited, versioned action", () => {
    const runId = harness.createRun({
      goal: "Prove run contract amendment",
      context: {
        goalContract: { version: 1, successCriteria: ["initial"] },
      },
    });

    const firstResult = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 2, successCriteria: ["initial", "stronger"] },
      version: 1,
      expectedVersion: 0,
      reason: "execution discovered a stronger check",
    });
    const firstRun = harness.getRun(runId)!;
    const firstEvent = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(firstResult).toMatchObject({
      status: "done",
      actionType: "amendRunContract",
      eventId: expect.any(String),
    });
    expect(firstResult.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "contract_amendment",
        runId,
        contractKey: "goalContract",
        previousVersion: 0,
        version: 1,
        reason: "execution discovered a stronger check",
      }),
    );
    expect(firstRun.context.goalContract).toEqual({
      version: 2,
      successCriteria: ["initial", "stronger"],
    });
    expect(firstRun.context.contractAmendments).toEqual([
      expect.objectContaining({
        contractKey: "goalContract",
        version: 1,
        reason: "execution discovered a stronger check",
        amendedAt: expect.any(String),
      }),
    ]);
    expect(firstEvent).toMatchObject({
      actionType: "amendRunContract",
      status: "done",
      request: expect.objectContaining({ runId, contractKey: "goalContract", version: 1 }),
    });

    const secondResult = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 3, successCriteria: ["initial", "stronger", "final"] },
      version: 2,
      expectedVersion: 1,
      reason: "tighten stop policy after repair",
    });
    const secondRun = harness.getRun(runId)!;

    expect(secondResult.status).toBe("done");
    expect(secondRun.context.goalContract).toEqual({
      version: 3,
      successCriteria: ["initial", "stronger", "final"],
    });
    expect(secondRun.context.contractAmendments).toHaveLength(2);
    expect(secondRun.context.contractAmendments).toContainEqual(
      expect.objectContaining({ contractKey: "goalContract", version: 2 }),
    );
  });

  test("rejects a stale contract amendment without mutating run context", () => {
    const runId = harness.createRun({
      goal: "Reject stale amendment",
      context: {
        goalContract: { version: 1, successCriteria: ["initial"] },
      },
    });
    applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 2, successCriteria: ["initial", "stronger"] },
      version: 1,
      expectedVersion: 0,
      reason: "first amendment",
    });

    const stale = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 99, successCriteria: ["wrong"] },
      version: 2,
      expectedVersion: 0,
      reason: "should not apply",
    });
    const run = harness.getRun(runId)!;
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(stale).toMatchObject({
      status: "blocked",
      actionType: "amendRunContract",
      problems: [expect.stringContaining("Stale contract amendment")],
    });
    expect(run.context.goalContract).toEqual({ version: 2, successCriteria: ["initial", "stronger"] });
    expect(run.context.contractAmendments).toHaveLength(1);
    expect(event).toMatchObject({
      actionType: "amendRunContract",
      status: "blocked",
      request: expect.objectContaining({ expectedVersion: 0 }),
    });
  });

  test("redacts sensitive values from a parsed blocked generic action audit", () => {
    const runId = harness.createRun({
      goal: "Reject a stale sensitive amendment",
      context: { goalContract: { version: 1 } },
    });
    const result = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: {
        Authorization: "Bearer authorization-secret",
        token: "token-secret",
        api_key: "api-key-secret",
        diagnostic: "Bearer embedded-secret",
        ordinary: "preserve this audit detail",
      },
      version: 1,
      expectedVersion: 1,
      reason: "retain ordinary amendment reason",
    });
    const event = harness.getHarnessActionEvent({ id: result.eventId });
    const serializedEvent = JSON.stringify(event);

    expect(result.status).toBe("blocked");
    expect(event).toMatchObject({
      actionType: "amendRunContract",
      status: "blocked",
      request: {
        type: "amendRunContract",
        runId,
        contractKey: "goalContract",
        reason: "retain ordinary amendment reason",
        value: {
          Authorization: "[REDACTED]",
          token: "[REDACTED]",
          api_key: "[REDACTED]",
          diagnostic: expect.stringContaining("[REDACTED]"),
          ordinary: "preserve this audit detail",
        },
      },
    });
    for (const secret of ["authorization-secret", "token-secret", "api-key-secret", "embedded-secret"]) {
      expect(serializedEvent).not.toContain(secret);
    }
    expect(harness.getRun(runId)?.context.goalContract).toEqual({ version: 1 });
  });

  test("rejects a non-monotonic contract amendment version", () => {
    const runId = harness.createRun({
      goal: "Reject non-monotonic amendment",
      context: {
        goalContract: { version: 5, successCriteria: ["fifth"] },
      },
    });
    applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 6, successCriteria: ["fifth", "sixth"] },
      version: 5,
      expectedVersion: 0,
      reason: "first amendment",
    });

    const regression = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId,
      contractKey: "goalContract",
      value: { version: 4, successCriteria: ["regression"] },
      version: 4,
      reason: "should not apply",
    });
    const run = harness.getRun(runId)!;

    expect(regression).toMatchObject({
      status: "blocked",
      actionType: "amendRunContract",
      problems: [expect.stringContaining("Non-monotonic contract amendment")],
    });
    expect(run.context.goalContract).toEqual({ version: 6, successCriteria: ["fifth", "sixth"] });
    expect(run.context.contractAmendments).toHaveLength(1);
  });

  test("blocks amendRunContract when the run or payload is invalid", () => {
    const existingRunId = harness.createRun({ goal: "Existing run for amendment" });

    const missingRun = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId: "run_missing",
      contractKey: "goalContract",
      value: { version: 1 },
      version: 1,
    });
    const invalidPayload = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId: existingRunId,
      contractKey: "goalContract",
      version: 1,
    } as never);

    expect(missingRun).toMatchObject({
      status: "blocked",
      actionType: "amendRunContract",
      problems: [expect.stringContaining("run not found")],
    });
    expect(invalidPayload).toMatchObject({
      status: "blocked",
      actionType: "invalid",
      problems: [expect.stringContaining("value")],
    });
    expect(harness.getRun(existingRunId)?.context.contractAmendments).toBeUndefined();
  });

  test("interrupts a running attempt, records overseer evidence, and creates a follow-up task", () => {
    const runId = harness.createRun({ goal: "Interrupt and replan" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Interrupted task",
      prompt: "Keep working.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task-running", codexSessionId: "codex_123" },
    });
    const threadId = harness.upsertExecutionThread({
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "1234",
      role: "worker",
      status: "running",
      pid: 1234,
      sessionName: "task-running",
      agentSessionId: "codex_123",
      worktreePath: "/tmp/task-running",
    });

    const result = applyHarnessAction(harness, {
      type: "interruptAttemptAndCreateTask",
      attemptId,
      reason: "overseer observed stale work",
      followUpTask: {
        role: "planner",
        goal: "Replan after interruption",
        prompt: "Inspect the interrupted run and produce the next plan.",
        doneWhen: ["next plan emitted"],
      },
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "interruptAttemptAndCreateTask",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "attempt", attemptId, taskId, status: "blocked" }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "execution_thread", threadId, status: "interrupted" }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "task", role: "planner", status: "todo" }));
    expect(harness.getAttempt(attemptId)?.status).toBe("blocked");
    expect(harness.getTask(taskId)?.status).toBe("blocked");
    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(harness.listExecutionThreads({ runId })[0]).toMatchObject({
      id: threadId,
      status: "interrupted",
      interruptReason: "overseer observed stale work",
    });
    expect(event).toMatchObject({
      actionType: "interruptAttemptAndCreateTask",
      status: "done",
      request: expect.objectContaining({ attemptId, reason: "overseer observed stale work" }),
      result: expect.objectContaining({ status: "done" }),
    });
    expect(overview.tasks).toHaveLength(2);
    expect(overview.tasks).toContainEqual(
      expect.objectContaining({ role: "planner", status: "todo", parentId: taskId }),
    );
  });

  test("interrupts multiple running attempts through the bulk action path and creates one follow-up task", () => {
    const runId = harness.createRun({ goal: "Interrupt a run with multiple attempts" });
    const firstTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "First interrupted task",
      prompt: "Keep working.",
    });
    const secondTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Second interrupted task",
      prompt: "Keep working.",
    });
    const firstAttemptId = harness.startAttempt({
      taskId: firstTaskId,
      input: { sessionName: "task-running-1", codexSessionId: "codex_123" },
    });
    const secondAttemptId = harness.startAttempt({
      taskId: secondTaskId,
      input: { sessionName: "task-running-2", codexSessionId: "codex_456" },
    });
    const firstThreadId = harness.upsertExecutionThread({
      runId,
      taskId: firstTaskId,
      attemptId: firstAttemptId,
      ownerType: "runner",
      ownerId: "1234",
      role: "worker",
      status: "running",
      pid: 1234,
      sessionName: "task-running-1",
      agentSessionId: "codex_123",
      worktreePath: "/tmp/task-running-1",
    });
    const secondThreadId = harness.upsertExecutionThread({
      runId,
      taskId: secondTaskId,
      attemptId: secondAttemptId,
      ownerType: "runner",
      ownerId: "5678",
      role: "worker",
      status: "running",
      pid: 5678,
      sessionName: "task-running-2",
      agentSessionId: "codex_456",
      worktreePath: "/tmp/task-running-2",
    });

    const result = applyHarnessAction(harness, {
      type: "interruptRunningAttemptsAndCreateTask",
      attemptIds: [firstAttemptId, secondAttemptId],
      reason: "overseer observed stale work",
      followUpTask: {
        role: "planner",
        goal: "Replan after interruption",
        prompt: "Inspect the interrupted run and produce the next plan.",
        doneWhen: ["next plan emitted"],
      },
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "interruptRunningAttemptsAndCreateTask",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "attempt", attemptId: firstAttemptId, status: "blocked" }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "attempt", attemptId: secondAttemptId, status: "blocked" }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "execution_thread", threadId: firstThreadId, status: "interrupted" }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "execution_thread", threadId: secondThreadId, status: "interrupted" }));
    expect(result.artifacts.filter((artifact) => artifact.kind === "task")).toHaveLength(1);
    expect(harness.getAttempt(firstAttemptId)?.status).toBe("blocked");
    expect(harness.getAttempt(secondAttemptId)?.status).toBe("blocked");
    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(harness.listExecutionThreads({ runId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstThreadId,
          status: "interrupted",
          interruptReason: "overseer observed stale work",
        }),
        expect.objectContaining({
          id: secondThreadId,
          status: "interrupted",
          interruptReason: "overseer observed stale work",
        }),
      ]),
    );
    expect(event).toMatchObject({
      actionType: "interruptRunningAttemptsAndCreateTask",
      status: "done",
      request: expect.objectContaining({ attemptIds: [firstAttemptId, secondAttemptId], reason: "overseer observed stale work" }),
      result: expect.objectContaining({ status: "done" }),
    });
    expect(overview.tasks).toHaveLength(3);
    expect(overview.tasks).toContainEqual(
      expect.objectContaining({ role: "planner", status: "todo", parentId: firstTaskId }),
    );
  });

  test("blocks non-running attempts and invalid follow-up payloads", () => {
    const runId = harness.createRun({ goal: "Reject invalid intervention" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Finished task",
      prompt: "Do work.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task-finished", codexSessionId: "codex_456" },
    });
    harness.finishAttempt({
      attemptId,
      output: {
        status: "done",
        summary: "Already finished",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    const blockedAttempt = applyHarnessAction(harness, {
      type: "interruptAttemptAndCreateTask",
      attemptId,
      reason: "late overseer intervention",
      followUpTask: {
        role: "planner",
        goal: "Should not be created",
        prompt: "Should not be created.",
        doneWhen: ["should not matter"],
      },
    });
    const invalidPayload = applyHarnessAction(harness, {
      type: "interruptAttemptAndCreateTask",
      attemptId,
      reason: "late overseer intervention",
      followUpTask: {
        role: "planner",
        goal: "Missing prompt",
      },
    } as never);

    expect(blockedAttempt).toMatchObject({
      status: "blocked",
      actionType: "interruptAttemptAndCreateTask",
      problems: [expect.stringContaining("not running")],
    });
    expect(invalidPayload).toMatchObject({
      status: "blocked",
      actionType: "invalid",
      problems: [expect.stringContaining("prompt")],
    });
    expect(harness.getRunOverview({ runId }).tasks).toHaveLength(1);
  });

  test("HTTP proxy validates bearer token before applying actions", async () => {
    const runId = harness.createRun({ goal: "Remote action" });
    const denied = await handleHarnessActionRequest(
      new Request("http://127.0.0.1/actions", {
        method: "POST",
        body: JSON.stringify({ type: "prepareRunDrain", runId }),
      }),
      { harness, token: "secret" },
    );
    expect(denied.status).toBe(401);

    const accepted = await handleHarnessActionRequest(
      new Request("http://127.0.0.1/actions", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify({ type: "prepareRunDrain", runId }),
      }),
      { harness, token: "secret" },
    );
    const body = await accepted.json();

    expect(accepted.status).toBe(200);
    expect(body).toMatchObject({ status: "done", actionType: "prepareRunDrain" });
    expect(harness.listHarnessActionEvents({ limit: 1 })[0]).toMatchObject({ actionType: "prepareRunDrain" });
  });

  test("accepts a pending guardrail proposal and records an audited event", () => {
    const runId = harness.createRun({
      goal: "Promote a pending guardrail proposal",
      context: {
        guardrails: [{ id: "guardrail_existing", summary: "Preserve accepted guardrails.", active: true }],
        guardrailProposals: [
          {
            id: "guardrail_pending",
            summary: "Repeated lesson summary.",
            count: 2,
            source: "lesson",
            active: false,
            accepted: false,
          },
        ],
      },
    });

    const result = applyHarnessAction(harness, {
      type: "acceptGuardrailProposal",
      runId,
      proposalId: "guardrail_pending",
      acceptedBy: "dashboard",
      reason: "dashboard accept control",
    });
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];
    const overview = harness.getRunOverview({ runId });

    expect(result).toMatchObject({
      status: "done",
      actionType: "acceptGuardrailProposal",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "guardrail_acceptance",
        runId,
        proposalId: "guardrail_pending",
        guardrailId: "guardrail_pending",
        acceptedBy: "dashboard",
        previouslyAccepted: false,
      }),
    );
    expect(overview.run?.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_existing" }),
      expect.objectContaining({ id: "guardrail_pending", active: true, accepted: true, acceptedBy: "dashboard" }),
    ]);
    expect((overview.run?.context.guardrailProposals as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({
      id: "guardrail_pending",
      accepted: true,
      active: false,
    });
    expect(event).toMatchObject({
      actionType: "acceptGuardrailProposal",
      status: "done",
      request: expect.objectContaining({ runId, proposalId: "guardrail_pending", acceptedBy: "dashboard" }),
      result: expect.objectContaining({ status: "done" }),
    });
  });

  test("blocks unknown guardrail proposal ids and missing runs without mutating context", () => {
    const runId = harness.createRun({
      goal: "Reject unknown guardrail proposal",
      context: {
        guardrailProposals: [
          {
            id: "guardrail_pending",
            summary: "Repeated lesson summary.",
            count: 2,
            source: "lesson",
            active: false,
            accepted: false,
          },
        ],
      },
    });

    const unknownProposal = applyHarnessAction(harness, {
      type: "acceptGuardrailProposal",
      runId,
      proposalId: "guardrail_missing",
      acceptedBy: "dashboard",
    });
    const missingRun = applyHarnessAction(harness, {
      type: "acceptGuardrailProposal",
      runId: "run_missing",
      proposalId: "guardrail_pending",
      acceptedBy: "dashboard",
    });
    const overview = harness.getRunOverview({ runId });

    expect(unknownProposal).toMatchObject({
      status: "blocked",
      actionType: "acceptGuardrailProposal",
    });
    expect(unknownProposal.problems).toContainEqual(expect.stringContaining("guardrail proposal not found: guardrail_missing"));
    expect(missingRun).toMatchObject({
      status: "blocked",
      actionType: "acceptGuardrailProposal",
    });
    expect((overview.run?.context.guardrailProposals as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({
      id: "guardrail_pending",
      accepted: false,
      active: false,
    });
    expect(overview.run?.context.guardrails ?? []).toEqual([]);
  });

  test("startSubsession passes and persists the harness-created child thread id", () => {
    const worktreePath = join(dir, "worker-tree");
    const runId = harness.createRun({
      goal: "Run subsession research",
      projectRoot: worktreePath,
      context: {
        agentBackends: {
          "codex-resumable": { kind: "codex-resumable" },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Drive child research",
      prompt: "Request a harness-managed subsession.",
      worktreePath,
    });
    const calls: SubsessionRunnerStartInput[] = [];
    const runner: SubsessionRunner = {
      start(input: SubsessionRunnerStartInput): SubsessionRunnerStartResult {
        calls.push(input);
        return {
          threadId: "thread_runner_replacement_should_not_win",
          sessionName: input.sessionName,
          agentSessionId: "external-session-id",
          status: "running",
          summary: "runner queued child session",
          checks: [],
          artifacts: [],
          problems: [],
        };
      },
      collect(_children: SubsessionRunnerCollectChild[]) {
        return [];
      },
      cancel(_children: SubsessionRunnerCancelChild[], _reason: string) {
        return [];
      },
    };

    const sensitivePrompt = "Inspect the protocol docs. Authorization: Bearer subsession-secret";
    const result = applyHarnessAction(
      harness,
      {
        type: "startSubsession",
        parentTaskId: taskId,
        purpose: "Research API contracts",
        prompt: sensitivePrompt,
        backend: "codex-resumable",
      },
      { subsessionRunner: runner },
    );

    expect(result).toMatchObject({ status: "done", actionType: "startSubsession" });
    expect(calls).toHaveLength(1);
    const recordedThread = harness.listExecutionThreads({ runId }).find((thread) => thread.ownerType === "subsession");
    expect(recordedThread).toBeTruthy();
    const recordedThreadId = recordedThread!.id;
    expect(calls[0]!.threadId).toBe(recordedThreadId);
    expect(recordedThreadId).not.toBe("thread_runner_replacement_should_not_win");
    expect(recordedThread).toMatchObject({
      ownerType: "subsession",
      taskId,
      worktreePath,
      agentSessionId: "external-session-id",
      status: "running",
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      kind: "subsession_thread",
      threadId: recordedThreadId,
    }));
    expect(calls[0]?.prompt).toBe(sensitivePrompt);
    const event = harness.getHarnessActionEvent({ id: result.eventId });
    expect(event?.request).toMatchObject({
      parentTaskId: taskId,
      purpose: "Research API contracts",
      prompt: expect.stringContaining("[REDACTED]"),
      backend: "codex-resumable",
    });
    expect(JSON.stringify(event)).not.toContain("subsession-secret");
  });

  test("collectSubsessions and cancelSubsessions update recorded child thread evidence", () => {
    const worktreePath = join(dir, "worker-tree");
    const runId = harness.createRun({
      goal: "Collect and cancel subsessions",
      projectRoot: worktreePath,
      context: {
        agentBackends: {
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-reads" },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Drive child research",
      prompt: "Request a harness-managed subsession.",
      worktreePath,
    });
    const runner: SubsessionRunner = {
      start(input) {
        return {
          threadId: input.threadId,
          sessionName: input.sessionName,
          agentSessionId: input.sessionName,
          status: "running",
        };
      },
      collect(children) {
        return children.map((child) => ({
          threadId: child.threadId,
          status: "done",
          summary: `summary for ${child.sessionName}`,
          agentSessionId: child.agentSessionId,
        }));
      },
      cancel(children, reason) {
        return children.map((child) => ({
          threadId: child.threadId,
          canceled: true,
          message: reason,
        }));
      },
    };
    const start = applyHarnessAction(
      harness,
      {
        type: "startSubsession",
        parentTaskId: taskId,
        purpose: "Research API contracts",
        prompt: "Inspect the protocol docs and summarize the harness-managed subsession contract.",
        backend: "claude-code",
      },
      { subsessionRunner: runner },
    );
    const threadId = String(start.artifacts.find((artifact) => artifact.kind === "subsession_thread")?.threadId);

    const collect = applyHarnessAction(
      harness,
      { type: "collectSubsessions", parentTaskId: taskId },
      { subsessionRunner: runner },
    );
    const cancel = applyHarnessAction(
      harness,
      { type: "cancelSubsessions", parentTaskId: taskId, threadIds: [threadId], reason: "parent stopping" },
      { subsessionRunner: runner },
    );
    const thread = harness.listExecutionThreads({ runId }).find((candidate) => candidate.id === threadId);

    expect(collect).toMatchObject({ status: "done", actionType: "collectSubsessions" });
    expect(collect.artifacts).toContainEqual(expect.objectContaining({
      kind: "subsession_summary",
      threadId,
      status: "done",
      summary: expect.stringContaining("summary for"),
    }));
    expect(cancel).toMatchObject({ status: "done", actionType: "cancelSubsessions" });
    expect(cancel.artifacts).toContainEqual(expect.objectContaining({
      kind: "subsession_cancel",
      threadId,
      canceled: true,
    }));
    expect(thread?.status).toBe("interrupted");
    expect(thread?.interruptReason).toBe("parent stopping");
  });
});

describe("Harness transition reads", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-transition-reads-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function seedProject(): string {
    return harness.createProject({ name: "ouroboros", rootPath: dir });
  }

  function seedCharter(projectId: string, mission: string, activate = true): string {
    const charter = harness.createFounderCharter({
      projectId,
      mission,
      charter: {
        mission,
        capitalPolicy: {
          currency: "USD",
          experimentBudget: 1000,
          recurringSpendApprovalAbove: 100,
          portfolio: { core: 5, growth: 3, exploration: 2 },
        },
        authority: {
          autoResearch: true,
          autoReversibleExperiments: true,
          requireHumanFor: [],
        },
      },
      activate,
    });
    return charter.id;
  }

  function seedSignal(projectId: string, observationTime: string, status: "active" | "expired" = "active"): string {
    const signal = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "verifier",
      title: `Signal ${observationTime}`,
      summary: "Cycle time observation.",
      observationTime,
      confidence: 0.6,
      evidence: [],
      status,
      expiresAt: status === "expired" ? "2020-01-01T00:00:00.000Z" : null,
    });
    return signal.id;
  }

  function seedProposal(projectId: string, charterId: string, title: string, status: "draft" | "proposed" | "accepted"): string {
    const proposal = harness.createDesignProposal({
      projectId,
      charterId,
      title,
      problem: "Problem statement.",
      recommendation: "Recommendation.",
      proposal: {
        problem: "Problem statement.",
        recommendation: "Recommendation.",
        evaluationContract: {
          baseline: [],
          successMetrics: ["metric"],
          guardMetrics: [],
          requiredEvidence: ["evidence"],
          reviewAt: "2026-09-01T00:00:00.000Z",
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
        },
        evidenceRefs: ["sig_a"],
      },
      status,
    });
    return proposal.id;
  }

  function seedActionEvent(
    actionType: string,
    request: Record<string, unknown>,
    status: "done" | "blocked" = "done",
  ): string {
    return harness.recordHarnessActionEvent({
      actionType,
      status,
      request,
      result: { ok: true },
    });
  }

  test("getActiveFounderCharter and WithDb agree on the active charter and ordering", () => {
    const projectId = seedProject();
    const first = seedCharter(projectId, "First charter");
    const second = seedCharter(projectId, "Second charter");

    expect(harness.getActiveFounderCharter({ projectId })?.id).toBe(second);

    const viaPublic = harness.getActiveFounderCharter({ projectId });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.getActiveFounderCharterWithDb(db, { projectId }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb?.id).toBe(second);
    expect(first).not.toBe(second);
  });

  test("getActiveFounderCharterWithDb returns null when no charter is active", () => {
    const projectId = seedProject();
    seedCharter(projectId, "Dormant charter", false);

    expect(harness.getActiveFounderCharter({ projectId })).toBeNull();
    expect(
      withDatabase(harness.dbPath, (db) => harness.getActiveFounderCharterWithDb(db, { projectId })),
    ).toBeNull();
  });

  test("getFounderCharter and WithDb agree for a pinned charter id", () => {
    const projectId = seedProject();
    const charterId = seedCharter(projectId, "Pinned charter");

    const viaPublic = harness.getFounderCharter({ id: charterId });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.getFounderCharterWithDb(db, { id: charterId }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb?.id).toBe(charterId);
  });

  test("getFounderCharterWithDb returns null for an unknown id and matches public behavior", () => {
    const viaPublic = harness.getFounderCharter({ id: "charter_missing" });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.getFounderCharterWithDb(db, { id: "charter_missing" }),
    );
    expect(viaPublic).toBeNull();
    expect(viaWithDb).toBeNull();
  });

  test("getStrategySignal and WithDb agree on the resolved signal", () => {
    const projectId = seedProject();
    const signalId = seedSignal(projectId, "2026-08-01T00:00:00.000Z");

    const viaPublic = harness.getStrategySignal({ id: signalId });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.getStrategySignalWithDb(db, { id: signalId }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb?.id).toBe(signalId);
  });

  test("listStrategySignals and WithDb agree on filtering and ordering", () => {
    const projectId = seedProject();
    const active = seedSignal(projectId, "2026-08-01T00:00:00.000Z", "active");
    seedSignal(projectId, "2026-07-01T00:00:00.000Z", "expired");

    const viaPublic = harness.listStrategySignals({ projectId, statuses: ["active"] });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.listStrategySignalsWithDb(db, { projectId, statuses: ["active"] }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb.map((signal) => signal.id)).toEqual([active]);
  });

  test("listDesignProposals and WithDb agree on filtering and ordering", () => {
    const projectId = seedProject();
    const charterId = seedCharter(projectId, "Charter for proposals");
    const accepted = seedProposal(projectId, charterId, "Accepted proposal", "accepted");
    const draft = seedProposal(projectId, charterId, "Draft proposal", "draft");

    const viaPublic = harness.listDesignProposals({ projectId });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.listDesignProposalsWithDb(db, { projectId }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(new Set(viaWithDb.map((proposal) => proposal.id))).toEqual(new Set([draft, accepted]));

    const acceptedPublic = harness.listDesignProposals({ projectId, statuses: ["accepted"] });
    const acceptedWithDb = withDatabase(harness.dbPath, (db) =>
      harness.listDesignProposalsWithDb(db, { projectId, statuses: ["accepted"] }),
    );
    expect(acceptedWithDb).toEqual(acceptedPublic);
    expect(acceptedWithDb.map((proposal) => proposal.id)).toEqual([accepted]);
  });

  test("listHarnessActionEvents and WithDb agree on rowid-desc ordering and limit", () => {
    const first = seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" });
    const second = seedActionEvent("design.proposeDesign", { type: "proposeDesign", runId: "run_a", taskId: "task_a" });
    const third = seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_b", taskId: "task_b" });

    const viaPublic = harness.listHarnessActionEvents({ limit: 2 });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.listHarnessActionEventsWithDb(db, { limit: 2 }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb.map((event) => event.id)).toEqual([third, second]);

    const allPublic = harness.listHarnessActionEvents();
    const allWithDb = withDatabase(harness.dbPath, (db) => harness.listHarnessActionEventsWithDb(db));
    expect(allWithDb).toEqual(allPublic);
    expect(allWithDb.map((event) => event.id)).toEqual([third, second, first]);
  });

  test("listHarnessActionEvents preserves the public limit: 0 contract", () => {
    seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" });

    // Public callers that explicitly pass `limit: 0` must receive an empty list.
    // SQLite `LIMIT 0` returns no rows; we must not silently substitute the
    // default. The WithDb variant shares this contract so production
    // coordinators reading inside a transaction see the same shape.
    expect(harness.listHarnessActionEvents({ limit: 0 })).toEqual([]);
    expect(
      withDatabase(harness.dbPath, (db) => harness.listHarnessActionEventsWithDb(db, { limit: 0 })),
    ).toEqual([]);

    // Default still applies when limit is omitted entirely.
    expect(harness.listHarnessActionEvents()).toHaveLength(1);
    expect(withDatabase(harness.dbPath, (db) => harness.listHarnessActionEventsWithDb(db))).toHaveLength(1);
  });

  test("listHarnessActionEventsWithDb resolves prior audit rows by action type and request shape", () => {
    seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" });
    seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" });
    seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_b", taskId: "task_b" });
    seedActionEvent("design.proposeDesign", { type: "proposeDesign", runId: "run_a", taskId: "task_a" });
    seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" }, "blocked");

    const runASignalsDone = withDatabase(harness.dbPath, (db) =>
      harness.listHarnessActionEventsWithDb(db, {
        actionType: "design.recordSignal",
        statuses: ["done"],
        requestType: "recordSignal",
        requestRunId: "run_a",
        requestTaskId: "task_a",
        limit: 50,
      }),
    );
    expect(runASignalsDone).toHaveLength(2);
    for (const event of runASignalsDone) {
      expect(event.actionType).toBe("design.recordSignal");
      expect(event.status).toBe("done");
      expect(event.request.runId).toBe("run_a");
      expect(event.request.taskId).toBe("task_a");
      expect(event.request.type).toBe("recordSignal");
    }

    const runASignalsAllStatuses = withDatabase(harness.dbPath, (db) =>
      harness.listHarnessActionEventsWithDb(db, {
        actionType: "design.recordSignal",
        requestRunId: "run_a",
        requestTaskId: "task_a",
        limit: 50,
      }),
    );
    expect(runASignalsAllStatuses).toHaveLength(3);

    const proposeForRunA = withDatabase(harness.dbPath, (db) =>
      harness.listHarnessActionEventsWithDb(db, {
        actionType: "design.proposeDesign",
        requestRunId: "run_a",
        limit: 50,
      }),
    );
    expect(proposeForRunA).toHaveLength(1);
    expect(proposeForRunA[0].actionType).toBe("design.proposeDesign");
  });

  test("getHarnessActionEvent and WithDb agree for a known id and a missing id", () => {
    const eventId = seedActionEvent("design.recordSignal", { type: "recordSignal", runId: "run_a", taskId: "task_a" });

    const viaPublic = harness.getHarnessActionEvent({ id: eventId });
    const viaWithDb = withDatabase(harness.dbPath, (db) =>
      harness.getHarnessActionEventWithDb(db, { id: eventId }),
    );
    expect(viaWithDb).toEqual(viaPublic);
    expect(viaWithDb?.id).toBe(eventId);

    expect(harness.getHarnessActionEvent({ id: "action_missing" })).toBeNull();
    expect(
      withDatabase(harness.dbPath, (db) => harness.getHarnessActionEventWithDb(db, { id: "action_missing" })),
    ).toBeNull();
  });

  test("WithDb reads observe uncommitted writes inside one transaction and roll back with it", () => {
    const projectId = seedProject();
    const charterId = seedCharter(projectId, "Charter");
    const proposalId = seedProposal(projectId, charterId, "Initial proposal", "proposed");

    // Inside the transaction, mark the proposal accepted and create a fresh
    // audit event using WithDb variants so they share the transaction
    // connection. The WithDb reads must observe both. After the rollback, the
    // outer world (public reads) must observe neither.
    let seenProposalDuringTx: { status: string } | null = null;
    let seenEventDuringTx: { actionType: string } | null = null;
    expect(() => {
      harness.runInTransaction((db) => {
        harness.updateDesignProposalStatusWithDb(db, { proposalId, status: "accepted" });
        const eventId = harness.recordHarnessActionEventWithDb(db, {
          actionType: "design.transitionProbe",
          status: "done",
          request: { type: "transitionProbe", runId: "run_a", taskId: "task_a" },
          result: { ok: true },
        });
        seenProposalDuringTx = harness.getDesignProposalWithDb(db, { id: proposalId });
        seenEventDuringTx = harness.getHarnessActionEventWithDb(db, { id: eventId });
        // Throw to force a rollback so we can assert the writes never landed.
        throw new Error("force rollback");
      });
    }).toThrow("force rollback");

    expect(seenProposalDuringTx).toMatchObject({ status: "accepted" });
    expect(seenEventDuringTx).toMatchObject({ actionType: "design.transitionProbe" });

    // After the rollback, the public reads must reflect the original state.
    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("proposed");
    expect(harness.listHarnessActionEvents({ limit: 50 }).map((event) => event.actionType)).not.toContain(
      "design.transitionProbe",
    );
  });

  test("WithDb signal and proposal reads observe each other within a single transaction", () => {
    const projectId = seedProject();
    const charterId = seedCharter(projectId, "Active charter");

    expect(() => {
      harness.runInTransaction((db) => {
        // Create a signal and a proposal via their WithDb variants so they share
        // the transaction connection. Public read variants on a separate
        // connection would block on the open write transaction or miss the
        // uncommitted rows entirely.
        const signal = harness.createStrategySignalWithDb(db, {
          projectId,
          signalClass: "delivery",
          source: "verifier",
          title: "Transaction signal",
          summary: "Visible inside the open transaction.",
          observationTime: "2026-08-01T00:00:00.000Z",
          confidence: 0.6,
          evidence: [],
        });
        const proposal = harness.createDesignProposalWithDb(db, {
          projectId,
          charterId,
          title: "Transaction proposal",
          problem: "Problem statement.",
          recommendation: "Recommendation.",
          proposal: {
            problem: "Problem statement.",
            recommendation: "Recommendation.",
            evaluationContract: {
              baseline: [],
              successMetrics: ["metric"],
              guardMetrics: [],
              requiredEvidence: ["evidence"],
              reviewAt: "2026-09-01T00:00:00.000Z",
            },
            investment: {
              reversibility: "easy",
              portfolio: "core",
              oneTimeCost: 0,
              recurringCost: 0,
            },
            evidenceRefs: ["sig_a"],
          },
          status: "proposed",
        });

        const active = harness.getActiveFounderCharterWithDb(db, { projectId });
        expect(active?.id).toBe(charterId);
        const pinned = harness.getFounderCharterWithDb(db, { id: charterId });
        expect(pinned?.id).toBe(charterId);
        expect(harness.getStrategySignalWithDb(db, { id: signal.id })?.id).toBe(signal.id);
        expect(
          harness.listStrategySignalsWithDb(db, { projectId, statuses: ["active"] }).map((row) => row.id),
        ).toContain(signal.id);
        expect(
          harness.listDesignProposalsWithDb(db, { projectId, statuses: ["proposed"] }).map((row) => row.id),
        ).toEqual([proposal.id]);
        // Throw to roll back so the seed data does not leak between tests.
        throw new Error("force rollback");
      });
    }).toThrow("force rollback");

    // After rollback the strategy_signals / design_proposals tables must be
    // empty for this project — proving the WithDb writes shared the open
    // transaction rather than committing on a separate connection.
    expect(harness.listStrategySignals({ projectId })).toEqual([]);
    expect(harness.listDesignProposals({ projectId })).toEqual([]);
  });
});

describe("Founder charter authority evaluator", () => {
  function makeCharter(overrides: Partial<AuthorityCharterContext> = {}): AuthorityCharterContext {
    return {
      id: "charter_test",
      version: 1,
      isActive: true,
      mission: "Build a safe autonomous strategy loop.",
      capitalPolicy: {
        currency: "USD",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: 2 },
      },
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        autoIntegrateVerifiedCode: false,
        requireHumanFor: [],
      },
      ...overrides,
    };
  }

  function makeProposal(overrides: Partial<AuthorityProposalRiskSurface> = {}): AuthorityProposalRiskSurface {
    return {
      proposalId: "proposal_test",
      reversibility: "easy",
      portfolio: "exploration",
      oneTimeCost: 50,
      recurringCost: 0,
      evidenceRefs: ["sig_a", "sig_b"],
      amendsMission: false,
      amendsCapitalPolicy: false,
      legalOrPrivacy: false,
      sensitiveData: false,
      destructiveOperation: false,
      productionDeployment: false,
      unplannedDependency: false,
      schemaMigration: false,
      recurringInfrastructure: false,
      declaredHumanCategories: [],
      ...overrides,
    };
  }

  function makeEvidence(overrides: Array<Partial<AuthorityEvidenceReference>> = []): AuthorityEvidenceReference[] {
    const base: AuthorityEvidenceReference[] = [
      { ref: "sig_a", kind: "signal", expiresAt: "3025-01-01T00:00:00.000Z", hasConflict: false },
      { ref: "sig_b", kind: "signal", expiresAt: "3025-01-01T00:00:00.000Z", hasConflict: false },
    ];
    if (overrides.length === 0) return base;
    return base.map((item, idx) => ({ ...item, ...overrides[idx] }));
  }

  function makeActor(overrides: Partial<AuthorityActorContext> = {}): AuthorityActorContext {
    return {
      kind: "human",
      ref: "founder",
      isProposer: false,
      ...overrides,
    };
  }

  function makeUsage(
    overrides: Partial<AuthorityPortfolioUsage> = {},
  ): AuthorityPortfolioUsage {
    return {
      category: "exploration",
      currentShare: 0,
      ...overrides,
    };
  }

  function evaluate(overrides: Partial<AuthorityEvaluationInput> = {}) {
    return evaluateAuthority({
      charter: makeCharter(),
      proposal: makeProposal(),
      evidence: makeEvidence(),
      actor: makeActor(),
      portfolioUsage: makeUsage(),
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      ...overrides,
    });
  }

  test("happy path: explicit true delegation, easy reverse, fresh evidence authorizes automatically", () => {
    const result = evaluate();
    expect(result.disposition).toBe("automatic");
    expect(result.reasons).toEqual([]);
    expect(result.budget.withinExperimentBudget).toBe(true);
    expect(result.budget.withinRecurringThreshold).toBe(true);
    expect(result.portfolio.withinShare).toBe(true);
  });

  test("cost-only policy authorizes zero-spend technical risk without a human checkpoint", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        humanApprovalPolicy: "cost-only",
        requireHumanFor: [],
      },
    });
    const proposal = makeProposal({
      oneTimeCost: 0,
      recurringCost: 0,
      reversibility: "hard",
      productionDeployment: true,
      schemaMigration: true,
    });

    const result = evaluate({ charter, proposal });

    expect(result.disposition).toBe("automatic");
    expect(result.reasons.some((reason) => reason.kind === "cost-requires-human-decision")).toBe(false);
  });

  test("cost-only policy defers any real spend to a human decision", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        humanApprovalPolicy: "cost-only",
        requireHumanFor: [],
      },
    });

    const result = evaluate({
      charter,
      proposal: makeProposal({ oneTimeCost: 1, recurringCost: 0 }),
    });

    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((reason) => reason.kind === "cost-requires-human-decision")).toBe(true);
  });

  test("cost-only policy rejects malformed evidence autonomously instead of asking a human", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        humanApprovalPolicy: "cost-only",
        requireHumanFor: [],
      },
    });

    const result = evaluate({ charter, evidence: [] });

    expect(result.disposition).toBe("rejected");
    expect(result.reasons.some((reason) => reason.kind === "missing-evidence")).toBe(true);
  });

  test("autoReversibleExperiments absent fails closed to human-required", () => {
    const charter = makeCharter({ authority: { autoResearch: true } });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "auto-reversible-experiments-disabled");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(false);
  });

  test("autoReversibleExperiments non-boolean fails closed", () => {
    const charter = makeCharter({
      authority: { autoResearch: true, autoReversibleExperiments: "yes" as unknown as true },
    });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "auto-reversible-experiments-disabled")).toBe(true);
  });

  test("autoReversibleExperiments false fails closed", () => {
    const charter = makeCharter({
      authority: { autoResearch: true, autoReversibleExperiments: false },
    });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "auto-reversible-experiments-disabled")).toBe(true);
  });

  test("invalid evidence expiry timestamp fails closed with auditable reason", () => {
    const evidence = makeEvidence([{ expiresAt: "not-a-timestamp" }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "invalid-evidence-expiry");
    expect(reason).toBeDefined();
    expect(reason?.evidenceRefs).toEqual(["sig_a"]);
    expect(result.evidence.invalidExpiry).toContain("sig_a");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("invalid-evidence-expiry");
  });

  test("empty-string evidence expiry is treated as invalid", () => {
    const evidence = makeEvidence([{ expiresAt: "" }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-evidence-expiry")).toBe(true);
  });

  test("numeric expiresAt fails closed instead of being coerced to a future date", () => {
    // Adversarial probe mirroring the verifier's failing case: Date.parse(9999)
    // returns a valid future date, which would silently authorize stale or
    // numeric garbage. The evaluator must require expiresAt to be null or a
    // non-empty string before parsing.
    const evidence = makeEvidence([{ expiresAt: 9999 as unknown as string }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "invalid-evidence-expiry");
    expect(reason).toBeDefined();
    expect(reason?.evidenceRefs).toEqual(["sig_a"]);
    expect(result.evidence.invalidExpiry).toContain("sig_a");
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("boolean expiresAt fails closed instead of being coerced", () => {
    const evidence = makeEvidence([{ expiresAt: true as unknown as string }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-evidence-expiry")).toBe(true);
  });

  test("object expiresAt fails closed instead of being coerced", () => {
    const evidence = makeEvidence([
      { expiresAt: { iso: "3025-01-01" } as unknown as string },
    ]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-evidence-expiry")).toBe(true);
  });

  test("null expiresAt remains valid (no expiry asserted)", () => {
    const evidence = makeEvidence([{ expiresAt: null }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("automatic");
    expect(result.evidence.invalidExpiry).toEqual([]);
  });

  test("non-boolean conflict metadata fails closed with auditable reason", () => {
    const evidence = makeEvidence([{ hasConflict: "yes" as unknown as boolean }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "invalid-conflict-metadata");
    expect(reason).toBeDefined();
    expect(reason?.evidenceRefs).toEqual(["sig_a"]);
    expect(result.evidence.invalidConflictMetadata).toContain("sig_a");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("invalid-conflict-metadata");
  });

  test("missing conflict metadata (undefined) fails closed", () => {
    const evidence = makeEvidence([{ hasConflict: undefined as unknown as boolean }]);
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-conflict-metadata")).toBe(true);
  });

  test("negative one-time cost fails closed with auditable reason", () => {
    const proposal = makeProposal({ oneTimeCost: -10 });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "invalid-cost-shape");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("invalid-cost-shape");
  });

  test("negative recurring cost fails closed", () => {
    const proposal = makeProposal({ recurringCost: -1 });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-cost-shape")).toBe(true);
  });

  test("non-finite cost fails closed", () => {
    const proposal = makeProposal({ oneTimeCost: Number.POSITIVE_INFINITY });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-cost-shape")).toBe(true);
  });

  test("NaN cost fails closed", () => {
    const proposal = makeProposal({ oneTimeCost: Number.NaN });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-cost-shape")).toBe(true);
  });

  test("unknown portfolio category fails closed", () => {
    const proposal = makeProposal({ portfolio: "blitzscale" as unknown as "exploration" });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "unknown-risk-data");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("blitzscale");
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("missing selected-category allocation fails closed", () => {
    const charter = makeCharter({
      capitalPolicy: {
        currency: "USD",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3 },
      },
    });
    const proposal = makeProposal({ portfolio: "exploration" });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "portfolio-allocation-missing");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("exploration");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("portfolio-allocation-missing");
  });

  test("invalid (non-finite) selected-category allocation fails closed", () => {
    const charter = makeCharter({
      capitalPolicy: {
        currency: "USD",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: Number.NaN },
      },
    });
    const proposal = makeProposal({ portfolio: "exploration" });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "portfolio-allocation-missing")).toBe(true);
  });

  test("expired evidence hard-rejects regardless of actor identity", () => {
    const evidence = makeEvidence([{ expiresAt: "2020-01-01T00:00:00.000Z" }]);
    const humanActor = makeActor({ kind: "human", ref: "founder", isProposer: false });
    const result = evaluate({ evidence, actor: humanActor });
    expect(result.disposition).toBe("rejected");
    const reason = result.reasons.find((r) => r.kind === "expired-evidence");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("high-risk proposal remains non-automatic even when actor claims human authority", () => {
    const proposal = makeProposal({ productionDeployment: true });
    const humanActor = makeActor({ kind: "human", ref: "opsLead", isProposer: false });
    const result = evaluate({ proposal, actor: humanActor });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "production-deployment")).toBe(true);
    expect(result.reasons.some((r) => r.kind === "actor-not-allowed-for-high-risk")).toBe(true);
  });

  test("high-risk proposal blocks proposer self-authorization", () => {
    const proposal = makeProposal({ sensitiveData: true });
    const proposer = makeActor({ kind: "human", ref: "designer", isProposer: true });
    const result = evaluate({ proposal, actor: proposer });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "proposer-cannot-self-authorize")).toBe(true);
  });

  test("malformed risk flag (non-boolean) fails closed", () => {
    const proposal = makeProposal({ legalOrPrivacy: undefined as unknown as boolean });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "unknown-risk-data" && r.message.includes("legalOrPrivacy"));
    expect(reason).toBeDefined();
  });

  test("invalid evaluatedAt fails closed instead of authorizing stale evidence", () => {
    const evidence = makeEvidence([{ expiresAt: "2020-01-01T00:00:00.000Z" }]);
    const result = evaluate({ evidence, evaluatedAt: "garbage" });
    expect(result.disposition).not.toBe("automatic");
    expect(result.evidence.evaluatedAtValid).toBe(false);
    expect(result.reasons.some((r) => r.kind === "unknown-risk-data")).toBe(true);
  });

  test("moderate reversibility routes to human review", () => {
    const proposal = makeProposal({ reversibility: "moderate" });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "moderate-reversibility")).toBe(true);
  });

  test("hard reversibility routes to human review", () => {
    const proposal = makeProposal({ reversibility: "hard" });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "hard-reversibility")).toBe(true);
  });

  test("requireHumanFor category match routes to human review", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: ["capital"],
      },
    });
    const proposal = makeProposal({ declaredHumanCategories: ["capital"] });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "require-human-category")).toBe(true);
  });

  test("empty evidence reference set fails closed with missing-evidence", () => {
    const proposal = makeProposal({ evidenceRefs: [] });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "missing-evidence");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("no evidence references");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("missing-evidence");
  });

  test("non-array evidence references fail closed", () => {
    const proposal = makeProposal({ evidenceRefs: "sig_a" as unknown as string[] });
    const result = evaluate({ proposal });
    expect(result.disposition).not.toBe("automatic");
  });

  test("undefined evidence references fail closed without throwing", () => {
    const proposal = makeProposal({ evidenceRefs: undefined as unknown as string[] });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "missing-evidence")).toBe(true);
  });

  test("non-string evidence reference entry fails closed", () => {
    const proposal = makeProposal({
      evidenceRefs: ["sig_a", 42 as unknown as string, "" as unknown as string],
    });
    const result = evaluate({ proposal });
    expect(result.disposition).toBe("human-required");
    const reasons = result.reasons.filter((r) => r.kind === "missing-evidence");
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.some((r) => r.message.includes("42"))).toBe(true);
    expect(reasons.some((r) => r.message.includes('""'))).toBe(true);
  });

  test("truthy non-boolean isActive fails closed as charter-inactive", () => {
    const charter = makeCharter({ isActive: "false" as unknown as boolean });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("rejected");
    const reason = result.reasons.find((r) => r.kind === "charter-inactive");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("isActive");
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("numeric isActive fails closed as charter-inactive", () => {
    const charter = makeCharter({ isActive: 1 as unknown as boolean });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("rejected");
    expect(result.reasons.some((r) => r.kind === "charter-inactive")).toBe(true);
  });

  test("truthy non-string currency fails closed as missing-currency-policy", () => {
    const charter = makeCharter({
      capitalPolicy: {
        currency: 123 as unknown as string,
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: 2 },
      },
    });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "missing-currency-policy");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("invalid currency");
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("empty-string currency fails closed", () => {
    const charter = makeCharter({
      capitalPolicy: {
        currency: "",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: 2 },
      },
    });
    const result = evaluate({ charter });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "missing-currency-policy")).toBe(true);
  });

  test("portfolio usage category mismatch fails closed", () => {
    const proposal = makeProposal({ portfolio: "core" });
    const usage = makeUsage({ category: "exploration", currentShare: 1 });
    const result = evaluate({ proposal, portfolioUsage: usage });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "portfolio-usage-category-mismatch");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("exploration");
    expect(reason?.message).toContain("core");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("portfolio-usage-category-mismatch");
  });

  test("NaN portfolio usage currentShare fails closed", () => {
    const usage = makeUsage({ currentShare: Number.NaN });
    const result = evaluate({ portfolioUsage: usage });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "invalid-portfolio-usage");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("invalid-portfolio-usage");
  });

  test("negative portfolio usage currentShare fails closed", () => {
    const usage = makeUsage({ currentShare: -1 });
    const result = evaluate({ portfolioUsage: usage });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "invalid-portfolio-usage")).toBe(true);
  });

  test("portfolio usage unavailable (undefined) fails closed", () => {
    const result = evaluate({ portfolioUsage: undefined });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "portfolio-usage-unavailable");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("portfolio-usage-unavailable");
  });

  test("portfolio usage null fails closed with auditable reason", () => {
    const result = evaluate({ portfolioUsage: null });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "portfolio-usage-unavailable");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("portfolio usage currentShare null admits first investment under positive allocation", () => {
    const usage = makeUsage({ currentShare: null });
    const result = evaluate({ portfolioUsage: usage });
    expect(result.disposition).toBe("automatic");
    expect(result.portfolio.withinShare).toBe(true);
    expect(result.portfolio.currentShare).toBeNull();
    expect(result.portfolio.proposedShare).toBe(1);
  });

  test("portfolio usage currentShare zero authorizes first investment", () => {
    const usage = makeUsage({ currentShare: 0 });
    const result = evaluate({ portfolioUsage: usage });
    expect(result.disposition).toBe("automatic");
    expect(result.portfolio.withinShare).toBe(true);
    expect(result.portfolio.proposedShare).toBe(1);
  });

  test("zero allocation with null currentShare never authorizes the first investment (adversarial probe)", () => {
    // Independent adversarial probe: configured share is 0 and currentShare is
    // null (no existing investment). The previous implementation converted null
    // to proposedShare=null and treated null as "not over quota", authorizing
    // a first unit silently. The fixed evaluator must treat the first investment
    // as proposedShare=1, mark withinShare=false, surface an auditable
    // portfolio-allocation-exceeded reason, and refuse automatic authority.
    const charter = makeCharter({
      capitalPolicy: {
        currency: "USD",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: 0 },
      },
    });
    const usage = makeUsage({ category: "exploration", currentShare: null });
    const result = evaluate({ charter, portfolioUsage: usage });
    expect(result.disposition).not.toBe("automatic");
    expect(result.disposition).toBe("human-required");
    expect(result.portfolio.configuredShare).toBe(0);
    expect(result.portfolio.currentShare).toBeNull();
    expect(result.portfolio.proposedShare).toBe(1);
    expect(result.portfolio.withinShare).toBe(false);
    const reason = result.reasons.find((r) => r.kind === "portfolio-allocation-exceeded");
    expect(reason).toBeDefined();
    expect(reason?.message).toContain("exploration");
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(HARD_AUTHORITY_RULES).toContain("portfolio-allocation-exceeded");
  });

  test("zero allocation with currentShare zero also refuses the first investment", () => {
    const charter = makeCharter({
      capitalPolicy: {
        currency: "USD",
        experimentBudget: 1000,
        recurringSpendApprovalAbove: 100,
        portfolio: { core: 5, growth: 3, exploration: 0 },
      },
    });
    const usage = makeUsage({ category: "exploration", currentShare: 0 });
    const result = evaluate({ charter, portfolioUsage: usage });
    expect(result.disposition).toBe("human-required");
    expect(result.portfolio.proposedShare).toBe(1);
    expect(result.portfolio.withinShare).toBe(false);
    expect(result.reasons.some((r) => r.kind === "portfolio-allocation-exceeded")).toBe(true);
  });

  test("non-array declaredHumanCategories fails closed without throwing", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: ["capital"],
      },
    });
    const proposal = makeProposal({
      declaredHumanCategories: "capital" as unknown as string[],
    });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find((r) => r.kind === "unknown-risk-data" && r.message.includes("declaredHumanCategories"));
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("non-string entry inside declaredHumanCategories fails closed", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: ["capital"],
      },
    });
    const proposal = makeProposal({
      declaredHumanCategories: ["capital", 7 as unknown as string],
    });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "require-human-category")).toBe(true);
    expect(result.reasons.some((r) => r.kind === "unknown-risk-data" && r.message.includes("7"))).toBe(true);
  });

  test("non-array declaredHumanCategories fails closed even when requireHumanFor is empty", () => {
    // Adversarial probe mirroring the verifier's failing case: when the charter
    // requires no human categories, the prior implementation short-circuited
    // before validating declaredHumanCategories and authorized a malformed
    // container. The fail-closed contract must validate both containers
    // regardless of whether either is empty.
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: [],
      },
    });
    const proposal = makeProposal({
      declaredHumanCategories: "security" as unknown as string[],
    });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).not.toBe("automatic");
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find(
      (r) => r.kind === "unknown-risk-data" && r.message.includes("declaredHumanCategories"),
    );
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("non-string entry inside declaredHumanCategories fails closed even when requireHumanFor is empty", () => {
    // A non-array element must always be audited; deferring validation until
    // requireHumanFor becomes non-empty would hide malformed data behind a
    // quieter charter.
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: [],
      },
    });
    const proposal = makeProposal({
      declaredHumanCategories: ["security", 7 as unknown as string],
    });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    expect(
      result.reasons.some((r) => r.kind === "unknown-risk-data" && r.message.includes("7")),
    ).toBe(true);
  });

  test("non-array requireHumanFor fails closed with auditable reason", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: "capital" as unknown as string[],
      },
    });
    const proposal = makeProposal({ declaredHumanCategories: [] });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    const reason = result.reasons.find(
      (r) => r.kind === "unknown-risk-data" && r.message.includes("requireHumanFor"),
    );
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
  });

  test("non-string entry inside requireHumanFor fails closed with auditable reason", () => {
    const charter = makeCharter({
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        requireHumanFor: ["capital", 7 as unknown as string],
      },
    });
    const proposal = makeProposal({ declaredHumanCategories: [] });
    const result = evaluate({ charter, proposal });
    expect(result.disposition).toBe("human-required");
    expect(
      result.reasons.some(
        (r) => r.kind === "unknown-risk-data" && r.message.includes("requireHumanFor"),
      ),
    ).toBe(true);
  });

  test("non-array evidence input fails closed without throwing", () => {
    const result = evaluate({ evidence: "not-an-array" as unknown as AuthorityEvidenceReference[] });
    expect(result.disposition).not.toBe("automatic");
    expect(result.disposition).toBe("human-required");
    expect(result.reasons.some((r) => r.kind === "missing-evidence")).toBe(true);
  });

  test("non-object evidence item fails closed rather than authorizing automatically", () => {
    // A malformed evidence entry (null, primitive, etc.) inside an otherwise
    // resolvable array must not be silently skipped. The verifier proved that
    // skipping allows automatic authorization even though the caller supplied
    // untrusted data. The fail-closed contract requires a non-automatic
    // disposition with an auditable malformed-evidence-item reason.
    const evidence = [null as unknown as AuthorityEvidenceReference, ...makeEvidence()];
    const result = evaluate({ evidence });
    expect(result.disposition).not.toBe("automatic");
    expect(result.disposition).toBe("human-required");
    expect(result.evidence.malformedItems).toBe(1);
    const reason = result.reasons.find((r) => r.kind === "malformed-evidence-item");
    expect(reason).toBeDefined();
    expect(isHardAuthorityReason(reason!)).toBe(true);
    expect(reason!.message).toContain("null");
  });

  test("multiple malformed evidence entries each produce a fail-closed reason", () => {
    // Every malformed entry must be audited; aggregating them into a single
    // reason would let one valid record mask the rest.
    const evidence = [
      null as unknown as AuthorityEvidenceReference,
      7 as unknown as AuthorityEvidenceReference,
      "stray" as unknown as AuthorityEvidenceReference,
      ...makeEvidence(),
    ];
    const result = evaluate({ evidence });
    expect(result.disposition).toBe("human-required");
    expect(result.evidence.malformedItems).toBe(3);
    const reasons = result.reasons.filter((r) => r.kind === "malformed-evidence-item");
    expect(reasons).toHaveLength(3);
    for (const reason of reasons) {
      expect(isHardAuthorityReason(reason)).toBe(true);
    }
  });

  test("malformed evidence item blocks even when the proposal cites a valid reference", () => {
    // Adversarial probe mirroring the verifier's failing case: a single null
    // entry alongside a valid record must still fail closed.
    const evidence: AuthorityEvidenceReference[] = [
      null as unknown as AuthorityEvidenceReference,
      { ref: "sig_a", kind: "signal", expiresAt: "3025-01-01T00:00:00.000Z", hasConflict: false },
    ];
    const result = evaluate({
      evidence,
      proposal: makeProposal({ evidenceRefs: ["sig_a"] }),
    });
    expect(result.disposition).not.toBe("automatic");
    expect(result.reasons.some((r) => r.kind === "malformed-evidence-item")).toBe(true);
  });

  test("describeAuthorityEvaluation summarizes reasons", () => {
    const blocked = evaluate({ proposal: makeProposal({ oneTimeCost: -5 }) });
    const text = describeAuthorityEvaluation(blocked);
    expect(text).toContain("authority=human-required");
    expect(text).toContain("invalid-cost-shape");
  });

  test("pure evaluator has no database or filesystem access", () => {
    // The evaluator accepts only data, not handles. Asserting by construction:
    // there is no harness, db, or path parameter on AuthorityEvaluationInput.
    const sample: AuthorityEvaluationInput = {
      charter: makeCharter(),
      proposal: makeProposal(),
      evidence: makeEvidence(),
      actor: makeActor(),
      evaluatedAt: "2026-08-02T00:00:00.000Z",
    };
    const keys = Object.keys(sample).sort();
    expect(keys).toEqual(["actor", "charter", "evidence", "evaluatedAt", "proposal"].sort());
    // AuthorityEvaluationInput carries no harness, db, or path fields — only
    // plain JSON-serializable data. The evaluator can be transported across a
    // process boundary without losing fidelity.
    expect(() => JSON.stringify(sample)).not.toThrow();
  });
});

describe("Evolution runtime fixed actions", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  const SHA_C = "c".repeat(64);
  const ZERO_SIDE_EFFECTS = {
    paidUsd: 0,
    realProviderCalls: 0,
    pancatWrites: 0,
    productionPublishes: 0,
    realAssetDeletes: 0,
    crossProjectMemoryReads: 0,
    crossProjectMemoryWrites: 0,
  } as const;

  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-evolution-actions-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function addressed<T extends Record<string, unknown>>(
    kind: "profile" | "episode" | "variant" | "experiment",
    value: T,
  ): T & { id: string } {
    const { id: _ignored, ...body } = value;
    return { ...body, id: expectedEvolutionRecordId(kind, body) } as T & { id: string };
  }

  function fixture() {
    const projectId = harness.createProject({
      id: "project_hodor_evolution_actions",
      name: "Hodor",
      rootPath: join(dir, "hodor"),
    });
    const charter = harness.createFounderCharter({
      id: "charter_hodor_evolution_actions",
      projectId,
      mission: "Improve Hodor from bounded replay evidence.",
      charter: {
        mission: "Improve Hodor from bounded replay evidence.",
        principles: ["No production side effects during shadow design."],
        nonGoals: ["No model mutation."],
      },
      activate: true,
    });
    const pack = {
      schemaVersion: 1 as const,
      id: "pack_hodor_evolution_actions",
      targetSystemId: "hodor",
      version: 1,
      knowledgeScope: `project:${projectId}` as const,
      objective: {
        charterId: charter.id,
        domainOutcomes: ["Reduce spatial-risk false positives."],
        nonGoals: ["No production mutation."],
      },
      observation: {
        signalSources: [{ id: "hodor_replay", kind: "domain-metric" as const }],
      },
      mutationSurfaces: [
        {
          id: "surface_policy",
          evolutionTarget: "artifact" as const,
          layer: "policy" as const,
          projectId,
          allowedPaths: ["config/evolution/**"],
          forbiddenPaths: ["config/evolution/forbidden/**"],
          owner: "target" as const,
        },
        {
          id: "surface_harness",
          evolutionTarget: "harness" as const,
          layer: "workflow" as const,
          projectId,
          allowedPaths: ["evals/evolution/**"],
          forbiddenPaths: ["evals/evolution/secrets/**"],
          owner: "ouroboros" as const,
        },
      ],
      experimentPolicy: {
        controlRequired: true as const,
        holdoutRequired: true as const,
        unrelatedRegressionRequired: true as const,
        equalBudgetRequired: true as const,
        maxCandidates: 1,
      },
      promotionPolicy: {
        guardMetrics: ["blocking-safety regressions"],
        observationWindow: "Frozen before any later shadow execution.",
        rollback: "A later authorized receipt must name exact rollback evidence.",
      },
      handoff: {
        maturity: "designed" as const,
        targetOwner: "hodor",
        requiredCapabilities: ["Immutable replay evidence."],
      },
      portability: {
        projectLocalRules: ["Hodor evidence remains project local."],
        genericizationEvidence: [],
      },
    };
    const comparison = {
      controlRef: "hodor_policy_control_v1",
      developmentEvidenceRefs: ["episode:hodor:development:001"],
      holdoutEvidenceRefs: ["episode:hodor:heldout:001"],
      unrelatedEvidenceRefs: ["episode:hodor:unrelated:001"],
      corpusSnapshotSha256: SHA_A,
      equalBudget: {
        model: "fixture-replay-no-provider",
        reasoningEffort: "high" as const,
        wallClockMs: 120_000,
        maxAttempts: 1,
        maxTokens: 20_000,
        toolPolicySha256: SHA_B,
        concurrency: 1,
      },
      primaryMetric: "spatial-risk false-positive rate",
      minimumUplift: 0.05,
      maximumGuardRegression: 0,
    };
    const packHash = canonicalEvolutionValueSha256(pack);
    const proposal = harness.createDesignProposal({
      id: "design_hodor_evolution_actions",
      projectId,
      charterId: charter.id,
      title: "Instrument Hodor evolution evidence",
      problem: "Hodor lacks immutable matched evolution evidence.",
      recommendation: "Activate an instrumented profile and freeze a shadow experiment specification.",
      status: "accepted",
      proposal: {
        problem: "Hodor lacks immutable matched evolution evidence.",
        recommendation: "Activate an instrumented profile and freeze a shadow experiment specification.",
        evolutionPack: pack,
        causalHypothesis: {
          failureClass: "domain-hypothesis",
          mechanism: "A bounded policy and harness variant can reduce replay false positives.",
          predictedEffects: ["Development replay improves."],
          disconfirmingEvidence: ["Heldout or unrelated guards regress."],
        },
        evaluationContract: {
          baseline: [comparison.controlRef],
          successMetrics: [comparison.primaryMetric],
          guardMetrics: [...pack.promotionPolicy.guardMetrics],
          requiredEvidence: ["transactional readback"],
          comparison,
        },
        investment: { reversibility: "easy", portfolio: "exploration", oneTimeCost: 0, recurringCost: 0 },
      },
    });
    const authorityDecision = harness.recordDesignDecision({
      id: "decision_hodor_evolution_actions",
      proposalId: proposal.id,
      charterId: charter.id,
      decision: "approved",
      actorKind: "auto",
      actorRef: "authority-evaluator",
      reasons: ["Zero-spend bounded instrumentation."],
      authority: { disposition: "automatic" },
    });
    const runId = harness.createRun({
      id: "run_hodor_evolution_actions",
      projectId,
      goal: "Freeze Hodor instrumented evolution evidence.",
      context: {
        source: "design",
        designProposalId: proposal.id,
        designDecisionId: authorityDecision.id,
        designCharterId: charter.id,
        designProposal: proposal.proposal,
        designEvaluationContract: proposal.proposal.evaluationContract,
        evolutionPack: pack,
        causalHypothesis: proposal.proposal.causalHypothesis,
        comparison,
        evolutionInstance: {
          schemaVersion: 1,
          mode: "design-target",
          kernelProjectId: "project_ouroboros_kernel",
          targetProjectId: projectId,
          cycle: { kind: "bootstrap", index: 1 },
          pack: { id: pack.id, version: pack.version, contentSha256: packHash },
        },
        evolutionComparison: comparison,
      },
    });
    const profile = parseEvolutionProfile(addressed("profile", {
      schemaVersion: 1 as const,
      projectId,
      pack: { id: pack.id, version: pack.version, contentSha256: packHash },
      charter: {
        id: charter.id,
        version: charter.version,
        contentSha256: canonicalEvolutionValueSha256(charter.charter),
      },
      runtimeMaturity: "declared",
      allowedSurfaceIds: pack.mutationSurfaces.map((surface) => surface.id),
      registeredAt: "2026-08-09T08:00:00.000Z",
    }), projectId);
    const episode = (
      split: "development" | "heldout" | "unrelated",
      marker: string = split,
      override: Record<string, unknown> = {},
    ) => {
      const sourceRefs = {
        development: comparison.developmentEvidenceRefs,
        heldout: comparison.holdoutEvidenceRefs,
        unrelated: comparison.unrelatedEvidenceRefs,
      };
      const inputSnapshotSha256 = typeof override.inputSnapshotSha256 === "string"
        ? override.inputSnapshotSha256
        : canonicalEvolutionValueSha256({ input: marker });
      const outcomeSnapshotSha256 = typeof override.outcomeSnapshotSha256 === "string"
        ? override.outcomeSnapshotSha256
        : canonicalEvolutionValueSha256({ outcome: marker });
      const {
        inputSnapshotSha256: _inputOverride,
        outcomeSnapshotSha256: _outcomeOverride,
        privacyReview: _privacyOverride,
        ...otherOverrides
      } = override;
      const privacyTaskId = harness.createTask({
        runId,
        role: "verifier",
        goal: `Review privacy for ${marker}`,
        prompt: "Verify the hashed replay episode without exposing raw content.",
      });
      const privacyAttemptId = harness.recordAttempt({
        taskId: privacyTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: `Approved privacy review for ${marker}`,
          checks: [{ name: "privacy policy", status: "passed" }],
          artifacts: [{
            kind: "privacy_review",
            status: "approved",
            policySha256: SHA_C,
            dataClassification: "confidential",
            retentionPolicyRef: "retention:test-only",
            inputSnapshotSha256,
            outcomeSnapshotSha256,
          }],
          problems: [],
        },
      });
      const privacyReceiptRef = `attempt:${privacyAttemptId}`;
      return parseProductionEpisode(addressed("episode", {
        schemaVersion: 1 as const,
        projectId,
        profileId: profile.id,
        sourceRef: sourceRefs[split][0],
        leakageGroupId: `leakage_${marker}`,
        observedAt: "2026-08-09T08:01:00.000Z",
        policyRef: "policy_hodor_replay_v1",
        metrics: split === "heldout" ? {} : { falsePositiveRate: 0.1 },
        sideEffectCounters: ZERO_SIDE_EFFECTS,
        evidenceRefs: split === "heldout" ? [privacyReceiptRef] : [`evidence:${marker}`],
        privacyReview: {
          status: "approved",
          policySha256: SHA_C,
          reviewerRef: privacyReceiptRef,
          dataClassification: "confidential",
          retentionPolicyRef: "retention:test-only",
          inputSnapshotSha256,
          outcomeSnapshotSha256,
          evidenceRefs: split === "heldout" ? [privacyReceiptRef] : [`privacy:${marker}`],
        },
        ...otherOverrides,
        inputSnapshotSha256,
        outcomeSnapshotSha256,
      }), projectId);
    };
    const control = parseHarnessVariant(addressed("variant", {
      schemaVersion: 1 as const,
      projectId,
      profileId: profile.id,
      role: "control",
      evolutionTargets: ["artifact"],
      contentSha256: SHA_A,
      mutationSurfaceIds: ["surface_policy"],
      changedPaths: ["config/evolution/control.json"],
      toolPolicySha256: SHA_B,
      createdFromEvidenceRefs: [comparison.controlRef],
    }), projectId);
    const candidate = parseHarnessVariant(addressed("variant", {
      schemaVersion: 1 as const,
      projectId,
      profileId: profile.id,
      role: "candidate",
      evolutionTargets: ["harness"],
      contentSha256: SHA_C,
      mutationSurfaceIds: ["surface_harness"],
      changedPaths: ["evals/evolution/candidate.test.ts"],
      toolPolicySha256: SHA_B,
      createdFromEvidenceRefs: [...comparison.developmentEvidenceRefs],
    }), projectId);
    const development = episode("development");
    const heldout = episode("heldout");
    const unrelated = episode("unrelated");
    const experiment = parseMatchedExperiment(addressed("experiment", {
      schemaVersion: 1 as const,
      projectId,
      profileId: profile.id,
      controlVariantId: control.id,
      candidateVariantId: candidate.id,
      developmentEpisodeRefs: [development.id],
      heldoutEpisodeRefs: [heldout.id],
      unrelatedEpisodeRefs: [unrelated.id],
      corpusSnapshotSha256: comparison.corpusSnapshotSha256,
      equalBudget: comparison.equalBudget,
      primaryMetric: comparison.primaryMetric,
      guardMetrics: pack.promotionPolicy.guardMetrics,
      sideEffectCounters: ZERO_SIDE_EFFECTS,
      outcome: "pending",
      evidenceRefs: ["evidence:experiment-spec"],
    }), projectId);
    return {
      projectId,
      charter,
      proposal,
      authorityDecision,
      pack,
      comparison,
      runId,
      profile,
      episode,
      development,
      heldout,
      unrelated,
      control,
      candidate,
      experiment,
    };
  }

  function applyDeclaredGraph(graph: ReturnType<typeof fixture>) {
    const results = [
      applyHarnessAction(harness, { type: "registerEvolutionProfile", runId: graph.runId, profile: graph.profile }),
      applyHarnessAction(harness, { type: "registerHarnessVariant", runId: graph.runId, variant: graph.control }),
      applyHarnessAction(harness, { type: "registerHarnessVariant", runId: graph.runId, variant: graph.candidate }),
    ];
    for (const result of results) {
      expect(result.status, result.summary).toBe("done");
      expect(result.artifacts[0]).toMatchObject({
        externalEffectsApplied: false,
        promotionApplied: false,
        replayed: false,
      });
    }
    return results;
  }

  function activationFixture(input: { trustedVariantReceipt?: boolean } = {}) {
    const graph = fixture();
    const rootRunId = harness.createRun({
      id: "run_continual_harness_root",
      projectId: graph.projectId,
      goal: "Continuously improve the project harness.",
      context: {
        source: "self-improve",
        selfImprovement: { cycleIndex: 0, assessmentFingerprint: SHA_A },
      },
    });
    harness.updateRun({ runId: graph.runId, contextPatch: { parentRunId: rootRunId } });
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("done");
    if (input.trustedVariantReceipt === false) {
      harness.recordHarnessVariant(graph.candidate);
    } else {
      expect(applyHarnessAction(harness, {
        type: "registerHarnessVariant",
        runId: graph.runId,
        variant: graph.candidate,
      }).status).toBe("done");
    }

    const verifiedRevision = (
      version: number,
      parentSha256: string | null,
      marker = String(version),
    ): HarnessRevisionV1 => {
      const attemptId = `attempt_harness_revision_${marker}`;
      const body: Omit<HarnessRevisionV1, "contentSha256"> = {
        schemaVersion: 1,
        projectId: graph.projectId,
        version,
        parentSha256,
        variant: {
          id: graph.candidate.id,
          recordSha256: canonicalEvolutionRecordSha256(graph.candidate),
          contentSha256: graph.candidate.contentSha256,
        },
        components: [
          { kind: "tools", ref: `repo:orbs/tools-${marker}.json`, sha256: SHA_B },
          { kind: "prompt", ref: `repo:prompts/harness-${marker}.md`, sha256: SHA_A },
          { kind: "agent-policy", ref: `content:agent-policy-${marker}`, sha256: SHA_C },
          { kind: "skills", ref: `mcp://orbs/skills/${marker}`, sha256: SHA_B },
          { kind: "knowledge", ref: `mcp://project/knowledge/${marker}`, sha256: SHA_A },
        ],
        evidenceRefs: [`attempt:${attemptId}`],
      };
      const revision: HarnessRevisionV1 = {
        ...body,
        contentSha256: canonicalHarnessRevisionContentSha256(body),
      };
      const verifierTaskId = harness.createTask({
        id: `task_harness_revision_${marker}`,
        runId: graph.runId,
        role: "verifier",
        goal: `Verify Harness revision ${marker}`,
        prompt: "Verify the frozen Harness revision and its candidate provenance.",
      });
      harness.recordAttempt({
        id: attemptId,
        taskId: verifierTaskId,
        input: { executor: "test" },
        output: {
          status: "done",
          summary: `Verified Harness revision ${marker}`,
          checks: [{ name: "frozen Harness revision", status: "passed" }],
          artifacts: [{
            kind: "harness_revision_verification",
            projectId: graph.projectId,
            variantId: graph.candidate.id,
            variantRecordSha256: canonicalEvolutionRecordSha256(graph.candidate),
            variantContentSha256: graph.candidate.contentSha256,
            revisionContentSha256: revision.contentSha256,
          }],
          problems: [],
        },
      });
      return revision;
    };

    return { ...graph, rootRunId, verifiedRevision };
  }

  test("activateHarnessRevision activates once and reuses the exact sequential retry", () => {
    const graph = activationFixture();
    const revision = graph.verifiedRevision(1, null);
    const request = {
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      revision,
    };

    const first = applyHarnessAction(harness, request);
    const replay = applyHarnessAction(harness, request);

    expect(first).toMatchObject({
      status: "done",
      actionType: "activateHarnessRevision",
      artifacts: [expect.objectContaining({
        kind: "harness_revision_activation",
        version: 1,
        contentSha256: revision.contentSha256,
        reused: false,
      })],
    });
    expect(replay).toMatchObject({
      status: "done",
      actionType: "activateHarnessRevision",
      artifacts: [expect.objectContaining({ reused: true })],
    });
    expect(harness.getRun(graph.rootRunId)?.context.activeHarnessRevision).toEqual({
      ...revision,
      components: ["prompt", "knowledge", "skills", "tools", "agent-policy"].map((kind) =>
        revision.components.find((component) => component.kind === kind)!,
      ),
    });
    const event = harness.getHarnessActionEvent({ id: first.eventId });
    expect(event?.request).toEqual({
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      projectId: graph.projectId,
      version: 1,
      contentSha256: revision.contentSha256,
      variantId: graph.candidate.id,
      variantRecordSha256: canonicalEvolutionRecordSha256(graph.candidate),
    });
    expect(JSON.stringify(event)).not.toContain("mcp://");
    expect(JSON.stringify(event)).not.toContain("repo:");
  });

  test("activateHarnessRevision rejects a null active revision instead of treating it as never activated", () => {
    const graph = activationFixture();
    harness.updateRun({
      runId: graph.rootRunId,
      contextPatch: { activeHarnessRevision: null },
    });
    const revision = graph.verifiedRevision(1, null, "null-active");

    const result = applyHarnessAction(harness, {
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      revision,
    });

    expect(result.status).toBe("blocked");
    expect(result.problems.join(" ")).toContain("activeHarnessRevision must be an object");
    expect(harness.getRun(graph.rootRunId)?.context.activeHarnessRevision).toBeNull();
  });

  test("activateHarnessRevision blocks stale parents and skipped versions without changing the active revision", () => {
    const graph = activationFixture();
    const firstRevision = graph.verifiedRevision(1, null);
    expect(applyHarnessAction(harness, {
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      revision: firstRevision,
    }).status).toBe("done");

    const staleParent = graph.verifiedRevision(2, SHA_B, "stale-parent");
    const skippedVersion = graph.verifiedRevision(3, firstRevision.contentSha256, "skipped-version");
    for (const revision of [staleParent, skippedVersion]) {
      const result = applyHarnessAction(harness, {
        type: "activateHarnessRevision",
        runId: graph.runId,
        rootRunId: graph.rootRunId,
        revision,
      });
      expect(result.status).toBe("blocked");
    }
    expect(harness.getRun(graph.rootRunId)?.context.activeHarnessRevision).toEqual(
      expect.objectContaining({ contentSha256: firstRevision.contentSha256, version: 1 }),
    );
  });

  test("activateHarnessRevision rejects an ordinary ancestor in place of the canonical self-improvement root", () => {
    const graph = activationFixture();
    const ordinaryAncestorId = harness.createRun({
      id: "run_ordinary_harness_ancestor",
      projectId: graph.projectId,
      goal: "Ordinary delivery ancestor",
      context: {
        source: "self-improvement-assessment",
        parentRunId: graph.rootRunId,
        selfImprovement: { cycleIndex: 1, assessmentFingerprint: SHA_B },
      },
    });
    harness.updateRun({ runId: graph.runId, contextPatch: { parentRunId: ordinaryAncestorId } });
    const revision = graph.verifiedRevision(1, null, "ordinary-ancestor");

    const result = applyHarnessAction(harness, {
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: ordinaryAncestorId,
      revision,
    });

    expect(result.status).toBe("blocked");
    expect(result.problems.join(" ")).toMatch(/self-improve|root/i);
    expect(harness.getRun(ordinaryAncestorId)?.context.activeHarnessRevision).toBeUndefined();
  });

  test("activateHarnessRevision rejects wrong projects, missing receipts, hash mismatch, and untrusted evidence", () => {
    const scenarios: Array<{
      build: () => ReturnType<typeof activationFixture>;
      mutate: (graph: ReturnType<typeof activationFixture>, revision: HarnessRevisionV1) => void;
      problem: RegExp;
    }> = [
      {
        build: () => activationFixture(),
        mutate: (_graph, revision) => {
          revision.projectId = "project_foreign";
          revision.contentSha256 = canonicalHarnessRevisionContentSha256(revision);
        },
        problem: /project/i,
      },
      {
        build: () => activationFixture({ trustedVariantReceipt: false }),
        mutate: () => {},
        problem: /receipt/i,
      },
      {
        build: () => activationFixture(),
        mutate: (_graph, revision) => {
          revision.variant.recordSha256 = SHA_A;
          revision.variant.id = `variant_${SHA_A}`;
          revision.contentSha256 = canonicalHarnessRevisionContentSha256(revision);
        },
        problem: /record.*hash.*mismatch/i,
      },
      {
        build: () => activationFixture(),
        mutate: (_graph, revision) => {
          revision.variant.contentSha256 = SHA_A;
          revision.contentSha256 = canonicalHarnessRevisionContentSha256(revision);
        },
        problem: /content.*hash|contentSha256|mismatch/i,
      },
      {
        build: () => activationFixture(),
        mutate: (graph) => {
          harness.recordDesignDecision({
            proposalId: graph.proposal.id,
            charterId: graph.charter.id,
            decision: "rejected",
            actorKind: "governance",
            actorRef: "governance-test",
          });
        },
        problem: /decision|approved/i,
      },
      {
        build: () => activationFixture(),
        mutate: (graph, revision) => {
          const attemptId = revision.evidenceRefs[0]!.slice("attempt:".length);
          const taskId = harness.createTask({
            id: "task_untrusted_harness_revision",
            runId: graph.runId,
            role: "worker",
            goal: "Pretend to verify",
            prompt: "This is not a verifier.",
          });
          revision.evidenceRefs = ["attempt:attempt_untrusted_harness_revision"];
          revision.contentSha256 = canonicalHarnessRevisionContentSha256(revision);
          expect(attemptId).not.toBe("attempt_untrusted_harness_revision");
          harness.recordAttempt({
            id: "attempt_untrusted_harness_revision",
            taskId,
            input: {},
            output: { status: "done", summary: "Untrusted", checks: [], artifacts: [], problems: [] },
          });
        },
        problem: /evidence|verifier|receipt/i,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      harness = new Harness(join(dir, `activation-negative-${index}.db`));
      harness.init();
      const graph = scenario.build();
      const revision = graph.verifiedRevision(1, null, `negative-${index}`);
      scenario.mutate(graph, revision);
      const result = applyHarnessAction(harness, {
        type: "activateHarnessRevision",
        runId: graph.runId,
        rootRunId: graph.rootRunId,
        revision,
      });
      expect(result.status, result.summary).toBe("blocked");
      expect(result.problems.join(" ")).toMatch(scenario.problem);
      expect(harness.getRun(graph.rootRunId)?.context.activeHarnessRevision).toBeUndefined();
    }
  });

  test("generic context actions cannot replace active or frozen Harness revisions", () => {
    const graph = activationFixture();
    for (const key of ["activeHarnessRevision", "harnessRevision"]) {
      const update = applyHarnessAction(harness, {
        type: "updateRunContext",
        runId: graph.rootRunId,
        contextPatch: { [key]: { attacker: true } },
      });
      const amendment = applyHarnessAction(harness, {
        type: "amendRunContract",
        runId: graph.rootRunId,
        contractKey: key,
        value: { attacker: true },
        version: 1,
        expectedVersion: 0,
      });
      expect(update.status, key).toBe("blocked");
      expect(amendment.status, key).toBe("blocked");
      expect(harness.getRun(graph.rootRunId)?.context[key]).toBeUndefined();
    }
  });

  test("generic context actions cannot forge parentRunId ancestry for Harness activation", () => {
    const graph = activationFixture();
    const forgedRootId = harness.createRun({
      id: "run_forged_harness_root",
      projectId: graph.projectId,
      goal: "Forged root",
    });

    const update = applyHarnessAction(harness, {
      type: "updateRunContext",
      runId: graph.runId,
      contextPatch: { parentRunId: forgedRootId },
    });
    const amendment = applyHarnessAction(harness, {
      type: "amendRunContract",
      runId: graph.runId,
      contractKey: "parentRunId",
      value: forgedRootId,
      version: 1,
      expectedVersion: 0,
    });

    expect(update.status).toBe("blocked");
    expect(amendment.status).toBe("blocked");
    expect(harness.getRun(graph.runId)?.context.parentRunId).toBe(graph.rootRunId);
  });

  test("activateHarnessRevision keeps invalid-action audit records compact and credential free", () => {
    const graph = activationFixture();
    const revision = graph.verifiedRevision(1, null) as HarnessRevisionV1 & {
      authorization?: string;
    };
    revision.authorization = "Bearer should-never-appear";

    const result = applyHarnessAction(harness, {
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      revision,
    });

    expect(result.status).toBe("blocked");
    expect(result.actionType).toBe("invalid");
    const event = harness.getHarnessActionEvent({ id: result.eventId });
    expect(event?.request).toEqual({
      type: "activateHarnessRevision",
      runId: graph.runId,
      rootRunId: graph.rootRunId,
      projectId: graph.projectId,
      version: 1,
      contentSha256: revision.contentSha256,
      variantId: graph.candidate.id,
      variantRecordSha256: canonicalEvolutionRecordSha256(graph.candidate),
    });
    expect(JSON.stringify(event)).not.toContain("should-never-appear");
    expect(JSON.stringify(event)).not.toContain("mcp://");
    expect(JSON.stringify(event)).not.toContain("repo:");
  });

  function createEquivalentDesignRun(graph: ReturnType<typeof fixture>, marker: string) {
    const proposal = harness.createDesignProposal({
      id: `design_hodor_evolution_actions_${marker}`,
      projectId: graph.projectId,
      charterId: graph.charter.id,
      title: `Equivalent evolution design ${marker}`,
      problem: graph.proposal.problem,
      recommendation: graph.proposal.recommendation,
      status: "accepted",
      proposal: graph.proposal.proposal,
    });
    const decision = harness.recordDesignDecision({
      id: `decision_hodor_evolution_actions_${marker}`,
      proposalId: proposal.id,
      charterId: graph.charter.id,
      decision: "approved",
      actorKind: "auto",
      actorRef: "authority-evaluator",
      reasons: ["Equivalent content still requires independent authority provenance."],
      authority: { disposition: "automatic" },
    });
    const sourceRun = harness.getRun(graph.runId)!;
    const runId = harness.createRun({
      id: `run_hodor_evolution_actions_${marker}`,
      projectId: graph.projectId,
      goal: `Exercise equivalent design ${marker}.`,
      context: {
        ...sourceRun.context,
        designProposalId: proposal.id,
        designDecisionId: decision.id,
        designProposal: proposal.proposal,
      },
    });
    return { proposal, decision, runId };
  }

  test("records the declared profile and variants with exact provenance and same-design replay", () => {
    const graph = fixture();
    applyDeclaredGraph(graph);

    expect(harness.getEvolutionProfile({ projectId: graph.projectId, id: graph.profile.id })).toEqual(graph.profile);
    expect(harness.getHarnessVariant({ projectId: graph.projectId, id: graph.candidate.id })).toEqual(graph.candidate);
    expect(harness.getProductionEpisode({ projectId: graph.projectId, id: graph.development.id })).toBeNull();
    expect(harness.getMatchedExperiment({ projectId: graph.projectId, id: graph.experiment.id })).toBeNull();

    const replay = applyHarnessAction(harness, {
      type: "registerHarnessVariant",
      runId: graph.runId,
      variant: graph.candidate,
    });
    expect(replay).toMatchObject({ status: "done", actionType: "registerHarnessVariant" });
    expect(replay.artifacts[0]).toMatchObject({
      replayed: true,
      externalEffectsApplied: false,
      promotionApplied: false,
    });
    const event = harness.getHarnessActionEvent({ id: replay.eventId });
    expect(event).toMatchObject({
      actionType: "registerHarnessVariant",
      status: "done",
      request: {
        type: "registerHarnessVariant",
        runId: graph.runId,
        entityKind: "variant",
        recordId: graph.candidate.id,
        recordSha256: canonicalEvolutionValueSha256(
          Object.fromEntries(Object.entries(graph.candidate).filter(([key]) => key !== "id")),
        ),
      },
      result: expect.objectContaining({ summary: replay.summary }),
    });
    expect(event?.request).not.toHaveProperty("variant");

    const receipts = withDatabase(harness.dbPath, (db) => db.query(`
      select record_kind, design_proposal_id, design_decision_id, design_charter_id
      from evolution_action_receipts
      where project_id = $projectId
      order by created_at, action_event_id
    `).all({ $projectId: graph.projectId })) as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(4);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        design_proposal_id: graph.proposal.id,
        design_decision_id: graph.authorityDecision.id,
        design_charter_id: graph.charter.id,
      });
    }
  });

  test("blocks episode and variant references to a profile recorded without a fixed-action receipt", () => {
    const graph = fixture();
    harness.recordEvolutionProfile(graph.profile);

    const episode = applyHarnessAction(harness, {
      type: "recordProductionEpisode",
      runId: graph.runId,
      episode: graph.development,
    });
    const variant = applyHarnessAction(harness, {
      type: "registerHarnessVariant",
      runId: graph.runId,
      variant: graph.control,
    });

    expect(episode.status, episode.summary).toBe("blocked");
    expect(variant.status, variant.summary).toBe("blocked");
    expect(episode.problems.join(" ")).toMatch(/receipt/i);
    expect(variant.problems.join(" ")).toMatch(/receipt/i);
    expect(harness.getProductionEpisode({ projectId: graph.projectId, id: graph.development.id })).toBeNull();
    expect(harness.getHarnessVariant({ projectId: graph.projectId, id: graph.control.id })).toBeNull();
  });

  test("accepts multiple consistent profile receipts from sequential replay", () => {
    const graph = fixture();
    for (let index = 0; index < 2; index += 1) {
      expect(applyHarnessAction(harness, {
        type: "registerEvolutionProfile",
        runId: graph.runId,
        profile: graph.profile,
      }).status).toBe("done");
    }
    const receiptCount = withDatabase(harness.dbPath, (db) => db.query(`
      select count(*) as count
      from evolution_action_receipts
      where project_id = $projectId and record_kind = 'profile' and record_id = $recordId
    `).get({
      $projectId: graph.projectId,
      $recordId: graph.profile.id,
    }) as { count: number });
    expect(receiptCount.count).toBe(2);

    const result = applyHarnessAction(harness, {
      type: "registerHarnessVariant",
      runId: graph.runId,
      variant: graph.control,
    });
    expect(result.status, result.summary).toBe("done");
  });

  test("rejects cross-design reuse of an identical record while preserving same-design replay", () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("done");
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    })).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({ replayed: true })],
    });

    const secondDesign = createEquivalentDesignRun(graph, "second");
    const profileReuse = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: secondDesign.runId,
      profile: graph.profile,
    });
    expect(profileReuse.status).toBe("blocked");
    expect(profileReuse.problems.join(" ")).toMatch(/proposal|decision|charter|provenance|receipt/i);

    const episodeReuse = applyHarnessAction(harness, {
      type: "recordProductionEpisode",
      runId: secondDesign.runId,
      episode: graph.development,
    });
    expect(episodeReuse.status).toBe("blocked");
    expect(episodeReuse.problems.join(" ")).toMatch(/proposal|decision|charter|provenance|receipt/i);
  });

  test("blocks an experiment that references episodes recorded without fixed-action receipts", () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile", runId: graph.runId, profile: graph.profile,
    }).status).toBe("done");
    for (const episode of [graph.development, graph.heldout, graph.unrelated]) {
      harness.recordProductionEpisode(episode);
    }
    for (const variant of [graph.control, graph.candidate]) {
      expect(applyHarnessAction(harness, {
        type: "registerHarnessVariant", runId: graph.runId, variant,
      }).status).toBe("done");
    }

    const result = applyHarnessAction(harness, {
      type: "freezeMatchedExperiment", runId: graph.runId, experiment: graph.experiment,
    });
    expect(result.status).toBe("blocked");
    expect(result.problems.join(" ")).toMatch(/episode.*receipt|receipt.*episode/i);
    expect(harness.getMatchedExperiment({ projectId: graph.projectId, id: graph.experiment.id })).toBeNull();
  });

  test("blocks an experiment that references variants recorded without fixed-action receipts", () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile", runId: graph.runId, profile: graph.profile,
    }).status).toBe("done");
    for (const episode of [graph.development, graph.heldout, graph.unrelated]) {
      harness.recordProductionEpisode(episode);
    }
    harness.recordHarnessVariant(graph.control);
    harness.recordHarnessVariant(graph.candidate);

    const result = applyHarnessAction(harness, {
      type: "freezeMatchedExperiment", runId: graph.runId, experiment: graph.experiment,
    });
    expect(result.status).toBe("blocked");
    expect(result.problems.join(" ")).toMatch(/variant.*receipt|receipt.*variant/i);
    expect(harness.getMatchedExperiment({ projectId: graph.projectId, id: graph.experiment.id })).toBeNull();
  });

  test("blocks when mutable run context duplicates drift from the accepted proposal", () => {
    const graph = fixture();
    harness.updateRun({
      runId: graph.runId,
      contextPatch: {
        evolutionPack: { attacker: "context must not authorize actions" },
        evolutionComparison: { attacker: "context must not authorize actions" },
        evolutionInstance: { attacker: "context must not authorize actions" },
      },
    });
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("blocked");
  });

  test("requires design source, accepted proposal, matching frozen charter, and latest approved authority decision", () => {
    const graph = fixture();
    const scenarios = [
      [{ source: "manual" }, { source: "design" }],
      [{ designProposalId: "design_missing" }, { designProposalId: graph.proposal.id }],
      [{ designCharterId: "charter_wrong" }, { designCharterId: graph.charter.id }],
    ];
    for (const [contextPatch, restorePatch] of scenarios) {
      harness.updateRun({ runId: graph.runId, contextPatch });
      const result = applyHarnessAction(harness, {
        type: "registerEvolutionProfile",
        runId: graph.runId,
        profile: graph.profile,
      });
      expect(result.status, result.summary).toBe("blocked");
      harness.updateRun({ runId: graph.runId, contextPatch: restorePatch });
    }

    harness.recordDesignDecision({
      proposalId: graph.proposal.id,
      charterId: graph.charter.id,
      decision: "rejected",
      actorKind: "governance",
      actorRef: "governance-test",
    });
    const rejected = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    });
    expect(rejected.status).toBe("blocked");
    expect(rejected.problems.join(" ")).toMatch(/decision|approved/i);
  });

  test("prevents context updates and contract amendments from replacing frozen design and evolution bindings", () => {
    const graph = fixture();
    for (const key of [
      "source",
      "projectId",
      "designProposalId",
      "designDecisionId",
      "designProposal",
      "designCharterId",
      "evolutionPack",
      "causalHypothesis",
      "evolutionComparison",
      "comparison",
      "evolutionInstance",
      "evaluationContract",
      "designEvaluationContract",
      "linearIntake",
    ]) {
      const result = applyHarnessAction(harness, {
        type: "updateRunContext",
        runId: graph.runId,
        contextPatch: { [key]: "tampered" },
      });
      expect(result.status, key).toBe("blocked");
      expect(harness.getRun(graph.runId)?.context[key]).not.toBe("tampered");

      const amendment = applyHarnessAction(harness, {
        type: "amendRunContract",
        runId: graph.runId,
        contractKey: key,
        value: "tampered",
        version: 1,
        expectedVersion: 0,
      });
      expect(amendment.status, key).toBe("blocked");
      expect(harness.getRun(graph.runId)?.context[key]).not.toBe("tampered");
    }
  });

  test("rejects extra action fields and redacts credentials in the blocked audit", () => {
    const graph = fixture();
    const result = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
      authorization: "Bearer should-never-appear",
    });
    expect(result.status).toBe("blocked");
    expect(result.actionType).toBe("invalid");
    expect(harness.getEvolutionProfile({ projectId: graph.projectId, id: graph.profile.id })).toBeNull();
    const event = harness.getHarnessActionEvent({ id: result.eventId });
    expect(event?.request).toMatchObject({ authorization: "[REDACTED]" });
    expect(JSON.stringify(event)).not.toContain("should-never-appear");
  });

  test("fails closed when the run is unbound or profile disagrees with frozen pack, instance, charter, or surfaces", () => {
    const graph = fixture();
    const unboundRunId = harness.createRun({ goal: "Unbound evolution run" });
    const unbound = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: unboundRunId,
      profile: graph.profile,
    });
    expect(unbound.status).toBe("blocked");
    const foreignProjectId = harness.createProject({
      id: "project_foreign_evolution_action",
      name: "Foreign",
      rootPath: join(dir, "foreign"),
    });
    const foreignRunId = harness.createRun({
      projectId: foreignProjectId,
      goal: "Must not record Hodor evolution state.",
      context: harness.getRun(graph.runId)?.context,
    });
    const crossProject = applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: foreignRunId,
      profile: graph.profile,
    });
    expect(crossProject.status).toBe("blocked");

    const invalidProfiles = [
      addressed("profile", { ...graph.profile, runtimeMaturity: "prepared" }),
      addressed("profile", {
        ...graph.profile,
        pack: { ...graph.profile.pack, contentSha256: SHA_C },
      }),
      addressed("profile", {
        ...graph.profile,
        charter: { ...graph.profile.charter, contentSha256: SHA_C },
      }),
      addressed("profile", { ...graph.profile, allowedSurfaceIds: ["surface_policy"] }),
    ];
    for (const profile of invalidProfiles) {
      const result = applyHarnessAction(harness, {
        type: "registerEvolutionProfile",
        runId: graph.runId,
        profile,
      });
      expect(result.status, result.summary).toBe("blocked");
      expect(harness.getEvolutionProfile({ projectId: graph.projectId, id: profile.id })).toBeNull();
    }
  });

  test("rejects episode sources outside the frozen comparison before any record write", () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("done");

    const foreign = graph.episode("development", "foreign", {
      sourceRef: "episode:foreign:development:999",
    });
    const rejected = applyHarnessAction(harness, {
      type: "recordProductionEpisode",
      runId: graph.runId,
      episode: foreign,
    });
    expect(rejected.status).toBe("blocked");
    expect(harness.getProductionEpisode({ projectId: graph.projectId, id: foreign.id })).toBeNull();
  });

  test("blocks perfect verifier artifacts through direct and HTTP actions until host-owned privacy receipts exist", async () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("done");

    const direct = applyHarnessAction(harness, {
      type: "recordProductionEpisode",
      runId: graph.runId,
      episode: graph.development,
    });
    expect(direct.status).toBe("blocked");
    expect(direct.problems.join(" ")).toMatch(/host-owned privacy receipt capability.*not implemented/i);

    const response = await handleHarnessActionRequest(
      new Request("http://127.0.0.1/actions", {
        method: "POST",
        headers: { authorization: "Bearer evolution-test" },
        body: JSON.stringify({
          type: "recordProductionEpisode",
          runId: graph.runId,
          episode: graph.development,
        }),
      }),
      { harness, token: "evolution-test" },
    );
    const body = await response.json() as { status: string; problems: string[] };
    expect(response.status).toBe(422);
    expect(body.status).toBe("blocked");
    expect(body.problems.join(" ")).toMatch(/host-owned privacy receipt capability.*not implemented/i);

    expect(harness.getProductionEpisode({ projectId: graph.projectId, id: graph.development.id })).toBeNull();
    const episodeReceipts = withDatabase(harness.dbPath, (db) => db.query(`
      select count(*) as count
      from evolution_action_receipts
      where project_id = $projectId and record_kind = 'episode'
    `).get({ $projectId: graph.projectId }) as { count: number });
    expect(episodeReceipts.count).toBe(0);
    expect(harness.listHarnessActionEvents({ limit: 50 }).filter((event) =>
      event.actionType === "recordProductionEpisode" && event.status === "done"
    )).toHaveLength(0);
  });

  test("confines variants to frozen surfaces, paths, targets, and development-only candidate evidence", () => {
    const graph = fixture();
    expect(applyHarnessAction(harness, {
      type: "registerEvolutionProfile",
      runId: graph.runId,
      profile: graph.profile,
    }).status).toBe("done");

    const invalidVariants = [
      addressed("variant", { ...graph.candidate, mutationSurfaceIds: ["surface_missing"] }),
      addressed("variant", { ...graph.candidate, changedPaths: ["src/escape.ts"] }),
      addressed("variant", { ...graph.candidate, changedPaths: ["evals/evolution/secrets/token.json"] }),
      addressed("variant", { ...graph.candidate, evolutionTargets: ["artifact"] }),
      addressed("variant", {
        ...graph.candidate,
        createdFromEvidenceRefs: [...graph.comparison.holdoutEvidenceRefs],
      }),
    ];
    for (const variant of invalidVariants) {
      const result = applyHarnessAction(harness, {
        type: "registerHarnessVariant",
        runId: graph.runId,
        variant,
      });
      expect(result.status, result.summary).toBe("blocked");
      expect(harness.getHarnessVariant({ projectId: graph.projectId, id: variant.id })).toBeNull();
    }
  });

  test("keeps matched experiments blocked while trusted production episode receipts are unavailable", () => {
    const graph = fixture();
    applyDeclaredGraph(graph);
    for (const episode of [graph.development, graph.heldout, graph.unrelated]) {
      harness.recordProductionEpisode(episode);
    }
    const result = applyHarnessAction(harness, {
      type: "freezeMatchedExperiment",
      runId: graph.runId,
      experiment: graph.experiment,
    });
    expect(result.status).toBe("blocked");
    expect(result.problems.join(" ")).toMatch(/episode.*receipt|receipt.*episode/i);
    expect(harness.getMatchedExperiment({ projectId: graph.projectId, id: graph.experiment.id })).toBeNull();
  });
});

async function createDisjointBranchIntegrationScenario(harness: Harness, dir: string) {
  const repoPath = join(dir, `repo-disjoint-branch-${crypto.randomUUID()}`);
  const worktreePath = join(dir, `worker-disjoint-branch-${crypto.randomUUID()}`);
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "initial\n");
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.name", "Ouroboros Test"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "commit.gpgSign", "false"]);
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "Initial commit"]);
  git(repoPath, ["worktree", "add", "-b", "task-disjoint-worker", worktreePath, "main"]);
  await mkdir(join(worktreePath, "src"), { recursive: true });
  await writeFile(join(worktreePath, "src", "feature.ts"), "export const feature = true;\n");
  git(worktreePath, ["add", "src/feature.ts"]);
  git(worktreePath, ["commit", "-m", "Verified worker change"]);
  await writeFile(join(repoPath, "README.md"), "operator edit\n");
  git(repoPath, ["add", "README.md"]);
  await writeFile(join(repoPath, "NOTES.md"), "operator note\n");

  const runId = harness.createRun({ goal: "Test disjoint branch integration", projectRoot: repoPath });
  const workerTaskId = harness.createTask({
    runId,
    role: "worker",
    goal: "Implement verified feature",
    prompt: "Create src/feature.ts.",
    worktreePath,
  });
  harness.recordAttempt({
    taskId: workerTaskId,
    input: { executor: "test" },
    output: {
      status: "done",
      summary: "Verified worker change",
      changedFiles: ["src/feature.ts"],
      checks: [{ name: "worker", status: "passed" }],
      artifacts: [],
      problems: [],
    },
  });
  const verifierTaskId = harness.createTask({
    runId,
    role: "verifier",
    goal: "Verify feature",
    prompt: "Verify src/feature.ts.",
    dependsOn: [workerTaskId],
  });
  harness.recordAttempt({
    taskId: verifierTaskId,
    input: { executor: "test" },
    output: {
      status: "done",
      summary: "Feature verified",
      changedFiles: [],
      checks: [{ name: "verify", status: "passed" }],
      artifacts: [],
      problems: [],
    },
  });
  return { repoPath, runId, workerTaskId };
}
describe("Control-plane watchdog contract", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-watchdog-actions-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createWatchedRun() {
    const runId = harness.createRun({ goal: "Watched run" });
    return runId;
  }

  function createEmptyNonterminalRun() {
    const runId = harness.createRun({ goal: "Empty nonterminal" });
    return runId;
  }

  test("keeps a terminal root eligible when an unfinished descendant still has work", () => {
    const rootRunId = harness.createRun({ goal: "Completed parent" });
    const childRunId = harness.createRun({
      goal: "Unfinished child",
      context: { parentRunId: rootRunId },
    });
    harness.createTask({ runId: childRunId, role: "worker", goal: "Finish child", prompt: "do work" });
    harness.updateRunStatus({ runId: rootRunId, status: "done" });

    const base = 1_700_000_000_000;
    for (let tick = 0; tick < 10; tick += 1) {
      const result = applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId,
        now: base + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `descendant liveness ${tick}`,
      });
      expect(result.status).toMatch(/^(done|blocked)$/);
    }

    const watchdog = harness.getRun(rootRunId)?.context.controlPlaneWatchdog as
      | { state?: string }
      | undefined;
    expect(watchdog?.state).not.toBe("healthy");
  });

  test("dispatches classified recovery against the affected descendant run", () => {
    const rootRunId = harness.createRun({ goal: "Completed parent" });
    const childRunId = harness.createRun({
      goal: "Empty child",
      context: { parentRunId: rootRunId },
    });
    harness.updateRunStatus({ runId: rootRunId, status: "done" });

    const base = 1_700_000_000_000;
    for (let tick = 0; tick < 5; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId,
        now: base + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `descendant recovery ${tick}`,
      });
    }

    const reconcile = harness.listHarnessActionEvents({ limit: 200 }).find(
      (event) => event.actionType === "prepareRunDrain",
    );
    expect(reconcile).toBeDefined();
    expect((reconcile?.request as Record<string, unknown>).runId).toBe(childRunId);
    expect(harness.getRunOverview({ runId: childRunId, eventLimit: 0 }).tasks.length).toBeGreaterThan(0);
  });

  test("canonical fingerprint is deterministic across row iteration orders", () => {
    const runId = createWatchedRun();
    // Insert multiple tasks; their row order in SQLite is insertion order, but
    // the fingerprint must sort by id deterministically so re-observing the
    // same tree always yields the same value.
    harness.createTask({ runId, role: "worker", goal: "Do work A", prompt: "x" });
    harness.createTask({ runId, role: "worker", goal: "Do work B", prompt: "x" });
    harness.createTask({ runId, role: "verifier", goal: "Verify work", prompt: "y" });
    const overviewA = harness.getRunOverview({ runId, eventLimit: 0 });
    const overviewB = harness.getRunOverview({ runId, eventLimit: 0 });
    const observationA = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: overviewA,
      harness,
      now: 1_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    const observationB = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: overviewB,
      harness,
      now: 1_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    expect(observationA.fingerprint).toBe(observationB.fingerprint);
    expect(observationA.fingerprint.length).toBe(64);
  });

  test("fingerprint changes only for meaningful run, task, attempt, thread, integration, or non-watchdog action state", () => {
    const runId = createWatchedRun();
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "First goal",
      prompt: "do work",
    });
    const before = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    // A meaningful change: task status transition.
    harness.updateRunStatus({ runId, status: "running" });
    const after = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 2,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(taskId).toBeDefined();
  });

  test("ten-tick false-positive matrix creates zero repair runs for every excluded fixture", () => {
    const fixtures: Array<{ name: string; setup: () => string }> = [
      {
        name: "paused",
        setup: () => {
          const runId = harness.createRun({ goal: "Paused", context: { runPause: { reason: "user" } } });
          harness.createTask({ runId, role: "worker", goal: "x", prompt: "x" });
          return runId;
        },
      },
      {
        name: "human-checkpoint",
        setup: () => {
          const runId = harness.createRun({ goal: "Human", context: { pauseForHumanReason: "approval" } });
          harness.createTask({ runId, role: "worker", goal: "x", prompt: "x" });
          return runId;
        },
      },
      {
        name: "quiescent",
        setup: () => {
          const assessmentFingerprint = "b".repeat(64);
          const runId = harness.createRun({
            goal: "Quiescent",
            context: {
              source: "self-improve",
              selfImprovement: {
                assessmentFingerprint,
                quiescent: true,
                quiescence: {
                  version: 1,
                  assessmentFingerprint,
                  sourceRunId: "run_quiescent_fixture",
                  sourceTaskId: "task_quiescent_fixture",
                  sourceAttemptId: "attempt_quiescent_fixture",
                  summary: "No evidence-backed work is justified until the scheduled wake.",
                  decidedAt: "2023-11-14T22:13:20.000Z",
                  nextWakeAt: "2023-11-16T22:13:20.000Z",
                  evidence: ["attempt:attempt_quiescent_fixture"],
                },
              },
            },
          });
          harness.updateRunStatus({ runId, status: "blocked" });
          return runId;
        },
      },
      {
        name: "scheduled-review",
        setup: () => {
          const runId = harness.createRun({ goal: "Review pending" });
          harness.createTask({ runId, role: "worker", goal: "x", prompt: "x" });
          return runId;
        },
      },
      {
        name: "fresh-heartbeat",
        setup: () => {
          const runId = harness.createRun({ goal: "Heartbeat" });
          const taskId = harness.createTask({ runId, role: "worker", goal: "x", prompt: "x" });
          harness.upsertExecutionThread({
            runId,
            taskId,
            ownerType: "attempt",
            role: "worker",
            status: "running",
            heartbeatAt: new Date().toISOString(),
          });
          return runId;
        },
      },
      {
        name: "terminal",
        setup: () => {
          const runId = harness.createRun({ goal: "Done" });
          harness.updateRunStatus({ runId, status: "done" });
          return runId;
        },
      },
    ];
    const fixtureStart = 1_700_000_000_000;
    for (const fixture of fixtures) {
      const runId = fixture.setup();
      // Advancing fake clock values: each tick is 90 seconds later so the
      // 60-second stall minimum is satisfied across all ten ticks. This
      // proves the watchdog would not falsely dispatch a repair even when
      // enough time has elapsed for a real stall.
      for (let tick = 0; tick < 10; tick += 1) {
        const result = applyHarnessAction(harness, {
          type: "runWatchdogPass",
          rootRunId: runId,
          now: fixtureStart + tick * 90_000,
          daemonIntervalMs: 1500,
          inboxEvents: [],
          scheduledReviews: fixture.name === "scheduled-review"
            ? [{ runId, reviewAt: new Date(fixtureStart + tick * 90_000 + 60_000).toISOString() }]
            : [],
          reason: `false-positive ${fixture.name} ${tick}`,
        });
        expect(result.status).toBe("done");
      }
      const events = harness.listHarnessActionEvents({ limit: 500 });
      const repairEvents = events.filter(
        (event) => event.actionType === "completeSystemTask" &&
          typeof event.request === "object" &&
          event.request !== null &&
          "taskId" in (event.request as Record<string, unknown>) &&
          typeof (event.request as Record<string, unknown>).taskId === "string" &&
          ((event.request as Record<string, unknown>).taskId as string).startsWith("task_watchdog_repair_"),
      );
      expect(repairEvents.length).toBe(0);
      const root = harness.getRun(runId);
      const watchdog = root?.context.controlPlaneWatchdog as { state?: string } | undefined;
      expect(watchdog?.state ?? "healthy").not.toBe("repairing");
      expect(watchdog?.state ?? "healthy").not.toBe("blocked");
    }
  });

  test("a terminal self-improvement root without a durable wake becomes evolution-stale", () => {
    const runId = harness.createRun({
      goal: "Continuously improve Ouroboros from evidence-backed gaps",
      context: {
        source: "self-improve",
        selfImprovement: {
          cycleIndex: 14,
          assessmentFingerprint: "frozen-assessment",
        },
        controlPlaneRuntime: {
          state: "current",
        },
      },
    });
    harness.updateRunStatus({ runId, status: "blocked" });

    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_700_000_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "terminal self-improvement observation 1",
    });
    const result = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_700_000_090_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "terminal self-improvement observation 2",
    });

    const observation = result.artifacts.find((artifact) =>
      (artifact as Record<string, unknown>).kind === "watchdog_observation"
    ) as Record<string, unknown>;
    const watchdog = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; fault?: { kind?: string }; history?: Array<{ reason?: string }> }
      | undefined;
    expect(observation.eligible).toBe(true);
    expect(watchdog?.state).toBe("suspect");
    expect(watchdog?.fault?.kind).toBe("terminal-evolution-stall");
    expect(watchdog?.history?.at(-1)?.reason).not.toBe("not eligible");
  });

  test("a future outcome review does not mask a terminal continuous root without a durable wake", () => {
    const runId = harness.createRun({
      goal: "Continuously improve Ouroboros from evidence-backed gaps",
      context: {
        source: "self-improve",
        selfImprovement: {
          cycleIndex: 17,
          assessmentFingerprint: "post-outcome-assessment",
        },
        controlPlaneRuntime: { state: "current" },
      },
    });
    harness.updateRunStatus({ runId, status: "blocked" });

    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_700_000_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [{ runId: "run_future_review", reviewAt: "2099-01-01T00:00:00.000Z" }],
      reason: "post-outcome continuous root observation 1",
    });
    const result = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_700_000_090_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [{ runId: "run_future_review", reviewAt: "2099-01-01T00:00:00.000Z" }],
      reason: "post-outcome continuous root observation 2",
    });

    const observation = result.artifacts.find((artifact) =>
      (artifact as Record<string, unknown>).kind === "watchdog_observation"
    ) as Record<string, unknown>;
    const watchdog = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; history?: Array<{ reason?: string }> }
      | undefined;
    expect(observation.eligible).toBe(true);
    expect(observation.eligibilityReasons).toEqual(["terminal-evolution-without-wake"]);
    expect(watchdog?.state).not.toBe("healthy");
    expect(watchdog?.history?.at(-1)?.reason).not.toBe("not eligible");
  });

  test("a terminal self-improvement root with a future durable wake stays intentionally quiescent", () => {
    const assessmentFingerprint = "a".repeat(64);
    const runId = harness.createRun({
      goal: "Continuously improve Ouroboros from evidence-backed gaps",
      context: {
        source: "self-improve",
        selfImprovement: {
          cycleIndex: 3,
          assessmentFingerprint,
          quiescent: true,
          quiescence: {
            version: 1,
            assessmentFingerprint,
            sourceRunId: "run_quiet_source",
            sourceTaskId: "task_quiet_source",
            sourceAttemptId: "attempt_quiet_source",
            summary: "No evidence-backed change is justified.",
            decidedAt: "2023-11-14T22:13:20.000Z",
            nextWakeAt: "2023-11-15T22:13:20.000Z",
            evidence: ["attempt:attempt_quiet_source"],
          },
        },
      },
    });
    harness.updateRunStatus({ runId, status: "blocked" });

    const result = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_700_000_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "durable quiescence observation",
    });

    const observation = result.artifacts.find((artifact) =>
      (artifact as Record<string, unknown>).kind === "watchdog_observation"
    ) as Record<string, unknown>;
    const watchdog = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; history?: Array<{ reason?: string }> }
      | undefined;
    expect(observation.eligible).toBe(false);
    expect(observation.eligibilityReasons).toEqual(["intentionally-quiescent"]);
    expect(watchdog?.state).toBe("healthy");
    expect(watchdog?.history?.at(-1)?.reason).toBe("not eligible");
  });

  test("fingerprint excludes heartbeat-only and watchdog-write events", () => {
    const runId = harness.createRun({ goal: "Heartbeat invariance" });
    const taskId = harness.createTask({ runId, role: "worker", goal: "x", prompt: "x" });
    // Establish an existing thread with no heartbeat so adding the heartbeat
    // later is the only change (a heartbeat-only update).
    const threadId = "thread_heartbeat_invariance";
    harness.upsertExecutionThread({
      id: threadId,
      runId,
      taskId,
      ownerType: "attempt",
      role: "worker",
      status: "running",
      heartbeatAt: null,
    });
    const before = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    // Heartbeat-only update: thread heartbeatAt changes but no other state.
    harness.upsertExecutionThread({
      id: threadId,
      runId,
      taskId,
      ownerType: "attempt",
      role: "worker",
      status: "running",
      heartbeatAt: new Date(2_000_000).toISOString(),
    });
    const afterHeartbeat = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1_500_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    expect(afterHeartbeat.fingerprint).toBe(before.fingerprint);
    // Watchdog write: persisting watchdog state must not count as progress.
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: 1_500_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "watchdog write invariance",
    });
    const afterWatchdog = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1_600_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    expect(afterWatchdog.fingerprint).toBe(before.fingerprint);
  });

  test("PAN-1223 empty-round replay advances suspect to stalled to reconciling to repair to canary", () => {
    const runId = createEmptyNonterminalRun();
    const base = 1_700_000_000_000;
    // Tick 0: first observation is always healthy (no previous fingerprint to
    // compare against, so meaningfulChange is true).
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 prime 0",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("healthy");
    // Tick 1: first unchanged eligible tick -> suspect.
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 prime 1",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("suspect");
    // Tick 2: still suspect (threshold count not yet met).
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 180_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 prime 2",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("suspect");
    // Tick 3: threshold met (3 unchanged ticks, elapsed >= 60s) -> stalled.
    // The stalled state is persisted before any reconcile dispatch so
    // observers can surface a deterministic stalled signal.
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 270_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 stall",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("stalled");
    // Tick 4: stalled -> reconciling. The fixed-action reconcile event is
    // persisted BEFORE any linked repair run is created.
    const reconcileTick = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 360_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 reconcile",
    });
    expect(reconcileTick.status).toBe("done");
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("reconciling");
    const eventsAfterReconcile = harness.listHarnessActionEvents({ limit: 200 });
    const reconcileActionEvents = eventsAfterReconcile.filter(
      (event) => event.actionType === "prepareRunDrain",
    );
    expect(reconcileActionEvents.length).toBeGreaterThanOrEqual(1);
    const eventsBeforeRepair = harness.listHarnessActionEvents({ limit: 200 });
    const repairRunExistsBefore = eventsBeforeRepair.some(
      (event) => event.actionType === "completeSystemTask",
    );
    expect(repairRunExistsBefore).toBe(false);
    // Tick 5: still unchanged from reconciling -> repair dispatch (creates
    // repair run, completes the system task from reconcile evidence, and
    // advances to canary).
    const repairTick = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 450_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 repair",
    });
    expect(repairTick.status).toBe("done");
    const afterRepair = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; repairRunId?: string; recoveryStage?: string; canary?: { status?: string } }
      | undefined;
    expect(afterRepair?.state).toBe("canary");
    expect(typeof afterRepair?.repairRunId).toBe("string");
    expect(afterRepair?.recoveryStage).toBe("canary");
    expect(afterRepair?.canary?.status).toBe("progressing");
    // Tick 6: watchdog-owned repair bookkeeping is excluded from the
    // fingerprint. With no new target-run progress, canary evidence stays
    // empty instead of approving its own writes.
    const canaryTick = applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 540_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "pan-1223 canary",
    });
    expect(canaryTick.status).toBe("done");
    const afterCanary = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; canary?: { status?: string; evidence?: string[] } }
      | undefined;
    expect(afterCanary?.canary?.status).toBe("progressing");
    expect((afterCanary?.canary?.evidence?.length ?? 0)).toBe(0);
    // Repair run and action evidence are durable.
    const events = harness.listHarnessActionEvents({ limit: 200 });
    const completeEvents = events.filter(
      (event) => event.actionType === "completeSystemTask" &&
        typeof event.request === "object" &&
        event.request !== null &&
        "taskId" in (event.request as Record<string, unknown>) &&
        typeof (event.request as Record<string, unknown>).taskId === "string" &&
        ((event.request as Record<string, unknown>).taskId as string).startsWith("task_watchdog_repair_"),
    );
    expect(completeEvents.length).toBe(1);
  });

  test("successful two-tick canary converges to recovered after continued meaningful progress", () => {
    const runId = harness.createRun({ goal: "Canary success" });
    // Set up an empty nonterminal run so the watchdog dispatches prepareRunDrain.
    const base = 1_700_000_000_000;
    // 4 primes: healthy -> suspect -> suspect -> stalled.
    for (let tick = 0; tick < 4; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: base + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `canary prime ${tick}`,
      });
    }
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("stalled");
    // Tick 4: stalled -> reconciling (prepareRunDrain dispatched, persists
    // the reconcile action event id).
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 4 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "canary reconcile",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("reconciling");
    // Tick 5: reconciling -> repair -> canary (creates linked repair run,
    // completes the system task from the reconcile evidence).
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 5 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "canary repair",
    });
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("canary");
    // Tick 6: internal repair bookkeeping alone is not target progress.
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 6 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "canary progress 1",
    });
    const after1 = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; canary?: { evidence?: string[]; status?: string } }
      | undefined;
    expect(after1?.state).toBe("canary");
    expect((after1?.canary?.evidence?.length ?? 0)).toBe(0);
    // Inject the first real target change for tick 7: record an attempt on the
    // goal-review task so the latest-attempt identity changes the fingerprint.
    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    const goalReviewTask = overview.tasks.find((task) => task.role === "goal-review");
    expect(goalReviewTask).toBeDefined();
    harness.recordAttempt({
      taskId: goalReviewTask!.id,
      input: { prompt: "go" },
      output: { status: "done", summary: "canary progress", changedFiles: [], checks: [], problems: [] },
    });
    // Tick 7: first meaningful target progress.
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 7 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "canary progress 2",
    });
    const afterTargetProgress = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; canary?: { evidence?: string[] } }
      | undefined;
    expect(afterTargetProgress?.state).toBe("canary");
    expect((afterTargetProgress?.canary?.evidence?.length ?? 0)).toBe(1);

    // A second independent target change satisfies the two-tick canary.
    harness.updateRun({ runId, goal: "Canary success after verified progress" });
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 8 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "canary progress 2",
    });
    const recovered = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; canary?: { evidence?: string[] } }
      | undefined;
    expect(recovered?.state).toBe("recovered");
    expect((recovered?.canary?.evidence?.length ?? 0)).toBe(2);
  });

  test("concurrent process claims dispatch one reconcile action and reuse it after restart", async () => {
    const runId = createEmptyNonterminalRun();
    const now = 1_700_000_000_000;
    // Prime only to stalled. The next pass is the unsafe boundary where the
    // fixed reconcile action must be claimed before it is dispatched.
    for (let tick = 0; tick < 4; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: now + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `prime ${tick}`,
      });
    }
    expect(
      (harness.getRun(runId)?.context.controlPlaneWatchdog as { state?: string }).state,
    ).toBe("stalled");

    const mainEntry = join(import.meta.dir, "..", "packages", "cli", "src", "main.ts");
    const command = [
      "bun",
      mainEntry,
      "--db",
      join(dir, "ouroboros.db"),
      "--config",
      join(dir, "missing-config.toml"),
      "run-watchdog-pass",
      "--root-run-id",
      runId,
      "--now",
      String(now + 4 * 90_000),
      "--daemon-interval-ms",
      "1500",
      "--reason",
      "concurrent atomic replay",
    ];
    const processes = Array.from({ length: 4 }, () =>
      Bun.spawn({
        cmd: command,
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(processes.map(async (process) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { stdout, stderr, exitCode };
    }));
    for (const result of results) {
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/SQLITE_(?:BUSY|LOCKED)|database is locked/i);
    }

    const reopened = new Harness(join(dir, "ouroboros.db"));
    const reconcileEvents = reopened.listHarnessActionEvents({ limit: 200 }).filter(
      (event) =>
        event.actionType === "prepareRunDrain" &&
        (event.request as Record<string, unknown>).runId === runId,
    );
    expect(reconcileEvents).toHaveLength(1);

    // Reopening the harness and replaying the same tick must reuse the durable
    // claim. It must not create a second fixed action event.
    applyHarnessAction(reopened, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: now + 4 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "restart replay",
    });
    const afterRestart = reopened.listHarnessActionEvents({ limit: 200 }).filter(
      (event) =>
        event.actionType === "prepareRunDrain" &&
        (event.request as Record<string, unknown>).runId === runId,
    );
    expect(afterRestart).toHaveLength(1);

    applyHarnessAction(reopened, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: now + 5 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "restart repair finalization",
    });
    const watchdog = reopened.getRun(runId)?.context.controlPlaneWatchdog as
      | { repairRunId?: string; repairTaskId?: string }
      | undefined;
    expect(watchdog?.repairRunId).toMatch(/^run_watchdog_repair_/);
    expect(watchdog?.repairTaskId).toMatch(/^task_watchdog_repair_/);
    const repairOverview = reopened.getRunOverview({
      runId: watchdog?.repairRunId ?? "missing",
      eventLimit: 0,
    });
    expect(repairOverview.run?.status).toBe("done");
    expect(repairOverview.tasks).toHaveLength(1);
    expect(repairOverview.tasks[0]?.status).toBe("done");
    expect(repairOverview.sessions).toHaveLength(1);
    expect(repairOverview.sessions[0]?.attemptId).toMatch(/^attempt_watchdog_repair_/);
    expect(repairOverview.threads).toHaveLength(0);
    const completeEvents = reopened.listHarnessActionEvents({ limit: 200 }).filter(
      (event) =>
        event.actionType === "completeSystemTask" &&
        (event.request as Record<string, unknown>).taskId === watchdog?.repairTaskId,
    );
    expect(completeEvents).toHaveLength(1);
  });

  test("unrelated action volume cannot evict supervised action evidence from the fingerprint", () => {
    const runId = createEmptyNonterminalRun();
    harness.recordHarnessActionEvent({
      actionType: "prepareRunDrain",
      status: "done",
      request: { type: "prepareRunDrain", runId, reason: "supervised evidence" },
      result: { status: "done", artifacts: [] },
    });
    const before = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1_700_000_000_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });

    for (let index = 0; index < 250; index += 1) {
      harness.recordHarnessActionEvent({
        actionType: "prepareRunDrain",
        status: "done",
        request: { type: "prepareRunDrain", runId: `run_unrelated_${index}`, reason: "unrelated volume" },
        result: { status: "done", artifacts: [] },
      });
    }

    const after = observeWatchdogTree({
      rootRunId: runId,
      rootRun: harness.getRun(runId),
      overview: harness.getRunOverview({ runId, eventLimit: 0 }),
      harness,
      now: 1_700_000_090_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
    });
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  test("restart after an expired claim without an action receipt blocks instead of redispatching", () => {
    const runId = createEmptyNonterminalRun();
    const base = 1_700_000_000_000;
    for (let tick = 0; tick < 4; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: base + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `expired claim prime ${tick}`,
      });
    }
    const stalled = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | Record<string, unknown>
      | undefined;
    expect(stalled?.state).toBe("stalled");
    const fingerprint = String(stalled?.fingerprint);
    harness.updateRun({
      runId,
      contextPatch: {
        controlPlaneWatchdog: {
          ...stalled,
          state: "reconciling",
          recoveryStage: "reconcile",
          repairFingerprint: fingerprint,
          reconcileClaim: {
            fingerprint,
            ownerId: "watchdog_claim_crashed",
            actionType: "prepareRunDrain",
            targetRunId: runId,
            actionEventId: "action_watchdog_reconcile_missing",
            claimedAt: new Date(base + 4 * 90_000).toISOString(),
            leaseUntil: new Date(base + 4 * 90_000 + 1_000).toISOString(),
          },
        },
      },
    });

    const reopened = new Harness(join(dir, "ouroboros.db"));
    const first = applyHarnessAction(reopened, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 5 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "expired claim restart",
    });
    expect(first.status).toBe("blocked");
    const blocked = reopened.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; cooldownUntil?: string | null; reconcileClaim?: unknown }
      | undefined;
    expect(blocked?.state).toBe("blocked");
    expect(blocked?.cooldownUntil).toBeString();
    expect(blocked?.reconcileClaim).toBeNull();
    expect(
      reopened.listHarnessActionEvents({ limit: 200 }).filter((event) => event.actionType === "prepareRunDrain"),
    ).toHaveLength(0);

    applyHarnessAction(reopened, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 6 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "expired claim sequential replay",
    });
    expect(
      reopened.listHarnessActionEvents({ limit: 200 }).filter((event) => event.actionType === "prepareRunDrain"),
    ).toHaveLength(0);
  });

  test("restart after reconcile response loss finalizes the deterministic action receipt", () => {
    const runId = createEmptyNonterminalRun();
    const base = 1_700_000_000_000;
    for (let tick = 0; tick < 4; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: base + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `response loss prime ${tick}`,
      });
    }
    const stalled = harness.getRun(runId)?.context.controlPlaneWatchdog as
      | Record<string, unknown>
      | undefined;
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 4 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "response loss dispatch",
    });
    const fixedEvent = harness.listHarnessActionEvents({ limit: 200 }).find(
      (event) => event.actionType === "prepareRunDrain",
    );
    expect(fixedEvent?.id).toMatch(/^action_watchdog_reconcile_/);
    const fingerprint = String(stalled?.fingerprint);
    harness.updateRun({
      runId,
      contextPatch: {
        controlPlaneWatchdog: {
          ...stalled,
          state: "reconciling",
          recoveryStage: "reconcile",
          repairFingerprint: fingerprint,
          actionEventIds: [],
          reconcileClaim: {
            fingerprint,
            ownerId: "watchdog_claim_response_lost",
            actionType: "prepareRunDrain",
            targetRunId: runId,
            actionEventId: fixedEvent?.id,
            claimedAt: new Date(base + 4 * 90_000).toISOString(),
            leaseUntil: new Date(base + 5 * 90_000).toISOString(),
          },
        },
      },
    });

    const reopened = new Harness(join(dir, "ouroboros.db"));
    const replay = applyHarnessAction(reopened, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: base + 4 * 90_000 + 1,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "response loss readback",
    });
    expect(replay.status).toBe("done");
    const recovered = reopened.getRun(runId)?.context.controlPlaneWatchdog as
      | { state?: string; reconcileClaim?: unknown; actionEventIds?: string[] }
      | undefined;
    expect(recovered?.state).toBe("reconciling");
    expect(recovered?.reconcileClaim).toBeNull();
    expect(recovered?.actionEventIds).toEqual([fixedEvent!.id]);
    expect(
      reopened.listHarnessActionEvents({ limit: 200 }).filter((event) => event.actionType === "prepareRunDrain"),
    ).toHaveLength(1);
  });

  test("deterministic repair identity reuses the same repair run and persists retry count and cooldown after failure", () => {
    const runId = createEmptyNonterminalRun();
    const now = 1_700_000_000_000;
    for (let tick = 0; tick < 3; tick += 1) {
      applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: now + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `prime ${tick}`,
      });
    }
    // Force a failed/unsupported recovery by leaving the run empty so the
    // canary never progresses; the watchdog should converge to blocked with
    // a cooldown.
    let blockedSeen = false;
    let attemptCount = 0;
    for (let tick = 4; tick < 12; tick += 1) {
      const result = applyHarnessAction(harness, {
        type: "runWatchdogPass",
        rootRunId: runId,
        now: now + tick * 90_000,
        daemonIntervalMs: 1500,
        inboxEvents: [],
        scheduledReviews: [],
        reason: `cooldown ${tick}`,
      });
      const root = harness.getRun(runId);
      const watchdog = root?.context.controlPlaneWatchdog as
        | { attemptCount?: number; cooldownUntil?: string | null; state?: string }
        | undefined;
      attemptCount = Math.max(attemptCount, watchdog?.attemptCount ?? 0);
      if (watchdog?.state === "blocked") {
        blockedSeen = true;
        break;
      }
      expect(result.status).toMatch(/^(done|blocked)$/);
    }
    expect(blockedSeen).toBe(true);
    expect(attemptCount).toBeGreaterThanOrEqual(1);
    const finalRoot = harness.getRun(runId);
    const finalWatchdog = finalRoot?.context.controlPlaneWatchdog as
      | { cooldownUntil?: string | null; attemptCount?: number; repairRunId?: string; failure?: { reason: string } }
      | undefined;
    expect(finalWatchdog?.cooldownUntil).toBeTruthy();
    expect(finalWatchdog?.failure?.reason).toBeTruthy();
    // No second repair during cooldown.
    const repairRunIdBefore = finalWatchdog?.repairRunId;
    applyHarnessAction(harness, {
      type: "runWatchdogPass",
      rootRunId: runId,
      now: now + 12 * 90_000,
      daemonIntervalMs: 1500,
      inboxEvents: [],
      scheduledReviews: [],
      reason: "second repair attempt",
    });
    const rootAgain = harness.getRun(runId);
    const watchdogAgain = rootAgain?.context.controlPlaneWatchdog as { repairRunId?: string } | undefined;
    expect(watchdogAgain?.repairRunId).toBe(repairRunIdBefore);
  });
});


function rawGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function git(cwd: string, args: string[]) {
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
