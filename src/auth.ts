/* auth.ts — TOTP-gated sessions. Zero deps (node:crypto). */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getKv, setKv } from "./db";
import { verifyTotp } from "./totp";

export const COOKIE_NAME = "deck_session";
const SESSION_DAYS = 30;

export function totpConfigured(db: Database): boolean {
  return getKv(db, "totp_enabled") === "1" && !!getKv(db, "totp_secret");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Create a session, returning the raw token for the cookie. */
export function createSession(db: Database): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.query(`INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)`)
    .run(hashToken(token), now, now + SESSION_DAYS * 86400 * 1000);
  // opportunistic cleanup
  db.query(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  return token;
}

export function validSession(db: Database, token: string | null | undefined): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const want = hashToken(token);
  const row = db.query(`SELECT expires_at FROM sessions WHERE token_hash = ?`).get(want) as { expires_at: number } | null;
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(want);
    return false;
  }
  return true;
}

export function destroySession(db: Database, token: string | null | undefined): void {
  if (!token) return;
  db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function destroyAllSessions(db: Database): void {
  db.query(`DELETE FROM sessions`).run();
}

export function sessionCookie(token: string): string {
  const maxAge = SESSION_DAYS * 86400;
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function cookieToken(req: Request): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/* ---------- login rate limiting (in-memory) ---------- */
const attempts = new Map<string, { fails: number; first: number }>();
const MAX_FAILS = 5;
const WINDOW_MS = 60_000;

export function rateLimited(ip: string): boolean {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return a.fails >= MAX_FAILS;
}

export function noteFail(ip: string): void {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(ip, { fails: 1, first: Date.now() });
  else a.fails++;
}

export function noteSuccess(ip: string): void {
  attempts.delete(ip);
}

/** Timing-safe check of a TOTP code against the configured secret. */
export function checkTotp(db: Database, code: string): boolean {
  const secret = getKv(db, "totp_secret");
  if (!secret) return false;
  return verifyTotp(secret, code, 1);
}

/** Constant-time string compare helper for codes (defense in depth). */
export function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
