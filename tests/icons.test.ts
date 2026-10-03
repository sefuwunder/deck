/* icons.test.ts — favicon fetch + cache. Run with bun. */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAppIcon } from "../src/icons";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "deck-icons-test-"));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="red"/></svg>`;

// stub app server
const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/favicon.svg") return new Response(SVG, { headers: { "Content-Type": "image/svg+xml" } });
    if (u.pathname === "/favicon.ico") return new Response("not an image", { headers: { "Content-Type": "text/html" } });
    return new Response("nf", { status: 404 });
  },
});
const PORT = stub.port;

try {
  // svg fetched and cached
  const r1 = await getAppIcon(tmp, 7, PORT, true);
  ok(!!r1 && r1.type === "image/svg+xml" && new TextDecoder().decode(r1.bytes).includes("<svg"), "fetches svg favicon");
  ok(existsSync(join(tmp, "icons", "7.json")) && existsSync(join(tmp, "icons", "7.bin")), "icon cached to disk");

  // served from cache without hitting network
  await stub.stop(true);
  const r2 = await getAppIcon(tmp, 7, PORT, true);
  ok(!!r2 && r2.type === "image/svg+xml", "second call served from cache");

  // stopped app with no cache -> null, no probe attempted
  const r3 = await getAppIcon(tmp, 8, 1, false);
  ok(r3 === null, "stopped app with no cache -> null");
} finally {
  try { await stub.stop(true); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
