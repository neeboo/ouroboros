import { initDatabase, withDatabase } from "./database";
import {
  DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE,
  DEFAULT_TASK_PROMPT_TEMPLATE,
  DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE,
} from "./default-prompts";
import { makeId } from "./ids";
import { toJson } from "./json";
import {
  attemptFromRow,
  externalRefFromRow,
  lessonFromRow,
  promptTemplateFromRow,
  runFromRow,
  taskFromRow,
} from "./mappers";
import type { AttemptRow, ExternalRefRow, LessonRow, PromptTemplateRow, RunRow, TaskRow } from "./rows";
import type {
  CreateExternalRefInput,
  SetPromptTemplateInput,
  CreateRunInput,
  CreateTaskInput,
  LeaseReadyTasksInput,
  ListExternalRefsInput,
  ListLessonsInput,
  RecordAttemptInput,
  RetryTaskInput,
  Status,
} from "./types";

export class Harness {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  init() {
    initDatabase(this.dbPath);
    this.seedPromptTemplates();
  }

  createRun(input: CreateRunInput) {
    const id = input.id ?? makeId("run");
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into runs (id, goal, status, context_json)
        values ($id, $goal, 'todo', $contextJson)
        `,
      ).run({
        $id: id,
        $goal: input.goal,
        $contextJson: toJson(input.context ?? {}),
      });
      return id;
    });
  }

  createTask(input: CreateTaskInput) {
    const id = input.id ?? makeId("task");
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into tasks (
          id, run_id, parent_id, status, role, goal, prompt,
          depends_on_json, done_when_json
        )
        values (
          $id, $runId, $parentId, 'todo', $role, $goal, $prompt,
          $dependsOnJson, $doneWhenJson
        )
        `,
      ).run({
        $id: id,
        $runId: input.runId,
        $parentId: input.parentId ?? null,
        $role: input.role,
        $goal: input.goal,
        $prompt: input.prompt,
        $dependsOnJson: toJson(input.dependsOn ?? []),
        $doneWhenJson: toJson(input.doneWhen ?? []),
      });
      return id;
    });
  }

  getRun(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from runs where id = $id").get({ $id: id }) as RunRow | null;
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
      ]) {
        query.run({
          $key: template.key,
          $contentMd: template.contentMd,
        });
      }
    });
  }
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
