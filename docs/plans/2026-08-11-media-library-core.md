# Media Library Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user point byline at a folder of their own images, search it by keyword, publish from it, and never publish the same file twice.

**Architecture:** A new `src/media/` module — infrastructure, not a plugin, because a local folder has no credentials, no remote API and no health check. It reads config from the existing `config.yaml`, writes a derived index and a separate usage ledger under `~/.byline/media/`, and exposes three MCP tools. The user's folder is read-only to byline: no file is ever moved, renamed, or written to.

**Tech Stack:** TypeScript (ESM, `node:` builtins only), zod for tool schemas, `yaml` for config, vitest for tests. No new runtime dependencies in this plan.

**Source spec:** `docs/specs/2026-08-11-local-media-library-design.md`, build-order steps 1–4.

## Global Constraints

- **Node ≥ 20**, ESM, `.js` extensions on every relative import (the repo compiles with `tsc`, no bundler).
- **`src/cli/` gains no knowledge of any specific library, platform or provider.** No CLI work in this plan.
- **Byline never writes inside a user's library folder.** No moving, no renaming, no sidecar files.
- **Asset identity is `sha256:<hex>` of file bytes.** Never a path.
- **Index and ledger are separate files.** `scan` rewrites the index; the ledger is unrecoverable and must never be in a file a routine command overwrites.
- **Nothing fails silently.** Every tool returns a result or a `ToolError` naming the failing subsystem, with a `hint`.
- **`loadContext()` must still never throw.** Media problems collect into `SetupState.problems`.
- **Library names use `SLUG_PATTERN` imported from `src/config/sites.ts`.** One rule, one definition — do not write a second regex.
- **Tests assert behaviour at runtime.** `npm run typecheck` covers `src/**/*` only; test files are not typechecked, so a double can cast past an interface it does not satisfy.
- **Never write `process.env = { ...saved }`** in a test. Restore per key.
- Run after every task: `npm run typecheck && npm test`.

## Two rulings made before execution

Both resolve a conflict between an earlier draft of this plan and `CLAUDE.md`. They bind every task.

**1. No `as Context` casts in tests. Narrow the parameter instead.**

`CLAUDE.md`: *"test files are not typechecked. A double can cast past an interface it does not satisfy."* A test that casts a three-field object to `Context` keeps passing on the day the function starts reading `ctx.personas`.

So the media functions take exactly what they use, declared field by field. A real `Context` satisfies both structurally, and a test object needs no cast at all — not even for `paths`, which is why this is `Pick<Paths, 'home'>` rather than the whole `Paths`:

```ts
/** Everything the read-only media tools touch. A real Context satisfies this. */
export interface MediaCtx {
  paths: Pick<Paths, 'home'>;
  media: MediaConfig;
}

/** …plus sites, for the tools that upload. */
export interface UploadCtx extends MediaCtx {
  sites: SitesConfig;
}
```

Any test that still needs `as` after this has found a function reading something it did not declare. Fix the declaration, not the test.

This also requires widening one existing signature in `src/tools/shared.ts`:

```ts
export function adapterFor(ctx: Pick<Context, 'sites'>, slug: string): PlatformAdapter {
```

Narrowing a parameter type is backwards-compatible — every existing caller still passes a full `Context`.

**2. `promoteUsedMedia` reports its failures. No empty catch.**

`CLAUDE.md`: *"Nothing fails silently."* It returns `{ promoted: number; problems: string[] }`, and `create_post`/`update_post` fold `problems` into the `warnings` array they already return. The publish still succeeds; the ledger failure becomes visible instead of invisible.

## Deviations from the spec, and why

Two, both deliberate. Raise them with the spec author if either looks wrong.

1. **`src/media/index.ts` is named `store.ts`.** In this repo `index.ts` is a barrel file (`src/plugins/images/index.ts`, `src/tools/index.ts`). A non-barrel `index.ts` imported as `../media/index.js` would read as one and mislead every future reader.
2. **EXIF extraction is deferred to Plan 2.** `captured_at` falls back to file mtime, and `source.captured_from` records `'mtime'` so the weaker claim is visible rather than disguised. EXIF needs an APP1 parser that should be written against real photo fixtures, not blind. `source.exif` is absent until then.

## File structure

| File | Responsibility |
|---|---|
| `src/media/types.ts` | Every shared type. No logic |
| `src/media/library.ts` | Parse the `media:` block from `config.yaml`, resolve and validate paths |
| `src/media/scan.ts` | Walk a library, hash files, extract metadata, build a `MediaIndex` |
| `src/media/store.ts` | Atomic read/write of the index and ledger JSON files |
| `src/media/search.ts` | Rank assets against a query |
| `src/media/ledger.ts` | Usage records: reserve, promote, release, and the used-or-not test |
| `src/tools/media-tools.ts` | `list_media_libraries`, `find_media`, `use_media` |

---

### Task 1: Types and library config

**Files:**
- Create: `src/media/types.ts`
- Create: `src/media/library.ts`
- Test: `tests/media/library.test.ts`

**Interfaces:**
- Consumes: `SLUG_PATTERN` from `src/config/sites.js`.
- Produces: every type in `types.ts`; `loadMedia(configFile: string, env: NodeJS.ProcessEnv): MediaConfig`; `indexFileFor(lib: LibraryConfig, home: string): string`; `ledgerFileFor(lib: LibraryConfig, home: string): string`; `getLibrary(cfg: MediaConfig, name?: string): LibraryConfig`.

- [ ] **Step 1: Write the failing test**

Create `tests/media/library.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { getLibrary, indexFileFor, ledgerFileFor, loadMedia } from '../../src/media/library.js';

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bl-media-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, yaml);
  return file;
}

function realDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bl-lib-'));
  mkdirSync(join(d, 'sub'), { recursive: true });
  return d;
}

describe('loadMedia', () => {
  it('returns empty defaults when the config has no media block', () => {
    const cfg = loadMedia(fixture('sites: {}\n'), {});
    expect(cfg.libraries).toEqual({});
    expect(cfg.reuseScope).toBe('site');
    expect(cfg.defaultLibrary).toBeUndefined();
  });

  it('reads a library and defaults recursive to true', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  default_library: shots\n  libraries:\n    - name: shots\n      path: ${root}\n`),
      {},
    );
    expect(cfg.defaultLibrary).toBe('shots');
    expect(cfg.libraries.shots?.path).toBe(root);
    expect(cfg.libraries.shots?.recursive).toBe(true);
    expect(cfg.libraries.shots?.unavailable).toBeUndefined();
  });

  it('marks a library unavailable rather than throwing when its path is missing', () => {
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: /nope/does/not/exist\n'),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toMatch(/does not exist/i);
  });

  it('marks a library unavailable when its name breaks SLUG_PATTERN', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: My_Shots\n      path: ${root}\n`),
      {},
    );
    expect(cfg.libraries.My_Shots?.unavailable).toMatch(/lowercase/i);
  });

  it('expands a leading ~ against HOME', () => {
    const home = realDir();
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: ~/sub\n'),
      { HOME: home },
    );
    expect(cfg.libraries.shots?.path).toBe(join(home, 'sub'));
  });

  it('rejects an unknown reuse_scope value', () => {
    const cfg = loadMedia(fixture('media:\n  reuse_scope: whatever\n  libraries: []\n'), {});
    expect(cfg.reuseScope).toBe('site');
    expect(cfg.problems.join(' ')).toMatch(/reuse_scope/);
  });
});

describe('getLibrary', () => {
  it('throws a ToolError naming the library when it is not configured', () => {
    const cfg = loadMedia(fixture('sites: {}\n'), {});
    expect(() => getLibrary(cfg, 'missing')).toThrow(ToolError);
    try {
      getLibrary(cfg, 'missing');
    } catch (e) {
      expect((e as ToolError).code).toBe('LIBRARY_NOT_FOUND');
      expect((e as ToolError).hint).toBeTruthy();
    }
  });

  it('throws when a library exists but is unavailable', () => {
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: /nope\n'),
      {},
    );
    expect(() => getLibrary(cfg, 'shots')).toThrow(ToolError);
  });

  it('falls back to default_library when no name is given', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  default_library: shots\n  libraries:\n    - name: shots\n      path: ${root}\n`),
      {},
    );
    expect(getLibrary(cfg).name).toBe('shots');
  });

  it('uses the sole library when there is exactly one and no default is named', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: only\n      path: ${root}\n`),
      {},
    );
    expect(getLibrary(cfg).name).toBe('only');
  });
});

describe('indexFileFor / ledgerFileFor', () => {
  it('puts both files under the byline home, not inside the library', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n`),
      {},
    );
    const lib = cfg.libraries.shots!;
    expect(indexFileFor(lib, '/home/u/.byline')).toBe('/home/u/.byline/media/shots.index.json');
    expect(ledgerFileFor(lib, '/home/u/.byline')).toBe('/home/u/.byline/media/shots.usage.json');
  });

  it('honours an explicit index_path', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: /shared/idx\n`),
      {},
    );
    const lib = cfg.libraries.shots!;
    expect(indexFileFor(lib, '/home/u/.byline')).toBe('/shared/idx/shots.index.json');
    expect(ledgerFileFor(lib, '/home/u/.byline')).toBe('/shared/idx/shots.usage.json');
  });

  it('never places either file inside the library root', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n`),
      {},
    );
    const lib = cfg.libraries.shots!;
    expect(indexFileFor(lib, '/home/u/.byline').startsWith(root)).toBe(false);
    expect(ledgerFileFor(lib, '/home/u/.byline').startsWith(root)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/library.test.ts`
Expected: FAIL — `Cannot find module '../../src/media/library.js'`

- [ ] **Step 3: Write `src/media/types.ts`**

```ts
/** The three aspect buckets the image tools already accept. One vocabulary, not two. */
export type Aspect = '16:9' | '4:3' | '1:1';

export type MediaKind = 'image' | 'video';

export interface LibraryConfig {
  name: string;
  /** Absolute, `~` already expanded. */
  path: string;
  recursive: boolean;
  /** Where the index and ledger live. Defaults to `<byline home>/media`. */
  indexPath?: string;
  /**
   * Why this library cannot be used, if it cannot. Mirrors `SiteConfig.unavailable`:
   * a broken library still loads so the others keep working, and `getLibrary`
   * refuses it at point of use.
   */
  unavailable?: string;
}

export interface MediaConfig {
  defaultLibrary?: string;
  /** `site` — used on one site, still free elsewhere. `global` — used once, ever. */
  reuseScope: 'site' | 'global';
  libraries: Record<string, LibraryConfig>;
  /** Config-level complaints, folded into SetupState.problems by loadContext. */
  problems: string[];
}

export interface AssetSource {
  filename_tokens: string[];
  folder_tokens: string[];
  /** Where `captured_at` came from. `mtime` is a much weaker claim than `exif`. */
  captured_from: 'exif' | 'mtime';
  exif?: Record<string, string>;
}

export interface AssetEnrichment {
  by: string;
  at: string;
  caption: string;
  keywords: string[];
  look: string;
  has_people: boolean;
  text_in_image: boolean;
}

export interface Asset {
  /** `sha256:<hex>` of the file's bytes. The only identity that survives a rename. */
  id: string;
  /** Relative to the library root, POSIX separators, so an index is portable. */
  path: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  aspect: Aspect | null;
  duration_s: number | null;
  captured_at: string;
  scanned_at: string;
  /** Part of the hash cache key. A file whose mtime and size are unchanged is not rehashed. */
  mtime_ms: number;
  source: AssetSource;
  enriched?: AssetEnrichment;
}

export interface MediaIndex {
  version: 1;
  library: string;
  root: string;
  scanned_at: string;
  assets: Asset[];
}

export type UsageState = 'reserved' | 'published';

export interface UsageRecord {
  id: string;
  site: string;
  state: UsageState;
  hosted_url: string;
  post_url?: string;
  slot?: string;
  at: string;
}

export interface UsageLedger {
  version: 1;
  library: string;
  records: UsageRecord[];
}
```

- [ ] **Step 4: Write `src/media/library.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/media/library.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/media/types.ts src/media/library.ts tests/media/library.test.ts
git commit -m "feat(media): library config types and resolution

Reads the media: block from config.yaml. A broken library is marked
unavailable and still loads, so one bad path never stops the others --
the same rule sites already follow, and what keeps loadContext() from
throwing. Library names reuse SLUG_PATTERN rather than a second copy.

Index and ledger paths are computed separately and never resolve inside
the user's library folder."
```

---

### Task 2: Wire media config into Context

**Files:**
- Modify: `src/context.ts`
- Test: `tests/media/context-media.test.ts`

**Interfaces:**
- Consumes: `loadMedia` from Task 1.
- Produces: `Context.media: MediaConfig`. Every later task reads the config from here rather than re-parsing `config.yaml`.

- [ ] **Step 1: Write the failing test**

Create `tests/media/context-media.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';

function home(configYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bl-ctx-'));
  writeFileSync(join(dir, 'config.yaml'), configYaml);
  return dir;
}

describe('loadContext media', () => {
  it('exposes an empty media config when none is set', () => {
    const dir = home('sites: {}\n');
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.media.libraries).toEqual({});
    expect(ctx.media.reuseScope).toBe('site');
  });

  it('exposes a configured library', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl-ctx-'));
    const shots = join(dir, 'shots');
    mkdirSync(shots, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${shots}\n`,
    );
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.media.libraries.shots?.path).toBe(shots);
  });

  it('folds a broken library into setup problems without throwing', () => {
    const dir = home('sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: /nope/nowhere\n');
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.setup.problems.join(' ')).toMatch(/does not exist/i);
  });
});
```

`BYLINE_HOME` is the correct base-directory override — verified in `src/config/paths.ts`, whose resolution order is `$BYLINE_HOME` → `~/.byline/` → `~/.writeblogs/` (pre-rename) → repo-local.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/context-media.test.ts`
Expected: FAIL — `ctx.media` is undefined.

- [ ] **Step 3: Modify `src/context.ts`**

Add the import beside the existing config imports:

```ts
import { loadMedia } from './media/library.js';
import type { MediaConfig } from './media/types.js';
```

Add to the `Context` interface, after `personas`:

```ts
  /** Local media libraries. Empty when none are configured — never absent. */
  media: MediaConfig;
```

In `loadContext`, after the `personas` block and before the `return`:

```ts
  // loadMedia never throws by contract, so there is no try/catch here. Its
  // complaints arrive as `media.problems` and are folded into SetupState below.
  const media = loadMedia(paths.configFile, env);
  extraProblems.push(...media.problems);
```

Then add `media,` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/media/ && npm run typecheck && npm test`
Expected: all PASS. The full suite must stay green — `buildSetupState` now receives extra problems, so any test asserting an exact `problems` length will need reading, not deleting.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts tests/media/context-media.test.ts
git commit -m "feat(media): expose media config on Context

loadMedia never throws, so its complaints arrive as media.problems and
fold into SetupState the same way a site's missing key does. Every later
consumer reads ctx.media rather than re-parsing config.yaml."
```

---

### Task 3: Scanning and hashing

**Files:**
- Create: `src/media/scan.ts`
- Test: `tests/media/scan.test.ts`

**Interfaces:**
- Consumes: `inspectImage` from `src/plugins/images/inspect.js`; types from Task 1.
- Produces: `scanLibrary(lib: LibraryConfig, previous: MediaIndex | null, now?: Date): MediaIndex`; `nearestAspect(w: number, h: number): Aspect`; `tokenise(text: string): string[]`; `MEDIA_EXTENSIONS: Record<string, { kind: MediaKind; mime: string }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/media/scan.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nearestAspect, scanLibrary, tokenise } from '../../src/media/scan.js';
import type { LibraryConfig } from '../../src/media/types.js';

/** A real 1x1 PNG. Byte-accurate, so inspectImage reads genuine magic bytes. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function libWith(files: Record<string, Buffer | string>): LibraryConfig {
  const root = mkdtempSync(join(tmpdir(), 'bl-scan-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return { name: 'shots', path: root, recursive: true };
}

describe('tokenise', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenise('Team_Standup-01.JPG')).toEqual(['team', 'standup', '01']);
  });

  it('drops single-character fragments', () => {
    expect(tokenise('a-photo')).toEqual(['photo']);
  });

  it('returns an empty array for text with no usable tokens', () => {
    expect(tokenise('__--__')).toEqual([]);
  });
});

describe('nearestAspect', () => {
  it('buckets 1920x1080 as 16:9', () => {
    expect(nearestAspect(1920, 1080)).toBe('16:9');
  });

  it('buckets 4032x3024 as 4:3', () => {
    expect(nearestAspect(4032, 3024)).toBe('4:3');
  });

  it('buckets a square as 1:1', () => {
    expect(nearestAspect(800, 800)).toBe('1:1');
  });

  it('buckets a portrait 3:4 as 1:1, the nearest of the three it has', () => {
    expect(nearestAspect(3024, 4032)).toBe('1:1');
  });
});

describe('scanLibrary', () => {
  it('indexes an image with a content-hash id and real dimensions', () => {
    const lib = libWith({ 'portraits/team-standup-01.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);

    expect(idx.assets).toHaveLength(1);
    const a = idx.assets[0]!;
    expect(a.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.path).toBe('portraits/team-standup-01.png');
    expect(a.kind).toBe('image');
    expect(a.mime).toBe('image/png');
    expect(a.width).toBe(1);
    expect(a.height).toBe(1);
    expect(a.aspect).toBe('1:1');
    expect(a.source.filename_tokens).toEqual(['team', 'standup', '01']);
    expect(a.source.folder_tokens).toEqual(['portraits']);
    expect(a.source.captured_from).toBe('mtime');
  });

  it('gives two copies of the same bytes the same id', () => {
    const lib = libWith({ 'a.png': PNG_1x1, 'nested/b.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets).toHaveLength(2);
    expect(idx.assets[0]!.id).toBe(idx.assets[1]!.id);
  });

  it('indexes video by extension with null dimensions', () => {
    const lib = libWith({ 'clips/demo.mp4': Buffer.from('not really an mp4') });
    const idx = scanLibrary(lib, null);
    const a = idx.assets[0]!;
    expect(a.kind).toBe('video');
    expect(a.mime).toBe('video/mp4');
    expect(a.width).toBeNull();
    expect(a.aspect).toBeNull();
    expect(a.duration_s).toBeNull();
  });

  it('ignores files with unknown extensions', () => {
    const lib = libWith({ 'notes.txt': 'hello', 'a.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets).toHaveLength(1);
    expect(idx.assets[0]!.path).toBe('a.png');
  });

  it('ignores dotfiles and dot-directories', () => {
    const lib = libWith({ '.hidden.png': PNG_1x1, '.git/x.png': PNG_1x1, 'ok.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['ok.png']);
  });

  it('does not descend when recursive is false', () => {
    const lib = { ...libWith({ 'top.png': PNG_1x1, 'sub/deep.png': PNG_1x1 }), recursive: false };
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['top.png']);
  });

  it('reuses the previous id when mtime and size are unchanged', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const doctored = {
      ...first,
      assets: [{ ...first.assets[0]!, id: 'sha256:CACHED', enriched: undefined }],
    };
    const second = scanLibrary(lib, doctored);
    expect(second.assets[0]!.id).toBe('sha256:CACHED');
  });

  it('rehashes when the file changed, even at the same size', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const file = join(lib.path, 'a.png');
    writeFileSync(file, PNG_1x1);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const second = scanLibrary(lib, first);
    expect(second.assets[0]!.id).toBe(first.assets[0]!.id);
    expect(second.assets[0]!.mtime_ms).not.toBe(first.assets[0]!.mtime_ms);
  });

  it('carries enrichment forward for an unchanged file', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const enriched = {
      ...first,
      assets: [
        {
          ...first.assets[0]!,
          enriched: {
            by: 'gemini',
            at: '2026-08-11T00:00:00.000Z',
            caption: 'a dot',
            keywords: ['dot'],
            look: 'flat',
            has_people: false,
            text_in_image: false,
          },
        },
      ],
    };
    const second = scanLibrary(lib, enriched);
    expect(second.assets[0]!.enriched?.caption).toBe('a dot');
  });

  it('drops an asset whose file no longer exists', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const stale = {
      ...first,
      assets: [...first.assets, { ...first.assets[0]!, id: 'sha256:GONE', path: 'gone.png' }],
    };
    const second = scanLibrary(lib, stale);
    expect(second.assets.map((a) => a.path)).toEqual(['a.png']);
  });

  it('sorts assets by path so the written index is stable', () => {
    const lib = libWith({ 'z.png': PNG_1x1, 'a.png': PNG_1x1, 'm/b.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['a.png', 'm/b.png', 'z.png']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/scan.test.ts`
Expected: FAIL — `Cannot find module '../../src/media/scan.js'`

- [ ] **Step 3: Write `src/media/scan.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inspectImage } from '../plugins/images/inspect.js';
import type { Asset, Aspect, LibraryConfig, MediaIndex, MediaKind } from './types.js';

/**
 * What byline will index, keyed by lowercase extension.
 *
 * An allow-list rather than a deny-list: a library folder holds sidecars, RAW
 * files, `.DS_Store` and half-finished exports, and indexing whatever happens
 * not to be excluded is how a search fills with junk.
 *
 * The mime here names the CONTAINER, from the extension. For images it is
 * corrected from the magic bytes below; a file named `.png` that is really a
 * JPEG must not be uploaded declaring itself a PNG, which is the defect
 * `inspectImage` was written for.
 */
export const MEDIA_EXTENSIONS: Record<string, { kind: MediaKind; mime: string }> = {
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  png: { kind: 'image', mime: 'image/png' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
};

const ASPECT_RATIOS: Record<Aspect, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };

/**
 * The nearest of the three buckets `generate_image` already accepts.
 *
 * Compared on log-ratio so the distance is scale-invariant: without it, wide
 * ratios sit further apart in absolute terms than narrow ones and 1:1 wins
 * arguments it should lose. Portrait images have no bucket of their own and
 * land on 1:1, which is the closest of the three that exist — a known limit,
 * not a bug to be surprised by later.
 */
export function nearestAspect(width: number, height: number): Aspect {
  const ratio = width / height;
  let best: Aspect = '1:1';
  let bestDistance = Infinity;
  for (const name of Object.keys(ASPECT_RATIOS) as Aspect[]) {
    const distance = Math.abs(Math.log(ratio / ASPECT_RATIOS[name]));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

/** Lowercase alphanumeric runs of two or more characters. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function hashFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Every indexable file under `root`, as paths relative to it, POSIX-separated. */
function walk(root: string, recursive: boolean): string[] {
  const out: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Dotfiles are metadata, version control, and OS bookkeeping. None of it
      // is media, and `.git` in particular would be walked in full.
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MEDIA_EXTENSIONS[extensionOf(entry.name)]) continue;
      out.push(relative(root, full).split(sep).join('/'));
    }
  };

  visit(root);
  return out.sort();
}

/**
 * Build an index for one library, reusing what the previous index already knows.
 *
 * A file whose size and mtime both match its previous entry is NOT rehashed and
 * NOT re-inspected, and its enrichment carries forward. That cache is what keeps
 * a rescan of a few thousand photographs cheap; without it, `scan` would be an
 * operation nobody runs twice.
 *
 * An entry whose file has gone is dropped. The index describes what is on disk
 * right now; the ledger, which lives in a different file, is what remembers
 * assets that no longer exist.
 */
export function scanLibrary(
  lib: LibraryConfig,
  previous: MediaIndex | null,
  now: Date = new Date(),
): MediaIndex {
  const scannedAt = now.toISOString();
  const cache = new Map((previous?.assets ?? []).map((a) => [a.path, a]));
  const assets: Asset[] = [];

  for (const rel of walk(lib.path, lib.recursive)) {
    const full = join(lib.path, rel);
    const stat = statSync(full);
    const ext = extensionOf(rel);
    const declared = MEDIA_EXTENSIONS[ext]!;

    const prior = cache.get(rel);
    const unchanged =
      prior !== undefined && prior.bytes === stat.size && prior.mtime_ms === stat.mtimeMs;

    if (unchanged) {
      assets.push({ ...prior, scanned_at: scannedAt });
      continue;
    }

    const segments = rel.split('/');
    const filename = segments[segments.length - 1]!;
    const folders = segments.slice(0, -1);

    let width: number | null = null;
    let height: number | null = null;
    let mime = declared.mime;

    if (declared.kind === 'image') {
      // Magic bytes, never the filename. A `.png` that is really a JPEG must
      // upload as a JPEG, or the platform is told the wrong Content-Type.
      const info = inspectImage(readFileSync(full));
      width = info.width;
      height = info.height;
      if (info.mime) mime = info.mime;
    }

    assets.push({
      id: hashFile(full),
      path: rel,
      kind: declared.kind,
      mime,
      bytes: stat.size,
      width,
      height,
      aspect: width && height ? nearestAspect(width, height) : null,
      // Video dimensions and duration need a container parser. Left null in
      // this plan rather than guessed — see the deviations note.
      duration_s: null,
      captured_at: new Date(stat.mtimeMs).toISOString(),
      scanned_at: scannedAt,
      mtime_ms: stat.mtimeMs,
      source: {
        filename_tokens: tokenise(filename.replace(/\.[^.]+$/, '')),
        folder_tokens: folders.flatMap(tokenise),
        // EXIF is Plan 2. Recording WHERE the date came from keeps the weaker
        // claim visible instead of letting an mtime pass as a capture time.
        captured_from: 'mtime',
      },
      ...(prior?.enriched ? { enriched: prior.enriched } : {}),
    });
  }

  return {
    version: 1,
    library: lib.name,
    root: lib.path,
    scanned_at: scannedAt,
    assets,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/media/scan.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media/scan.ts tests/media/scan.test.ts
git commit -m "feat(media): library scanning with content-hash identity

Ids are sha256 of the bytes, so two copies of one photo collapse to one
asset and a rename does not create a second. Files unchanged by size and
mtime are neither rehashed nor re-inspected, and carry their enrichment
forward -- without that cache, scan is a command nobody runs twice.

Image mime comes from the magic bytes via inspectImage, never from the
extension: a .png that is really a JPEG must not upload declaring itself
a PNG. Video dimensions are left null rather than guessed."
```

---

### Task 4: Atomic store for index and ledger

**Files:**
- Create: `src/media/store.ts`
- Test: `tests/media/store.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `readIndex(file: string): MediaIndex | null`; `writeIndex(file: string, index: MediaIndex): void`; `readLedger(file: string, library: string): UsageLedger`; `writeLedger(file: string, ledger: UsageLedger): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/media/store.test.ts`:

```ts
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readIndex, readLedger, writeIndex, writeLedger } from '../../src/media/store.js';
import type { MediaIndex, UsageLedger } from '../../src/media/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'bl-store-'));

const INDEX: MediaIndex = {
  version: 1,
  library: 'shots',
  root: '/tmp/shots',
  scanned_at: '2026-08-11T00:00:00.000Z',
  assets: [],
};

const LEDGER: UsageLedger = { version: 1, library: 'shots', records: [] };

describe('readIndex', () => {
  it('returns null when the file does not exist', () => {
    expect(readIndex(join(dir(), 'nope.json'))).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', () => {
    const file = join(dir(), 'i.json');
    writeFileSync(file, '{ not json');
    expect(readIndex(file)).toBeNull();
  });

  it('returns null for a version it does not understand', () => {
    const file = join(dir(), 'i.json');
    writeFileSync(file, JSON.stringify({ ...INDEX, version: 99 }));
    expect(readIndex(file)).toBeNull();
  });

  it('round-trips a written index', () => {
    const file = join(dir(), 'i.json');
    writeIndex(file, INDEX);
    expect(readIndex(file)).toEqual(INDEX);
  });
});

describe('writeIndex', () => {
  it('creates the parent directory', () => {
    const file = join(dir(), 'deep', 'nested', 'i.json');
    writeIndex(file, INDEX);
    expect(readIndex(file)).toEqual(INDEX);
  });

  it('leaves no temp file behind', () => {
    const d = dir();
    writeIndex(join(d, 'i.json'), INDEX);
    expect(readdirSync(d)).toEqual(['i.json']);
  });
});

describe('readLedger', () => {
  it('returns an empty ledger when the file does not exist', () => {
    const l = readLedger(join(dir(), 'nope.json'), 'shots');
    expect(l).toEqual({ version: 1, library: 'shots', records: [] });
  });

  it('THROWS on unparseable JSON instead of returning empty', () => {
    const file = join(dir(), 'u.json');
    writeFileSync(file, '{ not json');
    expect(() => readLedger(file, 'shots')).toThrow(/could not be read/i);
  });

  it('round-trips records', () => {
    const file = join(dir(), 'u.json');
    const l: UsageLedger = {
      ...LEDGER,
      records: [
        {
          id: 'sha256:a',
          site: 'personal',
          state: 'reserved',
          hosted_url: 'https://x/1.png',
          at: '2026-08-11T00:00:00.000Z',
        },
      ],
    };
    writeLedger(file, l);
    expect(readLedger(file, 'shots')).toEqual(l);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/store.test.ts`
Expected: FAIL — `Cannot find module '../../src/media/store.js'`

- [ ] **Step 3: Write `src/media/store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolError } from '../errors.js';
import type { MediaIndex, UsageLedger } from './types.js';

/**
 * Write via a temp file and rename.
 *
 * `renameSync` within one filesystem is atomic, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. Writing in place would make
 * an interrupted `scan` destroy the index it was rebuilding — recoverable — and
 * an interrupted ledger write destroy usage history, which is not.
 */
function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Read an index, or null if there isn't a usable one.
 *
 * Every failure returns null, because the index is DERIVED: a missing,
 * corrupt, or future-versioned file all mean the same thing to a caller — scan
 * again. Refusing to run would strand a user behind a file they never wrote by
 * hand and cannot repair.
 */
export function readIndex(file: string): MediaIndex | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MediaIndex;
    if (parsed?.version !== 1 || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeIndex(file: string, index: MediaIndex): void {
  writeAtomic(file, index);
}

/**
 * Read a ledger, or an empty one if it has never been written.
 *
 * Deliberately the OPPOSITE of `readIndex` on corruption: this THROWS. A
 * corrupt index costs a rescan; a corrupt ledger is unrecoverable usage
 * history, and silently continuing with an empty one would republish every
 * photograph the user has already used and report success. Loud beats tidy.
 */
export function readLedger(file: string, library: string): UsageLedger {
  if (!existsSync(file)) return { version: 1, library, records: [] };

  let parsed: UsageLedger;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as UsageLedger;
  } catch (e) {
    throw new ToolError({
      api: 'media',
      code: 'LEDGER_UNREADABLE',
      message: `The usage ledger at ${file} could not be read: ${(e as Error).message}`,
      hint: 'Restore it from a backup. Deleting it loses the record of which media you have already published, and byline will start reusing images.',
    });
  }

  if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
    throw new ToolError({
      api: 'media',
      code: 'LEDGER_UNREADABLE',
      message: `The usage ledger at ${file} is not in a format this version understands.`,
      hint: 'Restore it from a backup rather than deleting it — deleting it loses which media you have already published.',
    });
  }

  return parsed;
}

export function writeLedger(file: string, ledger: UsageLedger): void {
  writeAtomic(file, ledger);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/media/store.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media/store.ts tests/media/store.test.ts
git commit -m "feat(media): atomic index and ledger store

Both write through a temp file and rename, so an interrupted write leaves
the previous file intact.

The two read paths behave deliberately differently on corruption. A
corrupt index returns null, because it is derived and a rescan rebuilds
it. A corrupt ledger THROWS, because it is not: continuing with an empty
one would republish every photo the user has already used and report
success."
```

---

### Task 5: Usage ledger operations

**Files:**
- Create: `src/media/ledger.ts`
- Test: `tests/media/ledger.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `isUsed(ledger: UsageLedger, id: string, site: string, scope: 'site' | 'global'): boolean`; `reserve(ledger: UsageLedger, rec: Omit<UsageRecord, 'state'>): UsageLedger`; `promote(ledger: UsageLedger, hostedUrls: string[], postUrl: string): { ledger: UsageLedger; promoted: number }`; `release(ledger: UsageLedger, id: string): { ledger: UsageLedger; released: number }`; `staleReservations(ledger: UsageLedger): UsageRecord[]`.

All four return a new ledger rather than mutating, so a caller cannot half-apply a change and then fail before writing.

- [ ] **Step 1: Write the failing test**

Create `tests/media/ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isUsed, promote, release, reserve, staleReservations } from '../../src/media/ledger.js';
import type { UsageLedger } from '../../src/media/types.js';

const empty: UsageLedger = { version: 1, library: 'shots', records: [] };

const withOne = reserve(empty, {
  id: 'sha256:a',
  site: 'personal',
  hosted_url: 'https://blog/1.png',
  at: '2026-08-11T00:00:00.000Z',
  slot: 'hero',
});

describe('reserve', () => {
  it('adds a reserved record without mutating the input', () => {
    expect(empty.records).toHaveLength(0);
    expect(withOne.records).toHaveLength(1);
    expect(withOne.records[0]!.state).toBe('reserved');
  });
});

describe('isUsed', () => {
  it('reports an asset used on the same site', () => {
    expect(isUsed(withOne, 'sha256:a', 'personal', 'site')).toBe(true);
  });

  it('leaves it free on a different site under site scope', () => {
    expect(isUsed(withOne, 'sha256:a', 'nicgulf', 'site')).toBe(false);
  });

  it('marks it used everywhere under global scope', () => {
    expect(isUsed(withOne, 'sha256:a', 'nicgulf', 'global')).toBe(true);
  });

  it('reports an unknown id as unused', () => {
    expect(isUsed(withOne, 'sha256:zzz', 'personal', 'site')).toBe(false);
  });
});

describe('promote', () => {
  it('promotes a reserved record whose hosted url appears in the post', () => {
    const { ledger, promoted } = promote(withOne, ['https://blog/1.png'], 'https://blog/post/');
    expect(promoted).toBe(1);
    expect(ledger.records[0]!.state).toBe('published');
    expect(ledger.records[0]!.post_url).toBe('https://blog/post/');
  });

  it('promotes nothing when no url matches', () => {
    const { ledger, promoted } = promote(withOne, ['https://blog/other.png'], 'https://blog/post/');
    expect(promoted).toBe(0);
    expect(ledger.records[0]!.state).toBe('reserved');
  });

  it('is idempotent — re-promoting an already published record changes nothing', () => {
    const once = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const twice = promote(once, ['https://blog/1.png'], 'https://blog/other/');
    expect(twice.promoted).toBe(0);
    expect(twice.ledger.records[0]!.post_url).toBe('https://blog/post/');
  });
});

describe('release', () => {
  it('removes a reserved record', () => {
    const { ledger, released } = release(withOne, 'sha256:a');
    expect(released).toBe(1);
    expect(ledger.records).toHaveLength(0);
  });

  it('refuses to release a published record', () => {
    const published = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const { ledger, released } = release(published, 'sha256:a');
    expect(released).toBe(0);
    expect(ledger.records).toHaveLength(1);
  });
});

describe('staleReservations', () => {
  it('lists reserved records and excludes published ones', () => {
    const published = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const mixed = reserve(published, {
      id: 'sha256:b',
      site: 'personal',
      hosted_url: 'https://blog/2.png',
      at: '2026-08-11T00:00:00.000Z',
    });
    expect(staleReservations(mixed).map((r) => r.id)).toEqual(['sha256:b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/ledger.test.ts`
Expected: FAIL — `Cannot find module '../../src/media/ledger.js'`

- [ ] **Step 3: Write `src/media/ledger.ts`**

```ts
import type { UsageLedger, UsageRecord } from './types.js';

/**
 * Has this asset been used?
 *
 * Both `reserved` and `published` count. A reservation means the bytes are
 * already on the platform, so serving the asset again would put the same
 * photograph in two posts — which is the one thing this ledger exists to stop.
 * Over-excluding is recoverable through `release`; a duplicate on two live
 * posts is not.
 */
export function isUsed(
  ledger: UsageLedger,
  id: string,
  site: string,
  scope: 'site' | 'global',
): boolean {
  return ledger.records.some((r) => r.id === id && (scope === 'global' || r.site === site));
}

/** Record an upload. Returns a new ledger; the input is untouched. */
export function reserve(ledger: UsageLedger, rec: Omit<UsageRecord, 'state'>): UsageLedger {
  return { ...ledger, records: [...ledger.records, { ...rec, state: 'reserved' }] };
}

/**
 * Confirm every reservation whose hosted URL made it into a published post.
 *
 * Matching on the hosted URL rather than threading ids through `create_post` is
 * deliberate: the URL is what actually appears in the published HTML, so this
 * confirms what the platform really stored rather than what the caller intended
 * it to store.
 *
 * Already-published records are left alone, so re-running `update_post` on an
 * article does not rewrite the URL of the post that first published an asset.
 */
export function promote(
  ledger: UsageLedger,
  hostedUrls: string[],
  postUrl: string,
): { ledger: UsageLedger; promoted: number } {
  const wanted = new Set(hostedUrls);
  let promoted = 0;

  const records = ledger.records.map((r) => {
    if (r.state !== 'reserved' || !wanted.has(r.hosted_url)) return r;
    promoted += 1;
    return { ...r, state: 'published' as const, post_url: postUrl };
  });

  return { ledger: { ...ledger, records }, promoted };
}

/**
 * Clear a reservation that never became a post.
 *
 * Refuses to touch a `published` record. Releasing one would put an asset that
 * is live on a real page back into the unused pool, and the next article would
 * quietly reuse it.
 */
export function release(ledger: UsageLedger, id: string): { ledger: UsageLedger; released: number } {
  const kept = ledger.records.filter((r) => !(r.id === id && r.state === 'reserved'));
  return { ledger: { ...ledger, records: kept }, released: ledger.records.length - kept.length };
}

/**
 * Reservations that never became a post.
 *
 * Reported by `list_media_libraries` so an upload whose publish failed is
 * visible rather than a photograph that mysteriously stopped appearing in
 * search results.
 */
export function staleReservations(ledger: UsageLedger): UsageRecord[] {
  return ledger.records.filter((r) => r.state === 'reserved');
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/media/ledger.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media/ledger.ts tests/media/ledger.test.ts
git commit -m "feat(media): usage ledger operations

Reserved and published both count as used: once bytes are on the
platform, serving the asset again risks the same photo in two posts.
Over-excluding is recoverable through release; a duplicate on two live
posts is not.

promote matches on the hosted URL that actually appears in the published
HTML rather than on ids threaded through create_post, so it confirms what
the platform stored rather than what the caller intended. release refuses
published records outright."
```

---

### Task 6: Search ranking

**Files:**
- Create: `src/media/search.ts`
- Test: `tests/media/search.test.ts`

**Interfaces:**
- Consumes: `tokenise` from `src/media/scan.js`; types from Task 1.
- Produces: `searchAssets(assets: Asset[], q: SearchQuery): SearchHit[]`; `interface SearchQuery { query: string; kind?: MediaKind; aspect?: Aspect; hasPeople?: boolean; excludeIds?: Set<string>; limit?: number }`; `interface SearchHit { asset: Asset; score: number; why: { field: string; tokens: string[] }[] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/media/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { searchAssets } from '../../src/media/search.js';
import type { Asset } from '../../src/media/types.js';

function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    path: `${over.id}.png`,
    kind: 'image',
    mime: 'image/png',
    bytes: 100,
    width: 1920,
    height: 1080,
    aspect: '16:9',
    duration_s: null,
    captured_at: '2026-01-01T00:00:00.000Z',
    scanned_at: '2026-08-11T00:00:00.000Z',
    mtime_ms: 0,
    source: { filename_tokens: [], folder_tokens: [], captured_from: 'mtime' },
    ...over,
  } as Asset;
}

const KEYWORDED = asset({
  id: 'sha256:kw',
  enriched: {
    by: 'gemini',
    at: '2026-08-11T00:00:00.000Z',
    caption: 'people at a desk',
    keywords: ['standup', 'whiteboard'],
    look: 'flat',
    has_people: true,
    text_in_image: false,
  },
});

const FILENAMED = asset({
  id: 'sha256:fn',
  source: { filename_tokens: ['standup'], folder_tokens: [], captured_from: 'mtime' },
});

const FOLDERED = asset({
  id: 'sha256:fd',
  source: { filename_tokens: [], folder_tokens: ['standup'], captured_from: 'mtime' },
});

describe('searchAssets', () => {
  it('ranks a keyword match above a filename match above a folder match', () => {
    const hits = searchAssets([FOLDERED, FILENAMED, KEYWORDED], { query: 'standup' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:kw', 'sha256:fn', 'sha256:fd']);
  });

  it('names the matched field and tokens in why', () => {
    const [hit] = searchAssets([KEYWORDED], { query: 'standup' });
    expect(hit!.why).toContainEqual({ field: 'keywords', tokens: ['standup'] });
  });

  it('excludes assets that matched nothing', () => {
    expect(searchAssets([KEYWORDED], { query: 'submarine' })).toHaveLength(0);
  });

  it('returns everything, unranked, for an empty query', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], { query: '' });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it('filters by kind before ranking', () => {
    const video = asset({ id: 'sha256:v', kind: 'video', aspect: null });
    const hits = searchAssets([KEYWORDED, video], { query: '', kind: 'video' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:v']);
  });

  it('filters by aspect', () => {
    const square = asset({ id: 'sha256:sq', aspect: '1:1' });
    const hits = searchAssets([KEYWORDED, square], { query: '', aspect: '1:1' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:sq']);
  });

  it('filters by hasPeople, treating un-enriched assets as unknown and excluding them', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], { query: '', hasPeople: true });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:kw']);
  });

  it('excludes ids in excludeIds', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], {
      query: 'standup',
      excludeIds: new Set(['sha256:kw']),
    });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:fn']);
  });

  it('breaks ties on captured_at, most recent first', () => {
    const older = asset({ ...FILENAMED, id: 'sha256:old', captured_at: '2020-01-01T00:00:00.000Z' });
    const newer = asset({ ...FILENAMED, id: 'sha256:new', captured_at: '2026-06-01T00:00:00.000Z' });
    const hits = searchAssets([older, newer], { query: 'standup' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:new', 'sha256:old']);
  });

  it('honours limit', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED, FOLDERED], { query: 'standup', limit: 2 });
    expect(hits).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/search.test.ts`
Expected: FAIL — `Cannot find module '../../src/media/search.js'`

- [ ] **Step 3: Write `src/media/search.ts`**

```ts
import { tokenise } from './scan.js';
import type { Asset, Aspect, MediaKind } from './types.js';

export interface SearchQuery {
  query: string;
  kind?: MediaKind;
  aspect?: Aspect;
  hasPeople?: boolean;
  excludeIds?: Set<string>;
  limit?: number;
}

export interface SearchHit {
  asset: Asset;
  score: number;
  /** Which tokens matched where. Returned so a bad ranking is diagnosable. */
  why: { field: string; tokens: string[] }[];
}

/**
 * Field weights.
 *
 * Keywords outrank everything because a human or a vision model chose them for
 * this image. A folder name is the weakest signal in the set — it is shared by
 * every file beneath it, so it says the least about any one of them.
 */
const WEIGHTS: Record<string, number> = {
  keywords: 4,
  caption: 2,
  filename: 2,
  folder: 1,
};

function fieldsOf(asset: Asset): Record<string, string[]> {
  return {
    keywords: asset.enriched?.keywords.flatMap(tokenise) ?? [],
    caption: asset.enriched ? tokenise(asset.enriched.caption) : [],
    filename: asset.source.filename_tokens,
    folder: asset.source.folder_tokens,
  };
}

/**
 * Rank assets against a query. Deterministic, no embeddings, no network.
 *
 * An empty query is not an error — it means "everything matching the filters",
 * which is how a caller browses. Every hit then scores 0 and the order is the
 * tiebreak alone.
 */
export function searchAssets(assets: Asset[], q: SearchQuery): SearchHit[] {
  const wanted = tokenise(q.query);

  const candidates = assets.filter((a) => {
    if (q.kind && a.kind !== q.kind) return false;
    if (q.aspect && a.aspect !== q.aspect) return false;
    // An un-enriched asset has no answer for has_people. Excluding it is the
    // honest reading: the filter asked for a property nothing has established.
    if (q.hasPeople !== undefined && a.enriched?.has_people !== q.hasPeople) return false;
    if (q.excludeIds?.has(a.id)) return false;
    return true;
  });

  const hits: SearchHit[] = [];

  for (const asset of candidates) {
    if (wanted.length === 0) {
      hits.push({ asset, score: 0, why: [] });
      continue;
    }

    let score = 0;
    const why: { field: string; tokens: string[] }[] = [];

    for (const [field, tokens] of Object.entries(fieldsOf(asset))) {
      const present = new Set(tokens);
      const matched = wanted.filter((t) => present.has(t));
      if (matched.length === 0) continue;
      score += matched.length * WEIGHTS[field]!;
      why.push({ field, tokens: matched });
    }

    if (score > 0) hits.push({ asset, score, why });
  }

  hits.sort((a, b) => b.score - a.score || b.asset.captured_at.localeCompare(a.asset.captured_at));

  return q.limit ? hits.slice(0, q.limit) : hits;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/media/search.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media/search.ts tests/media/search.test.ts
git commit -m "feat(media): deterministic keyword ranking

Token overlap over keywords, caption, filename and folder, weighted in
that order -- a folder name is shared by every file beneath it, so it
says the least about any one of them. No embeddings: a vector store is a
dependency, a build step and a staleness problem for libraries that are
typically a few hundred files.

Every hit carries a why naming the matched tokens per field, so a poor
ranking is diagnosable instead of a score nobody can see into."
```

---

### Task 7: `list_media_libraries` and `find_media`

**Files:**
- Create: `src/tools/media-tools.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/media/media-tools.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `handler`/`json` from `src/tools/shared.js`; `ok` from `src/errors.js`.
- Produces: `type MediaCtx = Pick<Context, 'paths' | 'media'>`; `listMediaLibraries(ctx: MediaCtx, a)`; `findMedia(ctx: MediaCtx, a)`; `registerMediaTools(server: McpServer, ctx: Context): void`, and two live MCP tools.

**Ruling 1 applies:** both exported functions take `MediaCtx`, not `Context`. The test builds a plain object with `paths` and `media` and needs no cast — if that object is missing a field the function reads, `tsc` is not what catches it, so the narrow type is the only guard there is.

Read `src/tools/site-tools.ts` first for the exact `registerTool` call shape used in this repo.

- [ ] **Step 1: Write the failing test**

Create `tests/media/media-tools.test.ts`. Call the exported helpers directly rather than driving the MCP layer — but assert the returned SHAPE, because the MCP SDK silently strips keys an input schema does not declare and a handler test cannot see that.

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMedia, listMediaLibraries } from '../../src/tools/media-tools.js';
import type { MediaCtx } from '../../src/tools/media-tools.js';
import { loadMedia } from '../../src/media/library.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(files: string[]): MediaCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-home-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  for (const rel of files) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), PNG_1x1);
  }
  const configFile = join(home, 'config.yaml');
  writeFileSync(configFile, `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${root}\n`);

  // No cast. If this object is missing something the functions read, the
  // narrow MediaCtx is the only thing that will say so — tests are not typechecked.
  return { paths: { home }, media: loadMedia(configFile, {}) };
}

describe('listMediaLibraries', () => {
  it('reports zero assets before a scan and says the index is missing', async () => {
    const out = await listMediaLibraries(ctxWith(['a.png']), {});
    expect(out.libraries[0]!.name).toBe('shots');
    expect(out.libraries[0]!.scanned).toBe(false);
    expect(out.libraries[0]!.assets).toBe(0);
  });

  it('reports counts after a scan', async () => {
    const ctx = ctxWith(['a.png', 'b/c.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await listMediaLibraries(ctx, {});
    expect(out.libraries[0]!.scanned).toBe(true);
    expect(out.libraries[0]!.assets).toBe(2);
    expect(out.libraries[0]!.unused).toBe(2);
    expect(out.libraries[0]!.stale_reservations).toBe(0);
  });

  it('lists an unavailable library with its reason rather than omitting it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bl-home-'));
    const configFile = join(home, 'config.yaml');
    writeFileSync(configFile, 'sites: {}\nmedia:\n  libraries:\n    - name: gone\n      path: /nope\n');
    const ctx: MediaCtx = { paths: { home }, media: loadMedia(configFile, {}) };
    const out = await listMediaLibraries(ctx, {});
    expect(out.libraries[0]!.unavailable).toMatch(/does not exist/i);
  });
});

describe('findMedia', () => {
  it('finds by filename token and reports why', async () => {
    const ctx = ctxWith(['portraits/team-standup.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: 'standup' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.path).toBe('portraits/team-standup.png');
    expect(out.results[0]!.local_path).toContain('portraits/team-standup.png');
    expect(out.results[0]!.why[0]!.field).toBe('filename');
  });

  it('reports the library as un-enriched so weak results are explained', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: '' });
    expect(out.enriched).toBe(false);
    expect(out.note).toMatch(/enrich/i);
  });

  it('refuses with a hint when the library has never been scanned', async () => {
    const ctx = ctxWith(['a.png']);
    await expect(findMedia(ctx, { query: 'x' })).rejects.toThrow(/scan/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/media-tools.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/media-tools.js'`

- [ ] **Step 3: Write `src/tools/media-tools.ts`**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { getLibrary, indexFileFor, ledgerFileFor } from '../media/library.js';
import { staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { searchAssets } from '../media/search.js';
import { readIndex, readLedger, writeIndex } from '../media/store.js';
import type { LibraryConfig, MediaConfig, MediaIndex } from '../media/types.js';
import type { Paths } from '../config/paths.js';
import type { SitesConfig } from '../config/sites.js';
import { handler } from './shared.js';

/**
 * Exactly what the read-only media tools touch.
 *
 * Declared field by field rather than as `Context`, because test files are NOT
 * typechecked in this repo: a test that casts a small object to `Context` keeps
 * passing on the day a function starts reading a field that object never had.
 * A real `Context` satisfies this structurally, so production callers are
 * unchanged, and a test builds `{ paths: { home }, media }` with no cast.
 */
export interface MediaCtx {
  paths: Pick<Paths, 'home'>;
  media: MediaConfig;
}

/** …plus sites, for the tools that upload. */
export interface UploadCtx extends MediaCtx {
  sites: SitesConfig;
}

/** The index for a library, refusing with a fix rather than returning nothing. */
function requireIndex(ctx: Context, lib: LibraryConfig): MediaIndex {
  const index = readIndex(indexFileFor(lib, ctx.paths.home));
  if (!index) {
    throw new ToolError({
      api: 'media',
      code: 'NOT_SCANNED',
      message: `Media library "${lib.name}" has not been scanned yet.`,
      hint: 'Call list_media_libraries with scan: true, or run `byline media scan`.',
    });
  }
  return index;
}

export async function listMediaLibraries(
  ctx: MediaCtx,
  a: { scan?: boolean; library?: string },
): Promise<{
  libraries: {
    name: string;
    path: string;
    scanned: boolean;
    scanned_at?: string;
    assets: number;
    images: number;
    videos: number;
    enriched: number;
    unused: number;
    stale_reservations: number;
    unavailable?: string;
  }[];
  reuse_scope: 'site' | 'global';
  default_library?: string;
}> {
  const names = a.library ? [a.library] : Object.keys(ctx.media.libraries);

  const libraries = names.map((name) => {
    const lib = ctx.media.libraries[name];
    if (!lib) {
      return {
        name,
        path: '',
        scanned: false,
        assets: 0,
        images: 0,
        videos: 0,
        enriched: 0,
        unused: 0,
        stale_reservations: 0,
        unavailable: `No media library named "${name}".`,
      };
    }
    if (lib.unavailable) {
      return {
        name,
        path: lib.path,
        scanned: false,
        assets: 0,
        images: 0,
        videos: 0,
        enriched: 0,
        unused: 0,
        stale_reservations: 0,
        unavailable: lib.unavailable,
      };
    }

    const indexFile = indexFileFor(lib, ctx.paths.home);
    let index = readIndex(indexFile);

    if (a.scan) {
      index = scanLibrary(lib, index);
      writeIndex(indexFile, index);
    }

    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), lib.name);
    const usedIds = new Set(ledger.records.map((r) => r.id));
    const assets = index?.assets ?? [];

    return {
      name,
      path: lib.path,
      scanned: index !== null,
      ...(index ? { scanned_at: index.scanned_at } : {}),
      assets: assets.length,
      images: assets.filter((x) => x.kind === 'image').length,
      videos: assets.filter((x) => x.kind === 'video').length,
      enriched: assets.filter((x) => x.enriched).length,
      unused: assets.filter((x) => !usedIds.has(x.id)).length,
      stale_reservations: staleReservations(ledger).length,
    };
  });

  return {
    libraries,
    reuse_scope: ctx.media.reuseScope,
    ...(ctx.media.defaultLibrary ? { default_library: ctx.media.defaultLibrary } : {}),
  };
}

export async function findMedia(
  ctx: MediaCtx,
  a: {
    query: string;
    library?: string;
    kind?: 'image' | 'video';
    aspect?: '16:9' | '4:3' | '1:1';
    has_people?: boolean;
    unused_only?: boolean;
    site?: string;
    limit?: number;
  },
): Promise<{
  library: string;
  enriched: boolean;
  results: {
    id: string;
    path: string;
    local_path: string;
    kind: string;
    mime: string;
    width: number | null;
    height: number | null;
    aspect: string | null;
    caption?: string;
    keywords?: string[];
    score: number;
    why: { field: string; tokens: string[] }[];
  }[];
  note?: string;
}> {
  const lib = getLibrary(ctx.media, a.library);
  const index = requireIndex(ctx, lib);
  const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), lib.name);

  const unusedOnly = a.unused_only !== false;
  const site = a.site ?? '';
  const excludeIds = unusedOnly
    ? new Set(
        ledger.records
          .filter((r) => ctx.media.reuseScope === 'global' || r.site === site)
          .map((r) => r.id),
      )
    : undefined;

  const hits = searchAssets(index.assets, {
    query: a.query,
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.aspect ? { aspect: a.aspect } : {}),
    ...(a.has_people !== undefined ? { hasPeople: a.has_people } : {}),
    ...(excludeIds ? { excludeIds } : {}),
    limit: a.limit ?? 10,
  });

  const enrichedCount = index.assets.filter((x) => x.enriched).length;
  const enriched = enrichedCount > 0;

  return {
    library: lib.name,
    enriched,
    results: hits.map((h) => ({
      id: h.asset.id,
      path: h.asset.path,
      local_path: join(lib.path, h.asset.path),
      kind: h.asset.kind,
      mime: h.asset.mime,
      width: h.asset.width,
      height: h.asset.height,
      aspect: h.asset.aspect,
      ...(h.asset.enriched ? { caption: h.asset.enriched.caption } : {}),
      ...(h.asset.enriched ? { keywords: h.asset.enriched.keywords } : {}),
      score: h.score,
      why: h.why,
    })),
    ...(enriched
      ? {}
      : {
          note: 'No asset in this library has been enriched, so matching used filenames and folder names only. Run `byline media enrich` for keywords and captions.',
        }),
  };
}

export function registerMediaTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_media_libraries',
    {
      title: 'List media libraries',
      description:
        'List the local media libraries byline is configured to use, with asset counts, how many are still unused, and whether the index is up to date. Pass scan: true to walk the folder and rebuild the index first — that is how a new or changed library becomes searchable. Byline never writes inside your library folder.',
      inputSchema: {
        library: z.string().optional().describe('Limit to one library. Omit for all of them.'),
        scan: z
          .boolean()
          .default(false)
          .describe('Walk the folder and rebuild the index before reporting.'),
      },
    },
    handler('list_media_libraries', (a: { library?: string; scan?: boolean }) =>
      listMediaLibraries(ctx, a).then(ok),
    ),
  );

  server.registerTool(
    'find_media',
    {
      title: 'Find local media',
      description:
        'Search a local media library by keyword and get back ranked candidates with their local paths, ready to pass to use_media. Excludes anything already used by default. Each result carries a `why` naming the tokens that matched, so you can judge the match rather than trust the score. Requires a scan first — call list_media_libraries with scan: true if this refuses.',
      inputSchema: {
        query: z
          .string()
          .describe('What the image should show, in plain words. An empty string browses everything matching the filters.'),
        library: z.string().optional().describe('Which library. Defaults to the configured default.'),
        kind: z.enum(['image', 'video']).optional(),
        aspect: z.enum(['16:9', '4:3', '1:1']).optional(),
        has_people: z
          .boolean()
          .optional()
          .describe('Only assets known to contain people, or known not to. Un-enriched assets are excluded either way, because nothing has established it for them.'),
        unused_only: z
          .boolean()
          .default(true)
          .describe('Exclude assets already used. Defaults true — this is what stops the same photo appearing in two posts.'),
        site: z
          .string()
          .optional()
          .describe('The site this is for. Decides what counts as already used when reuse_scope is "site".'),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    handler('find_media', (a: Parameters<typeof findMedia>[1]) => findMedia(ctx, a).then(ok)),
  );
}
```

- [ ] **Step 4: Register the tools in `src/tools/index.ts`**

Add the import beside the others:

```ts
import { registerMediaTools } from './media-tools.js';
```

And call it inside `registerAllTools`, after `registerResearchTools` and before `registerCraftTools` — media is discovery, and discovery precedes the brief that consumes it:

```ts
  registerMediaTools(server, ctx); // discovery, like research: precedes the brief
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/media/ && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 6: Verify the tools are really registered — through the MCP layer, not a handler call**

A handler test cannot see the SDK stripping an undeclared input key, which is exactly how `feature_image_id` shipped doing nothing.

Run:

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node bin/byline.js | grep -o '"name":"[a-z_]*"'
```

Expected: the output includes `"name":"list_media_libraries"` and `"name":"find_media"` alongside the existing sixteen.

- [ ] **Step 7: Commit**

```bash
git add src/tools/media-tools.ts src/tools/index.ts tests/media/media-tools.test.ts
git commit -m "feat(media): list_media_libraries and find_media tools

find_media excludes used assets by default and returns a why naming the
tokens that matched, so the calling model judges the match instead of
trusting an invisible score. An un-enriched library says so in the
result rather than quietly returning weak filename matches.

An unscanned library refuses with the command that fixes it. An
unavailable library is listed WITH its reason rather than omitted --
a library that silently vanishes from the list is a worse bug than one
that reports why it is broken."
```

---

### Task 8: `use_media` and publish promotion

**Files:**
- Modify: `src/tools/media-tools.ts`
- Modify: `src/tools/post-tools.ts`
- Test: `tests/media/use-media.test.ts`

**Interfaces:**
- Consumes: `reserve`/`promote` from `src/media/ledger.js`; `adapterFor` from `src/tools/shared.js`.
- Produces: `type UploadCtx = Pick<Context, 'paths' | 'media' | 'sites'>`; `useMedia(ctx: UploadCtx, a)`; `promoteUsedMedia(ctx: MediaCtx, hostedUrls: string[], postUrl: string): { promoted: number; problems: string[] }` — called by `create_post` and `update_post`.

**Both rulings apply here.** `useMedia` takes `UploadCtx`, which means widening `adapterFor` in `src/tools/shared.ts` to `ctx: Pick<Context, 'sites'>` — a one-line change that every existing caller still satisfies. And `promoteUsedMedia` returns `problems` rather than swallowing anything.

In `src/tools/post-tools.ts` the published URL is `result.url` — `result` is the `PostResult` returned by `adapter.createPost` (`src/tools/post-tools.ts:280`) and by `adapter.updatePost` (`:434`). `PostResult.url` is a required `string` (`src/plugins/platforms/types.ts:128`), so it needs no guard.

- [ ] **Step 1: Write the failing test**

Create `tests/media/use-media.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listMediaLibraries, useMedia } from '../../src/tools/media-tools.js';
import { promoteUsedMedia } from '../../src/tools/media-tools.js';
import { readLedger } from '../../src/media/store.js';
import { ledgerFileFor } from '../../src/media/library.js';
import { loadMedia } from '../../src/media/library.js';
import type { UploadCtx } from '../../src/tools/media-tools.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(): UploadCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-use-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.png'), PNG_1x1);
  const configFile = join(home, 'config.yaml');
  writeFileSync(configFile, `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${root}\n`);
  return { paths: { home }, media: loadMedia(configFile, {}), sites: { sites: {} } };
}

/** Stand in for the platform adapter. Asserted at runtime, since tests are not typechecked. */
const uploadImage = vi.fn(async (_f: Buffer, name: string) => ({
  url: `https://blog.example.com/content/${name}`,
  id: '42',
}));

vi.mock('../../src/tools/shared.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/shared.js')>()),
  adapterFor: () => ({ uploadImage }),
}));

describe('useMedia', () => {
  it('uploads and reserves the asset', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png', alt: 'a dot' }] });

    expect(out.uploaded).toBe(1);
    expect(out.images[0]!.ok).toBe(true);
    expect(out.images[0]!.url).toMatch(/^https:\/\//);
    expect(typeof out.images[0]!.id).toBe('string');

    const lib = ctx.media.libraries.shots!;
    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots');
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]!.state).toBe('reserved');
    expect(ledger.records[0]!.site).toBe('personal');
  });

  it('refuses an asset that is not in the index', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    await expect(
      useMedia(ctx, { site: 'personal', assets: [{ path: 'ghost.png' }] }),
    ).rejects.toThrow(/not in the index/i);
  });

  it('reports one failure per asset without failing the batch', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    uploadImage.mockRejectedValueOnce(new Error('boom'));
    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    expect(out.failed).toBe(1);
    expect(out.images[0]!.ok).toBe(false);
    const lib = ctx.media.libraries.shots!;
    // A failed upload must NOT be reserved -- nothing reached the platform.
    expect(readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots').records).toHaveLength(0);
  });
});

describe('promoteUsedMedia', () => {
  it('promotes a reservation whose url appears in the published post', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const used = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    const url = used.images[0]!.url!;

    const { promoted } = promoteUsedMedia(ctx, [url], 'https://blog.example.com/post/');
    expect(promoted).toBe(1);

    const lib = ctx.media.libraries.shots!;
    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots');
    expect(ledger.records[0]!.state).toBe('published');
  });

  it('promotes nothing and throws nothing when no media was used', () => {
    const ctx = ctxWith();
    expect(promoteUsedMedia(ctx, ['https://blog/x.png'], 'https://blog/post/')).toEqual({
      promoted: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/use-media.test.ts`
Expected: FAIL — `useMedia is not a function`.

- [ ] **Step 3: Add `useMedia` and `promoteUsedMedia` to `src/tools/media-tools.ts`**

Add these imports at the top of the file:

```ts
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { promote, reserve } from '../media/ledger.js';
import { writeLedger } from '../media/store.js';
import { adapterFor } from './shared.js';
```

Then append:

```ts
export async function useMedia(
  ctx: UploadCtx,
  a: {
    site: string;
    library?: string;
    assets: { path: string; alt?: string }[];
  },
): Promise<{
  library: string;
  images: { ok: boolean; path: string; url?: string; id?: string; error?: string }[];
  uploaded: number;
  failed: number;
}> {
  const lib = getLibrary(ctx.media, a.library);
  const index = requireIndex(ctx, lib);
  const adapter = adapterFor(ctx, a.site);
  const ledgerFile = ledgerFileFor(lib, ctx.paths.home);

  const byPath = new Map(index.assets.map((x) => [x.path, x]));

  // Resolve EVERY asset before uploading anything. A batch that uploads two
  // files and then discovers the third is a typo has already spent two
  // reservations on an article that will not be written.
  const resolved = a.assets.map((want) => {
    const asset = byPath.get(want.path);
    if (!asset) {
      throw new ToolError({
        api: 'media',
        code: 'ASSET_NOT_FOUND',
        message: `"${want.path}" is not in the index for media library "${lib.name}".`,
        hint: 'Use the `path` exactly as find_media returned it, or rescan if the file is new.',
      });
    }
    return { asset, alt: want.alt };
  });

  const images: { ok: boolean; path: string; url?: string; id?: string; error?: string }[] = [];
  let ledger = readLedger(ledgerFile, lib.name);

  for (const { asset, alt } of resolved) {
    const full = join(lib.path, asset.path);
    try {
      const bytes = readFileSync(full);
      const uploaded = await adapter.uploadImage(bytes, basename(asset.path), alt);
      images.push({
        ok: true,
        path: asset.path,
        url: uploaded.url,
        ...(uploaded.id ? { id: uploaded.id } : {}),
      });
      // Reserved only AFTER the bytes reached the platform. Reserving a failed
      // upload would retire a photograph that was never published.
      ledger = reserve(ledger, {
        id: asset.id,
        site: a.site,
        hosted_url: uploaded.url,
        at: new Date().toISOString(),
      });
    } catch (e) {
      images.push({
        ok: false,
        path: asset.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  writeLedger(ledgerFile, ledger);

  const failed = images.filter((i) => !i.ok).length;
  return { library: lib.name, images, uploaded: images.length - failed, failed };
}

/**
 * Confirm reservations that made it into a published post.
 *
 * Called by `create_post` and `update_post`. Never throws: a publish that
 * succeeded must not be reported as failed because a ledger write did, so a
 * problem here is returned as a count of zero and the post stands.
 */
export function promoteUsedMedia(
  ctx: MediaCtx,
  hostedUrls: string[],
  postUrl: string,
): { promoted: number; problems: string[] } {
  let total = 0;
  const problems: string[] = [];

  for (const lib of Object.values(ctx.media.libraries)) {
    if (lib.unavailable) continue;
    const file = ledgerFileFor(lib, ctx.paths.home);
    try {
      const before = readLedger(file, lib.name);
      const { ledger, promoted } = promote(before, hostedUrls, postUrl);
      if (promoted > 0) {
        writeLedger(file, ledger);
        total += promoted;
      }
    } catch (e) {
      // Never rethrown: the post is already live, and failing the tool now
      // would report a successful publish as a failure. Never swallowed
      // either — the caller folds this into the warnings it already returns,
      // so a ledger that stopped recording is visible the moment it happens.
      problems.push(
        `Could not update the usage ledger for media library "${lib.name}": ${
          e instanceof Error ? e.message : String(e)
        }. The post published fine, but this asset may be offered again. Run \`byline media status\` to check.`,
      );
    }
  }

  return { promoted: total, problems };
}
```

Register the tool inside `registerMediaTools`:

```ts
  server.registerTool(
    'use_media',
    {
      title: 'Use local media',
      description:
        'Upload one or more local library assets to a site and record them as used, so the same file is never published twice. Pass the `path` values exactly as find_media returned them. Returns the hosted URL for each, ready for feature_image or an inline <img>. One failure does not fail the batch — check every entry.',
      inputSchema: {
        site: z.string().describe('Which site to upload to.'),
        library: z.string().optional().describe('Which library. Defaults to the configured default.'),
        assets: z
          .array(
            z.object({
              path: z.string().describe('The `path` from a find_media result, not an absolute path.'),
              alt: z.string().optional().describe('Alt text describing what is visible in the frame.'),
            }),
          )
          .min(1)
          .max(12),
      },
    },
    handler('use_media', (a: Parameters<typeof useMedia>[1]) => useMedia(ctx, a).then(ok)),
  );
```

- [ ] **Step 4: Call `promoteUsedMedia` from `src/tools/post-tools.ts`**

Import it:

```ts
import { promoteUsedMedia } from './media-tools.js';
```

In the `create_post` handler, after the post is created and its URL is known, and before the result is returned, collect every hosted URL the article actually references and promote:

```ts
      // Confirm any library assets this post really published. The hosted URL
      // is what appears in the stored HTML, so this records what the platform
      // kept rather than what the caller intended it to keep.
      const referenced = [
        ...(a.feature_image ? [a.feature_image] : []),
        ...[...a.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
      ];
      const promotion = promoteUsedMedia(ctx, referenced, result.url);
```

Then add `promotion.problems` to the existing `warnings` array — that array is already the channel for "the publish worked, but something about it did not":

```ts
        const warnings = [...localWarnings, ...(result.warnings ?? []), ...promotion.problems];
```

Apply the identical pair of changes in the `update_post` handler. `update_post` takes a partial patch, so guard the HTML scan there with `a.html ? [...a.html.matchAll(…)].map(…) : []` rather than assuming `html` is present. Check whether `update_post` already builds a `warnings` array; if it returns `result` directly, add one rather than dropping the problems.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/media/ && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 6: Verify `use_media` is registered through the MCP layer**

```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node bin/byline.js | grep -c '"name":"use_media"'
```

Expected: `1`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/media-tools.ts src/tools/post-tools.ts tests/media/use-media.test.ts
git commit -m "feat(media): use_media, and promotion on publish

Assets are resolved before anything uploads, so a typo in the third path
does not spend reservations on the first two. A reservation is written
only after the bytes reach the platform -- reserving a failed upload
would retire a photograph that was never published.

create_post and update_post promote reservations whose hosted URL appears
in the article. promoteUsedMedia never throws: the post is already live,
and failing the tool afterwards would report a successful publish as a
failure. A stuck reservation is visible in list_media_libraries instead."
```

---

### Task 9: Live integration test against a real site

**Files:**
- Create: `tests/integration/media.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing. This task exists to prove the tools work through a real platform, which no unit test in this plan can.

Every defect in `CONTEXT.md` passed its unit tests. This is the test that would have caught them.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/media.integration.test.ts`. Read `tests/integration/ghost.integration.test.ts` first and copy its skip-with-a-named-reason pattern and its self-cleaning teardown exactly.

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';
import { loadMedia } from '../../src/media/library.js';
import { listMediaLibraries, findMedia, useMedia } from '../../src/tools/media-tools.js';
import type { UploadCtx } from '../../src/tools/media-tools.js';

const SITE = 'personal';
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('media library against a live site', () => {
  const ctx = loadContext();
  const configured = Boolean(ctx.sites.sites[SITE] && !ctx.sites.sites[SITE]?.unavailable);

  it.skipIf(!configured)(
    `uploads a library asset to "${SITE}" and reads the hosted URL back`,
    async () => {
      // A real library folder, in a temp dir, with a real PNG in it.
      const root = mkdtempSync(join(tmpdir(), 'bl-int-'));
      mkdirSync(join(root, 'probe'), { recursive: true });
      writeFileSync(join(root, 'probe', 'byline-integration-dot.png'), PNG_1x1);

      const home = mkdtempSync(join(tmpdir(), 'bl-int-home-'));
      writeFileSync(
        join(home, 'config.yaml'),
        `sites: {}\nmedia:\n  libraries:\n    - name: probe\n      path: ${root}\n`,
      );

      // Real sites from the real config; a temp home so the index and ledger
      // land in scratch rather than the user's ~/.byline.
      const mediaCtx: UploadCtx = {
        paths: { home },
        media: loadMedia(join(home, 'config.yaml'), process.env),
        sites: ctx.sites,
      };

      await listMediaLibraries(mediaCtx, { scan: true });

      const found = await findMedia(mediaCtx, { query: 'dot', library: 'probe' });
      expect(found.results).toHaveLength(1);

      const used = await useMedia(mediaCtx, {
        site: SITE,
        library: 'probe',
        assets: [{ path: found.results[0]!.path, alt: 'a single dark pixel' }],
      });

      expect(used.failed).toBe(0);
      const url = used.images[0]!.url!;
      expect(url).toMatch(/^https:\/\//);

      // READ IT BACK. An upload that reports success and serves nothing is the
      // failure mode this whole test exists for.
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^image\//);

      // The asset must now be excluded from search for this site.
      const after = await findMedia(mediaCtx, { query: 'dot', library: 'probe', site: SITE });
      expect(after.results).toHaveLength(0);
    },
  );
});
```

- [ ] **Step 2: Run it against a real site**

Run: `RUN_INTEGRATION=1 npx vitest run tests/integration/media.integration.test.ts`
Expected: PASS, or a named skip if no `personal` site is configured.

**If it skips, the task is not done.** Configure a site or say plainly that this was never verified. A skipped integration test proves nothing, and reporting it as green is the exact dishonesty `CLAUDE.md` was written about.

- [ ] **Step 3: Confirm the unit suite is still green and the floor rose**

Run: `npm test`
Expected: PASS, with a total above the 684 floor recorded in `CLAUDE.md`.

- [ ] **Step 4: Update the test floor in `CLAUDE.md`**

Change the stated floor to the new passing count. It is stated in exactly one place; do not add a second copy.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/media.integration.test.ts CLAUDE.md
git commit -m "test(media): live integration test for the library round trip

Scans a real folder, searches it, uploads through a real platform
adapter, and fetches the hosted URL back to prove the bytes are actually
served. Every defect in CONTEXT.md passed its unit tests; only a
read-back catches an upload that reports success and serves nothing.

Also asserts the asset disappears from search for that site afterwards,
which is the whole point of the ledger."
```

---

## What this plan does NOT build

Named so nobody assumes otherwise:

- **No CLI.** `byline media add/scan/enrich/status/release` is Plan 2. In this plan a library is added by hand-editing `config.yaml`, and scanning happens through `list_media_libraries` with `scan: true`.
- **No enrichment.** No captions, no keywords, no `look`. Search runs on filenames and folder names, and `find_media` says so in its result.
- **No EXIF.** `captured_at` is the file mtime, and `source.captured_from` records that.
- **No staleness reporting on `find_media`.** The spec has it report `stale: true` when files
  changed since the last scan; detecting that honestly costs a full tree walk, which is most
  of a scan. Plan 2 either does the walk or drops the promise — it must not ship as a field
  hardcoded to `false`, which would state a fact nothing checked.
- **No aspect fitting.** Plan 2.
- **No `reference` / `reference_mode` on the generate tools.** Plan 2.
- **No `media` parameter on `build_writing_brief`.** Plan 2, so "use only local images" is not yet enforceable — a caller must simply choose to call `find_media`.
- **No video upload.** `use_media` calls `uploadImage`, which is image-only. Video assets are indexed and searchable but cannot be published. Plan 3.
