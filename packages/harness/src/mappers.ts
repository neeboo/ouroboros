import { parseJson } from "./json";
import type { Attempt, AttemptOutput, ExternalRef, Lesson, PromptTemplate, Run, Task } from "./types";
import type { AttemptRow, ExternalRefRow, LessonRow, PromptTemplateRow, RunRow, TaskRow } from "./rows";

export function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    context: parseJson<Record<string, unknown>>(row.context_json),
  };
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    status: row.status,
    role: row.role,
    goal: row.goal,
    prompt: row.prompt,
    dependsOn: parseJson<string[]>(row.depends_on_json),
    doneWhen: parseJson<string[]>(row.done_when_json),
    worktreePath: row.worktree_path,
    sessionRef: row.session_ref,
    contextVersion: row.context_version,
  };
}

export function attemptFromRow(row: AttemptRow): Attempt {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    input: parseJson<Record<string, unknown>>(row.input_json),
    output: parseJson<AttemptOutput>(row.output_json),
    checks: parseJson<unknown[]>(row.checks_json),
    artifacts: parseJson<unknown[]>(row.artifacts_json),
    error: row.error,
  };
}

export function externalRefFromRow(row: ExternalRefRow): ExternalRef {
  return {
    id: row.id,
    localType: row.local_type,
    localId: row.local_id,
    provider: row.provider,
    externalType: row.external_type,
    externalId: row.external_id,
    externalUrl: row.external_url,
  };
}

export function lessonFromRow(row: LessonRow): Lesson {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    summary: row.summary,
    evidence: parseJson<Record<string, unknown>>(row.evidence_json),
  };
}

export function promptTemplateFromRow(row: PromptTemplateRow): PromptTemplate {
  return {
    key: row.key,
    contentMd: row.content_md,
  };
}
