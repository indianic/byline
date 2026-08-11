import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

    const path = typeof e.path === 'string' ? expandPath(e.path, env) : '';
    const lib: LibraryConfig = {
      name,
      path,
      recursive: e.recursive === undefined ? true : e.recursive === true,
      ...(typeof e.index_path === 'string' ? { indexPath: expandPath(e.index_path, env) } : {}),
    };

    // Order matters: report the name problem first, because a library with an
    // illegal name is unusable regardless of whether its path happens to exist.
    if (!SLUG_PATTERN.test(name)) {
      lib.unavailable = `Media library "${name}" has an illegal name. ${SLUG_RULE}`;
    } else if (!path) {
      lib.unavailable = `Media library "${name}" has no \`path\`.`;
    } else if (!existsSync(path)) {
      lib.unavailable = `Media library "${name}" points at ${path}, which does not exist.`;
    } else if (!statSync(path).isDirectory()) {
      lib.unavailable = `Media library "${name}" points at ${path}, which is not a directory.`;
    }

    if (lib.unavailable) problems.push(lib.unavailable);
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
