import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function initDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  withDatabase(dbPath, (db) => {
    db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
    ensureTaskCycles(db);
  });
}

export function withDatabase<T>(dbPath: string, callback: (db: Database) => T) {
  const db = new Database(dbPath);
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
  try {
    return callback(db);
  } finally {
    db.close();
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

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
