/* deck — mission control for the Bun app fleet. Zero deps. */
import { Database } from "bun:sqlite";
import { existsSync, statSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  openDb, listApps, getApp, addApp, updateApp, deleteApp,
  getKv, setKv, type App,
} from "./db";
import { getProc, startApp, stopApp, tailLog, reconcileRuntime, isPidAlive } from "./procs";
import { parseEnv, serializeEnv, isSecretKey } from "./envfile";
import { scanPorts } from "./scan";
import { newSecret, otpauthUri, verifyTotp } from "./totp";
import { encodeQr, qrToSvg } from "./qr";
import {
  COOKIE_NAME, totpConfigured, createSession, validSession, destroySession,
  destroyAllSessions, sessionCookie, clearSessionCookie, cookieToken,
  rateLimited, noteFail, noteSuccess, checkTotp,
} from "./auth";

const PORT = Number(process.env.PORT || 3020);
const DATA_DIR = process.env.DECK_DATA_DIR || join(import.meta.dir, "..", "data");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const DB_PATH = join(DATA_DIR, "deck.db");

const db: Database = (() => {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  return openDb(DB_PATH);
})();

/* ---------------- seed: the known fleet ---------------- */
const SEED: Array<[string, string, number]> = [
  ["daily-briefing", "daily-briefing", 3000],
  ["exec-crm", "exec-crm", 3001],
  ["switchboard", "switchboard", 3002],
  ["exec-dashboard", "exec-dashboard", 3003],
  ["ascent", "ascent", 3004],
  ["meridian", "meridian", 3005],
  ["relay", "relay", 3006],
  ["sp1200", "sp1200", 3007],
  ["verdant", "verdant", 3008],
  ["milton", "milton", 3009],
  ["desk-recorder", "desk-recorder", 3010],
  ["rao", "rao", 3010],
  ["idea-party", "idea-party", 3011],
  ["longview", "longview", 3011],
  ["beacon", "beacon", 3012],
  ["abba", "abba", 3013],
  ["mesh", "mesh", 3014],
  ["sherry", "sherry", 3014],
];

function seedIfEmpty(): void {
  if (listApps(db).length > 0) return;
  const home = process.env.HOME || "";
  for (const [name, dirName, port] of SEED) {
    const dir = join(home, "workspace", "your_files", dirName);
    if (!existsSync(dir)) continue;
    try {
      addApp(db, { name, dir, port, start_cmd: "bun src/server.ts" });
    } catch {}
  }
  setKv(db, "scan_from", "3000");
  setKv(db, "scan_to", "3030");
}
seedIfEmpty();
reconcileRuntime(db, listApps(db));

/* ---------------- helpers ---------------- */
function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function appStatus(a: App): Record<string, unknown> {
  const p = getProc(a.id);
  return {
    id: a.id, name: a.name, dir: a.dir, port: a.port, start_cmd: a.start_cmd, sort: a.sort,
    running: !!p,
    pid: p ? p.pid : null,
    adopted: p ? p.adopted : false,
    started_at: p ? p.startedAt : null,
    uptime_s: p ? Math.floor((Date.now() - p.startedAt) / 1000) : null,
  };
}

function portConflicts(apps: App[]): Record<number, number[]> {
  const byPort = new Map<number, number[]>();
  for (const a of apps) {
    const l = byPort.get(a.port) || [];
    l.push(a.id);
    byPort.set(a.port, l);
  }
  const out: Record<number, number[]> = {};
  for (const [port, ids] of byPort) if (ids.length > 1) out[port] = ids;
  return out;
}

function envPath(app: App): string {
  return join(app.dir, ".env");
}

function readEnvFile(app: App): Array<{ key: string; value: string }> {
  const p = envPath(app);
  if (!existsSync(p)) return [];
  try {
    return parseEnv(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

/* ---------------- routes ---------------- */
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/health") return json({ ok: true, time: new Date().toISOString() });

  /* ----- auth (open endpoints) ----- */
  if (p === "/api/auth/status" && m === "GET") {
    return json({ configured: totpConfigured(db), authenticated: validSession(db, cookieToken(req)) });
  }

  if (p === "/api/auth/setup" && m === "POST") {
    if (totpConfigured(db)) return json({ error: "two-factor already configured" }, 403);
    const secret = newSecret();
    setKv(db, "totp_pending", secret);
    const uri = otpauthUri(secret);
    return json({ secret, uri, qr_svg: qrToSvg(encodeQr(uri), { scale: 6 }) });
  }

  function clientIp(req: Request): string {
    try {
      const ip = server.requestIP(req);
      return ip ? ip.address : "unknown";
    } catch {
      return "unknown";
    }
  }

  if (p === "/api/auth/enable" && m === "POST") {
    if (totpConfigured(db)) return json({ error: "two-factor already configured" }, 403);
    const pending = getKv(db, "totp_pending");
    if (!pending) return json({ error: "run setup first" }, 400);
    const ip = clientIp(req);
    if (rateLimited(ip)) return json({ error: "too many attempts, wait a minute" }, 429);
    const b = await readJson(req);
    if (!verifyTotp(pending, String(b.code || ""), 1)) {
      noteFail(ip);
      return json({ error: "wrong code, try again" }, 401);
    }
    noteSuccess(ip);
    setKv(db, "totp_secret", pending);
    setKv(db, "totp_enabled", "1");
    setKv(db, "totp_pending", "");
    const token = createSession(db);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (p === "/api/auth/login" && m === "POST") {
    if (!totpConfigured(db)) return json({ error: "two-factor not configured yet" }, 400);
    const ip = clientIp(req);
    if (rateLimited(ip)) return json({ error: "too many attempts, wait a minute" }, 429);
    const b = await readJson(req);
    if (!checkTotp(db, String(b.code || ""))) {
      noteFail(ip);
      return json({ error: "wrong code, try again" }, 401);
    }
    noteSuccess(ip);
    const token = createSession(db);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (p === "/api/auth/logout" && m === "POST") {
    destroySession(db, cookieToken(req));
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (p === "/api/auth/disable" && m === "POST") {
    if (!validSession(db, cookieToken(req))) return json({ error: "auth required" }, 401);
    const b = await readJson(req);
    if (!checkTotp(db, String(b.code || ""))) return json({ error: "wrong code" }, 401);
    setKv(db, "totp_secret", "");
    setKv(db, "totp_enabled", "");
    setKv(db, "totp_pending", "");
    destroyAllSessions(db);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  /* ----- everything below requires a session ----- */
  const OPEN = new Set(["/api/health", "/api/auth/status", "/api/auth/setup", "/api/auth/enable", "/api/auth/login", "/api/auth/logout"]);
  if (p.startsWith("/api/") && !OPEN.has(p)) {
    if (!validSession(db, cookieToken(req))) return json({ error: "auth required" }, 401);
  }

  if (p === "/api/apps" && m === "GET") {
    const apps = listApps(db);
    return json({ apps: apps.map(appStatus), conflicts: portConflicts(apps) });
  }

  if (p === "/api/apps" && m === "POST") {
    const b = await readJson(req);
    const name = String(b.name || "").trim();
    const dir = String(b.dir || "").trim();
    const port = Number(b.port);
    const start_cmd = String(b.start_cmd || "bun src/server.ts").trim() || "bun src/server.ts";
    if (!name) return json({ error: "name is required" }, 400);
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return json({ error: "dir must be an existing directory" }, 400);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "port must be 1-65535" }, 400);
    return json({ app: appStatus(addApp(db, { name, dir, port, start_cmd })) });
  }

  let mm = p.match(/^\/api\/apps\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    const app = getApp(db, id);
    if (!app) return json({ error: "unknown app" }, 404);
    if (m === "GET") return json({ app: appStatus(app) });
    if (m === "PATCH") {
      const b = await readJson(req);
      const patch: Record<string, unknown> = {};
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.dir !== undefined) patch.dir = String(b.dir);
      if (b.port !== undefined) patch.port = Number(b.port);
      if (b.start_cmd !== undefined) patch.start_cmd = String(b.start_cmd);
      if (patch.dir && (!existsSync(String(patch.dir)) || !statSync(String(patch.dir)).isDirectory()))
        return json({ error: "dir must be an existing directory" }, 400);
      if (patch.port !== undefined && (!Number.isInteger(patch.port as number) || (patch.port as number) < 1 || (patch.port as number) > 65535))
        return json({ error: "port must be 1-65535" }, 400);
      const next = updateApp(db, id, patch as any);
      return json({ app: appStatus(next!) });
    }
    if (m === "DELETE") {
      await stopApp(db, id).catch(() => {});
      deleteApp(db, id);
      return json({ ok: true });
    }
  }

  mm = p.match(/^\/api\/apps\/(\d+)\/(start|stop|restart)$/);
  if (mm && m === "POST") {
    const id = Number(mm[1]);
    const app = getApp(db, id);
    if (!app) return json({ error: "unknown app" }, 404);
    try {
      if (mm[2] === "start") {
        const r = await startApp(db, app);
        return json({ ok: true, ...r, app: appStatus(getApp(db, id)!) });
      }
      if (mm[2] === "stop") {
        const was = await stopApp(db, id);
        return json({ ok: true, was_running: was, app: appStatus(getApp(db, id)!) });
      }
      await stopApp(db, id);
      const r = await startApp(db, getApp(db, id)!);
      return json({ ok: true, ...r, app: appStatus(getApp(db, id)!) });
    } catch (e: any) {
      return json({ error: e.message || "failed" }, 500);
    }
  }

  mm = p.match(/^\/api\/apps\/(\d+)\/env$/);
  if (mm && m === "GET") {
    const app = getApp(db, Number(mm[1]));
    if (!app) return json({ error: "unknown app" }, 404);
    const vars = readEnvFile(app).map((v) => ({
      key: v.key,
      secret: isSecretKey(v.key),
      value: isSecretKey(v.key) ? null : v.value,
      length: v.value.length,
    }));
    return json({
      path: envPath(app),
      exists: existsSync(envPath(app)),
      vars,
      deck_manages_port: true,
      note: "PORT is injected by Deck at start time from the app's registered port; a PORT line in .env is ignored.",
    });
  }

  mm = p.match(/^\/api\/apps\/(\d+)\/env\/reveal$/);
  if (mm && m === "POST") {
    const app = getApp(db, Number(mm[1]));
    if (!app) return json({ error: "unknown app" }, 404);
    const b = await readJson(req);
    const key = String(b.key || "");
    const found = readEnvFile(app).find((v) => v.key === key);
    if (!found) return json({ error: "key not found" }, 404);
    return json({ key, value: found.value });
  }

  mm = p.match(/^\/api\/apps\/(\d+)\/env$/);
  if (mm && m === "PUT") {
    const app = getApp(db, Number(mm[1]));
    if (!app) return json({ error: "unknown app" }, 404);
    const b = await readJson(req);
    const incoming: Array<{ key: string; value?: string; keep?: boolean }> = Array.isArray(b.vars) ? b.vars : [];
    const toDelete: string[] = Array.isArray(b.delete) ? b.delete.map(String) : [];
    const current = new Map(readEnvFile(app).map((v) => [v.key, v.value]));
    const next: Array<{ key: string; value: string }> = [];
    const seen = new Set<string>();
    let strippedPort = false;
    for (const item of incoming) {
      const key = String(item.key || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      if (key === "PORT") {
        strippedPort = true;
        continue; // Deck owns PORT
      }
      if (item.keep) {
        if (current.has(key)) next.push({ key, value: current.get(key)! });
        continue;
      }
      next.push({ key, value: String(item.value ?? "") });
    }
    // keys in current but absent from incoming and not in delete list are dropped
    // (the editor always sends the full intended set)
    try {
      writeFileSync(envPath(app), serializeEnv(next), "utf8");
    } catch (e: any) {
      return json({ error: `cannot write .env: ${e.message || e}` }, 500);
    }
    void toDelete;
    const running = !!getProc(app.id);
    return json({ ok: true, count: next.length, stripped_port: strippedPort, restart_needed: running });
  }

  mm = p.match(/^\/api\/apps\/(\d+)\/logs$/);
  if (mm && m === "GET") {
    const app = getApp(db, Number(mm[1]));
    if (!app) return json({ error: "unknown app" }, 404);
    const lines = Math.max(1, Math.min(1000, Number(url.searchParams.get("lines")) || 200));
    return json({ lines: tailLog(app.id, lines) });
  }

  if (p === "/api/scan" && m === "POST") {
    const b = await readJson(req);
    let from = Number(b.from ?? getKv(db, "scan_from") ?? 3000);
    let to = Number(b.to ?? getKv(db, "scan_to") ?? 3030);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || to < from || to - from > 2000)
      return json({ error: "invalid range (max span 2000)" }, 400);
    setKv(db, "scan_from", String(from));
    setKv(db, "scan_to", String(to));
    const hits = await scanPorts(from, to);
    const apps = listApps(db);
    const byPort = new Map(apps.map((a) => [a.port, a.id]));
    return json({
      from, to,
      hits: hits.map((h) => ({ port: h.port, title: h.title, app_id: byPort.get(h.port) ?? null })),
    });
  }

  if (p === "/api/discover" && m === "GET") {
    // directories under ~/workspace/your_files that look like apps but aren't registered
    const home = process.env.HOME || "";
    const base = join(home, "workspace", "your_files");
    const registered = new Set(listApps(db).map((a) => a.dir));
    const out: Array<{ name: string; dir: string }> = [];
    try {
      for (const name of readdirSync(base)) {
        const dir = join(base, name);
        if (registered.has(dir)) continue;
        try {
          if (!statSync(dir).isDirectory()) continue;
          if (existsSync(join(dir, "src", "server.ts")) || existsSync(join(dir, "package.json")))
            out.push({ name, dir });
        } catch {}
      }
    } catch {}
    return json({ candidates: out.sort((a, b) => a.name.localeCompare(b.name)) });
  }

  // static
  const rel = p === "/" ? "/index.html" : p;
  if (!rel.includes("..")) {
    const file = Bun.file(PUBLIC_DIR + rel);
    if (await file.exists()) {
      const ext = rel.slice(rel.lastIndexOf("."));
      const types: Record<string, string> = {
        ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
      };
      return new Response(file, { headers: { "Content-Type": types[ext] || "application/octet-stream" } });
    }
  }
  return new Response("Not found", { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e: any) {
      return json({ error: e.message || "internal error" }, 500);
    }
  },
});

console.log(`Deck on http://127.0.0.1:${server.port} — ${listApps(db).length} apps registered`);
