import { initDatabase, withDatabase } from "./database";
import {
  DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE,
  DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE,
  DEFAULT_TASK_PROMPT_TEMPLATE,
  DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE,
} from "./default-prompts";
import { makeId } from "./ids";
import { toJson } from "./json";
import {
  attemptEventFromRow,
  attemptFromRow,
  executionThreadFromRow,
  externalRefFromRow,
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
  GetRunOverviewInput,
  LeaseReadyTasksInput,
  ListExecutionThreadsInput,
  ListRunningAttemptsInput,
  ListExternalRefsInput,
  ListLessonsInput,
  RecordAttemptEventInput,
  RecordAttemptInput,
  RetryTaskInput,
  StartAttemptInput,
  Status,
  UpdateRunStatusInput,
  UpdateAttemptInputInput,
  UpdateExecutionThreadInput,
  UpsertExecutionThreadInput,
} from "./types";
import { basename, resolve } from "node:path";

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
          depends_on_json, done_when_json, config_json
        )
        values (
          $id, $runId, $parentId, $cycleId, 'todo', $role, $goal, $prompt,
          $dependsOnJson, $doneWhenJson, $configJson
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
      const statusRows = db
        .query("select id, status from tasks where run_id = $runId")
        .all({ $runId: runId }) as Array<{ id: string; status: Status }>;
      const statuses = new Map(statusRows.map((row) => [row.id, row.status]));

      for (const row of taskRows) {
        const task = taskFromRow(row);
        if (task.dependsOn.every((id) => statuses.get(id) === "done")) {
          return task;
        }
      }
      return null;
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
      const statusRows = db
        .query("select id, status from tasks where run_id = $runId")
        .all({ $runId: input.runId }) as Array<{ id: string; status: Status }>;
      const statuses = new Map(statusRows.map((row) => [row.id, row.status]));
      const ready = taskRows
        .map(taskFromRow)
        .filter((task) => task.dependsOn.every((id) => statuses.get(id) === "done"))
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
    if (input.output.status !== "done" && input.output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const id = input.id ?? makeId("attempt");
    const problems = input.output.problems ?? [];
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
          $status: input.output.status,
          $inputJson: toJson(input.input),
          $outputJson: toJson(input.output),
          $checksJson: toJson(input.output.checks ?? []),
          $artifactsJson: toJson(input.output.artifacts ?? []),
          $error: problems.length > 0 ? problems.join("\n") : null,
        });
        db.query(
          `
          update tasks
          set status = $status, updated_at = current_timestamp
          where id = $taskId
          `,
        ).run({
          $status: input.output.status,
          $taskId: input.taskId,
        });
        const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as
          | TaskRow
          | null;
        if (taskRow) {
          const lesson = lessonForAttempt(input.output);
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
    if (input.output.status !== "done" && input.output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const problems = input.output.problems ?? [];
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
          $status: input.output.status,
          $outputJson: toJson(input.output),
          $checksJson: toJson(input.output.checks ?? []),
          $artifactsJson: toJson(input.output.artifacts ?? []),
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
          $status: input.output.status,
          $taskId: attemptRow.task_id,
        });
        const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: attemptRow.task_id }) as
          | TaskRow
          | null;
        if (taskRow) {
          const lesson = lessonForAttempt(input.output);
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
      db.query(
        `
        update tasks
        set status = 'todo', updated_at = current_timestamp
        where id = $taskId
        `,
      ).run({ $taskId: input.taskId });
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
      const query = db.query(`
        insert or ignore into prompt_templates (key, content_md)
        values ($key, $contentMd)
      `);
      for (const template of [
        { key: "task", contentMd: DEFAULT_TASK_PROMPT_TEMPLATE },
        { key: "verifier-task", contentMd: DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE },
        { key: "repair-task", contentMd: DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE },
        { key: "context-summary", contentMd: DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE },
      ]) {
        query.run({
          $key: template.key,
          $contentMd: template.contentMd,
        });
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

function lessonForAttempt(output: RecordAttemptInput["output"]) {
  if (output.status === "done") {
    return {
      kind: "experience" as const,
      summary: output.summary || "Task completed successfully",
      evidence: {
        changedFiles: output.changedFiles ?? [],
        checks: output.checks ?? [],
        artifacts: output.artifacts ?? [],
      },
    };
  }

  return {
    kind: "lesson" as const,
    summary: output.problems?.[0] ?? output.summary ?? "Task was blocked",
    evidence: {
      summary: output.summary,
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    },
  };
}
