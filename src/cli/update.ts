import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { intro, outro } from '@clack/prompts';
import { getPackageName, getPackageVersion } from '../version.js';
import { detectPackageManager, installGlobalCommand } from './pkg-manager.js';
import { detail, fail, section } from './tree.js';

const execFileAsync = promisify(execFile);

/**
 * `update` (alias `upgrade`) — check the registry for a newer version and
 * update the global install in place, using whichever package manager put it
 * there.
 *
 * The package name comes from package.json, so the `@indianic` scope routing in
 * the user's `.npmrc` sends the query to the internal registry with no
 * `--registry` flag here.
 */
export async function runUpdate(_args: string[]): Promise<void> {
  intro('byline — update');
  const pkg = getPackageName();
  const current = getPackageVersion();

  let latest: string;
  try {
    const { stdout } = await execFileAsync('npm', ['view', pkg, 'version']);
    latest = stdout.trim().split('\n').pop()!.trim();
  } catch (err) {
    fail(
      `Couldn't reach the registry to check for updates: ${err instanceof Error ? err.message : String(err)}\n` +
        `If this is the first release, ${pkg} may not be published yet.`,
    );
    process.exitCode = 1;
    return;
  }

  section('versions');
  detail(`installed   ${current}`);
  detail(`latest      ${latest}`);

  if (latest === current) {
    outro(`Already up to date (${current}).`);
    return;
  }

  const { cmd, args } = installGlobalCommand(detectPackageManager(), `${pkg}@${latest}`);
  detail(`via         ${cmd}`);
  try {
    await execFileAsync(cmd, args);
  } catch (err) {
    fail(`${cmd} ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`);
    outro(`Update failed — try manually: ${cmd} ${args.join(' ')}`);
    process.exitCode = 1;
    return;
  }

  outro(`Updated ${current} → ${latest}. Restart any running AI tools so they pick it up.`);
}
