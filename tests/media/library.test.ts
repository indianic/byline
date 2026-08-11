import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { getLibrary, indexFileFor, ledgerFileFor, loadMedia } from '../../src/media/library.js';

// Lets one test force `statSync` to throw for a specific path, simulating a
// directory that vanishes between the `existsSync` check and the `statSync`
// call (deletion, an unmounted network volume) without relying on an actual,
// non-deterministic race. `vi.hoisted` is required because `vi.mock` factories
// run before the rest of the module body, so the mutable flag they close over
// has to be created through it rather than declared as an ordinary variable.
const fsMockState = vi.hoisted(() => ({ throwStatFor: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    statSync: (p: unknown, ...rest: unknown[]) => {
      if (fsMockState.throwStatFor !== null && p === fsMockState.throwStatFor) {
        const err = new Error(`ENOENT: no such file or directory, stat '${String(p)}'`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return (actual as typeof import('node:fs')).statSync(p as never, ...(rest as []));
    },
  };
});

afterEach(() => {
  fsMockState.throwStatFor = null;
});

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

  it('marks a library unavailable when index_path equals its own path', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: ${root}\n`),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toMatch(/index_path/i);
    expect(cfg.libraries.shots?.unavailable).toContain(root);
    expect(cfg.problems.join(' ')).toMatch(/index_path/i);
  });

  it('marks a library unavailable when index_path is nested inside its own path', () => {
    const root = realDir();
    const nested = join(root, 'sub');
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: ${nested}\n`),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toMatch(/index_path/i);
    expect(cfg.libraries.shots?.unavailable).toContain(root);
    expect(cfg.libraries.shots?.unavailable).toContain(nested);
  });

  it('does not flag a sibling directory that merely shares a path prefix', () => {
    const root = realDir();
    const sibling = `${root}-backup`;
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: ${sibling}\n`),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toBeUndefined();
  });

  it('marks a library unavailable when path is empty', () => {
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: ""\n'),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toMatch(/path/i);
  });

  it('marks a library unavailable when path is whitespace-only', () => {
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: "   "\n'),
      {},
    );
    expect(cfg.libraries.shots?.unavailable).toMatch(/path/i);
  });

  it('does not fall back to cwd for an empty path', () => {
    const cfg = loadMedia(
      fixture('media:\n  libraries:\n    - name: shots\n      path: ""\n'),
      {},
    );
    expect(cfg.libraries.shots?.path).not.toBe(process.cwd());
  });

  it('treats an empty index_path as absent, defaulting to <bylineHome>/media', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: ""\n`),
      {},
    );
    const lib = cfg.libraries.shots!;
    expect(lib.unavailable).toBeUndefined();
    expect(lib.indexPath).toBeUndefined();
    expect(indexFileFor(lib, '/home/u/.byline')).toBe('/home/u/.byline/media/shots.index.json');
  });

  it('treats a whitespace-only index_path as absent, defaulting to <bylineHome>/media', () => {
    const root = realDir();
    const cfg = loadMedia(
      fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n      index_path: "   "\n`),
      {},
    );
    const lib = cfg.libraries.shots!;
    expect(lib.unavailable).toBeUndefined();
    expect(lib.indexPath).toBeUndefined();
    expect(indexFileFor(lib, '/home/u/.byline')).toBe('/home/u/.byline/media/shots.index.json');
  });

  it('does not throw when the path check itself fails partway through (statSync throws after existsSync passes)', () => {
    const root = realDir();
    fsMockState.throwStatFor = root;
    const configFile = fixture(`media:\n  libraries:\n    - name: shots\n      path: ${root}\n`);

    let cfg: ReturnType<typeof loadMedia> | undefined;
    expect(() => {
      cfg = loadMedia(configFile, {});
    }).not.toThrow();

    expect(cfg?.libraries.shots?.unavailable).toMatch(/could not be checked/i);
    expect(cfg?.libraries.shots?.unavailable).toContain(root);
    expect(cfg?.problems.join(' ')).toMatch(/could not be checked/i);
  });

  it('records a problem when two libraries share a name, and keeps the last one', () => {
    const root1 = realDir();
    const root2 = realDir();
    const cfg = loadMedia(
      fixture(
        `media:\n  libraries:\n    - name: shots\n      path: ${root1}\n    - name: shots\n      path: ${root2}\n`,
      ),
      {},
    );
    expect(cfg.libraries.shots?.path).toBe(root2);
    expect(cfg.problems.join(' ')).toMatch(/shots/);
    expect(cfg.problems.join(' ')).toMatch(/more than once|duplicate/i);
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
    try {
      getLibrary(cfg, 'shots');
    } catch (e) {
      expect((e as ToolError).code).toBe('LIBRARY_UNAVAILABLE');
    }
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
