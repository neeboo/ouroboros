import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyHarnessAction,
  describeAuthorityEvaluation,
  describeIntegrationReadiness,
  evaluateAuthority,
  Harness,
  HARD_AUTHORITY_RULES,
  isHardAuthorityReason,
  withDatabase,
  type HarnessDatabase,
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
    harness.recordAttempt({
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
    harness.recordAttempt({
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
        artifacts: [{ kind: "integration", workerTaskId, mergeCommit: "abc123" }],
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
    expect(goalReviews).toHaveLength(2);
    expect(goalReviews.find((task) => task.id !== oldReviewTaskId)?.status).toBe("todo");
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

    expect(result).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      eventId: expect.any(String),
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        workerTaskId,
        verifierTaskId,
        goalReviewTaskId,
        targetBranch: "main",
        sourceBranch: "task-worker",
        pushed: false,
      }),
    );
    expect(mergedFile.trim()).toBe("export const value = 1;");
    expect(log).toContain("Integrate verified worker");
    expect(event).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ runId, workerTaskId }),
    });
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
        name: "target materialized worker changes",
        status: "passed",
        evidence: "src/landing.ts",
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

  test("blocks materialized target integration when dirty files are not verified worker output", async () => {
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
    await writeFile(join(repoPath, "NOTES.md"), "human note\n");

    const runId = harness.createRun({ goal: "Reject unrelated target changes", projectRoot: repoPath });
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
      commitMessage: "Should not integrate unrelated target changes",
    });

    expect(result).toMatchObject({
      status: "blocked",
      actionType: "integrateVerifiedRun",
      summary: expect.stringContaining("outside the verified worker output"),
      problems: [expect.stringContaining("NOTES.md")],
    });
    expect(git(repoPath, ["log", "--oneline", "-1"]).stdout).toContain("Initial commit");
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
        workerTaskId: sourceWorkerTaskId,
        verifierTaskId: repairVerifierTaskId,
        worktreePath: sourceWorktreePath,
        sourceBranch: "task-source-worker",
        changedFiles: ["src/fixed.ts"],
      }),
    );
    expect(integratedFile?.trim()).toBe("export const fixed = true;");
    expect(readinessAfter.unintegrated).toHaveLength(0);
    expect(readinessAfter.integratedWorkerTaskIds.has(sourceWorkerTaskId)).toBe(true);
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

    const result = applyHarnessAction(
      harness,
      {
        type: "startSubsession",
        parentTaskId: taskId,
        purpose: "Research API contracts",
        prompt: "Inspect the protocol docs and summarize the harness-managed subsession contract.",
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
