import { initDatabase, withDatabase } from "./database";
import {
  DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE,
  DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE,
  DEFAULT_TASK_PROMPT_TEMPLATE,
  DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE,
  LEGACY_DEFAULT_TASK_PROMPT_TEMPLATES,
} from "./default-prompts";
import { makeId } from "./ids";
import { toJson } from "./json";
import {
  attemptEventFromRow,
  attemptFromRow,
  executionThreadFromRow,
  externalRefFromRow,
  harnessActionEventFromRow,
  lessonFromRow,
  projectFromRow,
  promptTemplateFromRow,
  runFromRow,
  taskFromRow,
} from "./mappers";
import type {
  AttemptEventRow,
  AttemptRow,
  ExecutionThreadRow,
  ExternalRefRow,
  HarnessActionEventRow,
  LessonRow,
  ProjectRow,
  PromptTemplateRow,
  RunRow,
  TaskRow,
} from "./rows";
import type {
  CreateProjectInput,
  CreateExternalRefInput,
  SetPromptTemplateInput,
  CreateRunInput,
  CreateTaskInput,
  DependencyAttempt,
  FinishAttemptInput,
  GetHarnessActionEventInput,
  GetRunOverviewInput,
  LeaseReadyTasksInput,
  ListExecutionThreadsInput,
  ListHarnessActionEventsInput,
  ListRunningAttemptsInput,
  ListExternalRefsInput,
  ListLessonsInput,
  ListRunsInput,
  RecordAttemptEventInput,
  RecordAttemptInput,
  RecordHarnessActionEventInput,
  BlockedUnfinishedTask,
  BlockUnfinishedTasksForRunInput,
  ReclaimedRunningTask,
  ReclaimRunningTasksInput,
  RetryTaskInput,
  StartAttemptInput,
  Status,
  Task,
  UpdateRunStatusInput,
  UpdateRunInput,
  UpdateAttemptInputInput,
  UpdateExecutionThreadInput,
  UpsertExecutionThreadInput,
} from "./types";
import { basename, resolve } from "node:path";
import { readableList, readableValue } from "./readable";

const ATTEMPT_EVENT_BUSY_RETRIES = 5;

export class Harness {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  init() {
    initDatabase(this.dbPath);
    this.seedPromptTemplates();
  }

  createProject(input: CreateProjectInput) {
    const id = input.id ?? makeId("project");
    const rootPath = resolve(input.rootPath);
    return withDatabase(this.dbPath, (db) => {
      const existing = db.query("select * from projects where root_path = $rootPath").get({ $rootPath: rootPath }) as
        | ProjectRow
        | null;
      if (existing) {
        return existing.id;
      }
      db.query(
        `
        insert into projects (id, name, root_path, context_json)
        values ($id, $name, $rootPath, $contextJson)
        `,
      ).run({
        $id: id,
        $name: input.name,
        $rootPath: rootPath,
        $contextJson: toJson(input.context ?? {}),
      });
      return id;
    });
  }

  getProject(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from projects where id = $id").get({ $id: id }) as ProjectRow | null;
      return row ? projectFromRow(row) : null;
    });
  }

  listProjects() {
    return withDatabase(this.dbPath, (db) => {
      const rows = db.query("select * from projects order by created_at, id").all() as ProjectRow[];
      return rows.map(projectFromRow);
    });
  }

  createRun(input: CreateRunInput) {
    const id = input.id ?? makeId("run");
    return withDatabase(this.dbPath, (db) => {
      const projectId = resolveRunProjectId(db, input);
      db.query(
        `
        insert into runs (id, project_id, goal, status, context_json)
        values ($id, $projectId, $goal, 'todo', $contextJson)
        `,
      ).run({
        $id: id,
        $projectId: projectId,
        $goal: input.goal,
        $contextJson: toJson(input.context ?? {}),
      });
      return id;
    });
  }

  updateRunStatus(input: UpdateRunStatusInput) {
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        update runs
        set status = $status, updated_at = current_timestamp
        where id = $runId
        `,
      ).run({
        $status: input.status,
        $runId: input.runId,
      });
    });
  }

  updateRun(input: UpdateRunInput) {
    return withDatabase(this.dbPath, (db) => {
      const existing = db.query("select * from runs where id = $runId").get({ $runId: input.runId }) as RunRow | null;
      if (!existing) {
        return null;
      }
      const current = runFromRow(existing);
      const nextContext = input.contextPatch ? { ...current.context, ...input.contextPatch } : current.context;
      db.query(
        `
        update runs
        set goal = $goal,
            status = $status,
            context_json = $contextJson,
            updated_at = current_timestamp
        where id = $runId
        `,
      ).run({
        $goal: input.goal ?? current.goal,
        $status: input.status ?? current.status,
        $contextJson: toJson(nextContext),
        $runId: input.runId,
      });
      return this.getRun(input.runId);
    });
  }

  clearRunPause(runId: string) {
    return this.updateRun({
      runId,
      contextPatch: {
        runPause: null,
        runPauseClearedAt: new Date().toISOString(),
      },
    });
  }

  createTask(input: CreateTaskInput) {
    const id = input.id ?? makeId("task");
    return withDatabase(this.dbPath, (db) => {
      const cycleId = resolveTaskCycleId(db, {
        id,
        role: input.role,
        parentId: input.parentId ?? null,
        dependsOn: input.dependsOn ?? [],
        cycleId: input.cycleId ?? null,
      });
      db.query(
        `
        insert into tasks (
          id, run_id, parent_id, cycle_id, status, role, goal, prompt,
          depends_on_json, done_when_json, worktree_path, config_json
        )
        values (
          $id, $runId, $parentId, $cycleId, 'todo', $role, $goal, $prompt,
          $dependsOnJson, $doneWhenJson, $worktreePath, $configJson
        )
        `,
      ).run({
        $id: id,
        $runId: input.runId,
        $parentId: input.parentId ?? null,
        $cycleId: cycleId,
        $role: input.role,
        $goal: input.goal,
        $prompt: input.prompt,
        $dependsOnJson: toJson(input.dependsOn ?? []),
        $doneWhenJson: toJson(input.doneWhen ?? []),
        $worktreePath: input.worktreePath ?? null,
        $configJson: toJson(input.config ?? {}),
      });
      return id;
    });
  }

  getRun(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          where runs.id = $id
          `,
        )
        .get({ $id: id }) as RunRow | null;
      return row ? runFromRow(row) : null;
    });
  }

  getTask(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from tasks where id = $id").get({ $id: id }) as TaskRow | null;
      return row ? taskFromRow(row) : null;
    });
  }

  getAttempt(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from attempts where id = $id").get({ $id: id }) as AttemptRow | null;
      return row ? attemptFromRow(row) : null;
    });
  }

  listRunningAttempts(input: ListRunningAttemptsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select attempts.*
          from attempts
          join tasks on tasks.id = attempts.task_id
          where tasks.run_id = $runId and attempts.status = 'running'
          order by attempts.started_at, attempts.id
          `,
        )
        .all({ $runId: input.runId }) as AttemptRow[];
      return rows.map(attemptFromRow);
    });
  }

  reclaimRunningTasksWithoutAttempts(input: ReclaimRunningTasksInput): ReclaimedRunningTask[] {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const rows = db
        .query(
          `
          select tasks.*
          from tasks
          left join attempts on attempts.task_id = tasks.id and attempts.status = 'running'
          where tasks.run_id = $runId
            and tasks.status = 'running'
            and attempts.id is null
          order by tasks.created_at, tasks.id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const reclaimed = rows.map(taskFromRow).map((task) => ({
        taskId: task.id,
        sessionRef: task.sessionRef,
        worktreePath: task.worktreePath,
        reason: "running task has no running attempt",
      }));
      if (reclaimed.length === 0) {
        return reclaimed;
      }
      return db.transaction(() => {
        for (const task of reclaimed) {
          db.query(
            `
            update tasks
            set status = 'todo', updated_at = current_timestamp
            where id = $taskId and status = 'running'
            `,
          ).run({ $taskId: task.taskId });
          db.query(
            `
            update execution_threads
            set status = 'orphaned',
                interrupt_reason = $reason,
                interrupted_at = coalesce(interrupted_at, current_timestamp),
                updated_at = current_timestamp
            where task_id = $taskId and attempt_id is null and status = 'running'
            `,
          ).run({ $taskId: task.taskId, $reason: task.reason });
        }
        return reclaimed;
      })();
    });
  }

  listLatestAttemptsForTasks(taskIds: string[]): DependencyAttempt[] {
    if (taskIds.length === 0) {
      return [];
    }

    return withDatabase(this.dbPath, (db) => {
      const latestAttemptQuery = db.query(`
        select *
        from attempts
        where task_id = $taskId
        order by finished_at desc, started_at desc, rowid desc
        limit 1
      `);
      return taskIds.flatMap((taskId) => {
        const row = latestAttemptQuery.get({ $taskId: taskId }) as AttemptRow | null;
        if (!row) {
          return [];
        }
        const attempt = attemptFromRow(row);
        return [
          {
            taskId,
            attemptId: attempt.id,
            status: attempt.output.status,
            summary: attempt.output.summary,
            changedFiles: attempt.output.changedFiles ?? [],
            checks: attempt.output.checks ?? [],
            artifacts: attempt.output.artifacts ?? [],
            problems: attempt.output.problems ?? [],
          },
        ];
      });
    });
  }

  nextReadyTask(runId: string) {
    return withDatabase(this.dbPath, (db) => {
      const taskRows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId and status = 'todo'
          order by created_at, id
          `,
        )
        .all({ $runId: runId }) as TaskRow[];
      const allTaskRows = db.query("select * from tasks where run_id = $runId").all({ $runId: runId }) as TaskRow[];
      const dependencyIsSatisfied = createDependencyReadiness(allTaskRows.map(taskFromRow));

      for (const row of taskRows) {
        const task = taskFromRow(row);
        if (task.dependsOn.every((dependencyId) => dependencyIsSatisfied(dependencyId, task))) {
          return task;
        }
      }
      return null;
    });
  }

  blockUnfinishedTasksForRun(input: BlockUnfinishedTasksForRunInput): BlockedUnfinishedTask[] {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const rows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId and status in ('todo', 'running')
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const blocked = rows.map(taskFromRow).map((task) => ({
        taskId: task.id,
        role: task.role,
        previousStatus: task.status as Extract<Status, "todo" | "running">,
        reason: input.reason,
      }));
      if (blocked.length === 0) {
        return blocked;
      }
      const output = {
        status: "blocked",
        summary: `Task was blocked because its run was retired: ${input.reason}`,
        changedFiles: [],
        checks: [{ name: "run retirement", status: "blocked", evidence: input.reason }],
        artifacts: [],
        problems: [input.reason],
      };
      return db.transaction(() => {
        for (const task of blocked) {
          db.query(
            `
            update attempts
            set status = 'blocked',
                output_json = $outputJson,
                checks_json = $checksJson,
                artifacts_json = '[]',
                error = $error,
                finished_at = current_timestamp
            where task_id = $taskId and status = 'running'
            `,
          ).run({
            $taskId: task.taskId,
            $outputJson: toJson(output),
            $checksJson: toJson(output.checks),
            $error: input.reason,
          });
          db.query(
            `
            update tasks
            set status = 'blocked', updated_at = current_timestamp
            where id = $taskId and status in ('todo', 'running')
            `,
          ).run({ $taskId: task.taskId });
          db.query(
            `
            update execution_threads
            set status = 'interrupted',
                interrupt_reason = $reason,
                interrupted_at = coalesce(interrupted_at, current_timestamp),
                updated_at = current_timestamp
            where task_id = $taskId and status = 'running'
            `,
          ).run({ $taskId: task.taskId, $reason: input.reason });
        }
        return blocked;
      })();
    });
  }

  leaseReadyTasks(input: LeaseReadyTasksInput) {
    return withDatabase(this.dbPath, (db) => {
      const taskRows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId and status = 'todo'
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const allTaskRows = db
        .query("select * from tasks where run_id = $runId")
        .all({ $runId: input.runId }) as TaskRow[];
      const dependencyIsSatisfied = createDependencyReadiness(allTaskRows.map(taskFromRow));
      const ready = taskRows
        .map(taskFromRow)
        .filter((task) => task.dependsOn.every((dependencyId) => dependencyIsSatisfied(dependencyId, task)))
        .slice(0, input.limit);

      return db.transaction(() => {
        for (const task of ready) {
          const sessionRef = input.sessionForTask(task);
          const worktreePath = input.worktreeForTask?.(task) ?? task.worktreePath;
          db.query(
            `
            update tasks
            set status = 'running',
                session_ref = $sessionRef,
                worktree_path = $worktreePath,
                updated_at = current_timestamp
            where id = $taskId and status = 'todo'
            `,
          ).run({
            $sessionRef: sessionRef,
            $worktreePath: worktreePath,
            $taskId: task.id,
          });
          task.status = "running";
          task.sessionRef = sessionRef;
          task.worktreePath = worktreePath;
        }
        return ready;
      })();
    });
  }

  recordAttempt(input: RecordAttemptInput) {
    const output = normalizeAttemptOutput(input.output);
    if (output.status !== "done" && output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const id = input.id ?? makeId("attempt");
    const problems = output.problems ?? [];
    return withDatabase(this.dbPath, (db) => {
      db.transaction(() => {
        db.query(
          `
          insert into attempts (
            id, task_id, status, input_json, output_json,
            checks_json, artifacts_json, error, finished_at
          )
          values (
            $id, $taskId, $status, $inputJson, $outputJson,
            $checksJson, $artifactsJson, $error, current_timestamp
          )
          `,
        ).run({
          $id: id,
          $taskId: input.taskId,
          $status: output.status,
          $inputJson: toJson(input.input),
          $outputJson: toJson(output),
          $checksJson: toJson(output.checks ?? []),
          $artifactsJson: toJson(output.artifacts ?? []),
          $error: problems.length > 0 ? problems.join("\n") : null,
        });
        db.query(
          `
          update tasks
          set status = $status, updated_at = current_timestamp
          where id = $taskId
          `,
        ).run({
          $status: output.status,
          $taskId: input.taskId,
        });
        const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as
          | TaskRow
          | null;
        if (taskRow) {
          const lesson = lessonForAttempt(output);
          db.query(
            `
            insert into lessons (
              id, run_id, task_id, attempt_id, kind, summary, evidence_json
            )
            values (
              $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
            )
            `,
          ).run({
            $id: makeId("lesson"),
            $runId: taskRow.run_id,
            $taskId: input.taskId,
            $attemptId: id,
            $kind: lesson.kind,
            $summary: lesson.summary,
            $evidenceJson: toJson(lesson.evidence),
          });
        }
      })();
      return id;
    });
  }

  startAttempt(input: StartAttemptInput) {
    const id = input.id ?? makeId("attempt");
    return withDatabase(this.dbPath, (db) => {
      db.transaction(() => {
        db.query(
          `
          insert into attempts (
            id, task_id, status, input_json, output_json,
            checks_json, artifacts_json, error, finished_at
          )
          values (
            $id, $taskId, 'running', $inputJson, '{}',
            '[]', '[]', null, null
          )
          `,
        ).run({
          $id: id,
          $taskId: input.taskId,
          $inputJson: toJson(input.input),
        });
        db.query(
          `
          update tasks
          set status = 'running', updated_at = current_timestamp
          where id = $taskId
          `,
        ).run({ $taskId: input.taskId });
      })();
      return id;
    });
  }

  finishAttempt(input: FinishAttemptInput) {
    const output = normalizeAttemptOutput(input.output);
    if (output.status !== "done" && output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const problems = output.problems ?? [];
    return withDatabase(this.dbPath, (db) => {
      db.transaction(() => {
        db.query(
          `
          update attempts
          set status = $status,
              output_json = $outputJson,
              checks_json = $checksJson,
              artifacts_json = $artifactsJson,
              error = $error,
              finished_at = current_timestamp
          where id = $attemptId and status = 'running'
          `,
        ).run({
          $status: output.status,
          $outputJson: toJson(output),
          $checksJson: toJson(output.checks ?? []),
          $artifactsJson: toJson(output.artifacts ?? []),
          $error: problems.length > 0 ? problems.join("\n") : null,
          $attemptId: input.attemptId,
        });
        const attemptRow = db.query("select * from attempts where id = $attemptId").get({
          $attemptId: input.attemptId,
        }) as AttemptRow | null;
        if (!attemptRow) {
          throw new Error(`attempt not found: ${input.attemptId}`);
        }
        db.query(
          `
          update tasks
          set status = $status, updated_at = current_timestamp
          where id = $taskId
          `,
        ).run({
          $status: output.status,
          $taskId: attemptRow.task_id,
        });
        const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: attemptRow.task_id }) as
          | TaskRow
          | null;
        if (taskRow) {
          const lesson = lessonForAttempt(output);
          db.query(
            `
            insert into lessons (
              id, run_id, task_id, attempt_id, kind, summary, evidence_json
            )
            values (
              $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
            )
            `,
          ).run({
            $id: makeId("lesson"),
            $runId: taskRow.run_id,
            $taskId: attemptRow.task_id,
            $attemptId: input.attemptId,
            $kind: lesson.kind,
            $summary: lesson.summary,
            $evidenceJson: toJson(lesson.evidence),
          });
        }
      })();
    });
  }

  updateAttemptInput(input: UpdateAttemptInputInput) {
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        update attempts
        set input_json = $inputJson
        where id = $attemptId
        `,
      ).run({
        $inputJson: toJson(input.input),
        $attemptId: input.attemptId,
      });
    });
  }

  recordAttemptEvent(input: RecordAttemptEventInput) {
    const id = input.id ?? makeId("event");
    for (let retry = 0; retry <= ATTEMPT_EVENT_BUSY_RETRIES; retry += 1) {
      try {
        return withDatabase(this.dbPath, (db) => {
          db.query(
            `
            insert into attempt_events (
              id, attempt_id, sequence, stream, text, payload_json
            )
            values (
              $id, $attemptId, $sequence, $stream, $text, $payloadJson
            )
            on conflict(attempt_id, sequence) do update set
              stream = excluded.stream,
              text = excluded.text,
              payload_json = excluded.payload_json
            `,
          ).run({
            $id: id,
            $attemptId: input.attemptId,
            $sequence: input.sequence,
            $stream: input.stream,
            $text: input.text ?? null,
            $payloadJson: toJson(input.payload ?? {}),
          });
          return id;
        });
      } catch (error) {
        if (!isSqliteBusyError(error) || retry === ATTEMPT_EVENT_BUSY_RETRIES) {
          throw error;
        }
        sleepSync(25 * (retry + 1));
      }
    }
    return id;
  }

  listRuns(input: ListRunsInput = {}) {
    return withDatabase(this.dbPath, (db) => {
      const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
      const statuses = input.statuses?.filter((status) =>
        status === "todo" || status === "running" || status === "done" || status === "blocked"
      ) ?? [];
      const rows = statuses.length > 0
        ? db
          .query(
            `
            select runs.*, projects.root_path as project_root
            from runs
            left join projects on projects.id = runs.project_id
            where runs.status in (${statuses.map((_, index) => `$status${index}`).join(", ")})
            order by runs.created_at, runs.id
            limit $limit
            `,
          )
          .all(Object.fromEntries([
            ...statuses.map((status, index) => [`$status${index}`, status]),
            ["$limit", limit],
          ])) as RunRow[]
        : db
          .query(
            `
            select runs.*, projects.root_path as project_root
            from runs
            left join projects on projects.id = runs.project_id
            order by runs.created_at, runs.id
            limit $limit
            `,
          )
          .all({ $limit: limit }) as RunRow[];
      return rows.map(runFromRow);
    });
  }

  countRunsByStatus() {
    return withDatabase(this.dbPath, (db) => {
      const counts = { todo: 0, running: 0, done: 0, blocked: 0 };
      const rows = db
        .query(
          `
          select status, count(*) as count
          from runs
          where json_extract(context_json, '$.retired') is not 1
          group by status
          `,
        )
        .all() as { status: Status; count: number }[];
      for (const row of rows) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    });
  }

  recordHarnessActionEvent(input: RecordHarnessActionEventInput) {
    const id = input.id ?? makeId("action");
    return withDatabase(this.dbPath, (db) => {
      ensureHarnessActionEvents(db);
      db.query(
        `
        insert into harness_action_events (
          id, action_type, status, request_json, result_json
        )
        values (
          $id, $actionType, $status, $requestJson, $resultJson
        )
        `,
      ).run({
        $id: id,
        $actionType: input.actionType,
        $status: input.status,
        $requestJson: toJson(input.request),
        $resultJson: toJson(input.result),
      });
      return id;
    });
  }

  listHarnessActionEvents(input: ListHarnessActionEventsInput = {}) {
    return withDatabase(this.dbPath, (db) => {
      ensureHarnessActionEvents(db);
      const rows = db
        .query(
          `
          select *
          from harness_action_events
          order by created_at desc, id desc
          limit $limit
          `,
        )
        .all({ $limit: input.limit ?? 50 }) as HarnessActionEventRow[];
      return rows.map(harnessActionEventFromRow);
    });
  }

  getHarnessActionEvent(input: GetHarnessActionEventInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureHarnessActionEvents(db);
      const row = db.query("select * from harness_action_events where id = $id").get({ $id: input.id }) as
        | HarnessActionEventRow
        | null;
      return row ? harnessActionEventFromRow(row) : null;
    });
  }

  upsertExecutionThread(input: UpsertExecutionThreadInput) {
    const id = input.id ?? makeId("thread");
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      db.query(
        `
        insert into execution_threads (
          id, run_id, task_id, attempt_id, parent_thread_id,
          owner_type, owner_id, role, status, pid,
          session_name, agent_session_id, worktree_path, interrupt_reason
        )
        values (
          $id, $runId, $taskId, $attemptId, $parentThreadId,
          $ownerType, $ownerId, $role, $status, $pid,
          $sessionName, $agentSessionId, $worktreePath, $interruptReason
        )
        on conflict(id) do update set
          run_id = excluded.run_id,
          task_id = excluded.task_id,
          attempt_id = excluded.attempt_id,
          parent_thread_id = excluded.parent_thread_id,
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          role = excluded.role,
          status = excluded.status,
          pid = excluded.pid,
          session_name = excluded.session_name,
          agent_session_id = excluded.agent_session_id,
          worktree_path = excluded.worktree_path,
          heartbeat_at = current_timestamp,
          interrupt_reason = excluded.interrupt_reason,
          updated_at = current_timestamp
        `,
      ).run({
        $id: id,
        $runId: input.runId,
        $taskId: input.taskId ?? null,
        $attemptId: input.attemptId ?? null,
        $parentThreadId: input.parentThreadId ?? null,
        $ownerType: input.ownerType,
        $ownerId: input.ownerId ?? null,
        $role: input.role,
        $status: input.status ?? "running",
        $pid: input.pid ?? null,
        $sessionName: input.sessionName ?? null,
        $agentSessionId: input.agentSessionId ?? null,
        $worktreePath: input.worktreePath ?? null,
        $interruptReason: input.interruptReason ?? null,
      });
      return id;
    });
  }

  updateExecutionThread(input: UpdateExecutionThreadInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const existing = db.query("select * from execution_threads where id = $id").get({ $id: input.id }) as
        | ExecutionThreadRow
        | null;
      if (!existing) {
        return;
      }
      const status = input.status ?? existing.status;
      db.query(
        `
        update execution_threads
        set status = $status,
            owner_id = $ownerId,
            pid = $pid,
            session_name = $sessionName,
            agent_session_id = $agentSessionId,
            worktree_path = $worktreePath,
            heartbeat_at = case when $heartbeat then current_timestamp else heartbeat_at end,
            interrupted_at = case when $interrupted then current_timestamp else interrupted_at end,
            interrupt_reason = $interruptReason,
            updated_at = current_timestamp
        where id = $id
        `,
      ).run({
        $id: input.id,
        $status: status,
        $ownerId: input.ownerId ?? existing.owner_id,
        $pid: input.pid ?? existing.pid,
        $sessionName: input.sessionName ?? existing.session_name,
        $agentSessionId: input.agentSessionId ?? existing.agent_session_id,
        $worktreePath: input.worktreePath ?? existing.worktree_path,
        $heartbeat: input.heartbeat === true ? 1 : 0,
        $interrupted: status === "interrupted" ? 1 : 0,
        $interruptReason: input.interruptReason ?? existing.interrupt_reason,
      });
    });
  }

  listExecutionThreads(input: ListExecutionThreadsInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const rows = db
        .query(
          `
          select *
          from execution_threads
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as ExecutionThreadRow[];
      return rows.map(executionThreadFromRow);
    });
  }

  getRunOverview(input: GetRunOverviewInput) {
    return withDatabase(this.dbPath, (db) => {
      const runRow = db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          where runs.id = $runId
          `,
        )
        .get({ $runId: input.runId }) as RunRow | null;
      const projectRow = runRow?.project_id
        ? (db.query("select * from projects where id = $projectId").get({ $projectId: runRow.project_id }) as
            | ProjectRow
            | null)
        : null;
      const taskRows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId
          order by rowid
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const tasks = taskRows.map(taskFromRow);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const attemptRows = db
        .query(
          `
          select attempts.*, attempts.started_at as started_at
          from attempts
          join tasks on tasks.id = attempts.task_id
          where tasks.run_id = $runId
          order by attempts.rowid
          `,
        )
        .all({ $runId: input.runId }) as Array<AttemptRow & { started_at: string | null }>;
      const eventQuery = db.query(
        `
        select *
        from attempt_events
        where attempt_id = $attemptId
        order by sequence desc
        limit $limit
        `,
      );
      const eventLimit = input.eventLimit ?? 25;
      const sessions = attemptRows.flatMap((row) => {
        const attempt = attemptFromRow(row);
        const task = taskById.get(attempt.taskId);
        if (!task) {
          return [];
        }
        const events = (eventQuery.all({ $attemptId: attempt.id, $limit: eventLimit }) as AttemptEventRow[])
          .map(attemptEventFromRow)
          .reverse();
        return [
          {
            role: task.role,
            taskId: task.id,
            taskGoal: task.goal,
            attemptId: attempt.id,
            status: attempt.status,
            output: attempt.output,
            model: objectOrNull(attempt.input.model),
            sessionName: stringOrNull(attempt.input.sessionName),
            codexSessionId: stringOrNull(attempt.input.codexSessionId),
            worktreePath: task.worktreePath,
            startedAt: row.started_at,
            latestText: latestEventText(events),
            events,
          },
        ];
      });
      const lessonRows = db
        .query(
          `
          select *
          from lessons
          where run_id = $runId
          order by created_at, rowid
          `,
        )
        .all({ $runId: input.runId }) as LessonRow[];
      ensureExecutionThreads(db);
      const threadRows = db
        .query(
          `
          select *
          from execution_threads
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as ExecutionThreadRow[];
      return {
        run: runRow ? runFromRow(runRow) : null,
        project: projectRow ? projectFromRow(projectRow) : null,
        tasks,
        sessions,
        threads: threadRows.map(executionThreadFromRow),
        lessons: lessonRows.map(lessonFromRow),
      };
    });
  }

  retryTask(input: RetryTaskInput) {
    return withDatabase(this.dbPath, (db) => {
      const task = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as TaskRow | null;
      db.query(
        `
        update tasks
        set status = 'todo', updated_at = current_timestamp
        where id = $taskId
        `,
      ).run({ $taskId: input.taskId });
      if (task) {
        const runRow = db.query("select * from runs where id = $runId").get({ $runId: task.run_id }) as RunRow | null;
        if (runRow) {
          const run = runFromRow(runRow);
          db.query(
            `
            update runs
            set context_json = $contextJson,
                updated_at = current_timestamp
            where id = $runId
            `,
          ).run({
            $runId: task.run_id,
            $contextJson: toJson({
              ...run.context,
              runPause: null,
              runPauseClearedAt: new Date().toISOString(),
            }),
          });
        }
      }
    });
  }

  createExternalRef(input: CreateExternalRefInput) {
    const id = input.id ?? makeId("ref");
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into external_refs (
          id, local_type, local_id, provider, external_type, external_id, external_url
        )
        values (
          $id, $localType, $localId, $provider, $externalType, $externalId, $externalUrl
        )
        `,
      ).run({
        $id: id,
        $localType: input.localType,
        $localId: input.localId,
        $provider: input.provider,
        $externalType: input.externalType,
        $externalId: input.externalId,
        $externalUrl: input.externalUrl ?? null,
      });
      return id;
    });
  }

  listExternalRefs(input: ListExternalRefsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from external_refs
          where local_type = $localType and local_id = $localId
          order by created_at, id
          `,
        )
        .all({
          $localType: input.localType,
          $localId: input.localId,
        }) as ExternalRefRow[];
      return rows.map(externalRefFromRow);
    });
  }

  listLessons(input: ListLessonsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from lessons
          where run_id = $runId
          order by created_at, rowid
          limit $limit
          `,
        )
        .all({ $runId: input.runId, $limit: input.limit ?? 50 }) as LessonRow[];
      return rows.map(lessonFromRow);
    });
  }

  getPromptTemplate(key: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from prompt_templates where key = $key").get({ $key: key }) as
        | PromptTemplateRow
        | null;
      return row ? promptTemplateFromRow(row) : null;
    });
  }

  setPromptTemplate(input: SetPromptTemplateInput) {
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into prompt_templates (key, content_md)
        values ($key, $contentMd)
        on conflict(key) do update set
          content_md = excluded.content_md,
          updated_at = current_timestamp
        `,
      ).run({ $key: input.key, $contentMd: input.contentMd });
      const row = db.query("select * from prompt_templates where key = $key").get({ $key: input.key }) as
        | PromptTemplateRow
        | null;
      return promptTemplateFromRow(row!);
    });
  }

  private seedPromptTemplates() {
    return withDatabase(this.dbPath, (db) => {
      const insertQuery = db.query(`
        insert or ignore into prompt_templates (key, content_md)
        values ($key, $contentMd)
      `);
      for (const template of [
        { key: "task", contentMd: DEFAULT_TASK_PROMPT_TEMPLATE },
        { key: "verifier-task", contentMd: DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE },
        { key: "repair-task", contentMd: DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE },
        { key: "context-summary", contentMd: DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE },
      ]) {
        insertQuery.run({
          $key: template.key,
          $contentMd: template.contentMd,
        });
      }

      const taskTemplate = db.query("select content_md from prompt_templates where key = 'task'").get() as
        | { content_md: string }
        | null;
      if (taskTemplate && LEGACY_DEFAULT_TASK_PROMPT_TEMPLATES.includes(taskTemplate.content_md)) {
        db.query(
          `
          update prompt_templates
          set content_md = $contentMd,
              updated_at = current_timestamp
          where key = 'task'
          `,
        ).run({ $contentMd: DEFAULT_TASK_PROMPT_TEMPLATE });
      }
    });
  }
}

function resolveRunProjectId(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  input: CreateRunInput,
) {
  if (input.projectId) {
    const row = db.query("select id from projects where id = $projectId").get({ $projectId: input.projectId }) as
      | { id: string }
      | null;
    if (!row) {
      throw new Error(`project not found: ${input.projectId}`);
    }
    return input.projectId;
  }
  if (!input.projectRoot) {
    return null;
  }
  const rootPath = resolve(input.projectRoot);
  const existing = db.query("select id from projects where root_path = $rootPath").get({ $rootPath: rootPath }) as
    | { id: string }
    | null;
  if (existing) {
    return existing.id;
  }
  const id = makeId("project");
  db.query(
    `
    insert into projects (id, name, root_path, context_json)
    values ($id, $name, $rootPath, '{}')
    `,
  ).run({
    $id: id,
    $name: basename(rootPath) || rootPath,
    $rootPath: rootPath,
  });
  return id;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function objectOrNull(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function createDependencyReadiness(tasks: Task[]) {
  const statuses = new Map(tasks.map((task) => [task.id, task.status]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const repairTasksByParent = new Map<string, Task[]>();
  const verifiedRepairIds = new Set<string>();

  for (const task of tasks) {
    if (task.role === "worker" && task.status === "done" && task.parentId) {
      const repairTasks = repairTasksByParent.get(task.parentId) ?? [];
      repairTasks.push(task);
      repairTasksByParent.set(task.parentId, repairTasks);
    }

    if (task.role === "verifier" && task.status === "done") {
      for (const dependencyId of task.dependsOn) {
        verifiedRepairIds.add(dependencyId);
      }
    }
  }

  return (taskId: string, dependentTask?: Task) => {
    const status = statuses.get(taskId);
    if (status === "done") {
      return true;
    }
    if (status !== "blocked") {
      return false;
    }

    const dependency = tasksById.get(taskId);
    if (
      dependentTask?.role === "worker" &&
      dependency?.role === "verifier" &&
      dependentTask.goal.toLowerCase().startsWith("repair")
    ) {
      return true;
    }

    return (repairTasksByParent.get(taskId) ?? []).some((repairTask) => verifiedRepairIds.has(repairTask.id));
  };
}

function ensureExecutionThreads(db: { exec: (sql: string) => void }) {
  db.exec(`
    create table if not exists execution_threads (
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
      agent_session_id text,
      worktree_path text,
      heartbeat_at text not null default current_timestamp,
      interrupted_at text,
      interrupt_reason text,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create index if not exists idx_execution_threads_run_status on execution_threads(run_id, status);
    create index if not exists idx_execution_threads_attempt on execution_threads(attempt_id);
  `);
  try {
    db.exec("alter table execution_threads add column agent_session_id text");
  } catch {
    // The column already exists on databases created after the thread registry landed.
  }
  try {
    db.exec("update execution_threads set agent_session_id = codex_session_id where agent_session_id is null");
  } catch {
    // Older and newer schemas only have one of these columns.
  }
}

function ensureHarnessActionEvents(db: { exec: (sql: string) => void }) {
  db.exec(`
    create table if not exists harness_action_events (
      id text primary key,
      action_type text not null,
      status text not null check (status in ('done', 'blocked')),
      request_json text not null,
      result_json text not null,
      created_at text not null default current_timestamp
    );
    create index if not exists idx_harness_action_events_created on harness_action_events(created_at, id);
  `);
}

function resolveTaskCycleId(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  input: { id: string; role: string; parentId: string | null; dependsOn: string[]; cycleId: string | null },
) {
  if (input.cycleId) {
    return input.cycleId;
  }
  if (input.role === "planner" || input.role === "goal-review") {
    return input.id;
  }
  const linkedIds = [input.parentId, ...input.dependsOn].filter((id): id is string => typeof id === "string");
  const query = db.query("select cycle_id from tasks where id = $id");
  for (const id of linkedIds) {
    const row = query.get({ $id: id }) as { cycle_id: string | null } | null;
    if (row?.cycle_id) {
      return row.cycle_id;
    }
  }
  return input.id;
}

function latestEventText(events: Array<{ text: string | null; payload: Record<string, unknown> }>) {
  for (const event of [...events].reverse()) {
    for (const key of ["delta", "message", "text", "content"]) {
      const value = event.payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  for (const event of [...events].reverse()) {
    if (event.text && event.text.trim().length > 0) {
      return event.text.trim();
    }
  }
  return "";
}

function normalizeAttemptOutput(output: RecordAttemptInput["output"]) {
  return {
    ...output,
    summary: readableValue(output.summary),
    problems: readableList(output.problems),
  };
}

function lessonForAttempt(output: RecordAttemptInput["output"]) {
  if (output.status === "done") {
    return {
      kind: "experience" as const,
      summary: readableValue(output.summary) || "Task completed successfully",
      evidence: {
        changedFiles: output.changedFiles ?? [],
        checks: output.checks ?? [],
        artifacts: output.artifacts ?? [],
      },
    };
  }

  return {
    kind: "lesson" as const,
    summary: readableList(output.problems)[0] || readableValue(output.summary) || "Task was blocked",
    evidence: {
      summary: output.summary,
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    },
  };
}

function isSqliteBusyError(error: unknown) {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY";
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
