import { parseJson } from "./json";
import type {
  Attempt,
  AttemptEvent,
  AttemptOutput,
  ExecutionThread,
  ExternalRef,
  HarnessActionEvent,
  Lesson,
  Project,
  PromptTemplate,
  Run,
  Task,
  TaskConfig,
} from "./types";
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

export function runFromRow(row: RunRow): Run {
  const context = parseJson<Record<string, unknown>>(row.context_json);
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    projectRoot: row.project_root ?? stringOrNull(context.projectRoot) ?? null,
    goal: row.goal,
    status: row.status,
    context,
    createdAt: row.created_at ?? null,
  };
}

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    context: parseJson<Record<string, unknown>>(row.context_json),
  };
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    cycleId: row.cycle_id ?? row.id,
    status: row.status,
    role: row.role,
    goal: row.goal,
    prompt: row.prompt,
    dependsOn: parseJson<string[]>(row.depends_on_json),
    doneWhen: parseJson<string[]>(row.done_when_json),
    config: parseJson<TaskConfig>(row.config_json),
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

export function attemptEventFromRow(row: AttemptEventRow): AttemptEvent {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    sequence: row.sequence,
    stream: row.stream,
    text: row.text,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: row.created_at,
  };
}

export function executionThreadFromRow(row: ExecutionThreadRow): ExecutionThread {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    parentThreadId: row.parent_thread_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    role: row.role,
    status: row.status,
    pid: row.pid,
    sessionName: row.session_name,
    agentSessionId: row.agent_session_id,
    worktreePath: row.worktree_path,
    heartbeatAt: row.heartbeat_at,
    interruptedAt: row.interrupted_at,
    interruptReason: row.interrupt_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export function harnessActionEventFromRow(row: HarnessActionEventRow): HarnessActionEvent {
  return {
    id: row.id,
    actionType: row.action_type,
    status: row.status,
    request: parseJson<Record<string, unknown>>(row.request_json),
    result: parseJson<Record<string, unknown>>(row.result_json),
    createdAt: row.created_at,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
