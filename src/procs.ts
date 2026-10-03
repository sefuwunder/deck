/* procs.ts — start/stop/track Bun app processes with log capture. */
import { Database } from "bun:sqlite";
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearRuntime, getRuntime, setRuntime, type App } from "./db";
import { parseEnv } from "./envfile";
import { splitCmd } from "./scan";

export interface ProcInfo {
  appId: number;
  pid: number;
  startedAt: number;
  adopted: boolean; // true when we only know the PID (panel restarted)
  proc: Bun.Subprocess | null;
}

const live = new Map<number, ProcInfo>();
const rings = new Map<number, string[]>(); // appId -> last ~400 log lines
const LOG_DIR = join(process.env.DECK_DATA_DIR || join(import.meta.dir, "..", "data"), "logs");
const RING_MAX = 400;
const LOG_MAX_BYTES = 512 * 1024;

function logPath(appId: number): string {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${appId}.log`);
}

function pushLine(appId: number, line: string): void {
  let ring = rings.get(appId);
  if (!ring) {
    ring = [];
    rings.set(appId, ring);
  }
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    const p = logPath(appId);
    if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) {
      // rotate: keep the tail
      const tail = ring.slice(-200).join("\n") + "\n";
      renameSync(p, p + ".old");
      Bun.write(p, tail).catch(() => {});
    }
    const ws = createWriteStream(p, { flags: "a" });
    ws.write(line + "\n");
    ws.end();
  } catch {
    /* logging must never break the app */
  }
}

export function tailLog(appId: number, lines = 200): string[] {
  const ring = rings.get(appId) || [];
  return ring.slice(-lines);
}

function readDotEnvSync(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const name of [".env", ".env.local"]) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      for (const v of parseEnv(readFileSync(p, "utf8"))) out[v.key] = v.value;
    }
  } catch {}
  return out;
}

async function pump(appId: number, stream: ReadableStream<Uint8Array> | null, tag: string): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        pushLine(appId, tag === "err" ? `[stderr] ${line}` : line);
      }
    }
    if (buf) pushLine(appId, tag === "err" ? `[stderr] ${buf}` : buf);
  } catch {
    /* stream closed */
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getProc(appId: number): ProcInfo | null {
  const p = live.get(appId);
  if (p && isPidAlive(p.pid)) return p;
  if (p) live.delete(appId);
  return null;
}

export async function startApp(db: Database, app: App): Promise<{ pid: number; startedAt: number }> {
  const existing = getProc(app.id);
  if (existing) return { pid: existing.pid, startedAt: existing.startedAt };
  // stale DB row?
  const rt = getRuntime(db, app.id);
  if (rt && isPidAlive(rt.pid)) {
    const info: ProcInfo = { appId: app.id, pid: rt.pid, startedAt: rt.started_at, adopted: true, proc: null };
    live.set(app.id, info);
    pushLine(app.id, `[deck] adopted live PID ${rt.pid}`);
    return { pid: rt.pid, startedAt: rt.started_at };
  }
  if (rt) clearRuntime(db, app.id);

  const argv = splitCmd(app.start_cmd);
  if (!argv.length) throw new Error("empty start command");
  const dotenv = readDotEnvSync(app.dir);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...dotenv, PORT: String(app.port) };

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, {
      cwd: app.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: any) {
    throw new Error(`spawn failed: ${e.message || e}`);
  }
  const startedAt = Date.now();
  const info: ProcInfo = { appId: app.id, pid: proc.pid, startedAt, adopted: false, proc };
  live.set(app.id, info);
  setRuntime(db, app.id, proc.pid, startedAt);
  pushLine(app.id, `[deck] started PID ${proc.pid}: ${app.start_cmd} (PORT=${app.port})`);
  pump(app.id, proc.stdout as ReadableStream<Uint8Array>, "out");
  pump(app.id, proc.stderr as ReadableStream<Uint8Array>, "err");
  proc.exited.then((code) => {
    const cur = live.get(app.id);
    if (cur && cur.pid === proc.pid) live.delete(app.id);
    clearRuntime(db, app.id);
    pushLine(app.id, `[deck] exited with code ${code}`);
  });
  // give it a beat; if it died instantly, surface the log tail
  await Bun.sleep(400);
  if (proc.exitCode !== null) {
    const tail = tailLog(app.id, 12).join("\n");
    throw new Error(`process exited immediately (code ${proc.exitCode})${tail ? ":\n" + tail : ""}`);
  }
  return { pid: proc.pid, startedAt };
}

export async function stopApp(db: Database, appId: number): Promise<boolean> {
  const info = getProc(appId);
  const rt = info ? null : getRuntime(db, appId);
  const pid = info ? info.pid : rt ? rt.pid : null;
  if (!pid || !isPidAlive(pid)) {
    live.delete(appId);
    clearRuntime(db, appId);
    return false;
  }
  pushLine(appId, `[deck] stopping PID ${pid}`);
  try {
    if (info && info.proc && !info.adopted) info.proc.kill("SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(300);
    if (!isPidAlive(pid)) break;
  }
  if (isPidAlive(pid)) {
    try {
      if (info && info.proc && !info.adopted) info.proc.kill("SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {}
    await Bun.sleep(400);
  }
  live.delete(appId);
  clearRuntime(db, appId);
  pushLine(appId, isPidAlive(pid) ? `[deck] PID ${pid} would not die` : `[deck] stopped PID ${pid}`);
  return !isPidAlive(pid);
}

/** On boot: adopt PIDs that are still alive, forget the dead. */
export function reconcileRuntime(db: Database, apps: App[]): void {
  const ids = new Set(apps.map((a) => a.id));
  for (const app of apps) {
    const rt = getRuntime(db, app.id);
    if (!rt) continue;
    if (isPidAlive(rt.pid)) {
      live.set(app.id, { appId: app.id, pid: rt.pid, startedAt: rt.started_at, adopted: true, proc: null });
      pushLine(app.id, `[deck] adopted live PID ${rt.pid} from previous session`);
    } else {
      clearRuntime(db, app.id);
    }
  }
  // drop runtime rows for deleted apps
  try {
    db.query(`DELETE FROM runtime WHERE app_id NOT IN (SELECT id FROM apps)`).run();
  } catch {}
  void ids;
}
