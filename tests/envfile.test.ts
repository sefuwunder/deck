/* envfile unit tests — run with bun. */
import { parseEnv, serializeEnv, isSecretKey } from "../src/envfile";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const parsed = parseEnv([
  "# comment",
  "",
  "PLAIN=hello",
  "SPACED = spaced value",
  "QUOTED=\"a b # c\"",
  "SINGLE='x y'",
  "ESC=\"line1\\nline2\"",
  "TRAILING=val # inline comment",
  "EMPTY=",
  "1BAD=nope",
  "NOEQUALS",
].join("\n"));
const get = (k: string) => parsed.find((v) => v.key === k)?.value;

ok(get("PLAIN") === "hello", "plain value");
ok(get("SPACED") === "spaced value", "spaces around =");
ok(get("QUOTED") === "a b # c", "double-quoted keeps #");
ok(get("SINGLE") === "x y", "single quotes literal");
ok(get("ESC") === "line1\nline2", "escape sequences");
ok(get("TRAILING") === "val", "inline comment stripped");
ok(get("EMPTY") === "", "empty value");
ok(!parsed.some((v) => v.key === "1BAD"), "bad key skipped");
ok(!parsed.some((v) => v.key === "NOEQUALS"), "no-equals skipped");

// round-trip
const vars = [
  { key: "A", value: "simple" },
  { key: "B", value: "has space" },
  { key: "C", value: 'quote"inside' },
  { key: "D", value: "line1\nline2" },
  { key: "E", value: "" },
];
const back = parseEnv(serializeEnv(vars));
ok(back.length === vars.length && back.every((v, i) => v.key === vars[i].key && v.value === vars[i].value), "serialize round-trips");

ok(isSecretKey("GITHUB_TOKEN"), "TOKEN is secret");
ok(isSecretKey("api_key"), "api_key is secret");
ok(isSecretKey("DB_PASSWORD"), "PASSWORD is secret");
ok(!isSecretKey("PORT") && !isSecretKey("APP_NAME"), "ordinary keys not secret");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
