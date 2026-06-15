import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import {
  buildTaskPrompt,
  createContextSummaryHook,
  createRepairTaskHook,
  createTasksFromOutputHook,
  createVerifierTaskHook,
  parseAttemptOutput,
  runNextReadyTask,
  runReadyTasks,
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
    expect(prompt).toContain('"nextTasks"');
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
      rawProblem,
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

  test("planner stop hook preserves next task model preference", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const plannerTask = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next work",
      prompt: "Plan one cheap task.",
    });

    await runNextReadyTask({
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

  test("planner stop hook resolves next task goal titles in dependsOn", async () => {
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
    expect(verifier.role).toBe("verifier");
    expect(verifier.goal).toBe("Verify: Implement runner");
    expect(verifier.dependsOn).toEqual([workerTask]);
    expect(verifier.prompt).toContain(`Source Task ID: ${workerTask}`);
    expect(verifier.prompt).toContain("Implemented runner");
    expect(verifier.prompt).toContain("packages/runner/src/runner.ts");
    expect(attempt.output.artifacts).toContainEqual({
      kind: "created_verifier_task",
      taskId: verifier.id,
      sourceTaskId: workerTask,
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

    await runNextReadyTask({
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

    await runNextReadyTask({
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

  test.each([
    ["missing role", { goal: "Goal", prompt: "Prompt" }],
    ["empty goal", { role: "worker", goal: "", prompt: "Prompt" }],
    ["empty prompt", { role: "worker", goal: "Goal", prompt: "  " }],
    ["invalid dependsOn", { role: "worker", goal: "Goal", prompt: "Prompt", dependsOn: "task_1" }],
    ["invalid doneWhen", { role: "worker", goal: "Goal", prompt: "Prompt", doneWhen: [1] }],
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
