import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "bun:test";
import { Harness, applyHarnessAction } from "../packages/harness/src";
import { handleDashboardRequest } from "../packages/cli/src/dashboard";

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

  test("watchdog diagnostics expose normalized coordination and canary evidence", () => {
    const fingerprint = "a".repeat(64);
    const repairFingerprint = "b".repeat(64);
    const runId = "run_dashboard_watchdog";
    harness.createRun({
      id: runId,
      goal: "Surface watchdog diagnostics",
      context: {
        controlPlaneWatchdog: {
          version: 1,
          state: "reconciling",
          fingerprint,
          firstSeenAt: "2026-08-09T10:00:00.000Z",
          unchangedEligibleTicks: 4,
          lastMeaningfulProgressAt: "2026-08-09T09:59:00.000Z",
          lastObservationAt: "2026-08-09T10:04:00.000Z",
          recoveryStage: "reconcile",
          repairFingerprint,
          repairRunId: "run_watchdog_repair_example",
          repairTaskId: "task_watchdog_repair_example",
          actionEventIds: ["action_watchdog_reconcile_example"],
          attemptCount: 1,
          cooldownUntil: "2026-08-09T10:19:00.000Z",
          affectedRunIds: [runId],
          fault: {
            kind: "empty-nonterminal-run",
            affectedRunIds: [runId],
            selectedAction: "prepareRunDrain",
            details: "empty run",
          },
          canary: {
            status: "pending",
            observedAt: "2026-08-09T10:04:00.000Z",
            fingerprint: repairFingerprint,
            evidence: [],
            ticksInCanary: 0,
          },
          failure: null,
          history: [],
        },
      },
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 0 });
    expect(overview.controlPlaneWatchdog).toMatchObject({
      state: "reconciling",
      fingerprint,
      recoveryStage: "reconcile",
      repairFingerprint,
      cooldownUntil: "2026-08-09T10:19:00.000Z",
      actionEventIds: ["action_watchdog_reconcile_example"],
      canary: {
        status: "pending",
        fingerprint: repairFingerprint,
        ticksInCanary: 0,
      },
    });

    harness.updateRun({
      runId,
      contextPatch: {
        controlPlaneWatchdog: {
          ...overview.controlPlaneWatchdog,
          state: "canary",
          recoveryStage: "canary",
          cooldownUntil: null,
          canary: {
            status: "progressing",
            observedAt: "2026-08-09T10:05:00.000Z",
            fingerprint: "c".repeat(64),
            evidence: ["target task reached done"],
            ticksInCanary: 1,
          },
        },
      },
    });
    const refreshed = harness.getRunOverview({ runId, eventLimit: 0 });
    expect(refreshed.controlPlaneWatchdog).toMatchObject({
      state: "canary",
      recoveryStage: "canary",
      cooldownUntil: null,
      canary: {
        status: "progressing",
        fingerprint: "c".repeat(64),
        evidence: ["target task reached done"],
        ticksInCanary: 1,
      },
    });
  });

  test("overview polling exposes the persisted runtime generation without rewriting it", async () => {
    const runtime = {
      state: "draining-for-reload",
      generation: 3,
      launchHead: "head-a",
      observedHead: "head-b",
      promptContractHash: "a".repeat(64),
      handoffReceipt: { oldHead: "head-a", newHead: "head-b" },
    };
    const runId = harness.createRun({ goal: "Runtime provenance", context: { controlPlaneRuntime: runtime } });
    const response = await handleDashboardRequest(
      new Request(`http://localhost/api/runs/${runId}/overview`),
      { runId, overview: () => harness.getRunOverview({ runId, eventLimit: 0 }), renderTaskPrompt: () => "" },
    );
    const body = await response.json();

    expect(body.run.context.controlPlaneRuntime).toEqual(runtime);
    expect(new Harness(join(dir, "ouroboros.db")).getRun(runId)?.context.controlPlaneRuntime).toEqual(runtime);
  });
});
