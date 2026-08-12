import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { addLibraryToConfig, removeLibraryFromConfig } from '../../src/config/media-block.js';

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bl-mblock-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, yaml);
  return file;
}

function realDir(): string {
  return mkdtempSync(join(tmpdir(), 'bl-lib-'));
}

const WITH_SITE = `default_site: personal
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PERSONAL_ADMIN_API_KEY}
`;

describe('addLibraryToConfig', () => {
  it('adds a media block to a config that has none', () => {
    const file = fixture(WITH_SITE);
    const root = realDir();
    const res = addLibraryToConfig(file, { name: 'shots', path: root });
    expect(res.written).toBe(true);

    const cfg = parse(readFileSync(file, 'utf8'));
    expect(cfg.media.libraries).toHaveLength(1);
    expect(cfg.media.libraries[0].name).toBe('shots');
    expect(cfg.media.libraries[0].path).toBe(root);
  });

  it('leaves every unrelated key untouched', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'shots', path: realDir() });
    const cfg = parse(readFileSync(file, 'utf8'));
    expect(cfg.default_site).toBe('personal');
    expect(cfg.sites.personal.platform).toBe('ghost');
    // The ${VAR} reference must survive as a literal, not be resolved.
    expect(cfg.sites.personal.admin_api_key).toBe('${PERSONAL_ADMIN_API_KEY}');
  });

  it('appends to an existing media block without dropping siblings', () => {
    const root1 = realDir();
    const root2 = realDir();
    const file = fixture(`${WITH_SITE}media:\n  reuse_scope: global\n  libraries:\n    - name: first\n      path: ${root1}\n`);
    addLibraryToConfig(file, { name: 'second', path: root2 });
    const cfg = parse(readFileSync(file, 'utf8'));
    expect(cfg.media.libraries.map((l: { name: string }) => l.name)).toEqual(['first', 'second']);
    expect(cfg.media.reuse_scope).toBe('global');
  });

  it('refuses a duplicate name rather than overwriting it', () => {
    const root = realDir();
    const file = fixture(`${WITH_SITE}media:\n  libraries:\n    - name: shots\n      path: ${root}\n`);
    expect(() => addLibraryToConfig(file, { name: 'shots', path: realDir() })).toThrow(ToolError);
    try {
      addLibraryToConfig(file, { name: 'shots', path: realDir() });
    } catch (e) {
      expect((e as ToolError).code).toBe('LIBRARY_EXISTS');
      expect((e as ToolError).hint).toBeTruthy();
    }
  });

  it('refuses an illegal name, quoting the rule', () => {
    const file = fixture(WITH_SITE);
    try {
      addLibraryToConfig(file, { name: 'My_Shots', path: realDir() });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('BAD_LIBRARY_NAME');
      expect((e as ToolError).message).toMatch(/lowercase/i);
    }
  });

  it('refuses a path that does not exist', () => {
    const file = fixture(WITH_SITE);
    try {
      addLibraryToConfig(file, { name: 'shots', path: '/nope/nowhere' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('LIBRARY_PATH_MISSING');
    }
  });

  it('refuses a path that is a file, not a directory', () => {
    const file = fixture(WITH_SITE);
    const notDir = join(mkdtempSync(join(tmpdir(), 'bl-nd-')), 'a.png');
    writeFileSync(notDir, 'x');
    try {
      addLibraryToConfig(file, { name: 'shots', path: notDir });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('LIBRARY_PATH_NOT_DIR');
    }
  });

  it('sets default_library only when asked', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'shots', path: realDir(), setDefault: true });
    expect(parse(readFileSync(file, 'utf8')).media.default_library).toBe('shots');
  });

  it('makes the FIRST library the default automatically, and says so', () => {
    const file = fixture(WITH_SITE);
    const res = addLibraryToConfig(file, { name: 'shots', path: realDir() });
    expect(parse(readFileSync(file, 'utf8')).media.default_library).toBe('shots');
    expect(res.warnings.join(' ')).toMatch(/default/i);
  });

  it('does not move the default when a second library is added', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'first', path: realDir() });
    addLibraryToConfig(file, { name: 'second', path: realDir() });
    expect(parse(readFileSync(file, 'utf8')).media.default_library).toBe('first');
  });
});

describe('removeLibraryFromConfig', () => {
  it('removes a library and reports it', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'shots', path: realDir() });
    expect(removeLibraryFromConfig(file, 'shots')).toBe(true);
    const cfg = parse(readFileSync(file, 'utf8'));
    expect(cfg.media.libraries).toHaveLength(0);
  });

  it('clears default_library when the default is the one removed', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'shots', path: realDir() });
    removeLibraryFromConfig(file, 'shots');
    expect(parse(readFileSync(file, 'utf8')).media.default_library).toBeUndefined();
  });

  it('returns false for a library that was never there', () => {
    const file = fixture(WITH_SITE);
    expect(removeLibraryFromConfig(file, 'ghost-library')).toBe(false);
  });

  it('NEVER touches the library folder on disk', () => {
    const file = fixture(WITH_SITE);
    const root = realDir();
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'photo.png'), 'bytes');
    addLibraryToConfig(file, { name: 'shots', path: root });
    removeLibraryFromConfig(file, 'shots');
    // Removing a library forgets it; it does not delete anybody's photographs.
    expect(readFileSync(join(root, 'sub', 'photo.png'), 'utf8')).toBe('bytes');
  });
});
