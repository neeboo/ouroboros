pragma foreign_keys = on;

create table if not exists projects (
  id text primary key,
  name text not null,
  root_path text not null unique,
  context_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists runs (
  id text primary key,
  project_id text references projects(id) on delete set null,
  goal text not null,
  status text not null check (status in ('todo', 'running', 'done', 'blocked')),
  context_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists tasks (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  parent_id text references tasks(id) on delete set null,
  cycle_id text,
  status text not null check (status in ('todo', 'running', 'done', 'blocked')),
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

create index if not exists idx_tasks_run_status on tasks(run_id, status);

create trigger if not exists reopen_done_run_after_active_task_insert
after insert on tasks
when new.status in ('todo', 'running')
begin
  update runs
  set status = 'todo', updated_at = current_timestamp
  where id = new.run_id and status = 'done';
end;

create trigger if not exists prevent_done_run_with_active_tasks
before update of status on runs
when new.status = 'done'
  and exists (
    select 1
    from tasks
    where run_id = new.id and status in ('todo', 'running')
  )
begin
  select raise(abort, 'cannot mark run done while active tasks exist');
end;

create table if not exists attempts (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  status text not null check (status in ('running', 'done', 'blocked')),
  input_json text not null,
  output_json text not null default '{}',
  checks_json text not null default '[]',
  artifacts_json text not null default '[]',
  error text,
  started_at text not null default current_timestamp,
  finished_at text
);

create index if not exists idx_attempts_task on attempts(task_id, started_at);

create table if not exists attempt_events (
  id text primary key,
  attempt_id text not null references attempts(id) on delete cascade,
  sequence integer not null,
  stream text not null check (stream in ('stdout', 'stderr', 'codex-json', 'system')),
  text text,
  payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  unique (attempt_id, sequence)
);

create index if not exists idx_attempt_events_attempt on attempt_events(attempt_id, sequence);

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

create table if not exists harness_action_events (
  id text primary key,
  action_type text not null,
  status text not null check (status in ('done', 'blocked')),
  request_json text not null,
  result_json text not null,
  created_at text not null default current_timestamp
);

create index if not exists idx_harness_action_events_created on harness_action_events(created_at, id);

create table if not exists lessons (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  task_id text not null references tasks(id) on delete cascade,
  attempt_id text not null references attempts(id) on delete cascade,
  kind text not null check (kind in ('experience', 'lesson')),
  summary text not null,
  evidence_json text not null default '{}',
  created_at text not null default current_timestamp
);

create index if not exists idx_lessons_run on lessons(run_id, created_at, id);

create table if not exists prompt_templates (
  key text primary key,
  content_md text not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists inbox_events (
  id text primary key,
  provider text not null,
  event_type text not null,
  external_id text not null,
  payload_json text not null,
  status text not null check (status in ('todo', 'running', 'done', 'blocked')),
  created_at text not null default current_timestamp,
  processed_at text
);

create index if not exists idx_inbox_events_status on inbox_events(status, created_at);

create table if not exists external_refs (
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

create index if not exists idx_external_refs_local on external_refs(local_type, local_id);
create index if not exists idx_external_refs_external on external_refs(provider, external_type, external_id);

create table if not exists founder_charters (
  id text primary key,
  project_id text references projects(id) on delete set null,
  version integer not null,
  is_active integer not null default 0,
  mission text not null,
  charter_json text not null default '{}',
  activated_at text,
  superseded_at text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (project_id, version)
);

create unique index if not exists idx_founder_charters_active_project
  on founder_charters(project_id) where is_active = 1;
create index if not exists idx_founder_charters_project
  on founder_charters(project_id, version);

create table if not exists strategy_signals (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  signal_class text not null check (signal_class in ('user','delivery','technology','market','economics','system')),
  source text not null,
  title text not null,
  summary text not null,
  observation_time text not null,
  confidence real not null,
  evidence_json text not null default '[]',
  expires_at text,
  status text not null default 'active' check (status in ('active','expired','superseded')),
  conflicting_signal_ids_json text not null default '[]',
  proposal_id text references design_proposals(id) on delete set null,
  run_id text references runs(id) on delete set null,
  task_id text references tasks(id) on delete set null,
  attempt_id text references attempts(id) on delete set null,
  payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists idx_strategy_signals_project_status
  on strategy_signals(project_id, status);
create index if not exists idx_strategy_signals_class_observed
  on strategy_signals(signal_class, observation_time);
create index if not exists idx_strategy_signals_expires
  on strategy_signals(expires_at);

create table if not exists design_proposals (
  id text primary key,
  project_id text references projects(id) on delete cascade,
  run_id text references runs(id) on delete set null,
  task_id text references tasks(id) on delete set null,
  attempt_id text references attempts(id) on delete set null,
  charter_id text references founder_charters(id) on delete set null,
  title text not null,
  problem text not null,
  recommendation text not null,
  status text not null default 'draft' check (
    status in (
      'draft','proposed','experimenting','accepted',
      'implemented','measuring','retained',
      'rejected','retired','revise'
    )
  ),
  proposal_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists idx_design_proposals_project_status
  on design_proposals(project_id, status);

create table if not exists design_decisions (
  id text primary key,
  proposal_id text not null references design_proposals(id) on delete cascade,
  charter_id text references founder_charters(id) on delete set null,
  decision text not null check (decision in ('approved','rejected','deferred','retired','revise')),
  actor_kind text not null check (actor_kind in ('auto','human','governance')),
  actor_ref text,
  reasons_json text not null default '[]',
  authority_json text not null default '{}',
  payload_json text not null default '{}',
  created_at text not null default current_timestamp
);

create index if not exists idx_design_decisions_proposal
  on design_decisions(proposal_id, created_at);

create table if not exists design_outcomes (
  id text primary key,
  proposal_id text not null references design_proposals(id) on delete cascade,
  run_id text references runs(id) on delete set null,
  task_id text references tasks(id) on delete set null,
  attempt_id text references attempts(id) on delete set null,
  stage text not null check (stage in ('experiment','release','review')),
  recommendation text not null check (recommendation in ('retain','revise','retire')),
  baseline_json text not null default '{}',
  observed_json text not null default '{}',
  evidence_json text not null default '[]',
  unexpected_effects_json text not null default '[]',
  review_at text,
  payload_json text not null default '{}',
  created_at text not null default current_timestamp
);

create index if not exists idx_design_outcomes_proposal
  on design_outcomes(proposal_id, created_at);
create index if not exists idx_design_outcomes_review
  on design_outcomes(review_at);
