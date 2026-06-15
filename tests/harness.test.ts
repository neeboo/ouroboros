import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, initDatabase, withDatabase } from "../packages/harness/src";

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
    });

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
    });

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

    expect(value.timeout).toBeGreaterThanOrEqual(5000);
  });

  test("seeds and updates prompt templates", () => {
    const seeded = harness.getPromptTemplate("task");
    const verifierSeeded = harness.getPromptTemplate("verifier-task");
    const repairSeeded = harness.getPromptTemplate("repair-task");
    const contextSeeded = harness.getPromptTemplate("context-summary");

    expect(seeded?.contentMd).toContain("# Ouroboros Task");
    expect(seeded?.contentMd).toContain("{{runLessonsJson}}");
    expect(verifierSeeded?.contentMd).toContain("{{sourceTaskId}}");
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

  test("treats blocked dependencies with done repair children as resolved", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const verifier = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify",
      prompt: "Verify.",
    });
    const downstream = harness.createTask({
      runId,
      role: "worker",
      goal: "Continue after repair",
      prompt: "Continue.",
      dependsOn: [verifier],
    });
    harness.recordAttempt({
      taskId: verifier,
      input: {},
      output: {
        status: "blocked",
        summary: "Verification failed",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["needs repair"],
      },
    });
    expect(harness.nextReadyTask(runId)).toBeNull();

    const repair = harness.createTask({
      runId,
      role: "worker",
      goal: "Repair verifier failure",
      prompt: "Repair.",
      parentId: verifier,
    });
    harness.recordAttempt({
      taskId: repair,
      input: {},
      output: {
        status: "done",
        summary: "Repair complete",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    expect(harness.nextReadyTask(runId)?.id).toBe(downstream);
    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `task-${task.id}`,
    });
    expect(leased.map((task) => task.id)).toEqual([downstream]);
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
