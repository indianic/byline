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
    addLibraryToConfig(file, { name: 'shots', path: root });

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

  it('throws INVALID_CONFIG when media is present but null', () => {
    const file = fixture(`${WITH_SITE}media:\n`);
    try {
      addLibraryToConfig(file, { name: 'shots', path: realDir() });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('INVALID_CONFIG');
      expect((e as ToolError).message).toMatch(/media.*not a mapping/i);
    }
  });

  it('throws INVALID_CONFIG when media.libraries is a map instead of a sequence', () => {
    const file = fixture(`${WITH_SITE}media:\n  libraries:\n    foo: bar\n`);
    try {
      addLibraryToConfig(file, { name: 'shots', path: realDir() });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('INVALID_CONFIG');
      expect((e as ToolError).message).toMatch(/media\.libraries.*not a list/i);
    }
  });

  it('does not crash when a library entry is a bare string', () => {
    const file = fixture(`${WITH_SITE}media:\n  libraries:\n    - shots\n`);
    const root = realDir();
    addLibraryToConfig(file, { name: 'second', path: root });
    const cfg = parse(readFileSync(file, 'utf8'));
    expect(cfg.media.libraries).toHaveLength(2);
    expect(cfg.media.libraries[0]).toBe('shots');
    expect(cfg.media.libraries[1].name).toBe('second');
  });
});

describe('addLibraryToConfig — no config file at all', () => {
  // `byline init` can finish WITHOUT writing config.yaml: the file is written by
  // the add-a-site path (src/cli/init.ts), so someone who ran init and only
  // registered their AI tools has no config.yaml and would be told to run the
  // command they just ran.
  it('does not tell the user to run `byline init` and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl-nocfg-'));
    try {
      addLibraryToConfig(join(dir, 'config.yaml'), { name: 'shots', path: realDir() });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('CONFIG_NOT_FOUND');
      expect((e as ToolError).hint).toMatch(/blog|site/i);
    }
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

  it('returns false when media is present but null (does not throw)', () => {
    const file = fixture(`${WITH_SITE}media:\n`);
    expect(removeLibraryFromConfig(file, 'shots')).toBe(false);
  });

  it('returns false when media.libraries is a map instead of a sequence (does not throw)', () => {
    const file = fixture(`${WITH_SITE}media:\n  libraries:\n    foo: bar\n`);
    expect(removeLibraryFromConfig(file, 'shots')).toBe(false);
  });

  // The file header claims comments in a hand-edited config survive the write.
  // That was true for `add` and false for `remove`, which replaced the whole
  // sequence node with a plain array built from `toJSON()`.
  it('KEEPS a comment above a sibling entry', () => {
    const a = realDir();
    const b = realDir();
    const file = fixture(
      `${WITH_SITE}media:\n  libraries:\n    # the good camera, 2024 onwards\n    - name: keep\n      path: ${a}\n    - name: drop\n      path: ${b}\n`,
    );
    expect(removeLibraryFromConfig(file, 'drop')).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/# the good camera, 2024 onwards/);
    expect(parse(text).media.libraries.map((l: { name: string }) => l.name)).toEqual(['keep']);
  });

  it('keeps a comment above an entry that FOLLOWS the removed one', () => {
    const a = realDir();
    const b = realDir();
    const file = fixture(
      `${WITH_SITE}media:\n  libraries:\n    - name: drop\n      path: ${a}\n    # phone exports, unsorted\n    - name: keep\n      path: ${b}\n`,
    );
    expect(removeLibraryFromConfig(file, 'drop')).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/# phone exports, unsorted/);
    expect(parse(text).media.libraries.map((l: { name: string }) => l.name)).toEqual(['keep']);
  });

  it('keeps a comment on an unrelated top-level key', () => {
    const root = realDir();
    const file = fixture(
      `# the blog I actually write for\ndefault_site: personal\nsites: {}\nmedia:\n  libraries:\n    - name: drop\n      path: ${root}\n`,
    );
    removeLibraryFromConfig(file, 'drop');
    expect(readFileSync(file, 'utf8')).toMatch(/# the blog I actually write for/);
  });
});

describe('addLibraryToConfig — index_path', () => {
  it('writes index_path when one is given', () => {
    const file = fixture(WITH_SITE);
    const idx = realDir();
    addLibraryToConfig(file, { name: 'shots', path: realDir(), indexPath: idx });
    expect(parse(readFileSync(file, 'utf8')).media.libraries[0].index_path).toBe(idx);
  });

  it('omits index_path entirely when none is given', () => {
    const file = fixture(WITH_SITE);
    addLibraryToConfig(file, { name: 'shots', path: realDir() });
    expect(parse(readFileSync(file, 'utf8')).media.libraries[0].index_path).toBeUndefined();
  });

  // Byline never writes inside a user's library folder. `loadMedia` refuses such
  // a config at load; refusing it at WRITE time too means the CLI cannot create
  // the broken config in the first place, rather than writing one that reports
  // itself unavailable on the next command.
  it('refuses an index path equal to the library path, and writes nothing', () => {
    const file = fixture(WITH_SITE);
    const root = realDir();
    const before = readFileSync(file, 'utf8');
    try {
      addLibraryToConfig(file, { name: 'shots', path: root, indexPath: root });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('INDEX_PATH_INSIDE_LIBRARY');
      expect((e as ToolError).message).toMatch(/never write/i);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses an index path nested inside the library path', () => {
    const file = fixture(WITH_SITE);
    const root = realDir();
    try {
      addLibraryToConfig(file, { name: 'shots', path: root, indexPath: join(root, 'idx') });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('INDEX_PATH_INSIDE_LIBRARY');
    }
  });

  it('allows a sibling directory whose name merely starts the same', () => {
    const file = fixture(WITH_SITE);
    const root = realDir();
    addLibraryToConfig(file, { name: 'shots', path: root, indexPath: `${root}-backup` });
    expect(parse(readFileSync(file, 'utf8')).media.libraries[0].index_path).toBe(`${root}-backup`);
  });
});
