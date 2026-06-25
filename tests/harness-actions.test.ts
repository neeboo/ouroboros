import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyHarnessAction,
  describeIntegrationReadiness,
  Harness,
  type SubsessionRunner,
  type SubsessionRunnerCancelChild,
  type SubsessionRunnerCollectChild,
  type SubsessionRunnerStartInput,
  type SubsessionRunnerStartResult,
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
    expect(verifier?.status).toBe("blocked");
    expect(verifierAttempt).toMatchObject({
      taskId: verifierTaskId,
      status: "blocked",
      summary: expect.stringContaining("dependencies are blocked"),
    });
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
        targetBackends: ["codex", "hermes"],
        keep: true,
      },
    });

    const result = applyHarnessAction(harness, {
      type: "updateRunContext",
      runId,
      goal: "Prove Hermes support first",
      contextPatch: {
        targetBackends: ["hermes"],
        scope: "hermes-first",
      },
      reason: "narrow user scope to Hermes",
    });
    const run = harness.getRun(runId)!;
    const event = harness.listHarnessActionEvents({ limit: 1 })[0];

    expect(result).toMatchObject({
      status: "done",
      actionType: "updateRunContext",
      eventId: expect.any(String),
    });
    expect(run.goal).toBe("Prove Hermes support first");
    expect(run.status).toBe("todo");
    expect(run.context).toEqual({
      targetBackends: ["hermes"],
      keep: true,
      scope: "hermes-first",
    });
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "run_context_update",
        runId,
        previousGoal: "Prove backend support",
        goal: "Prove Hermes support first",
        patchedKeys: ["scope", "targetBackends"],
      }),
    );
    expect(event).toMatchObject({
      actionType: "updateRunContext",
      status: "done",
      request: expect.objectContaining({ runId, reason: "narrow user scope to Hermes" }),
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
