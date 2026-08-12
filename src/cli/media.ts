import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { intro, outro } from '@clack/prompts';
import { addLibraryToConfig, removeLibraryFromConfig } from '../config/media-block.js';
import { SLUG_PATTERN, SLUG_RULE } from '../config/sites.js';
import { loadContext } from '../context.js';
import { ToolError } from '../errors.js';
import { getLibrary, indexFileFor, ledgerFileFor, libraryNamed } from '../media/library.js';
import { release, staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { readIndex, readLedger, writeIndex, writeLedger } from '../media/store.js';
import type { LibraryConfig, MediaConfig } from '../media/types.js';
import { attention, check, detail, fail, info, section } from './tree.js';

/**
 * `media` — the CLI surface over `src/media/`: add, list, scan, status,
 * release, remove.
 *
 * A generic surface over the library/index/ledger primitives in `src/media/`.
 * No platform, provider, or specific library is named anywhere here — the
 * `src/cli/` rule in CLAUDE.md. Every command that writes `config.yaml`
 * prints `RESTART_NOTICE`: `loadContext()` reads config once at MCP server
 * startup, so a library added here is invisible to an already-running server
 * until the AI tool is restarted. Before this command existed, adopting the
 * media library meant hand-editing config.yaml directly — severe enough that
 * drafting a real article abandoned the library mid-flow.
 */

const RESTART_NOTICE =
  'A running MCP server only reads config.yaml at startup, so this change is invisible there until you restart your AI tool.';

const USAGE: Array<[string, string]> = [
  ['add <folder> [--name <slug>] [--no-recursive] [--default]', 'Add a library and scan it immediately'],
  ['list', 'Every configured library, with asset counts'],
  ['scan [<name>]', 'Rescan a library (or every library) and report what changed'],
  ['status', 'Like list, plus index/ledger file locations and stale reservations'],
  ['release <id> [--library <name>]', 'Clear a reservation stuck by a failed publish'],
  ['remove <name> [--yes]', 'Forget a library (the folder itself is left alone)'],
];

function printUsage(): void {
  section('media   (usage: byline media <command> [...args])');
  for (const [cmd, text] of USAGE) detail(`${cmd}\n  ${text}`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function expandHome(raw: string): string {
  const home = homedir();
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/** Absolute, `~` expanded, relative resolved against cwd — never left ambiguous. */
function resolveFolder(raw: string): string {
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Lowercase the folder's basename, collapse non-alphanumeric runs to `-`,
 * trim leading/trailing `-`.
 *
 * May not satisfy `SLUG_PATTERN` (a folder named only in symbols, or one
 * whose collapse leaves nothing). The caller checks the result against
 * `SLUG_PATTERN` and refuses rather than inventing a fallback name — a name
 * the user did not choose is exactly what this derivation exists to avoid
 * doing silently.
 */
function deriveName(folderPath: string): string {
  return basename(folderPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assetCounts(assets: { kind: string }[]): string {
  const images = assets.filter((a) => a.kind === 'image').length;
  const videos = assets.filter((a) => a.kind === 'video').length;
  return `${assets.length} asset${assets.length === 1 ? '' : 's'} (${images} image${images === 1 ? '' : 's'}, ${videos} video${videos === 1 ? '' : 's'})`;
}

async function runAdd(args: string[]): Promise<void> {
  intro('byline — media add');
  const [rawPath, ...rest] = args;

  if (!rawPath) {
    fail('Usage: byline media add <folder> [--name <slug>] [--no-recursive] [--default]');
    process.exitCode = 1;
    outro('Nothing added.');
    return;
  }

  const path = resolveFolder(rawPath);
  let name = flagValue(rest, '--name');
  if (!name) {
    const derived = deriveName(path);
    if (!SLUG_PATTERN.test(derived)) {
      fail(`Could not derive a usable library name from "${basename(path)}". ${SLUG_RULE}`);
      info('Pass --name with a name of your choosing.');
      process.exitCode = 1;
      outro('Nothing added.');
      return;
    }
    name = derived;
  }

  const recursive = !rest.includes('--no-recursive');
  const ctx = loadContext();

  // Existence/directory-ness and the SLUG_PATTERN check on an EXPLICIT --name
  // are validated by addLibraryToConfig itself (src/config/media-block.ts) —
  // the one writer of a media.libraries entry. Re-checking either here would
  // be a second hand-maintained copy of a rule that already lives there.
  const { warnings } = addLibraryToConfig(ctx.paths.configFile, {
    name,
    path,
    ...(recursive ? {} : { recursive: false }),
    ...(rest.includes('--default') ? { setDefault: true } : {}),
  });

  section(`library "${name}"`);
  detail(path);
  for (const w of warnings) attention(w);

  // Scans immediately: one command makes the folder usable, not two. This is
  // the entire point of the plan — hand-editing config.yaml and restarting
  // used to be step one of two.
  const lib: LibraryConfig = { name, path, recursive };
  const index = scanLibrary(lib, null);
  writeIndex(indexFileFor(lib, ctx.paths.home), index);
  check(true, `Scanned: ${assetCounts(index.assets)}.`);

  attention(RESTART_NOTICE);
  outro(`Added "${name}".`);
}

function printLibraryList(media: MediaConfig, bylineHome: string): void {
  const names = Object.keys(media.libraries);
  section('media libraries');
  if (names.length === 0) {
    detail('none configured — run `byline media add <folder>`');
    return;
  }
  for (const name of names) {
    // Always present: `name` came from Object.keys(media.libraries) itself.
    const lib = libraryNamed(media.libraries, name)!;
    if (lib.unavailable) {
      check(false, name);
      detail(`  ${lib.unavailable}`);
      continue;
    }
    const index = readIndex(indexFileFor(lib, bylineHome));
    check(true, `${name}   ${lib.path}`);
    detail(
      index
        ? `  ${assetCounts(index.assets)}, scanned ${index.scanned_at}`
        : `  not scanned yet — run \`byline media scan ${name}\``,
    );
  }
}

async function runList(_args: string[]): Promise<void> {
  intro('byline — media list');
  const ctx = loadContext();
  printLibraryList(ctx.media, ctx.paths.home);
  outro('`byline media add <folder>` to add another.');
}

async function runScan(args: string[]): Promise<void> {
  intro('byline — media scan');
  const ctx = loadContext();
  const explicit = args[0];
  const names = explicit ? [explicit] : Object.keys(ctx.media.libraries);

  section('media scan');
  if (names.length === 0) {
    detail('none configured — run `byline media add <folder>`');
    outro('Nothing to scan.');
    return;
  }

  for (const name of names) {
    try {
      // getLibrary refuses an unknown name or an unavailable library with a
      // real message+hint, rather than a bare lookup miss.
      const lib = getLibrary(ctx.media, name);
      const indexFile = indexFileFor(lib, ctx.paths.home);
      const previous = readIndex(indexFile);
      const next = scanLibrary(lib, previous);
      writeIndex(indexFile, next);

      const prevPaths = new Set((previous?.assets ?? []).map((a) => a.path));
      const nextPaths = new Set(next.assets.map((a) => a.path));
      const added = [...nextPaths].filter((p) => !prevPaths.has(p)).length;
      const removed = [...prevPaths].filter((p) => !nextPaths.has(p)).length;
      const unchanged = next.assets.length - added;

      check(
        true,
        `${name}   ${added} added, ${removed} removed, ${unchanged} unchanged (${next.assets.length} total)`,
      );
    } catch (e) {
      // One broken library must not stop the rest of a whole-library scan
      // from being reported.
      check(false, `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  outro('Scan complete.');
}

async function runStatus(_args: string[]): Promise<void> {
  intro('byline — media status');
  const ctx = loadContext();
  printLibraryList(ctx.media, ctx.paths.home);

  const names = Object.keys(ctx.media.libraries);
  if (names.length > 0) section('files and reservations');
  for (const name of names) {
    const lib = libraryNamed(ctx.media.libraries, name)!;
    const indexFile = indexFileFor(lib, ctx.paths.home);
    const ledgerFile = ledgerFileFor(lib, ctx.paths.home);
    detail(`${name}   index: ${indexFile}`);
    detail(`${name.replace(/./g, ' ')}   ledger: ${ledgerFile}`);
    if (lib.unavailable) continue;
    try {
      const stale = staleReservations(readLedger(ledgerFile, name));
      if (stale.length > 0) {
        attention(
          `${name}: ${stale.length} stale reservation(s) — run \`byline media release <id> --library ${name}\` to clear one.`,
        );
      } else {
        detail(`${name}   0 stale reservations`);
      }
    } catch (e) {
      attention(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  outro('`byline media release <id>` clears a reservation stuck by a failed publish.');
}

async function runRelease(args: string[]): Promise<void> {
  intro('byline — media release');
  const id = args[0];
  const libraryName = flagValue(args, '--library');

  if (!id) {
    fail('Usage: byline media release <id> [--library <name>]');
    process.exitCode = 1;
    outro('Nothing released.');
    return;
  }

  const ctx = loadContext();
  const lib = getLibrary(ctx.media, libraryName);
  const ledgerFile = ledgerFileFor(lib, ctx.paths.home);
  const ledger = readLedger(ledgerFile, lib.name);
  const { ledger: next, released } = release(ledger, id);

  section(`library "${lib.name}"`);
  if (released === 0) {
    detail(
      `No reserved record for "${id}" was found — nothing changed. A "published" record is never released this way; release only clears a reservation that never became a post.`,
    );
    outro('Nothing released.');
    return;
  }

  writeLedger(ledgerFile, next);
  check(true, `Released ${released} reservation(s) for "${id}". It is free for use_media again.`);
  outro('Done.');
}

async function runRemove(args: string[]): Promise<void> {
  intro('byline — media remove');
  const name = args[0];

  if (!name) {
    fail('Usage: byline media remove <name> [--yes]');
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  const ctx = loadContext();
  const lib = libraryNamed(ctx.media.libraries, name);

  if (!lib) {
    fail(`No media library named "${name}".`);
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  section(`library "${name}"`);
  detail(lib.path);
  attention(
    'This forgets the config entry only. Byline never writes inside a library folder, so the folder and its files are not deleted — left alone at the path above.',
  );

  if (!args.includes('--yes')) {
    fail('Re-run with --yes to confirm.');
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  removeLibraryFromConfig(ctx.paths.configFile, name);
  check(true, `Removed "${name}" from config.yaml. The folder at ${lib.path} was left untouched — not deleted.`);
  attention(RESTART_NOTICE);
  outro(`Removed "${name}".`);
}

/**
 * Render a caught error the same way `main.ts`'s top-level boundary does —
 * message (+ hint for a ToolError), stack only behind BYLINE_DEBUG.
 *
 * A second copy of that rendering, not a call into `main.ts`: `runMedia` is
 * unit-tested directly (bypassing `runCli`), so it must never let an
 * anticipated failure — a missing folder, an unknown library — reach a
 * caller as a raw stack trace on its own, without going through `runCli`
 * first.
 */
function renderFailure(err: unknown): void {
  if (err instanceof ToolError) {
    fail(err.message);
    if (err.hint) info(err.hint);
  } else {
    fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (process.env.BYLINE_DEBUG) {
    const stack = err instanceof Error ? err.stack : undefined;
    if (stack) detail(stack);
  } else {
    info('Set BYLINE_DEBUG=1 and re-run for the full stack trace.');
  }
}

export async function runMedia(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  try {
    switch (sub) {
      case 'add':
        await runAdd(rest);
        return;
      case 'list':
        await runList(rest);
        return;
      case 'scan':
        await runScan(rest);
        return;
      case 'status':
        await runStatus(rest);
        return;
      case 'release':
        await runRelease(rest);
        return;
      case 'remove':
        await runRemove(rest);
        return;
      default:
        intro('byline — media');
        if (sub) fail(`Unknown media command: ${sub}`);
        printUsage();
        outro('`byline media <command>` — see the list above.');
        return;
    }
  } catch (e) {
    renderFailure(e);
    process.exitCode = 1;
    outro('media command failed.');
  }
}
