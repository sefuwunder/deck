/* auth-api.test.ts — TOTP setup/enable/login/logout/disable flow. Run with bun. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { totpNow } from "../src/totp";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const DECK_PORT = 3992;
const tmpHome = mkdtempSync(join(tmpdir(), "deck-auth-test-"));
const dataDir = join(tmpHome, "deckdata");

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

let cookie = "";
async function api(path: string, opts: RequestInit = {}): Promise<{ status: number; data: any; setCookie: string | null }> {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  const r = await fetch(base + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, setCookie: r.headers.get("set-cookie") };
}
function eatCookie(setCookie: string | null): void {
  if (setCookie) {
    const m = setCookie.match(/deck_session=([^;]*)/);
    cookie = m && m[1] ? `deck_session=${m[1]}` : "";
  }
}

try {
  await waitUp();

  let r = await api("/api/auth/status");
  ok(r.status === 200 && r.data.configured === false && r.data.authenticated === false, "fresh: not configured");

  r = await api("/api/apps");
  ok(r.status === 401, "api requires auth when unconfigured");

  r = await api("/api/auth/setup", { method: "POST" });
  ok(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret) && r.data.qr_svg.includes("<svg"), "setup returns secret + QR svg");
  const secret = r.data.secret;
  ok(r.data.uri.includes(`secret=${secret}`), "setup returns otpauth uri");

  r = await api("/api/auth/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
  ok(r.status === 401, "enable rejects wrong code");

  r = await api("/api/auth/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totpNow(secret) }) });
  ok(r.status === 200 && r.setCookie && r.setCookie.includes("deck_session"), "enable accepts right code, sets session cookie");
  eatCookie(r.setCookie);

  r = await api("/api/auth/status");
  ok(r.data.configured === true && r.data.authenticated === true, "status: configured + authenticated");

  r = await api("/api/apps");
  ok(r.status === 200, "authed api works");

  // no cookie -> 401
  const saved = cookie;
  cookie = "";
  r = await api("/api/apps");
  ok(r.status === 401, "no cookie -> 401");
  r = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "123456" }) });
  ok(r.status === 401, "login rejects wrong code");
  r = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totpNow(secret) }) });
  ok(r.status === 200 && r.setCookie, "login accepts right code");
  eatCookie(r.setCookie);

  // logout kills the current session
  r = await api("/api/auth/logout", { method: "POST" });
  ok(r.status === 200, "logout ok");
  r = await api("/api/apps");
  ok(r.status === 401, "session dead after logout");
  cookie = saved; // the other session from enable-time is still valid (per-session logout)
  r = await api("/api/apps");
  ok(r.status === 200, "other session survives logout");

  // disable needs auth + code; re-login first
  r = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totpNow(secret) }) });
  eatCookie(r.setCookie);
  r = await api("/api/auth/disable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
  ok(r.status === 401, "disable rejects wrong code");
  r = await api("/api/auth/disable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totpNow(secret) }) });
  ok(r.status === 200, "disable accepts right code");
  r = await api("/api/auth/status");
  ok(r.data.configured === false, "back to unconfigured after disable");
  r = await api("/api/apps");
  ok(r.status === 401, "sessions destroyed on disable");

  // setup again after disable works
  r = await api("/api/auth/setup", { method: "POST" });
  ok(r.status === 200 && r.data.secret !== secret, "can set up again with a fresh secret");
} catch (e: any) {
  console.log(`NOT OK - threw: ${e.message}`);
  fail++;
} finally {
  deck.kill("SIGKILL");
  await Bun.sleep(300);
  rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
