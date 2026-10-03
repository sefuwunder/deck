/* scan.ts — TCP port scan on loopback + title sniffing for unknown listeners. */
export interface ScanHit {
  port: number;
  title: string | null;
}

function tryConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open() {
          clearTimeout(timer);
          finish(true);
        },
        error() {
          clearTimeout(timer);
          finish(false);
        },
        close() {
          clearTimeout(timer);
          finish(false);
        },
        data() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function sniffTitle(port: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    clearTimeout(t);
    const text = await r.text();
    const m = text.match(/<title[^>]*>([^<]{1,80})/i);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Scan ports [from..to] on 127.0.0.1. Concurrency-limited. */
export async function scanPorts(from: number, to: number, concurrency = 24): Promise<ScanHit[]> {
  const ports: number[] = [];
  for (let p = from; p <= to; p++) ports.push(p);
  const hits: ScanHit[] = [];
  for (let i = 0; i < ports.length; i += concurrency) {
    const chunk = ports.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((p) => tryConnect(p, 1200)));
    for (let j = 0; j < chunk.length; j++) {
      if (results[j]) hits.push({ port: chunk[j], title: await sniffTitle(chunk[j]) });
    }
  }
  return hits.sort((a, b) => a.port - b.port);
}

/** Split a shell command into argv, honoring single/double quotes. */
export function splitCmd(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}
