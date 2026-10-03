/* envfile.ts — minimal .env parse / serialize. Zero deps.
 *
 * Format: KEY=VALUE lines, # comments, blank lines. Values may be quoted
 * with single or double quotes; \n, \t, \\, \" escapes honored inside
 * double quotes. Everything else is literal.
 */
export interface EnvVar {
  key: string;
  value: string;
}

export function parseEnv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1);
    } else {
      // strip trailing inline comment for unquoted values
      const hash = value.search(/(^|\s)#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.push({ key, value });
  }
  return out;
}

export function serializeEnv(vars: EnvVar[]): string {
  return (
    vars
      .map(({ key, value }) => {
        if (/[\s#"']/.test(value) || value === "") {
          const q = value
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
          return `${key}="${q}"`;
        }
        return `${key}=${value}`;
      })
      .join("\n") + (vars.length ? "\n" : "")
  );
}

/** A key looks secret when it names a credential. */
export function isSecretKey(key: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE)/i.test(key);
}
