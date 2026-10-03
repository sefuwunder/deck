/* totp.test.ts — RFC 6238 test vectors + base32 round-trip. Run with bun. */
import { base32Encode, base32Decode, newSecret, totpAt, totpNow, verifyTotp, otpauthUri } from "../src/totp";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`NOT OK - ${name}`); }
}

// RFC 6238 Appendix B, SHA-1, secret = ASCII "12345678901234567890"
const rfcSecret = base32Encode(new TextEncoder().encode("12345678901234567890"));
const vectors: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];
for (const [t, want] of vectors) {
  ok(totpAt(rfcSecret, t) === want, `RFC vector T=${t} -> ${want}`);
}

ok(new TextDecoder().decode(base32Decode(base32Encode(new TextEncoder().encode("hello world")))) === "hello world", "base32 round-trip");
ok(/^[A-Z2-7]{32}$/.test(newSecret()), "newSecret is 32 base32 chars");
ok(/^\d{6}$/.test(totpNow(rfcSecret)), "totpNow is 6 digits");
ok(verifyTotp(rfcSecret, totpNow(rfcSecret)), "verifyTotp accepts current code");
ok(!verifyTotp(rfcSecret, "000000") || totpNow(rfcSecret) === "000000", "verifyTotp rejects wrong code");
ok(!verifyTotp(rfcSecret, "abcdef"), "verifyTotp rejects non-digits");
ok(!verifyTotp(rfcSecret, "12345"), "verifyTotp rejects short code");
const uri = otpauthUri("JBSWY3DPEHPK3PXP");
ok(uri.startsWith("otpauth://totp/") && uri.includes("secret=JBSWY3DPEHPK3PXP"), "otpauth URI shape");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
