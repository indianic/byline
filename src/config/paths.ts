import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which rule produced the base directory.
 *
 * `legacy` means the pre-rename `~/.writeblogs/` directory was used because no
 * `~/.byline/` exists yet. It is deliberately a distinct value rather than
 * being folded into `home`: an existing user's config keeps working untouched,
 * and `status`/`doctor` can say so and point at `byline migrate` instead of
 * silently reading from a directory whose name no longer matches the product.
 */
export type BaseSource = 'env' | 'home' | 'legacy' | 'repo';

/** The pre-rename directory and variable prefix, still honoured for one release. */
const LEGACY_DIR = '.writeblogs';
const LEGACY_PREFIX = 'WRITEBLOGS';

/** Which rule produced one individual path. `override` = a `BYLINE_<X>` variable named it directly. */
export type FieldSource = BaseSource | 'override';

/**
 * Where one path actually came from.
 *
 * This exists because `Paths.source` describes ONLY how the base directory was
 * resolved. With a per-path override set, `source` can say `home` while the
 * file in question lives somewhere else entirely — so `status` and `doctor`
 * must print this per field rather than one global source, or their output is
 * simply false.
 */
export interface PathProvenance {
  path: string;
  source: FieldSource;
  /** The variable that named this path directly, when `source` is `override`. */
  via?: string;
}

export interface Paths {
  /** The resolved base directory. */
  home: string;
  /**
   * Which rule produced the BASE directory — not necessarily where any given
   * file came from. Use `provenance` for that.
   */
  source: BaseSource;
  configFile: string;
  personasDir: string;
  envFile: string;
  runsDir: string;
  /** Per-field provenance. See `PathProvenance` for why one global source is not enough. */
  provenance: {
    configFile: PathProvenance;
    personasDir: PathProvenance;
    envFile: PathProvenance;
    runsDir: PathProvenance;
  };
}

/** One path: an explicit override wins and records which variable set it. */
function field(
  via: string,
  override: string | undefined,
  derived: string,
  base: BaseSource,
): PathProvenance {
  return override ? { path: override, source: 'override', via } : { path: derived, source: base };
}

/**
 * Read a path override under the new name, falling back to the pre-rename one.
 *
 * Returns the variable that actually supplied the value, so `provenance.via`
 * names the real thing a user has set rather than the one we wish they had —
 * printing `BYLINE_SITES` at someone who set `WRITEBLOGS_SITES` would send them
 * hunting for a variable that is not in their environment.
 */
function overrideFor(
  env: NodeJS.ProcessEnv,
  suffix: string,
): { via: string; value: string | undefined } {
  const current = `BYLINE_${suffix}`;
  const legacy = `${LEGACY_PREFIX}_${suffix}`;
  return env[current]
    ? { via: current, value: env[current] }
    : { via: env[legacy] ? legacy : current, value: env[legacy] };
}

/**
 * Resolve where configuration lives.
 *
 * Order: `$BYLINE_HOME` → `~/.byline/` → `~/.writeblogs/` (pre-rename, still
 * honoured) → the repo checkout. The last is
 * a development convenience, recognised by `config/sites.yaml` sitting in the
 * *current working directory*.
 *
 * Note that the repo-local branch is cwd-dependent, and an MCP host chooses the
 * cwd it launches the server in. A published install therefore CAN match it —
 * for example when the host launches the server inside a checkout that happens
 * to contain `config/sites.yaml`. A real config directory takes priority, so
 * in practice a user who has run `init` is unaffected; `doctor` reports which
 * branch actually matched so the case is diagnosable rather than mysterious.
 *
 * The individual `BYLINE_SITES` / `_PERSONAS` / `_ENV` / `_RUNS` variables (and
 * their `WRITEBLOGS_*` predecessors)
 * override single paths and win over the resolved base, so an MCP registration
 * can point one file somewhere unusual without relocating everything. When one
 * of those is set, `source` still describes the base — `provenance` is what
 * describes the file.
 *
 * `exists` is injectable so the resolution order can be unit-tested without
 * touching a real filesystem.
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd(),
  exists: (path: string) => boolean = existsSync,
): Paths {
  const userHome = join(home, '.byline');
  const legacyHome = join(home, LEGACY_DIR);
  const homeOverride = overrideFor(env, 'HOME');

  let base: string;
  let source: BaseSource;

  if (homeOverride.value) {
    base = homeOverride.value;
    source = 'env';
  } else if (exists(userHome)) {
    base = userHome;
    source = 'home';
  } else if (exists(legacyHome)) {
    // Pre-rename config, still working. Read it exactly where it is rather than
    // moving anything: a rename must never relocate a user's live credentials
    // behind their back. `status` and `doctor` surface `legacy` and point at
    // `byline migrate`, which is the one thing allowed to move it, and only
    // with --yes.
    base = legacyHome;
    source = 'legacy';
  } else if (exists(join(cwd, 'config', 'sites.yaml'))) {
    base = cwd;
    source = 'repo';
  } else {
    // Nothing set up yet. Name the place `init` will create, so every message
    // that mentions a path points at the same one.
    base = userHome;
    source = 'home';
  }

  const isRepo = source === 'repo';

  const sites = overrideFor(env, 'SITES');
  const personas = overrideFor(env, 'PERSONAS');
  const envVar = overrideFor(env, 'ENV');
  const runs = overrideFor(env, 'RUNS');

  const provenance = {
    configFile: field(
      sites.via,
      sites.value,
      isRepo ? join(base, 'config', 'sites.yaml') : join(base, 'config.yaml'),
      source,
    ),
    personasDir: field(personas.via, personas.value, join(base, 'personas'), source),
    envFile: field(envVar.via, envVar.value, join(base, '.env'), source),
    runsDir: field(
      runs.via,
      runs.value,
      isRepo ? join(base, '.runs') : join(base, 'runs'),
      source,
    ),
  };

  return {
    home: base,
    source,
    configFile: provenance.configFile.path,
    personasDir: provenance.personasDir.path,
    envFile: provenance.envFile.path,
    runsDir: provenance.runsDir.path,
    provenance,
  };
}
