import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../packages/harness/src";
import { buildTaskPrompt } from "../packages/runner/src";
import { dashboardHtml, handleDashboardRequest } from "../packages/cli/src/dashboard";

describe("dashboard", () => {
  test("renders a dedicated active queue region for todo and running tasks", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Active Task Focus");
    expect(html).toContain('id="active-focus"');
    expect(html).toContain("todo");
    expect(html).toContain("running");
    expect(html).toContain("/prompt");
  });

  test("renders history task detail regions for sessions prompts and lessons", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('id="history-task-list"');
    expect(html).toContain('id="task-detail"');
    expect(html).toContain("sessionsForTaskChain");
    expect(html).toContain("lessonsForTaskChain");
    expect(html).toContain("Prompt Detail");
  });

  test("renders task doneWhen items as a checklist", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("checklist");
    expect(html).toContain("doneWhen");
    expect(html).toContain("checkbox");
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

    const response = handleDashboardRequest(
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
});
