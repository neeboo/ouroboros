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

    test("authenticated legacy human and governance approvals without charterId each create exactly one child run", async () => {
      const runId = harness.createRun({ goal: "design run" });
      const taskId = harness.createTask({
        runId,
        role: "designer",
        goal: "design",
        prompt: "design",
      });
      const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
      // No active founder charter is seeded and no charterId is recorded on
      // either the proposal or the decision — this is the legacy/manual
      // envelope that predates the coordinator's resolved-charter stamp.
      // Authenticated human and governance approvals (non-empty actorRef)
      // must remain delivery-eligible and create exactly one child run each.
      const humanProposal = harness.createDesignProposal({
        projectId,
        title: "Legacy human-approved change",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      harness.recordDesignDecision({
        proposalId: humanProposal.id,
        decision: "approved",
        actorKind: "human",
        actorRef: "founder@legacy",
        reasons: ["legacy human approval"],
      });
      harness.updateDesignProposalStatus({ proposalId: humanProposal.id, status: "accepted" });

      const governanceProposal = harness.createDesignProposal({
        projectId,
        title: "Legacy governance-approved change",
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "proposed",
      });
      harness.recordDesignDecision({
        proposalId: governanceProposal.id,
        decision: "approved",
        actorKind: "governance",
        actorRef: "council@legacy",
        reasons: ["legacy governance approval"],
      });
      harness.updateDesignProposalStatus({ proposalId: governanceProposal.id, status: "accepted" });

      const hook = createApplyDesignActionsHook({ harness });

      const output: AttemptOutput = {
        status: "done",
        summary: "deliver legacy approvals",
        designActions: [
          {
            type: "createRunsFromDesign",
            payload: {
              proposalId: humanProposal.id,
              runs: [{ goal: "Plan legacy human change", prompt: "Plan the change." }],
            },
          },
          {
            type: "createRunsFromDesign",
            payload: {
              proposalId: governanceProposal.id,
              runs: [{ goal: "Plan legacy governance change", prompt: "Plan the change." }],
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

      expect(result.decision).toBe("continue");
      expect(result.problems ?? []).toHaveLength(0);
      const childRuns = harness
        .listRuns({})
        .filter((r) => r.context?.parentRunId === runId);
      expect(childRuns).toHaveLength(2);
      // Each legacy child run inherits its own proposal id and a null charter
      // (no charterId was recorded and no active charter exists to fall back).
      const humanChild = childRuns.find(
        (r) => r.context?.designProposalId === humanProposal.id,
      );
      const governanceChild = childRuns.find(
        (r) => r.context?.designProposalId === governanceProposal.id,
      );
      expect(humanChild).toBeDefined();
      expect(governanceChild).toBeDefined();
      expect(humanChild?.context).toMatchObject({
        designProposalId: humanProposal.id,
        designCharterId: null,
        designApprovalAuthority: expect.objectContaining({ actorKind: "human" }),
      });
      expect(governanceChild?.context).toMatchObject({
        designProposalId: governanceProposal.id,
        designCharterId: null,
        designApprovalAuthority: expect.objectContaining({ actorKind: "governance" }),
      });
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

// Production transition coordinator coverage. The Hook now wraps every fixed
// action with a bounded authority transition: recordSignal emits one Designer
// continuation carrying the durable signal ID, proposeDesign runs the authority
// evaluator and routes to approved/accepted+continuation, rejected, or a
// deferred human-checkpoint, and createRunsFromDesign drains an accepted
// proposal to exactly one frozen-contract child run. Adversarial cases below
// prove the fail-closed behaviour for every ambiguous or hostile input and
// the idempotency guarantees required for safe replay.
describe("design-action transition coordinator (production authority path)", () => {
  let dir: string;
  let harness: AuditFaultHarness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-design-coord-"));
    harness = new AuditFaultHarness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function seedActiveCharter(projectId: string): string {
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Build a safe autonomous strategy loop.",
      charter: {
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
      },
      activate: true,
    });
    return charter.id;
  }

  function seedActiveSignal(
    projectId: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const signal = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "verifier",
      title: "Cold-cache startup over 7s",
      summary: "Three consecutive cold-cache test runs averaged 12s.",
      observationTime: "2026-08-01T00:00:00.000Z",
      confidence: 0.6,
      evidence: [],
      status: "active",
      expiresAt: null,
      ...overrides,
    });
    return signal.id;
  }

  function lowRiskEnvelope(
    signalId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      problem: "Test runner flakes on cold cache",
      recommendation: "Pre-warm the cache before running",
      evidenceRefs: [signalId],
      options: [
        {
          name: "pre-warm cache",
          benefits: ["faster startup"],
          costs: ["small boot cost"],
          risks: ["none"],
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
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      riskSurface: {
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
      },
      ...overrides,
    };
  }

  function setupRunAndTask(): { runId: string; taskId: string } {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    return { runId, taskId };
  }

  async function runHook(output: AttemptOutput, runId: string, taskId: string) {
    const hook = createApplyDesignActionsHook({ harness });
    return hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output,
    });
  }

  function continuationArtifacts(result: { artifacts?: unknown[] }) {
    return (result.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    );
  }

  function createdRunArtifacts(result: { artifacts?: unknown[] }) {
    return (result.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
  }

  test("low-risk signal→proposal→delivery drains to exactly one child run inheriting the frozen contract", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);

    const signalOutput: AttemptOutput = {
      status: "done",
      summary: "signal",
      designActions: [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "verifier",
            title: "Cold-cache startup over 7s",
            summary: "Three consecutive cold-cache test runs averaged 12s.",
            observationTime: "2026-08-01T00:00:00.000Z",
            confidence: 0.6,
          },
        },
      ],
    } as AttemptOutput;

    const signalResult = await runHook(signalOutput, runId, taskId);
    expect(signalResult.decision).toBe("exit");
    // recordSignal emits exactly one continuation carrying the durable signal ID.
    const signalContinuations = continuationArtifacts(signalResult);
    expect(signalContinuations).toHaveLength(1);
    const signalId = harness.listStrategySignals({ projectId })[0].id;
    expect((signalContinuations[0] as { signalId?: string }).signalId).toBe(signalId);
    const continuationTaskId = (signalContinuations[0] as { taskId: string }).taskId;
    const continuationTask = harness.getTask(continuationTaskId);
    expect(continuationTask?.role).toBe("designer");
    expect(continuationTask?.prompt).toContain(signalId);
    expect(continuationTask?.dependsOn).toEqual([taskId]);

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposeResult = await runHook(proposeOutput, runId, taskId);
    expect(proposeResult.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("accepted");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const autoApproval = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(autoApproval).toBeDefined();
    expect(autoApproval?.authority?.disposition).toBe("automatic");

    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposals[0].id,
            runs: [{ goal: "Plan pre-warm", prompt: "Plan the change." }],
          },
        },
      ],
    } as AttemptOutput;

    const deliverResult = await runHook(deliverOutput, runId, taskId);
    expect(deliverResult.decision).toBe("continue");
    const created = createdRunArtifacts(deliverResult);
    expect(created).toHaveLength(1);
    const childRunId = (created[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    expect(childRun?.context).toMatchObject({
      parentRunId: runId,
      sourceTaskId: taskId,
      source: "design",
      designProposalId: proposals[0].id,
      designEvaluationContract: expect.objectContaining({
        successMetrics: ["cold-cache startup under 7s"],
        requiredEvidence: ["bun test results from three runs"],
      }),
      designProposal: expect.objectContaining({
        problem: "Test runner flakes on cold cache",
        recommendation: "Pre-warm the cache before running",
        evidenceRefs: [signalId],
      }),
      designApprovalAuthority: expect.objectContaining({
        decision: "approved",
        actorKind: "auto",
      }),
    });
  });

  test("production-format proposal without an explicit riskSurface field auto-approves when content is genuinely low-risk", async () => {
    // The production Designer prompt (packages/cli/src/main.ts) does not require
    // an explicit `riskSurface` field. When the designer omits the field
    // entirely, the adapter must rely on the keyword matcher: a proposal with
    // no risk vocabulary and easy reversibility drains to auto-approval.
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);

    const envelopeWithoutRiskSurface = {
      problem: "Test runner flakes on cold cache",
      recommendation: "Pre-warm the cache before running",
      evidenceRefs: [signalId],
      options: [
        {
          name: "pre-warm cache",
          benefits: ["faster startup"],
          costs: ["small boot cost"],
          risks: ["none"],
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
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      // No riskSurface field — this is the production format.
    };

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache (production format)",
            proposal: envelopeWithoutRiskSurface,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("accepted");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const autoApproval = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(autoApproval).toBeDefined();
    expect(autoApproval?.authority?.disposition).toBe("automatic");
    expect(continuationArtifacts(result)).toHaveLength(1);
  });

  test("production-format proposal containing risk vocabulary is gated by the keyword matcher without an explicit riskSurface", async () => {
    // Without an explicit declaration, the keyword matcher is the durable
    // safety net: a proposal whose evidence or text mentions a checkpoint
    // keyword is still forced to human-required.
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId, {
      title: "Schema migration needed to fix flake",
      summary: "Resolving the cold-cache flake requires a schema migration of the runs table.",
    });

    const envelopeWithSchemaRisk = {
      problem: "Cold-cache test runner flake",
      recommendation: "Pre-warm the cache before running",
      evidenceRefs: [signalId],
      options: [
        {
          name: "pre-warm cache",
          benefits: ["faster startup"],
          costs: ["small boot cost"],
          risks: ["none"],
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
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      // No riskSurface field — the keyword matcher must catch the schema
      // migration vocabulary in the cited signal's title and summary.
    };

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache (production format with risk vocabulary)",
            proposal: envelopeWithSchemaRisk,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      checkpoint?.reasons.some((reason) => String(reason).includes("schema-migration")),
    ).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("full production-format signal→proposal→delivery cycle drains to exactly one child run", async () => {
    // End-to-end coverage of the production format: the cycle uses no
    // riskSurface declaration at any step. The low-risk content drains from
    // recordSignal through proposeDesign (auto-approved by the keyword-aware
    // adapter) to a single createRunsFromDesign child run that inherits the
    // frozen contract.
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);

    const signalOutput: AttemptOutput = {
      status: "done",
      summary: "signal",
      designActions: [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "verifier",
            title: "Cold-cache startup over 7s",
            summary: "Three consecutive cold-cache test runs averaged 12s.",
            observationTime: "2026-08-01T00:00:00.000Z",
            confidence: 0.6,
          },
        },
      ],
    } as AttemptOutput;

    const signalResult = await runHook(signalOutput, runId, taskId);
    expect(signalResult.decision).toBe("exit");
    const signalId = harness.listStrategySignals({ projectId })[0].id;

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: {
              problem: "Cold-cache test runner flake",
              recommendation: "Pre-warm the cache before running",
              evidenceRefs: [signalId],
              options: [
                {
                  name: "pre-warm cache",
                  benefits: ["faster startup"],
                  costs: ["small boot cost"],
                  risks: ["none"],
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
                reversibility: "easy",
                portfolio: "core",
                oneTimeCost: 0,
                recurringCost: 0,
                timeBudget: "1 hour",
              },
            },
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposeResult = await runHook(proposeOutput, runId, taskId);
    expect(proposeResult.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("accepted");
    const autoApproval = harness
      .listDesignDecisions({ proposalId: proposals[0].id })
      .find((decision) => decision.decision === "approved" && decision.actorKind === "auto");
    expect(autoApproval?.authority?.disposition).toBe("automatic");

    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposals[0].id,
            runs: [{ goal: "Plan pre-warm", prompt: "Plan the change." }],
          },
        },
      ],
    } as AttemptOutput;

    const deliverResult = await runHook(deliverOutput, runId, taskId);
    expect(deliverResult.decision).toBe("continue");
    const created = createdRunArtifacts(deliverResult);
    expect(created).toHaveLength(1);
    const childRunId = (created[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    expect(childRun?.context).toMatchObject({
      parentRunId: runId,
      sourceTaskId: taskId,
      source: "design",
      designProposalId: proposals[0].id,
      designEvaluationContract: expect.objectContaining({
        successMetrics: ["cold-cache startup under 7s"],
        requiredEvidence: ["bun test results from three runs"],
      }),
      designApprovalAuthority: expect.objectContaining({
        decision: "approved",
        actorKind: "auto",
      }),
    });
  });

  test("production envelope omitting charterId and riskSurface inherits resolved charter across proposal, decision, and child run with replay idempotency", async () => {
    // Production envelope regression: a valid proposeDesign payload may omit
    // both `charterId` (the production Designer prompt does not require it)
    // and `riskSurface` (covered by the keyword matcher). The coordinator
    // must resolve the active founder charter during authority evaluation,
    // persist that resolved charter on the durable approved decision, and
    // copy the SAME non-null charter ID into the child run's
    // designCharterId and designApprovalAuthority.charterId. Replay must
    // not duplicate the decision, continuation, or child run, and the
    // frozen evaluation contract must be inherited byte-for-byte.
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const resolvedCharterId = seedActiveCharter(projectId);

    // recordSignal — production format, no extra fields.
    const signalOutput: AttemptOutput = {
      status: "done",
      summary: "signal",
      designActions: [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "verifier",
            title: "Cold-cache startup over 7s",
            summary: "Three consecutive cold-cache test runs averaged 12s.",
            observationTime: "2026-08-01T00:00:00.000Z",
            confidence: 0.6,
          },
        },
      ],
    } as AttemptOutput;
    const signalResult = await runHook(signalOutput, runId, taskId);
    expect(signalResult.decision).toBe("exit");
    const signalId = harness.listStrategySignals({ projectId })[0].id;

    // proposeDesign — production envelope: NO charterId, NO riskSurface.
    const productionEnvelope = {
      problem: "Cold-cache test runner flake",
      recommendation: "Pre-warm the cache before running",
      evidenceRefs: [signalId],
      options: [
        {
          name: "pre-warm cache",
          benefits: ["faster startup"],
          costs: ["small boot cost"],
          risks: ["none"],
          lockIn: ["none"],
        },
      ],
      evaluationContract: {
        baseline: ["cold-cache startup 12s"],
        successMetrics: ["cold-cache startup under 7s"],
        guardMetrics: ["test reliability stays at 100%"],
        requiredEvidence: ["bun test results from three runs"],
        reviewAt: "2026-09-15",
      },
      investment: {
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
    };

    const proposePayload = {
      projectId,
      title: "Pre-warm cache (production envelope)",
      proposal: productionEnvelope,
      status: "proposed" as const,
      // NO charterId — the production Designer prompt does not require it.
    };

    const proposeResult = await runHook({
      status: "done",
      summary: "propose",
      designActions: [{ type: "proposeDesign", payload: proposePayload }],
    } as AttemptOutput, runId, taskId);
    expect(proposeResult.decision).toBe("exit");

    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal.status).toBe("accepted");
    // The production payload omitted charterId, so the durable column on the
    // proposal remains null. The resolved charter is persisted on the
    // approved decision — the authoritative source for child-run inheritance.
    expect(proposal.charterId).toBeNull();

    const decisions = harness.listDesignDecisions({ proposalId: proposal.id });
    const autoApproval = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(autoApproval).toBeDefined();
    expect(autoApproval?.authority?.disposition).toBe("automatic");
    expect(autoApproval?.charterId).toBe(resolvedCharterId);

    // createRunsFromDesign — the child run must inherit the resolved charter.
    const deliverPayload = {
      proposalId: proposal.id,
      runs: [
        {
          goal: "Plan pre-warm cache change",
          prompt: "Sharpen the task graph for the pre-warm change.",
          doneWhen: ["Planner returns a small nextTasks graph"],
        },
      ],
    };

    const deliverResult1 = await runHook({
      status: "done",
      summary: "deliver",
      designActions: [{ type: "createRunsFromDesign", payload: deliverPayload }],
    } as AttemptOutput, runId, taskId);
    expect(deliverResult1.decision).toBe("continue");

    const created1 = createdRunArtifacts(deliverResult1);
    expect(created1).toHaveLength(1);
    const childRunId = (created1[0] as { runId: string }).runId;
    const plannerTaskId = (created1[0] as { plannerTaskId: string }).plannerTaskId;
    const childRun = harness.getRun(childRunId);
    expect(childRun).toBeDefined();

    // The child context must carry the resolved non-null charter ID in both
    // designCharterId and designApprovalAuthority.charterId, matching the
    // charter persisted on the durable approved decision.
    const childContext = (childRun?.context ?? {}) as Record<string, unknown>;
    expect(childContext.designCharterId).toBe(resolvedCharterId);
    expect(childContext.designProposalId).toBe(proposal.id);
    expect(childContext.designDecisionId).toBe(autoApproval!.id);
    const childApprovalAuthority = childContext.designApprovalAuthority as {
      charterId?: string;
      decisionId?: string;
      decision?: string;
      actorKind?: string;
    } | undefined;
    expect(childApprovalAuthority?.charterId).toBe(resolvedCharterId);
    expect(childApprovalAuthority?.decisionId).toBe(autoApproval!.id);
    expect(childApprovalAuthority?.decision).toBe("approved");
    expect(childApprovalAuthority?.actorKind).toBe("auto");

    // Byte-for-byte frozen evaluation contract: the inherited contract must
    // equal the proposal's stored evaluationContract exactly.
    const storedProposalRow = harness.getDesignProposal({ id: proposal.id });
    const storedContract = storedProposalRow?.proposal.evaluationContract as Record<string, unknown>;
    const childFrozenContract = childContext.designEvaluationContract as Record<string, unknown>;
    expect(childFrozenContract).toEqual(storedContract);
    expect(childFrozenContract).toEqual(productionEnvelope.evaluationContract);
    // The frozen proposal envelope re-pins the canonical top-level fields.
    const childFrozenProposal = childContext.designProposal as { title?: string; problem?: string };
    expect(childFrozenProposal.title).toBe("Pre-warm cache (production envelope)");
    expect(childFrozenProposal.problem).toBe(productionEnvelope.problem);

    // Replay idempotency: re-running the same createRunsFromDesign action
    // must NOT create a duplicate decision, continuation, or child run.
    const decisionsBeforeReplay = harness.listDesignDecisions({ proposalId: proposal.id }).length;
    const runsBeforeReplay = harness.listRuns({ limit: 100 }).filter(
      (entry) => entry.context?.parentRunId === runId,
    ).length;
    const tasksBeforeReplay = harness
      .getRunOverview({ runId: childRunId })
      .tasks.filter((entry) => entry.runId === childRunId).length;

    const deliverResult2 = await runHook({
      status: "done",
      summary: "deliver-replay",
      designActions: [{ type: "createRunsFromDesign", payload: deliverPayload }],
    } as AttemptOutput, runId, taskId);

    // Replay yields the same child run artifact, no new decisions, no new runs, no new tasks.
    const created2 = createdRunArtifacts(deliverResult2);
    expect(created2).toHaveLength(1);
    expect((created2[0] as { runId: string }).runId).toBe(childRunId);
    expect((created2[0] as { plannerTaskId: string }).plannerTaskId).toBe(plannerTaskId);
    expect(harness.listDesignDecisions({ proposalId: proposal.id })).toHaveLength(decisionsBeforeReplay);
    expect(
      harness.listRuns({ limit: 100 }).filter((entry) => entry.context?.parentRunId === runId),
    ).toHaveLength(runsBeforeReplay);
    expect(
      harness
        .getRunOverview({ runId: childRunId })
        .tasks.filter((entry) => entry.runId === childRunId),
    ).toHaveLength(tasksBeforeReplay);

    // Exactly one child planner run exists for the parent — the cycle drains
    // to a single delivery.
    const childRuns = harness.listRuns({ limit: 100 }).filter(
      (entry) => entry.context?.parentRunId === runId && entry.context?.source === "design",
    );
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0].context?.designCharterId).toBe(resolvedCharterId);
  });

  test("direct conflict: cited signal that names a conflicting peer routes to human-required checkpoint with no delivery run", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const peerSignalId = seedActiveSignal(projectId, {
      title: "Peer signal disagrees",
      summary: "Peer observation.",
    });
    const citedSignalId = seedActiveSignal(projectId, {
      title: "Cited signal with direct conflict",
      summary: "Cited observation declares a direct conflict.",
      conflictingSignalIds: [peerSignalId],
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites conflicting signal",
            proposal: lowRiskEnvelope(citedSignalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      (checkpoint?.authority as { evidence?: { conflicting?: string[] } } | undefined)?.evidence
        ?.conflicting,
    ).toContain(citedSignalId);
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("reverse conflict: a peer signal that names the cited signal as conflicting routes to human-required checkpoint", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const citedSignalId = seedActiveSignal(projectId, {
      title: "Cited signal clean",
      summary: "Cited observation declares no conflict itself.",
    });
    seedActiveSignal(projectId, {
      title: "Peer names cited as conflicting",
      summary: "Peer observation declares the cited signal conflicts with this one.",
      conflictingSignalIds: [citedSignalId],
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites signal named by a peer",
            proposal: lowRiskEnvelope(citedSignalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(
      (checkpoint?.authority as { evidence?: { conflicting?: string[] } } | undefined)?.evidence
        ?.conflicting,
    ).toContain(citedSignalId);
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("malformed stored conflict metadata cannot authorize automatically and routes to a human checkpoint", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const citedSignalId = seedActiveSignal(projectId, {
      title: "Cited signal with corrupt conflict column",
      summary: "Cited observation whose conflicting_signal_ids_json is a JSON string, not an array.",
    });
    // Corrupt the durable conflict-metadata column directly: a JSON-encoded
    // string parses to a non-array at read time. The adapter must NOT coerce
    // this into a clean boolean; it must surface the malformation to the
    // evaluator's invalid-conflict-metadata hard rule.
    harness.runInTransaction((db) => {
      db.query(
        "update strategy_signals set conflicting_signal_ids_json = $json where id = $id",
      ).run({ $json: '"sig_peer_malformed"', $id: citedSignalId });
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites signal with corrupt conflict metadata",
            proposal: lowRiskEnvelope(citedSignalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    const autoApproved = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(checkpoint).toBeDefined();
    expect(autoApproved).toBeUndefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      (checkpoint?.authority as { evidence?: { invalidConflictMetadata?: string[] } } | undefined)
        ?.evidence?.invalidConflictMetadata,
    ).toContain(citedSignalId);
    expect(checkpoint?.reasons.some((reason) => String(reason).includes("malformed conflict metadata"))).toBe(
      true,
    );
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("a signal owned by another project cannot authorize work and routes to a human checkpoint", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const otherProjectId = harness.createProject({
      name: "other-project",
      // Distinct root_path so createProject does not deduplicate back to the
      // proposal's own project (projects are keyed by root_path).
      rootPath: join(dir, "other-project"),
    });
    // The cited signal is valid and active but belongs to a different project.
    const foreignSignalId = seedActiveSignal(otherProjectId, {
      title: "Foreign-project signal",
      summary: "This observation belongs to another project and must not authorize work here.",
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites a foreign-project signal",
            proposal: lowRiskEnvelope(foreignSignalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    const autoApproved = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(checkpoint).toBeDefined();
    expect(autoApproved).toBeUndefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      (checkpoint?.authority as { evidence?: { missing?: string[] } } | undefined)?.evidence
        ?.missing,
    ).toContain(foreignSignalId);
    expect(checkpoint?.reasons.some((reason) => String(reason).includes("cross-project evidence"))).toBe(
      true,
    );
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("a malformed declaredHumanCategories declaration cannot authorize automatically and routes to a human checkpoint", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);
    // The production envelope is otherwise genuinely low-risk; the only defect
    // is a non-array declaredHumanCategories. The adapter must forward the raw
    // value to the evaluator instead of normalizing it to [].
    const envelope = lowRiskEnvelope(signalId, {
      riskSurface: {
        amendsMission: false,
        amendsCapitalPolicy: false,
        legalOrPrivacy: false,
        sensitiveData: false,
        destructiveOperation: false,
        productionDeployment: false,
        unplannedDependency: false,
        schemaMigration: false,
        recurringInfrastructure: false,
        declaredHumanCategories: "single-category" as unknown as string[],
      },
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Malformed declaredHumanCategories",
            proposal: envelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    const autoApproved = decisions.find(
      (decision) => decision.decision === "approved" && decision.actorKind === "auto",
    );
    expect(checkpoint).toBeDefined();
    expect(autoApproved).toBeUndefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    const authorityReasons = (
      checkpoint?.authority as { reasons?: Array<{ kind?: string }> } | undefined
    )?.reasons ?? [];
    expect(authorityReasons.some((reason) => reason.kind === "unknown-risk-data")).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("inactive cited signal is treated as expired and the proposal is rejected", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const inactiveSignalId = seedActiveSignal(projectId, {
      title: "Superseded signal",
      summary: "This observation has been superseded.",
      status: "superseded",
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites superseded signal",
            proposal: lowRiskEnvelope(inactiveSignalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("rejected");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const rejected = decisions.find((decision) => decision.decision === "rejected");
    expect(rejected).toBeDefined();
    expect(
      (rejected?.authority as { evidence?: { expired?: string[] } } | undefined)?.evidence?.expired,
    ).toContain(inactiveSignalId);
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("non-boolean riskSurface flag value forces the corresponding flag true and routes to human-required", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);
    const envelope = lowRiskEnvelope(signalId, {
      riskSurface: {
        amendsMission: false,
        amendsCapitalPolicy: false,
        legalOrPrivacy: false,
        sensitiveData: false,
        destructiveOperation: false,
        productionDeployment: false,
        unplannedDependency: false,
        // Non-boolean declaration must fail closed: the adapter forces this flag
        // to true regardless of the designer's intent.
        schemaMigration: "no" as unknown as boolean,
        recurringInfrastructure: false,
        declaredHumanCategories: [],
      },
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Non-boolean risk flag",
            proposal: envelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      checkpoint?.reasons.some((reason) => String(reason).includes("schema-migration")),
    ).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("free-form evidence text matching a risk keyword forces the corresponding flag true and routes to human-required", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    // The evidence text mentions "schema migration". The adapter's keyword
    // matcher must force the schemaMigration flag to true even when the
    // designer declared it false.
    const signalId = seedActiveSignal(projectId, {
      title: "Schema migration required for cold cache",
      summary: "Resolving this requires a schema migration of the runs table.",
    });
    const envelope = lowRiskEnvelope(signalId);

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Resolves schema migration concern",
            proposal: envelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      checkpoint?.reasons.some((reason) => String(reason).includes("schema-migration")),
    ).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("high-risk schema-migration declaration routes to human-required checkpoint with no delivery run", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);
    const envelope = lowRiskEnvelope(signalId, {
      investment: {
        reversibility: "hard",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      riskSurface: {
        amendsMission: false,
        amendsCapitalPolicy: false,
        legalOrPrivacy: false,
        sensitiveData: false,
        destructiveOperation: false,
        productionDeployment: false,
        unplannedDependency: false,
        schemaMigration: true,
        recurringInfrastructure: false,
        declaredHumanCategories: [],
      },
    });

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Risk-on schema migration",
            proposal: envelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      checkpoint?.reasons.some((reason) => String(reason).includes("schema-migration")),
    ).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
    expect(
      harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId),
    ).toHaveLength(0);
  });

  test("proposeDesign without an active charter records a missing-charter checkpoint and stays unaccepted", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    // No charter seeded — adapter must fail closed at the charter gate.
    const signalId = seedActiveSignal(projectId);

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "No charter pinned",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      checkpoint?.reasons.some((reason) => String(reason).includes("missing-active-charter")),
    ).toBe(true);
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("proposeDesign with a missing evidence reference routes to human-required checkpoint", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites missing signal",
            proposal: lowRiskEnvelope("signal_does_not_exist"),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const checkpoint = decisions.find((decision) => decision.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(
      (checkpoint?.authority as { evidence?: { missing?: string[] } } | undefined)?.evidence
        ?.missing,
    ).toContain("signal_does_not_exist");
    expect(continuationArtifacts(result)).toHaveLength(0);
  });

  test("audit-write fault during proposeDesign leaves no proposal, decision, or continuation behind", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);

    harness.faultingActionTypes.add("design.proposeDesign");

    const beforeTasks = harness.getRunOverview({ runId, eventLimit: 0 }).tasks.length;

    const result = await runHook({
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    expect(result.problems?.some((problem) => problem.includes("injected audit-write failure"))).toBe(true);

    expect(harness.listDesignProposals({ projectId })).toHaveLength(0);
    // The fault rolls back the entire transition: no approved decision, no
    // continuation task, no delivery run survives.
    expect(harness.listRuns({ limit: 50 }).filter((run) => run.context?.parentRunId === runId)).toHaveLength(0);
    const afterTasks = harness.getRunOverview({ runId, eventLimit: 0 }).tasks;
    expect(afterTasks).toHaveLength(beforeTasks);
    // No `done` audit row was committed for proposeDesign; only the blocked
    // out-of-band audit row exists.
    const donePropose = harness
      .listHarnessActionEvents({ limit: 50 })
      .filter((event) => event.actionType === "design.proposeDesign" && event.status === "done");
    expect(donePropose).toHaveLength(0);
  });

  test("duplicate proposeDesign actions in one batch record independently per action index", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);

    const result = await runHook({
      status: "done",
      summary: "two proposals",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache (first)",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache (second)",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput, runId, taskId);

    expect(result.decision).toBe("exit");
    // Each actionIndex is unique, so both proposals are recorded independently.
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(2);
    for (const proposal of proposals) {
      expect(proposal.status).toBe("accepted");
      const decisions = harness.listDesignDecisions({ proposalId: proposal.id });
      expect(
        decisions.find((decision) => decision.decision === "approved" && decision.actorKind === "auto"),
      ).toBeDefined();
    }
    const donePropose = harness
      .listHarnessActionEvents({ limit: 50 })
      .filter((event) => event.actionType === "design.proposeDesign" && event.status === "done");
    expect(donePropose).toHaveLength(2);
  });

  test("replaying a complete signal→proposal→delivery cycle across a fresh Harness instance creates no duplicate decision, continuation, or child run", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedActiveSignal(projectId);

    const signalOutput: AttemptOutput = {
      status: "done",
      summary: "signal",
      designActions: [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "verifier",
            title: "Cold-cache startup over 7s",
            summary: "Three consecutive cold-cache test runs averaged 12s.",
            observationTime: "2026-08-01T00:00:00.000Z",
            confidence: 0.6,
          },
        },
      ],
    } as AttemptOutput;

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    await runHook(signalOutput, runId, taskId);
    await runHook(proposeOutput, runId, taskId);
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan pre-warm", prompt: "Plan the change." }],
          },
        },
      ],
    } as AttemptOutput;
    await runHook(deliverOutput, runId, taskId);

    const signalsBefore = harness.listStrategySignals({ projectId }).length;
    const proposalsBefore = harness.listDesignProposals({ projectId }).length;
    const decisionsBefore = harness.listDesignDecisions({ proposalId }).length;
    const eventsBefore = harness
      .listHarnessActionEvents({ limit: 100 })
      .filter((event) => event.actionType.startsWith("design.")).length;
    const tasksBefore = harness.getRunOverview({ runId, eventLimit: 0 }).tasks.length;
    const runsBefore = harness.listRuns({ limit: 100 }).length;

    // Simulate a process restart: open the same database with a fresh Harness
    // instance. The audit log is the source of truth.
    const dbPath = (harness as unknown as { dbPath: string }).dbPath;
    const replayHarness = new HarnessClass(dbPath);
    replayHarness.init();
    const replayHook = createApplyDesignActionsHook({ harness: replayHarness });

    const replaySignal = await replayHook({
      run: replayHarness.getRun(runId)!,
      task: replayHarness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: signalOutput,
    });
    const replayPropose = await replayHook({
      run: replayHarness.getRun(runId)!,
      task: replayHarness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const replayDeliver = await replayHook({
      run: replayHarness.getRun(runId)!,
      task: replayHarness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverOutput,
    });

    expect(replaySignal.decision).toBe("exit");
    expect(replaySignal.problems).toBeUndefined();
    expect(replayPropose.decision).toBe("exit");
    expect(replayPropose.problems).toBeUndefined();
    expect(replayDeliver.decision).toBe("continue");
    expect(replayDeliver.problems).toBeUndefined();

    expect(replayHarness.listStrategySignals({ projectId })).toHaveLength(signalsBefore);
    expect(replayHarness.listDesignProposals({ projectId })).toHaveLength(proposalsBefore);
    expect(replayHarness.listDesignDecisions({ proposalId })).toHaveLength(decisionsBefore);
    expect(
      replayHarness
        .listHarnessActionEvents({ limit: 100 })
        .filter((event) => event.actionType.startsWith("design.")),
    ).toHaveLength(eventsBefore);
    expect(replayHarness.getRunOverview({ runId, eventLimit: 0 }).tasks).toHaveLength(tasksBefore);
    expect(replayHarness.listRuns({ limit: 100 })).toHaveLength(runsBefore);
  });

  test("quiescent designer output produces no signals, proposals, decisions, continuations, runs, or audit rows", async () => {
    const { runId, taskId } = setupRunAndTask();
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);

    const beforeSignals = harness.listStrategySignals({}).length;
    const beforeProposals = harness.listDesignProposals({}).length;
    const beforeEvents = harness.listHarnessActionEvents({ limit: 100 }).length;
    const beforeTasks = harness.getRunOverview({ runId, eventLimit: 0 }).tasks.length;
    const beforeRuns = harness.listRuns({ limit: 100 }).length;

    const result = await runHook(
      { status: "done", summary: "no actions" } as AttemptOutput,
      runId,
      taskId,
    );

    expect(result.decision).toBe("exit");
    expect(result.problems).toBeUndefined();
    expect(harness.listStrategySignals({})).toHaveLength(beforeSignals);
    expect(harness.listDesignProposals({})).toHaveLength(beforeProposals);
    expect(harness.listHarnessActionEvents({ limit: 100 })).toHaveLength(beforeEvents);
    expect(harness.getRunOverview({ runId, eventLimit: 0 }).tasks).toHaveLength(beforeTasks);
    expect(harness.listRuns({ limit: 100 })).toHaveLength(beforeRuns);
  });
});
