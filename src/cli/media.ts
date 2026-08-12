import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { intro, outro } from '@clack/prompts';
import { addLibraryToConfig, removeLibraryFromConfig } from '../config/media-block.js';
import { SLUG_PATTERN, SLUG_RULE } from '../config/sites.js';
import { loadContext } from '../context.js';
import {
  getLibrary,
  indexFileFor,
  ledgerFileFor,
  libraryNamed,
  resolveLibrary,
} from '../media/library.js';
import { isUsed, release, staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { readIndex, readLedger, writeIndex, writeLedger } from '../media/store.js';
import type { LibraryConfig, MediaConfig } from '../media/types.js';
import { attention, check, detail, fail, info, renderFailure, section } from './tree.js';

/**
 * `media` — the CLI surface over `src/media/`: add, list, scan, status,
 * release, remove.
 *
 * A generic surface over the library/index/ledger primitives in `src/media/`.
 * No platform, provider, or specific library is named anywhere here — the
 * `src/cli/` rule in CLAUDE.md. Every command that writes `config.yaml`
 * prints `RESTART_NOTICE`: `loadContext()` reads config once at MCP server
 * startup, so a library added here is invisible to an already-running server
 * until the AI tool is restarted — and that includes an `add` whose first scan
 * then failed, because the config write happened first and is not undone.
 * Before this command existed, adopting the media library meant hand-editing
 * config.yaml directly — severe enough that drafting a real article abandoned
 * the library mid-flow.
 */

const RESTART_NOTICE =
  'A running MCP server only reads config.yaml at startup, so this change is invisible there until you restart your AI tool.';

/**
 * One subcommand: what it is called, what it accepts, and what runs it.
 *
 * `flags` maps a flag to whether it takes a following value, and it is what
 * makes an unrecognised flag an error rather than a no-op. `byline media add
 * ~/Pictures --defualt` used to exit 0 having quietly not set the default,
 * which is the same silence `main.ts` refuses to give a mistyped COMMAND.
 * Keeping the flags beside the usage line is also what stops the two drifting:
 * a flag added to one is visible in the other.
 */
interface MediaCommand {
  usage: string;
  summary: string;
  flags: Record<string, boolean>;
  run: (args: string[]) => Promise<void>;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Every complaint about the flags in `args`, in the order they appear.
 *
 * Two kinds, both of which used to pass silently: a flag this subcommand does
 * not know, and a flag that takes a value with no value after it (`--name` as
 * the last argument used to fall back to the derived name, which is a name the
 * user did not choose).
 *
 * A flag's VALUE is skipped rather than inspected, so `--name --weird` is a
 * name, not an unknown flag. Positional arguments — a folder, a library name,
 * an asset id — never begin with `-`.
 */
function flagProblems(args: string[], spec: Record<string, boolean>): string[] {
  const problems: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) continue;
    if (!Object.hasOwn(spec, arg)) {
      problems.push(`Unrecognised flag: ${arg}`);
      continue;
    }
    if (!spec[arg]) continue;
    if (args[i + 1] === undefined) {
      problems.push(`${arg} needs a value after it.`);
      continue;
    }
    i += 1;
  }
  return problems;
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether the index/ledger directory for a library can be read at all.
 *
 * The same guard `reportLibrary` uses in `src/tools/media-tools.ts`, and for
 * the same reason: these files live under byline's own home (or a configured
 * `index_path`), NOT inside the library folder, so an unreachable library
 * folder says nothing about them. Only when the ledger's own directory is gone
 * too is the count genuinely unanswerable — and then it is omitted with a
 * reason rather than printed as a zero, because a fabricated zero is
 * indistinguishable from "nothing is held".
 */
function ledgerReachable(ledgerFile: string): boolean {
  return existsSync(ledgerFile) || existsSync(dirname(ledgerFile));
}

async function runAdd(args: string[]): Promise<void> {
  intro('byline — media add');
  const [rawPath, ...rest] = args;

  if (!rawPath) {
    fail('Usage: byline media add <folder> [--name <slug>] [--index-path <folder>] [--no-recursive] [--default]');
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
  const rawIndexPath = flagValue(rest, '--index-path');
  const indexPath = rawIndexPath ? resolveFolder(rawIndexPath) : undefined;
  const ctx = loadContext();

  // Existence/directory-ness, the SLUG_PATTERN check on an EXPLICIT --name, and
  // the refusal of an index path inside the library are all validated by
  // addLibraryToConfig itself (src/config/media-block.ts) — the one writer of a
  // media.libraries entry. Re-checking any of them here would be a second
  // hand-maintained copy of a rule that already lives there.
  const { warnings } = addLibraryToConfig(ctx.paths.configFile, {
    name,
    path,
    ...(recursive ? {} : { recursive: false }),
    ...(indexPath ? { indexPath } : {}),
    ...(rest.includes('--default') ? { setDefault: true } : {}),
  });

  section(`library "${name}"`);
  detail(path);
  if (indexPath) detail(`index and usage ledger: ${indexPath}`);
  for (const w of warnings) attention(w);

  // Scans immediately: one command makes the folder usable, not two. This is
  // the entire point of the plan — hand-editing config.yaml and restarting
  // used to be step one of two.
  const lib: LibraryConfig = { name, path, recursive, ...(indexPath ? { indexPath } : {}) };
  try {
    const index = scanLibrary(lib, null);
    writeIndex(indexFileFor(lib, ctx.paths.home), index);
    check(true, `Scanned: ${assetCounts(index.assets)}.`);
  } catch (e) {
    // config.yaml WAS written above, and nothing here undoes it. Letting this
    // reach the outer boundary reported the whole command as a failure, so the
    // obvious retry hit LIBRARY_EXISTS pointing at `remove` — for a library the
    // user had just been told did not get added. The write stands, the restart
    // notice still applies, and the fix names the command that finishes the job.
    check(true, `Added "${name}" to config.yaml.`);
    fail(`The first scan did not finish: ${messageOf(e)}`);
    info(`The library IS configured — do not add it again. Once that is fixed, run \`byline media scan ${name}\` to build the index.`);
    attention(RESTART_NOTICE);
    process.exitCode = 1;
    outro(`Added "${name}" — not scanned yet.`);
    return;
  }

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

  let failures = 0;

  for (const name of names) {
    try {
      // getLibrary refuses an unknown name or an unavailable library with a
      // real message+hint, rather than a bare lookup miss.
      const lib = getLibrary(ctx.media, name);
      const indexFile = indexFileFor(lib, ctx.paths.home);
      const previous = readIndex(indexFile);
      const next = scanLibrary(lib, previous);
      writeIndex(indexFile, next);

      // Counted by ID, not by path. An asset's id is the hash of its bytes, so
      // a file whose content changed gets a NEW id and its ledger record — keyed
      // by id — no longer refers to it. Calling that "unchanged" because the
      // path is the same reported "nothing happened" for the one event this
      // command exists to surface: appending bytes to a file left it detached
      // from its usage record and `scan` said `2 unchanged`.
      const previousIds = new Map((previous?.assets ?? []).map((a) => [a.path, a.id]));
      const nextPaths = new Set(next.assets.map((a) => a.path));
      let added = 0;
      let changed = 0;
      let unchanged = 0;
      for (const asset of next.assets) {
        const before = previousIds.get(asset.path);
        if (before === undefined) added += 1;
        else if (before === asset.id) unchanged += 1;
        else changed += 1;
      }
      const removed = [...previousIds.keys()].filter((p) => !nextPaths.has(p)).length;

      check(
        true,
        `${name}   ${added} added, ${removed} removed, ${changed} changed, ${unchanged} unchanged (${next.assets.length} total)`,
      );
    } catch (e) {
      // One broken library must not stop the rest of a whole-library scan
      // from being reported — but it must not be reported as success either.
      failures += 1;
      check(false, `${name}: ${messageOf(e)}`);
    }
  }

  if (failures > 0) {
    // The house signal for a command that printed a failure (`doctor.ts` sets
    // the same). Exiting 0 under "Scan complete." left a script unable to tell
    // a scan of nothing from a scan of everything.
    process.exitCode = 1;
    outro(`Scan failed for ${failures} of ${names.length} librar${names.length === 1 ? 'y' : 'ies'}.`);
    return;
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

    // Deliberately NOT skipped for an unavailable library. The ledger is not
    // inside the library folder, so an unplugged drive is exactly the case
    // where a reservation is still held and nothing else would say so —
    // `reportLibrary` in src/tools/media-tools.ts has always done this, and the
    // CLI disagreeing with the MCP tools about what a library is meant this
    // command's own documented promise (it reports the stale count) was false
    // in the one state where the count matters most.
    if (!ledgerReachable(ledgerFile)) {
      attention(`${name}: the usage ledger at ${ledgerFile} is not reachable either, so reservations cannot be counted.`);
      continue;
    }
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
      attention(`${name}: ${messageOf(e)}`);
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
  // resolveLibrary, not getLibrary: clearing a reservation touches the ledger
  // under byline's home and never the library folder, so refusing here because
  // a drive is unplugged made `list_media_libraries`' own advice — "clear one
  // from a terminal with `byline media release <id> --library <name>`" —
  // impossible to follow in the one state that note describes.
  const lib = resolveLibrary(ctx.media, libraryName);
  const ledgerFile = ledgerFileFor(lib, ctx.paths.home);

  section(`library "${lib.name}"`);
  if (lib.unavailable) {
    attention(`${lib.unavailable} The usage ledger lives at ${ledgerFile}, outside that folder, so a reservation can still be cleared from here.`);
  }

  const ledger = readLedger(ledgerFile, lib.name);
  const clearing = ledger.records.filter((r) => r.id === id && r.state === 'reserved');
  const { ledger: next, released } = release(ledger, id);

  if (released === 0) {
    detail(
      `No reserved record for "${id}" was found in ${ledgerFile} — nothing changed. A "published" record is never released this way; release only clears a reservation that never became a post.`,
    );
    outro('Nothing released.');
    return;
  }

  writeLedger(ledgerFile, next);

  const sites = [...new Set(clearing.map((r) => r.site))];
  check(true, `Released ${released} reservation(s) for "${id}" on ${sites.join(', ')}.`);

  // Whether the asset is actually free again is a question for `isUsed`, the
  // one definition of used/not-used — not something to assert unconditionally.
  // `release` only clears RESERVED records: a surviving `published` record for
  // the same id still counts, so under reuse_scope "global" the asset stays
  // refused by use_media and the old blanket "It is free for use_media again."
  // was simply wrong.
  const stillUsed = sites.filter((site) => isUsed(next, id, site, ctx.media.reuseScope));
  if (stillUsed.length === 0) {
    info('It is free for use_media again.');
  } else if (ctx.media.reuseScope === 'global') {
    info(`It is still NOT free for use_media: reuse_scope is "global", and another record for "${id}" survives in the ledger — a published record is never released this way.`);
  } else {
    info(`It is free for use_media again except on ${stillUsed.join(', ')}, where another record for "${id}" survives — a published record is never released this way.`);
  }
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
    fail('Re-run with --yes to confirm. Nothing has been changed.');
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  // The return value decides what is printed. It was discarded, and success was
  // announced unconditionally — so a `false` (nothing in the file matched) read
  // to the user as a completed removal.
  if (!removeLibraryFromConfig(ctx.paths.configFile, name)) {
    fail(`Nothing named "${name}" was found in ${ctx.paths.configFile}, so nothing was changed.`);
    info('Check that file for a `media.libraries` entry with that name, and that it is a list.');
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  check(true, `Removed "${name}" from config.yaml. The folder at ${lib.path} was left untouched — not deleted.`);
  attention(RESTART_NOTICE);
  outro(`Removed "${name}".`);
}

const COMMANDS: Record<string, MediaCommand> = {
  add: {
    usage: 'add <folder> [--name <slug>] [--index-path <folder>] [--no-recursive] [--default]',
    summary: 'Add a library and scan it immediately',
    flags: { '--name': true, '--index-path': true, '--no-recursive': false, '--default': false },
    run: runAdd,
  },
  list: {
    usage: 'list',
    summary: 'Every configured library, with asset counts',
    flags: {},
    run: runList,
  },
  scan: {
    usage: 'scan [<name>]',
    summary: 'Rescan a library (or every library) and report what changed',
    flags: {},
    run: runScan,
  },
  status: {
    usage: 'status',
    summary: 'Like list, plus index/ledger file locations and stale reservations',
    flags: {},
    run: runStatus,
  },
  release: {
    usage: 'release <id> [--library <name>]',
    summary: 'Clear a reservation stuck by a failed publish',
    flags: { '--library': true },
    run: runRelease,
  },
  remove: {
    usage: 'remove <name> [--yes]',
    summary: 'Forget a library (the folder itself is left alone)',
    flags: { '--yes': false },
    run: runRemove,
  },
};

function printUsage(): void {
  section('media   (usage: byline media <command> [...args])');
  for (const cmd of Object.values(COMMANDS)) detail(`${cmd.usage}\n  ${cmd.summary}`);
}

export async function runMedia(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  // Object.hasOwn, not a bare lookup: `sub` is user input, and
  // `COMMANDS['constructor']` is a truthy inherited function.
  const command = sub && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub]! : undefined;

  if (!command) {
    intro('byline — media');
    if (sub) fail(`Unknown media command: ${sub}`);
    printUsage();
    if (sub) process.exitCode = 1;
    outro('`byline media <command>` — see the list above.');
    return;
  }

  const problems = flagProblems(rest, command.flags);
  if (problems.length > 0) {
    intro(`byline — media ${sub}`);
    for (const p of problems) fail(p);
    const known = Object.keys(command.flags);
    info(
      known.length > 0
        ? `\`byline media ${sub}\` accepts: ${known.join(', ')}.`
        : `\`byline media ${sub}\` takes no flags.`,
    );
    process.exitCode = 1;
    outro('Nothing done.');
    return;
  }

  try {
    await command.run(rest);
  } catch (e) {
    // `renderFailure` is the shared rendering in `tree.ts`, not a copy of
    // `main.ts`'s: `runMedia` is unit-tested directly (bypassing `runCli`), so
    // it must never let an anticipated failure — a missing folder, an unknown
    // library — reach a caller as a raw stack trace on its own. The closing
    // line differs from `main.ts`'s, which is all this adds.
    renderFailure(e);
    process.exitCode = 1;
    outro('media command failed.');
  }
}
