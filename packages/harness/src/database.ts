import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function initDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  withDatabase(dbPath, (db) => {
    db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
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
