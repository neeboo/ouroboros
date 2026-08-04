import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "bun:test";
import { Harness, applyHarnessAction } from "../packages/harness/src";

describe("dashboard diagnostics stream", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-diag-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("acpx diagnostics events are surfaced via attempt_events stream", async () => {
    const runId = harness.createRun({ goal: "Surface diagnostics" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Surface diagnostics",
      prompt: "Emit diagnostics.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task-1", route: { backend: { kind: "acpx", agent: "claude", source: "cli-executor" } } },
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 1,
      payload: {
        type: "acpx.attempt.started",
        agent: "claude",
        sessionName: "task-1",
        approval: "approve-all",
        format: "json",
        cwd: "/repo",
        attemptId,
        worktreePath: "/repo/worktrees/task-1",
      },
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 2,
      payload: {
        type: "acpx.attempt.terminal",
        agent: "claude",
        sessionName: "task-1",
        attemptId,
        exitCode: 0,
      },
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 3,
      payload: {
        type: "acpx.attempt.recovery.start",
        agent: "claude",
        sessionName: "task-1",
        attemptId,
      },
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 4,
      payload: {
        type: "acpx.attempt.recovery.succeeded",
        agent: "claude",
        sessionName: "task-1",
        attemptId,
      },
    });
    harness.finishAttempt({
      attemptId,
      output: {
        status: "done",
        summary: "recovered via same-session recovery",
        changedFiles: [],
        checks: [],
        artifacts: [
          {
            kind: "acpx_terminal_evidence",
            agent: "claude",
            sessionName: "task-1",
            terminalReason: "terminal_no_envelope",
            recoveryAttempted: true,
            lastStdout: "",
            lastStderr: "",
            worktreeSnapshot: "cwd:/repo",
          },
        ],
        problems: [],
      },
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 50 });
    const session = overview.sessions.find((candidate) => candidate.attemptId === attemptId);
    expect(session).toBeDefined();
    const eventTypes = (session?.events ?? [])
      .map((event) => event.payload?.type)
      .filter((value): value is string => typeof value === "string");
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "acpx.attempt.started",
        "acpx.attempt.terminal",
        "acpx.attempt.recovery.start",
        "acpx.attempt.recovery.succeeded",
      ]),
    );
    const terminalArtifacts = (session?.output.artifacts ?? []).filter(
      (artifact) => (artifact as Record<string, unknown>)?.kind === "acpx_terminal_evidence",
    );
    expect(terminalArtifacts).toHaveLength(1);
    expect((terminalArtifacts[0] as Record<string, unknown>)?.terminalReason).toBe("terminal_no_envelope");
    expect((terminalArtifacts[0] as Record<string, unknown>)?.recoveryAttempted).toBe(true);
  });

  test("shared root cause and budget diagnostics are exposed via run context", () => {
    const runId = harness.createRun({
      goal: "Surface budget and root cause",
      context: {
        repairReplanBudget: {
          limit: 3,
          used: 2,
          entries: [
            { taskId: "task_a", kind: "repair", summary: "first", chargedAt: "2026-01-01T00:00:00Z" },
            { taskId: "task_b", kind: "repair", summary: "second", chargedAt: "2026-01-01T00:00:00Z" },
          ],
          sharedRootCause: "task_root:terminal_no_envelope",
        },
      },
    });
    const rootTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Root",
      prompt: "Fail.",
    });
    harness.recordAttempt({
      taskId: rootTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Root unrecoverable",
        changedFiles: [],
        checks: [],
        artifacts: [
          { kind: "acpx_terminal_evidence", terminalReason: "terminal_no_envelope" },
        ],
        problems: [],
      },
    });
    for (let index = 0; index < 5; index += 1) {
      harness.createTask({
        runId,
        role: "worker",
        goal: `Descendant ${index}`,
        prompt: "Dependent.",
        dependsOn: [rootTaskId],
      });
    }
    applyHarnessAction(harness, { type: "prepareRunDrain", runId });

    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    const run = overview.run!;
    expect(run.context.repairReplanBudget).toBeDefined();
    expect((run.context.repairReplanBudget as Record<string, unknown>).limit).toBe(3);
    expect((run.context.repairReplanBudget as Record<string, unknown>).used).toBe(2);
    const sharedRoots = run.context.sharedRootCauses as Array<Record<string, unknown>>;
    expect(sharedRoots.length).toBeGreaterThan(0);
    expect(sharedRoots[0]?.rootTaskId).toBe(rootTaskId);
    expect(sharedRoots[0]?.terminalReason).toBe("terminal_no_envelope");
    expect(Array.isArray(sharedRoots[0]?.descendantTaskIds)).toBe(true);
    expect((sharedRoots[0]?.descendantTaskIds as string[]).length).toBe(5);
  });
});
