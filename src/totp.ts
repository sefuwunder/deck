/* totp.ts — RFC 6238 TOTP (SHA-1, 30s step, 6 digits). Zero deps (node:crypto). */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.trim().replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** New random secret: 20 bytes -> 32 base32 chars (160 bits). */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

function counterBytes(counter: number): Buffer {
  const b = Buffer.alloc(8);
  // counter fits in 53 bits for any realistic time; write high/low 32 bits
  b.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  b.writeUInt32BE(counter >>> 0, 4);
  return b;
}

/** 6-digit code for a given unix time (seconds). */
export function totpAt(secretB32: string, unixSec: number, step = 30, digits = 6): string {
  const key = Buffer.from(base32Decode(secretB32));
  const counter = Math.floor(unixSec / step);
  const mac = createHmac("sha1", key).update(counterBytes(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpNow(secretB32: string): string {
  return totpAt(secretB32, Math.floor(Date.now() / 1000));
}

/** Verify a 6-digit code, accepting `window` steps of clock skew each way. */
export function verifyTotp(secretB32: string, code: string, window = 1, step = 30): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  const want = Buffer.from(code, "utf8");
  for (let d = -window; d <= window; d++) {
    const got = Buffer.from(totpAt(secretB32, now + d * step, step), "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps. */
export function otpauthUri(secretB32: string, label = "Deck", issuer = "Deck"): string {
  const l = encodeURIComponent(label);
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${l}?secret=${secretB32}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}
