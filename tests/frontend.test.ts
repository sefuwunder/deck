/* frontend.test.ts — DOM-stubbed render of the fleet. Run with bun. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

function makeEl(tag = "div"): any {
  const el: any = {
    tag, children: [] as any[], _html: "", _text: "", hidden: false,
    classList: { _s: new Set<string>(), add(c: string) { this._s.add(c); }, remove(c: string) { this._s.delete(c); }, toggle(c: string, f?: boolean) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); }, contains(c: string) { return this._s.has(c); } },
    style: {} as any, dataset: {} as any,
    listeners: {} as Record<string, Function[]>,
    addEventListener(t: string, f: Function) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    appendChild(c: any) { this.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    closest(sel: string) { return sel === ".card" ? this._card || null : null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v: string) { this._html = v; } });
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v: string) { this._text = String(v); } });
  return el;
}

const els: Record<string, any> = {};
const ids = ["toast", "fleet-summary", "scan-info", "conflict-banner", "apps", "wire-list", "scan-btn", "add-btn",
  "lock-btn", "auth", "auth-body", "widgets-btn", "theme-btn", "widgets",
  "sheet", "sheet-backdrop", "sheet-title", "sheet-body", "sheet-close", "scan-from", "scan-to"];
for (const id of ids) { els[id] = makeEl(); els[id].id = id; }
els["scan-from"].value = "3000"; els["scan-to"].value = "3030";
els["widgets"].hidden = true;

let apiHandler: (path: string, opts?: any) => Promise<any> = async () => ({});
(globalThis as any).document = {
  getElementById: (id: string) => els[id] || null,
  querySelector: () => ({ scrollIntoView() {} }),
  documentElement: makeEl("html"),
  addEventListener() {}, body: makeEl("body"),
  createElement: (t: string) => makeEl(t),
};
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).fetch = async (path: string, opts?: any) => {
  const data = await apiHandler(path, opts);
  return { ok: true, json: async () => data };
};
(globalThis as any).setInterval = () => 0;
(globalThis as any).clearInterval = () => {};
(globalThis as any).clearTimeout = () => {};
(globalThis as any).setTimeout = ((fn: Function) => 0) as any;
(globalThis as any).confirm = () => true;
(globalThis as any).prompt = () => null;

const src = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");

apiHandler = async (path: string) => {
  if (path === "/api/auth/status") return { configured: true, authenticated: true };
  if (path === "/api/apps") return {
    apps: [
      { id: 1, name: "relay", dir: "/home/x/relay", port: 3006, start_cmd: "bun src/server.ts", running: true, pid: 111, adopted: false, started_at: Date.now() - 70000, uptime_s: 70 },
      { id: 2, name: "sp1200", dir: "/home/x/sp1200", port: 3007, start_cmd: "bun src/server.ts", running: false, pid: null, adopted: false, started_at: null, uptime_s: null },
      { id: 3, name: "twin", dir: "/home/x/twin", port: 3006, start_cmd: "bun src/server.ts", running: false, pid: null, adopted: false, started_at: null, uptime_s: null },
    ],
    conflicts: { "3006": [1, 3] },
  };
  return {};
};

eval(src);

// refresh() is async and called at boot; let it settle
await Bun.sleep(50);

const appsHtml: string = els["apps"].innerHTML;
ok(appsHtml.includes("relay") && appsHtml.includes("sp1200"), "fleet renders app names");
ok(appsHtml.includes(":3006") && appsHtml.includes(":3007"), "ports shown");
ok(appsHtml.includes("card-chev"), "cards are tappable rows with chevron");
ok(!appsHtml.includes("pid 111") && !appsHtml.includes("1m up"), "stats hidden from cards (live in detail sheet)");
ok(appsHtml.includes("data-id=\"1\""), "cards carry app ids");
// tap a card -> glassy detail sheet with stats + actions
const cardEl = { getAttribute: () => "1" };
const clickEvt = { target: { closest: (sel: string) => sel === ".card" ? cardEl : null } };
(els["apps"].listeners["click"][0] as Function)(clickEvt);
const sheetHtml: string = els["sheet-body"].innerHTML;
ok(!els["sheet"].hidden, "tapping a card opens the detail sheet");
ok(sheetHtml.includes("pid 111") || sheetHtml.includes("111"), "detail sheet shows pid stat");
ok(sheetHtml.includes("1m up"), "detail sheet shows uptime stat");
ok(sheetHtml.includes("data-app-act=\"toggle\"") && sheetHtml.includes("data-app-act=\"env\""), "detail sheet has actions");
ok(!els["conflict-banner"].hidden && els["conflict-banner"].innerHTML.includes("3006"), "port conflict banner shows");
ok((els["fleet-summary"].innerHTML as string).includes("1 running"), "fleet summary counts");
// widgets tray toggle
(els["widgets-btn"].listeners["click"][0] as Function)();
ok(!els["widgets"].hidden, "▦ button reveals the widget tray");
const wHtml: string = els["widgets"].innerHTML;
ok(wHtml.includes("Fleet") && wHtml.includes("Port conflicts") && wHtml.includes("Stray listeners"), "tray holds three glassy widgets");
ok(wHtml.includes("glass"), "widgets use the glass style");
// theme cycles auto -> light -> dark
const t0 = (els["theme-btn"] as any).textContent;
(els["theme-btn"].listeners["click"][0] as Function)();
ok((els["theme-btn"] as any).textContent !== t0, "theme button cycles the theme");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
