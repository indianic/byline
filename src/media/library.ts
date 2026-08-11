import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { SLUG_PATTERN, SLUG_RULE } from '../config/sites.js';
import { ToolError } from '../errors.js';
import type { LibraryConfig, MediaConfig } from './types.js';

const EMPTY: MediaConfig = { reuseScope: 'site', libraries: {}, problems: [] };

/** Expand a leading `~` against the supplied environment's HOME, then absolutise. */
function expandPath(raw: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Whether `child`, once resolved and normalised, is `parent` itself or sits
 * somewhere underneath it.
 *
 * `relative()` — not a string-prefix check — is what keeps `/media/shots-backup`
 * from reading as nested inside `/media/shots`: a prefix match would treat the
 * two as parent/child purely because one name starts with the other's
 * characters, when they are unrelated siblings.
 *
 * UNVERIFIED: this comparison is a plain string comparison after `resolve()`,
 * not case-fold aware. This repo's primary platform is macOS, where APFS is
 * case-insensitive by default, so `/Users/x/Media/Shots` and
 * `/users/x/media/shots` are the same directory on disk but compare here as
 * unrelated — the index-path-inside-library guard would not catch that case.
 * Deliberately not fixed with `realpathSync`: it requires the path to exist,
 * and probing a path that may not exist would trade this gap for a new
 * failure mode inside a function that must never throw. Whether a
 * case-differing config actually slips past the guard has not been verified
 * against a real case-insensitive volume.
 */
function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Read the `media:` block out of `config.yaml`.
 *
 * Never throws. A missing file, unparseable YAML, or a broken library all
 * produce a usable MediaConfig with the complaint recorded in `problems`,
 * because `loadContext()` must never throw — a doctor that crashed on a broken
 * config would be useless exactly when it is needed.
 */
export function loadMedia(configFile: string, env: NodeJS.ProcessEnv): MediaConfig {
  if (!existsSync(configFile)) return { ...EMPTY, libraries: {}, problems: [] };

  let raw: unknown;
  try {
    raw = parse(readFileSync(configFile, 'utf8'));
  } catch (e) {
    return {
      ...EMPTY,
      libraries: {},
      problems: [`Could not parse ${configFile} for media libraries: ${(e as Error).message}`],
    };
  }

  const block = (raw as { media?: unknown } | null)?.media;
  if (!block || typeof block !== 'object') return { ...EMPTY, libraries: {}, problems: [] };

  const m = block as {
    default_library?: unknown;
    reuse_scope?: unknown;
    libraries?: unknown;
  };
  const problems: string[] = [];

  let reuseScope: 'site' | 'global' = 'site';
  if (m.reuse_scope !== undefined) {
    if (m.reuse_scope === 'site' || m.reuse_scope === 'global') {
      reuseScope = m.reuse_scope;
    } else {
      problems.push(
        `media.reuse_scope must be "site" or "global", not ${JSON.stringify(m.reuse_scope)}. Using "site".`,
      );
    }
  }

  const libraries: Record<string, LibraryConfig> = {};
  const list = Array.isArray(m.libraries) ? m.libraries : [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!name) {
      problems.push('A media library entry has no `name` and was skipped.');
      continue;
    }

    // A whitespace-only path must never fall through to expandPath: resolve('')
    // returns process.cwd() — an existing directory almost always — so an empty
    // `path:` would silently accept byline's own working directory as the
    // library root instead of being rejected as "no path".
    const rawPath = typeof e.path === 'string' ? e.path : '';
    const path = rawPath.trim() ? expandPath(rawPath, env) : '';
    // Same trap as `path` above: `typeof e.index_path === 'string'` is true
    // for `index_path: ""`, and expandPath('') → resolve('') → process.cwd().
    // A whitespace-only index_path must behave as if the field were absent
    // so indexFileFor/ledgerFileFor's `<bylineHome>/media` default applies,
    // instead of silently writing the index and the unrecoverable usage
    // ledger into whatever directory the MCP host happened to launch in.
    const rawIndexPath = typeof e.index_path === 'string' ? e.index_path : '';
    const lib: LibraryConfig = {
      name,
      path,
      recursive: e.recursive === undefined ? true : e.recursive === true,
      ...(rawIndexPath.trim() ? { indexPath: expandPath(rawIndexPath, env) } : {}),
    };

    // Order matters: report the name problem first, because a library with an
    // illegal name is unusable regardless of whether its path happens to exist.
    if (!SLUG_PATTERN.test(name)) {
      lib.unavailable = `Media library "${name}" has an illegal name. ${SLUG_RULE}`;
    } else if (!path) {
      lib.unavailable = `Media library "${name}" has no \`path\`.`;
    } else {
      // existsSync and statSync are two separate syscalls; the directory can
      // vanish between them (deletion, an unmounted network volume), and
      // statSync throws ENOENT when it does. loadMedia must never throw, so
      // any filesystem error here becomes an `unavailable` message naming
      // the path and the error, the same way the YAML parse failure above
      // is turned into a problem instead of propagating.
      try {
        if (!existsSync(path)) {
          lib.unavailable = `Media library "${name}" points at ${path}, which does not exist.`;
        } else if (!statSync(path).isDirectory()) {
          lib.unavailable = `Media library "${name}" points at ${path}, which is not a directory.`;
        } else if (lib.indexPath && isPathInside(lib.indexPath, path)) {
          // Byline must never write inside a user's library folder. A library
          // whose configured index_path resolves to its own path (or somewhere
          // under it) would put the derived index and usage ledger there, so it
          // is refused rather than silently honoured.
          lib.unavailable = `Media library "${name}" has index_path ${lib.indexPath} inside its own path ${path}; byline must never write inside a library folder.`;
        }
      } catch (e2) {
        lib.unavailable = `Media library "${name}" points at ${path}, which could not be checked: ${(e2 as Error).message}`;
      }
    }

    if (lib.unavailable) problems.push(lib.unavailable);
    if (libraries[name]) {
      problems.push(
        `Media library "${name}" is defined more than once in config.yaml; using the last definition.`,
      );
    }
    libraries[name] = lib;
  }

  const defaultLibrary = typeof m.default_library === 'string' ? m.default_library : undefined;
  if (defaultLibrary && !libraries[defaultLibrary]) {
    problems.push(`media.default_library names "${defaultLibrary}", which is not a configured library.`);
  }

  return {
    ...(defaultLibrary ? { defaultLibrary } : {}),
    reuseScope,
    libraries,
    problems,
  };
}

const NO_LIBRARY_HINT =
  'Add one to config.yaml under `media.libraries` as a `name` and a `path`, then run a scan.';

/**
 * The library a call means, refusing at point of use rather than at load.
 *
 * Resolution order: an explicit name, then `default_library`, then the sole
 * library when there is exactly one. The last rule exists because a user with
 * one library should never have to name it.
 */
export function getLibrary(cfg: MediaConfig, name?: string): LibraryConfig {
  const names = Object.keys(cfg.libraries);

  let chosen = name ?? cfg.defaultLibrary;
  if (!chosen && names.length === 1) chosen = names[0];

  if (!chosen) {
    throw new ToolError({
      api: 'media',
      code: 'LIBRARY_NOT_FOUND',
      message:
        names.length === 0
          ? 'No media library is configured.'
          : `Several media libraries are configured (${names.join(', ')}) and none was named.`,
      hint: names.length === 0 ? NO_LIBRARY_HINT : 'Pass `library` naming one of them.',
    });
  }

  const lib = cfg.libraries[chosen];
  if (!lib) {
    throw new ToolError({
      api: 'media',
      code: 'LIBRARY_NOT_FOUND',
      message: `No media library named "${chosen}".${names.length ? ` Configured: ${names.join(', ')}.` : ''}`,
      hint: NO_LIBRARY_HINT,
    });
  }
  if (lib.unavailable) {
    throw new ToolError({
      api: 'media',
      code: 'LIBRARY_UNAVAILABLE',
      message: lib.unavailable,
      hint: 'Fix the path in config.yaml, or remove the library entry.',
    });
  }
  return lib;
}

/** Where the derived index lives. Never inside the user's library folder. */
export function indexFileFor(lib: LibraryConfig, bylineHome: string): string {
  return join(lib.indexPath ?? join(bylineHome, 'media'), `${lib.name}.index.json`);
}

/**
 * Where the usage ledger lives — a SEPARATE file from the index.
 *
 * `scan` rewrites the index. The ledger is unrecoverable. Putting unrecoverable
 * data in a file a routine command overwrites is a data-loss defect waiting for
 * its first user.
 */
export function ledgerFileFor(lib: LibraryConfig, bylineHome: string): string {
  return join(lib.indexPath ?? join(bylineHome, 'media'), `${lib.name}.usage.json`);
}
