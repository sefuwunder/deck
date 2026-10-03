/* db.ts — SQLite registry of Bun apps + runtime PIDs. Zero deps (bun:sqlite). */
import { Database } from "bun:sqlite";

export interface App {
  id: number;
  name: string;
  dir: string;
  port: number;
  start_cmd: string;
  sort: number;
  created_at: number;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dir TEXT NOT NULL,
      port INTEGER NOT NULL,
      start_cmd TEXT NOT NULL DEFAULT 'bun src/server.ts',
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime (
      app_id INTEGER PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function listApps(db: Database): App[] {
  return db.query(`SELECT * FROM apps ORDER BY sort, name`).all() as App[];
}

export function getApp(db: Database, id: number): App | null {
  return db.query(`SELECT * FROM apps WHERE id = ?`).get(id) as App | null;
}

export function addApp(db: Database, a: { name: string; dir: string; port: number; start_cmd?: string }): App {
  const maxSort = (db.query(`SELECT COALESCE(MAX(sort), -1) AS m FROM apps`).get() as { m: number }).m;
  const r = db
    .query(`INSERT INTO apps (name, dir, port, start_cmd, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(a.name.trim(), a.dir, a.port, (a.start_cmd || "bun src/server.ts").trim() || "bun src/server.ts", maxSort + 1, Date.now());
  return getApp(db, Number(r.lastInsertRowid))!;
}

export function updateApp(db: Database, id: number, patch: Partial<Pick<App, "name" | "dir" | "port" | "start_cmd" | "sort">>): App | null {
  const cur = getApp(db, id);
  if (!cur) return null;
  const next = {
    name: patch.name !== undefined ? patch.name.trim() : cur.name,
    dir: patch.dir !== undefined ? patch.dir : cur.dir,
    port: patch.port !== undefined ? patch.port : cur.port,
    start_cmd: patch.start_cmd !== undefined ? patch.start_cmd.trim() || "bun src/server.ts" : cur.start_cmd,
    sort: patch.sort !== undefined ? patch.sort : cur.sort,
  };
  if (!next.name) return cur;
  db.query(`UPDATE apps SET name = ?, dir = ?, port = ?, start_cmd = ?, sort = ? WHERE id = ?`)
    .run(next.name, next.dir, next.port, next.start_cmd, next.sort, id);
  return getApp(db, id);
}

export function deleteApp(db: Database, id: number): void {
  db.query(`DELETE FROM runtime WHERE app_id = ?`).run(id);
  db.query(`DELETE FROM apps WHERE id = ?`).run(id);
}

export function setRuntime(db: Database, appId: number, pid: number, startedAt: number): void {
  db.query(`INSERT INTO runtime (app_id, pid, started_at) VALUES (?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at`).run(appId, pid, startedAt);
}

export function clearRuntime(db: Database, appId: number): void {
  db.query(`DELETE FROM runtime WHERE app_id = ?`).run(appId);
}

export function getRuntime(db: Database, appId: number): { pid: number; started_at: number } | null {
  return (db.query(`SELECT pid, started_at FROM runtime WHERE app_id = ?`).get(appId) as { pid: number; started_at: number } | null) || null;
}

export function getKv(db: Database, k: string): string | null {
  const r = db.query(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | null;
  return r ? r.v : null;
}

export function setKv(db: Database, k: string, v: string): void {
  db.query(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
}
