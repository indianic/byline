import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContext } from '../src/context.js';

const SITES = `
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PROBE_GHOST_KEY}
`;

const PERSONA = `
slug: jane-doe
name: Jane Doe
role: CTO
writing_style: Analytical
tone_of_voice: Dry
platform_authors: {}
`;

function scaffold(envBody: string): { sitesFile: string; personasDir: string; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  const sitesFile = join(dir, 'sites.yaml');
  writeFileSync(sitesFile, SITES);
  const personasDir = mkdtempSync(join(tmpdir(), 'wb-ep-'));
  writeFileSync(join(personasDir, 'jane-doe.yaml'), PERSONA);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, envBody);
  return { sitesFile, personasDir, envFile };
}

const saved = { ...process.env };
afterEach(() => {
  // Restore PER KEY. `process.env = { ...saved }` replaces the object, which
  // silently DETACHES it from the process's native environment: writes to the
  // replacement never reach the real environ, so `os.homedir()` (which reads
  // $HOME natively, not through this object) goes stale for the remainder of
  // the process — every later test file in the same worker included.
  //
  // This suite was safe only by accident: it drives paths through
  // BYLINE_* overrides and never reads homedir() after its afterEach. The
  // footgun was found in phase 4 and reproduced independently in plain Node,
  // outside vitest. `tests/cli/doctor.test.ts` restores per key for the same
  // reason. The final test in this file asserts the binding is still live.
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
});

describe('loadContext', () => {
  it('reads keys out of .env — an MCP server inherits no shell exports', () => {
    const { sitesFile, personasDir, envFile } = scaffold('PROBE_GHOST_KEY=abc:def\n');
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = envFile;
    delete process.env.PROBE_GHOST_KEY;

    const ctx = loadContext();
    expect(ctx.sites.sites.personal?.credentials.admin_api_key).toBe('abc:def');
    expect(ctx.sites.sites.personal?.unavailable).toBeUndefined();
  });

  it('lets an already-set environment variable win over the file', () => {
    const { sitesFile, personasDir, envFile } = scaffold('PROBE_GHOST_KEY=from:file\n');
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = envFile;
    process.env.PROBE_GHOST_KEY = 'from:env';

    expect(loadContext().sites.sites.personal?.credentials.admin_api_key).toBe('from:env');
  });

  it('survives a missing .env and reports the site as unavailable', () => {
    const { sitesFile, personasDir } = scaffold('');
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = '/nonexistent/.env';
    delete process.env.PROBE_GHOST_KEY;

    expect(loadContext().sites.sites.personal?.unavailable).toContain('PROBE_GHOST_KEY');
  });

  it('records a problem instead of throwing when the config is missing', () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-ctx-')) });
    expect(ctx.setup.configured).toBe(false);
    expect(ctx.setup.problems.length).toBeGreaterThan(0);
  });

  // Finding 6: a `ToolError`'s `hint` never survived `loadContext`'s catch —
  // only `.message` was pushed into `problems` — so a fresh user with no
  // config at all saw a bare "Cannot read site config at …" with no fix
  // attached, even though the fix (`byline init`) was sitting right there
  // in the hint the whole time.
  it('folds a config-load failure\'s hint into the problem message, not just its bare message', () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-ctx-hint-')) });
    const problem = ctx.setup.problems.find((p) => p.includes('Cannot read site config'));
    expect(problem).toBeDefined();
    expect(problem).toMatch(/init/);
  });

  // Regression (LEAK 5): `configuredImageProviders` used to hardcode
  // `GEMINI_API_KEY`/`XAI_API_KEY` directly instead of asking each image
  // provider whether it is configured. These assert the setup state is
  // actually derived from the providers (both empty, one configured, both
  // configured), which would break if a provider's own env var name ever
  // changed without a matching edit here.
  describe('imageProviders', () => {
    it('lists no providers when neither key is set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-imgnone-'));
      const env = { BYLINE_HOME: home } as NodeJS.ProcessEnv;
      delete env.GEMINI_API_KEY;
      delete env.XAI_API_KEY;
      expect(loadContext(env).setup.imageProviders).toEqual([]);
    });

    it('lists gemini when only GEMINI_API_KEY is set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-imggem-'));
      const env = { BYLINE_HOME: home, GEMINI_API_KEY: 'g-key' } as NodeJS.ProcessEnv;
      delete env.XAI_API_KEY;
      expect(loadContext(env).setup.imageProviders).toEqual(['gemini']);
    });

    it('lists both when both keys are set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-imgboth-'));
      const env = {
        BYLINE_HOME: home,
        GEMINI_API_KEY: 'g-key',
        XAI_API_KEY: 'x-key',
      } as NodeJS.ProcessEnv;
      expect(loadContext(env).setup.imageProviders).toEqual(['gemini', 'grok']);
    });
  });

  // Task 6: `researchProviders` mirrors `imageProviders` — derived from each
  // research provider's own `configured()` rather than a second hardcoded
  // list of env var names in this file. Before this, only
  // `providerFamilies()` in isolation (tests/plugins/providers.test.ts) was
  // covered; nothing asserted `ctx.setup.researchProviders` itself, which is
  // the field `requireSetup` and any future research gate would actually
  // read.
  describe('researchProviders', () => {
    it('lists no providers when neither key is set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-resnone-'));
      const env = { BYLINE_HOME: home } as NodeJS.ProcessEnv;
      delete env.BRAVE_API_KEY;
      delete env.TAVILY_API_KEY;
      expect(loadContext(env).setup.researchProviders).toEqual([]);
    });

    it('lists brave when only BRAVE_API_KEY is set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-resbrave-'));
      const env = { BYLINE_HOME: home, BRAVE_API_KEY: 'b-key' } as NodeJS.ProcessEnv;
      delete env.TAVILY_API_KEY;
      expect(loadContext(env).setup.researchProviders).toEqual(['brave']);
    });

    it('lists both when both keys are set', () => {
      const home = mkdtempSync(join(tmpdir(), 'wb-ctx-resboth-'));
      const env = {
        BYLINE_HOME: home,
        BRAVE_API_KEY: 'b-key',
        TAVILY_API_KEY: 't-key',
      } as NodeJS.ProcessEnv;
      expect(loadContext(env).setup.researchProviders).toEqual(['brave', 'tavily']);
    });
  });
});

// Deliberately last in the file: it can only detect the damage after this
// suite's afterEach has already run at least once.
describe("this suite's own env handling", () => {
  it('leaves process.env attached to the native environment, so os.homedir() stays live', () => {
    // `process.env = { ...saved }` in an afterEach replaces the object and
    // detaches it from the real environ. os.homedir() reads $HOME natively, so
    // after such a reassignment it returns whatever $HOME was at the moment of
    // detachment and never updates again — for the rest of the process, across
    // every later test file in the same worker. That makes any test which sets
    // HOME to a temp directory silently exercise the developer's real home.
    //
    // Restoring per key keeps the binding live, which is exactly what this
    // asserts. Mutation-tested: swapping the afterEach back to the wholesale
    // reassignment makes this fail.
    const realHome = process.env.HOME;
    try {
      const probe = mkdtempSync(join(tmpdir(), 'wb-homedir-probe-'));
      process.env.HOME = probe;
      expect(homedir()).toBe(probe);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
    expect(homedir()).toBe(realHome);
  });
});
