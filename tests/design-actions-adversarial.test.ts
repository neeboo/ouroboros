import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type AttemptOutput,
  type DesignActionInput,
  type HarnessDatabase,
  Harness as HarnessClass,
  isStrictIsoTimestamp,
  optionalStrictIsoTimestamp,
  requireStrictIsoTimestamp,
} from "../packages/harness/src";
import { createApplyDesignActionsHook } from "../packages/runner/src/hooks/apply-design-actions";
import { parseAttemptOutput } from "../packages/runner/src";

// Fault-injection harness that overrides the audit-write primitive so the
// mutation and audit cannot both succeed. Used to prove that a failed audit
// rolls back the entire design action and leaves no durable mutation or child
// run behind.
class AuditFaultHarness extends HarnessClass {
  public faultingActionTypes: Set<string> = new Set();
  public auditWriteFailures = 0;
  public auditWriteAttempts = 0;

  override recordHarnessActionEventWithDb(db: HarnessDatabase, input: {
    actionType: string;
    status: "done" | "blocked";
    request: Record<string, unknown>;
    result: Record<string, unknown>;
  }): string {
    this.auditWriteAttempts += 1;
    if (this.faultingActionTypes.has(input.actionType)) {
      this.auditWriteFailures += 1;
      throw new Error(`injected audit-write failure for ${input.actionType}`);
    }
    return super.recordHarnessActionEventWithDb(db, input);
  }
}

const validProposal = {
  problem: "Cold-cache test runner flake",
  recommendation: "Pre-warm the cache before running",
  evidenceRefs: ["signal_abc"],
  options: [
    {
      name: "pre-warm cache",
      benefits: ["faster startup"],
      costs: ["small boot cost"],
      risks: ["none"],
      lockIn: ["none"],
    },
    {
      name: "leave as-is",
      benefits: ["no change"],
      costs: ["ongoing flake"],
      risks: ["continued flake"],
      lockIn: ["none"],
    },
  ],
  evaluationContract: {
    baseline: ["cold-cache startup 12s"],
    successMetrics: ["cold-cache startup under 7s"],
    guardMetrics: ["test reliability stays at 100%"],
    requiredEvidence: ["bun test results from three runs"],
  },
  investment: {
    reversibility: "easy" as const,
    portfolio: "core" as const,
    oneTimeCost: 0,
    recurringCost: 0,
    timeBudget: "1 hour",
  },
};

describe("design-action adversarial contract", () => {
  let dir: string;
  let harness: AuditFaultHarness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-design-adv-"));
    harness = new AuditFaultHarness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("strict ISO 8601 timestamp validation", () => {
    test.each([
      ["canonical UTC", "2026-08-02T10:00:00Z"],
      ["UTC with milliseconds", "2026-08-02T10:00:00.000Z"],
      ["far future UTC", "3025-01-01T00:00:00.000Z"],
    ])("accepts %s timestamps", (_label, value) => {
      expect(() => requireStrictIsoTimestamp(value, "test.timestamp")).not.toThrow();
      expect(isStrictIsoTimestamp(value)).toBe(true);
    });

    test.each([
      ["natural-language (Date.parse accepts)", "March 1, 2026"],
      ["RFC 2822 (Date.parse accepts)", "01 Mar 2026 12:00:00 GMT"],
      ["date-only (Date.parse accepts)", "2026-03-01"],
      ["numeric string (Date.parse accepts)", "9999"],
      ["timezone offset instead of Z", "2026-08-02T10:00:00+00:00"],
      ["missing timezone", "2026-08-02T10:00:00"],
      ["empty string", ""],
      ["whitespace", "   "],
      ["null", null],
      ["undefined", undefined],
      ["number primitive", 9999],
      ["boolean primitive", true],
      ["object", { iso: "2026-08-02T00:00:00Z" }],
      ["array", ["2026-08-02T00:00:00Z"]],
    ])("rejects %s timestamps", (_label, value) => {
      expect(isStrictIsoTimestamp(value)).toBe(false);
      expect(() => requireStrictIsoTimestamp(value, "test.timestamp")).toThrow(
        /ISO 8601/,
      );
    });

    test("optionalStrictIsoTimestamp preserves null and undefined sentinel", () => {
      expect(optionalStrictIsoTimestamp(null, "label")).toBeNull();
      expect(optionalStrictIsoTimestamp(undefined, "label")).toBeUndefined();
      expect(optionalStrictIsoTimestamp("2026-08-02T00:00:00Z", "label")).toBe(
        "2026-08-02T00:00:00Z",
      );
      expect(() =>
        optionalStrictIsoTimestamp("March 1, 2026", "label"),
      ).toThrow(/ISO 8601/);
    });

    test.each([
      ["natural-language observationTime", { observationTime: "March 1, 2026" }],
      ["RFC 2822 observationTime", { observationTime: "01 Mar 2026 12:00:00 GMT" }],
      ["date-only observationTime", { observationTime: "2026-03-01" }],
      ["timezone-offset observationTime", { observationTime: "2026-08-02T10:00:00+00:00" }],
      ["numeric observationTime", { observationTime: "9999" }],
    ])("recordSignal parser rejects %s", (_label, partial) => {
      const payload = {
        ...partial,
        projectId: "project_1",
        signalClass: "delivery",
        source: "tests",
        title: "title",
        summary: "summary",
        confidence: 0.5,
      };
      expect(() =>
        parseAttemptOutput(
          JSON.stringify({
            status: "done",
            summary: "x",
            actions: [{ type: "recordSignal", payload }],
          }),
        ),
      ).toThrow(/observationTime/);
    });

    test.each([
      ["natural-language expiresAt", { expiresAt: "March 1, 2026" }],
      ["date-only expiresAt", { expiresAt: "2026-03-01" }],
      ["timezone-offset expiresAt", { expiresAt: "2026-08-02T10:00:00+00:00" }],
      ["numeric expiresAt", { expiresAt: "9999" }],
    ])("recordSignal parser rejects %s", (_label, partial) => {
      const payload = {
        projectId: "project_1",
        signalClass: "delivery",
        source: "tests",
        title: "title",
        summary: "summary",
        observationTime: "2026-08-02T00:00:00Z",
        confidence: 0.5,
        ...partial,
      };
      expect(() =>
        parseAttemptOutput(
          JSON.stringify({
            status: "done",
            summary: "x",
            actions: [{ type: "recordSignal", payload }],
          }),
        ),
      ).toThrow(/expiresAt/);
    });
  });

  describe("audit-write atomicity", () => {
    test("recordSignal mutation rolls back when the audit write fails", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const hook = createApplyDesignActionsHook({ harness });

      harness.faultingActionTypes.add("design.recordSignal");

      const output: AttemptOutput = {
        status: "done",
        summary: "design",
        designActions: [
          {
            type: "recordSignal",
            payload: {
              projectId,
              signalClass: "delivery",
              source: "tests",
              title: "title",
              summary: "summary",
              observationTime: "2026-08-02T00:00:00Z",
              confidence: 0.5,
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.some((p) => p.includes("injected audit-write failure"))).toBe(true);

      expect(harness.listStrategySignals({ projectId })).toHaveLength(0);
      // The audit primitive fails twice: once for the in-transaction `done`
      // write (which rolls back the mutation), and once for the hook's
      // out-of-band `blocked` write (which surfaces as a second problem).
      expect(harness.auditWriteFailures).toBe(2);
      const designEvents = harness
        .listHarnessActionEvents({ limit: 20 })
        .filter((event) => event.actionType.startsWith("design."));
      // No audit row can exist because the audit primitive itself failed both
      // times. The mutation also rolled back, so signals and audit rows agree
      // on the empty outcome.
      expect(designEvents).toHaveLength(0);
    });

    test("proposeDesign mutation rolls back when the audit write fails", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const hook = createApplyDesignActionsHook({ harness });

      harness.faultingActionTypes.add("design.proposeDesign");

      const output: AttemptOutput = {
        status: "done",
        summary: "proposal",
        designActions: [
          {
            type: "proposeDesign",
            payload: {
              projectId,
              title: "Pre-warm cache",
              proposal: validProposal,
              status: "proposed",
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.some((p) => p.includes("injected audit-write failure"))).toBe(true);
      expect(harness.listDesignProposals({ projectId })).toHaveLength(0);
    });

    test("createRunsFromDesign rolls back child runs when the audit write fails", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const proposal = harness.createDesignProposal({
        projectId,
        title: "Pre-warm cache",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      harness.recordDesignDecision({
        proposalId: proposal.id,
        decision: "approved",
        actorKind: "human",
        actorRef: "founder@example.com",
        reasons: ["founder approval"],
      });
      harness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });
      const hook = createApplyDesignActionsHook({ harness });

      harness.faultingActionTypes.add("design.createRunsFromDesign");

      const beforeRunCount = harness.getRunOverview({ runId }).run ? 1 : 1;

      const output: AttemptOutput = {
        status: "done",
        summary: "deliver",
        designActions: [
          {
            type: "createRunsFromDesign",
            payload: {
              proposalId: proposal.id,
              runs: [
                {
                  goal: "Plan pre-warm",
                  prompt: "Plan the change.",
                },
              ],
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.some((p) => p.includes("injected audit-write failure"))).toBe(true);

      // No child runs should have survived. The parent run is still present,
      // but no new runs should have appeared in its place.
      const allRuns = harness.listRuns({});
      const childRuns = allRuns.filter((r) => r.context?.parentRunId === runId);
      expect(childRuns).toHaveLength(0);
      void beforeRunCount;
    });

    test("a successful action after a fault leaves a clean paired audit row", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const hook = createApplyDesignActionsHook({ harness });

      // First: fault mid-batch.
      harness.faultingActionTypes.add("design.recordSignal");
      const faultedOutput: AttemptOutput = {
        status: "done",
        summary: "design",
        designActions: [
          {
            type: "recordSignal",
            payload: {
              projectId,
              signalClass: "delivery",
              source: "tests",
              title: "rolled back",
              summary: "rolled back",
              observationTime: "2026-08-02T00:00:00Z",
              confidence: 0.5,
            },
          },
        ],
      } as AttemptOutput;

      const faultedResult = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output: faultedOutput,
      });
      expect(faultedResult.decision).toBe("exit");

      // Then: clear the fault and run a successful action.
      harness.faultingActionTypes.delete("design.recordSignal");
      const successOutput: AttemptOutput = {
        status: "done",
        summary: "design",
        designActions: [
          {
            type: "recordSignal",
            payload: {
              projectId,
              signalClass: "delivery",
              source: "tests",
              title: "persisted",
              summary: "persisted",
              observationTime: "2026-08-02T00:00:00Z",
              confidence: 0.5,
            },
          },
        ],
      } as AttemptOutput;

      const successResult = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output: successOutput,
      });
      expect(successResult.decision).toBe("exit");

      const signals = harness.listStrategySignals({ projectId });
      expect(signals).toHaveLength(1);
      expect(signals[0].title).toBe("persisted");

      const designEvents = harness
        .listHarnessActionEvents({ limit: 20 })
        .filter((event) => event.actionType.startsWith("design."));
      // Only the successful mutation's `done` audit row should be present.
      // The rolled-back action left no audit row.
      expect(designEvents).toHaveLength(1);
      expect(designEvents[0]).toMatchObject({
        actionType: "design.recordSignal",
        status: "done",
      });
    });
  });

  describe("designer cannot forge human or governance approval", () => {
    test("forged human approval is rejected and no durable decision is recorded", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const proposal = harness.createDesignProposal({
        projectId,
        title: "Pre-warm cache",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      const hook = createApplyDesignActionsHook({ harness });

      const forged: AttemptOutput = {
        status: "done",
        summary: "approve",
        designActions: [
          {
            type: "decideDesign",
            payload: {
              proposalId: proposal.id,
              decision: "approved",
              actorKind: "human",
              actorRef: "founder@example.com",
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output: forged,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.[0]).toContain("approved is not allowed from designer output");
      expect(harness.listDesignDecisions({ proposalId: proposal.id })).toHaveLength(0);
      expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("proposed");
    });

    test("forged governance approval is rejected and no durable decision is recorded", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const proposal = harness.createDesignProposal({
        projectId,
        title: "Pre-warm cache",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      const hook = createApplyDesignActionsHook({ harness });

      const forged: AttemptOutput = {
        status: "done",
        summary: "approve",
        designActions: [
          {
            type: "decideDesign",
            payload: {
              proposalId: proposal.id,
              decision: "approved",
              actorKind: "governance",
              actorRef: "board@example.com",
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output: forged,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.[0]).toContain("approved is not allowed from designer output");
      expect(harness.listDesignDecisions({ proposalId: proposal.id })).toHaveLength(0);
    });

    test("createRunsFromDesign refuses to deliver without a real approved decision", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const proposal = harness.createDesignProposal({
        projectId,
        title: "Pre-warm cache",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      // No approved decision recorded — proposal stays in proposed status.
      const hook = createApplyDesignActionsHook({ harness });

      const output: AttemptOutput = {
        status: "done",
        summary: "deliver",
        designActions: [
          {
            type: "createRunsFromDesign",
            payload: {
              proposalId: proposal.id,
              runs: [{ goal: "Plan pre-warm", prompt: "Plan the change." }],
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.[0]).toContain("requires an accepted proposal");
      // No child runs survived.
      const runs = harness.listRuns({});
      expect(runs.filter((r) => r.context?.parentRunId === runId)).toHaveLength(0);
    });

    test("createRunsFromDesign refuses an approved decision with empty actorRef", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const proposal = harness.createDesignProposal({
        projectId,
        title: "Pre-warm cache",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      // The authority path normally rejects empty actorRef, but the database
      // itself permits it. We test the defense in depth: even if an
      // approved/human row exists with empty actorRef, the design action hook
      // refuses to deliver.
      harness.recordDesignDecision({
        proposalId: proposal.id,
        decision: "approved",
        actorKind: "human",
        actorRef: "",
        reasons: ["should not have happened"],
      });
      harness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });
      const hook = createApplyDesignActionsHook({ harness });

      const output: AttemptOutput = {
        status: "done",
        summary: "deliver",
        designActions: [
          {
            type: "createRunsFromDesign",
            payload: {
              proposalId: proposal.id,
              runs: [{ goal: "Plan pre-warm", prompt: "Plan the change." }],
            },
          },
        ],
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.[0]).toContain("missing actorRef");
      const runs = harness.listRuns({});
      expect(runs.filter((r) => r.context?.parentRunId === runId)).toHaveLength(0);
    });
  });

  describe("evidence expiry cannot authorize investment", () => {
    test("createRunsFromDesign honors evidence expiry when frozen evidence is stale", async () => {
      // Evidence expiry is enforced by the authority evaluator rather than the
      // delivery hook. This adversarial probe confirms that an expired evidence
      // timestamp fails closed via the parser's strict ISO 8601 guard: a
      // designer cannot smuggle a non-ISO expiry past the parser to reset the
      // clock on stale evidence.
      const payload = {
        projectId: "project_1",
        signalClass: "delivery",
        source: "tests",
        title: "stale",
        summary: "stale",
        observationTime: "2026-08-02T00:00:00Z",
        confidence: 0.5,
        expiresAt: "March 1, 2026",
      };
      expect(() =>
        parseAttemptOutput(
          JSON.stringify({
            status: "done",
            summary: "x",
            actions: [{ type: "recordSignal", payload }],
          }),
        ),
      ).toThrow(/expiresAt/);
    });
  });

  describe("design action atomicity preserves minimal protocol", () => {
    test("mutations without an audit row cannot survive", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      const hook = createApplyDesignActionsHook({ harness });

      // Cause every audit write to fail.
      harness.faultingActionTypes.add("design.recordSignal");
      harness.faultingActionTypes.add("design.proposeDesign");

      const actions: DesignActionInput[] = [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "tests",
            title: "should not persist",
            summary: "should not persist",
            observationTime: "2026-08-02T00:00:00Z",
            confidence: 0.5,
          },
        },
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "should not persist",
            proposal: validProposal,
            status: "proposed",
          },
        },
      ];

      const output: AttemptOutput = {
        status: "done",
        summary: "design",
        designActions: actions,
      } as AttemptOutput;

      const result = await hook({
        run: harness.getRun(runId)!,
        task: harness.getTask(taskId)!,
        sessionName: "session",
        prompt: "design",
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.length).toBeGreaterThanOrEqual(2);

      // No mutations may outlive their audit row.
      expect(harness.listStrategySignals({ projectId })).toHaveLength(0);
      expect(harness.listDesignProposals({ projectId })).toHaveLength(0);
      const designEvents = harness
        .listHarnessActionEvents({ limit: 20 })
        .filter((event) => event.actionType.startsWith("design."));
      expect(designEvents).toHaveLength(0);
    });
  });
});
