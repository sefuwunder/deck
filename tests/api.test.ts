/* api.test.ts — end-to-end: registry, start/stop, env, logs, scan. Run with bun. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { totpNow } from "../src/totp";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const DECK_PORT = 3990;
const APP_PORT = 3991;
const tmpHome = mkdtempSync(join(tmpdir(), "deck-test-"));
const dataDir = join(tmpHome, "deckdata");
const fakeDir = join(tmpHome, "workspace", "your_files", "fakeapp");
mkdirSync(join(fakeDir, "src"), { recursive: true });
writeFileSync(join(fakeDir, "src", "server.ts"),
  `const port = Number(process.env.PORT || 3991);\n` +
  `console.log("fakeapp booted on " + port + " FOO=" + (process.env.FOO || "unset"));\n` +
  `Bun.serve({ port, fetch: () => new Response("hi from fakeapp") });\n`);

const deck = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts")], {
  env: { ...process.env, PORT: String(DECK_PORT), HOME: tmpHome, DECK_DATA_DIR: dataDir },
  stdout: "pipe", stderr: "pipe",
});
const base = `http://127.0.0.1:${DECK_PORT}`;

async function waitUp(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("deck server did not come up");
}

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  const r = await fetch(base + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
let cookie = "";

async function login(): Promise<void> {
  const s = await api("/api/auth/setup", { method: "POST" });
  const code = totpNow(s.data.secret);
  const r = await fetch(base + "/api/auth/enable", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const sc = r.headers.get("set-cookie") || "";
  const m = sc.match(/deck_session=([^;]*)/);
  cookie = m && m[1] ? `deck_session=${m[1]}` : "";
  if (!cookie) throw new Error("no session cookie from enable");
}

try {
  await waitUp();
  ok(true, "deck server boots");
  await login();
  ok(!!cookie, "totp login works");

  // registry
  let r = await api("/api/apps");
  ok(r.status === 200 && r.data.apps.length === 0, "empty registry on fresh HOME");
  r = await api("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  ok(r.status === 400, "add rejects missing dir/port");
  r = await api("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "fakeapp", dir: fakeDir, port: APP_PORT }) });
  ok(r.status === 200 && r.data.app.name === "fakeapp" && r.data.app.port === APP_PORT, "add app");
  const id = r.data.app.id;
  r = await api("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "bad", dir: fakeDir, port: 99999 }) });
  ok(r.status === 400, "add rejects bad port");

  // start: PORT must be injected
  r = await api(`/api/apps/${id}/start`, { method: "POST" });
  ok(r.status === 200 && r.data.app.running && r.data.app.pid > 0, "start app");
  await Bun.sleep(800);
  const hit = await fetch(`http://127.0.0.1:${APP_PORT}/`).then((x) => x.text()).catch(() => "");
  ok(hit === "hi from fakeapp", "app answers on Deck-managed PORT");
  r = await api(`/api/apps/${id}/start`, { method: "POST" });
  ok(r.status === 200 && r.data.app.running, "double start is idempotent");

  // port change on a running app must flag restart (PORT is injected at spawn)
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: APP_PORT + 1 }) });
  ok(r.status === 200 && r.data.port_changed === true && r.data.restart_needed === true, "port change on running app flags restart");
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: APP_PORT }) });
  ok(r.status === 200 && r.data.app.port === APP_PORT && r.data.restart_needed === true, "port change back still flags restart while running");
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "fakeapp" }) });
  ok(r.status === 200 && r.data.port_changed === false && r.data.restart_needed === false, "non-port patch needs no restart");

  // logs
  r = await api(`/api/apps/${id}/logs?lines=50`);
  ok(r.status === 200 && r.data.lines.some((l: string) => l.includes("fakeapp booted on 3991")), "logs capture boot line");

  // env: write, mask, reveal, keep, PORT strip
  r = await api(`/api/apps/${id}/env`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars: [{ key: "FOO", value: "bar" }, { key: "GITHUB_TOKEN", value: "s3cr3t" }, { key: "PORT", value: "1234" }] }),
  });
  ok(r.status === 200 && r.data.stripped_port === true && r.data.restart_needed === true, "env save strips PORT, flags restart");
  r = await api(`/api/apps/${id}/env`);
  const foo = r.data.vars.find((v: any) => v.key === "FOO");
  const tok = r.data.vars.find((v: any) => v.key === "GITHUB_TOKEN");
  ok(foo && foo.value === "bar" && !foo.secret, "plain var readable");
  ok(tok && tok.secret && tok.value === null, "secret masked");
  r = await api(`/api/apps/${id}/env/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "GITHUB_TOKEN" }) });
  ok(r.data.value === "s3cr3t", "reveal returns secret");
  // keep-preserve: save with keep on the secret, new value on FOO
  r = await api(`/api/apps/${id}/env`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars: [{ key: "FOO", value: "baz" }, { key: "GITHUB_TOKEN", keep: true }] }),
  });
  r = await api(`/api/apps/${id}/env/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "GITHUB_TOKEN" }) });
  ok(r.data.value === "s3cr3t", "keep preserves masked secret");

  // restart picks up new env (FOO=baz in boot log)
  r = await api(`/api/apps/${id}/restart`, { method: "POST" });
  ok(r.status === 200 && r.data.app.running, "restart");
  await Bun.sleep(800);
  r = await api(`/api/apps/${id}/logs?lines=50`);
  ok(r.data.lines.some((l: string) => l.includes("FOO=baz")), "restarted app sees edited env");

  // scan finds it and matches the app
  r = await api("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: APP_PORT, to: APP_PORT }) });
  ok(r.status === 200 && r.data.hits.length === 1 && r.data.hits[0].app_id === id, "scan matches listener to app");

  // stop
  r = await api(`/api/apps/${id}/stop`, { method: "POST" });
  ok(r.status === 200 && r.data.app.running === false, "stop app");
  await Bun.sleep(500);
  const dead = await fetch(`http://127.0.0.1:${APP_PORT}/`).then(() => "up").catch(() => "down");
  ok(dead === "down", "port closed after stop");

  // port change on a stopped app: no restart needed, applies on next start
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: APP_PORT + 2 }) });
  ok(r.status === 200 && r.data.port_changed === true && r.data.restart_needed === false, "port change on stopped app needs no restart");
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: APP_PORT }) });
  ok(r.status === 200 && r.data.app.port === APP_PORT, "port restored");

  // patch + delete
  r = await api(`/api/apps/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "fakeapp2" }) });
  ok(r.data.app.name === "fakeapp2", "rename app");
  // conflict detection: register a second app on the same port
  r = await api("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "twin", dir: fakeDir, port: APP_PORT }) });
  const twinId = r.data.app.id;
  r = await api("/api/apps");
  ok(r.data.conflicts[String(APP_PORT)]?.length === 2, "port conflict detected");
  r = await api(`/api/apps/${twinId}`, { method: "DELETE" });
  ok(r.data.ok === true, "delete app");
  r = await api("/api/apps");
  ok(r.data.apps.length === 1 && !r.data.conflicts[String(APP_PORT)], "conflict clears after delete");

  // discover finds unregistered dirs
  const other = join(tmpHome, "workspace", "your_files", "otherapp");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "package.json"), "{}");
  r = await api("/api/discover");
  ok(r.data.candidates.some((c: any) => c.name === "otherapp"), "discover finds unregistered app dir");
} catch (e: any) {
  console.log(`NOT OK - threw: ${e.message}`);
  fail++;
} finally {
  try { await fetch(`${base}/api/apps`).then(async (x) => { const d: any = await x.json(); for (const a of d.apps) await fetch(`${base}/api/apps/${a.id}/stop`, { method: "POST" }).catch(() => {}); }); } catch {}
  deck.kill("SIGKILL");
  await Bun.sleep(300);
  rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
