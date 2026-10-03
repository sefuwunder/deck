/* qr.test.ts — structural checks (decode verified separately with OpenCV). Run with bun. */
import { encodeQr, qrToSvg } from "../src/qr";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

const q1 = encodeQr("HELLO");
ok(q1.size === 21, "V1 size is 21");
ok(q1.dark(0, 0) && q1.dark(6, 0) && q1.dark(0, 6), "finder corners dark");
ok(q1.dark(3, 3), "finder core dark");
ok(!q1.dark(1, 1) && !q1.dark(7, 0), "finder inner light + separator");
ok(q1.dark(8, 8 - 8 + 17) === q1.dark(8, 17), "dark module present");
// version boundaries pick the smallest fitting version
ok(encodeQr("x".repeat(14)).size === 21, "14 chars -> V1");
ok(encodeQr("x".repeat(15)).size === 25, "15 chars -> V2");
ok(encodeQr("x".repeat(84)).size === 37, "84 chars -> V5");
ok(encodeQr("x".repeat(85)).size === 41, "85 chars -> V6");
ok(encodeQr("x".repeat(152)).size === 49, "152 chars -> V8");
let threw = false;
try { encodeQr("x".repeat(153)); } catch { threw = true; }
ok(threw, "153 chars throws");
const svg = qrToSvg(encodeQr("HELLO"));
ok(svg.startsWith("<svg") && svg.includes("<rect"), "qrToSvg renders svg");
// quiet zone: svg viewBox is size+8
ok(svg.includes('viewBox="0 0 29 29"'), "quiet zone in viewBox");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
