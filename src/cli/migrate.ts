import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { intro, outro } from '@clack/prompts';
import { checkEnvPermissions } from '../config/dotenv.js';
import { type Paths, resolvePaths } from '../config/paths.js';
import { attention, check, detail, fail, info, section } from './tree.js';
import { ensureHome } from './home-config.js';

/**
 * `migrate` — copy a repo-checkout configuration into `~/.byline/`.
 *
 * The repo-local path resolution is a development convenience and is
 * cwd-dependent: an AI tool picks the directory it launches the MCP server in,
 * so a config that only exists inside a checkout may or may not be found
 * depending on where the server was started. `~/.byline/` is found
 * regardless. This is the command that makes that move.
 *
 * Deliberately a COPY, never a move: the checkout keeps working, and a
 * migration that turns out wrong costs nothing. Deleting the originals is the
 * user's call afterwards.
 */

export interface MigrationItem {
  from: string;
  to: string;
  kind: 'config' | 'env' | 'persona';
  action: 'copy' | 'skip-exists' | 'skip-missing';
  /**
   * Set by `applyMigration` when a planned copy could not be completed.
   * Never set by `planMigration` — a later task depends on the action values
   * it produces staying exactly `'copy' | 'skip-exists' | 'skip-missing'`.
   */
  error?: string;
}

/** The repo-local config file, if this directory is a checkout with one. */
export function detectRepoConfig(cwd: string = process.cwd()): string | null {
  const file = join(cwd, 'config', 'sites.yaml');
  return existsSync(file) ? file : null;
}

/**
 * Decide every copy before making any of them, so the user can be shown exactly
 * what will happen and nothing is half-done on a failure. An existing
 * destination is never overwritten — that is how someone loses a working
 * `~/.byline/` to a stale checkout.
 */
export function planMigration(
  repoDir: string,
  target: Paths,
  exists: (p: string) => boolean = existsSync,
  listPersonas: (dir: string) => string[] = (dir) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : [],
): MigrationItem[] {
  const decide = (from: string, to: string, kind: MigrationItem['kind']): MigrationItem => ({
    from,
    to,
    kind,
    action: !exists(from) ? 'skip-missing' : exists(to) ? 'skip-exists' : 'copy',
  });

  const items: MigrationItem[] = [
    decide(join(repoDir, 'config', 'sites.yaml'), target.configFile, 'config'),
    decide(join(repoDir, '.env'), target.envFile, 'env'),
  ];

  for (const file of listPersonas(join(repoDir, 'personas'))) {
    items.push(decide(join(repoDir, 'personas', file), join(target.personasDir, file), 'persona'));
  }

  return items;
}

/**
 * Perform the planned copies. `.env` always lands at mode 600 regardless of the
 * source's mode.
 *
 * The "never overwrite an existing destination" invariant is enforced here,
 * not just by `planMigration`'s plan-time check: the copy uses
 * `COPYFILE_EXCL`, so if a destination appears in the window between planning
 * and applying, the copy fails instead of clobbering it. That is deliberately
 * NOT the same outcome as `skip-exists` — the plan the user approved no
 * longer matches reality, so it is reported as a failure (see below) rather
 * than silently treated as already-done.
 *
 * A failure on one item — that race, a full disk, a permission problem, a
 * destination directory that cannot be created — is recorded on the returned
 * item's `error` field instead of being thrown, so it does not abort the
 * remaining items and the caller can report every outcome.
 */
export function applyMigration(items: readonly MigrationItem[]): MigrationItem[] {
  return items.map((item) => {
    if (item.action !== 'copy') return item;
    try {
      mkdirSync(dirname(item.to), { recursive: true });
      copyFileSync(item.from, item.to, constants.COPYFILE_EXCL);
      // The repo .env is routinely 644 from an editor's default umask. Copying
      // that mode into the user's home directory would just relocate the problem.
      if (item.kind === 'env') chmodSync(item.to, 0o600);
      return item;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const reason =
        code === 'EEXIST'
          ? 'destination appeared after the plan was made — not overwritten'
          : err instanceof Error
            ? err.message
            : String(err);
      return { ...item, error: reason };
    }
  });
}

export async function runMigrate(args: string[]): Promise<void> {
  intro('byline — migrate');

  const cwd = process.cwd();
  const repoConfig = detectRepoConfig(cwd);
  if (!repoConfig) {
    outro(`No repo-local configuration found (looked for ${join(cwd, 'config', 'sites.yaml')}). Nothing to migrate.`);
    return;
  }

  // Resolve the DESTINATION explicitly rather than through the normal order:
  // the whole point is to write ~/.byline/, and the normal order would
  // resolve to the very checkout being migrated away from. Forcing a cwd that
  // cannot contain `config/sites.yaml` is what rules the repo branch out.
  const target = resolvePaths(process.env, undefined, '/nonexistent');
  const items = planMigration(cwd, target);

  section('plan');
  for (const item of items) {
    const verb =
      item.action === 'copy'
        ? 'copy   '
        : item.action === 'skip-exists'
          ? 'skip   '
          : 'absent ';
    detail(`${verb} ${basename(item.from)} → ${item.to}`);
  }

  const willCopy = items.filter((i) => i.action === 'copy');
  if (willCopy.length === 0) {
    outro('Everything is already in place — nothing copied.');
    return;
  }

  if (!args.includes('--yes')) {
    info('Nothing has been copied yet. Re-run with --yes to perform the plan above. Your checkout is never modified.');
    outro('Dry run.');
    return;
  }

  try {
    ensureHome(target);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(`Could not prepare ${target.home} — ${reason}`);
    outro('Nothing was copied. Fix the destination (e.g. remove whatever occupies that path) and re-run `byline migrate --yes`.');
    process.exitCode = 1;
    return;
  }
  const results = applyMigration(items);

  section('copied');
  const copied = results.filter((i) => i.action === 'copy');
  for (const item of copied) {
    if (item.error) check(false, `${item.to} — ${item.error}`);
    else check(true, item.to);
  }

  const permission = checkEnvPermissions(target.envFile);
  if (permission) attention(permission);

  const failed = copied.filter((i) => i.error);
  const succeeded = copied.length - failed.length;
  if (failed.length > 0) {
    attention(
      `${failed.length} of ${copied.length} file(s) failed to copy — see above. ` +
        'Nothing failed silently and no destination was overwritten; resolve the cause and re-run `byline migrate --yes`.',
    );
  }

  info(
    `Your configuration now lives in ${target.home}, which is found regardless of which directory your AI tool starts in.\n` +
      'Run `byline doctor` to confirm every blog still authenticates from the new location.\n' +
      'The originals in this checkout were left untouched — delete them once doctor is green.',
  );
  outro(
    failed.length > 0
      ? `Migrated ${succeeded} of ${copied.length} file(s) to ${target.home}; ${failed.length} failed.`
      : `Migrated ${succeeded} file(s) to ${target.home}.`,
  );
}
