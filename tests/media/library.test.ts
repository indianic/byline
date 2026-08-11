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
