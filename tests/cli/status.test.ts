import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext } from '../../src/context.js';
import { collectStatus } from '../../src/cli/status.js';

let home: string;
let fakeHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wb-status-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'wb-fakehome-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('collectStatus', () => {
  it('works with no configuration at all — the state that makes someone reach for it', () => {
    const ctx = loadContext({ BYLINE_HOME: home });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    expect(data.configured).toBe(false);
    expect(data.sites).toEqual([]);
    expect(data.personas).toEqual([]);
    expect(data.paths).toHaveLength(4);
  });

  it('reports per-field provenance, not one global source', () => {
    const elsewhere = join(fakeHome, 'somewhere-else.yaml');
    writeFileSync(elsewhere, 'sites: {}\n');
    const ctx = loadContext({ BYLINE_HOME: home, BYLINE_SITES: elsewhere });
    const data = collectStatus(ctx, fakeHome, fakeHome);

    const config = data.paths.find((p) => p.label === 'config')!;
    const personas = data.paths.find((p) => p.label === 'personas')!;

    // The base came from $BYLINE_HOME, but the config file did NOT — and
    // saying "env" for both is exactly the lie this replaces.
    expect(data.baseSource).toBe('env');
    expect(config.source).toBe('override');
    expect(config.via).toBe('BYLINE_SITES');
    expect(config.path).toBe(elsewhere);
    expect(personas.source).toBe('env');
    expect(personas.via).toBeUndefined();
  });

  it('lists a configured site and marks one with a missing key as unusable, with the reason', () => {
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'default_site: good',
        'sites:',
        '  good:',
        '    platform: ghost',
        '    url: https://good.example.com',
        '    admin_api_key: ${WB_STATUS_GOOD_KEY}',
        '  bad:',
        '    platform: ghost',
        '    url: https://bad.example.com',
        '    admin_api_key: ${WB_STATUS_MISSING_KEY}',
        '',
      ].join('\n'),
    );
    const ctx = loadContext({ BYLINE_HOME: home, WB_STATUS_GOOD_KEY: 'id:secret' });
    const data = collectStatus(ctx, fakeHome, fakeHome);

    expect(data.configured).toBe(true);
    const good = data.sites.find((s) => s.slug === 'good')!;
    const bad = data.sites.find((s) => s.slug === 'bad')!;
    expect(good.usable).toBe(true);
    expect(bad.usable).toBe(false);
    expect(bad.reason).toContain('WB_STATUS_MISSING_KEY');
  });

  it('never leaks a credential value', () => {
    writeFileSync(
      join(home, 'config.yaml'),
      'sites:\n  s:\n    platform: ghost\n    url: https://x.com\n    admin_api_key: ${WB_SECRETY}\n',
    );
    const ctx = loadContext({ BYLINE_HOME: home, WB_SECRETY: 'super-secret-value' });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    expect(JSON.stringify(data)).not.toContain('super-secret-value');
  });

  it('names each image provider and whether its key is set, from the provider itself', () => {
    const ctx = loadContext({ BYLINE_HOME: home, GEMINI_API_KEY: 'k' });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    const gemini = data.imageProviders.find((p) => p.name === 'gemini')!;
    const grok = data.imageProviders.find((p) => p.name === 'grok')!;
    expect(gemini.configured).toBe(true);
    expect(gemini.envVar).toBe('GEMINI_API_KEY');
    expect(grok.configured).toBe(false);
  });

  // Task 6: the research family (Brave + Tavily) is wired into `status`
  // through the same `providers` array `imageProviders` used to be the only
  // consumer of. Nothing before this asserted the research entry actually
  // shows up, or that both providers are listed with their own envVar/
  // configured pair — only `providerFamilies()` in isolation was tested.
  it('adds a research family to providers, listing both brave and tavily with envVar and configured', () => {
    const ctx = loadContext({ BYLINE_HOME: home, TAVILY_API_KEY: 'k' });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    const research = data.providers.find((f) => f.family === 'research')!;
    expect(research).toBeDefined();
    expect(research.label.length).toBeGreaterThan(0);
    const brave = research.providers.find((p) => p.name === 'brave')!;
    const tavily = research.providers.find((p) => p.name === 'tavily')!;
    expect(brave).toBeDefined();
    expect(brave.envVar).toBe('BRAVE_API_KEY');
    expect(brave.configured).toBe(false);
    expect(tavily).toBeDefined();
    expect(tavily.envVar).toBe('TAVILY_API_KEY');
    expect(tavily.configured).toBe(true);
  });

  // `imageProviders` is "consumed output" per the comment in status.ts — kept
  // exactly as it was so nothing reading it breaks, with `providers` as the
  // additive replacement. Prove the addition really is additive: with every
  // image AND research key set, imageProviders must still contain exactly the
  // two image providers, under their original names, and nothing from the
  // research family.
  it('keeps imageProviders unchanged and images-only even once research providers are configured', () => {
    const ctx = loadContext({
      BYLINE_HOME: home,
      GEMINI_API_KEY: 'g-key',
      BRAVE_API_KEY: 'b-key',
      TAVILY_API_KEY: 't-key',
    });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    expect(data.imageProviders).toEqual([
      { name: 'gemini', configured: true, envVar: 'GEMINI_API_KEY' },
      { name: 'grok', configured: false, envVar: 'XAI_API_KEY' },
    ]);
    expect(data.imageProviders.some((p) => p.name === 'brave' || p.name === 'tavily')).toBe(false);
  });

  it('reports which AI tools have byline registered', () => {
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ mcpServers: { byline: {} } }));
    const ctx = loadContext({ BYLINE_HOME: home });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    const claude = data.registrations.find((r) => r.label === 'Claude Code')!;
    expect(claude.registered).toBe(true);
    expect(claude.scope).toBe('global');
    expect(data.registrations.find((r) => r.label === 'Cursor')!.registered).toBe(false);
  });

  // Finding 4: `register --scope project` writes <cwd>/.mcp.json and
  // <cwd>/.cursor/mcp.json, and Claude Code separately supports a
  // project-scoped ("local") registration stored INSIDE ~/.claude.json itself,
  // under `projects[<cwd>].mcpServers` — which is where the maintainer's own
  // registration actually lived. The old check only ever looked at the global
  // file's top-level `mcpServers`, so both of these reported "not registered"
  // even though byline was, in fact, registered.

  it('detects a project-scoped Claude Code registration stored under projects[<cwd>].mcpServers in the global file — no coverage before Finding 4', () => {
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ projects: { [fakeHome]: { mcpServers: { byline: {} } } } }),
    );
    const ctx = loadContext({ BYLINE_HOME: home });
    // Both `home` and `cwd` are `fakeHome` here, matching the key under `projects`.
    const data = collectStatus(ctx, fakeHome, fakeHome);
    const claude = data.registrations.find((r) => r.label === 'Claude Code')!;
    expect(claude.registered).toBe(true);
    expect(claude.scope).toBe('project');
    expect(claude.file).toBe(join(fakeHome, '.claude.json'));
  });

  it('detects a project-scope registration written to <cwd>/.cursor/mcp.json by `register --scope project`', () => {
    // A distinct `cwd` from `home` matters: cursor's global path is
    // <home>/.cursor/mcp.json and its project path is <cwd>/.cursor/mcp.json —
    // using the same directory for both would collapse them into one file and
    // this would pass even with the OLD (global-only) check.
    const projectCwd = mkdtempSync(join(tmpdir(), 'wb-fakecwd-'));
    const projectFile = join(projectCwd, '.cursor', 'mcp.json');
    mkdirSync(join(projectCwd, '.cursor'), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ mcpServers: { byline: {} } }));
    try {
      const ctx = loadContext({ BYLINE_HOME: home });
      const data = collectStatus(ctx, fakeHome, projectCwd);
      const cursor = data.registrations.find((r) => r.label === 'Cursor')!;
      expect(cursor.registered).toBe(true);
      expect(cursor.scope).toBe('project');
      expect(cursor.file).toBe(projectFile);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('still reports "not registered" when neither global, project-stanza, nor project-file names byline', () => {
    const ctx = loadContext({ BYLINE_HOME: home });
    const data = collectStatus(ctx, fakeHome, fakeHome);
    const claude = data.registrations.find((r) => r.label === 'Claude Code')!;
    expect(claude.registered).toBe(false);
    expect(claude.scope).toBeUndefined();
  });
});
