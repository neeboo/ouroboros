import type { Status } from "./types";

export interface RunRow {
  id: string;
  goal: string;
  status: Status;
  context_json: string;
}

export interface TaskRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  status: Status;
  role: string;
  goal: string;
  prompt: string;
  depends_on_json: string;
  done_when_json: string;
  worktree_path: string | null;
  session_ref: string | null;
  context_version: number;
}

export interface AttemptRow {
  id: string;
  task_id: string;
  status: Exclude<Status, "todo">;
  input_json: string;
  output_json: string;
  checks_json: string;
  artifacts_json: string;
  error: string | null;
}

export interface AttemptEventRow {
  id: string;
  attempt_id: string;
  sequence: number;
  stream: "stdout" | "stderr" | "codex-json" | "system";
  text: string | null;
  payload_json: string;
  created_at: string;
}

export interface ExternalRefRow {
  id: string;
  local_type: string;
  local_id: string;
  provider: string;
  external_type: string;
  external_id: string;
  external_url: string | null;
}

export interface LessonRow {
  id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  kind: "experience" | "lesson";
  summary: string;
  evidence_json: string;
}

export interface PromptTemplateRow {
  key: string;
  content_md: string;
}
