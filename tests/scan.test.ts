/* scan unit tests (splitCmd) — run with bun. */
import { splitCmd } from "../src/scan";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
ok(eq(splitCmd("bun src/server.ts"), ["bun", "src/server.ts"]), "simple split");
ok(eq(splitCmd('bun run "my script.ts" --port 3001'), ["bun", "run", "my script.ts", "--port", "3001"]), "double quotes");
ok(eq(splitCmd("sh -c 'echo hi'"), ["sh", "-c", "echo hi"]), "single quotes");
ok(eq(splitCmd("  bun   src/server.ts  "), ["bun", "src/server.ts"]), "extra whitespace");
ok(eq(splitCmd(""), []), "empty command");
ok(eq(splitCmd("bun --env-file=.env.local src/server.ts"), ["bun", "--env-file=.env.local", "src/server.ts"]), "flags kept whole");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
