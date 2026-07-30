import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Paths } from '../config/paths.js';

/**
 * Everything that writes `~/.byline/`.
 *
 * Kept separate from the prompting so both `init` (a human answering questions)
 * and `migrate` (copying an existing repo checkout) land identical files, and
 * so all of it is unit-testable against a temp directory without a terminal.
 */

/**
 * The environment variable name a site's secret field is stored under.
 *
 * Must always match `src/config/sites.ts`'s `ENV_REF` (`\$\{[A-Z0-9_]+\}`).
 * A name outside that character set does not match on reload, so the `${…}`
 * text is treated as a LITERAL credential — the site then loads as "usable"
 * with garbage credentials and no warning, and fails much later with a
 * confusing auth error instead of here.
 */
export function envVarNameFor(slug: string, fieldName: string): string {
  const clean = (s: string) =>
    s
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Z0-9_]/g, '');
  return `${clean(slug)}_${clean(fieldName)}`;
}

/** Create the config home and its subdirectories. Idempotent. */
export function ensureHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.personasDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
}

/**
 * A value needs quoting when `parseEnv` would otherwise mangle it.
 *
 * `src/config/dotenv.ts` truncates an unquoted value at a whitespace-preceded
 * `#`, and trims surrounding whitespace. A WordPress Application Password is
 * shown with spaces (`abcd EFGH ijkl MNOP`), so quoting is not hypothetical.
 */
function formatEnvValue(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Escape a string for literal use inside a `RegExp` constructor. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Set variables in `.env`, collapsing every existing definition of a key down
 * to a single line rather than appending a duplicate — `parseEnv` takes the
 * LAST occurrence, so if we only rewrote the first match, a pre-existing
 * duplicate would make this whole function a silent no-op: it reports
 * success, the file looks edited, but the credential actually in effect never
 * changes.
 *
 * The file is always left at mode 600. `checkEnvPermissions` warns about
 * anything looser on load, and `doctor` surfaces it; writing it correctly here
 * is what makes that warning rare.
 */
export function upsertEnvVars(envFile: string, vars: Record<string, string>): void {
  mkdirSync(dirname(envFile), { recursive: true });

  let lines: string[] = [];
  if (existsSync(envFile)) {
    lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  }

  for (const [key, value] of Object.entries(vars)) {
    const rendered = `${key}=${formatEnvValue(value)}`;
    // The key is a general-purpose string here (this function has no
    // enforced input contract), so it must be escaped before it is spliced
    // into a RegExp — an unbalanced `(` etc. would otherwise throw.
    const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
    const matches: number[] = [];
    lines.forEach((l, i) => {
      if (pattern.test(l)) matches.push(i);
    });

    if (matches.length > 0) {
      const first = matches[0]!;
      lines[first] = rendered;
      // Drop every other occurrence so `parseEnv` (which takes the last
      // occurrence) sees exactly the value we just wrote. Splice from the
      // end so earlier indices stay valid.
      for (let i = matches.length - 1; i >= 1; i--) {
        lines.splice(matches[i]!, 1);
      }
    } else {
      lines.push(rendered);
    }
  }

  const text = lines.join('\n').replace(/\n+$/, '') + '\n';
  writeFileSync(envFile, text, { mode: 0o600 });
  // writeFileSync's `mode` applies only when it CREATES the file, so an
  // existing loose .env would keep its old mode without this.
  chmodSync(envFile, 0o600);
}

/**
 * Merge one site into `config.yaml`, preserving everything already there.
 *
 * Reads and rewrites rather than appending text, so YAML stays valid; a config
 * that fails to parse is a hard error rather than something to overwrite,
 * because overwriting is how a user loses three working sites to fix a fourth.
 *
 * Refuses to replace an EXISTING slug unless `replace: true` is passed
 * explicitly — matching `add_site` in `src/tools/site-tools.ts`, which has
 * always refused this with `SITE_EXISTS`. Before this, `init` naming a blog the
 * same slug as an already-configured one (a different platform, a different
 * URL) silently replaced it — config block, `default_site`, and the `.env`
 * secret `persistSite` had already written — with no warning and no recovery.
 * No current caller passes `replace: true`; it exists only for a future caller
 * that has gotten the user's explicit confirmation first.
 */
export function writeSiteToConfig(
  configFile: string,
  slug: string,
  block: Record<string, string>,
  makeDefault: boolean,
  options: { replace?: boolean } = {},
): void {
  let doc: { default_site?: string; sites?: Record<string, unknown> } = {};

  if (existsSync(configFile)) {
    const text = readFileSync(configFile, 'utf8');
    if (text.trim()) {
      const parsed: unknown = parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          `${configFile} is not a YAML mapping — fix or move it aside before adding a site, so nothing already configured is lost.`,
        );
      }
      doc = parsed as typeof doc;
    }
  }

  if (doc.sites?.[slug] && !options.replace) {
    throw new Error(
      `Site "${slug}" already exists in ${configFile}. Remove it first (e.g. via the remove_site tool), or pick a different name — ` +
        'replacing it here would silently discard its config and (if different) its .env credential.',
    );
  }

  doc.sites = { ...(doc.sites ?? {}), [slug]: block };
  if (makeDefault || !doc.default_site) doc.default_site = slug;

  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, stringify(doc), 'utf8');
}

/**
 * Copy the shipped persona template into the user's personas directory.
 *
 * Returns the path written, or null when a template is already there — an
 * edited template is the user's work, and silently replacing it would discard
 * it. `personas/_template.yaml` ships via package.json's `files`.
 */
export function seedPersonaTemplate(personasDir: string): string | null {
  const dest = join(personasDir, '_template.yaml');
  if (existsSync(dest)) return null;

  // dist/cli/home-config.js → ../../personas/_template.yaml; src/cli under tsx
  // resolves identically, both being two levels below the package root.
  const source = new URL('../../personas/_template.yaml', import.meta.url);
  mkdirSync(personasDir, { recursive: true });
  copyFileSync(source, dest);
  return dest;
}
