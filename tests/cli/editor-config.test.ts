import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EDITORS,
  detectInstalledEditors,
  mergeCodexToml,
  mergeJsonMcpServers,
  resolveTools,
  writeEditorConfig,
} from '../../src/cli/editor-config.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wb-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('EDITORS', () => {
  it('covers the five supported AI tools', () => {
    expect(EDITORS.map((e) => e.id).sort()).toEqual(['claude', 'codex', 'cursor', 'gemini', 'windsurf']);
  });

  it('uses the verified config path for each tool', () => {
    const path = (id: string) => EDITORS.find((e) => e.id === id)!.path('global', cwd, home);
    expect(path('claude')).toBe(join(home, '.claude.json'));
    expect(path('cursor')).toBe(join(home, '.cursor', 'mcp.json'));
    expect(path('windsurf')).toBe(join(home, '.codeium', 'windsurf', 'mcp_config.json'));
    expect(path('gemini')).toBe(join(home, '.gemini', 'settings.json'));
    expect(path('codex')).toBe(join(home, '.codex', 'config.toml'));
  });
});

describe('detectInstalledEditors', () => {
  it('finds nothing on a machine with no AI tools', () => {
    expect(detectInstalledEditors(home, cwd)).toEqual([]);
  });

  it('finds only the tools whose config file actually exists', () => {
    writeFileSync(join(home, '.claude.json'), '{}');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '');
    expect(detectInstalledEditors(home, cwd).map((e) => e.id).sort()).toEqual(['claude', 'codex']);
  });
});

describe('mergeJsonMcpServers', () => {
  it('creates mcpServers when absent and leaves other top-level keys alone', () => {
    const merged = mergeJsonMcpServers({ theme: 'dark' });
    expect(merged.theme).toBe('dark');
    expect((merged.mcpServers as Record<string, unknown>).byline).toEqual({
      command: 'npx',
      args: ['-y', '@indianic/byline'],
    });
  });

  it('leaves every other server untouched', () => {
    const merged = mergeJsonMcpServers({ mcpServers: { mailman: { command: 'npx', args: ['-y', '@indianic/mailman'] } } });
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.mailman).toEqual({ command: 'npx', args: ['-y', '@indianic/mailman'] });
    expect(servers.byline).toBeDefined();
  });

  it('is idempotent', () => {
    const once = mergeJsonMcpServers({});
    expect(mergeJsonMcpServers(once)).toEqual(once);
  });
});

describe('mergeCodexToml', () => {
  it('appends a block to an empty config', () => {
    expect(mergeCodexToml('')).toContain('[mcp_servers.byline]');
  });

  it('replaces rather than duplicates on re-run', () => {
    const once = mergeCodexToml('');
    const twice = mergeCodexToml(once);
    expect(twice.match(/\[mcp_servers\.byline\]/g)).toHaveLength(1);
    expect(twice.trim()).toBe(once.trim());
  });

  it('preserves unrelated mcp_servers entries', () => {
    const existing = '[mcp_servers.mailman]\ncommand = "npx"\nargs = ["-y", "@indianic/mailman"]\n';
    const merged = mergeCodexToml(existing);
    expect(merged).toContain('[mcp_servers.mailman]');
    expect(merged).toContain('[mcp_servers.byline]');
  });
});

describe('writeEditorConfig', () => {
  it('creates a config that did not exist, with no backup', () => {
    const editor = EDITORS.find((e) => e.id === 'cursor')!;
    const result = writeEditorConfig(editor, 'global', cwd, home);
    expect(result.action).toBe('created');
    expect(result.backup).toBeUndefined();
    const written = JSON.parse(readFileSync(result.file, 'utf8')) as Record<string, unknown>;
    expect((written.mcpServers as Record<string, unknown>).byline).toBeDefined();
  });

  it('backs up an existing config before editing it', () => {
    const file = join(home, '.claude.json');
    writeFileSync(file, JSON.stringify({ projects: { a: 1 } }));
    const editor = EDITORS.find((e) => e.id === 'claude')!;
    const result = writeEditorConfig(editor, 'global', cwd, home);
    expect(result.action).toBe('updated');
    expect(result.backup).toBe(`${file}.byline-bak`);
    // The backup holds the PRE-EDIT content — that is the whole point.
    expect(JSON.parse(readFileSync(result.backup!, 'utf8'))).toEqual({ projects: { a: 1 } });
    // ...and the user's own keys survived the merge.
    expect(JSON.parse(readFileSync(file, 'utf8')).projects).toEqual({ a: 1 });
  });

  it('refuses to guess at a config file that is not valid JSON', () => {
    writeFileSync(join(home, '.claude.json'), '{not json');
    const editor = EDITORS.find((e) => e.id === 'claude')!;
    expect(() => writeEditorConfig(editor, 'global', cwd, home)).toThrow(/isn't valid JSON/);
  });

  it('ignores project scope for user-level-only tools', () => {
    const editor = EDITORS.find((e) => e.id === 'gemini')!;
    const result = writeEditorConfig(editor, 'project', cwd, home);
    expect(result.file).toBe(join(home, '.gemini', 'settings.json'));
  });
});

describe('resolveTools', () => {
  // Finding 3: `all` used to mean literally every supported editor id,
  // regardless of what is actually installed — so `register --tools all` on a
  // Claude-Code-only machine created configs from nothing for Gemini,
  // Windsurf, and Codex. These assert `all` now means "every tool
  // `detectInstalledEditors` actually finds", the same check `init` uses.

  it('resolves "all" to only the tools actually detected on this machine', () => {
    expect(resolveTools('all', home, cwd)).toEqual([]);

    writeFileSync(join(home, '.claude.json'), '{}');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '');
    expect(resolveTools('all', home, cwd).sort()).toEqual(['claude', 'codex']);
  });

  it('honours an explicitly named tool even when undetected — naming it asserts it exists', () => {
    // Nothing is installed in `home`/`cwd` here, unlike the "all" case above.
    expect(resolveTools('codex', home, cwd)).toEqual(['codex']);
  });

  it('resolves a stray `--tools` with no value to nothing, not to "all"', () => {
    // A missing spec used to fall through to the same branch as "all" and
    // silently register every tool — worse than registering none.
    expect(resolveTools(undefined, home, cwd)).toEqual([]);
  });

  it('drops unknown names', () => {
    expect(resolveTools('claude,notatool,codex')).toEqual(['claude', 'codex']);
  });
});
