import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { acceptGuardrailProposal, Harness, type AttemptOutput } from "../packages/harness/src";
import { consumeLinearInbox } from "../packages/cli/src/linear-intake";
import { ingestLinearEvent } from "../packages/cli/src/linear";
import {
  buildTaskPrompt,
  createApplyDesignActionsHook,
  createRunsAction,
  createRunsFromDesignAction,
  createCollectSubsessionsHook,
  createContextSummaryHook,
  createGitWorktreeHook,
  createGoalReviewDecisionHook,
  createRefreshGuardrailProposalsHook,
  createRepairTaskHook,
  createRouteExecutor,
  createRunsFromOutputHook,
  createTasksAction,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  decideDesignAction,
  doneOutput,
  parseAttemptOutput,
  proposeDesignAction,
  recordDesignOutcomeAction,
  recordSignalAction,
  reconcileDeferredDesignAuthority,
  resolveAgentBackend,
  resolveExecutionRoute,
  resolveModelPreference,
  runCodexResumableLoop,
  resumeCodexResumableAttempt,
  runNextReadyTask,
  runReadyTasks,
  setRunDecisionAction,
  superviseCodexRuns,
  runUntilIdle,
} from "../packages/runner/src";

function requiredOutputExample(prompt: string): Record<string, unknown> {
  const section = prompt.split("## Required Output")[1];
  if (!section) {
    throw new Error("prompt is missing Required Output");
  }
  const match = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!match) {
    throw new Error("Required Output is missing a JSON example");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function frozenLinearGateSection(prompt: string): string {
  const marker = "## Frozen Linear Implementation Gate";
  const start = prompt.lastIndexOf(marker);
  if (start < 0) {
    throw new Error("prompt is missing Frozen Linear Implementation Gate");
  }
  return prompt.slice(start).split("## Required Output")[0]!;
}

const FROZEN_LINEAR_SCOPE = {
  issueId: "6ad2b245-497b-4e7c-a83d-8d0b4088f3f7",
  identifier: "PAN-1244",
  teamKey: "PAN",
  state: "In Progress",
  stateId: "100f8cf5-f7e3-4297-862c-b2b0b922afc3",
} as const;

function matchingLinearDelivery(overrides: Record<string, unknown> = {}) {
  return {
    ...FROZEN_LINEAR_SCOPE,
    statusOutcome: "verified",
    statusVerifiedBy: "independent_readback",
    ...overrides,
  };
}

function matchingSupervisorEvidence(input: {
  observedAt?: string;
  linear?: Record<string, unknown>;
} = {}) {
  return {
    version: 1,
    observedAt: input.observedAt ?? new Date(Date.now() - 60_000).toISOString(),
    linear: {
      ...FROZEN_LINEAR_SCOPE,
      outcome: "verified",
      verifiedBy: "independent_readback",
      ...input.linear,
    },
    git: {
      hodor: {
        repository: "PanCatAI/hodor",
        mainSha: "695de55263dde70dd12c8142576e6d3b258163f2",
        targetRef: "refs/heads/codex/pan-1244-deterministic-contract-mainline",
        targetRefExists: false,
        verifiedBy: "git ls-remote",
      },
    },
    guardrails: { finalRemoteReadbackStillRequired: true },
  };
}

function buildFrozenLinearPrompt(
  harness: Harness,
  input: {
    role?: string;
    linearDelivery?: Record<string, unknown> | null;
    supervisorEvidence?: Record<string, unknown> | null;
    taskContract?: Record<string, unknown> | null;
    context?: Record<string, unknown>;
    template?: string;
  } = {},
) {
  const linearDelivery = input.linearDelivery === undefined ? matchingLinearDelivery() : input.linearDelivery;
  const supervisorEvidence = input.supervisorEvidence === undefined
    ? matchingSupervisorEvidence()
    : input.supervisorEvidence;
  const runId = harness.createRun({
    goal: "Exercise the frozen Linear implementation gate",
    context: {
      ...input.context,
      ...(linearDelivery ? { linearDelivery } : {}),
      ...(supervisorEvidence ? { externalSupervisorEvidence: supervisorEvidence } : {}),
    },
  });
  const taskId = harness.createTask({
    runId,
    role: input.role ?? "worker",
    goal: "Begin local implementation",
    prompt: "Implement locally while preserving final delivery verification.",
    ...(input.taskContract ? { config: { linearDelivery: input.taskContract } } : {}),
  });
  return buildTaskPrompt({
    run: harness.getRun(runId)!,
    task: harness.getTask(taskId)!,
    dependencyAttempts: [],
    ...(input.template ? { template: input.template } : {}),
  });
}

describe("runner", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-runner-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("builds an execution prompt from run and task state", () => {
    const runId = harness.createRun({
      goal: "Use Ouroboros to iterate on Ouroboros",
      context: { repo: "/Users/ghostcorn/dev/ouroboros" },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan the next task",
      prompt: "Read current state and propose one small task.",
      doneWhen: ["a next task exists", "the task is small"],
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
    });

    expect(prompt).toContain("Use Ouroboros to iterate on Ouroboros");
    expect(prompt).toContain("Role: planner");
    expect(prompt).toContain("Plan the next task");
    expect(prompt).toContain("Read current state and propose one small task.");
    expect(prompt).toContain('"status": "done"');
    expect(prompt).toContain('"actions"');
    expect(prompt).toContain('"createTasks"');
    expect(prompt).toContain("a next task exists");
    expect(prompt).toContain("## Runtime File Guardrail");
    expect(prompt).toContain("Do not modify, delete, recreate, clean, commit, or report these paths as task changedFiles.");
  });

  test("builds prompts with run lessons", () => {
    const runId = harness.createRun({
      goal: "Use Ouroboros to iterate on Ouroboros",
      context: { repo: "/Users/ghostcorn/dev/ouroboros" },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use lessons",
      prompt: "Apply prior lessons.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons: [
        {
          id: "lesson_1",
          runId,
          taskId: "task_success",
          attemptId: "attempt_success",
          kind: "experience",
          summary: "Use output-last-message for Codex final JSON.",
          evidence: { checks: [{ name: "bun test", status: "passed" }] },
        },
        {
          id: "lesson_2",
          runId,
          taskId: "task_failed",
          attemptId: "attempt_failed",
          kind: "lesson",
          summary: "Do not run full CLI tests inside an isolated worktree without workspace links.",
          evidence: { problems: ["package resolution failed"] },
        },
      ],
    });

    expect(prompt).toContain("## Run Lessons");
    expect(prompt).toContain("experience");
    expect(prompt).toContain("Use output-last-message");
    expect(prompt).toContain("lesson");
    expect(prompt).toContain("isolated worktree");
  });

  test("builds prompts with active role-scoped guardrails from run context", () => {
    const runId = harness.createRun({
      goal: "Use durable guardrails",
      context: {
        guardrails: [
          {
            id: "guardrail_worker_db_actions",
            role: "worker",
            summary: "Workers must request fixed HarnessAction payloads instead of writing the root database.",
            source: "lesson",
          },
          {
            id: "guardrail_verifier_evidence",
            roles: ["verifier", "goal-review"],
            summary: "Verifier decisions must cite repository, command, and harness evidence.",
            source: "lesson",
          },
          {
            id: "guardrail_disabled",
            role: "worker",
            summary: "Disabled guardrails stay out of prompts.",
            active: false,
          },
        ],
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Apply active guardrails",
      prompt: "Use active guardrails before editing.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
    });

    const activeGuardrailsSection = prompt.split("## Active Guardrails")[1]!
      .split("## Candidate Guardrails")[0]!
      .split("## Reusable Experience Evidence")[0]!
      .split("## Required Output")[0]!;

    expect(prompt).toContain("## Active Guardrails");
    expect(activeGuardrailsSection).toContain("guardrail_worker_db_actions");
    expect(activeGuardrailsSection).toContain("Workers must request fixed HarnessAction payloads");
    expect(activeGuardrailsSection).not.toContain("guardrail_verifier_evidence");
    expect(activeGuardrailsSection).not.toContain("Disabled guardrails");
  });

  test("fresh matching independent Linear readback lets planners and workers start local implementation without repeating network preflight", () => {
    for (const role of ["planner", "worker"]) {
      const gate = frozenLinearGateSection(buildFrozenLinearPrompt(harness, { role }));
      expect(gate).toContain("SATISFIED");
      expect(gate).toContain(FROZEN_LINEAR_SCOPE.issueId);
      expect(gate).toContain(FROZEN_LINEAR_SCOPE.stateId);
      expect(gate).toContain("Do not repeat Linear or GitHub OAuth/network preflight before starting local implementation");
      expect(gate).toContain("final Linear evidence comment");
      expect(gate).toContain("Linear Done state");
      expect(gate).toContain("Git remote SHA");
      expect(gate).toContain("independent readback");
    }
  });

  test("a verified linearDelivery block can satisfy the matching task-local contract", () => {
    const gate = frozenLinearGateSection(buildFrozenLinearPrompt(harness, {
      linearDelivery: matchingLinearDelivery({ observedAt: new Date(Date.now() - 60_000).toISOString() }),
      supervisorEvidence: null,
      taskContract: FROZEN_LINEAR_SCOPE,
    }));
    expect(gate).toContain("SATISFIED");
  });

  test("frozen Linear implementation guidance cannot be omitted by a custom task prompt template", () => {
    const prompt = buildFrozenLinearPrompt(harness, {
      context: { note: "## Frozen Linear Implementation Gate is only a label here" },
      template: "# Custom Prompt\nGoal={{taskGoal}}\nContext={{runContextJson}}",
    });
    expect(prompt).toContain("# Custom Prompt");
    expect(frozenLinearGateSection(prompt)).toContain("SATISFIED");
  });

  test("stale frozen Linear readback fails closed for local implementation", () => {
    const gate = frozenLinearGateSection(buildFrozenLinearPrompt(harness, {
      supervisorEvidence: matchingSupervisorEvidence({ observedAt: "2020-01-01T00:00:00.000Z" }),
    }));
    expect(gate).toContain("NOT SATISFIED");
    expect(gate).toContain("expired");
    expect(gate).toContain("Fail closed");
    expect(gate).not.toContain("Do not repeat Linear or GitHub OAuth/network preflight before starting local implementation");
  });

  test("mismatched frozen Linear scope fails closed for issue team and state differences", () => {
    for (const mismatch of [
      { field: "issueId", value: "7bd2b245-497b-4e7c-a83d-8d0b4088f3f7" },
      { field: "identifier", value: "PAN-9999" },
      { field: "teamKey", value: "OTHER" },
      { field: "state", value: "Backlog" },
      { field: "stateId", value: "200f8cf5-f7e3-4297-862c-b2b0b922afc3" },
    ] as const) {
      const gate = frozenLinearGateSection(buildFrozenLinearPrompt(harness, {
        role: "planner",
        supervisorEvidence: matchingSupervisorEvidence({ linear: { [mismatch.field]: mismatch.value } }),
      }));
      expect(gate).toContain("NOT SATISFIED");
      expect(gate).toContain(mismatch.field);
      expect(gate).toContain("Fail closed");
    }
  });

  test("unverified or unsuccessful frozen Linear evidence fails closed", () => {
    for (const mismatch of [
      { field: "verifiedBy", value: "agent_report" },
      { field: "outcome", value: "failed" },
    ] as const) {
      const gate = frozenLinearGateSection(buildFrozenLinearPrompt(harness, {
        supervisorEvidence: matchingSupervisorEvidence({ linear: { [mismatch.field]: mismatch.value } }),
      }));
      expect(gate).toContain("NOT SATISFIED");
      expect(gate).toContain(mismatch.field);
      expect(gate).toContain("Fail closed");
    }
  });

  test("unrelated external supervisor evidence does not create a Linear implementation gate", () => {
    const prompt = buildFrozenLinearPrompt(harness, {
      linearDelivery: null,
      supervisorEvidence: { version: 1, git: { repository: "neeboo/example", sha: "a".repeat(40) } },
    });
    expect(prompt).not.toContain("## Frozen Linear Implementation Gate");
  });

  test("builds prompts with compact recent lessons", () => {
    const runId = harness.createRun({ goal: "Use Ouroboros to iterate on Ouroboros" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use compact lessons",
      prompt: "Apply prior lessons without loading raw evidence.",
    });
    const lessons = Array.from({ length: 14 }, (_value, index) => ({
      id: `lesson_${index}`,
      runId,
      taskId: `task_${index}`,
      attemptId: `attempt_${index}`,
      kind: "lesson" as const,
      summary: `lesson summary ${index}`,
      evidence: { raw: `large raw evidence ${index}` },
    }));

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons,
    });

    expect(prompt).not.toContain("lesson summary 0");
    expect(prompt).toContain("lesson summary 13");
    expect(prompt).not.toContain("large raw evidence");
  });

  test("derives repeated failure lessons as prompt-only candidate guardrails", () => {
    const runId = harness.createRun({ goal: "Use lessons as guardrails" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Apply repeated failure context",
      prompt: "Use repeated lessons before implementing.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons: [
        {
          id: "lesson_1",
          runId,
          taskId: "task_a",
          attemptId: "attempt_a",
          kind: "lesson",
          summary: "Running attempt is missing codexSessionId; task was returned to todo for a fresh attempt",
          evidence: {},
        },
        {
          id: "lesson_2",
          runId,
          taskId: "task_b",
          attemptId: "attempt_b",
          kind: "lesson",
          summary: "running attempt is missing codexSessionId; task was returned to todo for a fresh attempt.",
          evidence: {},
        },
      ],
    });

    expect(prompt).toContain("## Candidate Guardrails");
    expect(prompt).toContain("Candidate guardrail guidance");
    expect(prompt).toContain("Seen 2 times");
    expect(prompt).toContain("running attempt is missing codexSessionId");
  });

  test("keeps one-off failure lessons raw without candidate guardrail sections", () => {
    const runId = harness.createRun({ goal: "Keep single failures raw" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use raw lessons carefully",
      prompt: "Do not promote one-off failures.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons: [
        {
          id: "lesson_1",
          runId,
          taskId: "task_failed",
          attemptId: "attempt_failed",
          kind: "lesson",
          summary: "Single verifier failure should remain raw until it repeats.",
          evidence: {},
        },
      ],
    });

    const rawLessonsSection = prompt.split("## Run Lessons")[1]!
      .split("## Candidate Guardrails")[0]!
      .split("## Reusable Experience Evidence")[0]!
      .split("## Required Output")[0]!;

    expect(prompt).not.toContain("## Candidate Guardrails");
    expect(prompt).not.toContain("## Reusable Experience Evidence");
    expect(rawLessonsSection).toContain("Single verifier failure should remain raw until it repeats.");
  });

  test("renders successful experiences as reusable evidence instead of guardrails", () => {
    const runId = harness.createRun({ goal: "Use experiences as evidence" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Apply successful procedures",
      prompt: "Use reusable experience evidence.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons: [
        {
          id: "experience_1",
          runId,
          taskId: "task_success",
          attemptId: "attempt_success",
          kind: "experience",
          summary: "Ran bun test tests/dashboard.test.ts after keyed DOM patching and confirmed dashboard checks pass.",
          evidence: {},
        },
        {
          id: "lesson_1",
          runId,
          taskId: "task_failed",
          attemptId: "attempt_failed",
          kind: "lesson",
          summary: "Single failure should stay in raw lessons only.",
          evidence: {},
        },
      ],
    });

    expect(prompt).toContain("## Reusable Experience Evidence");
    expect(prompt).toContain("Ran bun test tests/dashboard.test.ts");
    const experienceSection = prompt.split("## Reusable Experience Evidence")[1]!.split("## Run Lessons")[0]!;
    expect(prompt).not.toContain("## Candidate Guardrails");
    expect(experienceSection).not.toContain("Single failure should stay in raw lessons only");
  });

  test("keeps backward-compatible Run Lessons JSON with prompt-only candidate sections", () => {
    const runId = harness.createRun({ goal: "Keep raw lessons compatible" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Render raw and promoted lessons",
      prompt: "Use prompt context.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
      lessons: [
        {
          id: "lesson_1",
          runId,
          taskId: "task_a",
          attemptId: "attempt_a",
          kind: "lesson",
          summary: "Repeated failure summary",
          evidence: {},
        },
        {
          id: "lesson_2",
          runId,
          taskId: "task_b",
          attemptId: "attempt_b",
          kind: "lesson",
          summary: "Repeated failure summary",
          evidence: {},
        },
      ],
    });

    const rawLessonsSection = prompt.split("## Run Lessons")[1]!
      .split("## Candidate Guardrails")[0]!
      .split("## Reusable Experience Evidence")[0]!
      .split("## Required Output")[0]!;
    expect(rawLessonsSection).toContain('"kind": "lesson"');
    expect(rawLessonsSection).toContain('"summary": "Repeated failure summary"');
    expect(rawLessonsSection).toContain('"taskId": "task_a"');
    expect(rawLessonsSection).toContain('"attemptId": "attempt_a"');
    expect(rawLessonsSection).not.toContain("Candidate guardrail guidance");
    expect(rawLessonsSection).not.toContain("candidateGuardrail");
  });

  test("builds designer prompts that advertise the five fixed design actions", () => {
    const runId = harness.createRun({
      goal: "Designer drives the autonomous strategy loop",
      context: {
        founderCharterId: "charter_default",
        designCharterId: "charter_default",
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "Decide whether to propose, accept, or stay quiescent",
      prompt: "Read the active charter and signals before proposing.",
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
    });

    const requiredOutput = prompt.split("## Required Output")[1]!;
    expect(requiredOutput).toContain("recordSignal");
    expect(requiredOutput).toContain("proposeDesign");
    expect(requiredOutput).toContain("decideDesign");
    expect(requiredOutput).toContain("recordDesignOutcome");
    expect(requiredOutput).toContain("createRunsFromDesign");
  });

  test("builds a Designer proposeDesign example that matches the fixed action parser contract", () => {
    const runId = harness.createRun({ goal: "Designer proposes a bounded change" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "Propose one evidence-backed design",
      prompt: "Use the frozen action contract.",
    });
    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
    });

    expect(prompt).toContain("The JSON example below is role-specific");
    expect(prompt).not.toContain(
      "Supported action types are createTasks, createRuns, and setRunDecision",
    );
    const output = parseAttemptOutput(JSON.stringify(requiredOutputExample(prompt)));
    const proposalAction = output.designActions?.find((action) => action.type === "proposeDesign");
    expect(proposalAction).toBeDefined();
    const proposal = proposalAction?.payload.proposal as Record<string, unknown>;
    const option = (proposal.options as Array<Record<string, unknown>>)[0];
    const experiment = proposal.experiment as Record<string, unknown>;

    expect(proposal.options).toBeArray();
    expect(proposal.options).not.toHaveLength(0);
    expect(option.benefits).toBeArray();
    expect(option.costs).toBeArray();
    expect(option.risks).toBeArray();
    expect(option.lockIn).toBeArray();
    expect(experiment.rollback).toBeString();
    expect(proposal).toMatchObject({
      additions: expect.any(Array),
      removals: expect.any(Array),
      targetOutcome: expect.any(String),
      assumptions: expect.any(Array),
      uncertainty: expect.any(Array),
      evaluationContract: {
        baseline: expect.any(Array),
        successMetrics: expect.any(Array),
        guardMetrics: expect.any(Array),
        requiredEvidence: expect.any(Array),
        reviewAt: expect.any(String),
      },
      investment: {
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: expect.any(String),
      },
    });
  });

  test("resolveModelPreference uses designer role defaults from run context", () => {
    const runId = harness.createRun({
      goal: "Designer defaults flow through role preference",
      context: {
        modelDefaults: {
          global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
          roles: {
            designer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
            worker: { model: "gpt-5.6-luna", reasoning_effort: "high" },
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "Designer role resolves to configured defaults",
      prompt: "Resolve designer model preference.",
    });

    const preference = resolveModelPreference({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
    });

    expect(preference).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source: "role-default",
      role: "designer",
    });
  });

  test("runs the next ready task with an executor and records the attempt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async ({ prompt, task }) => ({
        status: "done",
        summary: `Executed ${task.id}`,
        artifacts: [{ kind: "prompt", chars: prompt.length }],
        checks: [{ name: "fake executor", status: "passed" }],
        problems: [],
      }),
    });

    expect(result?.taskId).toBe(taskId);
    expect(result?.attemptId).toBeString();
    expect(harness.getTask(taskId)?.status).toBe("done");
    expect(harness.getAttempt(result!.attemptId)?.output.summary).toBe(`Executed ${taskId}`);
  });

  test("runner injects recorded lessons into the next task prompt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "worker",
      goal: "Learn",
      prompt: "Create a lesson.",
    });
    harness.recordAttempt({
      taskId: first,
      input: {},
      output: {
        status: "blocked",
        summary: "Verifier failed",
        problems: ["worktree lacks linked workspace packages"],
      },
    });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Use lesson",
      prompt: "Use prior lesson.",
    });

    const prompts: string[] = [];
    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async ({ prompt }) => {
        prompts.push(prompt);
        return {
          status: "done",
          summary: "Used lesson",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(prompts[0]).toContain("## Run Lessons");
    expect(prompts[0]).toContain("worktree lacks linked workspace packages");
  });

  test("runner injects latest direct dependency attempts into the task prompt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const upstream = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement prompt templates",
      prompt: "Store prompts in the database.",
    });
    const olderAttempt = harness.recordAttempt({
      taskId: upstream,
      input: {},
      output: {
        status: "done",
        summary: "Older implementation attempt",
        checks: [{ name: "bun test", status: "failed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.recordAttempt({
      taskId: upstream,
      input: {},
      output: {
        status: "done",
        summary: "Prompt templates stored in SQLite",
        changedFiles: ["packages/harness/src/harness.ts"],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [{ kind: "commit", sha: "b8bf39b" }],
        problems: [],
      },
    });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify prompt templates",
      prompt: "Verify the upstream implementation.",
      dependsOn: [upstream],
    });

    const prompts: string[] = [];
    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async ({ prompt }) => {
        prompts.push(prompt);
        return {
          status: "done",
          summary: "Verified dependency context",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    const dependencySection = prompts[0].split("## Dependency Attempts")[1]!.split("## Run Lessons")[0]!;
    expect(dependencySection).toContain(upstream);
    expect(dependencySection).toContain("Prompt templates stored in SQLite");
    expect(dependencySection).toContain("packages/harness/src/harness.ts");
    expect(dependencySection).toContain('"name": "bun test"');
    expect(dependencySection).toContain('"status": "passed"');
    expect(dependencySection).not.toContain(olderAttempt);
    expect(dependencySection).not.toContain("Older implementation attempt");
  });

  test("runner-owned codex loop starts ready resumable tasks and preserves inert model metadata", async () => {
    const runId = harness.createRun({
      goal: "Build loop",
      context: {
        modelDefaults: {
          roles: {
            worker: {
              model: "gpt-5-mini",
              reason: "cheap worker",
              provider: "openai",
              profile: "fast",
              base_url: "https://api.example.test/v1",
              env_key: "OPENAI_API_KEY",
            },
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });
    const clientModels: Array<string | undefined> = [];

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      clientFactory: ({ model }) => {
        clientModels.push(model);
        return {
          start: async () => ({
            status: "done" as const,
            sessionId: "session_runner",
            outputPath: join(dir, "output.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              summary: "Implemented runner",
              changedFiles: [],
              checks: [],
              artifacts: [],
              problems: [],
            },
          }),
          resume: async () => {
            throw new Error("resume should not be called");
          },
        };
      },
    });

    const attemptId = result.rounds[0].tasks[0].attemptId;
    const attempt = harness.getAttempt(attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId,
      status: "done",
      codexSessionId: "session_runner",
    });
    expect(clientModels).toEqual(["gpt-5-mini"]);
    expect(attempt.input.model).toMatchObject({
      model: "gpt-5-mini",
      reason: "cheap worker",
      provider: "openai",
      profile: "fast",
      base_url: "https://api.example.test/v1",
      env_key: "OPENAI_API_KEY",
    });
    expect(attempt.output.artifacts).toContainEqual({ kind: "codex_session", sessionId: "session_runner" });
  });

  test("runner-owned goal review applies the browser process deny policy", async () => {
    const runId = harness.createRun({ goal: "Review without browser side effects" });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Use existing evidence only.",
    });
    const commands: string[][] = [];

    await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      codexOptions: {
        codexBin: "/custom/codex",
        runCommand: async ({ cmd }) => {
          commands.push(cmd);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "agent.message",
              message: '{"status":"done","runDecision":"defer","summary":"cost approval required","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
            }),
            stderr: "",
          };
        },
      },
    });

    if (process.platform === "darwin") {
      expect(commands[0]?.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
      expect(commands[0]?.[2]).toContain("Google Chrome");
    } else {
      expect(commands[0]?.[0]).toBe("/custom/codex");
    }
  });

  test("runner-owned codex loop blocks running starts that have no resumable session id", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      clientFactory: () => ({
        start: async () => ({
          status: "running" as const,
          sessionId: null,
          outputPath: join(dir, "output.json"),
          stdout: "{\"type\":\"item.started\"}\n",
          stderr: "",
          events: [{ type: "item.started" }],
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const attemptId = result.rounds[0].tasks[0].attemptId;
    const attempt = harness.getAttempt(attemptId)!;
    const task = harness.getTask(taskId)!;
    const thread = harness.getRunOverview({ runId, eventLimit: 1 }).sessions.find((session) => session.attemptId === attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId,
      status: "blocked",
      codexSessionId: null,
    });
    expect(attempt.status).toBe("blocked");
    expect(attempt.output.summary).toContain("without an agent session id");
    expect(task.status).toBe("blocked");
    expect(thread.status).toBe("blocked");
  });

  test("runner-owned codex loop recovers a streamed session id before the start command returns", async () => {
    const runId = harness.createRun({ goal: "Recover streamed session" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Keep running after session event",
      prompt: "Start and keep running.",
    });

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      clientFactory: () => ({
        start: async ({ onEvent, onStdout }) => {
          onEvent?.({ type: "thread.started", thread_id: "streamed_session" });
          onStdout?.(`${JSON.stringify({ type: "thread.started", thread_id: "streamed_session" })}\n`);
          return {
            status: "running" as const,
            sessionId: null,
            outputPath: join(dir, "output.json"),
            stdout: "",
            stderr: "",
            events: [],
          };
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const attemptId = result.rounds[0].tasks[0].attemptId;
    const attempt = harness.getAttempt(attemptId)!;
    const thread = harness.getRunOverview({ runId, eventLimit: 1 }).threads.find((candidate) => candidate.attemptId === attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId,
      status: "running",
      codexSessionId: "streamed_session",
    });
    expect(attempt.input.codexSessionId).toBe("streamed_session");
    expect(thread.agentSessionId).toBe("streamed_session");
    expect(harness.getTask(taskId)?.status).toBe("running");
  });

  test("runner-owned codex loop orphans running attempts when the owner pid is gone", async () => {
    const runId = harness.createRun({ goal: "Recover dead owner" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Recover stale running attempt",
      prompt: "Continue.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "dead-owner", executor: "codex-resumable" },
    });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`,
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "dead-owner-test",
      role: "worker",
      status: "running",
      pid: 99999999,
      sessionName: "dead-owner",
    });

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const attempt = harness.getAttempt(attemptId)!;
    const task = harness.getTask(taskId)!;
    const thread = harness.getRunOverview({ runId, eventLimit: 1 }).threads.find((candidate) => candidate.attemptId === attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId,
      attemptId,
      status: "blocked",
      codexSessionId: null,
    });
    expect(attempt.status).toBe("blocked");
    expect(task.status).toBe("blocked");
    expect(attempt.output?.problems).toContain(
      "running attempt is missing an agent session id; automatic retry is disabled because this attempt cannot be resumed safely",
    );
    expect(thread.status).toBe("orphaned");
  });

  test("runner-owned codex loop recovers missing codexSessionId from thread agent session id", async () => {
    const runId = harness.createRun({ goal: "Recover runner session" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Resume from thread",
      prompt: "Continue.",
    });
    const recoveredAttemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "recoverable", executor: "codex-resumable", cwd: dir },
    });
    harness.upsertExecutionThread({
      id: `thread_${recoveredAttemptId}`,
      runId,
      taskId,
      attemptId: recoveredAttemptId,
      ownerType: "runner",
      ownerId: "recoverable-owner",
      role: "worker",
      status: "running",
      pid: 99999999,
      sessionName: "recoverable",
      agentSessionId: "session_from_thread",
      worktreePath: dir,
    });

    const missingTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Missing session",
      prompt: "Continue without a session.",
    });
    const missingAttemptId = harness.startAttempt({
      taskId: missingTaskId,
      input: { sessionName: "missing", executor: "codex-resumable", cwd: dir },
    });
    harness.upsertExecutionThread({
      id: `thread_${missingAttemptId}`,
      runId,
      taskId: missingTaskId,
      attemptId: missingAttemptId,
      ownerType: "runner",
      ownerId: "missing-owner",
      role: "worker",
      status: "running",
      pid: 99999999,
      sessionName: "missing",
      worktreePath: dir,
    });

    const resumedSessions: string[] = [];
    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 2,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async ({ sessionId }) => {
          resumedSessions.push(sessionId);
          return {
            status: "done" as const,
            sessionId,
            outputPath: join(dir, "output.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              summary: "Resumed",
              changedFiles: [],
              checks: [],
              artifacts: [],
              problems: [],
            },
          };
        },
      }),
    });

    const recoveredAttempt = harness.getAttempt(recoveredAttemptId)!;
    const missingAttempt = harness.getAttempt(missingAttemptId)!;
    const missingTask = harness.getTask(missingTaskId)!;

    expect(resumedSessions).toEqual(["session_from_thread"]);
    expect(result.rounds[0].tasks).toContainEqual(
      expect.objectContaining({ attemptId: recoveredAttemptId, status: "done", codexSessionId: "session_from_thread" }),
    );
    expect(result.rounds[0].tasks).toContainEqual(
      expect.objectContaining({ attemptId: missingAttemptId, status: "blocked", codexSessionId: null }),
    );
    expect(recoveredAttempt.input.codexSessionId).toBe("session_from_thread");
    expect(missingAttempt.status).toBe("blocked");
    expect(missingTask.status).toBe("blocked");
    expect(missingAttempt.output.problems).toContain(
      "running attempt is missing an agent session id; automatic retry is disabled because this attempt cannot be resumed safely",
    );
  });

  test("direct codex resume recovers missing codexSessionId from thread agent session id", async () => {
    const runId = harness.createRun({ goal: "Recover direct resume session" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Resume direct",
      prompt: "Continue.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "direct-recoverable", executor: "codex-resumable", cwd: dir },
    });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`,
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "direct-owner",
      role: "worker",
      status: "running",
      pid: process.pid,
      sessionName: "direct-recoverable",
      agentSessionId: "direct_session_from_thread",
      worktreePath: dir,
    });

    const resumedSessions: string[] = [];
    const result = await resumeCodexResumableAttempt({
      harness,
      attemptId,
      cwd: dir,
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async ({ sessionId }) => {
          resumedSessions.push(sessionId);
          return {
            status: "done" as const,
            sessionId,
            outputPath: join(dir, "output.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              summary: "Resumed direct",
              changedFiles: [],
              checks: [],
              artifacts: [],
              problems: [],
            },
          };
        },
      }),
    });

    const attempt = harness.getAttempt(attemptId)!;

    expect(resumedSessions).toEqual(["direct_session_from_thread"]);
    expect(result).toMatchObject({ attemptId, status: "done", codexSessionId: "direct_session_from_thread" });
    expect(attempt.input.codexSessionId).toBe("direct_session_from_thread");
  });

  test("runner-owned loop preserves fresh generic running attempts without Codex session ids", async () => {
    const runId = harness.createRun({
      goal: "Keep generic agent running",
      context: {
        agentDefaults: {
          roles: {
            planner: "claude-code",
          },
        },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agent: "claude",
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan with Claude Code",
      prompt: "Plan.",
    });
    const route = resolveExecutionRoute({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      cliExecutor: "codex-resumable",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        sessionName: "claude-planner",
        executor: "acpx",
        route,
        backend: route.backend,
        cwd: dir,
        model: route.model,
      },
    });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`,
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "generic-owner-test",
      role: "planner",
      status: "running",
      pid: process.pid,
      sessionName: "claude-planner",
      worktreePath: dir,
    });
    const db = new Database(harness.dbPath);
    db.query("update attempts set started_at = datetime('now', '-10 minutes') where id = $id").run({ $id: attemptId });
    db.query("update execution_threads set heartbeat_at = current_timestamp where id = $id").run({
      $id: `thread_${attemptId}`,
    });
    db.close();

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      runningAttemptStaleMs: 5 * 60 * 1000,
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async () => {
          throw new Error("generic running attempt should not use codex resume");
        },
      }),
    });

    const attempt = harness.getAttempt(attemptId)!;
    const task = harness.getTask(taskId)!;
    const thread = harness.getRunOverview({ runId, eventLimit: 1 }).threads.find((candidate) => candidate.attemptId === attemptId)!;

    expect(result.rounds[0].tasks[0]).toMatchObject({
      taskId,
      attemptId,
      sessionName: "claude-planner",
      status: "running",
      codexSessionId: null,
    });
    expect(attempt.status).toBe("running");
    expect(task.status).toBe("running");
    expect(thread.status).toBe("running");
  });

  test("generic acpx attempt records durable start evidence and streamed output via the executor recorder", async () => {
    const runId = harness.createRun({
      goal: "Observe generic acpx attempt",
      context: {
        agentDefaults: {
          roles: {
            planner: "claude-code",
          },
        },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agent: "claude",
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan with Claude Code",
      prompt: "Plan.",
    });

    const recordedChunks: string[] = [];
    const recordedEvents: Record<string, unknown>[] = [];
    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      genericExecutorFactory: () => async ({ recorder }) => {
        recorder?.event({ type: "test.executor.started" });
        recorder?.stdout("[agent] planning\n");
        recorder?.stderr("[agent] warning\n");
        recordedChunks.push("streamed");
        return {
          status: "done",
          summary: "planned via generic executor",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        };
      },
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called for generic route");
        },
        resume: async () => {
          throw new Error("resume should not be called for generic route");
        },
      }),
    });

    const attemptId = result.rounds[0].tasks[0]!.attemptId;
    const events = harness.listAttemptEvents(attemptId);
    const systemEvents = events.filter((event) => event.stream === "system");
    const stdoutEvents = events.filter((event) => event.stream === "stdout");
    const stderrEvents = events.filter((event) => event.stream === "stderr");
    for (const event of events) {
      if (event.stream === "system" && event.payload && typeof event.payload === "object") {
        recordedEvents.push(event.payload as Record<string, unknown>);
      }
    }

    expect(systemEvents.length).toBeGreaterThan(0);
    expect(systemEvents[0]!.payload).toMatchObject({ type: "generic.attempt.started", backend: "acpx" });
    expect(recordedEvents.some((event) => event.type === "test.executor.started")).toBe(true);
    expect(stdoutEvents.map((event) => event.text).join("")).toContain("[agent] planning");
    expect(stderrEvents.map((event) => event.text).join("")).toContain("[agent] warning");
    expect(recordedChunks).toEqual(["streamed"]);
    expect(harness.getAttempt(attemptId)?.status).toBe("done");
  });

  test("generic acpx attempt records heartbeat events while a quiet executor is still running", async () => {
    const runId = harness.createRun({
      goal: "Observe quiet generic acpx attempt",
      context: {
        agentDefaults: {
          global: "claude-code",
        },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agent: "claude",
          },
        },
      },
    });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Run quiet worker",
      prompt: "Stay quiet for a bit.",
    });

    let releaseExecutor!: () => void;
    const running = runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      genericAttemptHeartbeatMs: 20,
      genericExecutorFactory: () => async () => {
        await new Promise<void>((resolve) => {
          releaseExecutor = resolve;
        });
        return {
          status: "done",
          summary: "quiet worker completed",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        };
      },
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called for generic route");
        },
        resume: async () => {
          throw new Error("resume should not be called for generic route");
        },
      }),
    });

    await waitFor(() => {
      const [attempt] = harness.listRunningAttempts({ runId });
      if (!attempt) {
        return false;
      }
      const heartbeat = harness.listAttemptEvents(attempt.id).find((event) =>
        event.stream === "system" &&
        event.payload &&
        typeof event.payload === "object" &&
        (event.payload as { type?: string }).type === "generic.attempt.heartbeat"
      );
      return Boolean(heartbeat);
    });

    const [attempt] = harness.listRunningAttempts({ runId });
    expect(attempt?.input).toMatchObject({
      sessionName: expect.any(String),
      cwd: dir,
      backend: expect.objectContaining({ kind: "acpx", agent: "claude" }),
    });
    const eventsBeforeCompletion = harness.listAttemptEvents(attempt!.id);
    expect(eventsBeforeCompletion.some((event) =>
      event.stream === "system" &&
      (event.payload as { type?: string }).type === "generic.attempt.heartbeat"
    )).toBe(true);
    expect(harness.getAttempt(attempt!.id)?.status).toBe("running");

    releaseExecutor();
    const result = await running;

    expect(result.rounds[0].tasks[0]).toMatchObject({ status: "done", attemptId: attempt!.id });
    expect(harness.getAttempt(attempt!.id)?.status).toBe("done");
  });

  test("runner event writes keep using the original relative database after cwd changes to an external worktree", async () => {
    const originalCwd = process.cwd();
    const controlRoot = join(dir, "control-root");
    const externalWorktree = join(dir, "external-worktree");
    await mkdir(controlRoot, { recursive: true });
    await mkdir(externalWorktree, { recursive: true });

    try {
      process.chdir(controlRoot);
      const relativeHarness = new Harness(".ouroboros/ouroboros.db");
      relativeHarness.init();
      const expectedDbPath = resolve(".ouroboros", "ouroboros.db");
      expect(relativeHarness.dbPath).toBe(expectedDbPath);

      const runId = relativeHarness.createRun({
        goal: "Write events from an external worktree",
        context: {
          agentDefaults: {
            global: "claude-code",
          },
          agentBackends: {
            "claude-code": {
              kind: "acpx",
              agent: "claude",
            },
          },
        },
      });
      relativeHarness.createTask({
        runId,
        role: "worker",
        goal: "Stream from external worktree",
        prompt: "Stream output.",
        worktreePath: externalWorktree,
      });

      process.chdir(externalWorktree);
      const result = await runCodexResumableLoop({
        harness: relativeHarness,
        runId,
        limit: 1,
        maxRounds: 1,
        maxTries: 3,
        cwd: externalWorktree,
        genericExecutorFactory: () => async ({ recorder }) => {
          recorder?.stdout("external stream\n");
          recorder?.event({ type: "test.external_worktree_event" });
          return {
            status: "done",
            summary: "streamed from external worktree",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          };
        },
        clientFactory: () => ({
          start: async () => {
            throw new Error("start should not be called for generic route");
          },
          resume: async () => {
            throw new Error("resume should not be called for generic route");
          },
        }),
      });

      const attemptId = result.rounds[0].tasks[0]!.attemptId;
      const reopened = new Harness(expectedDbPath);
      const events = reopened.listAttemptEvents(attemptId);

      expect(events.some((event) => event.stream === "stdout" && event.text?.includes("external stream"))).toBe(true);
      expect(events.some((event) =>
        event.stream === "system" &&
        event.payload &&
        typeof event.payload === "object" &&
        (event.payload as { type?: string }).type === "test.external_worktree_event"
      )).toBe(true);
      expect(existsSync(join(externalWorktree, ".ouroboros", "ouroboros.db"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("generic acpx attempt records start evidence even when the executor throws", async () => {
    const runId = harness.createRun({
      goal: "Observe throwing generic acpx attempt",
      context: {
        agentDefaults: {
          global: "claude-code",
        },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agent: "claude",
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Throwing worker",
      prompt: "Work.",
    });

    const result = await runCodexResumableLoop({
      harness,
      runId,
      limit: 1,
      maxRounds: 1,
      maxTries: 3,
      cwd: dir,
      genericExecutorFactory: () => async () => {
        throw new Error("silent executor crash");
      },
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const attemptId = result.rounds[0].tasks[0]!.attemptId;
    const attempt = harness.getAttempt(attemptId)!;
    const events = harness.listAttemptEvents(attemptId);
    const systemEvents = events.filter((event) => event.stream === "system").map((event) => event.payload as Record<string, unknown>);

    expect(attempt.status).toBe("blocked");
    expect(attempt.output.problems).toContain("silent executor crash");
    expect(systemEvents.some((event) => event.type === "generic.attempt.started")).toBe(true);
    expect(systemEvents.some((event) => event.type === "generic.attempt.executor_threw")).toBe(true);
  });

  test("supervisor skips paused and complete runs while draining blocked and orphaned work", async () => {
    const pausedRunId = harness.createRun({
      goal: "Paused run",
      context: {
        runPause: {
          reason: "human requested pause",
          pausedAt: "2026-06-17T00:00:00.000Z",
        },
      },
    });
    const pausedTaskId = harness.createTask({
      runId: pausedRunId,
      role: "worker",
      goal: "Paused task",
      prompt: "Do not run.",
    });

    const blockedRunId = harness.createRun({ goal: "Blocked run" });
    const blockedTaskId = harness.createTask({
      runId: blockedRunId,
      role: "worker",
      goal: "Blocked task",
      prompt: "Blocked.",
    });
    harness.recordAttempt({
      taskId: blockedTaskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Cannot continue",
        problems: ["cannot continue"],
      },
    });

    const completeRunId = harness.createRun({ goal: "Complete run" });
    harness.updateRunStatus({ runId: completeRunId, status: "done" });

    const runnableRunId = harness.createRun({ goal: "Runnable orphaned run" });
    const runnableTaskId = harness.createTask({
      runId: runnableRunId,
      role: "worker",
      goal: "Runnable task",
      prompt: "Run.",
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: dir,
      runConcurrency: 4,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      clientFactory: ({ task }) => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_runnable",
          outputPath: join(dir, "runnable-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            ...(task?.role === "goal-review" ? { runDecision: "complete" as const } : {}),
            summary: task?.role === "goal-review" ? "Reviewed blocked work." : "Ran runnable work",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    expect(result.cycles[0].runs.map((run) => run.runId).sort()).toEqual(
      [runnableRunId, blockedRunId].sort(),
    );
    expect(harness.getTask(runnableTaskId)?.status).toBe("done");
    expect(harness.getRun(blockedRunId)?.status).toBe("done");
    expect(harness.getTask(pausedTaskId)?.status).toBe("todo");
    expect(harness.getRun(pausedRunId)?.context.runPause).toEqual(
      expect.objectContaining({ reason: "human requested pause" }),
    );
  });

  test("supervisor reaches runnable descendants through terminal ancestors", async () => {
    const rootRunId = harness.createRun({ goal: "Durable supervisor root" });
    harness.updateRunStatus({ runId: rootRunId, status: "blocked" });
    const assessmentRunId = harness.createRun({
      goal: "Completed assessment",
      context: { parentRunId: rootRunId },
    });
    harness.updateRunStatus({ runId: assessmentRunId, status: "done" });
    const deliveryRunId = harness.createRun({
      goal: "Recoverable delivery",
      context: { parentRunId: assessmentRunId },
    });
    const deliveryTaskId = harness.createTask({
      runId: deliveryRunId,
      role: "worker",
      goal: "Continue delivery after the assessment completes",
      prompt: "Continue.",
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: dir,
      rootRunId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_descendant",
          outputPath: join(dir, "descendant-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            summary: "Recovered descendant work",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    expect(result.cycles[0].runs.map((run) => run.runId)).toEqual([deliveryRunId]);
    expect(harness.getTask(deliveryTaskId)?.status).toBe("done");
  });

  test("resumable loop start clears durable human pause", async () => {
    const runId = harness.createRun({
      goal: "Start paused run explicitly",
      context: {
        runPause: {
          reason: "human requested pause",
          pausedAt: "2026-06-17T00:00:00.000Z",
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Started work",
      prompt: "Run.",
    });

    await runCodexResumableLoop({
      harness,
      cwd: dir,
      runId,
      maxRounds: 1,
      limit: 1,
      maxTries: 3,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_start",
          outputPath: join(dir, "start-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            summary: "Started work",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const run = harness.getRun(runId)!;
    expect(harness.getTask(taskId)?.status).toBe("done");
    expect(run.context.runPause).toBeNull();
    expect(typeof run.context.runPauseClearedAt).toBe("string");
  });

  test("resumable loop resume clears durable human pause", async () => {
    const runId = harness.createRun({
      goal: "Resume paused run explicitly",
      context: {
        runPause: {
          reason: "human requested pause",
          pausedAt: "2026-06-17T00:00:00.000Z",
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Resumed work",
      prompt: "Continue.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        codexSessionId: "session_existing",
        sessionName: "task-existing",
        cwd: dir,
        prompt: "Continue.",
      },
    });

    await runCodexResumableLoop({
      harness,
      cwd: dir,
      runId,
      maxRounds: 1,
      limit: 1,
      maxTries: 3,
      clientFactory: () => ({
        start: async () => {
          throw new Error("start should not be called");
        },
        resume: async () => ({
          status: "done" as const,
          sessionId: "session_existing",
          outputPath: join(dir, "resume-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            summary: "Resumed work",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          },
        }),
      }),
    });

    const run = harness.getRun(runId)!;
    expect(harness.getAttempt(attemptId)?.status).toBe("done");
    expect(run.context.runPause).toBeNull();
    expect(typeof run.context.runPauseClearedAt).toBe("string");
  });

  test("supervisor integrates a completed verified run when enabled", async () => {
    const repoPath = join(dir, "repo");
    const worktreePath = join(dir, "verified-worker");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-verified-worker", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "supervised.ts"), "export const supervised = true;\n");

    const runId = harness.createRun({ goal: "Integrate supervised work", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement supervised file",
      prompt: "Create src/supervised.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created supervised file",
        changedFiles: ["src/supervised.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify supervised file",
      prompt: "Verify worker output.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified supervised file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review completion",
      prompt: "Return runDecision complete.",
      dependsOn: [verifierTaskId],
    });

    let startCount = 0;
    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 2,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => {
          startCount += 1;
          return {
            status: "done" as const,
            sessionId: `session_goal_review_${startCount}`,
            outputPath: join(dir, `goal-review-output-${startCount}.json`),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              runDecision: "complete" as const,
              summary: `Goal reached after review ${startCount}`,
              changedFiles: [],
              checks: [{ name: "goal", status: "passed" }],
              artifacts: [],
              problems: [],
            },
          };
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });
    const mergedFile = await readFile(join(repoPath, "src", "supervised.ts"), "utf8");
    const actionEvent = harness
      .listHarnessActionEvents({ limit: 10 })
      .find((event) => event.actionType === "integrateVerifiedRun");
    const integrationResults = result.cycles[0].runs[0].integration!;
    const goalReviews = harness.getRunOverview({ runId }).tasks.filter((task) => task.role === "goal-review");
    const run = harness.getRun(runId)!;

    expect(result.cycles[0].runs[0]).toMatchObject({
      runId,
      status: "todo",
    });
    expect(result.cycles[1].runs[0]).toMatchObject({
      runId,
      status: "done",
    });
    expect(integrationResults).toHaveLength(1);
    expect(integrationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          actionType: "integrateVerifiedRun",
        }),
      ]),
    );
    expect(mergedFile.trim()).toBe("export const supervised = true;");
    expect(startCount).toBe(2);
    expect(goalReviews).toHaveLength(2);
    expect(run.status).toBe("done");
    expect(run.context.goalReviewInvalidatedByIntegration).toBe(false);
    expect(typeof run.context.goalReviewRefreshedAt).toBe("string");
    expect(actionEvent).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "done",
    });
  });

  test("supervisor exits a blocked integration pass instead of replaying forever", async () => {
    const repoPath = join(dir, "repo-blocked-integration");
    const worktreePath = join(dir, "verified-worker-blocked-integration");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-blocked-integration", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "blocked.ts"), "export const blocked = true;\n");
    await writeFile(join(repoPath, "NOTES.md"), "unrelated target change\n");

    const runId = harness.createRun({ goal: "Bound blocked integration", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement blocked file",
      prompt: "Create src/blocked.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created blocked file",
        changedFiles: ["src/blocked.ts"],
        checks: [{ name: "worker", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify blocked file",
      prompt: "Verify worker output.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified blocked file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 1,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_blocked_integration_review",
          outputPath: join(dir, "blocked-integration-review.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            runDecision: "continue" as const,
            summary: "Integration remains blocked.",
            changedFiles: [],
            checks: [{ name: "integration", status: "failed" }],
            artifacts: [],
            problems: ["target repository contains unrelated changes"],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });
    const integrationEvents = harness
      .listHarnessActionEvents({ limit: 10 })
      .filter((event) => event.actionType === "integrateVerifiedRun");

    expect(result.cycles).toHaveLength(1);
    expect(integrationEvents).toHaveLength(2);
    expect(integrationEvents.every((event) => event.status === "blocked")).toBe(true);
  }, 2_000);

  test("supervisor integrates verified worker work before goal review when run is still todo", async () => {
    const repoPath = join(dir, "repo-pre-review");
    const worktreePath = join(dir, "verified-worker-pre-review");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-verified-pre-review", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "pre-review.ts"), "export const preReview = true;\n");

    const runId = harness.createRun({ goal: "Integrate before review" });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement pre-review file",
      prompt: "Create src/pre-review.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created pre-review file",
        changedFiles: ["src/pre-review.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify pre-review file",
      prompt: "Verify worker output.",
      dependsOn: [workerTaskId],
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_verifier",
          outputPath: join(dir, "verifier-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            summary: "Verified pre-review file",
            changedFiles: [],
            checks: [{ name: "verify", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });
    const mergedFile = await readFile(join(repoPath, "src", "pre-review.ts"), "utf8");
    const actionEvent = harness.listHarnessActionEvents({ limit: 1 })[0];
    const integrationResults = result.cycles[0].runs[0].integration!;

    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(harness.getTask(verifierTaskId)?.status).toBe("done");
    expect(result.cycles[0].runs[0]).toMatchObject({
      runId,
      status: "todo",
    });
    expect(integrationResults).toHaveLength(1);
    expect(integrationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          actionType: "integrateVerifiedRun",
        }),
      ]),
    );
    expect(mergedFile.trim()).toBe("export const preReview = true;");
    expect(actionEvent).toMatchObject({
      actionType: "integrateVerifiedRun",
      status: "done",
      request: expect.objectContaining({ workerTaskId }),
    });
  });

  test("supervisor integrates verified work before same-tick goal review when max rounds continue", async () => {
    const repoPath = join(dir, "repo-pre-review-same-tick");
    const worktreePath = join(dir, "verified-worker-same-tick");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-verified-same-tick", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "same-tick.ts"), "export const sameTick = true;\n");

    const runId = harness.createRun({ goal: "Review merged worker evidence", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement same tick file",
      prompt: "Create src/same-tick.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created same tick file",
        changedFiles: ["src/same-tick.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify same tick file",
      prompt: "Verify worker output.",
      dependsOn: [workerTaskId],
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 4,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: (factoryInput) => ({
        start: async (input) => {
          if (factoryInput.task?.role === "goal-review") {
            let mergedEvidence = "";
            try {
              mergedEvidence = await readFile(join(repoPath, "src", "same-tick.ts"), "utf8");
            } catch {
              // Missing evidence means goal-review ran before integration.
            }
            if (mergedEvidence.includes("sameTick = true")) {
              return {
                status: "done" as const,
                sessionId: "session_goal_review_complete",
                outputPath: join(dir, "goal-review-complete.json"),
                stdout: "",
                stderr: "",
                events: [],
                output: {
                  status: "done" as const,
                  runDecision: "complete" as const,
                  summary: "Goal-review saw merged worker evidence.",
                  changedFiles: [],
                  checks: [{ name: "merged evidence", status: "passed" }],
                  artifacts: [],
                  problems: [],
                },
              };
            }
            return {
              status: "done" as const,
              sessionId: "session_goal_review_continue",
              outputPath: join(dir, "goal-review-continue.json"),
              stdout: "",
              stderr: "",
              events: [],
              output: {
                status: "done" as const,
                runDecision: "continue" as const,
                summary: "Merged worker evidence is missing.",
                changedFiles: [],
                checks: [{ name: "merged evidence", status: "failed" }],
                artifacts: [],
                problems: ["src/same-tick.ts was not visible on main"],
                nextTasks: [{
                  role: "worker" as const,
                  goal: "Repair missing integration",
                  prompt: "Repair missing integration.",
                  doneWhen: ["merged evidence visible"],
                }],
              },
            };
          }
          return {
            status: "done" as const,
            sessionId: "session_verifier",
            outputPath: join(dir, "verifier-output.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              summary: "Verified same tick file",
              changedFiles: [],
              checks: [{ name: "verify", status: "passed" }],
              artifacts: [],
              problems: [],
            },
          };
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const integrationEvents = harness
      .listHarnessActionEvents({ limit: 10 })
      .filter((event) => event.actionType === "integrateVerifiedRun" && event.status === "done");
    const goalReview = harness.getRunOverview({ runId }).tasks.find((task) => task.role === "goal-review");

    expect(result.cycles[0].runs[0]).toMatchObject({ runId, status: "done", activeTasks: 0 });
    expect(integrationEvents).toHaveLength(1);
    expect(goalReview?.status).toBe("done");
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(await readFile(join(repoPath, "src", "same-tick.ts"), "utf8")).toContain("sameTick = true");
  });

  test("supervisor integrates every eligible verified worker in a single pre-review tick", async () => {
    const repoPath = join(dir, "repo-pre-review-multi");
    const workerAWorktree = join(dir, "verified-worker-a");
    const workerBWorktree = join(dir, "verified-worker-b");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-worker-a", workerAWorktree, "main"]);
    await mkdir(join(workerAWorktree, "src"), { recursive: true });
    await writeFile(join(workerAWorktree, "src", "worker_a.ts"), "export const workerA = true;\n");
    git(repoPath, ["worktree", "add", "-b", "task-worker-b", workerBWorktree, "main"]);
    await mkdir(join(workerBWorktree, "src"), { recursive: true });
    await writeFile(join(workerBWorktree, "src", "worker_b.ts"), "export const workerB = true;\n");

    const runId = harness.createRun({ goal: "Integrate two verified workers", projectRoot: repoPath });
    const workerATaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement worker A file",
      prompt: "Create src/worker_a.ts.",
      worktreePath: workerAWorktree,
    });
    harness.recordAttempt({
      taskId: workerATaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created worker A file",
        changedFiles: ["src/worker_a.ts"],
        checks: [{ name: "worker A check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierATaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker A",
      prompt: "Verify worker A output.",
      dependsOn: [workerATaskId],
    });
    harness.recordAttempt({
      taskId: verifierATaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified worker A",
        changedFiles: [],
        checks: [{ name: "verify A", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const workerBTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement worker B file",
      prompt: "Create src/worker_b.ts.",
      worktreePath: workerBWorktree,
      dependsOn: [workerATaskId],
    });
    harness.recordAttempt({
      taskId: workerBTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created worker B file",
        changedFiles: ["src/worker_b.ts"],
        checks: [{ name: "worker B check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierBTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify worker B",
      prompt: "Verify worker B output.",
      dependsOn: [workerBTaskId],
    });
    harness.recordAttempt({
      taskId: verifierBTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified worker B",
        changedFiles: [],
        checks: [{ name: "verify B", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_idle",
          outputPath: join(dir, "idle-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            summary: "Nothing to start",
            changedFiles: [],
            checks: [],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const actionEvents = harness
      .listHarnessActionEvents({ limit: 50 })
      .filter((event) => event.actionType === "integrateVerifiedRun" && event.status === "done");
    const integratedWorkerIds = actionEvents.map((event) => event.request.workerTaskId);
    const integrationResults = result.cycles[0].runs[0].integration!;
    const integrationOrderWorkerIds = integrationResults.map((result) => {
      const artifact = result.artifacts.find((entry) => typeof (entry as { workerTaskId?: unknown }).workerTaskId === "string") as
        | { workerTaskId: string }
        | undefined;
      return artifact?.workerTaskId;
    });

    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(integrationResults).toHaveLength(2);
    expect(integrationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          actionType: "integrateVerifiedRun",
          artifacts: [expect.objectContaining({ workerTaskId: workerATaskId })],
        }),
        expect.objectContaining({
          status: "done",
          actionType: "integrateVerifiedRun",
          artifacts: [expect.objectContaining({ workerTaskId: workerBTaskId })],
        }),
      ]),
    );
    expect(integratedWorkerIds.sort()).toEqual([workerATaskId, workerBTaskId].sort());
    expect(integrationOrderWorkerIds).toEqual([workerBTaskId, workerATaskId]);
    expect(await readFile(join(repoPath, "src", "worker_a.ts"), "utf8")).toContain("workerA = true");
    expect(await readFile(join(repoPath, "src", "worker_b.ts"), "utf8")).toContain("workerB = true");
  });

  test("supervisor integrates verified work even when an unrelated branch is waiting", async () => {
    const repoPath = join(dir, "repo-pre-review-unrelated-wait");
    const worktreePath = join(dir, "verified-worker-unrelated-wait");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-verified-unrelated-wait", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "unrelated-wait.ts"), "export const unrelatedWait = true;\n");

    const runId = harness.createRun({ goal: "Integrate ready branch while another branch waits", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement unrelated wait file",
      prompt: "Create src/unrelated-wait.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created unrelated wait file",
        changedFiles: ["src/unrelated-wait.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify unrelated wait file",
      prompt: "Verify worker output.",
      dependsOn: [workerTaskId],
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified unrelated wait file",
        changedFiles: [],
        checks: [{ name: "verify", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const blockedWorkerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Blocked unrelated work",
      prompt: "This branch is blocked.",
    });
    harness.recordAttempt({
      taskId: blockedWorkerId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "External blocker",
        changedFiles: [],
        checks: [{ name: "external", status: "failed" }],
        artifacts: [],
        problems: ["external blocker"],
      },
    });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify blocked unrelated work",
      prompt: "Wait for blocked worker.",
      dependsOn: [blockedWorkerId],
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 2,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => {
          return {
            status: "done" as const,
            sessionId: "session_goal_review_waiting",
            outputPath: join(dir, "goal-review-waiting-output.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: {
              status: "done" as const,
              runDecision: "complete" as const,
              summary: "Integrated verified work and drained unrelated blocked dependency.",
              changedFiles: [],
              checks: [{ name: "goal review", status: "passed", evidence: "complete" }],
              artifacts: [],
              problems: [],
            },
          };
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    const integrationResults = result.cycles[0].runs[0].integration!;

    expect(result.cycles[0].runs[0]).toMatchObject({ runId, activeTasks: 0, status: "done" });
    expect(integrationResults).toHaveLength(1);
    expect(integrationResults[0]).toMatchObject({
      status: "done",
      actionType: "integrateVerifiedRun",
      artifacts: [expect.objectContaining({ workerTaskId })],
    });
    expect(await readFile(join(repoPath, "src", "unrelated-wait.ts"), "utf8")).toContain("unrelatedWait = true");
  });

  test("supervisor drains todo tasks blocked by dependencies when no task is ready", async () => {
    const runId = harness.createRun({ goal: "Drain a stuck dependency graph" });
    const blockedWorkerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Blocked worker",
      prompt: "This worker is blocked.",
    });
    harness.recordAttempt({
      taskId: blockedWorkerId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Worker blocked",
        changedFiles: [],
        checks: [{ name: "worker", status: "failed", evidence: "blocked" }],
        artifacts: [],
        problems: ["worker blocked"],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify blocked worker",
      prompt: "This should be drained.",
      dependsOn: [blockedWorkerId],
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: dir,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 3,
      maxTries: 3,
      intervalMs: 1,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_goal_review",
          outputPath: join(dir, "goal-review-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            runDecision: "complete" as const,
            summary: "No runnable work remains after blocked dependency drain.",
            changedFiles: [],
            checks: [{ name: "goal review", status: "passed", evidence: "drained" }],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });
    const overview = harness.getRunOverview({ runId });

    expect(result.cycles[0].runs[0]).toMatchObject({ runId, status: "done", activeTasks: 0 });
    expect(harness.getTask(verifierTaskId)?.status).toBe("blocked");
    expect(overview.tasks.find((task) => task.role === "goal-review")?.status).toBe("done");
    expect(harness.getRun(runId)?.status).toBe("done");
  });

  test("supervisor drains a todo run when every remaining task is blocked", async () => {
    const runId = harness.createRun({ goal: "Recover a fully blocked run" });
    const partialWorktree = join(dir, "partial-worktree");
    await mkdir(partialWorktree, { recursive: true });
    const blockedWorkerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Blocked worker with partial progress",
      prompt: "The prior attempt timed out after changing its worktree.",
      worktreePath: partialWorktree,
    });
    harness.recordAttempt({
      taskId: blockedWorkerId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Worker timed out after making partial progress",
        changedFiles: ["src/partial.ts"],
        checks: [{ name: "worker", status: "failed", evidence: "idle timeout" }],
        artifacts: [{ kind: "worktree", path: "/tmp/partial-worktree" }],
        problems: ["idle timeout"],
      },
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: dir,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 2,
      maxTries: 3,
      intervalMs: 1,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_fully_blocked_goal_review",
          outputPath: join(dir, "fully-blocked-goal-review.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            runDecision: "complete" as const,
            summary: "The blocked attempt preserved enough evidence to close the run.",
            changedFiles: [],
            checks: [{ name: "goal review", status: "passed", evidence: "blocked evidence reviewed" }],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    expect(result.status).toBe("cycle_limit");
    expect(result.cycles[0].runs[0]).toMatchObject({ runId, status: "done", activeTasks: 0 });
    const goalReview = harness.getRunOverview({ runId }).tasks.find((task) => task.role === "goal-review");
    expect(goalReview).toMatchObject({ status: "done", worktreePath: partialWorktree, dependsOn: [] });
    expect(harness.getRun(runId)?.status).toBe("done");
  });

  test("supervisor skips a verified worker superseded by a verified repair", async () => {
    const repoPath = join(dir, "repo-superseded");
    const originalWorktreePath = join(dir, "original-worker");
    const repairWorktreePath = join(dir, "repair-worker");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-original-worker", originalWorktreePath, "main"]);
    await mkdir(join(originalWorktreePath, "src"), { recursive: true });
    await mkdir(join(originalWorktreePath, "docs"), { recursive: true });
    await writeFile(join(originalWorktreePath, "src", "original.ts"), "export const original = true;\n");
    await writeFile(join(originalWorktreePath, "docs", "original.md"), "original docs\n");
    git(repoPath, ["worktree", "add", "-b", "task-repair-worker", repairWorktreePath, "main"]);
    await mkdir(join(repairWorktreePath, "src"), { recursive: true });
    await writeFile(join(repairWorktreePath, "src", "repair.ts"), "export const repair = true;\n");

    const runId = harness.createRun({ goal: "Integrate repaired work", projectRoot: repoPath });
    const originalTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement original work",
      prompt: "Create original files.",
      worktreePath: originalWorktreePath,
    });
    harness.recordAttempt({
      taskId: originalTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created original files",
        changedFiles: ["src/original.ts", "docs/original.md"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const blockedVerifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify original work",
      prompt: "Verify original files.",
      dependsOn: [originalTaskId],
    });
    const repairTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair original work",
      prompt: "Repair original files.",
      worktreePath: repairWorktreePath,
    });
    harness.recordAttempt({
      taskId: blockedVerifierId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Original work needs repair",
        changedFiles: [],
        checks: [{ name: "verify", status: "failed" }],
        artifacts: [{ kind: "created_repair_task", taskId: repairTaskId, verifierTaskId: blockedVerifierId }],
        problems: ["original work needs repair"],
      },
    });
    harness.recordAttempt({
      taskId: repairTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Repaired original files",
        changedFiles: ["src/repair.ts"],
        checks: [{ name: "repair check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const repairVerifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify repair",
      prompt: "Verify repair.",
      dependsOn: [repairTaskId],
    });
    harness.recordAttempt({
      taskId: repairVerifierId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Verified repair",
        changedFiles: [],
        checks: [{ name: "verify repair", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review completion",
      prompt: "Return runDecision complete.",
    });

    const result = await superviseCodexRuns({
      harness,
      cwd: repoPath,
      rootRunId: runId,
      runConcurrency: 1,
      taskConcurrency: 1,
      maxCycles: 1,
      maxRounds: 1,
      maxTries: 3,
      intervalMs: 1,
      integrateCompletedRuns: true,
      clientFactory: () => ({
        start: async () => ({
          status: "done" as const,
          sessionId: "session_goal_review",
          outputPath: join(dir, "goal-review-output.json"),
          stdout: "",
          stderr: "",
          events: [],
          output: {
            status: "done" as const,
            runDecision: "complete" as const,
            summary: "Goal reached",
            changedFiles: [],
            checks: [{ name: "goal", status: "passed" }],
            artifacts: [],
            problems: [],
          },
        }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      }),
    });

    expect(result.cycles[0].runs[0].integration).toEqual([
      expect.objectContaining({
        status: "done",
        actionType: "integrateVerifiedRun",
        artifacts: [expect.objectContaining({ workerTaskId: repairTaskId })],
      }),
    ]);
    expect(await readFile(join(repoPath, "src", "repair.ts"), "utf8")).toContain("repair");
    expect(Bun.file(join(repoPath, "src", "original.ts")).exists()).resolves.toBe(false);
  });

  test("supervisor refuses to mark a run done while verified worker changes remain unintegrated", async () => {
    const repoPath = join(dir, "repo-unintegrated-supervisor");
    const worktreePath = join(dir, "verified-worker-unintegrated");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.name", "Ouroboros Test"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "commit.gpgSign", "false"]);
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["worktree", "add", "-b", "task-unintegrated-worker", worktreePath, "main"]);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "pending.ts"), "export const pending = true;\n");

    const runId = harness.createRun({ goal: "Block completion until integration", projectRoot: repoPath });
    const workerTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement pending work",
      prompt: "Create src/pending.ts.",
      worktreePath,
    });
    harness.recordAttempt({
      taskId: workerTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Created pending file",
        changedFiles: ["src/pending.ts"],
        checks: [{ name: "worker check", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify pending work",
      prompt: "Verify worker output.",
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
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Mark complete",
      prompt: "Return runDecision complete.",
    });
    harness.updateRunStatus({ runId, status: "running" });

    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async () => ({
        status: "done",
        runDecision: "complete",
        summary: "Goal reached",
        changedFiles: [],
        checks: [{ name: "goal", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    });

    const run = harness.getRun(runId)!;
    expect(run.status).toBe("blocked");
    expect(run.context.pendingIntegrationWorkerTaskIds).toEqual([workerTaskId]);
    expect(run.context.pendingIntegrationReason).toMatch(/not integrated/);
  });

  test("runner keeps dependency attempts empty for tasks without dependencies", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Implement standalone task",
      prompt: "No upstream context needed.",
    });

    const prompts: string[] = [];
    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async ({ prompt }) => {
        prompts.push(prompt);
        return {
          status: "done",
          summary: "Executed standalone task",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    const dependencySection = prompts[0].split("## Dependency Attempts")[1]!.split("## Run Lessons")[0]!;
    expect(dependencySection).toContain("[]");
  });

  test("runner builds task prompts from the database template", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.setPromptTemplate({
      key: "task",
      contentMd: "# Custom Harness Prompt\nGoal={{taskGoal}}\nLessons={{runLessonsJson}}",
    });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Use custom template",
      prompt: "Use prior lesson.",
    });

    const prompts: string[] = [];
    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async ({ prompt }) => {
        prompts.push(prompt);
        return {
          status: "done",
          summary: "Used custom template",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(prompts[0]).toContain("# Custom Harness Prompt");
    expect(prompts[0]).toContain("Goal=Use custom template");
  });

  test("applies stop hooks before recording an attempt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Executed task",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [
        async ({ task }) => ({
          decision: "exit",
          checks: [{ name: "stop hook", status: "passed" }],
          artifacts: [{ kind: "summary", taskId: task.id }],
        }),
      ],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.output.checks).toEqual([{ name: "stop hook", status: "passed" }]);
    expect(attempt.output.artifacts).toEqual([{ kind: "summary", taskId }]);
  });

  test("collect subsessions stop hook records child summaries in the parent attempt output", async () => {
    const runId = harness.createRun({ goal: "Collect child evidence" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Drive child session",
      prompt: "Start a child session and finish.",
    });
    let childThreadId = "";
    const subsessionRunner = {
      start: () => ({
        threadId: "unused",
        sessionName: "unused",
        status: "running" as const,
      }),
      collect: (children: Array<{ threadId: string; sessionName: string | null }>) =>
        children.map((child) => ({
          threadId: child.threadId,
          status: "done" as const,
          summary: `collected ${child.sessionName}`,
          agentSessionId: child.sessionName,
        })),
      cancel: () => [],
    };

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => {
        childThreadId = harness.upsertExecutionThread({
          runId,
          taskId,
          ownerType: "subsession",
          ownerId: "action_1",
          role: "researcher",
          status: "done",
          sessionName: "task_child__research",
          agentSessionId: "task_child__research",
        });
        return {
          status: "done",
          summary: "parent done",
          changedFiles: [],
          checks: [],
          artifacts: [],
          problems: [],
        };
      },
      stopHooks: [createCollectSubsessionsHook({ harness, subsessionRunner })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.output.artifacts).toContainEqual(expect.objectContaining({
      kind: "subsession_summary",
      threadId: childThreadId,
      status: "done",
      summary: "collected task_child__research",
    }));
  });

  test("stop hooks can block an otherwise successful attempt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Executed task",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [
        async () => ({
          decision: "exit",
          problems: ["git tree is dirty"],
        }),
      ],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.status).toBe("blocked");
    expect(attempt.output.status).toBe("blocked");
    expect(attempt.output.problems).toEqual(["git tree is dirty"]);
  });

  test("stop hooks can request retry without pretending the task is complete", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Executed task",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [
        async () => ({
          decision: "retry",
          problems: ["subagent output was not specific enough"],
        }),
      ],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.status).toBe("blocked");
    expect(result?.stopDecision).toBe("retry");
    expect(harness.getTask(taskId)?.status).toBe("todo");
    expect(attempt.output.problems).toEqual(["subagent output was not specific enough"]);
  });

  test("runner applies stop hooks by task role", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const planner = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const worker = harness.createTask({
      runId,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
    });

    const results = await runReadyTasks({
      harness,
      runId,
      limit: 2,
      stopHooksByRole: {
        planner: [
          async () => ({
            artifacts: [{ kind: "planner_hook" }],
          }),
        ],
        worker: [
          async () => ({
            artifacts: [{ kind: "worker_hook" }],
          }),
        ],
      },
      executorFactory: () => async () => ({
        status: "done",
        summary: "ok",
        artifacts: [],
        checks: [],
        problems: [],
      }),
    });

    const attemptsByTask = new Map(results.map((result) => [result.taskId, harness.getAttempt(result.attemptId)!]));
    expect(attemptsByTask.get(planner)?.output.artifacts).toEqual([{ kind: "planner_hook" }]);
    expect(attemptsByTask.get(worker)?.output.artifacts).toEqual([{ kind: "worker_hook" }]);
  });

  test("context summary archives experience and lesson after successful verifier attempts", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Raw success with noisy implementation notes",
        changedFiles: ["packages/runner/src/runner.ts"],
        artifacts: [],
        checks: [{ name: "bun test", status: "passed" }],
        problems: [],
      }),
      stopHooks: [
        createContextSummaryHook({
          summarize: async ({ output }) => ({
            experience: {
              summary: "Stop hooks can preserve compact context after successful execution.",
              evidence: { checks: output.checks },
            },
            lesson: {
              summary: "No failure pattern found in this successful attempt.",
              evidence: { rawProblems: output.problems ?? [] },
            },
          }),
        }),
      ],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.output.summary).toBe("Stop hooks can preserve compact context after successful execution.");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "context_experience_archive",
      taskId,
      summary: "Stop hooks can preserve compact context after successful execution.",
      evidence: { checks: [{ name: "bun test", status: "passed" }] },
    });
    expect(attempt.output.artifacts).toContainEqual({
      kind: "context_lesson_archive",
      taskId,
      summary: "No failure pattern found in this successful attempt.",
      evidence: { rawProblems: [] },
    });
    expect(harness.listLessons({ runId })).toContainEqual(
      expect.objectContaining({
        kind: "experience",
        summary: "Stop hooks can preserve compact context after successful execution.",
      }),
    );
  });

  test("role hook routing keeps verifier summaries away from worker attempts", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Implemented runner",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooksByRole: {
        verifier: [createContextSummaryHook()],
      },
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.output.summary).toBe("Implemented runner");
    expect(attempt.output.artifacts).not.toContainEqual(
      expect.objectContaining({ kind: "context_experience_archive" }),
    );
  });

  test("context summary turns blocked verifier attempts into compact lessons with raw evidence", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify acpx planner",
      prompt: "Verify the planner through acpx.",
    });
    const rawProblem = "exit code: 124\n\nstderr:\ncommand timed out after 600000ms";

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "acpx codex executor failed",
        artifacts: [],
        checks: [{ name: "acpx codex exec", status: "failed" }],
        problems: [rawProblem],
      }),
      stopHooks: [
        createContextSummaryHook({
          summarize: async ({ output }) => ({
            experience: {
              summary: "No reusable success pattern recorded for the blocked acpx attempt.",
              evidence: { status: output.status },
            },
            lesson: {
              summary: "Bound acpx planner turns with a shorter timeout or a smaller prompt.",
              evidence: { rawProblems: output.problems },
            },
          }),
        }),
      ],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.output.summary).toBe("Bound acpx planner turns with a shorter timeout or a smaller prompt.");
    expect(attempt.output.problems).toEqual([
      "Bound acpx planner turns with a shorter timeout or a smaller prompt.",
      "exit code: 124 stderr: command timed out after 600000ms",
    ]);
    expect(attempt.output.artifacts).toContainEqual({
      kind: "context_lesson_archive",
      taskId,
      summary: "Bound acpx planner turns with a shorter timeout or a smaller prompt.",
      evidence: { rawProblems: [rawProblem] },
    });
    expect(harness.listLessons({ runId })).toContainEqual(
      expect.objectContaining({
        kind: "lesson",
        summary: "Bound acpx planner turns with a shorter timeout or a smaller prompt.",
      }),
    );
  });

  test("context summary derives readable lessons from structured problem objects", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify readable lessons",
      prompt: "Verify the lesson summary.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "structured verifier failure",
        artifacts: [],
        checks: [{ name: "structured verifier", status: "failed" }],
        problems: [
          {
            severity: "high",
            message: "Structured verifier problem needs repair",
            details: { command: "bun test tests/runner.test.ts" },
          } as unknown as string,
        ],
      }),
      stopHooks: [createContextSummaryHook()],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(attempt.taskId).toBe(taskId);
    expect(attempt.output.summary).toContain("Structured verifier problem needs repair");
    expect(attempt.output.summary).toContain("bun test tests/runner.test.ts");
    expect(attempt.output.summary).not.toContain("[object Object]");
    expect(attempt.output.problems?.[0]).not.toContain("[object Object]");
  });

  test("planner stop hook creates next tasks from structured output", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan one task.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned next task",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Implement planner output hook",
            prompt: "Create tasks from planner output.",
            doneWhen: ["tests pass"],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    const next = harness.nextReadyTask(runId);
    expect(result?.stopDecision).toBe("continue");
    expect(next?.role).toBe("worker");
    expect(next?.goal).toBe("Implement planner output hook");
    expect(next?.dependsOn).toEqual([plannerTask]);
    expect(attempt.output.artifacts).toEqual([
      {
        kind: "created_task",
        taskId: next?.id,
        sourceTaskId: plannerTask,
      },
    ]);
  });

  test("planner stop hook creates child runs from structured nextRuns output", async () => {
    const runId = harness.createRun({
      goal: "Intake requirement document",
      context: {
        modelDefaults: {
          global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
          roles: { planner: { model: "gpt-5.6-sol", reasoning_effort: "high" } },
        },
        agentDefaults: { global: "claude-code", roles: { planner: "codex-resumable" } },
        agentBackends: {
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
          "codex-resumable": { kind: "codex-resumable" },
        },
        guardrails: [{ id: "guardrail_1", role: "planner", rule: "cite evidence" }],
      },
    });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Split document into runs",
      prompt: "Read the document and create child runs.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Split into child runs",
        artifacts: [],
        checks: [],
        problems: [],
        nextRuns: [
          {
            goal: "Build React dashboard composer",
            prompt: "Plan the React dashboard composer work.",
            doneWhen: ["composer is planned", "verifier is planned"],
            context: { area: "dashboard" },
            modelPreference: {
              model: "gpt-5.4-mini",
              reason: "planning child run",
            },
          },
        ],
      }),
      stopHooks: [createRunsFromOutputHook({ harness })],
    });

    const childRuns = harness.listRuns({ statuses: ["todo"] }).filter((run) => run.id !== runId);
    const childOverview = harness.getRunOverview({ runId: childRuns[0].id, eventLimit: 0 });
    const childPlanner = childOverview.tasks[0];

    expect(result?.stopDecision).toBe("continue");
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      goal: "Build React dashboard composer",
      context: expect.objectContaining({
        area: "dashboard",
        parentRunId: runId,
        sourceTaskId: plannerTask,
        source: "nextRuns",
        modelDefaults: {
          global: { model: "gpt-5.6-luna", reasoning_effort: "high" },
          roles: { planner: { model: "gpt-5.6-sol", reasoning_effort: "high" } },
        },
        agentDefaults: { global: "claude-code", roles: { planner: "codex-resumable" } },
        agentBackends: expect.objectContaining({
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
          "codex-resumable": { kind: "codex-resumable" },
        }),
        guardrails: [{ id: "guardrail_1", role: "planner", rule: "cite evidence" }],
      }),
    });
    expect(childPlanner).toMatchObject({
      role: "planner",
      goal: "Plan run: Build React dashboard composer",
      prompt: "Plan the React dashboard composer work.",
      doneWhen: ["composer is planned", "verifier is planned"],
      config: {
        modelPreference: {
          model: "gpt-5.4-mini",
          reason: "planning child run",
        },
      },
    });
    expect(harness.getAttempt(result!.attemptId)?.output.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "created_run",
        runId: childRuns[0].id,
        plannerTaskId: childPlanner.id,
        sourceRunId: runId,
        sourceTaskId: plannerTask,
      }),
    );
  });

  test("planner stop hook preserves next task model preference", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan one cheap task.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned cheap task",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Implement with mini model",
            prompt: "Use cheaper model for this task.",
            modelPreference: {
              model: "gpt-5-mini",
              reason: "low risk change",
            },
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const next = harness.nextReadyTask(runId);
    expect(next).toMatchObject({
      role: "worker",
      dependsOn: [plannerTask],
      config: {
        modelPreference: {
          model: "gpt-5-mini",
          reason: "low risk change",
        },
      },
    });
  });

  test("planner stop hook persists next task verifier contract with model preference", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan one contracted task.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned contracted task",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Implement frozen verifier contract",
            prompt: "Persist the planner-supplied verifier contract.",
            modelPreference: {
              model: "gpt-5-mini",
              reason: "focused change",
            },
            verifierContract: {
              successCriteria: ["worker task config stores the contract"],
              deterministicChecks: [
                {
                  name: "runner tests",
                  command: "bun test tests/runner.test.ts",
                  expected: "passes",
                },
              ],
              agentReviewRubric: ["verify prompt cites the frozen contract"],
            },
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const next = harness.nextReadyTask(runId);
    expect(next).toMatchObject({
      role: "worker",
      dependsOn: [plannerTask],
      config: {
        modelPreference: {
          model: "gpt-5-mini",
          reason: "focused change",
        },
        verifierContract: {
          successCriteria: ["worker task config stores the contract"],
          deterministicChecks: [
            {
              name: "runner tests",
              command: "bun test tests/runner.test.ts",
              expected: "passes",
            },
          ],
          agentReviewRubric: ["verify prompt cites the frozen contract"],
        },
      },
    });
  });

  test("planner stop hook resolves next task goal titles in dependsOn", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan dependent tasks.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned dependent tasks",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Implement protocol-level task and role model selection",
            prompt: "Implement model selection.",
          },
          {
            role: "verifier",
            goal: "Verify model selection behavior",
            prompt: "Verify model selection.",
            dependsOn: ["Implement protocol-level task and role model selection"],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 1 });
    const worker = overview.tasks.find((task) => task.goal === "Implement protocol-level task and role model selection")!;
    const verifier = overview.tasks.find((task) => task.goal === "Verify model selection behavior")!;

    expect(verifier.dependsOn).toEqual([worker.id]);
  });

  test("planner stop hook resolves role-prefixed next task goal titles in dependsOn", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan dependent tasks.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned role-prefixed dependencies",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Plumb a run-level goal contract through run.context_json with no schema migration",
            prompt: "Implement goal contract plumbing.",
          },
          {
            role: "verifier",
            goal: "Verify goal contract plumbing",
            prompt: "Verify goal contract plumbing.",
            dependsOn: ["worker:Plumb a run-level goal contract through run.context_json with no schema migration"],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 1 });
    const worker = overview.tasks.find((task) => task.goal === "Plumb a run-level goal contract through run.context_json with no schema migration")!;
    const verifier = overview.tasks.find((task) => task.goal === "Verify goal contract plumbing")!;

    expect(verifier.dependsOn).toEqual([worker.id]);
  });

  test("planner stop hook makes same-batch verifiers wait for producer tasks by default", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan worker and verifier tasks.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned producer and verifier",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Implement dashboard shell",
            prompt: "Implement the dashboard shell.",
          },
          {
            role: "worker",
            goal: "Implement dashboard streaming",
            prompt: "Implement streaming updates.",
          },
          {
            role: "verifier",
            goal: "Verify dashboard behavior",
            prompt: "Verify both dashboard changes.",
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 1 });
    const workers = overview.tasks.filter((task) => task.role === "worker");
    const verifier = overview.tasks.find((task) => task.goal === "Verify dashboard behavior")!;

    expect(workers).toHaveLength(2);
    expect(workers.map((task) => task.dependsOn)).toEqual([[plannerTask], [plannerTask]]);
    expect(verifier.dependsOn).toEqual(workers.map((task) => task.id));
  });

  test("planner stop hook preserves explicit empty verifier dependencies", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan independent verifier and dependent work.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned an independent baseline verifier",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "verifier",
            goal: "Verify baseline first",
            prompt: "Verify the baseline before downstream work.",
            dependsOn: [],
          },
          {
            role: "worker",
            goal: "Implement downstream update",
            prompt: "Implement after baseline verification.",
            dependsOn: ["Verify baseline first"],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 1 });
    const verifier = overview.tasks.find((task) => task.goal === "Verify baseline first")!;
    const worker = overview.tasks.find((task) => task.goal === "Implement downstream update")!;

    expect(verifier.dependsOn).toEqual([]);
    expect(worker.dependsOn).toEqual([verifier.id]);
    expect(overview.tasks.find((task) => task.id === plannerTask)?.status).toBe("done");
  });

  test("goal-review stop hook records reviewed worktree without reusing it as child cwd", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const sourceWorker = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement dashboard candidate",
      prompt: "Implement in a candidate worktree.",
      worktreePath: "/tmp/ouroboros-reviewed-candidate",
    });
    harness.recordAttempt({
      taskId: sourceWorker,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Candidate implemented",
        changedFiles: ["packages/cli/src/dashboard.ts"],
        checks: [{ name: "candidate", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const reviewTask = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review candidate",
      prompt: "Decide whether the candidate is complete.",
      dependsOn: [sourceWorker],
      worktreePath: "/tmp/ouroboros-reviewed-candidate",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        runDecision: "continue",
        summary: "Candidate needs one more repair",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Repair dashboard shell",
            prompt: "Continue from the reviewed candidate worktree.",
            dependsOn: [],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const repair = harness.getRunOverview({ runId, eventLimit: 1 }).tasks.find((task) => task.goal === "Repair dashboard shell")!;
    expect(repair.dependsOn).toEqual([reviewTask]);
    expect(repair.worktreePath).toBeNull();
    expect(repair.config?.sourceWorktreePath).toBe("/tmp/ouroboros-reviewed-candidate");

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: repair,
      dependencyAttempts: [],
    });
    expect(prompt).toContain('"sourceWorktreePath": "/tmp/ouroboros-reviewed-candidate"');
  });

  test("sibling goal-review workers from one source worktree lease separate cwd values under concurrency", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const sourceWorker = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement candidate",
      prompt: "Implement in a source worktree.",
      worktreePath: "/tmp/ouroboros-shared-source",
    });
    harness.recordAttempt({
      taskId: sourceWorker,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Candidate implemented",
        artifacts: [],
        checks: [],
        problems: [],
      },
    });
    const reviewTask = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review candidate",
      prompt: "Create sibling repairs.",
      dependsOn: [sourceWorker],
      worktreePath: "/tmp/ouroboros-shared-source",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        runDecision: "continue",
        summary: "Needs parallel follow-up work",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Repair A",
            prompt: "Use the reviewed source for context.",
            dependsOn: [],
          },
          {
            role: "worker",
            goal: "Repair B",
            prompt: "Use the reviewed source for context.",
            dependsOn: [],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const cwdByTask = new Map<string, string>();
    const results = await runReadyTasks({
      harness,
      runId,
      limit: 2,
      worktreeForTask: (task) => join(dir, "worktrees", task.id),
      executorFactory: ({ cwd }) => async ({ task }) => {
        cwdByTask.set(task.id, cwd);
        return {
          status: "done",
          summary: `Executed ${task.id} in ${cwd}`,
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    const repairTasks = harness
      .getRunOverview({ runId, eventLimit: 1 })
      .tasks.filter((task) => task.goal === "Repair A" || task.goal === "Repair B");
    const cwdValues = repairTasks.map((task) => cwdByTask.get(task.id));

    expect(results.map((result) => result.taskId).sort()).toEqual(repairTasks.map((task) => task.id).sort());
    expect(new Set(cwdValues).size).toBe(2);
    expect(cwdValues).not.toContain("/tmp/ouroboros-shared-source");
    expect(repairTasks.map((task) => task.config?.sourceWorktreePath)).toEqual([
      "/tmp/ouroboros-shared-source",
      "/tmp/ouroboros-shared-source",
    ]);
    expect(repairTasks.map((task) => task.worktreePath).sort()).toEqual(
      repairTasks.map((task) => join(dir, "worktrees", task.id)).sort(),
    );
    expect(harness.getTask(reviewTask)?.worktreePath).toBe("/tmp/ouroboros-shared-source");
  });

  test("planner stop hook blocks unresolved dependsOn instead of creating stuck tasks", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan a task with a bad dependency.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Planned bad task",
        artifacts: [],
        checks: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Generated worker",
            prompt: "Do generated work.",
            dependsOn: ["Missing task title"],
          },
        ],
      }),
      stopHooks: [createTasksFromOutputHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    const overview = harness.getRunOverview({ runId, eventLimit: 1 });

    expect(attempt.output.status).toBe("blocked");
    expect(attempt.output.problems).toEqual([
      'planned task 0 dependsOn "Missing task title" does not match a task id or planned task goal',
    ]);
    expect(overview.tasks.map((task) => task.id)).toEqual([plannerTask]);
  });

  test("records resolved model in attempt input with task, role, and global precedence", async () => {
    const runId = harness.createRun({
      goal: "Build loop",
      context: {
        modelDefaults: {
          global: { model: "gpt-5-codex" },
          roles: {
            worker: { model: "gpt-5-mini" },
          },
        },
      },
    });
    const worker = harness.createTask({
      runId,
      role: "worker",
      goal: "Use role model",
      prompt: "Work.",
    });
    const verifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Use task model",
      prompt: "Verify.",
      config: {
        modelPreference: {
          model: "gpt-5",
        },
      },
    });
    const planner = harness.createTask({
      runId,
      role: "planner",
      goal: "Use global model",
      prompt: "Plan.",
    });

    const seenModels: Array<string | null> = [];
    const results = await runReadyTasks({
      harness,
      runId,
      limit: 3,
      model: "global-flag-model",
      executorFactory: ({ route }) => {
        seenModels.push(route.model?.model ?? null);
        return async () => ({
          status: "done",
          summary: "ok",
          artifacts: [],
          checks: [],
          problems: [],
        });
      },
    });

    const attemptsByTask = new Map(results.map((result) => [result.taskId, harness.getAttempt(result.attemptId)!]));
    expect(seenModels.sort()).toEqual(["gpt-5", "gpt-5-mini", "gpt-5-codex"].sort());
    expect(attemptsByTask.get(worker)?.input.model).toEqual({
      model: "gpt-5-mini",
      source: "role-default",
      role: "worker",
    });
    expect(attemptsByTask.get(verifier)?.input.model).toEqual({
      model: "gpt-5",
      source: "task",
      role: "verifier",
    });
    expect(attemptsByTask.get(planner)?.input.model).toEqual({
      model: "gpt-5-codex",
      source: "run-default",
      role: "planner",
    });
  });

  test("resolves agent backend with task, role, run, cli backend, and executor precedence", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        agentDefaults: {
          global: "global-acpx",
          roles: {
            worker: "role-acpx",
          },
        },
        agentBackends: {
          "task-acpx": { kind: "acpx", agent: "claude" },
          "role-acpx": { kind: "acpx", agent: "claude" },
          "global-acpx": { kind: "acpx", agentCommand: "custom-acp", env: { CUSTOM_ACP_HOME: "/tmp/custom-acp-home" } },
          "raw-claude": { kind: "acpx", agent: "claude", agentCommand: "/opt/acp/claude-agent-acp" },
        },
      },
    };
    const baseTask = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    expect(resolveAgentBackend({ run, task: { ...baseTask, config: { agentBackend: "task-acpx" } } })).toMatchObject({
      id: "task-acpx",
      kind: "acpx",
      agent: "claude",
      source: "task",
    });
    expect(resolveAgentBackend({ run, task: baseTask })).toMatchObject({
      id: "role-acpx",
      kind: "acpx",
      agent: "claude",
      source: "role-default",
    });
    expect(resolveAgentBackend({ run, task: { ...baseTask, role: "planner" } })).toMatchObject({
      id: "global-acpx",
      kind: "acpx",
      agentCommand: "custom-acp",
      env: { CUSTOM_ACP_HOME: "/tmp/custom-acp-home" },
      source: "run-default",
    });
    expect(resolveAgentBackend({ run, task: { ...baseTask, config: { agentBackend: "raw-claude" } } })).toMatchObject({
      id: "raw-claude",
      kind: "acpx",
      agent: "claude",
      agentCommand: "/opt/acp/claude-agent-acp",
      source: "task",
    });
    expect(resolveAgentBackend({ run: { ...run, context: {} }, task: baseTask, cliAgentBackend: "claude" })).toMatchObject({
      id: "claude",
      kind: "acpx",
      agent: "claude",
      source: "cli-agent-backend",
    });
    expect(resolveAgentBackend({ run: { ...run, context: {} }, task: baseTask, cliAgentBackend: "claude-code" })).toMatchObject({
      id: "claude-code",
      kind: "acpx",
      agent: "claude",
      source: "cli-agent-backend",
    });
    expect(resolveAgentBackend({ run: { ...run, context: {} }, task: baseTask, cliExecutor: "codex-cli" })).toMatchObject({
      id: "codex-cli",
      kind: "codex-cli",
      source: "cli-executor",
    });
  });

  test("resolves execution route with backend model and execution mode", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        modelDefaults: {
          global: { model: "gpt-5", reason: "global codex default" },
          roles: {
            worker: {
              model: "gpt-5.4-mini",
              reason: "cheap worker",
              base_url: "https://api.example.test/v1",
              env_key: "OPENAI_API_KEY",
            },
            verifier: { model: "gpt-5.5", reason: "strong verifier" },
          },
        },
        agentDefaults: {
          global: "claude-code",
          roles: {
            verifier: "codex-resumable",
          },
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {},
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    expect(resolveExecutionRoute({ run, task, cliExecutor: "codex-resumable" })).toMatchObject({
      role: "worker",
      executionMode: "generic",
      backend: {
        id: "claude-code",
        kind: "acpx",
        agent: "claude",
        source: "run-default",
      },
      model: null,
    });
    expect(resolveExecutionRoute({ run, task: { ...task, role: "verifier" }, cliExecutor: "codex-cli" })).toMatchObject({
      role: "verifier",
      executionMode: "codex-resumable",
      backend: {
        id: "codex-resumable",
        kind: "codex-resumable",
        source: "role-default",
      },
      model: {
        model: "gpt-5.5",
        reason: "strong verifier",
        source: "role-default",
        role: "verifier",
      },
    });
  });

  test("allows explicit task model preference for Claude Code routes", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        agentDefaults: {
          global: "claude-code",
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {
        modelPreference: {
          model: "sonnet",
          reason: "explicit claude override",
        },
      },
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    expect(resolveExecutionRoute({ run, task, globalModel: "gpt-5.4-mini" })).toMatchObject({
      backend: {
        id: "claude-code",
        kind: "acpx",
        agent: "claude",
        source: "run-default",
      },
      model: {
        model: "sonnet",
        reason: "explicit claude override",
        source: "task",
        role: "worker",
      },
    });
  });

  test("drops inherited Codex models when the reserved Claude backend uses a raw agent command", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        modelDefaults: {
          global: { model: "gpt-5.6-luna", provider: "openai" },
          roles: { worker: { model: "gpt-5.4-mini", provider: "openai" } },
        },
        agentDefaults: { global: "claude-code" },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agentCommand: "/opt/acp/claude-agent-acp",
          },
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {},
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    for (const route of [
      resolveExecutionRoute({ run, task }),
      resolveExecutionRoute({
        run: {
          ...run,
          context: {
            ...run.context,
            modelDefaults: { global: run.context.modelDefaults.global },
          },
        },
        task,
      }),
      resolveExecutionRoute({
        run: { ...run, context: { ...run.context, modelDefaults: {} } },
        task,
        globalModel: "gpt-5.6-luna",
      }),
    ]) {
      expect(route.backend).toMatchObject({
        id: "claude-code",
        kind: "acpx",
        agent: "claude",
        agentCommand: "/opt/acp/claude-agent-acp",
        source: "run-default",
      });
      expect(route.model).toBeNull();
    }
  });

  test("passes an explicit provider-compatible task model to a raw Claude backend", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        agentDefaults: { global: "raw-claude" },
        agentBackends: {
          "raw-claude": {
            kind: "acpx",
            agent: "claude",
            agentCommand: "/opt/acp/claude-agent-acp",
          },
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {
        modelPreference: {
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          reason: "explicit Claude override",
        },
      },
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    expect(resolveExecutionRoute({ run, task })).toMatchObject({
      backend: {
        id: "raw-claude",
        kind: "acpx",
        agent: "claude",
        agentCommand: "/opt/acp/claude-agent-acp",
      },
      model: {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        source: "task",
        role: "worker",
      },
    });
  });

  test("drops a task model explicitly declared for an incompatible Claude provider", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        agentDefaults: { global: "claude-code" },
        agentBackends: {
          "claude-code": {
            kind: "acpx",
            agentCommand: "/opt/acp/claude-agent-acp",
          },
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {
        modelPreference: {
          model: "gpt-5.6-luna",
          provider: "openai",
        },
      },
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    expect(resolveExecutionRoute({ run, task })).toMatchObject({
      backend: {
        id: "claude-code",
        kind: "acpx",
        agent: "claude",
        agentCommand: "/opt/acp/claude-agent-acp",
      },
      model: null,
    });
  });

  test("does not infer a Claude provider from a raw ACP command string", () => {
    const run = {
      id: "run_1",
      projectId: null,
      projectRoot: null,
      goal: "Build loop",
      status: "todo" as const,
      context: {
        modelDefaults: { global: { model: "gpt-5.6-luna", provider: "openai" } },
        agentDefaults: { global: "custom-acp" },
        agentBackends: {
          "custom-acp": {
            kind: "acpx",
            agentCommand: "/opt/acp/path-with-claude-in-its-name",
          },
        },
      },
    };
    const task = {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "todo" as const,
      role: "worker",
      goal: "Work",
      prompt: "Work.",
      dependsOn: [],
      doneWhen: [],
      config: {},
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    };

    const route = resolveExecutionRoute({ run, task });
    expect(route.backend.agent).toBeUndefined();
    expect(route.backend.agentCommand).toBe("/opt/acp/path-with-claude-in-its-name");
    expect(route.model).toMatchObject({
      model: "gpt-5.6-luna",
      provider: "openai",
      source: "run-default",
    });
  });

  test("records resolved backend in attempt input", async () => {
    const runId = harness.createRun({
      goal: "Build loop",
      context: {
        agentDefaults: {
          roles: {
            worker: "claude-code",
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use Claude Code",
      prompt: "Work.",
    });

    const result = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      model: "global-model",
      executorFactory: () => async () => ({
        status: "done",
        summary: "ok",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      cliExecutor: "codex-cli",
      attemptInput: ({ cwd, route }) => {
        return {
          route,
          backend: route.backend,
          cwd,
          model: route.model,
        };
      },
    });

    expect(harness.getAttempt(result[0].attemptId)?.input).toMatchObject({
      sessionName: `task-${taskId}`,
      cwd: process.cwd(),
      backend: {
        id: "claude-code",
        kind: "acpx",
        agent: "claude",
        source: "role-default",
      },
      route: {
        role: "worker",
        executionMode: "generic",
        backend: {
          id: "claude-code",
          kind: "acpx",
        },
        model: null,
      },
      model: null,
    });
  });

  test("runs a raw ACPX backend through an explicit persistent prompt command", async () => {
    const agentCommand = "/opt/acp/claude-agent-acp";
    const runId = harness.createRun({
      goal: "Run a persistent raw ACP adapter",
      context: {
        modelDefaults: { global: { model: "gpt-5.6-luna", provider: "openai" } },
        agentDefaults: { roles: { worker: "claude-code" } },
        agentBackends: {
          "claude-code": { kind: "acpx", agentCommand, approval: "approve-all", format: "quiet" },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use the raw ACP adapter",
      prompt: "Work through the persistent session.",
    });
    const calls: string[][] = [];
    let showCalls = 0;

    const [result] = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      sessionForTask: () => "raw-session",
      executorFactory: ({ cwd, route }) => createRouteExecutor({
        cwd,
        route,
        runCommand: async ({ cmd }) => {
          calls.push(cmd);
          if (cmd.includes("show")) {
            showCalls += 1;
            return showCalls === 1
              ? { exitCode: 1, stdout: "", stderr: "missing session" }
              : { exitCode: 0, stdout: "session exists", stderr: "" };
          }
          if (cmd.includes("new")) {
            return { exitCode: 0, stdout: "created", stderr: "" };
          }
          if (cmd.includes("prompt")) {
            return {
              exitCode: 0,
              stdout: '{"status":"done","summary":"raw persistent ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
              stderr: "",
            };
          }
          return { exitCode: 2, stdout: "", stderr: "error: unknown option '-s'" };
        },
      }),
    });

    expect(harness.getTask(taskId)?.status).toBe("done");
    expect(harness.getAttempt(result.attemptId)?.output).toMatchObject({
      status: "done",
      summary: "raw persistent ok",
    });
    expect(harness.getAttempt(result.attemptId)?.input).toMatchObject({
      sessionName: "raw-session",
      route: {
        backend: { id: "claude-code", kind: "acpx", agent: "claude", agentCommand },
        model: null,
      },
      model: null,
    });
    expect(calls.every((cmd) => !cmd.includes("--model") && !cmd.includes("gpt-5.6-luna"))).toBe(true);
    expect(calls.at(-1)).toEqual([
      "acpx",
      "--cwd",
      process.cwd(),
      "--approve-all",
      "--format",
      "quiet",
      "--agent",
      agentCommand,
      "prompt",
      "-s",
      "raw-session",
      "-f",
      "-",
    ]);
  });

  test("worker stop hook creates a verifier task", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const workerTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Implemented runner",
        changedFiles: ["packages/runner/src/runner.ts"],
        artifacts: [{ kind: "commit", sha: "abc123" }],
        checks: [{ name: "bun test", status: "passed" }],
        problems: [],
      }),
      stopHooks: [createVerifierTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    const verifier = harness.nextReadyTask(runId)!;
    expect(result?.stopDecision).toBe("continue");
    expect(verifier.role).toBe("verifier");
    expect(verifier.goal).toBe("Verify: Implement runner");
    expect(verifier.dependsOn).toEqual([workerTask]);
    expect(verifier.prompt).toContain(`Source Task ID: ${workerTask}`);
    expect(verifier.prompt).toContain("Source Worktree Path: not recorded");
    expect(verifier.prompt).toContain("Implemented runner");
    expect(verifier.prompt).toContain("packages/runner/src/runner.ts");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_verifier_task",
      taskId: verifier.id,
      sourceTaskId: workerTask,
      sourceWorktreePath: null,
    });
  });

  test("worker stop hook records the source worktree for verifier tasks", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const workerTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement in worktree",
      prompt: "Change files in the task worktree.",
    });

    const results = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      worktreeForTask: () => "/tmp/ouroboros-source-worktree",
      executorFactory: () => async () => ({
        status: "done",
        summary: "Implemented in source worktree",
        changedFiles: ["packages/cli/src/dashboard.ts"],
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [createVerifierTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(results[0].attemptId)!;
    const verifier = harness.nextReadyTask(runId)!;
    expect(verifier.worktreePath).toBe("/tmp/ouroboros-source-worktree");
    expect(verifier.prompt).toContain("Source Worktree Path: /tmp/ouroboros-source-worktree");
    expect(verifier.prompt).toContain('"worktreePath": "/tmp/ouroboros-source-worktree"');
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_verifier_task",
      taskId: verifier.id,
      sourceTaskId: workerTask,
      sourceWorktreePath: "/tmp/ouroboros-source-worktree",
    });
  });

  test("worker stop hook injects frozen verifier contract into verifier prompt and artifact", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const verifierContract = {
      successCriteria: ["created verifier prompt contains this exact criterion"],
      deterministicChecks: [
        {
          name: "runner tests",
          command: "bun test tests/runner.test.ts",
          expected: "passes",
          required: true,
        },
      ],
      agentReviewRubric: ["review against persisted task config"],
    };
    const workerTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement contracted worker",
      prompt: "Do contracted work.",
      config: { verifierContract },
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Implemented contracted worker",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [createVerifierTaskHook({ harness })],
    });

    const verifier = harness.nextReadyTask(runId)!;
    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(verifier.prompt).toContain("## Frozen Verifier Contract");
    expect(verifier.prompt).toContain("## Runtime File Guardrail");
    expect(verifier.prompt).toContain(".ouroboros/");
    expect(verifier.prompt).toContain("created verifier prompt contains this exact criterion");
    expect(verifier.prompt).toContain("bun test tests/runner.test.ts");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_verifier_task",
      taskId: verifier.id,
      sourceTaskId: workerTask,
      sourceWorktreePath: null,
      verifierContract,
    });
  });

  test("verifier task hook uses the database template", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.setPromptTemplate({
      key: "verifier-task",
      contentMd: "Custom verifier for {{sourceTaskId}}: {{sourceSummary}}",
    });
    const workerTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Implemented runner",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [createVerifierTaskHook({ harness })],
    });

    expect(harness.nextReadyTask(runId)?.prompt).toBe(`Custom verifier for ${workerTask}: Implemented runner`);
  });

  test("verifier stop hook does not create verifier tasks for verifier attempts", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done",
        summary: "Verified runner",
        artifacts: [],
        checks: [],
        problems: [],
      }),
      stopHooks: [createVerifierTaskHook({ harness })],
    });

    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
  });

  test("blocked verifier stop hook creates a ready repair task", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Verification failed",
        artifacts: [{ kind: "log", path: "verify.log" }],
        checks: [{ name: "bun test", status: "failed" }],
        problems: ["runner test failed"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    const repair = harness.nextReadyTask(runId)!;
    expect(result?.stopDecision).toBe("continue");
    expect(repair.role).toBe("worker");
    expect(repair.goal).toBe("Repair: Verify runner");
    expect(repair.parentId).toBe(verifierTask);
    expect(repair.dependsOn).toEqual([]);
    expect(repair.prompt).toContain(`Verifier Task ID: ${verifierTask}`);
    expect(repair.prompt).toContain("runner test failed");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_repair_task",
      taskId: repair.id,
      verifierTaskId: verifierTask,
    });
  });

  test("blocked repair verifier stop hook does not create recursive repair tasks for the same branch", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const originalVerifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });
    const repairWorker = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair: Verify runner",
      prompt: "Repair the verifier failure.",
      parentId: originalVerifier,
    });
    const repairVerifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify repair",
      prompt: "Verify the repair.",
      parentId: repairWorker,
      dependsOn: [repairWorker],
    });

    const result = await createRepairTaskHook({ harness })({
      run: harness.getRun(runId)!,
      task: harness.getTask(repairVerifier)!,
      sessionName: "repair-verifier",
      prompt: "Verify the repair.",
      output: {
        status: "blocked",
        summary: "Repair still does not satisfy the original verifier.",
        artifacts: [],
        checks: [{ name: "repair verification", status: "failed" }],
        problems: ["same blocked branch still failing"],
      },
    });

    const repairChildren = harness.getRunOverview({ runId }).tasks.filter((task) => task.parentId === repairVerifier);
    expect(result.decision).toBe("exit");
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      kind: "repair_skipped_recursive_branch",
      verifierTaskId: repairVerifier,
      originalVerifierTaskId: originalVerifier,
    }));
    expect(repairChildren).toEqual([]);
  });

  test("blocked verifier stop hook binds repair to the verified source worktree", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const sourceWorktreePath = "/tmp/ouroboros-repair-source-worktree";
    const workerTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement in source worktree",
      prompt: "Change files in the task worktree.",
      worktreePath: sourceWorktreePath,
    });
    harness.recordAttempt({
      taskId: workerTask,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Implemented in source worktree",
        changedFiles: ["packages/cli/src/dashboard.ts"],
        artifacts: [],
        checks: [],
        problems: [],
      },
    });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify source worktree",
      prompt: "Verify the runner.",
      dependsOn: [workerTask],
      worktreePath: sourceWorktreePath,
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Verification failed",
        artifacts: [{ kind: "log", path: "verify.log" }],
        checks: [{ name: "bun test", status: "failed" }],
        problems: ["runner test failed"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    const repair = harness.nextReadyTask(runId)!;
    expect(result?.stopDecision).toBe("continue");
    expect(repair.role).toBe("worker");
    expect(repair.parentId).toBe(verifierTask);
    expect(repair.dependsOn).toEqual([workerTask]);
    expect(repair.worktreePath).toBe(sourceWorktreePath);
    expect(repair.prompt).toContain(`Source Task ID: ${workerTask}`);
    expect(repair.prompt).toContain(`Source Worktree Path: ${sourceWorktreePath}`);
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_repair_task",
      taskId: repair.id,
      verifierTaskId: verifierTask,
      sourceTaskId: workerTask,
      sourceWorktreePath,
    });
  });

  test("blocked verifier stop hook skips repair for external setup blockers", async () => {
    const runId = harness.createRun({ goal: "Prove Claude Code support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Claude Code readiness",
      prompt: "Verify Claude Code.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Claude Code readiness is blocked by an external setup blocker.",
        artifacts: [
          {
            kind: "external_setup_blocker",
            command: "bun run scripts/acpx-agent-smoke.ts claude-code --doctor",
            diagnostic: "setup blocker: install Claude Code CLI or expose claude on the normalized child PATH",
          },
        ],
        checks: [{ name: "Claude Code doctor", status: "failed", evidence: "missing command: claude" }],
        problems: ["missing command: claude; install or expose it on PATH"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output.artifacts).toContainEqual({
      kind: "repair_skipped_external_setup_blocker",
      verifierTaskId: verifierTask,
      reason: "external setup blocker",
    });
  });

  test("blocked verifier stop hook skips repair for acpx auth setup blockers", async () => {
    const runId = harness.createRun({ goal: "Prove Claude Code support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Claude Code auth",
      prompt: "Verify Claude Code acpx auth.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Claude Code ACP is available, but acpx auth is not configured.",
        artifacts: [
          {
            kind: "external_setup_blocker",
            command: "bun run scripts/acpx-agent-smoke.ts claude-code --doctor",
            diagnostic:
              "setup blocker: acpx auth missing for Claude Code; add auth.custom or export ACPX_AUTH_CUSTOM",
          },
        ],
        checks: [{ name: "Claude Code ACP check", status: "passed", evidence: "Claude Code ACP adapter OK" }],
        problems: ["setup blocker: acpx auth missing for Claude Code"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output.artifacts).toContainEqual({
      kind: "repair_skipped_external_setup_blocker",
      verifierTaskId: verifierTask,
      reason: "external setup blocker",
    });
  });

  test("blocked verifier stop hook treats setup auth text as external even without artifact kind", async () => {
    const runId = harness.createRun({ goal: "Prove Claude Code support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Claude Code auth",
      prompt: "Verify Claude Code acpx auth.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "setup blocker: acpx auth missing for Claude Code",
        problems: ["add auth.custom before enabling execution"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output.artifacts).toContainEqual({
      kind: "repair_skipped_external_setup_blocker",
      verifierTaskId: verifierTask,
      reason: "setup blocker requires external environment change",
    });
  });

  test("blocked verifier stop hook skips repair for provider connection blockers", async () => {
    const runId = harness.createRun({ goal: "Prove Claude Code support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Claude Code smoke",
      prompt: "Verify Claude Code acpx read-only prompt.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Claude Code ACP/acpx read-only prompt readiness remains unproven because provider connectivity failed.",
        checks: [
          {
            name: "bun run scripts/acpx-agent-smoke.ts claude-code",
            status: "failed",
            evidence: "API call failed after 3 retries: Connection error.",
          },
        ],
        problems: ["Claude Code smoke reached session/new, then the provider returned APIConnectionError."],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output.artifacts).toContainEqual({
      kind: "repair_skipped_external_setup_blocker",
      verifierTaskId: verifierTask,
      reason: "provider connectivity requires external environment change",
    });
  });

  test("blocked verifier stop hook skips repair for local resource exhaustion blockers", async () => {
    const runId = harness.createRun({ goal: "Verify supervisor hardening" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify typecheck",
      prompt: "Verify typecheck.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Required typecheck could not be verified because tsc was killed by SIGKILL.",
        checks: [
          {
            name: "typecheck",
            status: "failed",
            evidence: "bun run typecheck and tsc --noEmit were killed with exit code 137/SIGKILL.",
          },
        ],
        problems: ["typecheck was killed with exit code 137"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const attempt = harness.getAttempt(result!.attemptId)!;
    expect(result?.stopDecision).toBe("exit");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output.artifacts).toContainEqual({
      kind: "repair_skipped_external_setup_blocker",
      verifierTaskId: verifierTask,
      reason: "local verification resource limit requires external environment change",
    });
  });

  test("goal-review hook patches an explicitly written runDecision from readable text", async () => {
    const runId = harness.createRun({ goal: "Configure worker model defaults" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary: "Implementation and tests passed; runDecision complete.",
        changedFiles: [],
        checks: [{ name: "tests", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook patches a labeled decision from readable text", async () => {
    const runId = harness.createRun({ goal: "Complete intake workflow" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary: "Checks passed. Decision: complete.",
        changedFiles: [],
        checks: [{ name: "tests", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook patches a runDecision artifact value", async () => {
    const runId = harness.createRun({ goal: "Complete self iteration" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary: "All evidence is complete.",
        changedFiles: [],
        checks: [{ name: "tests", status: "passed" }],
        artifacts: [{ kind: "runDecision", value: "complete" }],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook patches an explicit run goal met summary", async () => {
    const runId = harness.createRun({ goal: "Complete self iteration" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary: "Run goal met. All required checks passed.",
        changedFiles: [],
        checks: [{ name: "tests", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook patches evidence-backed verification completion text", async () => {
    const runId = harness.createRun({ goal: "Complete PAN-869 source-worktree verification" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary:
          "PAN-869 source-worktree verification is complete. typecheck, contracts, build, and gate-lite passed.",
        changedFiles: [],
        checks: [
          { name: "typecheck", status: "passed" },
          { name: "contracts", status: "passed" },
          { name: "build", status: "passed" },
          { name: "gate-lite", status: "passed" },
        ],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook patches evidence-backed ticket completion text", async () => {
    const runId = harness.createRun({ goal: "Complete PAN-869 antd 6 warning cleanup" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary:
          "PAN-869 is complete: repository changes remove the remaining antd 6 deprecated first-screen APIs from platform_admin accounts/troubleshoot.",
        changedFiles: [],
        checks: [
          { name: "typecheck", status: "passed", evidence: "npm --prefix apps/platform_admin run typecheck passed" },
          {
            name: "contracts",
            status: "passed",
            evidence: "npm --prefix apps/platform_admin run test:contracts passed, 15/15",
          },
          { name: "build", status: "passed", evidence: "npm --prefix apps/platform_admin run build passed" },
          { name: "gate-lite", status: "passed", evidence: "bash scripts/gate-lite.sh auto passed" },
          {
            name: "antd deprecated API scan",
            status: "passed",
            evidence: "rg found no List width valueStyle Alert message direction or bordered usage in touched files",
          },
        ],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("done");
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "complete",
    });
  });

  test("goal-review hook does not infer complete from vague implementation completion", async () => {
    const runId = harness.createRun({ goal: "Complete PAN-869 source-worktree verification" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        summary: "Implementation is complete.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(attempt.output).toMatchObject({
      status: "blocked",
      problems: expect.arrayContaining(["goal-review output must include runDecision"]),
    });
  });

  test("goal-review defer blocks the run without follow-up tasks", async () => {
    const runId = harness.createRun({ goal: "Prove external provider readiness" });
    const taskId = harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Review the goal.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [createGoalReviewDecisionHook({ harness })],
      },
      executor: async () => ({
        status: "done",
        runDecision: "defer",
        summary: "Provider connectivity is down; wait for external recovery.",
        changedFiles: [],
        checks: [{ name: "provider smoke", status: "failed" }],
        artifacts: [],
        problems: ["API call failed after 3 retries."],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;

    expect(result?.taskId).toBe(taskId);
    expect(harness.getRun(runId)?.status).toBe("blocked");
    expect(harness.nextReadyTask(runId)).toBeNull();
    expect(attempt.output).toMatchObject({
      status: "done",
      runDecision: "defer",
    });
  });

  test("goal-review refresh hook surfaces repeated lesson guardrail proposals without auto-accepting", async () => {
    const lessonSummary = "Refresh hook must promote repeated blocked lessons during goal-review drain";
    const runId = harness.createRun({
      goal: "Refresh proposals during goal-review drain",
      context: {
        guardrails: [
          {
            id: "guardrail_existing",
            summary: "Preserve accepted guardrails.",
            source: "manual",
            active: true,
            accepted: true,
            acceptedBy: "manual",
            acceptedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const firstBlocked = harness.createTask({
      runId,
      role: "worker",
      goal: "First blocked worker",
      prompt: "Block with a repeated lesson.",
    });
    const secondBlocked = harness.createTask({
      runId,
      role: "worker",
      goal: "Second blocked worker",
      prompt: "Block with the same repeated lesson.",
    });
    harness.recordAttempt({
      taskId: firstBlocked,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [lessonSummary] },
    });
    harness.recordAttempt({
      taskId: secondBlocked,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [`${lessonSummary}.`] },
    });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "Review whether the run goal is complete",
      prompt: "Return runDecision continue with a follow-up worker task.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [
          createGoalReviewDecisionHook({ harness }),
          createTasksFromOutputHook({ harness }),
          createRefreshGuardrailProposalsHook({ harness }),
        ],
      },
      executor: async () => ({
        status: "done",
        runDecision: "continue",
        summary: "Goal needs another worker pass.",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed" }],
        artifacts: [],
        problems: [],
        nextTasks: [
          {
            role: "worker",
            goal: "Follow-up worker",
            prompt: "Apply the candidate guardrail once accepted.",
          },
        ],
      }),
    });
    const attempt = harness.getAttempt(result!.attemptId)!;
    const overview = harness.getRunOverview({ runId });
    const proposals = (overview.run?.context.guardrailProposals ?? []) as Array<Record<string, unknown>>;
    const proposal = proposals[0];

    expect(result?.stopDecision).toBe("continue");
    expect(attempt.output.runDecision).toBe("continue");
    expect(overview.run?.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_existing", active: true, accepted: true }),
    ]);
    expect(proposal).toMatchObject({
      summary: lessonSummary,
      count: 2,
      source: "lesson",
      active: false,
      accepted: false,
    });
    expect(proposals).toHaveLength(1);
    expect(attempt.output.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "guardrail_proposals",
        runId,
        proposed: 1,
      }),
    );
    expect(overview.tasks.some((task) => task.role === "worker" && task.status === "todo")).toBe(true);
  });

  test("goal-review refresh hook preserves accepted proposal metadata and skips experiences", async () => {
    const acceptedLessonSummary = "Already accepted lesson proposal keeps its accepted metadata";
    const experienceSummary = "Reusable experience should remain evidence, not a guardrail";
    const runId = harness.createRun({
      goal: "Keep accepted proposals intact during refresh",
      context: {
        guardrails: [
          {
            id: "guardrail_manual",
            summary: "Preserve manually accepted guardrails.",
            source: "manual",
            active: true,
            accepted: true,
            acceptedBy: "manual",
            acceptedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const firstBlocked = harness.createTask({
      runId,
      role: "worker",
      goal: "First blocked worker",
      prompt: "Trigger the accepted lesson.",
    });
    const secondBlocked = harness.createTask({
      runId,
      role: "worker",
      goal: "Second blocked worker",
      prompt: "Trigger the accepted lesson again.",
    });
    harness.recordAttempt({
      taskId: firstBlocked,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [acceptedLessonSummary] },
    });
    harness.recordAttempt({
      taskId: secondBlocked,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [`${acceptedLessonSummary}.`] },
    });
    const successTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Succeed and record experience",
      prompt: "Succeed while recording an experience lesson.",
    });
    harness.recordAttempt({
      taskId: successTask,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: experienceSummary,
        changedFiles: [],
        checks: [{ name: "experience", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.createTask({
      runId,
      role: "goal-review",
      goal: "First review",
      prompt: "Return runDecision continue with a follow-up worker task.",
    });

    const firstResult = await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [
          createGoalReviewDecisionHook({ harness }),
          createTasksFromOutputHook({ harness }),
          createRefreshGuardrailProposalsHook({ harness }),
        ],
      },
      executor: async () => ({
        status: "done",
        runDecision: "continue",
        summary: "Need another pass.",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed" }],
        artifacts: [],
        problems: [],
        nextTasks: [
          {
            role: "goal-review",
            goal: "Second review",
            prompt: "Return runDecision complete.",
          },
        ],
      }),
    });

    const overviewAfterFirst = harness.getRunOverview({ runId });
    const proposalsAfterFirst = (overviewAfterFirst.run?.context.guardrailProposals ?? []) as Array<Record<string, unknown>>;
    const proposalId = proposalsAfterFirst[0]?.id as string;
    expect(proposalId).toEqual(expect.any(String));
    expect(proposalsAfterFirst[0]).toMatchObject({
      summary: acceptedLessonSummary,
      count: 2,
      active: false,
      accepted: false,
    });
    const proposalSummariesAfterFirst = proposalsAfterFirst.map((proposal) => proposal.summary);
    expect(proposalSummariesAfterFirst).not.toContain(experienceSummary);

    const accepted = acceptGuardrailProposal({
      context: overviewAfterFirst.run!.context,
      proposalId,
      acceptedBy: "goal-review",
      acceptedAt: "2026-02-01T00:00:00.000Z",
    });
    harness.updateRun({
      runId,
      contextPatch: {
        guardrails: accepted!.nextGuardrails,
        guardrailProposals: accepted!.nextProposals,
      },
    });

    const thirdBlocked = harness.createTask({
      runId,
      role: "worker",
      goal: "Third blocked worker",
      prompt: "Trigger the accepted lesson a third time.",
    });
    harness.recordAttempt({
      taskId: thirdBlocked,
      input: { executor: "test" },
      output: { status: "blocked", summary: "Blocked", problems: [`${acceptedLessonSummary}!`] },
    });

    await runNextReadyTask({
      harness,
      runId,
      stopHooksByRole: {
        "goal-review": [
          createGoalReviewDecisionHook({ harness }),
          createTasksFromOutputHook({ harness }),
          createRefreshGuardrailProposalsHook({ harness }),
        ],
      },
      executor: async () => ({
        status: "done",
        runDecision: "complete",
        summary: "Goal complete.",
        changedFiles: [],
        checks: [{ name: "goal review", status: "passed" }],
        artifacts: [],
        problems: [],
      }),
    });

    expect(firstResult?.stopDecision).toBe("continue");
    const overview = harness.getRunOverview({ runId });
    const proposals = (overview.run?.context.guardrailProposals ?? []) as Array<Record<string, unknown>>;
    expect(overview.run?.status).toBe("done");
    expect(overview.run?.context.guardrails).toEqual([
      expect.objectContaining({ id: "guardrail_manual", active: true, accepted: true }),
      expect.objectContaining({ id: proposalId, active: true, accepted: true }),
    ]);
    const refreshedProposal = proposals.find((proposal) => proposal.id === proposalId);
    expect(refreshedProposal).toMatchObject({
      id: proposalId,
      count: 3,
      active: false,
      accepted: true,
      acceptedBy: "goal-review",
      acceptedAt: "2026-02-01T00:00:00.000Z",
    });
    const proposalSummaries = proposals.map((proposal) => proposal.summary);
    expect(proposalSummaries).not.toContain(experienceSummary);
  });

  test("repair task hook uses the database template", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.setPromptTemplate({
      key: "repair-task",
      contentMd: "Custom repair for {{verifierTaskId}}: {{verifierProblemsJson}}",
    });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Verification failed",
        artifacts: [],
        checks: [],
        problems: ["missing regression test"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    expect(harness.nextReadyTask(runId)?.prompt).toContain(`Custom repair for ${verifierTask}`);
    expect(harness.nextReadyTask(runId)?.prompt).toContain("missing regression test");
  });

  test("repair task hook default prompt protects Ouroboros runtime files", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Verification failed",
        artifacts: [],
        checks: [],
        problems: ["unexpected .ouroboros runtime file"],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const repair = harness.nextReadyTask(runId)!;
    expect(repair.prompt).toContain("## Runtime File Guardrail");
    expect(repair.prompt).toContain("Do not modify, delete, recreate, clean, commit, or report these paths as task changedFiles.");
  });

  test("repair task hook renders structured verifier summaries as readable text", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.setPromptTemplate({
      key: "repair-task",
      contentMd: "Custom repair for {{verifierTaskId}}: {{verifierSummary}}\n{{verifierProblemsJson}}",
    });
    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify runner",
      prompt: "Verify the runner.",
    });

    await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: {
          summary: "Verification could not prove completion",
          details: { command: "bun test tests/runner.test.ts" },
        } as unknown as string,
        artifacts: [],
        checks: [],
        problems: [
          {
            message: "missing regression test",
            details: { path: "tests/runner.test.ts" },
          } as unknown as string,
        ],
      }),
      stopHooks: [createRepairTaskHook({ harness })],
    });

    const prompt = harness.nextReadyTask(runId)?.prompt ?? "";
    expect(prompt).toContain("Verification could not prove completion");
    expect(prompt).toContain("bun test tests/runner.test.ts");
    expect(prompt).toContain("missing regression test");
    expect(prompt).toContain("tests/runner.test.ts");
    expect(prompt).not.toContain("[object Object]");
  });

  test("parses valid planner next tasks", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned",
        nextTasks: [
          {
            role: "worker",
            goal: "Implement validation",
            prompt: "Validate nextTasks before task creation.",
            dependsOn: ["task_1"],
            doneWhen: ["tests pass"],
          },
        ],
      }),
    );

    expect(output.nextTasks).toEqual([
      {
        role: "worker",
        goal: "Implement validation",
        prompt: "Validate nextTasks before task creation.",
        dependsOn: ["task_1"],
        doneWhen: ["tests pass"],
      },
    ]);
  });

  test("parses object summaries and problem entries into readable text", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "blocked",
        summary: {
          summary: "Verifier could not prove completion",
          status: "blocked",
          details: { command: "bun test tests/runner.test.ts" },
        },
        problems: [
          {
            severity: "high",
            path: "packages/runner/src/executors/output.ts",
            message: "Problem entries were rendered as objects",
            details: { command: "bun test tests/runner.test.ts", status: "failed" },
          },
        ],
      }),
    );

    expect(output.summary).toContain("Verifier could not prove completion");
    expect(output.summary).toContain("bun test tests/runner.test.ts");
    expect(output.summary).not.toContain("[object Object]");
    expect(output.problems?.[0]).toContain("Problem entries were rendered as objects");
    expect(output.problems?.[0]).toContain("packages/runner/src/executors/output.ts");
    expect(output.problems?.[0]).toContain("high");
    expect(output.problems?.[0]).not.toContain("[object Object]");
  });

  test("parses optional planner next task verifier contracts", () => {
    const verifierContract = {
      successCriteria: ["tests pass"],
      deterministicChecks: [{ name: "runner tests", expected: "passes" }],
      agentReviewRubric: ["contract is included in verifier prompt"],
      requiredArtifacts: ["created_verifier_task artifact"],
    };
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned",
        actions: [
          createTasksAction([
            {
              role: "worker",
              goal: "Implement verifier contract path",
              prompt: "Persist contract and inject it.",
              verifierContract,
            },
          ]),
        ],
      }),
    );

    expect(output.nextTasks?.[0]).toEqual({
      role: "worker",
      goal: "Implement verifier contract path",
      prompt: "Persist contract and inject it.",
      dependsOn: undefined,
      doneWhen: undefined,
      modelPreference: undefined,
      verifierContract,
    });
  });

  test("keeps planner next tasks compatible when verifier contract is omitted", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned",
        nextTasks: [
          {
            role: "worker",
            goal: "Implement without verifier contract",
            prompt: "Keep old planner output working.",
          },
        ],
      }),
    );

    expect(output.nextTasks?.[0]?.verifierContract).toBeUndefined();
  });

  test("parses valid planner next runs", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned runs",
        nextRuns: [
          {
            goal: "Build React dashboard composer",
            prompt: "Plan the child run.",
            doneWhen: ["child run planned"],
            context: { phase: "ui" },
            modelPreference: {
              model: "gpt-5.6-sol",
              reasoning_effort: "high",
            },
          },
        ],
      }),
    );

    expect(output.nextRuns).toEqual([
      {
        goal: "Build React dashboard composer",
        prompt: "Plan the child run.",
        doneWhen: ["child run planned"],
        context: { phase: "ui" },
        modelPreference: {
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
        },
      },
    ]);
  });

  test("parses fixed action payloads into planner outputs", () => {
    const output = parseAttemptOutput(
      JSON.stringify(doneOutput({
        summary: "planned with actions",
        actions: [
          createTasksAction([
            {
              role: "worker",
              goal: "Implement action parser",
              prompt: "Add action schema support.",
              doneWhen: ["parser accepts actions"],
            },
          ]),
          createRunsAction([
            {
              goal: "Child planning run",
              prompt: "Plan the child run.",
              context: { source: "action" },
            },
          ]),
          setRunDecisionAction("continue"),
        ],
      })),
    );

    expect(output.runDecision).toBe("continue");
    expect(output.nextTasks).toEqual([
      {
        role: "worker",
        goal: "Implement action parser",
        prompt: "Add action schema support.",
        dependsOn: undefined,
        doneWhen: ["parser accepts actions"],
        modelPreference: undefined,
      },
    ]);
    expect(output.nextRuns).toEqual([
      {
        goal: "Child planning run",
        prompt: "Plan the child run.",
        doneWhen: undefined,
        context: { source: "action" },
        modelPreference: undefined,
      },
    ]);
  });

  test("rejects invalid fixed action payloads", () => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "bad action",
          actions: [
            {
              type: "createTasks",
              payload: { tasks: { role: "worker" } },
            },
          ],
        }),
      ),
    ).toThrow("payload.tasks must be an array");
  });

  test("normalizes done run decisions from fixed actions to complete", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "verified complete",
        actions: [
          {
            type: "setRunDecision",
            payload: { decision: "done" },
          },
        ],
      }),
    );

    expect(output.runDecision).toBe("complete");
  });

  test("fixed action builders reject invalid control values", () => {
    expect(() => setRunDecisionAction("pause" as never)).toThrow("decision must be complete, continue, verify, or defer");
    expect(() => doneOutput({ summary: "" })).toThrow("summary must be a non-empty string");
  });

  test("ignores non-model string preferences in planner next runs", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned runs",
        nextRuns: [
          {
            goal: "Build React dashboard composer",
            prompt: "Plan the child run.",
            modelPreference: "balanced",
          },
        ],
      }),
    );

    expect(output.nextRuns?.[0]).toEqual({
      goal: "Build React dashboard composer",
      prompt: "Plan the child run.",
      doneWhen: undefined,
      context: undefined,
      modelPreference: undefined,
    });
  });

  test("ignores reason-only model preference objects in planner next runs", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "planned runs",
        nextRuns: [
          {
            goal: "Build React dashboard composer",
            prompt: "Plan the child run.",
            modelPreference: {
              reason: "balanced effort",
            },
          },
        ],
      }),
    );

    expect(output.nextRuns?.[0]?.modelPreference).toBeUndefined();
  });

  test.each([
    ["missing role", { goal: "Goal", prompt: "Prompt" }],
    ["empty goal", { role: "worker", goal: "", prompt: "Prompt" }],
    ["empty prompt", { role: "worker", goal: "Goal", prompt: "  " }],
    ["invalid dependsOn", { role: "worker", goal: "Goal", prompt: "Prompt", dependsOn: "task_1" }],
    ["invalid doneWhen", { role: "worker", goal: "Goal", prompt: "Prompt", doneWhen: [1] }],
    ["invalid verifierContract", { role: "worker", goal: "Goal", prompt: "Prompt", verifierContract: [] }],
    [
      "missing verifierContract successCriteria",
      {
        role: "worker",
        goal: "Goal",
        prompt: "Prompt",
        verifierContract: {
          deterministicChecks: [],
          agentReviewRubric: [],
        },
      },
    ],
  ])("rejects planner next tasks with %s", (_name, plannedTask) => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "planned",
          nextTasks: [plannedTask],
        }),
      ),
    ).toThrow(/planned task/);
  });

  const validProposal = {
    problem: "Test runner flakes on cold cache",
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

  test("parses valid recordSignal designer action", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "recorded signal",
        actions: [
          {
            type: "recordSignal",
            payload: {
              projectId: "project_1",
              signalClass: "delivery",
              source: "test-runs",
              title: "flaky runner",
              summary: "runner flaked twice",
              observationTime: "2026-08-02T00:00:00Z",
              confidence: 0.6,
              evidence: [{ path: "tests/runner.test.ts" }],
            },
          },
        ],
      }),
    );

    expect(output.designActions).toEqual([
      {
        type: "recordSignal",
        payload: expect.objectContaining({
          projectId: "project_1",
          signalClass: "delivery",
          source: "test-runs",
          title: "flaky runner",
          summary: "runner flaked twice",
          observationTime: "2026-08-02T00:00:00Z",
          confidence: 0.6,
          evidence: [{ path: "tests/runner.test.ts" }],
        }),
      },
    ]);
    expect(output.nextRuns).toEqual([]);
    expect(output.nextTasks).toEqual([]);
  });

  test("parses valid proposeDesign designer action with builder", () => {
    const output = parseAttemptOutput(
      JSON.stringify(
        doneOutput({
          summary: "proposed",
          actions: [
            proposeDesignAction({
              projectId: "project_1",
              title: "Pre-warm cache",
              proposal: validProposal,
              status: "proposed",
            }),
          ],
        }),
      ),
    );

    expect(output.designActions).toHaveLength(1);
    expect(output.designActions?.[0].type).toBe("proposeDesign");
    expect(output.designActions?.[0].payload.proposal).toMatchObject({
      problem: "Test runner flakes on cold cache",
      recommendation: "Pre-warm the cache before running",
    });
  });

  test("parses valid decideDesign designer action", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "decided",
        actions: [
          decideDesignAction({
            proposalId: "design_1",
            decision: "rejected",
            reasons: ["no evidence of impact"],
          }),
        ],
      }),
    );

    expect(output.designActions?.[0]).toMatchObject({
      type: "decideDesign",
      payload: { proposalId: "design_1", decision: "rejected", actorKind: "auto" },
    });
  });

  test("parses valid recordDesignOutcome designer action", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "outcome",
        actions: [
          recordDesignOutcomeAction({
            proposalId: "design_1",
            stage: "review",
            recommendation: "retain",
            baseline: { startup: 12 },
            observed: { startup: 5 },
            evidence: [{ runId: "run_1" }],
          }),
        ],
      }),
    );

    expect(output.designActions?.[0].payload.recommendation).toBe("retain");
  });

  test("parses valid createRunsFromDesign designer action", () => {
    const output = parseAttemptOutput(
      JSON.stringify({
        status: "done",
        summary: "delivery",
        actions: [
          createRunsFromDesignAction({
            proposalId: "design_1",
            runs: [
              {
                goal: "Plan cache pre-warm",
                prompt: "Plan the change.",
                doneWhen: ["planner returns tasks"],
              },
            ],
          }),
        ],
      }),
    );

    expect(output.designActions?.[0].type).toBe("createRunsFromDesign");
    expect(output.designActions?.[0].payload.runs).toHaveLength(1);
    expect(output.nextRuns).toEqual([]);
  });

  test("coexists createTasks, createRuns, setRunDecision, and design actions", () => {
    const output = parseAttemptOutput(
      JSON.stringify(
        doneOutput({
          summary: "design and delivery",
          actions: [
            createTasksAction([
              {
                role: "worker",
                goal: "wire gate",
                prompt: "wire gate",
              },
            ]),
            createRunsAction([
              {
                goal: "auxiliary run",
                prompt: "auxiliary run",
              },
            ]),
            setRunDecisionAction("continue"),
            recordSignalAction({
              projectId: "project_1",
              signalClass: "delivery",
              source: "test",
              title: "signal",
              summary: "ok",
              observationTime: "2026-08-02T00:00:00Z",
              confidence: 0.5,
            }),
          ],
        }),
      ),
    );

    expect(output.nextTasks).toHaveLength(1);
    expect(output.nextRuns).toHaveLength(1);
    expect(output.runDecision).toBe("continue");
    expect(output.designActions).toHaveLength(1);
    expect(output.designActions?.[0].type).toBe("recordSignal");
  });

  test.each([
    ["missing projectId", { signalClass: "delivery", source: "x", title: "x", summary: "x", observationTime: "2026-08-02T00:00:00Z", confidence: 0.5 }],
    ["missing signalClass", { projectId: "project_1", source: "x", title: "x", summary: "x", observationTime: "2026-08-02T00:00:00Z", confidence: 0.5 }],
    ["invalid signalClass", { projectId: "project_1", signalClass: "weather", source: "x", title: "x", summary: "x", observationTime: "2026-08-02T00:00:00Z", confidence: 0.5 }],
    ["invalid confidence", { projectId: "project_1", signalClass: "delivery", source: "x", title: "x", summary: "x", observationTime: "2026-08-02T00:00:00Z", confidence: 1.4 }],
    ["missing observationTime", { projectId: "project_1", signalClass: "delivery", source: "x", title: "x", summary: "x", confidence: 0.5 }],
    ["non-timestamp observationTime", { projectId: "project_1", signalClass: "delivery", source: "x", title: "x", summary: "x", observationTime: "not-a-timestamp", confidence: 0.5 }],
    ["invalid expiresAt", { projectId: "project_1", signalClass: "delivery", source: "x", title: "x", summary: "x", observationTime: "2026-08-02T00:00:00Z", confidence: 0.5, expiresAt: "not-a-date" }],
  ])("rejects malformed recordSignal payloads with %s", (_name, payload) => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "recordSignal", payload }],
        }),
      ),
    ).toThrow(/recordSignal/);
  });

  test.each([
    ["missing proposal", { projectId: "project_1", title: "x" }],
    ["missing problem", { projectId: "project_1", title: "x", proposal: { recommendation: "x", evidenceRefs: ["signal_1"], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core" } } }],
    ["empty options array", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], options: [], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core" } } }],
    ["missing options", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core" } } }],
    ["missing evaluation contract", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], investment: { reversibility: "easy", portfolio: "core" } } }],
    ["missing investment", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], evaluationContract: { successMetrics: ["x"] } } }],
    ["invalid reversibility", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "trivial", portfolio: "core" } } }],
    ["negative oneTimeCost", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: ["signal_1"], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core", oneTimeCost: -5 } } }],
    ["empty evidenceRefs", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evidenceRefs: [], evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core" } } }],
    ["missing evidenceRefs", { projectId: "project_1", title: "x", proposal: { problem: "x", recommendation: "x", evaluationContract: { successMetrics: ["x"] }, investment: { reversibility: "easy", portfolio: "core" } } }],
    ["string option lockIn", { projectId: "project_1", title: "x", proposal: { ...validProposal, options: [{ name: "x", benefits: [], costs: [], risks: [], lockIn: "none" }] } }],
    ["array experiment rollback", { projectId: "project_1", title: "x", proposal: { ...validProposal, experiment: { hypothesis: "x", smallestTest: "x", stopConditions: [], rollback: ["undo"] } } }],
  ])("rejects malformed proposeDesign payloads with %s", (_name, payload) => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "proposeDesign", payload }],
        }),
      ),
    ).toThrow(/proposeDesign/);
  });

  test.each([
    ["missing proposalId", { decision: "rejected" }],
    ["invalid decision", { proposalId: "design_1", decision: "defer" }],
    ["invalid actorKind", { proposalId: "design_1", decision: "rejected", actorKind: "founder" }],
    ["designer approval", { proposalId: "design_1", decision: "approved" }],
    ["designer human actor", { proposalId: "design_1", decision: "rejected", actorKind: "human" }],
    ["designer governance actor", { proposalId: "design_1", decision: "revise", actorKind: "governance" }],
  ])("rejects malformed decideDesign payloads with %s", (_name, payload) => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "decideDesign", payload }],
        }),
      ),
    ).toThrow(/decideDesign/);
  });

  test.each([
    ["missing proposalId", { stage: "review", recommendation: "retain" }],
    ["invalid stage", { proposalId: "design_1", stage: "post", recommendation: "retain" }],
    ["invalid recommendation", { proposalId: "design_1", stage: "review", recommendation: "hold" }],
  ])("rejects malformed recordDesignOutcome payloads with %s", (_name, payload) => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "recordDesignOutcome", payload }],
        }),
      ),
    ).toThrow(/recordDesignOutcome/);
  });

  test("rejects createRunsFromDesign without proposalId", () => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "createRunsFromDesign", payload: { runs: [] } }],
        }),
      ),
    ).toThrow(/createRunsFromDesign/);
  });

  test("rejects unknown design action types", () => {
    expect(() =>
      parseAttemptOutput(
        JSON.stringify({
          status: "done",
          summary: "x",
          actions: [{ type: "approveDesign", payload: {} }],
        }),
      ),
    ).toThrow(/action type/);
  });

  test("apply-design-actions hook records durable entities from valid actions", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

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
            title: "flaky",
            summary: "twice",
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
    const signals = harness.listStrategySignals({ projectId });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ title: "flaky", runId });
    const events = harness.listHarnessActionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      actionType: "design.recordSignal",
      status: "done",
    });
    expect(events[0].request).toMatchObject({
      type: "recordSignal",
      runId,
      taskId,
    });
    expect(events[0].result).toMatchObject({ signalId: signals[0].id });
  });

  test("apply-design-actions hook records proposal, decision, outcome, and runs", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

    const proposalOutput: AttemptOutput = {
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

    const proposalResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposalOutput,
    });
    expect(proposalResult.decision).toBe("exit");

    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;

    harness.recordDesignDecision({
      proposalId,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      reasons: ["reversible change reviewed by founder"],
    });
    harness.updateDesignProposalStatus({ proposalId, status: "accepted" });

    const approvedProposal = harness.getDesignProposal({ id: proposalId });
    expect(approvedProposal?.status).toBe("accepted");
    const decisions = harness.listDesignDecisions({ proposalId });
    const humanApproved = decisions.find(
      (d) => d.decision === "approved" && d.actorKind === "human",
    );
    expect(humanApproved).toMatchObject({
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
    });

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "delivery",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
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

    const deliveryResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });

    expect(deliveryResult.decision).toBe("continue");
    const createdRunArtifacts = (deliveryResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(createdRunArtifacts).toHaveLength(1);
    const childRunId = (createdRunArtifacts[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    expect(childRun?.context).toMatchObject({
      designProposalId: proposalId,
      source: "design",
      designEvaluationContract: expect.objectContaining({
        successMetrics: ["cold-cache startup under 7s"],
        requiredEvidence: ["bun test results from three runs"],
      }),
      designProposal: expect.objectContaining({
        problem: "Test runner flakes on cold cache",
        recommendation: "Pre-warm the cache before running",
        options: expect.arrayContaining([expect.objectContaining({ name: "pre-warm cache" })]),
        evidenceRefs: ["signal_abc"],
      }),
      designInvestment: expect.objectContaining({
        reversibility: "easy",
        portfolio: "core",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      }),
      designAdditions: [],
      designRemovals: [],
      designApprovalAuthority: expect.objectContaining({
        decisionId: expect.any(String),
        decision: "approved",
        actorKind: "human",
        actorRef: "founder@example.com",
        authority: expect.objectContaining({}),
      }),
    });

    const outcomeOutput: AttemptOutput = {
      status: "done",
      summary: "outcome",
      designActions: [
        {
          type: "recordDesignOutcome",
          payload: {
            proposalId,
            stage: "review",
            recommendation: "retain",
            baseline: { startup: 12 },
            observed: { startup: 5 },
            evidence: [{ runId: childRunId }],
          },
        },
      ],
    } as AttemptOutput;

    await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: outcomeOutput,
    });

    const outcomes = harness.listDesignOutcomes({ proposalId });
    expect(outcomes).toHaveLength(1);
    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("retained");

    const designEvents = harness
      .listHarnessActionEvents({ limit: 50 })
      .filter((event) => event.actionType.startsWith("design."));
    const actionTypes = designEvents.map((event) => event.actionType);
    expect(actionTypes).toEqual(
      expect.arrayContaining([
        "design.proposeDesign",
        "design.createRunsFromDesign",
        "design.recordDesignOutcome",
      ]),
    );
    for (const event of designEvents) {
      expect(event.status).toBe("done");
      expect(event.request).toMatchObject({ runId, taskId });
    }
  });

  test("createRunsFromDesign preserves extension fields stored on the proposal envelope", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

    const proposalWithExtensions = {
      ...validProposal,
      targetOutcome: "Cold-cache startup falls below 7s without reliability loss",
      additions: ["packages/runner/src/prewarm.ts"],
      removals: ["legacy cold-cache handling"],
      assumptions: ["prewarm runs before test discovery"],
      uncertainty: ["effect under load"],
      experiment: {
        hypothesis: "Pre-warming eliminates the cold-cache startup tail",
        smallestTest: "Run three cold-cache suites with and without prewarm",
        stopConditions: ["startup stays above 7s after prewarm"],
        rollback: "Delete prewarm and rerun the suite",
      },
      // Designer-authored extension fields must survive the freeze so planners
      // and verifiers inherit a single durable source of truth.
      customRolloutNotes: "Coordinate with release manager before merging",
      telemetryHypothesis: {
        metric: "cold_cache_startup_ms",
        expectedDelta: -5000,
      },
    } as typeof validProposal;

    const proposalOutput: AttemptOutput = {
      status: "done",
      summary: "proposal",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: proposalWithExtensions,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposalResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposalOutput,
    });
    expect(proposalResult.decision).toBe("exit");

    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;

    harness.recordDesignDecision({
      proposalId,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      reasons: ["reversible change reviewed by founder"],
    });
    harness.updateDesignProposalStatus({ proposalId, status: "accepted" });

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "delivery",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
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

    const deliveryResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });

    expect(deliveryResult.decision).toBe("continue");
    const createdRunArtifacts = (deliveryResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(createdRunArtifacts).toHaveLength(1);
    const childRunId = (createdRunArtifacts[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    expect(childRun?.context).toMatchObject({
      designProposal: expect.objectContaining({
        problem: "Test runner flakes on cold cache",
        recommendation: "Pre-warm the cache before running",
        targetOutcome: "Cold-cache startup falls below 7s without reliability loss",
        additions: ["packages/runner/src/prewarm.ts"],
        removals: ["legacy cold-cache handling"],
        assumptions: ["prewarm runs before test discovery"],
        uncertainty: ["effect under load"],
        experiment: expect.objectContaining({
          hypothesis: "Pre-warming eliminates the cold-cache startup tail",
        }),
        customRolloutNotes: "Coordinate with release manager before merging",
        telemetryHypothesis: expect.objectContaining({
          metric: "cold_cache_startup_ms",
          expectedDelta: -5000,
        }),
      }),
    });
  });

  test("apply-design-actions hook rejects unaccepted proposal for delivery", async () => {
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

    const output: AttemptOutput = {
      status: "done",
      summary: "delivery",
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
    expect(result.problems?.[0]).toContain("createRunsFromDesign requires an accepted proposal");
  });

  test("apply-design-actions hook emits adverse strategy signals for revise and retire recommendations", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

    let proposalIndex = 0;
    for (const recommendation of ["revise", "retire"] as const) {
      proposalIndex += 1;
      const proposal = harness.createDesignProposal({
        projectId,
        title: `Pre-warm cache (${recommendation})`,
        problem: "x",
        recommendation: "x",
        proposal: validProposal as never,
        status: "measuring",
      });
      const output: AttemptOutput = {
        status: "done",
        summary: "outcome",
        designActions: [
          {
            type: "recordDesignOutcome",
            payload: {
              proposalId: proposal.id,
              stage: "review",
              recommendation,
              baseline: { startup: 12 },
              observed: { startup: 14 },
              evidence: [{ runId }],
              unexpectedEffects: ["latency spike at 99p"],
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

      const signalArtifacts = (result.artifacts ?? []).filter(
        (artifact) => (artifact as { kind?: string }).kind === "design_signal",
      );
      expect(signalArtifacts).toHaveLength(1);
      const signalId = (signalArtifacts[0] as { signalId: string }).signalId;
      expect(
        (result.checks ?? []).some((check) => {
          const c = check as { name?: string; evidence?: string };
          return c.name === "adverse outcome signal" && c.evidence === signalId;
        }),
      ).toBe(true);

      const signals = harness.listStrategySignals({ projectId }).filter((s) => s.id === signalId);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        signalClass: "delivery",
        source: "outcome-review",
        proposalId: proposal.id,
        runId,
        taskId,
      });
      expect(signals[0].title).toContain(recommendation);
      expect(signals[0].summary).toContain("latency spike at 99p");
      expect(signals[0].evidence).toEqual(
        expect.arrayContaining([`design_proposal:${proposal.id}`]),
      );

      const expectedStatus = recommendation === "revise" ? "revise" : "retired";
      expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe(expectedStatus);
      void proposalIndex;
    }
  });

  test("apply-design-actions hook does not emit adverse signals for retained outcomes", async () => {
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
      status: "measuring",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "outcome",
      designActions: [
        {
          type: "recordDesignOutcome",
          payload: {
            proposalId: proposal.id,
            stage: "review",
            recommendation: "retain",
            baseline: { startup: 12 },
            observed: { startup: 5 },
            evidence: [{ runId }],
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

    expect((result.artifacts ?? []).some((a) => (a as { kind?: string }).kind === "design_signal")).toBe(false);
    expect(harness.listStrategySignals({ projectId })).toHaveLength(0);
    expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("retained");
  });

  test("apply-design-actions hook rejects designer-authored approvals of every actor kind", async () => {
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

    for (const actorKind of ["auto", "human", "governance"] as const) {
      const output: AttemptOutput = {
        status: "done",
        summary: "decision",
        designActions: [
          {
            type: "decideDesign",
            payload: {
              proposalId: proposal.id,
              decision: "approved",
              actorKind,
              actorRef: actorKind === "auto" ? null : "founder@example.com",
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
      expect(result.problems?.[0]).toContain("decideDesign payload.decision approved is not allowed from designer output");
      const events = harness.listHarnessActionEvents({ limit: 5 });
      expect(events[0]).toMatchObject({
        actionType: "design.decideDesign",
        status: "blocked",
      });
      expect(events[0].request).toMatchObject({
        type: "decideDesign",
        runId,
        taskId,
      });
    }

    const decisions = harness.listDesignDecisions({ proposalId: proposal.id });
    expect(decisions).toHaveLength(0);
    expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("proposed");
  });

  test("apply-design-actions hook rejects designer-authored human and governance actor kinds", async () => {
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

    for (const actorKind of ["human", "governance"] as const) {
      const output: AttemptOutput = {
        status: "done",
        summary: "decision",
        designActions: [
          {
            type: "decideDesign",
            payload: {
              proposalId: proposal.id,
              decision: "rejected",
              actorKind,
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
        output,
      });

      expect(result.decision).toBe("exit");
      expect(result.problems?.[0]).toContain(
        `decideDesign payload.actorKind ${actorKind} is not allowed from designer output`,
      );
    }

    expect(harness.listDesignDecisions({ proposalId: proposal.id })).toHaveLength(0);
  });

  test("apply-design-actions hook rejects createRunsFromDesign when the approval lacks actorRef", async () => {
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
      reasons: ["reviewed"],
    });
    harness.updateDesignProposalStatus({ proposalId: proposal.id, status: "accepted" });
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "delivery",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposal.id,
            runs: [{ goal: "Plan", prompt: "Plan." }],
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
  });

  test("apply-design-actions hook rejects expired evidence", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "signal",
      designActions: [
        {
          type: "recordSignal",
          payload: {
            projectId,
            signalClass: "delivery",
            source: "tests",
            title: "old",
            summary: "old",
            observationTime: "2024-01-01T00:00:00Z",
            confidence: 0.5,
            expiresAt: "2024-02-01T00:00:00Z",
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

    expect(result.problems?.[0]).toContain("expiresAt");
  });

  test("apply-design-actions hook is no-op without design actions", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const result = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: { status: "done", summary: "no actions" } as AttemptOutput,
    });

    expect(result.decision).toBe("exit");
    expect(result.problems).toBeUndefined();
  });

  // -- Designer transition coordinator: bounded, idempotent, fail-closed. --

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

  function seedLowRiskSignal(projectId: string): string {
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
    });
    return signal.id;
  }

  function lowRiskProposalEnvelope(signalId: string) {
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
        reversibility: "easy" as const,
        portfolio: "core" as const,
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
    };
  }

  test("apply-design-actions hook creates bounded continuation after recordSignal carrying durable signal ID", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
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

    const result = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output,
    });

    expect(result.decision).toBe("exit");
    const signals = harness.listStrategySignals({ projectId });
    expect(signals).toHaveLength(1);
    const signalId = signals[0].id;

    // Exactly one designer continuation exists, carrying the durable signal ID.
    const continuationArtifacts = (result.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    );
    expect(continuationArtifacts).toHaveLength(1);
    const continuation = continuationArtifacts[0] as { taskId: string; signalId: string };
    expect(continuation.signalId).toBe(signalId);
    const continuationTask = harness.getTask(continuation.taskId);
    expect(continuationTask).toBeDefined();
    expect(continuationTask?.role).toBe("designer");
    expect(continuationTask?.prompt).toContain(signalId);
    expect(continuationTask?.dependsOn).toEqual([taskId]);

    const continuationPrompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: continuationTask!,
      dependencyAttempts: [],
    });
    const continuationExample = requiredOutputExample(continuationPrompt);
    expect(continuationExample.actions).toEqual([
      expect.objectContaining({ type: "proposeDesign" }),
    ]);
    const parsedContinuation = parseAttemptOutput(JSON.stringify(continuationExample));
    expect(parsedContinuation.designActions).toEqual([
      expect.objectContaining({ type: "proposeDesign" }),
    ]);
    const continuationProposal = parsedContinuation.designActions?.[0]?.payload.proposal as {
      evidenceRefs: string[];
    };
    expect(continuationProposal.evidenceRefs).toEqual([signalId]);

    // The audit row captures both the durable signal ID and continuation task.
    const events = harness.listHarnessActionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      actionType: "design.recordSignal",
      status: "done",
    });
    expect(events[0].result).toMatchObject({
      signalId,
      continuationTaskId: continuation.taskId,
    });
  });

  test("apply-design-actions hook auto-approves low-risk proposal end-to-end with frozen contract inheritance", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposeResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });

    // Auto-approved transitions do not themselves create the child run — they
    // produce a delivery continuation that emits the createRunsFromDesign
    // action in the next bounded step. The hook stays in exit, and the
    // proposal status moves to accepted.
    expect(proposeResult.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;
    expect(proposals[0].status).toBe("accepted");

    const decisions = harness.listDesignDecisions({ proposalId });
    const autoApproval = decisions.find(
      (d) => d.decision === "approved" && d.actorKind === "auto",
    );
    expect(autoApproval).toBeDefined();
    expect(autoApproval?.authority?.disposition).toBe("automatic");

    // A bounded delivery continuation is created for the next Designer pass.
    const deliveryContinuation = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string; proposalId: string } | undefined;
    expect(deliveryContinuation).toBeDefined();
    expect(deliveryContinuation?.proposalId).toBe(proposalId);

    // The Designer emits the bounded createRunsFromDesign action against the
    // stored proposal. Exactly one child planner run is created within the
    // configured budget.
    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
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

    const deliverResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverOutput,
    });

    expect(deliverResult.decision).toBe("continue");
    const createdRunArtifacts = (deliverResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(createdRunArtifacts).toHaveLength(1);
    const childRunId = (createdRunArtifacts[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    expect(childRun).toBeDefined();
    expect(childRun?.context).toMatchObject({
      parentRunId: runId,
      sourceTaskId: taskId,
      source: "design",
      designProposalId: proposalId,
      designEvaluationContract: {
        baseline: ["cold-cache startup 12s"],
        successMetrics: ["cold-cache startup under 7s"],
        guardMetrics: ["test reliability stays at 100%"],
        requiredEvidence: ["bun test results from three runs"],
      },
      designProposal: expect.objectContaining({
        problem: "Test runner flakes on cold cache",
        recommendation: "Pre-warm the cache before running",
        evidenceRefs: [signalId],
        investment: expect.objectContaining({
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
        }),
      }),
      designApprovalAuthority: expect.objectContaining({
        decision: "approved",
        actorKind: "auto",
      }),
    });
  });

  test("apply-design-actions hook auto-approves production-format proposal that omits the riskSurface field", async () => {
    // The production Designer prompt (packages/cli/src/main.ts:selfIterationDesignerPrompt)
    // does NOT require an explicit `riskSurface` field on `proposeDesign`. The
    // coordinator must therefore derive a conservative risk surface from the
    // envelope text and accept low-risk proposals even when `riskSurface` is
    // absent. This test reproduces the production envelope exactly: no
    // `riskSurface` block, no `declaredHumanCategories`, just the documented
    // contract fields.
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    // Production envelope: matches what selfIterationDesignerPrompt asks the
    // designer to emit. Note the absence of `riskSurface`.
    const productionEnvelope = {
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
        reversibility: "easy" as const,
        portfolio: "core" as const,
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      // No `riskSurface` field — this is the production format.
    };

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: productionEnvelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposeResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });

    // The coordinator must auto-approve: status accepted, an approved auto
    // decision with automatic disposition, and a delivery continuation.
    expect(proposeResult.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("accepted");

    const decisions = harness.listDesignDecisions({ proposalId: proposals[0].id });
    const autoApproval = decisions.find(
      (d) => d.decision === "approved" && d.actorKind === "auto",
    );
    expect(autoApproval).toBeDefined();
    expect(autoApproval?.authority?.disposition).toBe("automatic");

    const deliveryContinuation = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    );
    expect(deliveryContinuation).toBeDefined();
  });

  test("apply-design-actions hook records human checkpoint for high-risk proposal and creates no delivery run", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    // High-risk envelope: hard reversibility and a schema-migration flag the
    // designer declares as true. The evaluator must route to human-required.
    const highRiskEnvelope = {
      ...lowRiskProposalEnvelope(signalId),
      investment: {
        reversibility: "hard" as const,
        portfolio: "core" as const,
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
    };

    const output: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Risk-on schema migration",
            proposal: highRiskEnvelope,
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
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;

    // Status stays in proposed — no auto-acceptance.
    expect(proposals[0].status).toBe("proposed");

    const decisions = harness.listDesignDecisions({ proposalId });
    const checkpoint = decisions.find((d) => d.decision === "deferred" && d.actorKind === "auto");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(checkpoint?.reasons.some((r) => String(r).includes("schema-migration"))).toBe(true);

    // No delivery continuation was created.
    const continuationArtifacts = (result.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    );
    expect(continuationArtifacts).toHaveLength(0);

    // No child run can be created because the proposal was never accepted.
    expect(
      harness.listRuns({ limit: 50 }).filter((r) => r.context?.parentRunId === runId),
    ).toHaveLength(0);

    // A subsequent delivery attempt against the un-accepted proposal fails closed.
    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;

    const deliverResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverOutput,
    });

    expect(deliverResult.decision).toBe("exit");
    expect(deliverResult.problems?.[0]).toContain("createRunsFromDesign requires an accepted proposal");
  });

  test("authority reconciliation reopens a blocked zero-cost proposal under cost-only policy", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });
    const envelope = {
      ...lowRiskProposalEnvelope(signalId),
      investment: {
        reversibility: "hard" as const,
        portfolio: "core" as const,
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "1 hour",
      },
      riskSurface: {
        ...lowRiskProposalEnvelope(signalId).riskSurface,
        schemaMigration: true,
      },
    };

    await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: {
        status: "done",
        summary: "propose",
        designActions: [{
          type: "proposeDesign",
          payload: { projectId, title: "Repair authority", proposal: envelope, status: "proposed" },
        }],
      } as AttemptOutput,
    });
    const proposal = harness.listDesignProposals({ projectId })[0];
    expect(proposal.status).toBe("proposed");
    harness.updateRunStatus({ runId, status: "blocked" });
    harness.createFounderCharter({
      projectId,
      mission: "Build a safe autonomous strategy loop.",
      charter: {
        mission: "Build a safe autonomous strategy loop.",
        capitalPolicy: {
          currency: "USD",
          experimentBudget: 1000,
          recurringSpendApprovalAbove: 0,
          portfolio: { core: 5, growth: 3, exploration: 2 },
        },
        authority: {
          autoResearch: true,
          autoReversibleExperiments: true,
          humanApprovalPolicy: "cost-only",
          requireHumanFor: ["cost"],
        },
      },
      activate: true,
    });

    const result = reconcileDeferredDesignAuthority({ harness, projectId });

    expect(result.approved).toBe(1);
    expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("accepted");
    expect(harness.getRun(runId)?.status).toBe("todo");
    expect(
      harness.listDesignDecisions({ proposalId: proposal.id }).some(
        (decision) => decision.decision === "approved" && decision.actorKind === "auto",
      ),
    ).toBe(true);
    expect(
      harness.getRunOverview({ runId }).tasks.some(
        (task) => task.role === "designer" && task.config?.designContinuation !== undefined,
      ),
    ).toBe(true);
  });

  test("apply-design-actions hook fails closed for missing evidence references", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites missing signal",
            proposal: lowRiskProposalEnvelope("signal_does_not_exist"),
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
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;

    // Missing evidence cannot authorize automatic approval: status stays in
    // proposed and a deferred checkpoint is recorded with human-required
    // disposition.
    expect(proposals[0].status).toBe("proposed");
    const decisions = harness.listDesignDecisions({ proposalId });
    const checkpoint = decisions.find((d) => d.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(
      (checkpoint?.authority as { evidence?: { missing?: string[] } } | undefined)?.evidence?.missing,
    ).toContain("signal_does_not_exist");
  });

  test("apply-design-actions hook fails closed for stale evidence signals", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);

    // Stale signal — already expired at observation time.
    const stale = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "verifier",
      title: "stale",
      summary: "stale observation",
      observationTime: "2024-01-01T00:00:00.000Z",
      confidence: 0.5,
      evidence: [],
      status: "active",
      expiresAt: "2024-02-01T00:00:00.000Z",
    });

    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites stale signal",
            proposal: lowRiskProposalEnvelope(stale.id),
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
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;
    const decisions = harness.listDesignDecisions({ proposalId });
    // Stale evidence must hard-reject.
    const rejected = decisions.find((d) => d.decision === "rejected");
    expect(rejected).toBeDefined();
    expect(
      (rejected?.authority as { evidence?: { expired?: string[] } } | undefined)?.evidence?.expired,
    ).toContain(stale.id);
    expect(proposals[0].status).toBe("rejected");
  });

  test("apply-design-actions hook fails closed for conflicting evidence signals", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalA = seedLowRiskSignal(projectId);
    const signalB = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "verifier",
      title: "conflict",
      summary: "Conflicting observation.",
      observationTime: "2026-08-01T00:00:00.000Z",
      confidence: 0.5,
      evidence: [],
      status: "active",
      expiresAt: null,
      conflictingSignalIds: [signalA],
    });

    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cites conflicting signal",
            proposal: lowRiskProposalEnvelope(signalA),
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
    const proposals = harness.listDesignProposals({ projectId });
    const proposalId = proposals[0].id;
    const decisions = harness.listDesignDecisions({ proposalId });
    const checkpoint = decisions.find((d) => d.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(
      (checkpoint?.authority as { evidence?: { conflicting?: string[] } } | undefined)?.evidence
        ?.conflicting,
    ).toContain(signalA);
    void signalB;
  });

  test("apply-design-actions hook fails closed for evidence with no active charter", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    // No charter seeded — adapter must fail closed.
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "No charter",
            proposal: lowRiskProposalEnvelope(signalId),
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
    const proposals = harness.listDesignProposals({ projectId });
    const proposalId = proposals[0].id;
    const decisions = harness.listDesignDecisions({ proposalId });
    const checkpoint = decisions.find((d) => d.decision === "deferred");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.authority?.disposition).toBe("human-required");
    expect(checkpoint?.reasons.some((r) => String(r).includes("missing-active-charter"))).toBe(true);
  });

  test("apply-design-actions hook is idempotent across Harness reconstruction", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const firstResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    expect(firstResult.decision).toBe("exit");

    const proposalsBefore = harness.listDesignProposals({ projectId });
    const decisionsBefore = harness.listDesignDecisions({ proposalId: proposalsBefore[0].id });
    const eventsBefore = harness.listHarnessActionEvents({ limit: 50 })
      .filter((e) => e.actionType.startsWith("design."));

    // Simulate a process restart: drop and recreate the harness over the same
    // SQLite database. The audit log is the source of truth.
    const dbPath = (harness as unknown as { dbPath: string }).dbPath;
    const replayHarness = new Harness(dbPath);
    replayHarness.init();
    const replayHook = createApplyDesignActionsHook({ harness: replayHarness });

    const replayResult = await replayHook({
      run: replayHarness.getRun(runId)!,
      task: replayHarness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });

    // Replay produces the same artifacts but does not create new entities.
    expect(replayResult.decision).toBe("exit");
    expect(replayResult.problems).toBeUndefined();

    const proposalsAfter = replayHarness.listDesignProposals({ projectId });
    expect(proposalsAfter).toHaveLength(proposalsBefore.length);
    expect(proposalsAfter[0].id).toBe(proposalsBefore[0].id);
    expect(proposalsAfter[0].status).toBe(proposalsBefore[0].status);

    const decisionsAfter = replayHarness.listDesignDecisions({ proposalId: proposalsAfter[0].id });
    expect(decisionsAfter).toHaveLength(decisionsBefore.length);
    expect(decisionsAfter.map((d) => d.id).sort()).toEqual(
      decisionsBefore.map((d) => d.id).sort(),
    );

    const eventsAfter = replayHarness.listHarnessActionEvents({ limit: 50 })
      .filter((e) => e.actionType.startsWith("design."));
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    for (const event of eventsAfter) {
      expect(event.status).toBe("done");
    }
  });

  test("apply-design-actions hook preserves byte-for-byte frozen evaluation contract in child run context", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const envelope = {
      ...lowRiskProposalEnvelope(signalId),
      // Extension fields must survive the freeze byte-for-byte so planners,
      // workers, and verifiers inherit a single durable source of truth.
      targetOutcome: "Cold-cache startup falls below 7s without reliability loss",
      additions: ["packages/runner/src/prewarm.ts"],
      removals: ["legacy cold-cache handling"],
      assumptions: ["prewarm runs before test discovery"],
      uncertainty: ["effect under load"],
      experiment: {
        hypothesis: "Pre-warming eliminates the cold-cache startup tail",
        smallestTest: "Run three cold-cache suites with and without prewarm",
        stopConditions: ["startup stays above 7s after prewarm"],
        rollback: "Delete prewarm and rerun the suite",
      },
      customRolloutNotes: "Coordinate with release manager before merging",
      telemetryHypothesis: {
        metric: "cold_cache_startup_ms",
        expectedDelta: -5000,
      },
    };

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: envelope,
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });

    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliverOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;

    const deliverResult = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverOutput,
    });

    expect(deliverResult.decision).toBe("continue");
    const createdRunArtifacts = (deliverResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(createdRunArtifacts).toHaveLength(1);
    const childRunId = (createdRunArtifacts[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId);
    // The frozen envelope preserves every stored field byte-for-byte.
    expect(childRun?.context?.designEvaluationContract).toEqual(envelope.evaluationContract);
    expect(childRun?.context?.designInvestment).toEqual(envelope.investment);
    expect(childRun?.context?.designAdditions).toEqual(envelope.additions);
    expect(childRun?.context?.designRemovals).toEqual(envelope.removals);
    expect(childRun?.context?.designProposal).toMatchObject({
      targetOutcome: envelope.targetOutcome,
      assumptions: envelope.assumptions,
      uncertainty: envelope.uncertainty,
      experiment: envelope.experiment,
      customRolloutNotes: envelope.customRolloutNotes,
      telemetryHypothesis: envelope.telemetryHypothesis,
    });
  });

  test("apply-design-actions hook records duplicate-action transitions idempotently within one designer cycle", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const output: AttemptOutput = {
      status: "done",
      summary: "propose twice",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache",
            proposal: lowRiskProposalEnvelope(signalId),
            status: "proposed",
          },
        },
        // Duplicate action replay within the same designer cycle.
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Pre-warm cache (duplicate)",
            proposal: lowRiskProposalEnvelope(signalId),
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
    // Each action index is unique, so both proposals are recorded. The
    // idempotency guarantee is per (actionType, runId, taskId, actionIndex,
    // entity identity), not per designer cycle.
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(2);
    // Both proposals were auto-approved independently.
    for (const proposal of proposals) {
      expect(proposal.status).toBe("accepted");
      const decisions = harness.listDesignDecisions({ proposalId: proposal.id });
      expect(decisions.find((d) => d.decision === "approved" && d.actorKind === "auto")).toBeDefined();
    }
    const events = harness.listHarnessActionEvents({ limit: 50 })
      .filter((e) => e.actionType === "design.proposeDesign");
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.status === "done")).toBe(true);
  });

  test("apply-design-actions hook is mutation-free and quiescent on no-action result with no designActions", async () => {
    const runId = harness.createRun({ goal: "design run" });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const beforeProposals = harness.listDesignProposals({}).length;
    const beforeSignals = harness.listStrategySignals({}).length;
    const beforeEvents = harness.listHarnessActionEvents({ limit: 200 }).length;

    const result = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: { status: "done", summary: "no actions" } as AttemptOutput,
    });

    expect(result.decision).toBe("exit");
    expect(result.problems).toBeUndefined();
    expect(harness.listDesignProposals({})).toHaveLength(beforeProposals);
    expect(harness.listStrategySignals({})).toHaveLength(beforeSignals);
    expect(harness.listHarnessActionEvents({ limit: 200 })).toHaveLength(beforeEvents);
  });

  // -- Linear intake: durable provenance through fixed design actions. --
  //
  // The Linear intake path claims each `issue.created` inbox event into an
  // issue-scoped Designer run carrying a `linearIntake` provenance block on its
  // context. When that Designer run emits a fixed proposeDesign →
  // createRunsFromDesign cycle, the createRunsFromDesign action must (1) stamp
  // the child planning run with the same immutable provenance, (2) atomically
  // create or reuse exactly one run-to-issue external reference, and (3)
  // transition the matching inbox event running → done only after the run,
  // task, and reference are durable. The same fixed action replayed must reuse
  // the same run, task, reference, and done event without duplicates.
  //
  // The intake helpers below drive the production `consumeLinearInbox` path
  // rather than synthesizing running inbox state directly. This exposes the
  // contract: consume claims todo → running, creates the deterministic
  // issue-scoped Designer run/task, and leaves the inbox in `running` for the
  // fixed design action path to finalize. A pre-createRunsFromDesign
  // transition to `done` would mask the atomic guarantee and is forbidden.

  function seedAndConsumeTodoIntake(input: {
    rootRunId: string;
    inboxEventId: string;
    externalIssueId: string;
    identifier?: string;
    title?: string;
    url?: string;
  }): { runId: string; taskId: string } {
    harness.createInboxEvent({
      id: input.inboxEventId,
      provider: "linear",
      eventType: "issue.created",
      externalId: input.externalIssueId,
      payload: {
        identifier: input.identifier ?? null,
        title: input.title ?? null,
        url: input.url ?? null,
      },
    });
    const result = consumeLinearInbox({ harness, rootRunId: input.rootRunId });
    const outcome = result.outcomes.find((o) => o.eventId === input.inboxEventId);
    if (!outcome) {
      throw new Error(
        `consumeLinearInbox did not process intake event ${input.inboxEventId}; outcomes=${JSON.stringify(result.outcomes)}`,
      );
    }
    if (outcome.kind !== "claimed") {
      throw new Error(
        `expected first consumption of ${input.inboxEventId} to claim a fresh todo event, found ${outcome.kind}`,
      );
    }
    const event = harness.getInboxEvent({ id: input.inboxEventId });
    if (event?.status !== "running") {
      throw new Error(
        `expected intake event ${input.inboxEventId} to remain running after consumeLinearInbox (the fixed action path owns running → done); found status=${event?.status}`,
      );
    }
    return { runId: outcome.runId, taskId: outcome.taskId };
  }

  // Compute the deterministic intake run/task IDs that `consumeLinearInbox`
  // derives from (root run, immutable Linear issue id). Tests use this when
  // they need the IDs before consumption, or to assert the production mapping.
  function deterministicIntakeRunTaskIds(
    rootRunId: string,
    externalIssueId: string,
  ): { runId: string; taskId: string } {
    const material = `${rootRunId}|${externalIssueId}`;
    const digest = createHash("sha256").update(material, "utf8").digest("hex");
    return { runId: `run_linear_${digest}`, taskId: `task_linear_${digest}` };
  }

  function linearIntakeProposalEnvelope(signalId: string) {
    return {
      problem: "Linear intake issue requires a bounded designer response",
      recommendation: "Run a single fixed-action delivery cycle for the issue",
      evidenceRefs: [signalId],
      options: [
        {
          name: "fixed-action delivery",
          benefits: ["preserves provenance"],
          costs: ["one planning run"],
          risks: ["none"],
          lockIn: ["none"],
        },
      ],
      evaluationContract: {
        baseline: ["intake was undiscovered before polling"],
        successMetrics: ["issue produces exactly one planning run"],
        guardMetrics: ["intake lifecycle stays atomic"],
        requiredEvidence: ["bun test apply-design-actions intake cycle"],
      },
      investment: {
        reversibility: "easy" as const,
        portfolio: "core" as const,
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
    };
  }

  test("apply-design-actions hook preserves Linear provenance and finalizes intake exactly once", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_primary";
    const externalIssueId = "linear-intake-issue-1";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7001",
      title: "Polling transport test",
      url: "https://linear.app/pancat/issue/PAN-7001",
    });

    const hook = createApplyDesignActionsHook({ harness });

    // Issue-scoped Designer emits proposeDesign. The auto-authority evaluator
    // accepts and creates a delivery continuation on the same run; the
    // linearIntake provenance block is preserved on the run context throughout.
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Linear intake delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;

    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    expect(proposeResult.decision).toBe("exit");
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(1);
    const proposalId = proposals[0].id;
    expect(proposals[0].status).toBe("accepted");
    const decisions = harness.listDesignDecisions({ proposalId });
    const autoApproval = decisions.find((d) => d.decision === "approved" && d.actorKind === "auto");
    expect(autoApproval).toBeDefined();
    const decisionId = autoApproval!.id;

    // Inbox event stays running after the proposal is recorded: the running
    // → done transition is owned by createRunsFromDesign, not proposeDesign.
    const midInbox = harness.getInboxEvent({ id: inboxEventId });
    expect(midInbox?.status).toBe("running");

    // The auto-approval produces a deterministic after-approveDesign
    // continuation task whose ID differs from the original Designer task that
    // ran proposeDesign. The continuation carries config.designContinuation
    // binding it to the original cycle. Production supervision drives
    // createRunsFromDesign from this continuation task — not the original
    // Designer task — so the ownership guard must accept the legitimate
    // continuation by validating every binding field.
    const deliveryContinuation = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string; proposalId: string } | undefined;
    expect(deliveryContinuation).toBeDefined();
    expect(deliveryContinuation?.proposalId).toBe(proposalId);
    const continuationTaskId = deliveryContinuation!.taskId;
    expect(continuationTaskId).not.toBe(intake.taskId);
    const continuationTask = harness.getTask(continuationTaskId)!;
    expect(continuationTask).toBeDefined();
    expect(continuationTask.config?.designContinuation).toMatchObject({
      kind: "after-approveDesign",
      proposalId,
      sourceTaskId: intake.taskId,
    });

    // Delivery continuation emits createRunsFromDesign against the stored
    // proposal. Exactly one canonical planning run, planner task, and external
    // reference are produced and the inbox event transitions to done in the
    // same atomic transaction.
    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [
              {
                goal: "Plan intake delivery",
                prompt: "Plan the change.",
              },
            ],
          },
        },
      ],
    } as AttemptOutput;

    const deliveryResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });

    expect(deliveryResult.decision).toBe("continue");
    const createdRunArtifacts = (deliveryResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(createdRunArtifacts).toHaveLength(1);
    const childRunId = (createdRunArtifacts[0] as { runId: string }).runId;
    const childRun = harness.getRun(childRunId)!;
    expect(childRun).toBeDefined();
    expect(childRun.context).toMatchObject({
      parentRunId: intake.runId,
      source: "design",
      designProposalId: proposalId,
      designDecisionId: decisionId,
      linearIntake: {
        rootRunId,
        inboxEventId,
        linearIssueId: externalIssueId,
        issueIdentifier: "PAN-7001",
        issueUrl: "https://linear.app/pancat/issue/PAN-7001",
        issueTitle: "Polling transport test",
        proposalId,
        decisionId,
        sourceDesignerRunId: intake.runId,
        sourceDesignerTaskId: intake.taskId,
      },
    });

    // Exactly one external reference links the canonical planning run to the
    // immutable Linear issue under the contract documented in the design
    // proposal. The reference ID is derived from the issue identity alone.
    const refs = harness.listExternalRefs({ localType: "run", localId: childRunId });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      provider: "linear",
      externalType: "issue",
      externalId: externalIssueId,
      externalUrl: "https://linear.app/pancat/issue/PAN-7001",
    });
    const externalRefId = refs[0].id;

    // No second reference exists for any other combination of run or issue.
    expect(harness.listExternalRefs({ localType: "run", localId: intake.runId })).toHaveLength(0);

    // The matching inbox event transitions running → done atomically with the
    // run, task, and reference. The done event is durable.
    const finalInbox = harness.getInboxEvent({ id: inboxEventId });
    expect(finalInbox?.status).toBe("done");

    // The design action audit row records the intake finalization so a later
    // replay reconstructs the same durable identities.
    const events = harness.listHarnessActionEvents({ limit: 50 });
    const deliveryEvent = events.find((event) => event.actionType === "design.createRunsFromDesign");
    expect(deliveryEvent).toBeDefined();
    expect(deliveryEvent!.result).toMatchObject({
      proposalId,
      decisionId,
      intake: {
        inboxEventId,
        externalRefId,
        linearIssueId: externalIssueId,
      },
    });

    // Replay: re-running the same fixed action from the same continuation
    // task must reuse the same canonical run, task, reference, and done
    // event. No duplicates are produced.
    const replayResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replayResult.decision).toBe("continue");
    const replayRunArtifacts = (replayResult.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(replayRunArtifacts).toHaveLength(1);
    expect((replayRunArtifacts[0] as { runId: string }).runId).toBe(childRunId);

    expect(harness.listExternalRefs({ localType: "run", localId: childRunId })).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.getTask((createdRunArtifacts[0] as { plannerTaskId?: string }).plannerTaskId ?? "")).toBeDefined();

    // A second replay driven from the original Designer task (instead of the
    // continuation) must also reuse the same canonical state. This proves the
    // ownership guard accepts the legitimate original-task path alongside the
    // continuation path, and that no duplicate row is produced.
    const replayFromOriginalTask = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replayFromOriginalTask.decision).toBe("continue");
    const replayFromOriginalArtifacts = (replayFromOriginalTask.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(replayFromOriginalArtifacts).toHaveLength(1);
    expect((replayFromOriginalArtifacts[0] as { runId: string }).runId).toBe(childRunId);
    expect(harness.listExternalRefs({ localType: "run", localId: childRunId })).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
  });

  test("apply-design-actions hook rejects Linear intake createRunsFromDesign that requests more than one run", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_too_many_runs";
    const externalIssueId = "linear-intake-issue-too-many";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7002",
      title: "Too many runs",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Multi-run intake",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    expect(proposeResult.decision).toBe("exit");
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    // Requesting more than one run from a Linear intake proposal violates the
    // one-issue-one-run contract. The createRunsFromDesign action throws, the
    // inbox event stays running, and no child runs or external references are
    // produced. The audit row records a blocked event.
    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [
              { goal: "Plan intake A", prompt: "A." },
              { goal: "Plan intake B", prompt: "B." },
            ],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/exactly one run/);
    expect(harness.listDesignProposals({ projectId })).toHaveLength(1);
    expect(harness.listExternalRefs({ localType: "run", localId: intake.runId })).toHaveLength(0);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
  });

  test("apply-design-actions hook finalizes Linear intake inbox when the Designer rejects a proposal and fails closed for later createRunsFromDesign", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_unaccepted";
    const externalIssueId = "linear-intake-issue-unaccepted";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7003",
      title: "Unaccepted proposal",
    });
    const hook = createApplyDesignActionsHook({ harness });

    // Issue-scoped Designer proposes; auto-approval accepts the low-risk
    // envelope. The test then rejects it manually via decideDesign to simulate
    // an unaccepted path.
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Soon-rejected intake",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const decideOutput: AttemptOutput = {
      status: "done",
      summary: "decide",
      designActions: [
        {
          type: "decideDesign",
          payload: {
            proposalId,
            decision: "rejected",
            reasons: ["test-only rejection"],
          },
        },
      ],
    } as AttemptOutput;
    const decideResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: decideOutput,
    });

    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("rejected");
    // The bounded terminal path finalizes the intake inbox running → done
    // atomically with the decideDesign transaction so a rejected Linear intake
    // cannot stay pending forever. The hook surfaces the finalization as an
    // audit artifact and a passed check.
    const finalizedArtifact = (decideResult.artifacts ?? []).find(
      (artifact) =>
        (artifact as { kind?: string }).kind === "design_intake_finalized" &&
        (artifact as { intakeEventId?: string }).intakeEventId === inboxEventId,
    );
    expect(finalizedArtifact).toBeDefined();
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");

    // createRunsFromDesign against a rejected proposal must fail closed: no
    // run, no task, no reference, no further inbox mutation.
    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/accepted/);
    // The inbox remains done — the failed delivery cannot rewind the lifecycle.
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.listExternalRefs({ localType: "run", localId: intake.runId })).toHaveLength(0);
  });

  test("apply-design-actions hook finalizes Linear intake inbox when the Designer emits a quiescent no-action result", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const inboxEventId = "inbox_intake_quiescent";
    const externalIssueId = "linear-intake-issue-quiescent";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7008",
      title: "Quiescent decision",
    });
    const hook = createApplyDesignActionsHook({ harness });

    // The Designer considers the issue and emits no design actions: a bounded
    // quiescent outcome. The hook's no-action path must finalize the matching
    // intake inbox running → done so the lifecycle cannot stay pending forever.
    const result = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: { status: "done", summary: "nothing to do" } as AttemptOutput,
    });

    expect(result.decision).toBe("exit");
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.listDesignProposals({ projectId })).toHaveLength(0);
  });

  test("apply-design-actions hook rejects createRunsFromDesign when the proposal does not belong to the issue-scoped Designer run", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventIdA = "inbox_intake_ownership_a";
    const externalIssueIdA = "linear-intake-issue-ownership-a";
    const intakeA = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId: inboxEventIdA,
      externalIssueId: externalIssueIdA,
      identifier: "PAN-7010",
      title: "Owner issue",
    });
    // A second intake run for a different immutable Linear issue id. The
    // deterministic run/task IDs differ, so this is a separate Designer cycle.
    const inboxEventIdB = "inbox_intake_ownership_b";
    const externalIssueIdB = "linear-intake-issue-ownership-b";
    const intakeB = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId: inboxEventIdB,
      externalIssueId: externalIssueIdB,
      identifier: "PAN-7011",
      title: "Non-owner issue",
    });
    expect(intakeB.runId).not.toBe(intakeA.runId);

    const hook = createApplyDesignActionsHook({ harness });

    // intakeA proposes and is auto-approved; the durable proposal is pinned to
    // intakeA.runId / intakeA.taskId.
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose on A",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Owner proposal",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intakeA.runId)!,
      task: harness.getTask(intakeA.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    expect(harness.getDesignProposal({ id: proposalId })?.runId).toBe(intakeA.runId);

    // intakeB attempts to deliver against intakeA's accepted proposal. The
    // ownership mismatch must fail closed inside the createRunsFromDesign
    // transaction: no child run, no task, no external reference, and no inbox
    // finalization for either issue.
    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver on B",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Hijack delivery", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(intakeB.runId)!,
      task: harness.getTask(intakeB.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });

    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/must originate from the same issue-scoped Designer/);
    // Neither inbox event was finalized by the failed delivery.
    expect(harness.getInboxEvent({ id: inboxEventIdA })?.status).toBe("running");
    expect(harness.getInboxEvent({ id: inboxEventIdB })?.status).toBe("running");
    expect(harness.listExternalRefs({ localType: "run", localId: intakeA.runId })).toHaveLength(0);
    expect(harness.listExternalRefs({ localType: "run", localId: intakeB.runId })).toHaveLength(0);
  });

  test("apply-design-actions hook leaves Linear intake inbox running when approval is missing", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_missing_approval";
    const externalIssueId = "linear-intake-issue-missing-approval";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7004",
      title: "Missing approval",
    });
    const hook = createApplyDesignActionsHook({ harness });

    // Insert a proposal directly via the harness bypassing the authority
    // evaluator to simulate a proposal without an approved decision.
    const proposal = harness.createDesignProposal({
      projectId,
      title: "No-approval intake",
      problem: "missing approval",
      recommendation: "should not deliver",
      proposal: linearIntakeProposalEnvelope(signalId),
      charterId: null,
      runId: intake.runId,
      taskId: intake.taskId,
      attemptId: null,
      status: "accepted",
    });

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposal.id,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/approved decision/);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
    expect(harness.listExternalRefs({ localType: "run", localId: intake.runId })).toHaveLength(0);
  });

  test("apply-design-actions hook preserves Linear intake finalization across Harness reconstruction and replay", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_reconstruct";
    const externalIssueId = "linear-intake-issue-reconstruct";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7005",
      title: "Reconstruct replay",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Reconstruct replay",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const first = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    const childRunId = (first.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string };
    const originalRefs = harness.listExternalRefs({ localType: "run", localId: childRunId.runId });
    expect(originalRefs).toHaveLength(1);

    // Simulate a daemon restart: rebuild the Harness over the same database
    // file and re-run the same fixed action. Replay must reuse the same run,
    // task, reference, and done event without producing any duplicate rows.
    const rebuilt = new Harness(join(dir, "ouroboros.db"));
    const rebuiltHook = createApplyDesignActionsHook({ harness: rebuilt });
    const replay = await rebuiltHook({
      run: rebuilt.getRun(intake.runId)!,
      task: rebuilt.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replay.decision).toBe("continue");
    const replayRuns = (replay.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(replayRuns).toHaveLength(1);
    expect((replayRuns[0] as { runId: string }).runId).toBe(childRunId.runId);

    const replayedRefs = rebuilt.listExternalRefs({ localType: "run", localId: childRunId.runId });
    expect(replayedRefs).toHaveLength(1);
    expect(replayedRefs[0].id).toBe(originalRefs[0].id);
    expect(rebuilt.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
  });

  test("apply-design-actions hook finalizes Linear intake idempotently when the inbox event is already done", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_already_done";
    const externalIssueId = "linear-intake-issue-already-done";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7006",
      title: "Already done",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Already done replay",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;

    // First call finalizes the inbox event and writes the durable audit row.
    const first = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(first.decision).toBe("continue");
    const childRunId = ((first.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string }).runId;
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");

    // Replay the same fixed action. The audit row is already `done`, so the
    // hook must reconstruct the result without re-executing any mutation: no
    // exceptions, no duplicate runs, no duplicate references, and the inbox
    // event remains durably done.
    const replay = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replay.decision).toBe("continue");
    expect(replay.problems).toBeUndefined();
    const replayRuns = (replay.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    );
    expect(replayRuns).toHaveLength(1);
    expect((replayRuns[0] as { runId: string }).runId).toBe(childRunId);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.listExternalRefs({ localType: "run", localId: childRunId })).toHaveLength(1);
    expect(harness.listDesignProposals({ projectId })).toHaveLength(1);
  });

  test("apply-design-actions hook rejects Linear intake provenance block missing required fields", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_malformed";
    const externalIssueId = "linear-intake-issue-malformed";

    // Plant a malformed intake block on the Designer run context: missing the
    // immutable issue id. The createRunsFromDesign action must fail closed and
    // leave the inbox event untouched.
    const designerRunId = "run_linear_test_malformed";
    const designerTaskId = "task_linear_test_malformed";
    harness.createRun({
      id: designerRunId,
      goal: "designer: malformed intake",
      context: {
        parentRunId: rootRunId,
        source: "linear-intake",
        linearIntake: {
          rootRunId,
          inboxEventId,
          // linearIssueId intentionally omitted
        },
      },
    });
    harness.createTask({
      id: designerTaskId,
      runId: designerRunId,
      role: "designer",
      goal: "designer",
      prompt: "designer",
    });
    harness.createInboxEvent({
      id: inboxEventId,
      provider: "linear",
      eventType: "issue.created",
      externalId: externalIssueId,
      payload: { identifier: "PAN-7007", title: "Malformed" },
      status: "running",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Malformed intake",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(designerRunId)!,
      task: harness.getTask(designerTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(designerRunId)!,
      task: harness.getTask(designerTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/linearIntake\.linearIssueId/);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
  });

  test("apply-design-actions hook ignores polling-only Linear state on non-intake design runs", async () => {
    // The self-improvement root stores the Linear polling cursor under the
    // linearIntake key. That control-plane state is not issue provenance and
    // must not trigger issue-scoped delivery validation.
    const rootRunId = harness.createRun({
      goal: "design run",
      context: {
        source: "self-improve",
        linearIntake: {
          polling: {
            cursor: null,
            lastStatus: "ok",
            cyclesCompleted: 12,
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId: rootRunId,
      role: "designer",
      goal: "design",
      prompt: "design",
    });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Non-intake delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(rootRunId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan non-intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(rootRunId)!,
      task: harness.getTask(taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("continue");
    const childRunArtifact = (deliveryResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string } | undefined;
    expect(childRunArtifact).toBeDefined();
    const childRun = harness.getRun(childRunArtifact!.runId)!;
    expect(childRun.context.linearIntake).toBeUndefined();
    expect(harness.listExternalRefs({ localType: "run", localId: childRun.id })).toHaveLength(0);
  });

  test("apply-design-actions hook rejects a forged after-approveDesign continuation whose bindings target another proposal", async () => {
    // Adversarial: an attacker (or buggy designer) forges a task whose
    // config.designContinuation claims to be an after-approveDesign
    // continuation for proposal P2 — but the task is run from the issue-
    // scoped Designer cycle that proposed P1, and P2 lives on a different
    // cycle. The ownership guard must reject the forged continuation by
    // checking every binding field, not just the kind.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);

    // Two distinct immutable Linear issues → two distinct Designer cycles.
    const intakeA = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId: "inbox_intake_forge_a",
      externalIssueId: "linear-intake-issue-forge-a",
      identifier: "PAN-7201",
      title: "Forged continuation owner",
    });
    const intakeB = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId: "inbox_intake_forge_b",
      externalIssueId: "linear-intake-issue-forge-b",
      identifier: "PAN-7202",
      title: "Forged continuation target",
    });
    expect(intakeA.runId).not.toBe(intakeB.runId);

    const hook = createApplyDesignActionsHook({ harness });

    // intakeA proposes and is auto-approved; the durable proposal P_A is
    // pinned to intakeA's cycle.
    const proposeA: AttemptOutput = {
      status: "done",
      summary: "propose A",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Owner proposal A",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intakeA.runId)!,
      task: harness.getTask(intakeA.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeA,
    });
    const proposalAId = harness.listDesignProposals({ projectId })[0].id;

    // intakeB also proposes and is auto-approved; proposal P_B is pinned to
    // intakeB's cycle. The deterministic proposal IDs differ.
    const proposeB: AttemptOutput = {
      status: "done",
      summary: "propose B",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Target proposal B",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intakeB.runId)!,
      task: harness.getTask(intakeB.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeB,
    });
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(2);
    const proposalBId = proposals.find((p) => p.id !== proposalAId)!.id;
    expect(proposalBId).not.toBe(proposalAId);

    // Forge a continuation task on intakeA's run whose config claims to be
    // the after-approveDesign continuation for proposal P_B (which belongs
    // to intakeB's cycle). The continuation bindings are otherwise well-
    // formed: kind=after-approveDesign, sourceTaskId=intakeA.taskId,
    // proposalId=P_B. The ownership guard must reject this — P_B does not
    // belong to intakeA's cycle.
    const forgedContinuationTaskId = harness.createTask({
      runId: intakeA.runId,
      role: "designer",
      goal: "forged continuation",
      prompt: "forge",
      config: {
        designContinuation: {
          kind: "after-approveDesign",
          proposalId: proposalBId,
          sourceTaskId: intakeA.taskId,
          actionIndex: 0,
        },
      },
    });

    const forgedDelivery: AttemptOutput = {
      status: "done",
      summary: "forge",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposalBId,
            runs: [{ goal: "Forge delivery", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const forgedResult = await hook({
      run: harness.getRun(intakeA.runId)!,
      task: harness.getTask(forgedContinuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: forgedDelivery,
    });
    expect(forgedResult.decision).toBe("exit");
    expect(forgedResult.problems).toBeDefined();
    // The guard rejects forged continuations through multiple layers: the
    // deterministic task-ID check fires when the task carrying the metadata
    // is not the canonical after-approveDesign continuation; the binding
    // check fires when the metadata targets another proposal/run. Either
    // rejection proves the forged continuation cannot deliver.
    expect(forgedResult.problems?.[0]).toMatch(
      /(does not resolve to the canonical after-approveDesign continuation|must originate from the same issue-scoped Designer cycle)/,
    );
    // Neither issue was delivered: no runs, no references, inbox events remain
    // running. The canonical state for both issues is preserved.
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: "linear-intake-issue-forge-a" })).toHaveLength(0);
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: "linear-intake-issue-forge-b" })).toHaveLength(0);
    expect(harness.getInboxEvent({ id: "inbox_intake_forge_a" })?.status).toBe("running");
    expect(harness.getInboxEvent({ id: "inbox_intake_forge_b" })?.status).toBe("running");
  });

  test("apply-design-actions hook rejects a forged task that copies the legitimate after-approveDesign bindings but carries a non-deterministic task ID", async () => {
    // Adversarial: the attacker (or a buggy producer) observes the legitimate
    // after-approveDesign continuation metadata stamped onto the canonical
    // delivery task — kind=after-approveDesign, proposalId=P_A,
    // sourceTaskId=intakeA.taskId, actionIndex=0 — and copies ALL of those
    // bindings onto a different task on the same issue-scoped run. The
    // loose ownership guard (matching only kind/proposalId/sourceTaskId/
    // runId) would accept this forgery, because every binding field is
    // identical to the legitimate continuation. The deterministic task ID
    // check must reject it: the canonical continuation task ID is derived
    // from those same bindings, so only the genuine task (whose ID equals
    // stableContinuationTaskId) can authorize createRunsFromDesign.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_forged_same_proposal";
    const externalIssueId = "linear-intake-issue-forged-same-proposal";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7301",
      title: "Forged same-proposal continuation",
    });

    const hook = createApplyDesignActionsHook({ harness });

    // Propose + auto-approve yields the legitimate proposal P_A and the
    // canonical after-approveDesign continuation task on intake's run.
    const propose: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Legitimate delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: propose,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    const continuationArtifact = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string; proposalId: string } | undefined;
    expect(continuationArtifact).toBeDefined();
    const legitimateContinuationTaskId = continuationArtifact!.taskId;
    const legitimateContinuation = harness.getTask(legitimateContinuationTaskId)!;
    expect(legitimateContinuation.config?.designContinuation).toMatchObject({
      kind: "after-approveDesign",
      proposalId,
      sourceTaskId: intake.taskId,
    });

    // Forge a SECOND task on the same run whose config copies every binding
    // field from the legitimate continuation. The auto-generated task ID is
    // NOT the deterministic stableContinuationTaskId — the forger cannot
    // choose a custom task ID through harness.createTask without already
    // knowing the SHA1-derived canonical ID, and even if they did, that ID
    // would simply BE the legitimate continuation (ensureDesignerContinuation
    // TaskWithDb reuses an existing task at that ID).
    const forgedTaskId = harness.createTask({
      runId: intake.runId,
      role: "designer",
      goal: "forged same-proposal continuation",
      prompt: "forge",
      config: {
        designContinuation: {
          kind: "after-approveDesign",
          proposalId,
          sourceTaskId: intake.taskId,
          actionIndex:
            (legitimateContinuation.config?.designContinuation as { actionIndex?: number } | undefined)?.actionIndex
            ?? 0,
        },
      },
    });
    expect(forgedTaskId).not.toBe(legitimateContinuationTaskId);

    // The forged task attempts createRunsFromDesign for the SAME proposal
    // the legitimate continuation is bound to. Every binding field matches
    // the loose contract; only the deterministic task ID check can reject.
    const forgedDelivery: AttemptOutput = {
      status: "done",
      summary: "forge",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Forge delivery", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const forgedResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(forgedTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: forgedDelivery,
    });
    expect(forgedResult.decision).toBe("exit");
    expect(forgedResult.problems).toBeDefined();
    expect(forgedResult.problems?.[0]).toMatch(
      /does not resolve to the canonical after-approveDesign continuation/,
    );
    // The legitimate continuation has not been driven, so no canonical
    // state exists yet — the forged call must not produce any.
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId })).toHaveLength(0);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");

    // Sanity: the legitimate continuation driving the same action still
    // succeeds after the forgery was rejected — the canonical state is
    // intact and the ownership guard accepts the genuine task.
    const legitDelivery: AttemptOutput = {
      status: "done",
      summary: "legit deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Legit delivery", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const legitResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(legitimateContinuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: legitDelivery,
    });
    expect(legitResult.decision).toBe("continue");
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId })).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
  });

  test("apply-design-actions hook rejects stray after-approveDesign metadata on the original Designer task instead of trusting it for sourceDesignerTaskId", async () => {
    // Adversarial: the original Designer task that ran proposeDesign
    // somehow carries config.designContinuation metadata — a producer
    // defect or corruption attempt. The metadata is supposed to be stamped
    // ONLY on the deterministic after-approveDesign continuation task. The
    // previous loose ownership guard would have accepted the call via
    // sameCycle (proposal.runId === context.run.id && proposal.taskId ===
    // context.task.id) and then stamped continuation.sourceTaskId onto the
    // canonical planning run's linearIntake block — silently redirecting
    // provenance to an attacker-chosen task ID. The strict guard must
    // reject because the metadata is present on a task whose ID is not the
    // canonical after-approveDesign continuation.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_stray_metadata";
    const externalIssueId = "linear-intake-issue-stray-metadata";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7302",
      title: "Stray continuation metadata",
    });

    const hook = createApplyDesignActionsHook({ harness });

    // Run proposeDesign from the original task to mint proposal P_A.
    const propose: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Original-task delivery with stray metadata",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: propose,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    // Inject stray continuation metadata onto the original Designer task.
    // sourceTaskId points at a DIFFERENT task — if the guard trusted the
    // metadata, the stamped sourceDesignerTaskId would become
    // task_straySourceForMetadata instead of the original Designer task.
    const straySourceTaskId = "task_straySourceForMetadata";
    const db = new Database(harness.dbPath);
    const strayConfig = {
      designContinuation: {
        kind: "after-approveDesign",
        proposalId,
        sourceTaskId: straySourceTaskId,
        actionIndex: 0,
      },
    };
    db.query("update tasks set config_json = $config where id = $id").run({
      $config: JSON.stringify(strayConfig),
      $id: intake.taskId,
    });
    db.close();

    // Drive createRunsFromDesign from the original Designer task. sameCycle
    // would authorize via the durable proposal columns, but the strict
    // guard fires first: continuation metadata is present and the task ID
    // is not the canonical after-approveDesign continuation derived from
    // the metadata bindings. The call must fail closed.
    const deliver: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan delivery", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const result = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliver,
    });
    expect(result.decision).toBe("exit");
    expect(result.problems).toBeDefined();
    expect(result.problems?.[0]).toMatch(
      /does not resolve to the canonical after-approveDesign continuation/,
    );
    // No canonical state was mutated: no planning run, no reference, and
    // the inbox event remains running.
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId })).toHaveLength(0);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
  });

  test("apply-design-actions hook rejects a second accepted proposal that attempts to deliver a duplicate planning run for one immutable Linear issue", async () => {
    // Adversarial: one immutable Linear issue, one Designer cycle, but two
    // distinct accepted proposals. The first proposal delivers a canonical
    // planning run + run-to-issue reference. The second proposal attempts
    // createRunsFromDesign again — the issue-level exactly-once guard must
    // fail closed because the canonical reference already exists and binds
    // the issue to the first planning run.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_duplicate_run";
    const externalIssueId = "linear-intake-issue-duplicate-run";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7210",
      title: "Duplicate run guard",
    });

    const hook = createApplyDesignActionsHook({ harness });

    // First proposal on the intake cycle.
    const proposeA: AttemptOutput = {
      status: "done",
      summary: "propose A",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "First delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeAResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeA,
    });
    const proposalAId = harness.listDesignProposals({ projectId })[0].id;
    const continuationArtifact = (proposeAResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string } | undefined;
    expect(continuationArtifact).toBeDefined();
    const continuationAId = continuationArtifact!.taskId;

    // Deliver proposal A from its legitimate continuation.
    const deliverA: AttemptOutput = {
      status: "done",
      summary: "deliver A",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposalAId,
            runs: [{ goal: "Plan A", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliverAResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationAId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverA,
    });
    expect(deliverAResult.decision).toBe("continue");
    const childRunA = (deliverAResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string };
    expect(childRunA).toBeDefined();
    expect(harness.listExternalRefs({ localType: "run", localId: childRunA.runId })).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");

    // Simulate the Designer re-running on the same intake cycle: a fresh
    // designer task on the intake run. proposeDesign on this task creates a
    // second proposal (different stable action audit ID) and the authority
    // evaluator auto-accepts again, producing a second after-approveDesign
    // continuation. The legitimate ownership guard would accept this
    // continuation for proposal B, but the issue-level canonical-state
    // guard must fail closed: the canonical reference for this issue
    // already exists, binds to childRunA, and cannot be replaced.
    const secondDesignerTaskId = harness.createTask({
      runId: intake.runId,
      role: "designer",
      goal: "second designer cycle on same intake",
      prompt: "design",
    });
    const proposeB: AttemptOutput = {
      status: "done",
      summary: "propose B",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Second delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeBResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(secondDesignerTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeB,
    });
    const proposals = harness.listDesignProposals({ projectId });
    expect(proposals).toHaveLength(2);
    const proposalBId = proposals.find((p) => p.id !== proposalAId)!.id;
    const continuationBArtifact = (proposeBResult.artifacts ?? []).find(
      (artifact) =>
        (artifact as { kind?: string }).kind === "design_continuation"
        && (artifact as { proposalId?: string }).proposalId === proposalBId,
    ) as { taskId: string; proposalId: string } | undefined;
    expect(continuationBArtifact).toBeDefined();
    const continuationBId = continuationBArtifact!.taskId;
    expect(continuationBId).not.toBe(continuationAId);

    const deliverB: AttemptOutput = {
      status: "done",
      summary: "deliver B",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId: proposalBId,
            runs: [{ goal: "Plan B", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliverBResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationBId)!,
      sessionName: "session",
      prompt: "design",
      output: deliverB,
    });
    expect(deliverBResult.decision).toBe("exit");
    expect(deliverBResult.problems).toBeDefined();
    // The duplicate-delivery attempt must fail closed. Two layers of defense
    // surface the failure: the canonical-run verify path catches the
    // proposalId mismatch on the existing canonical planning run, and the
    // canonical-reference pre-check catches any localId mismatch. Either
    // error proves the second proposal cannot create a duplicate planning
    // run or reference for the same immutable Linear issue.
    expect(deliverBResult.problems?.[0]).toMatch(/(mismatched linearIntake\.proposalId|already links issue to run)/);

    // The canonical state for proposal A is unchanged: still exactly one
    // planning run, one reference, and one done inbox event. No second
    // planning run was created.
    const refsAfter = harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId });
    expect(refsAfter).toHaveLength(1);
    expect(refsAfter[0].localId).toBe(childRunA.runId);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
  });

  test("apply-design-actions hook leaves Linear intake running when an after-approveDesign continuation emits a no-action result", async () => {
    // Adversarial: the legitimate after-approveDesign continuation task
    // emits no design actions. The hook must NOT finalize the intake inbox
    // (running → done) because the proposal is already accepted — the only
    // legitimate finalization is createRunsFromDesign. Leaving the inbox
    // running preserves the repair path so a later retry can deliver.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_noaction_continuation";
    const externalIssueId = "linear-intake-issue-noaction-continuation";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7220",
      title: "No-action continuation",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "No-action continuation proposal",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    const continuationArtifact = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string } | undefined;
    expect(continuationArtifact).toBeDefined();
    const continuationTaskId = continuationArtifact!.taskId;

    // The continuation emits no design actions. The hook must return exit
    // (no actions to apply), but must NOT terminalize the intake inbox —
    // the proposal is accepted and the only legitimate finalization is a
    // later createRunsFromDesign.
    const noAction: AttemptOutput = {
      status: "done",
      summary: "no action",
    } as AttemptOutput;
    const noActionResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: noAction,
    });
    expect(noActionResult.decision).toBe("exit");
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId })).toHaveLength(0);

    // The repair path remains viable: a later createRunsFromDesign from the
    // same continuation must still create the canonical planning run,
    // reference, and finalize the inbox.
    const repairDelivery: AttemptOutput = {
      status: "done",
      summary: "repair delivery",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan repair", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const repairResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: repairDelivery,
    });
    expect(repairResult.decision).toBe("continue");
    const repairRun = (repairResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string };
    expect(repairRun).toBeDefined();
    expect(harness.listExternalRefs({ localType: "run", localId: repairRun.runId })).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
  });

  test("apply-design-actions hook rejects an after-approveDesign continuation that emits decideDesign to terminalize intake", async () => {
    // Adversarial: the legitimate after-approveDesign continuation task
    // emits decideDesign(rejected) to terminalize the intake inbox. The
    // hook must refuse — the proposal is already accepted and the only
    // legitimate finalization is createRunsFromDesign. decideDesign from
    // this continuation is a producer defect or an attempt to bypass the
    // delivery contract; surfacing it as a hook failure preserves the
    // repair path.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_continuation_decide";
    const externalIssueId = "linear-intake-issue-continuation-decide";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7230",
      title: "Continuation decideDesign",
    });
    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Continuation decideDesign proposal",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    const continuationArtifact = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string } | undefined;
    expect(continuationArtifact).toBeDefined();
    const continuationTaskId = continuationArtifact!.taskId;

    // The continuation emits decideDesign(rejected) for the accepted
    // proposal. The terminal-finalization helper must throw because the
    // task is an after-approveDesign continuation, not the original intake
    // Designer cycle. The intake inbox stays running so the repair path
    // remains viable.
    const decideOutput: AttemptOutput = {
      status: "done",
      summary: "decide",
      designActions: [
        {
          type: "decideDesign",
          payload: {
            proposalId,
            decision: "rejected",
            reasons: ["adversarial continuation"],
          },
        },
      ],
    } as AttemptOutput;
    const decideResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: decideOutput,
    });
    expect(decideResult.decision).toBe("exit");
    expect(decideResult.problems).toBeDefined();
    expect(decideResult.problems?.[0]).toMatch(/after-approveDesign continuation/);
    expect(decideResult.problems?.[0]).toMatch(/cannot terminalize Linear intake/);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId })).toHaveLength(0);
    // The proposal remains accepted — the adversarial decideDesign could not
    // rewind the auto-approval.
    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("accepted");
  });

  // -- Linear intake: verifier-grade exactly-once regression coverage. --
  //
  // The next four tests were added to make the frozen intake contract
  // adversarially explicit. They enter through the production
  // `consumeLinearInbox` and `ingestLinearEvent` paths (no synthetic running
  // events), cover duplicate automatic and manual intake, reject multi-run
  // payloads before any durable mutation, and prove cross-task and
  // cross-action replay leave exactly one decision, one planning run, one
  // run-to-issue external reference, and one done inbox event for the
  // immutable Linear issue.

  test("apply-design-actions hook treats duplicate consumeLinearInbox polls as idempotent for one immutable Linear issue", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_duplicate_poll";
    const externalIssueId = "linear-intake-issue-duplicate-poll";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7401",
      title: "Duplicate poll",
    });

    // Re-poll: simulate the supervisor running consumeLinearInbox again
    // before the fixed-action path finalizes the inbox. The event is now in
    // `running`, so claimAndPlan takes the running-events branch and
    // deduplicates against the durable run/task.
    const repoll = consumeLinearInbox({ harness, rootRunId });
    const repollOutcome = repoll.outcomes.find((o) => o.eventId === inboxEventId);
    expect(repollOutcome).toBeDefined();
    expect(repollOutcome?.kind).toBe("deduplicated");
    expect(repollOutcome?.runId).toBe(intake.runId);
    expect(repollOutcome?.taskId).toBe(intake.taskId);
    expect(repollOutcome?.runCreated).toBe(false);
    expect(repollOutcome?.taskCreated).toBe(false);

    // No duplicate Designer run or task exists. The deterministic IDs
    // derived from (rootRunId, immutable Linear issue id) converge.
    const hook = createApplyDesignActionsHook({ harness });
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Duplicate poll delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryArtifact = (await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    })).artifacts ?? [];
    const childRunId = (deliveryArtifact.find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string }).runId;

    // After delivery, exactly one Designer run, one planner task, one
    // run-to-issue reference, and one done inbox event exist for the issue.
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId }))
      .toHaveLength(1);
    expect(harness.getRun(intake.runId)).toBeDefined();
    expect(harness.getRun(childRunId)).toBeDefined();
    // No second intake Designer run was created by the duplicate poll.
    expect(harness.listRuns({}).filter((run) => run.id.startsWith("run_linear_")).length).toBe(1);
  });

  test("apply-design-actions hook feeds manual linear-ingest-event intake into the same idempotent fixed-action path", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const externalIssueId = "linear-intake-issue-manual";
    const inboxEventId = deterministicLinearInboxIdForTest(externalIssueId);

    // Manual intake path: ingestLinearEvent writes the deterministic inbox
    // row directly (no polling transport). The deterministic id is derived
    // from (provider, eventType, externalId) so repeated manual intake for
    // the same issue converges on the same row.
    const firstIngest = ingestLinearEvent({
      harness,
      eventType: "issue.created",
      externalId: externalIssueId,
      payloadJson: JSON.stringify({
        identifier: "PAN-7402",
        title: "Manual intake",
        url: "https://linear.app/pancat/issue/PAN-7402",
      }),
    });
    expect(firstIngest.created).toBe(true);
    const secondIngest = ingestLinearEvent({
      harness,
      eventType: "issue.created",
      externalId: externalIssueId,
      payloadJson: JSON.stringify({
        identifier: "PAN-7402",
        title: "Manual intake",
        url: "https://linear.app/pancat/issue/PAN-7402",
      }),
    });
    expect(secondIngest.created).toBe(false);
    expect(secondIngest.id).toBe(firstIngest.id);

    // The manual inbox row feeds the same consumeLinearInbox path. The
    // event transitions todo → running and the deterministic intake run/task
    // are created.
    const consume = consumeLinearInbox({ harness, rootRunId });
    const outcome = consume.outcomes.find((o) => o.eventId === inboxEventId);
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("claimed");
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");

    // The fixed-action path finalizes the lifecycle exactly once.
    const hook = createApplyDesignActionsHook({ harness });
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Manual intake delivery",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(outcome!.runId)!,
      task: harness.getTask(outcome!.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan manual intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(outcome!.runId)!,
      task: harness.getTask(outcome!.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("continue");

    // Exactly one decision, one planning run, one external reference, and
    // one done inbox event for the immutable Linear issue.
    const decisions = harness.listDesignDecisions({ proposalId });
    expect(decisions.filter((d) => d.decision === "approved").length).toBe(1);
    const refs = harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId });
    expect(refs).toHaveLength(1);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.listRuns({}).filter((run) => run.id.startsWith("run_linear_")).length).toBe(1);
  });

  test("apply-design-actions hook rejects Linear intake multi-run createRunsFromDesign before any durable mutation", async () => {
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_multi_run_no_mutation";
    const externalIssueId = "linear-intake-issue-multi-run-no-mutation";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7403",
      title: "Multi-run no mutation",
    });

    const hook = createApplyDesignActionsHook({ harness });
    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Multi-run no mutation",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;

    const runsBefore = harness.listRuns({});
    const refsBefore = harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId });

    // Multi-run payload: must be rejected BEFORE any mutation. No child
    // run, no planner task, no run-to-issue reference, no inbox transition.
    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [
              { goal: "Plan A", prompt: "A." },
              { goal: "Plan B", prompt: "B." },
            ],
          },
        },
      ],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(deliveryResult.decision).toBe("exit");
    expect(deliveryResult.problems).toBeDefined();
    expect(deliveryResult.problems?.[0]).toMatch(/exactly one run/);

    // No new runs created by the rejected action (no canonical child run
    // was durable, no partially-created run survived the rollback).
    const runsAfter = harness.listRuns({});
    expect(runsAfter.length).toBe(runsBefore.length);
    expect(runsAfter.filter((run) => run.id.startsWith("run_linear_")).length).toBe(1);
    // The blocked audit row records the rejection — no `done` audit row
    // exists for the multi-run payload.
    const blockedEvents = harness
      .listHarnessActionEvents({ limit: 500 })
      .filter((event) => event.actionType === "design.createRunsFromDesign");
    expect(blockedEvents.every((event) => event.status === "blocked")).toBe(true);
    // No external reference for the issue.
    const refsAfter = harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId });
    expect(refsAfter).toEqual(refsBefore);
    expect(refsAfter).toHaveLength(0);
    // Inbox event stays running — the lifecycle cannot rewind or finalize
    // without durable delivery.
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("running");
    // Proposal remains accepted; the rejection did not rewind authority.
    expect(harness.getDesignProposal({ id: proposalId })?.status).toBe("accepted");
  });

  test("apply-design-actions hook reuses canonical state across cross-action and cross-task replay for one Linear issue", async () => {
    // Adversarial: combine (a) replaying the same createRunsFromDesign
    // action twice from the same continuation task (cross-action replay),
    // (b) replaying the same delivery from a SECOND non-canonical task on
    // the same issue-scoped run (cross-task replay that must fail closed),
    // and (c) verifying the canonical decision/run/reference/inbox quad
    // remains unique after the full adversarial sequence.
    const rootRunId = harness.createRun({ goal: "supervised root run" });
    const projectId = harness.createProject({ name: "ouroboros", rootPath: dir });
    seedActiveCharter(projectId);
    const signalId = seedLowRiskSignal(projectId);
    const inboxEventId = "inbox_intake_cross_replay";
    const externalIssueId = "linear-intake-issue-cross-replay";
    const intake = seedAndConsumeTodoIntake({
      rootRunId,
      inboxEventId,
      externalIssueId,
      identifier: "PAN-7404",
      title: "Cross replay",
    });

    const hook = createApplyDesignActionsHook({ harness });

    const proposeOutput: AttemptOutput = {
      status: "done",
      summary: "propose",
      designActions: [
        {
          type: "proposeDesign",
          payload: {
            projectId,
            title: "Cross replay proposal",
            proposal: linearIntakeProposalEnvelope(signalId),
            status: "proposed",
          },
        },
      ],
    } as AttemptOutput;
    const proposeResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: proposeOutput,
    });
    const proposalId = harness.listDesignProposals({ projectId })[0].id;
    const continuationArtifact = (proposeResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "design_continuation",
    ) as { taskId: string } | undefined;
    expect(continuationArtifact).toBeDefined();
    const continuationTaskId = continuationArtifact!.taskId;

    const deliveryOutput: AttemptOutput = {
      status: "done",
      summary: "deliver",
      designActions: [
        {
          type: "createRunsFromDesign",
          payload: {
            proposalId,
            runs: [{ goal: "Plan intake", prompt: "Plan." }],
          },
        },
      ],
    } as AttemptOutput;

    // First delivery from the canonical continuation task.
    const firstResult = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(firstResult.decision).toBe("continue");
    const childRunId = ((firstResult.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    ) as { runId: string }).runId;

    // Cross-action replay: the same continuation task emits the same
    // createRunsFromDesign again. The canonical run, task, reference, and
    // done inbox event must all be reused — no duplicates.
    const replayFromContinuation = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(continuationTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replayFromContinuation.decision).toBe("continue");
    expect((replayFromContinuation.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    )).toMatchObject({ runId: childRunId });

    // Cross-task replay from the ORIGINAL Designer task that ran
    // proposeDesign. This is a legitimate sameCycle path (proposal.taskId
    // === context.task.id) and must reuse the canonical state.
    const replayFromOriginal = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(intake.taskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replayFromOriginal.decision).toBe("continue");
    expect((replayFromOriginal.artifacts ?? []).find(
      (artifact) => (artifact as { kind?: string }).kind === "created_run",
    )).toMatchObject({ runId: childRunId });

    // Cross-task replay from a SECOND non-canonical task on the same run.
    // The ownership guard must fail closed — neither sameCycle nor
    // legitContinuation applies, so no duplicate run/reference is produced.
    const secondTaskId = harness.createTask({
      runId: intake.runId,
      role: "designer",
      goal: "second non-canonical task",
      prompt: "design",
    });
    const replayFromSecondTask = await hook({
      run: harness.getRun(intake.runId)!,
      task: harness.getTask(secondTaskId)!,
      sessionName: "session",
      prompt: "design",
      output: deliveryOutput,
    });
    expect(replayFromSecondTask.decision).toBe("exit");
    expect(replayFromSecondTask.problems).toBeDefined();
    expect(replayFromSecondTask.problems?.[0]).toMatch(
      /(does not resolve to the canonical after-approveDesign continuation|must originate from the same issue-scoped Designer cycle)/,
    );

    // Final assertion: after the entire adversarial sequence, exactly one
    // decision, one planning run, one run-to-issue external reference, and
    // one done inbox event exist for the immutable Linear issue.
    const decisions = harness.listDesignDecisions({ proposalId });
    expect(decisions.filter((d) => d.decision === "approved").length).toBe(1);
    const refs = harness.findExternalRefs({ provider: "linear", externalType: "issue", externalId: externalIssueId });
    expect(refs).toHaveLength(1);
    expect(refs[0].localId).toBe(childRunId);
    expect(harness.getInboxEvent({ id: inboxEventId })?.status).toBe("done");
    expect(harness.listRuns({}).filter((run) => run.id.startsWith("run_linear_")).length).toBe(1);
  });

  function deterministicLinearInboxIdForTest(externalIssueId: string): string {
    const material = `linear|issue.created|${externalIssueId}`;
    const digest = createHash("sha256").update(material, "utf8").digest("hex");
    return `inbox_linear_${digest}`;
  }

  test("runs multiple ready tasks with separate subagent sessions", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement B",
      prompt: "Implement B.",
    });
    const blockedByFirst = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify A",
      prompt: "Verify A.",
      dependsOn: [first],
    });

    const seenSessions: string[] = [];
    const results = await runReadyTasks({
      harness,
      runId,
      limit: 2,
      sessionForTask: (task) => `session-${task.id}`,
      worktreeForTask: (task) => `/tmp/worktrees/${task.id}`,
      executorFactory: ({ sessionName }) => async ({ task }) => {
        seenSessions.push(sessionName);
        return {
          status: "done",
          summary: `Executed ${task.id} in ${sessionName}`,
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(results.map((result) => result.taskId).sort()).toEqual([first, second].sort());
    expect(seenSessions.sort()).toEqual([`session-${first}`, `session-${second}`].sort());
    expect(harness.getTask(first)?.sessionRef).toBe(`session-${first}`);
    expect(harness.getTask(second)?.sessionRef).toBe(`session-${second}`);
    expect(harness.getTask(first)?.worktreePath).toBe(`/tmp/worktrees/${first}`);
    expect(harness.getTask(second)?.worktreePath).toBe(`/tmp/worktrees/${second}`);
    expect(harness.getTask(blockedByFirst)?.status).toBe("todo");
    expect(harness.nextReadyTask(runId)?.id).toBe(blockedByFirst);
  });

  test("passes task worktree path to executor factory", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const cwdByTask: string[] = [];

    await runReadyTasks({
      harness,
      runId,
      limit: 1,
      worktreeForTask: (task) => `/tmp/worktrees/${task.id}`,
      executorFactory: ({ cwd }) => {
        cwdByTask.push(cwd);
        return async () => ({
          status: "done",
          summary: "ok",
          artifacts: [],
          checks: [],
          problems: [],
        });
      },
    });

    expect(cwdByTask).toEqual([`/tmp/worktrees/${taskId}`]);
  });

  test("runs start hooks before executor", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const events: string[] = [];

    const [result] = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      worktreeForTask: (task) => `/tmp/worktrees/${task.id}`,
      startHooks: [
        async ({ cwd }) => {
          events.push(`start:${cwd}`);
          return {
            checks: [{ name: "start hook", status: "passed" }],
          };
        },
      ],
      executorFactory: () => async () => {
        events.push("executor");
        return {
          status: "done",
          summary: "ok",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(events).toEqual([`start:/tmp/worktrees/${taskId}`, "executor"]);
    expect(harness.getAttempt(result.attemptId)?.output.checks).toEqual([
      { name: "start hook", status: "passed" },
    ]);
  });

  test("git worktree start hook reuses an existing task worktree", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Reuse worktree",
      prompt: "Reuse existing worktree.",
    });
    const cwd = join(dir, "worktrees", taskId);
    await mkdir(cwd, { recursive: true });
    const commands: string[][] = [];

    const hook = createGitWorktreeHook({
      repoPath: dir,
      runCommand: async ({ cmd }) => {
        commands.push(cmd);
        if (cmd.includes("rev-parse")) {
          return { exitCode: 0, stdout: "true\n", stderr: "" };
        }
        if (cmd[0] === "bun") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      },
    });

    const result = await hook({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      sessionName: "task-session",
      cwd,
    });

    expect(commands.some((cmd) => cmd.includes("worktree") && cmd.includes("add"))).toBe(false);
    expect(result.problems).toBeUndefined();
    expect(result.checks).toContainEqual({
      name: "git worktree reuse",
      status: "passed",
      summary: "existing task worktree reused",
    });
    expect(result.checks).toContainEqual({ name: "bun install", status: "passed" });
  });

  test("runs task rounds until no ready task remains", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "planner",
      goal: "Plan worker",
      prompt: "Plan one worker.",
    });

    const result = await runUntilIdle({
      harness,
      runId,
      limit: 1,
      maxRounds: 3,
      stopHooks: [createTasksFromOutputHook({ harness })],
      executorFactory: ({ task }) => async () => {
        if (task.role === "planner") {
          return {
            status: "done",
            summary: "planned",
            artifacts: [],
            checks: [],
            problems: [],
            nextTasks: [
              {
                role: "worker",
                goal: "Generated worker",
                prompt: "Do worker task.",
              },
            ],
          };
        }
        return {
          status: "done",
          summary: "worker done",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].tasks).toHaveLength(1);
    expect(result.rounds[1].tasks).toHaveLength(1);
    expect(harness.nextReadyTask(runId)).toBeNull();
  });

  test("runNextReadyTask creates the persistent attempt before invoking the executor and finishes the same attempt afterwards", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Wire attempt lifecycle",
      prompt: "Use the persisted attempt id.",
    });

    let observedAttemptId = "";
    let runningAttemptSeen = false;
    const executor: (input: { attemptId?: string }) => Promise<AttemptOutput> = async (input) => {
      const attemptId = input.attemptId ?? "";
      observedAttemptId = attemptId;
      const db = new Database(harness.dbPath);
      const row = db
        .query("select status from attempts where id = $id")
        .get({ $id: attemptId }) as { status: string } | null;
      db.close();
      if (row?.status === "running") {
        runningAttemptSeen = true;
      }
      return {
        status: "done",
        summary: `Executed ${attemptId}`,
        artifacts: [],
        checks: [{ name: "executor received attempt id", status: "passed" }],
        problems: [],
      };
    };

    const result = await runNextReadyTask({ harness, runId, executor });

    expect(result?.attemptId).toBeString();
    const attemptId = result!.attemptId;
    expect(observedAttemptId).toBe(attemptId);
    expect(runningAttemptSeen).toBe(true);
    const attempt = harness.getAttempt(attemptId)!;
    expect(attempt.id).toBe(attemptId);
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.status).toBe("done");
    expect(attempt.output.summary).toBe(`Executed ${attemptId}`);
    expect(attempt.output.checks).toContainEqual({
      name: "executor received attempt id",
      status: "passed",
    });
  });

  test("runReadyTasks creates the persistent attempt before invoking the factory executor and finishes the same attempt afterwards", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Wire attempt lifecycle for leased tasks",
      prompt: "Use the persisted attempt id.",
    });

    let observedAttemptId = "";
    let runningAttemptSeen = false;
    const result = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async (input) => {
        const attemptId = input.attemptId ?? "";
        observedAttemptId = attemptId;
        const db = new Database(harness.dbPath);
        const row = db
          .query("select status from attempts where id = $id")
          .get({ $id: attemptId }) as { status: string } | null;
        db.close();
        if (row?.status === "running") {
          runningAttemptSeen = true;
        }
        return {
          status: "done" as const,
          summary: `Executed ${attemptId}`,
          artifacts: [],
          checks: [{ name: "factory executor received attempt id", status: "passed" as const }],
          problems: [],
        };
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].attemptId).toBeString();
    expect(observedAttemptId).toBe(result[0].attemptId);
    expect(runningAttemptSeen).toBe(true);
    const attempt = harness.getAttempt(result[0].attemptId)!;
    expect(attempt.id).toBe(result[0].attemptId);
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.status).toBe("done");
    expect(attempt.output.summary).toBe(`Executed ${result[0].attemptId}`);
  });

  test("runNextReadyTask finishes exactly one blocked attempt when the executor throws", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Handle executor exceptions",
      prompt: "Throw once.",
    });

    let observedAttemptId = "";
    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async (input) => {
        observedAttemptId = input.attemptId ?? "";
        throw new Error("synthetic executor failure");
      },
    });

    expect(result?.attemptId).toBeString();
    const attemptId = result!.attemptId;
    expect(observedAttemptId).toBe(attemptId);
    const attempt = harness.getAttempt(attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.status).toBe("blocked");
    expect(attempt.output.status).toBe("blocked");
    expect(attempt.output.summary).toBe("executor threw before producing output");
    expect(attempt.output.problems).toContain("synthetic executor failure");

    const db = new Database(harness.dbPath);
    const rows = db
      .query("select id, status from attempts where task_id = $taskId order by rowid")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string }>;
    db.close();
    expect(rows).toEqual([{ id: attemptId, status: "blocked" }]);
    expect(harness.getTask(taskId)?.status).toBe("blocked");
  });

  test("runReadyTasks finishes exactly one blocked attempt when the factory executor throws", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Handle leased executor exceptions",
      prompt: "Throw once.",
    });

    const result = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async () => {
        throw new Error("synthetic factory executor failure");
      },
    });

    expect(result).toHaveLength(1);
    const attempt = harness.getAttempt(result[0].attemptId)!;
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.status).toBe("blocked");
    expect(attempt.output.problems).toContain("synthetic factory executor failure");

    const db = new Database(harness.dbPath);
    const rows = db
      .query("select id from attempts where task_id = $taskId order by rowid")
      .all({ $taskId: taskId }) as Array<{ id: string }>;
    db.close();
    expect(rows).toEqual([{ id: result[0].attemptId }]);
  });

  test("runNextReadyTask uses a new attempt id when a legal retry re-runs the task", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Retry once with a fresh attempt",
      prompt: "Run, then run again.",
    });

    const observedAttemptIds: string[] = [];
    const firstResult = await runNextReadyTask({
      harness,
      runId,
      executor: async (input) => {
        observedAttemptIds.push(input.attemptId ?? "");
        return {
          status: "done" as const,
          summary: "First execution done",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
      stopHooks: [
        async () => ({
          decision: "retry" as const,
          problems: ["first attempt needs a retry"],
        }),
      ],
    });

    const firstAttemptId = firstResult!.attemptId;
    expect(firstAttemptId).toBeString();
    expect(observedAttemptIds).toEqual([firstAttemptId]);
    const firstAttempt = harness.getAttempt(firstAttemptId)!;
    expect(firstAttempt.status).toBe("blocked");
    expect(firstAttempt.output.problems).toContain("first attempt needs a retry");
    expect(harness.getTask(taskId)?.status).toBe("todo");

    const secondResult = await runNextReadyTask({
      harness,
      runId,
      executor: async (input) => {
        observedAttemptIds.push(input.attemptId ?? "");
        return {
          status: "done" as const,
          summary: "Second execution done",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    const secondAttemptId = secondResult!.attemptId;
    expect(secondAttemptId).toBeString();
    expect(secondAttemptId).not.toBe(firstAttemptId);
    expect(observedAttemptIds).toEqual([firstAttemptId, secondAttemptId]);

    const db = new Database(harness.dbPath);
    const rows = db
      .query("select id, status from attempts where task_id = $taskId order by rowid")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string }>;
    db.close();
    expect(rows).toEqual([
      { id: firstAttemptId, status: "blocked" },
      { id: secondAttemptId, status: "done" },
    ]);
    expect(harness.getTask(taskId)?.status).toBe("done");
  });

  test("runNextReadyTask records exactly one attempt per invocation and never reuses the id on a later task", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const firstTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "First task",
      prompt: "Run once.",
    });
    const secondTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Second task",
      prompt: "Run again.",
    });

    let firstExecutorCalls = 0;
    const firstResult = await runNextReadyTask({
      harness,
      runId,
      executor: async () => {
        firstExecutorCalls += 1;
        return {
          status: "done" as const,
          summary: "First task done",
          artifacts: [],
          checks: [],
          problems: [],
        };
      },
    });

    expect(firstExecutorCalls).toBe(1);
    const firstAttemptId = firstResult!.attemptId;
    const firstAttempt = harness.getAttempt(firstAttemptId)!;
    expect([firstTaskId, secondTaskId]).toContain(firstAttempt.taskId);
    expect(harness.getTask(firstAttempt.taskId)?.status).toBe("done");

    const secondResult = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done" as const,
        summary: "Second task done",
        artifacts: [],
        checks: [],
        problems: [],
      }),
    });

    const secondAttemptId = secondResult!.attemptId;
    expect(secondAttemptId).toBeString();
    expect(secondAttemptId).not.toBe(firstAttemptId);
    const secondAttempt = harness.getAttempt(secondAttemptId)!;
    expect([firstTaskId, secondTaskId]).toContain(secondAttempt.taskId);
    expect(secondAttempt.taskId).not.toBe(firstAttempt.taskId);

    const db = new Database(harness.dbPath);
    const rows = db
      .query(
        `
        select attempts.id as attempt_id, attempts.task_id as task_id, attempts.status as status
        from attempts
        where attempts.task_id in ($firstTaskId, $secondTaskId)
        order by attempts.rowid
        `,
      )
      .all({ $firstTaskId: firstTaskId, $secondTaskId: secondTaskId }) as Array<{
      attempt_id: string;
      task_id: string;
      status: string;
    }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attempt_id)).toEqual([firstAttemptId, secondAttemptId]);
    expect(rows.map((row) => row.task_id).sort()).toEqual([firstTaskId, secondTaskId].sort());
    expect(rows.every((row) => row.status === "done")).toBe(true);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
