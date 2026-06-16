import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import {
  buildTaskPrompt,
  createRunsAction,
  createContextSummaryHook,
  createGitWorktreeHook,
  createGoalReviewDecisionHook,
  createRepairTaskHook,
  createRunsFromOutputHook,
  createTasksAction,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  doneOutput,
  parseAttemptOutput,
  resolveAgentBackend,
  runNextReadyTask,
  runReadyTasks,
  setRunDecisionAction,
  runUntilIdle,
} from "../packages/runner/src";

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
    const runId = harness.createRun({ goal: "Intake requirement document" });
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
      executorFactory: ({ resolvedModel }) => {
        seenModels.push(resolvedModel?.model ?? null);
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
          "role-acpx": { kind: "acpx", agent: "opencode" },
          "global-acpx": { kind: "acpx", agentCommand: "reasonix acp", env: { REASONIX_HOME: "/tmp/reasonix-home" } },
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
      agent: "opencode",
      source: "role-default",
    });
    expect(resolveAgentBackend({ run, task: { ...baseTask, role: "planner" } })).toMatchObject({
      id: "global-acpx",
      kind: "acpx",
      agentCommand: "reasonix acp",
      env: { REASONIX_HOME: "/tmp/reasonix-home" },
      source: "run-default",
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

  test("records resolved backend in attempt input", async () => {
    const runId = harness.createRun({
      goal: "Build loop",
      context: {
        agentDefaults: {
          roles: {
            worker: "opencode",
          },
        },
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use opencode",
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
      attemptInput: ({ run, task, cwd, resolvedModel }) => ({
        backend: resolveAgentBackend({ run, task, cliExecutor: "codex-cli" }),
        cwd,
        model: resolvedModel,
      }),
    });

    expect(harness.getAttempt(result[0].attemptId)?.input).toMatchObject({
      sessionName: `task-${taskId}`,
      cwd: process.cwd(),
      backend: {
        id: "opencode",
        kind: "acpx",
        agent: "opencode",
        source: "role-default",
      },
      model: {
        model: "global-model",
        source: "global",
        role: "worker",
      },
    });
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

  test("blocked verifier stop hook skips repair for external setup blockers", async () => {
    const runId = harness.createRun({ goal: "Prove Hermes support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Hermes readiness",
      prompt: "Verify Hermes.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Hermes readiness is blocked by an external setup blocker.",
        artifacts: [
          {
            kind: "external_setup_blocker",
            command: "bun run scripts/acpx-agent-smoke.ts hermes --doctor",
            diagnostic: "setup blocker: install Hermes CLI or expose hermes/hermes-acp on the normalized child PATH",
          },
        ],
        checks: [{ name: "Hermes doctor", status: "failed", evidence: "missing command: hermes" }],
        problems: ["missing command: hermes; install or expose it on PATH"],
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
    const runId = harness.createRun({ goal: "Prove Hermes support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Hermes auth",
      prompt: "Verify Hermes acpx auth.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Hermes ACP is available, but acpx auth is not configured.",
        artifacts: [
          {
            kind: "external_setup_blocker",
            command: "bun run scripts/acpx-agent-smoke.ts hermes --doctor",
            diagnostic:
              "setup blocker: acpx auth missing for Hermes; add auth.custom or auth.hermes-setup, or export ACPX_AUTH_CUSTOM / ACPX_AUTH_HERMES_SETUP",
          },
        ],
        checks: [{ name: "Hermes ACP check", status: "passed", evidence: "Hermes ACP check OK" }],
        problems: ["setup blocker: acpx auth missing for Hermes"],
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
    const runId = harness.createRun({ goal: "Prove Hermes support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Hermes auth",
      prompt: "Verify Hermes acpx auth.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "setup blocker: acpx auth missing for Hermes",
        problems: ["add auth.custom or auth.hermes-setup before enabling execution"],
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

  test("blocked verifier stop hook skips repair for Hermes provider connection blockers", async () => {
    const runId = harness.createRun({ goal: "Prove Hermes support" });
    const verifierTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify Hermes smoke",
      prompt: "Verify Hermes acpx read-only prompt.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "blocked",
        summary: "Hermes ACP/acpx read-only prompt readiness remains unproven because provider connectivity failed.",
        checks: [
          {
            name: "bun run scripts/acpx-agent-smoke.ts hermes",
            status: "failed",
            evidence: "API call failed after 3 retries: Connection error.",
          },
        ],
        problems: ["Hermes smoke reached session/new, then the provider returned APIConnectionError."],
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
              model: "gpt-5.4-mini",
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
          model: "gpt-5.4-mini",
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
});
