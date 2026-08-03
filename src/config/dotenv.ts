import { readFileSync, statSync } from 'node:fs';

/**
 * Parse `.env` text into key/value pairs.
 *
 * Deliberately small. We do not use `process.loadEnvFile` because it landed in
 * Node 20.12 and this package supports Node 20.0 — a user on an early 20.x would
 * get a TypeError at startup with no useful message. Twenty lines we control and
 * can unit-test is a better trade than a version-sensitive built-in.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;

    // Split on the FIRST '=' only. Ghost admin keys are `id:secret` and other
    // values contain '=' (base64 padding), so splitting greedily corrupts them.
    const eq = body.indexOf('=');
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    const doubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
    const singleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;

    if (doubleQuoted) {
      // `upsertEnvVars`' formatEnvValue escapes an embedded `"` as `\"` so the
      // written line stays parseable; unescape it here so the value round-trips.
      // A pre-existing file that happens to contain a literal `\"` sequence
      // (nothing we ship ever writes one) unescapes the same way, which is
      // the closest reading available without a full escaping grammar.
      value = value.slice(1, -1).replace(/\\"/g, '"');
    } else if (singleQuoted) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a whitespace-preceded '#'. A bare '#' inside
      // the value (as in a URL fragment) is kept.
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Read `.env` into an environment object.
 *
 * An MCP server is launched by the client, not a shell, so it inherits none of
 * your terminal's exports — without this, every key would look unset no matter
 * what is in `.env`. Values already present win, so an MCP registration can
 * still override the file. A missing `.env` is fine: keys may come from the client.
 */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Warn when `.env` is readable by anyone but its owner.
 *
 * Not fatal: refusing to start because of a file mode would strand a user whose
 * umask differs, and the diagnostic path must work in a broken state. `doctor`
 * surfaces this and offers the fix.
 */
export function checkEnvPermissions(file: string): string | null {
  let mode: number;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  const octal = mode.toString(8).padStart(3, '0');
  return `${file} is mode ${octal} — readable by other users on this machine. Run \`chmod 600 ${file}\`.`;
}
