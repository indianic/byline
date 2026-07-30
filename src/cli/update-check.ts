import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getPackageName, getPackageVersion } from '../version.js';

const execFileAsync = promisify(execFile);

/** How long a registry answer is trusted before asking again. */
const CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * How long the registry gets to answer before we give up entirely.
 *
 * This runs on ordinary commands, so it is spending the user's time. A version
 * notice is worth a second at most; on a slow connection or behind a
 * corporate proxy the right answer is silence, not a stalled CLI.
 */
const TIMEOUT_MS = 1500;

interface CacheFile {
  checkedAt: number;
  latest: string;
}

/**
 * Compare two dotted versions numerically.
 *
 * String comparison gets this wrong in the ordinary case: '0.10.0' < '0.9.0'
 * lexically, so a real upgrade would never be announced. Pre-release suffixes
 * are deliberately ignored — a `1.0.0-rc.1` tag should not nag someone running
 * a stable `1.0.0`.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Where the last answer is remembered, beside the user's config. */
function cachePath(home: string): string {
  return join(home, '.update-check.json');
}

function readCache(path: string): CacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
    return typeof parsed.checkedAt === 'number' && typeof parsed.latest === 'string' ? parsed : null;
  } catch {
    // A corrupt or absent cache means "ask again", never a crash. This runs on
    // every command; it is not allowed to be the thing that breaks one.
    return null;
  }
}

function writeCache(path: string, value: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    // Unwritable config dir (read-only home, permissions). Losing the cache
    // costs one extra registry call, so there is nothing worth reporting.
  }
}

/**
 * The latest published version, or null when we should stay quiet.
 *
 * Returns null — never throws — for every failure mode there is: no network, a
 * proxy, an unpublished package, a registry 500, a slow answer. A version
 * notice is a courtesy; it must never be the reason a command fails or hangs.
 *
 * `now` and `run` are injectable so the caching and comparison logic is
 * testable without a clock or a network.
 */
export async function fetchLatest(
  home: string,
  now: number,
  run: (pkg: string) => Promise<string> = defaultRun,
): Promise<string | null> {
  const path = cachePath(home);
  const cached = readCache(path);
  if (cached && now - cached.checkedAt < CACHE_MS) return cached.latest;

  try {
    const latest = (await run(getPackageName())).trim();
    if (!/^\d+\.\d+\.\d+/.test(latest)) return null;
    writeCache(path, { checkedAt: now, latest });
    return latest;
  } catch {
    // Remember the ATTEMPT even though it failed, so an offline user is not
    // made to wait TIMEOUT_MS on every single command for the next day.
    if (cached) writeCache(path, { ...cached, checkedAt: now });
    else writeCache(path, { checkedAt: now, latest: getPackageVersion() });
    return null;
  }
}

async function defaultRun(pkg: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', ['view', pkg, 'version'], {
    timeout: TIMEOUT_MS,
  });
  return stdout.trim().split('\n').pop() ?? '';
}

/**
 * One line telling the user a newer version exists, or null.
 *
 * Returns the string rather than printing it, so the caller decides where it
 * goes and this stays testable without capturing stdout.
 */
export async function updateNotice(
  home: string,
  now: number = Date.now(),
  run?: (pkg: string) => Promise<string>,
): Promise<string | null> {
  const current = getPackageVersion();
  const latest = await fetchLatest(home, now, run);
  if (!latest || !isNewer(latest, current)) return null;
  return `A newer version is available: ${current} → ${latest}. Run \`byline update\` to upgrade.`;
}

/** Skip the check entirely — set by the user, or by us on paths that must stay silent. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BYLINE_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}
