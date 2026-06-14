import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../packages/harness/src";
import { buildTaskPrompt } from "../packages/runner/src";
import { dashboardHtml, handleDashboardRequest } from "../packages/cli/src/dashboard";

describe("dashboard", () => {
  test("renders Codex-style goal navigation for active and history goals", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Active Goals");
    expect(html).toContain('id="active-goal-list"');
    expect(html).toContain('id="history-goal-list"');
    expect(html).toContain("todo");
    expect(html).toContain("running");
    expect(html).toContain("/prompt");
    expect(html).toContain('id="goal-composer"');
    expect(html).toContain("Interrupt + replan");
    expect(html).toContain("No active tasks. Open a blocked history goal and rerun it, or add a new goal.");
    expect(html).toContain("data-resume-task-id");
    expect(html).toContain("data-stop-attempt-id");
    expect(html).toContain("Stop current task");
    expect(html).toContain("data-rerun-task-id");
    expect(html).toContain("Rerun task");
    expect(html).toContain("data-start-runner");
    expect(html).toContain("data-stop-runner");
    expect(html).toContain("Start runner");
    expect(html).toContain("Connection timed out");
    expect(html).toContain("runnerIssue");
  });

  test("renders workspace and inspector regions for sessions prompts and lessons", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('id="workspace-flow"');
    expect(html).toContain('id="inspector-panel"');
    expect(html).toContain("buildGoalGroups");
    expect(html).toContain("task.cycleId");
    expect(html).toContain("transcript");
    expect(html).toContain("stream-output");
    expect(html).toContain("stream-line");
    expect(html).toContain("eventText");
    expect(html).toContain("streamOutput");
    expect(html).toContain("renderWorkspace");
    expect(html).toContain("renderInspector");
  });

  test("renders task doneWhen items in the todo inspector", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("todo-list");
    expect(html).toContain("doneWhen");
    expect(html).toContain("checkbox");
    expect(html).toContain(".todo-item.done");
    expect(html).toContain("current-task");
    expect(html).toContain("aria-hidden");
    expect(html).toContain("Progress");
    expect(html).not.toContain("<h2>Lessons</h2>");
    expect(html).not.toContain("<h2>Queue</h2>");
    expect(html).not.toContain("<h2>Run Info</h2>");
  });

  test("polls overview through a worker instead of a main-thread interval", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("overviewWorkerSource");
    expect(html).toContain("new Worker");
    expect(html).toContain("new Blob");
    expect(html).not.toContain("setInterval");
  });

  test("serves a rendered task prompt preview as plain text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Bootstrap dashboard prompt previews" });
    const dependencyId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement dependency",
      prompt: "Build the upstream piece.",
    });
    harness.recordAttempt({
      taskId: dependencyId,
      input: {},
      output: {
        status: "done",
        summary: "Dependency implemented summary",
        changedFiles: ["src/dependency.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Preview rendered dashboard prompts",
      prompt: "Render the current task prompt.",
      dependsOn: [dependencyId],
    });

    const response = await handleDashboardRequest(
      new Request(`http://localhost/tasks/${taskId}/prompt`),
      {
        runId,
        overview: () => harness.getRunOverview({ runId }),
        renderTaskPrompt: (requestedTaskId) => {
          const task = harness.getTask(requestedTaskId);
          if (!task) throw new Error(`task not found: ${requestedTaskId}`);
          const run = harness.getRun(task.runId);
          if (!run) throw new Error(`run not found: ${task.runId}`);
          return buildTaskPrompt({
            run,
            task,
            dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
            lessons: harness.listLessons({ runId: run.id }),
            template: harness.getPromptTemplate("task")?.contentMd,
          });
        },
      },
    );
    try {
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(body).toContain("Goal: Preview rendered dashboard prompts");
      expect(body).toContain("Dependency implemented summary");
      expect(body).toContain("src/dependency.ts");
      expect(body).toContain("Run Lessons");
      expect(body).toContain("Dependency implemented summary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles dashboard goal interrupt and resume actions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-actions-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Bootstrap interactive control" });
    const runningTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Long running task",
      prompt: "Keep working.",
    });
    const runningAttemptId = harness.startAttempt({
      taskId: runningTaskId,
      input: { sessionName: "task-long-running", codexSessionId: "codex_123" },
    });
    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
      runnerStatus: () => ({ status: "idle" as const, pid: null }),
      actions: {
        startRunner: () => ({ status: "running", pid: 1234 }),
        stopRunner: () => ({ status: "blocked", pid: 1234 }),
        createGoal: (goal: string) => ({
          taskId: harness.createTask({
            runId,
            role: "planner",
            goal: `Plan user goal: ${goal}`,
            prompt: goal,
            doneWhen: ["planned"],
          }),
          status: "todo",
        }),
        interruptAndCreateGoal: (goal: string) => {
          const running = harness.listRunningAttempts({ runId });
          for (const attempt of running) {
            harness.finishAttempt({
              attemptId: attempt.id,
              output: {
                status: "blocked",
                summary: "Interrupted by dashboard",
                changedFiles: [],
                checks: [{ name: "dashboard interrupt", status: "failed" }],
                artifacts: [],
                problems: [goal],
              },
            });
          }
          return {
            taskId: harness.createTask({
              runId,
              role: "planner",
              goal: `Replan after user interruption: ${goal}`,
              prompt: goal,
              doneWhen: ["replanned"],
            }),
            status: "todo",
            interrupted: running.length,
          };
        },
        resumeTask: (taskId: string) => {
          harness.retryTask({ taskId });
          return { taskId, status: "todo" };
        },
        rerunTask: (taskId: string) => {
          harness.retryTask({ taskId });
          return { taskId, status: "todo" };
        },
        stopAttempt: (attemptId: string) => {
          const attempt = harness.getAttempt(attemptId);
          if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
          harness.finishAttempt({
            attemptId,
            output: {
              status: "blocked",
              summary: "Stopped by dashboard",
              changedFiles: [],
              checks: [{ name: "dashboard stop", status: "failed" }],
              artifacts: [],
              problems: ["user stopped the task"],
            },
          });
          return { attemptId, taskId: attempt.taskId, status: "blocked" };
        },
      },
    };

    try {
      const overviewResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        dashboardInput,
      );
      const overviewBody = await overviewResponse.json();
      expect(overviewBody.runner).toEqual({ status: "idle", pid: null });

      const startRunnerResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/runner/start`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const startRunnerBody = await startRunnerResponse.json();
      expect(startRunnerResponse.status).toBe(200);
      expect(startRunnerBody.status).toBe("running");

      const stopRunnerResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/runner/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const stopRunnerBody = await stopRunnerResponse.json();
      expect(stopRunnerResponse.status).toBe(200);
      expect(stopRunnerBody.status).toBe("blocked");

      const stopResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/attempts/${runningAttemptId}/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const stopBody = await stopResponse.json();
      expect(stopResponse.status).toBe(200);
      expect(stopBody.status).toBe("blocked");
      expect(harness.getAttempt(runningAttemptId)?.status).toBe("blocked");
      expect(harness.getTask(runningTaskId)?.status).toBe("blocked");

      const rerunResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/tasks/${runningTaskId}/rerun`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const rerunBody = await rerunResponse.json();
      expect(rerunResponse.status).toBe(200);
      expect(rerunBody.status).toBe("todo");
      expect(harness.getTask(runningTaskId)?.status).toBe("todo");

      harness.startAttempt({
        taskId: runningTaskId,
        input: { sessionName: "task-long-running-again", codexSessionId: "codex_456" },
      });

      const addResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/goals`, {
          method: "POST",
          body: JSON.stringify({ goal: "Add a new dashboard control" }),
        }),
        dashboardInput,
      );
      const addBody = await addResponse.json();
      expect(addResponse.status).toBe(200);
      expect(harness.getTask(addBody.taskId)?.role).toBe("planner");

      const interruptResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/interrupt`, {
          method: "POST",
          body: JSON.stringify({ goal: "Change direction now" }),
        }),
        dashboardInput,
      );
      const interruptBody = await interruptResponse.json();
      expect(interruptResponse.status).toBe(200);
      expect(interruptBody.interrupted).toBe(1);
      expect(harness.getTask(runningTaskId)?.status).toBe("blocked");

      const resumeResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/tasks/${runningTaskId}/resume`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const resumeBody = await resumeResponse.json();
      expect(resumeResponse.status).toBe(200);
      expect(resumeBody.status).toBe("todo");
      expect(harness.getTask(runningTaskId)?.status).toBe("todo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
