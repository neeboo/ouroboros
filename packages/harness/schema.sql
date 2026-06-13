pragma foreign_keys = on;

create table if not exists runs (
  id text primary key,
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
  status text not null check (status in ('todo', 'running', 'done', 'blocked')),
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

create index if not exists idx_tasks_run_status on tasks(run_id, status);

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
