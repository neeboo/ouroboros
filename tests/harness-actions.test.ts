import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyHarnessAction, Harness } from "../packages/harness/src";
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
    expect(harness.getRun(runId)?.status).toBe("blocked");
    expect(harness.getTask(taskId)?.status).toBe("blocked");
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "blocked_task", taskId }));
    expect(event).toMatchObject({
      actionType: "retireRun",
      status: "done",
      request: expect.objectContaining({ reason: "duplicate historical self-iteration run" }),
    });
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
});
