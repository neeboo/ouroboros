import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_TASK_PROMPT_TEMPLATE,
  Harness,
  applyHarnessAction,
  diagnoseRunOverview,
  initDatabase,
  withDatabase,
} from "../packages/harness/src";

describe("Harness", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createBlockedVerifierRepairGraph() {
    const runId = harness.createRun({ goal: "Build loop" });
    const verifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify implementation",
      prompt: "Verify.",
    });
    const downstream = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next",
      prompt: "Plan next.",
      dependsOn: [verifier],
    });
    const repair = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair verifier failure",
      prompt: "Repair.",
      parentId: verifier,
    });
    const repairVerifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify repair",
      prompt: "Verify repair.",
      dependsOn: [repair],
    });

    return { runId, verifier, downstream, repair, repairVerifier };
  }

  function recordTaskStatus(taskId: string, status: "done" | "blocked", summary: string) {
    harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status,
        summary,
        problems: status === "blocked" ? [summary] : [],
      },
    });
  }

  test("creates a run and task", () => {
    const runId = harness.createRun({
      goal: "Bootstrap this repository",
      context: { repo: "ouroboros" },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Create the first task graph",
      prompt: "Plan the smallest useful harness loop.",
      doneWhen: ["task graph exists"],
    });

    const run = harness.getRun(runId);
    const task = harness.getTask(taskId);

    expect(run).toMatchObject({
      id: runId,
      goal: "Bootstrap this repository",
      status: "todo",
      context: { repo: "ouroboros" },
    });
    expect(task).toMatchObject({
      id: taskId,
      runId,
      status: "todo",
      role: "planner",
      config: {},
    });
  });

  test("global run counts exclude retired blocked runs", () => {
    const activeTodoRunId = harness.createRun({ goal: "Active todo" });
    const activeBlockedRunId = harness.createRun({ goal: "Active blocked" });
    const retiredRunId = harness.createRun({
      goal: "Retired duplicate",
      context: {
        retired: true,
        retiredAt: "2026-06-18T00:00:00.000Z",
        retiredReason: "duplicate historical run",
      },
    });

    harness.updateRunStatus({ runId: activeBlockedRunId, status: "blocked" });
    harness.updateRunStatus({ runId: retiredRunId, status: "blocked" });

    expect(harness.countRunsByStatus()).toEqual({
      todo: 1,
      running: 0,
      done: 0,
      blocked: 1,
    });
    expect(harness.getRun(activeTodoRunId)?.status).toBe("todo");
  });

  test("stores readable blocked attempt errors and lessons from structured problem entries", () => {
    const runId = harness.createRun({ goal: "Build verifier serialization" });
    const taskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify structured failures",
      prompt: "Verify readable failures.",
    });

    const attemptId = harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "blocked",
        summary: { summary: "Verifier blocked", status: "blocked" } as unknown as string,
        problems: [
          {
            severity: "high",
            path: "packages/harness/src/harness.ts",
            message: "Structured failure was not readable",
            details: { command: "bun test tests/harness.test.ts" },
          } as unknown as string,
        ],
      },
    });

    const attempt = harness.getAttempt(attemptId)!;
    const lesson = harness.listLessons({ runId }).find((candidate) => candidate.attemptId === attemptId)!;

    expect(attempt.error).toContain("Structured failure was not readable");
    expect(attempt.error).toContain("packages/harness/src/harness.ts");
    expect(attempt.error).not.toContain("[object Object]");
    expect(attempt.output.summary).toContain("Verifier blocked");
    expect(attempt.output.problems?.[0]).toContain("bun test tests/harness.test.ts");
    expect(lesson.summary).toContain("Structured failure was not readable");
    expect(lesson.summary).not.toContain("[object Object]");
  });

  test("stores task model preference in task config", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Cheap worker",
      prompt: "Use a mini model.",
      config: {
        modelPreference: {
          model: "gpt-5-mini",
          reason: "cheap implementation pass",
        },
      },
    });

    expect(harness.getTask(taskId)?.config).toEqual({
      modelPreference: {
        model: "gpt-5-mini",
        reason: "cheap implementation pass",
      },
    });
    expect(harness.nextReadyTask(runId)?.config).toEqual({
      modelPreference: {
        model: "gpt-5-mini",
        reason: "cheap implementation pass",
      },
    });
  });

  test("prevents marking a run done while active tasks remain", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Implement active work",
      prompt: "Implement.",
    });

    expect(() => harness.updateRunStatus({ runId, status: "done" })).toThrow(
      "cannot mark run done while active tasks exist",
    );
    expect(harness.getRun(runId)?.status).toBe("todo");
  });

  test("reopens a done run when a new active task is created", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    harness.updateRunStatus({ runId, status: "done" });

    harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify late evidence",
      prompt: "Verify.",
    });

    expect(harness.getRun(runId)?.status).toBe("todo");
  });

  test("creates projects and binds runs to project metadata", () => {
    const projectId = harness.createProject({
      name: "Ouroboros",
      rootPath: dir,
      context: { linearProject: "ouroboros-acd5df2ef1da" },
    });
    const runId = harness.createRun({
      goal: "Add project workspace",
      projectId,
      context: { source: "test" },
    });

    expect(harness.getProject(projectId)).toMatchObject({
      id: projectId,
      name: "Ouroboros",
      rootPath: dir,
      context: { linearProject: "ouroboros-acd5df2ef1da" },
    });
    expect(harness.listProjects()).toEqual([
      expect.objectContaining({
        id: projectId,
        name: "Ouroboros",
      }),
    ]);
    expect(harness.getRun(runId)).toMatchObject({
      id: runId,
      projectId,
      projectRoot: dir,
    });
    expect(harness.getRunOverview({ runId }).project).toMatchObject({
      id: projectId,
      name: "Ouroboros",
      rootPath: dir,
    });
  });

  test("creates or reuses a project when creating a run from project root", () => {
    const runId = harness.createRun({
      goal: "Bind by root",
      projectRoot: dir,
    });
    const run = harness.getRun(runId);
    const projects = harness.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "ouroboros-" + dir.split("ouroboros-")[1],
      rootPath: dir,
    });
    expect(run?.projectId).toBe(projects[0].id);
    expect(run?.projectRoot).toBe(dir);
  });

  test("migrates old databases with nullable project bindings", async () => {
    const oldDbPath = join(dir, "old.db");
    withDatabase(oldDbPath, (db) => {
      db.exec(`
        create table runs (
          id text primary key,
          goal text not null,
          status text not null,
          context_json text not null default '{}',
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        insert into runs (id, goal, status, context_json)
        values ('run_old', 'Legacy run', 'todo', '{"projectRoot":"/legacy/root"}');
      `);
    }, { allowMissingSchema: true });

    initDatabase(oldDbPath);
    const reopened = new Harness(oldDbPath);

    expect(reopened.getRun("run_old")).toMatchObject({
      id: "run_old",
      projectId: null,
      projectRoot: "/legacy/root",
      context: { projectRoot: "/legacy/root" },
    });
    expect(reopened.getRunOverview({ runId: "run_old" }).project).toBeNull();
  });

  test("migrates old task tables with default empty task config", async () => {
    const oldDbPath = join(dir, "old-tasks.db");
    withDatabase(oldDbPath, (db) => {
      db.exec(`
        create table runs (
          id text primary key,
          goal text not null,
          status text not null,
          context_json text not null default '{}',
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        create table tasks (
          id text primary key,
          run_id text not null references runs(id) on delete cascade,
          parent_id text references tasks(id) on delete set null,
          cycle_id text,
          status text not null,
          role text not null,
          goal text not null,
          prompt text not null,
          depends_on_json text not null default '[]',
          done_when_json text not null default '[]',
          worktree_path text,
          session_ref text,
          context_version integer not null default 1,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        insert into runs (id, goal, status, context_json)
        values ('run_old', 'Legacy run', 'todo', '{}');
        insert into tasks (id, run_id, status, role, goal, prompt)
        values ('task_old', 'run_old', 'todo', 'worker', 'Legacy task', 'Work.');
      `);
    }, { allowMissingSchema: true });

    initDatabase(oldDbPath);
    const reopened = new Harness(oldDbPath);

    expect(reopened.getTask("task_old")).toMatchObject({
      id: "task_old",
      config: {},
    });
  });

  test("migrates old execution thread codex session ids to agent session ids", () => {
    const dbPath = join(dir, "old-execution-threads.db");
    const legacyHarness = new Harness(dbPath);
    legacyHarness.init();
    const runId = legacyHarness.createRun({ goal: "Migrate thread sessions" });
    const taskId = legacyHarness.createTask({
      runId,
      role: "worker",
      goal: "Run legacy session",
      prompt: "Work.",
    });
    const attemptId = legacyHarness.startAttempt({
      taskId,
      input: { sessionName: "legacy-worker", codexSessionId: "codex-legacy" },
    });

    withDatabase(dbPath, (db) => {
      db.exec(`
        drop table execution_threads;
        create table execution_threads (
          id text primary key,
          run_id text not null references runs(id) on delete cascade,
          task_id text references tasks(id) on delete set null,
          attempt_id text references attempts(id) on delete set null,
          parent_thread_id text references execution_threads(id) on delete set null,
          owner_type text not null,
          owner_id text,
          role text not null,
          status text not null check (status in ('running', 'done', 'blocked', 'interrupted', 'orphaned')),
          pid integer,
          session_name text,
          codex_session_id text,
          worktree_path text,
          heartbeat_at text not null default current_timestamp,
          interrupted_at text,
          interrupt_reason text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
      `);
      db.query(
        `
        insert into execution_threads (
          id, run_id, task_id, attempt_id, owner_type, role, status, session_name, codex_session_id
        )
        values ('thread_legacy', $runId, $taskId, $attemptId, 'runner', 'worker', 'running', 'legacy-worker', 'codex-legacy')
        `,
      ).run({ $runId: runId, $taskId: taskId, $attemptId: attemptId });
    });

    const overview = legacyHarness.getRunOverview({ runId });

    expect(overview.threads[0]).toMatchObject({
      id: "thread_legacy",
      agentSessionId: "codex-legacy",
    });
  });

  test("configures sqlite connections to wait briefly on busy databases", () => {
    const value = withDatabase(harness.dbPath, (db) => db.query("pragma busy_timeout").get() as { timeout: number });

    expect(value.timeout).toBeGreaterThanOrEqual(30000);
  });

  test("configures sqlite connections for concurrent read and streamed write workloads", () => {
    const value = withDatabase(harness.dbPath, (db) => db.query("pragma journal_mode").get() as { journal_mode: string });

    expect(value.journal_mode.toLowerCase()).toBe("wal");
  });

  test("withDatabase creates missing parent directories before opening the database", () => {
    const nestedDbPath = join(dir, "nested", ".ouroboros", "ouroboros.db");

    withDatabase(nestedDbPath, (db) => {
      db.exec("create table if not exists smoke (id text primary key)");
      db.query("insert into smoke (id) values ($id)").run({ $id: "ok" });
    }, { allowMissingSchema: true });

    expect(existsSync(nestedDbPath)).toBe(true);
    expect(
      withDatabase(nestedDbPath, (db) => db.query("select id from smoke").get() as { id: string }, {
        allowMissingSchema: true,
      }),
    ).toEqual({ id: "ok" });
  });

  test("withDatabase diagnoses an existing empty Ouroboros database instead of treating it as a new run DB", async () => {
    const emptyDbPath = join(dir, "empty", "ouroboros.db");
    withDatabase(emptyDbPath, () => null, { allowMissingSchema: true });

    expect(() => withDatabase(emptyDbPath, () => null)).toThrow("Ouroboros database is missing schema");
  });

  test("seeds and updates prompt templates", () => {
    const seeded = harness.getPromptTemplate("task");
    const verifierSeeded = harness.getPromptTemplate("verifier-task");
    const repairSeeded = harness.getPromptTemplate("repair-task");
    const contextSeeded = harness.getPromptTemplate("context-summary");

    expect(seeded?.contentMd).toContain("# Ouroboros Task");
    expect(seeded?.contentMd).toContain("{{runLessonsJson}}");
    expect(verifierSeeded?.contentMd).toContain("{{sourceTaskId}}");
    expect(verifierSeeded?.contentMd).toContain("exclude the current verifier task");
    expect(repairSeeded?.contentMd).toContain("{{verifierTaskId}}");
    expect(contextSeeded?.contentMd).toContain("{{attemptOutputJson}}");

    harness.setPromptTemplate({
      key: "task",
      contentMd: "# Custom Task\n{{taskGoal}}\n{{runLessonsJson}}",
    });

    expect(harness.getPromptTemplate("task")).toMatchObject({
      key: "task",
      contentMd: "# Custom Task\n{{taskGoal}}\n{{runLessonsJson}}",
    });
  });

  test("upgrades legacy default task prompt templates", () => {
    const legacyDefaultTaskTemplate = [
      "# Ouroboros Task",
      "",
      "Run Goal: {{runGoal}}",
      "",
      "## Run Context",
      "```json",
      "{{runContextJson}}",
      "```",
      "",
      "## Task",
      "Task ID: {{taskId}}",
      "Role: {{taskRole}}",
      "Goal: {{taskGoal}}",
      "",
      "## Instructions",
      "{{taskPrompt}}",
      "",
      "## Done When",
      "{{doneWhenMarkdown}}",
      "",
      "## Dependency Attempts",
      "```json",
      "{{dependencyAttemptsJson}}",
      "```",
      "",
      "## Run Lessons",
      "```json",
      "{{runLessonsJson}}",
      "```",
      "",
      "## Required Output",
      "Return only JSON with this shape:",
      "```json",
      "{{requiredOutputJson}}",
      "```",
    ].join("\n");
    harness.setPromptTemplate({
      key: "task",
      contentMd: legacyDefaultTaskTemplate,
    });

    harness.init();

    expect(harness.getPromptTemplate("task")?.contentMd).toBe(DEFAULT_TASK_PROMPT_TEMPLATE);
    expect(harness.getPromptTemplate("task")?.contentMd).toContain("{{activeGuardrailsMarkdown}}");
  });

  test("upgrades promoted guardrail default task prompt templates", () => {
    const promotedGuardrailDefaultTaskTemplate = [
      "# Ouroboros Task",
      "",
      "Run Goal: {{runGoal}}",
      "",
      "## Run Context",
      "```json",
      "{{runContextJson}}",
      "```",
      "",
      "## Task",
      "Task ID: {{taskId}}",
      "Role: {{taskRole}}",
      "Goal: {{taskGoal}}",
      "",
      "## Instructions",
      "{{taskPrompt}}",
      "",
      "## Done When",
      "{{doneWhenMarkdown}}",
      "",
      "## Dependency Attempts",
      "```json",
      "{{dependencyAttemptsJson}}",
      "```",
      "",
      "## Promoted Guardrails",
      "{{promotedGuardrailsMarkdown}}",
      "",
      "## Reusable Experience Evidence",
      "{{reusableExperienceEvidenceMarkdown}}",
      "",
      "## Run Lessons",
      "```json",
      "{{runLessonsJson}}",
      "```",
      "",
      "## Required Output",
      "Return only JSON with this shape:",
      "Prefer the `actions` array for follow-up work and run decisions. Supported action types are createTasks, createRuns, and setRunDecision.",
      "```json",
      "{{requiredOutputJson}}",
      "```",
    ].join("\n");
    harness.setPromptTemplate({
      key: "task",
      contentMd: promotedGuardrailDefaultTaskTemplate,
    });

    harness.init();

    expect(harness.getPromptTemplate("task")?.contentMd).toBe(DEFAULT_TASK_PROMPT_TEMPLATE);
    expect(harness.getPromptTemplate("task")?.contentMd).toContain("{{activeGuardrailsMarkdown}}");
  });

  test("preserves custom task prompt templates during prompt seeding", () => {
    const customTemplate = "# Custom Task\n{{taskGoal}}\n{{runLessonsJson}}";
    harness.setPromptTemplate({
      key: "task",
      contentMd: customTemplate,
    });

    harness.init();

    expect(harness.getPromptTemplate("task")?.contentMd).toBe(customTemplate);
  });

  test("waits for dependencies before returning the next ready task", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement",
      prompt: "Implement.",
      dependsOn: [first],
    });

    const ready = harness.nextReadyTask(runId);

    expect(ready?.id).toBe(first);
    expect(ready?.id).not.toBe(second);
  });

  test("assigns task cycles from planners dependencies and parents", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const planner = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan cycle",
      prompt: "Plan.",
    });
    const worker = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement cycle",
      prompt: "Implement.",
      dependsOn: [planner],
    });
    const verifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify cycle",
      prompt: "Verify.",
      dependsOn: [worker],
    });
    const repair = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair cycle",
      prompt: "Repair.",
      parentId: verifier,
    });
    const nextPlanner = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan next cycle",
      prompt: "Plan next.",
      dependsOn: [verifier],
    });

    expect(harness.getTask(planner)?.cycleId).toBe(planner);
    expect(harness.getTask(worker)?.cycleId).toBe(planner);
    expect(harness.getTask(verifier)?.cycleId).toBe(planner);
    expect(harness.getTask(repair)?.cycleId).toBe(planner);
    expect(harness.getTask(nextPlanner)?.cycleId).toBe(nextPlanner);
  });

  test("records a done attempt and unlocks dependent work", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement",
      prompt: "Implement.",
      dependsOn: [first],
    });

    const attemptId = harness.recordAttempt({
      taskId: first,
      input: { prompt: "Plan." },
      output: {
        status: "done",
        summary: "Created task graph",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    expect(harness.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      taskId: first,
      status: "done",
    });
    expect(harness.getTask(first)?.status).toBe("done");
    expect(harness.nextReadyTask(runId)?.id).toBe(second);
  });

  test("repaired blocked verifier unlocks dependent work without changing blocked status", () => {
    const { runId, verifier, downstream, repair, repairVerifier } = createBlockedVerifierRepairGraph();

    recordTaskStatus(verifier, "blocked", "Verifier failed");
    recordTaskStatus(repair, "done", "Added evidence");
    recordTaskStatus(repairVerifier, "done", "Repair verified");

    expect(harness.getTask(verifier)?.status).toBe("blocked");
    expect(harness.nextReadyTask(runId)?.id).toBe(downstream);
  });

  test("repair worker can start when it depends on the blocked verifier it repairs", () => {
    const runId = harness.createRun({ goal: "Repair blocked verifier" });
    const verifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify dashboard UX",
      prompt: "Verify.",
    });
    recordTaskStatus(verifier, "blocked", "Browser smoke failed");
    const repair = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair dashboard UX verifier failures without expanding scope",
      prompt: "Repair.",
      dependsOn: [verifier],
    });

    expect(harness.nextReadyTask(runId)?.id).toBe(repair);
  });

  test("done repair worker without done repair verifier does not unlock dependent work", () => {
    const { runId, verifier, downstream, repair } = createBlockedVerifierRepairGraph();

    recordTaskStatus(verifier, "blocked", "Verifier failed");
    recordTaskStatus(repair, "done", "Added evidence");

    expect(harness.nextReadyTask(runId)?.id).not.toBe(downstream);
  });

  test("blocked repair verifier does not unlock dependent work", () => {
    const { runId, verifier, downstream, repair, repairVerifier } = createBlockedVerifierRepairGraph();

    recordTaskStatus(verifier, "blocked", "Verifier failed");
    recordTaskStatus(repair, "done", "Added evidence");
    recordTaskStatus(repairVerifier, "blocked", "Repair verifier failed");

    expect(harness.nextReadyTask(runId)?.id).not.toBe(downstream);
  });

  test("starts and finishes a resumable running attempt", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "planner-session" },
    });
    const reopened = new Harness(harness.dbPath);

    expect(reopened.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      taskId,
      status: "running",
      input: { sessionName: "planner-session" },
    });
    expect(reopened.getTask(taskId)?.status).toBe("running");
    expect(reopened.listRunningAttempts({ runId })).toEqual([
      expect.objectContaining({ id: attemptId, taskId, status: "running" }),
    ]);

    reopened.finishAttempt({
      attemptId,
      output: {
        status: "done",
        summary: "Planned next task",
        changedFiles: [],
        checks: [{ name: "planner", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    expect(reopened.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      status: "done",
      output: expect.objectContaining({ summary: "Planned next task" }),
    });
    expect(reopened.getTask(taskId)?.status).toBe("done");
    expect(reopened.listLessons({ runId })).toEqual([
      expect.objectContaining({
        attemptId,
        kind: "experience",
        summary: "Planned next task",
      }),
    ]);
  });

  test("reclaims running tasks that never recorded an attempt", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Recover leased task",
      prompt: "Do the work.",
    });

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `task-${task.id}`,
    });

    expect(leased.map((task) => task.id)).toEqual([taskId]);
    expect(harness.getTask(taskId)?.status).toBe("running");
    expect(harness.listRunningAttempts({ runId })).toEqual([]);

    const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId });

    expect(reclaimed).toEqual([
      {
        taskId,
        sessionRef: `task-${taskId}`,
        worktreePath: null,
        reason: "running task has no running attempt",
      },
    ]);
    expect(harness.getTask(taskId)?.status).toBe("todo");
    expect(harness.nextReadyTask(runId)?.id).toBe(taskId);
  });

  test("updates running attempt input for resumable session ids", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        sessionName: "planner-session",
      },
    });

    harness.updateAttemptInput({
      attemptId,
      input: {
        sessionName: "planner-session",
        codexSessionId: "codex-session-1",
      },
    });

    expect(harness.getAttempt(attemptId)?.input).toMatchObject({
      sessionName: "planner-session",
      codexSessionId: "codex-session-1",
    });
  });

  test("records attempt events and builds an observable run overview", () => {
    const runId = harness.createRun({ goal: "Build observable loop" });
    const planner = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan graph",
      prompt: "Plan.",
    });
    const worker = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement graph",
      prompt: "Implement.",
      dependsOn: [planner],
    });
    const plannerAttempt = harness.startAttempt({
      taskId: planner,
      input: {
        sessionName: "planner-session",
        codexSessionId: "codex-planner",
      },
    });
    const workerAttempt = harness.startAttempt({
      taskId: worker,
      input: {
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
      },
    });

    harness.recordAttemptEvent({
      attemptId: plannerAttempt,
      stream: "codex-json",
      sequence: 1,
      payload: {
        type: "agent.message.delta",
        delta: "planning",
      },
    });
    harness.recordAttemptEvent({
      attemptId: workerAttempt,
      stream: "stdout",
      sequence: 1,
      text: "implementing\n",
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 5 });

    expect(overview.run?.id).toBe(runId);
    expect(overview.tasks.map((task) => task.id)).toEqual([planner, worker]);
    expect(overview.lessons).toEqual([]);
    expect(overview.sessions).toEqual([
      expect.objectContaining({
        role: "planner",
        taskId: planner,
        attemptId: plannerAttempt,
        sessionName: "planner-session",
        codexSessionId: "codex-planner",
        status: "running",
        latestText: "planning",
        events: [
          expect.objectContaining({
            stream: "codex-json",
            payload: expect.objectContaining({ delta: "planning" }),
          }),
        ],
      }),
      expect.objectContaining({
        role: "worker",
        taskId: worker,
        attemptId: workerAttempt,
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
        status: "running",
        latestText: "implementing",
      }),
    ]);
  });

  test("records execution threads for supervisor visibility", () => {
    const runId = harness.createRun({ goal: "Supervise execution" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement supervised work",
      prompt: "Work.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
      },
    });
    const threadId = harness.upsertExecutionThread({
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "runner-1",
      role: "worker",
      pid: 1234,
      sessionName: "worker-session",
      agentSessionId: "codex-worker",
      worktreePath: "/tmp/worktree",
    });

    harness.updateExecutionThread({
      id: threadId,
      status: "interrupted",
      interruptReason: "user stopped current task",
      heartbeat: true,
    });

    const [thread] = harness.listExecutionThreads({ runId });
    const overview = harness.getRunOverview({ runId });

    expect(thread).toMatchObject({
      id: threadId,
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      ownerId: "runner-1",
      role: "worker",
      status: "interrupted",
      pid: 1234,
      sessionName: "worker-session",
      agentSessionId: "codex-worker",
      worktreePath: "/tmp/worktree",
      interruptReason: "user stopped current task",
    });
    expect(thread?.interruptedAt).toBeString();
    expect(overview.threads).toContainEqual(expect.objectContaining({ id: threadId, status: "interrupted" }));
  });

  test("diagnoses a healthy draining run", () => {
    const runId = harness.createRun({ goal: "Drain active work" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement active work",
      prompt: "Work.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
      },
    });
    harness.upsertExecutionThread({
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "worker-session",
      agentSessionId: "codex-worker",
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "stdout",
      sequence: 1,
      text: "working\n",
    });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId, eventLimit: 5 }));

    expect(diagnosis.state).toBe("draining");
    expect(diagnosis.activeWork.readyTaskIds).toEqual([]);
    expect(diagnosis.activeWork.runningTaskIds).toEqual([taskId]);
    expect(diagnosis.runningAttempts).toHaveLength(1);
    expect(diagnosis.executionThreads).toHaveLength(1);
    expect(diagnosis.recentAttemptEvents).toEqual([
      expect.objectContaining({
        attemptId,
        taskId,
        stream: "stdout",
      }),
    ]);
    expect(diagnosis.duplicateTaskGoals).toEqual([]);
    expect(diagnosis.emptyRunGoalReviewRaceRisk).toBe(false);
    expect(diagnosis.repeatedBlockedFailures).toEqual([]);
    expect(diagnosis.orphanedLeases).toEqual([]);
    expect(diagnosis.queueStarvation).toBe(false);
  });

  test("diagnoses overseer failure signals from run overview data", () => {
    const runId = harness.createRun({ goal: "Diagnose failures" });
    const readyOne = harness.createTask({
      runId,
      role: "worker",
      goal: "Duplicate goal",
      prompt: "Work.",
    });
    const readyTwo = harness.createTask({
      runId,
      role: "worker",
      goal: "Duplicate goal",
      prompt: "Work again.",
    });
    const blocked = harness.createTask({
      runId,
      role: "worker",
      goal: "Repeated failure",
      prompt: "Recover.",
    });
    const orphaned = harness.createTask({
      runId,
      role: "worker",
      goal: "Orphaned lease",
      prompt: "Lease.",
    });
    const failedAttemptOne = harness.recordAttempt({
      taskId: blocked,
      input: {},
      output: {
        status: "blocked",
        summary: "Database locked",
        problems: ["database locked"],
      },
    });
    const failedAttemptTwo = harness.recordAttempt({
      taskId: blocked,
      input: {},
      output: {
        status: "blocked",
        summary: "Database locked",
        problems: ["database locked"],
      },
    });
    withDatabase(harness.dbPath, (db) => {
      db.query("update tasks set status = 'running', updated_at = current_timestamp where id = $taskId").run({
        $taskId: orphaned,
      });
    });
    harness.upsertExecutionThread({
      runId,
      taskId: orphaned,
      ownerType: "runner",
      role: "worker",
      status: "orphaned",
      interruptReason: "runner exited before attempt",
    });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId, eventLimit: 5 }));

    expect(diagnosis.state).toBe("orphaned");
    expect(diagnosis.activeWork.readyTaskIds).toEqual(expect.arrayContaining([readyOne, readyTwo]));
    expect(diagnosis.duplicateTaskGoals).toEqual([
      expect.objectContaining({
        goal: "Duplicate goal",
        taskIds: expect.arrayContaining([readyOne, readyTwo]),
      }),
    ]);
    expect(diagnosis.repeatedBlockedFailures).toEqual([
      expect.objectContaining({
        taskId: blocked,
        attemptIds: expect.arrayContaining([failedAttemptOne, failedAttemptTwo]),
      }),
    ]);
    expect(diagnosis.orphanedLeases).toEqual([
      expect.objectContaining({
        taskId: orphaned,
      }),
    ]);
    expect(diagnosis.queueStarvation).toBe(true);
    expect(diagnosis.emptyRunGoalReviewRaceRisk).toBe(false);
  });

  test("diagnoses an active run pause from overview context", () => {
    const runId = harness.createRun({
      goal: "Respect human pause",
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
      goal: "Paused work",
      prompt: "Wait.",
    });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId }));

    expect(diagnosis.state).toBe("paused");
    expect(diagnosis.activeWork.readyTaskIds).toEqual([taskId]);
    expect(diagnosis.queueStarvation).toBe(false);
  });

  test("diagnoses uncleared human-stopped interrupted threads as paused", () => {
    const runId = harness.createRun({ goal: "Pause after human stop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Interrupted work",
      prompt: "Work.",
    });
    const attemptId = harness.startAttempt({ taskId, input: {} });
    harness.updateExecutionThread({
      id: harness.upsertExecutionThread({
        runId,
        taskId,
        attemptId,
        ownerType: "runner",
        role: "worker",
        status: "running",
      }),
      status: "interrupted",
      interruptReason: "human requested stop from dashboard",
    });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId }));

    expect(diagnosis.state).toBe("paused");
    expect(diagnosis.executionThreads).toEqual([
      expect.objectContaining({
        status: "interrupted",
        interruptReason: "human requested stop from dashboard",
      }),
    ]);
  });

  test("retrying a task clears durable run pause and supersedes human-stopped threads", () => {
    const runId = harness.createRun({
      goal: "Resume paused run",
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
      goal: "Blocked paused work",
      prompt: "Work.",
    });
    const attemptId = harness.startAttempt({ taskId, input: {} });
    harness.updateExecutionThread({
      id: harness.upsertExecutionThread({
        runId,
        taskId,
        attemptId,
        ownerType: "runner",
        role: "worker",
        status: "running",
      }),
      status: "interrupted",
      interruptReason: "human requested stop from dashboard",
    });
    harness.finishAttempt({
      attemptId,
      output: {
        status: "blocked",
        summary: "Stopped by human",
        problems: ["stopped by human"],
      },
    });

    harness.retryTask({ taskId });

    const run = harness.getRun(runId)!;
    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId }));
    expect(run.context.runPause).toBeNull();
    expect(typeof run.context.runPauseClearedAt).toBe("string");
    expect(diagnosis.state).toBe("orphaned");
    expect(diagnosis.activeWork.readyTaskIds).toEqual([taskId]);
  });

  test("explicit run actions clear durable run pause", () => {
    const markRunId = harness.createRun({
      goal: "Mark paused run todo",
      context: { runPause: { reason: "human requested pause" } },
    });
    const drainRunId = harness.createRun({
      goal: "Drain paused run",
      context: { runPause: { reason: "human requested pause" } },
    });

    applyHarnessAction(harness, { type: "markRunTodo", runId: markRunId });
    applyHarnessAction(harness, { type: "prepareRunDrain", runId: drainRunId });

    expect(harness.getRun(markRunId)?.context.runPause).toBeNull();
    expect(typeof harness.getRun(markRunId)?.context.runPauseClearedAt).toBe("string");
    expect(harness.getRun(drainRunId)?.context.runPause).toBeNull();
    expect(typeof harness.getRun(drainRunId)?.context.runPauseClearedAt).toBe("string");
    expect(diagnoseRunOverview(harness.getRunOverview({ runId: markRunId })).state).not.toBe("paused");
    expect(diagnoseRunOverview(harness.getRunOverview({ runId: drainRunId })).state).not.toBe("paused");
  });

  test("diagnoses the empty-run goal-review race risk", () => {
    const runId = harness.createRun({ goal: "Wait for goal review" });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId }));

    expect(diagnosis.state).toBe("waiting");
    expect(diagnosis.activeWork.readyTaskIds).toEqual([]);
    expect(diagnosis.activeWork.runningTaskIds).toEqual([]);
    expect(diagnosis.runningAttempts).toEqual([]);
    expect(diagnosis.emptyRunGoalReviewRaceRisk).toBe(true);
    expect(diagnosis.queueStarvation).toBe(false);
    expect(diagnosis.duplicateTaskGoals).toEqual([]);
    expect(diagnosis.repeatedBlockedFailures).toEqual([]);
    expect(diagnosis.orphanedLeases).toEqual([]);
  });

  test("diagnoses a blocked-only run", () => {
    const runId = harness.createRun({ goal: "Blocked run" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Blocked work",
      prompt: "Recover.",
    });
    harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Dependency missing",
        problems: ["dependency missing"],
      },
    });

    const diagnosis = diagnoseRunOverview(harness.getRunOverview({ runId }));

    expect(diagnosis.state).toBe("blocked");
    expect(diagnosis.emptyRunGoalReviewRaceRisk).toBe(false);
    expect(diagnosis.duplicateTaskGoals).toEqual([]);
    expect(diagnosis.repeatedBlockedFailures).toEqual([]);
    expect(diagnosis.orphanedLeases).toEqual([]);
    expect(diagnosis.queueStarvation).toBe(false);
  });

  test("records experiences and lessons from attempts", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const successTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const failedTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify A",
      prompt: "Verify A.",
    });
    const successAttempt = harness.recordAttempt({
      taskId: successTask,
      input: {},
      output: {
        status: "done",
        summary: "Using output-last-message avoids noisy stdout parsing.",
        changedFiles: ["packages/runner/src/executors/codex-cli.ts"],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const failedAttempt = harness.recordAttempt({
      taskId: failedTask,
      input: {},
      output: {
        status: "blocked",
        summary: "Verifier failed",
        checks: [{ name: "bun test", status: "failed" }],
        artifacts: [],
        problems: ["workspace package resolution failed inside worktree"],
      },
    });

    const lessons = harness.listLessons({ runId });
    const overview = harness.getRunOverview({ runId });

    expect(lessons).toEqual([
      expect.objectContaining({
        runId,
        taskId: successTask,
        attemptId: successAttempt,
        kind: "experience",
        summary: "Using output-last-message avoids noisy stdout parsing.",
      }),
      expect.objectContaining({
        runId,
        taskId: failedTask,
        attemptId: failedAttempt,
        kind: "lesson",
        summary: "workspace package resolution failed inside worktree",
      }),
    ]);
    expect(overview.lessons).toEqual(lessons);
  });

  test("links a local entity to an external project", () => {
    const runId = harness.createRun({ goal: "Build loop" });

    const refId = harness.createExternalRef({
      localType: "run",
      localId: runId,
      provider: "linear",
      externalType: "project",
      externalId: "ouroboros-acd5df2ef1da",
      externalUrl: "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview",
    });

    expect(harness.listExternalRefs({ localType: "run", localId: runId })).toEqual([
      {
        id: refId,
        localType: "run",
        localId: runId,
        provider: "linear",
        externalType: "project",
        externalId: "ouroboros-acd5df2ef1da",
        externalUrl: "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview",
      },
    ]);
  });

  test("leases ready tasks with session refs", () => {
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
      dependsOn: [first],
    });

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 2,
      sessionForTask: (task) => `session-${task.id}`,
    });

    expect(leased.map((task) => task.id)).toEqual([first]);
    expect(harness.getTask(first)?.status).toBe("running");
    expect(harness.getTask(first)?.sessionRef).toBe(`session-${first}`);
    expect(harness.getTask(second)?.status).toBe("todo");
  });

  test("leases tasks unlocked by verified repair paths", () => {
    const { runId, verifier, downstream, repair, repairVerifier } = createBlockedVerifierRepairGraph();

    recordTaskStatus(verifier, "blocked", "Verifier failed");
    recordTaskStatus(repair, "done", "Added evidence");
    recordTaskStatus(repairVerifier, "done", "Repair verified");

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `session-${task.id}`,
    });

    expect(leased.map((task) => task.id)).toEqual([downstream]);
    expect(harness.getTask(downstream)?.status).toBe("running");
    expect(harness.getTask(verifier)?.status).toBe("blocked");
  });

  test("leases ready tasks with worktree paths", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `session-${task.id}`,
      worktreeForTask: (task) => `/tmp/worktrees/${task.id}`,
    });

    expect(leased[0].id).toBe(taskId);
    expect(leased[0].worktreePath).toBe(`/tmp/worktrees/${taskId}`);
    expect(harness.getTask(taskId)?.worktreePath).toBe(`/tmp/worktrees/${taskId}`);
  });

  test("retries a blocked task", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Network failed",
        problems: ["timeout"],
      },
    });

    harness.retryTask({ taskId });

    expect(harness.getTask(taskId)?.status).toBe("todo");
    expect(harness.nextReadyTask(runId)?.id).toBe(taskId);
  });
});

describe("Harness inbox lifecycle", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-inbox-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("ensureInboxEvent inserts once and treats an identical retry as the same row", () => {
    const first = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_abc",
      provider: "linear",
      eventType: "issue.created",
      externalId: "abc",
      payload: { title: "Linear issue" },
    });
    expect(first.created).toBe(true);
    expect(first.event.id).toBe("inbox_linear_issue_created_abc");
    expect(first.event.status).toBe("todo");
    expect(first.event.processedAt).toBeNull();

    const second = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_abc",
      provider: "linear",
      eventType: "issue.created",
      externalId: "abc",
      payload: { title: "Linear issue" },
    });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe("inbox_linear_issue_created_abc");

    const rows = harness.listInboxEvents({ provider: "linear" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("inbox_linear_issue_created_abc");
  });

  test("ensureInboxEvent fails closed when an existing id has different source fields", () => {
    harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_abc",
      provider: "linear",
      eventType: "issue.created",
      externalId: "abc",
      payload: {},
    });

    expect(() =>
      harness.ensureInboxEvent({
        id: "inbox_linear_issue_created_abc",
        provider: "linear",
        eventType: "issue.updated",
        externalId: "abc",
        payload: {},
      }),
    ).toThrow(/deterministic id collision/);

    expect(() =>
      harness.ensureInboxEvent({
        id: "inbox_linear_issue_created_abc",
        provider: "github",
        eventType: "issue.created",
        externalId: "abc",
        payload: {},
      }),
    ).toThrow(/deterministic id collision/);

    expect(() =>
      harness.ensureInboxEvent({
        id: "inbox_linear_issue_created_abc",
        provider: "linear",
        eventType: "issue.created",
        externalId: "def",
        payload: {},
      }),
    ).toThrow(/deterministic id collision/);

    expect(harness.listInboxEvents({})).toHaveLength(1);
  });

  test("createInboxEvent remains compatible for callers that do not supply a deterministic id", () => {
    const event = harness.createInboxEvent({
      provider: "linear",
      eventType: "issue.created",
      externalId: "LIN-100",
      payload: { ok: true },
    });
    expect(event.id).toMatch(/^inbox_/);
    expect(event.status).toBe("todo");
    expect(event.processedAt).toBeNull();

    const direct = harness.getInboxEvent({ id: event.id });
    expect(direct?.id).toBe(event.id);
  });

  test("transitionInboxEvent claims a todo event and rejects duplicate running claims", () => {
    const ensured = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_claim",
      provider: "linear",
      eventType: "issue.created",
      externalId: "claim-1",
      payload: {},
    });

    const first = harness.transitionInboxEvent({
      id: ensured.event.id,
      from: "todo",
      to: "running",
    });
    expect(first.event.status).toBe("running");
    expect(first.event.processedAt).toBeNull();

    expect(() =>
      harness.transitionInboxEvent({
        id: ensured.event.id,
        from: "todo",
        to: "running",
      }),
    ).toThrow(/expected inbox event .* to be todo, found running/);

    expect(harness.getInboxEvent({ id: ensured.event.id })?.status).toBe("running");
  });

  test("transitionInboxEvent terminalizes running into done or blocked and stamps processedAt", () => {
    const ensured = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_term",
      provider: "linear",
      eventType: "issue.created",
      externalId: "term-1",
      payload: {},
    });

    harness.transitionInboxEvent({ id: ensured.event.id, from: "todo", to: "running" });
    const done = harness.transitionInboxEvent({ id: ensured.event.id, from: "running", to: "done" });
    expect(done.event.status).toBe("done");
    expect(done.event.processedAt).not.toBeNull();
    expect(done.event.processedAt).not.toBe("current_timestamp");
    expect(Number.isNaN(Date.parse(done.event.processedAt as string))).toBe(false);

    const blocked = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_term_blocked",
      provider: "linear",
      eventType: "issue.created",
      externalId: "term-blocked-1",
      payload: {},
    });
    harness.transitionInboxEvent({ id: blocked.event.id, from: "todo", to: "running" });
    const blockedResult = harness.transitionInboxEvent({
      id: blocked.event.id,
      from: "running",
      to: "blocked",
    });
    expect(blockedResult.event.status).toBe("blocked");
    expect(blockedResult.event.processedAt).not.toBeNull();
    expect(blockedResult.event.processedAt).not.toBe("current_timestamp");
    expect(Number.isNaN(Date.parse(blockedResult.event.processedAt as string))).toBe(false);

    expect(() =>
      harness.transitionInboxEvent({ id: ensured.event.id, from: "running", to: "done" }),
    ).toThrow(/expected inbox event .* to be running, found done/);
  });

  test("transitionInboxEvent rejects invalid transitions", () => {
    const ensured = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_invalid",
      provider: "linear",
      eventType: "issue.created",
      externalId: "invalid-1",
      payload: {},
    });

    expect(() =>
      harness.transitionInboxEvent({ id: ensured.event.id, from: "running", to: "done" }),
    ).toThrow(/expected inbox event .* to be running, found todo/);

    expect(() =>
      harness.transitionInboxEvent({
        id: ensured.event.id,
        from: "todo",
        to: "blocked" as never,
      }),
    ).toThrow(/invalid inbox transition/);

    expect(() =>
      harness.transitionInboxEvent({
        id: ensured.event.id,
        from: "todo",
        to: "todo" as never,
      }),
    ).toThrow(/invalid inbox transition/);

    expect(harness.getInboxEvent({ id: ensured.event.id })?.status).toBe("todo");
    expect(harness.getInboxEvent({ id: ensured.event.id })?.processedAt).toBeNull();
  });

  test("transitionInboxEvent reports missing events explicitly", () => {
    expect(() =>
      harness.transitionInboxEvent({
        id: "inbox_missing",
        from: "todo",
        to: "running",
      }),
    ).toThrow(/inbox event not found: inbox_missing/);
  });

  test("ensureInboxEvent is idempotent across harness instances for the same deterministic id", () => {
    const id = "inbox_linear_issue_created_persistence";
    const payload = { identifier: "PAN-1", title: "Persistent issue" };
    const dbPath = join(dir, "ouroboros.db");

    const firstHarness = new Harness(dbPath);
    firstHarness.init();
    const first = firstHarness.ensureInboxEvent({
      id,
      provider: "linear",
      eventType: "issue.created",
      externalId: "persist-1",
      payload,
    });
    expect(first.created).toBe(true);

    // A fresh harness instance simulating a daemon restart observes the
    // durable row and reports created=false; the event is reused, not
    // duplicated.
    const secondHarness = new Harness(dbPath);
    const second = secondHarness.ensureInboxEvent({
      id,
      provider: "linear",
      eventType: "issue.created",
      externalId: "persist-1",
      payload,
    });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(secondHarness.listInboxEvents({ provider: "linear" })).toHaveLength(1);
  });

  test("ensureInboxEvent and transitionInboxEvent cooperate to deduplicate concurrent claim attempts", () => {
    // Two consumers race to claim the same todo event. The first transition
    // succeeds; the second sees the durable state has moved and the
    // transition throws. The idempotent ensure path keeps the inbox at one
    // row regardless of how many consumers attempt the claim.
    const ensured = harness.ensureInboxEvent({
      id: "inbox_linear_issue_created_concurrent",
      provider: "linear",
      eventType: "issue.created",
      externalId: "concurrent-1",
      payload: {},
    });
    const first = harness.transitionInboxEvent({
      id: ensured.event.id,
      from: "todo",
      to: "running",
    });
    expect(first.updated).toBe(true);
    expect(first.event.status).toBe("running");

    expect(() =>
      harness.transitionInboxEvent({
        id: ensured.event.id,
        from: "todo",
        to: "running",
      }),
    ).toThrow(/found running/);

    // Only one durable row exists for the immutable id, regardless of how
    // many claim attempts occurred.
    expect(harness.listInboxEvents({ provider: "linear" })).toHaveLength(1);
  });
});

describe("Harness strategy domain", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createProject(name = "Ouroboros") {
    return harness.createProject({ name, rootPath: dir });
  }

  function sampleCharterData(mission = "Reliable autonomous coding work") {
    return {
      mission,
      targetUsers: ["developer-tools"],
      valueMetrics: ["time-to-integrated-change"],
      principles: ["evidence before opinion"],
      nonGoals: ["viral growth"],
      constraints: ["no production deployment without approval"],
      capitalPolicy: {
        currency: "USD",
        monthlyBudget: 1000,
        experimentBudget: 200,
        recurringSpendApprovalAbove: 100,
        runwayFloorMonths: 12,
        portfolio: { core: 70, growth: 20, exploration: 10 },
      },
      authority: {
        autoResearch: true,
        autoReversibleExperiments: true,
        autoIntegrateVerifiedCode: false,
        requireHumanFor: ["mission", "production", "destructive"],
      },
      reviewCadenceDays: 30,
    };
  }

  function sampleProposalData() {
    return {
      problem: "Workers cannot persist strategy decisions.",
      evidenceRefs: ["signal-1"],
      targetOutcome: "Durable strategy records",
      options: [
        {
          name: "Add strategy tables",
          benefits: ["durable"],
          costs: ["schema work"],
          risks: ["migration"],
          lockIn: ["sqlite"],
        },
      ],
      recommendation: "Add strategy tables now.",
      additions: ["founder_charters"],
      removals: [],
      assumptions: ["migrations remain additive"],
      uncertainty: ["schema upgrade cost"],
      evaluationContract: {
        baseline: ["round-trip tests"],
        successMetrics: ["typed create/get/list"],
        guardMetrics: ["no legacy data loss"],
        requiredEvidence: ["migrations and round-trips pass"],
        reviewAt: "2026-09-01T00:00:00.000Z",
      },
      investment: {
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "P1D",
        reversibility: "easy" as const,
        portfolio: "core" as const,
      },
      experiment: {
        hypothesis: "Additive schema migrations preserve legacy data.",
        smallestTest: "Migrate a legacy test database and assert no rows are lost.",
        stopConditions: ["typecheck or harness tests fail"],
        rollback: "Drop the new tables; existing rows are untouched.",
      },
    };
  }

  test("creates and reads a founder charter and exposes active charter lookup", () => {
    const projectId = createProject();

    const draft = harness.createFounderCharter({
      projectId,
      mission: "Reliable autonomous coding work",
      charter: sampleCharterData(),
    });

    expect(draft).toMatchObject({
      projectId,
      version: 1,
      isActive: false,
      activatedAt: null,
      supersededAt: null,
      mission: "Reliable autonomous coding work",
    });
    expect(draft.charter.capitalPolicy?.portfolio).toEqual({ core: 70, growth: 20, exploration: 10 });

    expect(harness.getFounderCharter({ id: draft.id })?.id).toBe(draft.id);
    expect(harness.getActiveFounderCharter({ projectId })).toBeNull();

    const active = harness.activateFounderCharter({ charterId: draft.id })!;
    expect(active).toMatchObject({ id: draft.id, isActive: true, supersededAt: null });
    expect(active.activatedAt).not.toBeNull();

    expect(harness.getActiveFounderCharter({ projectId })?.id).toBe(draft.id);
    expect(harness.listFounderCharters({ projectId, includeInactive: false })).toEqual([
      expect.objectContaining({ id: draft.id }),
    ]);
    expect(harness.listFounderCharters({ projectId, includeInactive: true })).toHaveLength(1);
  });

  test("activating a charter supersedes the prior active version without deleting history", () => {
    const projectId = createProject();
    const first = harness.createFounderCharter({
      projectId,
      mission: "First charter",
      charter: sampleCharterData("First charter"),
      activate: true,
    });
    const second = harness.createFounderCharter({
      projectId,
      mission: "Second charter",
      charter: sampleCharterData("Second charter"),
      activate: true,
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(harness.getActiveFounderCharter({ projectId })?.id).toBe(second.id);

    const firstRow = harness.getFounderCharter({ id: first.id })!;
    expect(firstRow.isActive).toBe(false);
    expect(firstRow.supersededAt).not.toBeNull();
    expect(firstRow.activatedAt).not.toBeNull();

    const history = harness.listFounderCharters({ projectId, includeInactive: true });
    expect(history.map((charter) => charter.id)).toEqual([second.id, first.id]);
    expect(history.at(-1)).toMatchObject({ id: first.id, version: 1, isActive: false });
  });

  test("rejects a second activation for the same project charter when the unique index fires", () => {
    const projectId = createProject();
    const first = harness.createFounderCharter({
      projectId,
      mission: "First",
      charter: sampleCharterData("First"),
      activate: true,
    });
    const second = harness.createFounderCharter({
      projectId,
      mission: "Second",
      charter: sampleCharterData("Second"),
      activate: true,
    });

    expect(first.isActive).toBe(true);
    expect(second.isActive).toBe(true);
    expect(harness.listFounderCharters({ projectId, includeInactive: true })).toHaveLength(2);

    const active = harness.getActiveFounderCharter({ projectId });
    expect(active?.id).toBe(second.id);
  });

  test("creates and lists expiring and conflicting strategy signals", () => {
    const projectId = createProject();
    const first = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "verifier",
      title: "Cycle time regression",
      summary: "Median cycle time grew by 18%.",
      observationTime: "2026-07-31T00:00:00.000Z",
      confidence: 0.7,
      evidence: [{ metric: "cycle-time", value: 18 }],
      expiresAt: "2026-08-31T00:00:00.000Z",
    });

    expect(first).toMatchObject({
      projectId,
      signalClass: "delivery",
      status: "active",
      expiresAt: "2026-08-31T00:00:00.000Z",
    });
    expect(first.conflictingSignalIds).toEqual([]);
    expect(first.evidence).toEqual([{ metric: "cycle-time", value: 18 }]);

    const conflict = harness.createStrategySignal({
      projectId,
      signalClass: "delivery",
      source: "human-review",
      title: "Cycle time appears stable",
      summary: "Manual sampling did not find a regression.",
      observationTime: "2026-08-01T00:00:00.000Z",
      confidence: 0.5,
      evidence: [{ metric: "cycle-time", value: 2 }],
      conflictingSignalIds: [first.id],
      status: "active",
    });

    expect(harness.getStrategySignal({ id: conflict.id })?.conflictingSignalIds).toEqual([first.id]);
    expect(harness.listStrategySignals({ projectId, statuses: ["active"] })).toHaveLength(2);
    expect(harness.listStrategySignals({ projectId, signalClass: "delivery" })).toHaveLength(2);

    const expired = harness.createStrategySignal({
      projectId,
      signalClass: "market",
      source: "rss",
      title: "Competitor announcement",
      summary: "Pricing change.",
      observationTime: "2026-06-01T00:00:00.000Z",
      confidence: 0.6,
      expiresAt: "2026-06-30T00:00:00.000Z",
      status: "expired",
    });

    expect(harness.listStrategySignals({ projectId, statuses: ["active"] })).toHaveLength(2);
    expect(harness.listStrategySignals({ projectId, statuses: ["active", "expired"] })).toHaveLength(3);
    expect(harness.listStrategySignals({ projectId, statuses: ["expired"] })).toEqual([
      expect.objectContaining({ id: expired.id }),
    ]);
  });

  test("creates design proposals and updates status without losing the frozen evaluation contract", () => {
    const projectId = createProject();
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter for proposal",
      charter: sampleCharterData(),
      activate: true,
    });

    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      title: "Persist strategy records",
      problem: "Strategy state lives only in prompts.",
      recommendation: "Add the five strategy tables.",
      proposal: sampleProposalData(),
    });

    expect(proposal).toMatchObject({
      status: "draft",
      title: "Persist strategy records",
      charterId: charter.id,
    });
    expect(proposal.proposal.evaluationContract.successMetrics).toEqual(["typed create/get/list"]);

    const updated = harness.updateDesignProposalStatus({
      proposalId: proposal.id,
      status: "accepted",
    });

    expect(updated?.status).toBe("accepted");
    expect(updated?.proposal.evaluationContract.reviewAt).toBe("2026-09-01T00:00:00.000Z");

    expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("accepted");
    expect(
      harness.listDesignProposals({ projectId, statuses: ["accepted"] }).map((row) => row.id),
    ).toEqual([proposal.id]);
    expect(harness.listDesignProposals({ projectId, statuses: ["draft"] })).toEqual([]);
  });

  test("records append-only design decisions and outcomes", () => {
    const projectId = createProject();
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter",
      charter: sampleCharterData(),
      activate: true,
    });
    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      title: "Persist strategy records",
      problem: "x",
      recommendation: "Add tables.",
      proposal: sampleProposalData(),
    });

    const firstDecision = harness.recordDesignDecision({
      proposalId: proposal.id,
      charterId: charter.id,
      decision: "deferred",
      actorKind: "auto",
      actorRef: "designer-bootstrap",
      reasons: ["waiting for evidence"],
      authority: { autoApproved: false },
    });

    const secondDecision = harness.recordDesignDecision({
      proposalId: proposal.id,
      charterId: charter.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder",
      reasons: ["evidence is sufficient"],
      authority: { autoApproved: false, manual: true },
    });

    const decisions = harness.listDesignDecisions({ proposalId: proposal.id });
    expect(decisions.map((decision) => decision.id)).toEqual([firstDecision.id, secondDecision.id]);
    expect(decisions[0]).toMatchObject({ decision: "deferred", actorKind: "auto" });
    expect(decisions[1]).toMatchObject({ decision: "approved", actorKind: "human" });

    const outcome = harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "experiment",
      recommendation: "retain",
      baseline: { cycleTime: 100 },
      observed: { cycleTime: 92 },
      evidence: [{ metric: "cycleTime", value: 92 }],
      unexpectedEffects: [],
      reviewAt: "2026-09-15T00:00:00.000Z",
    });

    expect(outcome).toMatchObject({
      recommendation: "retain",
      stage: "experiment",
      reviewAt: "2026-09-15T00:00:00.000Z",
    });
    expect(harness.listDesignOutcomes({ proposalId: proposal.id })).toEqual([
      expect.objectContaining({ id: outcome.id }),
    ]);
    expect(
      harness.listDesignOutcomes({ dueBefore: "2026-10-01T00:00:00.000Z" }).map((row) => row.id),
    ).toEqual([outcome.id]);
    expect(harness.listDesignOutcomes({ dueBefore: "2026-09-01T00:00:00.000Z" })).toEqual([]);
  });

  test("migrates a legacy database without strategy tables and preserves pre-existing records", () => {
    const legacyDbPath = join(dir, "legacy.db");
    withDatabase(
      legacyDbPath,
      (db) => {
        db.exec(`
          create table projects (
            id text primary key,
            name text not null,
            root_path text not null unique,
            context_json text not null default '{}',
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp
          );
          create table runs (
            id text primary key,
            project_id text references projects(id) on delete set null,
            goal text not null,
            status text not null,
            context_json text not null default '{}',
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp
          );
          create table tasks (
            id text primary key,
            run_id text not null references runs(id) on delete cascade,
            parent_id text references tasks(id) on delete set null,
            cycle_id text,
            status text not null,
            role text not null,
            goal text not null,
            prompt text not null,
            depends_on_json text not null default '[]',
            done_when_json text not null default '[]',
            config_json text not null default '{}',
            worktree_path text,
            session_ref text,
            context_version integer not null default 1,
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp
          );
          create table attempts (
            id text primary key,
            task_id text not null references tasks(id) on delete cascade,
            status text not null,
            input_json text not null,
            output_json text not null default '{}',
            checks_json text not null default '[]',
            artifacts_json text not null default '[]',
            error text,
            started_at text not null default current_timestamp,
            finished_at text
          );
          create table attempt_events (
            id text primary key,
            attempt_id text not null references attempts(id) on delete cascade,
            sequence integer not null,
            stream text not null,
            text text,
            payload_json text not null default '{}',
            created_at text not null default current_timestamp,
            unique (attempt_id, sequence)
          );
          create table execution_threads (
            id text primary key,
            run_id text not null references runs(id) on delete cascade,
            task_id text references tasks(id) on delete set null,
            attempt_id text references attempts(id) on delete set null,
            parent_thread_id text references execution_threads(id) on delete set null,
            owner_type text not null,
            owner_id text,
            role text not null,
            status text not null,
            pid integer,
            session_name text,
            agent_session_id text,
            worktree_path text,
            heartbeat_at text not null default current_timestamp,
            interrupted_at text,
            interrupt_reason text,
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp
          );
          create table harness_action_events (
            id text primary key,
            action_type text not null,
            status text not null check (status in ('done', 'blocked')),
            request_json text not null,
            result_json text not null,
            created_at text not null default current_timestamp
          );
          create table lessons (
            id text primary key,
            run_id text not null references runs(id) on delete cascade,
            task_id text not null references tasks(id) on delete cascade,
            attempt_id text not null references attempts(id) on delete cascade,
            kind text not null check (kind in ('experience', 'lesson')),
            summary text not null,
            evidence_json text not null default '{}',
            created_at text not null default current_timestamp
          );
          create table prompt_templates (
            key text primary key,
            content_md text not null,
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp
          );
          create table inbox_events (
            id text primary key,
            provider text not null,
            event_type text not null,
            external_id text not null,
            payload_json text not null,
            status text not null,
            created_at text not null default current_timestamp,
            processed_at text
          );
          create table external_refs (
            id text primary key,
            local_type text not null,
            local_id text not null,
            provider text not null,
            external_type text not null,
            external_id text not null,
            external_url text,
            created_at text not null default current_timestamp,
            unique (local_type, local_id, provider, external_type, external_id)
          );

          insert into projects (id, name, root_path)
          values ('project_legacy', 'Legacy', '/legacy/root');
          insert into runs (id, project_id, goal, status)
          values ('run_legacy', 'project_legacy', 'Legacy run', 'todo');
          insert into tasks (id, run_id, status, role, goal, prompt)
          values ('task_legacy', 'run_legacy', 'todo', 'worker', 'Legacy task', 'Work.');
          insert into attempts (id, task_id, status, input_json)
          values ('attempt_legacy', 'task_legacy', 'done', '{}');
          insert into lessons (id, run_id, task_id, attempt_id, kind, summary)
          values ('lesson_legacy', 'run_legacy', 'task_legacy', 'attempt_legacy', 'experience', 'Legacy experience');
        `);
      },
      { allowMissingSchema: true },
    );

    initDatabase(legacyDbPath);
    const reopened = new Harness(legacyDbPath);

    expect(reopened.getRun("run_legacy")).toMatchObject({ id: "run_legacy", goal: "Legacy run" });
    expect(reopened.getTask("task_legacy")).toMatchObject({ id: "task_legacy" });
    expect(reopened.getAttempt("attempt_legacy")).toMatchObject({ id: "attempt_legacy", status: "done" });
    expect(reopened.listLessons({ runId: "run_legacy" }).map((lesson) => lesson.id)).toEqual([
      "lesson_legacy",
    ]);

    const charter = reopened.createFounderCharter({
      projectId: "project_legacy",
      mission: "Migrated charter",
      charter: sampleCharterData("Migrated"),
      activate: true,
    });
    expect(reopened.getActiveFounderCharter({ projectId: "project_legacy" })?.id).toBe(charter.id);
  });

  test("creates strategy records with run, task, and attempt references", () => {
    const projectId = createProject();
    const runId = harness.createRun({ goal: "Design run", projectId });
    const taskId = harness.createTask({
      runId,
      role: "designer",
      goal: "Propose strategy",
      prompt: "Propose.",
    });
    const attemptId = harness.startAttempt({ taskId, input: {} });
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter",
      charter: sampleCharterData(),
      activate: true,
    });
    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      runId,
      taskId,
      attemptId,
      title: "Persist records",
      problem: "x",
      recommendation: "Add tables",
      proposal: sampleProposalData(),
    });

    expect(proposal).toMatchObject({ runId, taskId, attemptId });

    const signal = harness.createStrategySignal({
      projectId,
      signalClass: "system",
      source: "harness",
      title: "Schema gaps",
      summary: "No strategy tables existed.",
      observationTime: "2026-08-02T00:00:00.000Z",
      confidence: 0.9,
      proposalId: proposal.id,
      runId,
      taskId,
      attemptId,
    });

    expect(signal).toMatchObject({ proposalId: proposal.id, runId, taskId, attemptId });

    const outcome = harness.recordDesignOutcome({
      proposalId: proposal.id,
      stage: "experiment",
      recommendation: "retain",
      runId,
      taskId,
      attemptId,
    });

    expect(outcome).toMatchObject({ runId, taskId, attemptId });
  });

  test("linkProposalOutcomeReview moves an integrated design proposal into measuring and seeds a due review task", () => {
    const projectId = createProject();
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter for outcome review",
      charter: sampleCharterData(),
      activate: true,
    });
    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      title: "Pre-warm cache",
      problem: "Cold cache flake",
      recommendation: "Pre-warm",
      proposal: {
        ...sampleProposalData(),
        evaluationContract: {
          baseline: ["cold-cache 12s"],
          successMetrics: ["cold-cache under 7s"],
          guardMetrics: ["test reliability stable"],
          requiredEvidence: ["three runs"],
        },
      },
      status: "accepted",
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: charter.id,
      reasons: ["reversible"],
    });
    const runId = harness.createRun({
      goal: "design child run",
      context: { source: "design", designProposalId: proposal.id },
    });

    const result = harness.linkProposalOutcomeReview({ runId });
    expect(result.proposalId).toBe(proposal.id);
    expect(result.reviewDue).toBe(true);
    expect(result.outcomeReviewTaskId).toBeString();
    const refreshed = harness.getDesignProposal({ id: proposal.id });
    expect(refreshed?.status).toBe("measuring");
    const task = harness.getTask(result.outcomeReviewTaskId!);
    expect(task?.role).toBe("outcome-review");
    expect(task?.config).toMatchObject({
      designProposalId: proposal.id,
      designSuccessMetrics: ["cold-cache under 7s"],
    });
  });

  test("linkProposalOutcomeReview stays idle when the next review is in the future", () => {
    const projectId = createProject();
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter for future review",
      charter: sampleCharterData(),
      activate: true,
    });
    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      title: "Deferred review",
      problem: "Cold cache",
      recommendation: "Pre-warm",
      proposal: sampleProposalData(),
      status: "accepted",
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: charter.id,
      reasons: ["ok"],
    });
    const runId = harness.createRun({
      goal: "design child run",
      context: { source: "design", designProposalId: proposal.id },
    });
    // sampleProposalData has reviewAt: 2026-09-01. Pin now to 2026-08-02 so it is in the future.
    const result = harness.linkProposalOutcomeReview({ runId, now: Date.parse("2026-08-02T00:00:00.000Z") });
    expect(result.proposalId).toBe(proposal.id);
    expect(result.reviewDue).toBe(false);
    expect(result.outcomeReviewTaskId).toBeNull();
    const refreshed = harness.getDesignProposal({ id: proposal.id });
    expect(refreshed?.status).toBe("measuring");
  });

  test("linkProposalOutcomeReview is idempotent across integrations for the same run", () => {
    const projectId = createProject();
    const charter = harness.createFounderCharter({
      projectId,
      mission: "Charter for idempotent link",
      charter: sampleCharterData(),
      activate: true,
    });
    const proposal = harness.createDesignProposal({
      projectId,
      charterId: charter.id,
      title: "Idempotent",
      problem: "x",
      recommendation: "y",
      proposal: {
        ...sampleProposalData(),
        evaluationContract: {
          baseline: ["x"],
          successMetrics: ["y"],
          guardMetrics: ["z"],
          requiredEvidence: ["e"],
        },
      },
      status: "accepted",
    });
    harness.recordDesignDecision({
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "human",
      actorRef: "founder@example.com",
      charterId: charter.id,
      reasons: ["ok"],
    });
    const runId = harness.createRun({
      goal: "design run",
      context: { source: "design", designProposalId: proposal.id },
    });

    const first = harness.linkProposalOutcomeReview({ runId });
    const second = harness.linkProposalOutcomeReview({ runId });
    expect(first.outcomeReviewTaskId).toBe(second.outcomeReviewTaskId);
    expect(harness.getDesignProposal({ id: proposal.id })?.status).toBe("measuring");
  });

  test("linkProposalOutcomeReview returns null when no design proposal is linked", () => {
    const runId = harness.createRun({ goal: "plain run" });
    const result = harness.linkProposalOutcomeReview({ runId });
    expect(result.proposalId).toBeNull();
    expect(result.outcomeReviewTaskId).toBeNull();
    expect(result.reason).toContain("no designProposalId");
  });
});
