/* icons.ts — fetch and cache each app's favicon from its own port. Zero deps. */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TTL_MS = 24 * 3600 * 1000;      // refresh cached icons daily
const MISS_TTL_MS = 3600 * 1000;      // don't re-probe a missing icon for an hour
const MAX_BYTES = 200_000;
const PATHS = ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/favicon.png"];

export interface AppIcon {
  bytes: Uint8Array;
  type: string;
}

/** Return the cached icon, fetching from the app's port when stale. Null when unavailable. */
export async function getAppIcon(
  dataDir: string,
  appId: number,
  port: number,
  running: boolean,
): Promise<AppIcon | null> {
  const dir = join(dataDir, "icons");
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, `${appId}.json`);
  const binPath = join(dir, `${appId}.bin`);

  let meta: { at: number; type: string } | null = null;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch { /* no cache */ }

  if (meta && existsSync(binPath)) {
    const age = Date.now() - meta.at;
    if (meta.type && age < TTL_MS) {
      return { bytes: readFileSync(binPath), type: meta.type };
    }
    if (!meta.type && age < MISS_TTL_MS) return null; // recent miss
  }

  if (!running) return null; // can't probe a stopped app; serve stale cache only
  if (meta && meta.type && existsSync(binPath)) {
    // stale but usable — refresh in background, serve now
    refreshIcon(dir, metaPath, binPath, appId, port).catch(() => {});
    return { bytes: readFileSync(binPath), type: meta.type };
  }

  return refreshIcon(dir, metaPath, binPath, appId, port);
}

async function refreshIcon(
  dir: string, metaPath: string, binPath: string, appId: number, port: number,
): Promise<AppIcon | null> {
  void dir; void appId;
  for (const fp of PATHS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${fp}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const isSvg = fp.endsWith(".svg") || ct === "image/svg+xml";
      if (!isSvg && !ct.startsWith("image/")) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 10 || buf.length > MAX_BYTES) continue;
      if (isSvg && !looksLikeSvg(buf)) continue;
      const type = isSvg ? "image/svg+xml" : ct || "image/png";
      writeFileSync(binPath, buf);
      writeFileSync(metaPath, JSON.stringify({ at: Date.now(), type }));
      return { bytes: buf, type };
    } catch { /* try next path */ }
  }
  writeFileSync(metaPath, JSON.stringify({ at: Date.now(), type: "" }));
  return null;
}

function looksLikeSvg(buf: Uint8Array): boolean {
  const head = new TextDecoder().decode(buf.slice(0, 200)).toLowerCase();
  return head.includes("<svg");
}
