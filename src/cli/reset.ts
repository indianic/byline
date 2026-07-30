import { existsSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { intro, outro } from '@clack/prompts';
import { type Paths, resolvePaths } from '../config/paths.js';
import { attention, detail, fail, section } from './tree.js';

interface Identity {
  dev: number;
  ino: number;
}

/**
 * Stat a path for identity comparison. Returns `undefined` when the path
 * doesn't exist (or isn't reachable) — callers fall back to a normalised
 * string comparison in that case, which is safe: `rmSync` on a path that
 * doesn't exist is a no-op, so a nonexistent candidate is harmless regardless
 * of what string it happens to match.
 */
function identityOf(path: string): Identity | undefined {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

/**
 * True when `candidate` refers to the same directory as `target`.
 *
 * Compares by filesystem identity (device + inode) whenever both paths
 * exist, so case differences, trailing slashes, `.`/`..` segments, and
 * symlinks can't hide a match — the case-insensitive-filesystem bypass lived
 * exactly here: `/Users/x` and `/uSeRs/X` are the SAME inode on APFS (macOS's
 * default filesystem) despite being different strings, so a case-sensitive
 * `===` comparison silently let a mangled-case `$BYLINE_HOME` reach the
 * real home directory. Falls back to a normalised string comparison when
 * either side doesn't exist.
 */
function sameDirectory(candidate: string, target: string): boolean {
  const a = identityOf(candidate);
  const b = identityOf(target);
  if (a !== undefined && b !== undefined) return a.dev === b.dev && a.ino === b.ino;
  return candidate === target;
}

/**
 * True when `candidate` equals `target` or is one of `target`'s ancestors,
 * walking up to and including the filesystem root.
 *
 * Refusing this single predicate (with `target` = the real home directory)
 * subsumes `/Users`, `/home`, and `/` without a hardcoded per-OS directory
 * list: every one of those is an ancestor of wherever the real home
 * directory lives, so a shell bug that collapses `$BYLINE_HOME` to
 * `/Users/` (or to `/`, or to the parent of home) is caught by the same rule
 * that catches home itself — no separate enumeration needed.
 */
function isSelfOrAncestor(candidate: string, target: string): boolean {
  let current = target;
  for (;;) {
    if (sameDirectory(candidate, current)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * True when `dir` contains the unmistakable markers of a source checkout —
 * a `.git` entry or a `package.json`.
 *
 * This is keyed on what the directory IS, not on how `paths.source` was
 * resolved. The cwd-autodetect `repo` branch is one way to end up pointed at
 * a checkout, but an explicit `BYLINE_HOME=<repo root>` yields
 * `source: 'env'` and would otherwise walk straight past a check that only
 * looked at `paths.source`. `reset` should never delete a source tree
 * regardless of which path led it there.
 */
function looksLikeSourceCheckout(dir: string): boolean {
  return existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'));
}

/**
 * `reset` — wipe the configuration directory for a clean re-setup.
 *
 * Destructive, so it requires an explicit `--yes` with no confirm-default
 * bypass, AND passes `assertResettable` first.
 *
 * That guard is not ceremony. byline' path resolution has a repo-checkout
 * branch that resolves `home` to the CURRENT WORKING DIRECTORY — so a developer
 * who runs `byline reset --yes` inside a checkout would, without this,
 * delete their source tree rather than their config. That is the single most
 * destructive thing this CLI could do, and it would be one command away.
 *
 * Every other clause below answers one question — "is it safe to recursively
 * delete this directory?" — from what the path IS (its filesystem identity,
 * its position relative to the home directory and the root, its contents),
 * never from how `paths.source` happened to be resolved. That is deliberate:
 * keying safety on resolution mechanism is exactly what let an explicit
 * `BYLINE_HOME=<repo root>` walk past the old repo-only check.
 */
export function assertResettable(paths: Paths): void {
  const home = resolve(paths.home);
  const realHome = resolve(homedir());
  const root = resolve('/');

  if (paths.source === 'repo') {
    throw new Error(
      `Refusing to reset: configuration is currently resolving to the repo checkout at ${home}, ` +
        'so wiping it would delete your source tree, not your configuration. ' +
        'Run `byline migrate --yes` first, or set $BYLINE_HOME to the directory you actually want removed.',
    );
  }

  if (sameDirectory(home, root)) {
    throw new Error(`Refusing to reset: ${home} is the filesystem root.`);
  }

  if (dirname(home) === root) {
    throw new Error(
      `Refusing to reset: ${home} is a top-level system directory (an immediate child of the filesystem ` +
        `root ${root}), not a byline config directory. Point $BYLINE_HOME at a specific ` +
        'config directory instead, e.g. one nested inside it.',
    );
  }

  if (sameDirectory(home, realHome)) {
    throw new Error(
      `Refusing to reset: ${home} is your home directory, not a byline config directory.`,
    );
  }

  if (isSelfOrAncestor(home, realHome)) {
    throw new Error(
      `Refusing to reset: ${home} is an ancestor of your home directory (${realHome}), so wiping it ` +
        'would delete far more than byline config. Point $BYLINE_HOME at a specific config ' +
        'directory instead.',
    );
  }

  if (looksLikeSourceCheckout(home)) {
    throw new Error(
      `Refusing to reset: ${home} contains a .git directory or a package.json, which makes it look like ` +
        'a source checkout rather than a byline config directory. Point $BYLINE_HOME at your ' +
        'actual config directory instead.',
    );
  }
}

export async function runReset(args: string[]): Promise<void> {
  intro('byline — reset');
  const paths = resolvePaths();

  try {
    assertResettable(paths);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  section('would remove');
  detail(paths.home);
  attention('This deletes every configured blog, every author profile, and every stored API key.');

  if (!args.includes('--yes')) {
    fail('Re-run with --yes to confirm.');
    process.exitCode = 1;
    outro('Nothing removed.');
    return;
  }

  rmSync(paths.home, { recursive: true, force: true });
  outro(`Removed ${paths.home}. Run \`byline init\` to set up again.`);
}
