import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolvePaths } from '../../src/config/paths.js';
import { assertResettable } from '../../src/cli/reset.js';
import { detectPackageManager, installGlobalCommand } from '../../src/cli/pkg-manager.js';

let dir: string;

// `assertResettable` checks the resolved `home` against the REAL `os.homedir()`
// (not an injectable parameter — the interface is `assertResettable(paths: Paths)`),
// to guard the case where `$BYLINE_HOME` is accidentally set to the user's
// actual home directory. Exercising that branch means pointing the real `HOME`
// env var at a throwaway directory, so it must be restored KEY BY KEY —
// `process.env = { ...saved }` silently detaches `process.env` from the native
// environment and leaves `os.homedir()` stale for the rest of the process (see
// tests/cli/doctor.test.ts, which documents the same footgun).
const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-reset-'));
});

afterEach(() => {
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
});

describe('assertResettable', () => {
  it('allows wiping a real ~/.byline directory', () => {
    const paths = resolvePaths({ BYLINE_HOME: join(dir, '.byline') }, dir, '/nowhere');
    expect(() => assertResettable(paths)).not.toThrow();
  });

  it('refuses to wipe a repo checkout', () => {
    // The repo branch resolves `home` to the CWD itself. `rm -rf` on that would
    // delete the user's source tree, not their config — the single most
    // destructive thing this CLI could possibly do.
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'sites.yaml'), 'sites: {}\n');
    const paths = resolvePaths({}, '/nowhere', dir);
    expect(paths.source).toBe('repo');
    expect(() => assertResettable(paths)).toThrow(/repo checkout/i);
  });

  it('refuses when the resolved home is a filesystem root', () => {
    expect(() => assertResettable(resolvePaths({ BYLINE_HOME: '/' }, dir, '/nowhere'))).toThrow();
  });

  it("refuses when the resolved home is the user's actual home directory", () => {
    // Point the REAL HOME at the throwaway dir so os.homedir() returns it —
    // otherwise this branch is untestable, since assertResettable has no way to
    // learn what `home` a Paths came from other than asking the OS directly.
    process.env.HOME = dir;
    expect(() => assertResettable(resolvePaths({ BYLINE_HOME: dir }, dir, '/nowhere'))).toThrow(
      /home directory/i,
    );
  });

  it('refuses the home directory written with a trailing slash', () => {
    process.env.HOME = dir;
    expect(() =>
      assertResettable(resolvePaths({ BYLINE_HOME: `${dir}/` }, dir, '/nowhere')),
    ).toThrow(/home directory/i);
  });

  it('refuses the home directory written with ./.. segments that normalise back to it', () => {
    process.env.HOME = dir;
    const base = dir.split('/').pop() as string;
    const roundabout = join(dir, '..', base, '.');
    expect(() =>
      assertResettable(resolvePaths({ BYLINE_HOME: roundabout }, dir, '/nowhere')),
    ).toThrow(/home directory/i);
  });

  it('refuses a case-mangled path to the home directory (bypass: case-insensitive filesystem)', () => {
    // On macOS's default APFS, `/Users/x` and `/uSeRs/X` are the same inode
    // despite being different strings — a case-sensitive `===` comparison lets
    // a mangled-case $BYLINE_HOME reach the real home directory. Verify by
    // inode identity, rather than assuming the mangled path resolves to home,
    // so this test is meaningful on a case-sensitive filesystem too: there the
    // mangled path is a genuinely different, nonexistent directory, and NOT
    // refusing it is the correct behaviour (refusing a nonexistent path would
    // break a legitimate first-run reset).
    process.env.HOME = dir;
    const base = dir.split('/').pop() as string;
    const mangledBase = base
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    const mangled = join(dirname(dir), mangledBase);

    let sameInode = false;
    try {
      const a = statSync(dir);
      const b = statSync(mangled);
      sameInode = a.dev === b.dev && a.ino === b.ino;
    } catch {
      sameInode = false;
    }

    const check = () => assertResettable(resolvePaths({ BYLINE_HOME: mangled }, dir, '/nowhere'));
    if (sameInode) {
      expect(check).toThrow(/home directory/i);
    } else {
      expect(check).not.toThrow();
    }
  });

  it('refuses the parent of the home directory (bypass: ancestor directories)', () => {
    // A mocked HOME nested one level under a throwaway parent — the parent is
    // an ancestor of home, the same shape as `/Users` being the parent of
    // `/Users/alice`, without hardcoding a real, possibly-unwritable path.
    const fakeHome = mkdtempSync(join(dir, 'home-'));
    process.env.HOME = fakeHome;
    const parent = dirname(fakeHome);
    expect(() =>
      assertResettable(resolvePaths({ BYLINE_HOME: parent }, fakeHome, '/nowhere')),
    ).toThrow(/ancestor of your home directory/i);
  });

  it('refuses a top-level system directory such as /Users (bypass: system directories)', () => {
    // Uses the REAL, unmocked OS home directory: on this machine (and any
    // default macOS install) `dirname(homedir())` literally is `/Users`. The
    // "top-level child of the filesystem root" rule is what catches this
    // (and /tmp, /home, /var, ...) without a hardcoded per-OS directory list.
    const realHome = resolve(homedir());
    const topLevel = dirname(realHome);
    expect(() =>
      assertResettable(resolvePaths({ BYLINE_HOME: topLevel }, dir, '/nowhere')),
    ).toThrow(/top-level system directory/i);
  });

  it('does not refuse a path that does not exist yet', () => {
    // A first-run reset legitimately targets a config directory that hasn't
    // been created yet. rmSync on a nonexistent path is a no-op, so refusing
    // it would break that legitimate case.
    const missing = join(dir, 'does-not-exist-yet');
    expect(() =>
      assertResettable(resolvePaths({ BYLINE_HOME: missing }, dir, '/nowhere')),
    ).not.toThrow();
  });

  it('refuses an explicit BYLINE_HOME pointing at a directory containing .git (bypass: repo guard keyed on source)', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    const paths = resolvePaths({ BYLINE_HOME: dir }, '/nowhere', '/nowhere');
    expect(paths.source).toBe('env'); // NOT 'repo' — that is exactly the bypass.
    expect(() => assertResettable(paths)).toThrow(/source checkout/i);
  });

  it('refuses an explicit BYLINE_HOME pointing at a directory containing package.json (bypass: repo guard keyed on source)', () => {
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const paths = resolvePaths({ BYLINE_HOME: dir }, '/nowhere', '/nowhere');
    expect(paths.source).toBe('env');
    expect(() => assertResettable(paths)).toThrow(/source checkout/i);
  });
});

describe('installGlobalCommand', () => {
  it('matches the package manager that owns the install', () => {
    expect(installGlobalCommand('npm', '@indianic/byline@1.0.0')).toEqual({
      cmd: 'npm',
      args: ['install', '-g', '@indianic/byline@1.0.0'],
    });
    expect(installGlobalCommand('pnpm', 'x').cmd).toBe('pnpm');
    expect(installGlobalCommand('yarn', 'x').args).toEqual(['global', 'add', 'x']);
  });
});

describe('detectPackageManager', () => {
  it('returns one of the three supported managers', () => {
    expect(['npm', 'pnpm', 'yarn']).toContain(detectPackageManager());
  });
});
