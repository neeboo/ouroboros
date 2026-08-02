import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type HarnessDatabase = Database;

export function initDatabase(dbPath: string) {
  const resolvedPath = normalizeDatabasePath(dbPath);
  const allowMissingSchema = !databaseFileExists(resolvedPath);
  withDatabase(resolvedPath, (db) => {
    db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
    ensureProjects(db);
    ensureTaskConfig(db);
    ensureTaskCycles(db);
    ensureHarnessActionEvents(db);
    ensureRunLifecycleGuards(db);
    ensureStrategyTables(db);
  }, { allowMissingSchema });
}

export function withDatabase<T>(
  dbPath: string,
  callback: (db: Database) => T,
  options: { allowMissingSchema?: boolean } = {},
) {
  const resolvedPath = normalizeDatabasePath(dbPath);
  ensureDatabaseDirectory(resolvedPath);
  const db = new Database(resolvedPath);
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 30000");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  if (!options.allowMissingSchema) {
    ensureOuroborosSchema(db, resolvedPath);
  }
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

export function normalizeDatabasePath(dbPath: string) {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return dbPath;
  }
  return resolve(dbPath);
}

function ensureDatabaseDirectory(dbPath: string) {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

function databaseFileExists(dbPath: string) {
  return dbPath === ":memory:" || dbPath.startsWith("file:") || existsSync(dbPath);
}

function ensureOuroborosSchema(db: Database, dbPath: string) {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return;
  }
  const row = db
    .query("select name from sqlite_master where type = 'table' and name = 'runs'")
    .get() as { name: string } | null;
  if (!row) {
    throw new Error(
      `Ouroboros database is missing schema: ${dbPath}. The run database may be corrupted or this command is pointing at the wrong DB. Run init only for a new database, or restore/recreate the run DB.`,
    );
  }
}

function ensureTaskCycles(db: Database) {
  const columns = db.query("pragma table_info(tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "cycle_id")) {
    db.exec("alter table tasks add column cycle_id text");
  }
  db.exec("create index if not exists idx_tasks_run_cycle on tasks(run_id, cycle_id)");

  const rows = db
    .query(
      `
      select rowid, id, run_id, parent_id, role, depends_on_json, cycle_id
      from tasks
      order by run_id, rowid
      `,
    )
    .all() as Array<{
    rowid: number;
    id: string;
    run_id: string;
    parent_id: string | null;
    role: string;
    depends_on_json: string;
    cycle_id: string | null;
  }>;
  const cycleByTaskId = new Map<string, string>();
  let currentRunId: string | null = null;
  let currentCycleId: string | null = null;
  const update = db.query("update tasks set cycle_id = $cycleId where rowid = $rowid and cycle_id is null");

  db.transaction(() => {
    for (const row of rows) {
      if (row.run_id !== currentRunId) {
        currentRunId = row.run_id;
        currentCycleId = null;
      }
      const linkedCycleId = [row.parent_id, ...parseStringArray(row.depends_on_json)]
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => cycleByTaskId.get(id))
        .find((id): id is string => typeof id === "string");
      const startsCycle = row.role === "planner" || row.role === "goal-review" || !currentCycleId;
      const cycleId = row.cycle_id ?? (linkedCycleId && !startsCycle ? linkedCycleId : startsCycle ? row.id : currentCycleId ?? row.id);
      cycleByTaskId.set(row.id, cycleId);
      currentCycleId = cycleId;
      if (!row.cycle_id) {
        update.run({ $cycleId: cycleId, $rowid: row.rowid });
      }
    }
  })();
}

function ensureProjects(db: Database) {
  db.exec(`
    create table if not exists projects (
      id text primary key,
      name text not null,
      root_path text not null unique,
      context_json text not null default '{}',
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    )
  `);
  const columns = db.query("pragma table_info(runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "project_id")) {
    db.exec("alter table runs add column project_id text references projects(id) on delete set null");
  }
  db.exec("create index if not exists idx_runs_project on runs(project_id)");
}

function ensureTaskConfig(db: Database) {
  const columns = db.query("pragma table_info(tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "config_json")) {
    db.exec("alter table tasks add column config_json text not null default '{}'");
  }
}

function ensureHarnessActionEvents(db: Database) {
  db.exec(`
    create table if not exists harness_action_events (
      id text primary key,
      action_type text not null,
      status text not null check (status in ('done', 'blocked')),
      request_json text not null,
      result_json text not null,
      created_at text not null default current_timestamp
    )
  `);
  db.exec("create index if not exists idx_harness_action_events_created on harness_action_events(created_at, id)");
}

function ensureStrategyTables(db: Database) {
  db.exec(`
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
  `);
}

function ensureRunLifecycleGuards(db: Database) {
  db.exec(`
    update runs
    set status = 'todo', updated_at = current_timestamp
    where status = 'done'
      and exists (
        select 1
        from tasks
        where tasks.run_id = runs.id and tasks.status in ('todo', 'running')
      )
  `);
  db.exec(`
    create trigger if not exists reopen_done_run_after_active_task_insert
    after insert on tasks
    when new.status in ('todo', 'running')
    begin
      update runs
      set status = 'todo', updated_at = current_timestamp
      where id = new.run_id and status = 'done';
    end;
  `);
  db.exec(`
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
  `);
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
