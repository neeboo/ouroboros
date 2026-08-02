import type {
  DesignDecisionActorKind,
  DesignDecisionKind,
  DesignOutcomeRecommendation,
  DesignOutcomeStage,
  DesignProposalStatus,
  ExecutionThreadStatus,
  Status,
  StrategySignalClass,
  StrategySignalStatus,
} from "./types";

export interface RunRow {
  id: string;
  project_id: string | null;
  project_root?: string | null;
  goal: string;
  status: Status;
  context_json: string;
  created_at?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  context_json: string;
}

export interface TaskRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  cycle_id: string | null;
  status: Status;
  role: string;
  goal: string;
  prompt: string;
  depends_on_json: string;
  done_when_json: string;
  config_json: string;
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

export interface ExecutionThreadRow {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  parent_thread_id: string | null;
  owner_type: string;
  owner_id: string | null;
  role: string;
  status: ExecutionThreadStatus;
  pid: number | null;
  session_name: string | null;
  agent_session_id: string | null;
  worktree_path: string | null;
  heartbeat_at: string;
  interrupted_at: string | null;
  interrupt_reason: string | null;
  created_at: string;
  updated_at: string;
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

export interface InboxEventRow {
  id: string;
  provider: string;
  event_type: string;
  external_id: string;
  payload_json: string;
  status: string;
  created_at: string | null;
  processed_at: string | null;
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

export interface HarnessActionEventRow {
  id: string;
  action_type: string;
  status: "done" | "blocked";
  request_json: string;
  result_json: string;
  created_at: string;
}

export interface FounderCharterRow {
  id: string;
  project_id: string | null;
  version: number;
  is_active: number;
  mission: string;
  charter_json: string;
  activated_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StrategySignalRow {
  id: string;
  project_id: string | null;
  signal_class: StrategySignalClass;
  source: string;
  title: string;
  summary: string;
  observation_time: string;
  confidence: number;
  evidence_json: string;
  expires_at: string | null;
  status: StrategySignalStatus;
  conflicting_signal_ids_json: string;
  proposal_id: string | null;
  run_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface DesignProposalRow {
  id: string;
  project_id: string | null;
  run_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  charter_id: string | null;
  title: string;
  problem: string;
  recommendation: string;
  status: DesignProposalStatus;
  proposal_json: string;
  created_at: string;
  updated_at: string;
}

export interface DesignDecisionRow {
  id: string;
  proposal_id: string;
  charter_id: string | null;
  decision: DesignDecisionKind;
  actor_kind: DesignDecisionActorKind;
  actor_ref: string | null;
  reasons_json: string;
  authority_json: string;
  payload_json: string;
  created_at: string;
}

export interface DesignOutcomeRow {
  id: string;
  proposal_id: string;
  run_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  stage: DesignOutcomeStage;
  recommendation: DesignOutcomeRecommendation;
  baseline_json: string;
  observed_json: string;
  evidence_json: string;
  unexpected_effects_json: string;
  review_at: string | null;
  payload_json: string;
  created_at: string;
}
