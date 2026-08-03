import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolvePaths } from '../../src/config/paths.js';

const HOME = '/home/tester';
const CWD = '/work/project';
const none = () => false;

describe('resolvePaths', () => {
  it('prefers $BYLINE_HOME over everything', () => {
    const p = resolvePaths({ BYLINE_HOME: '/custom' }, HOME, CWD, () => true);
    expect(p.source).toBe('env');
    expect(p.home).toBe('/custom');
    expect(p.configFile).toBe(join('/custom', 'config.yaml'));
    expect(p.personasDir).toBe(join('/custom', 'personas'));
    expect(p.envFile).toBe(join('/custom', '.env'));
    expect(p.runsDir).toBe(join('/custom', 'runs'));
  });

  it('uses ~/.byline when it exists', () => {
    const exists = (path: string) => path === join(HOME, '.byline');
    const p = resolvePaths({}, HOME, CWD, exists);
    expect(p.source).toBe('home');
    expect(p.configFile).toBe(join(HOME, '.byline', 'config.yaml'));
  });

  it('falls back to the repo checkout when only config/sites.yaml exists', () => {
    const exists = (path: string) => path === join(CWD, 'config', 'sites.yaml');
    const p = resolvePaths({}, HOME, CWD, exists);
    expect(p.source).toBe('repo');
    // The dev checkout keeps its historical layout, not the installed one.
    expect(p.configFile).toBe(join(CWD, 'config', 'sites.yaml'));
    expect(p.runsDir).toBe(join(CWD, '.runs'));
  });

  it('prefers ~/.byline over the repo when both exist', () => {
    const exists = (path: string) =>
      path === join(HOME, '.byline') || path === join(CWD, 'config', 'sites.yaml');
    expect(resolvePaths({}, HOME, CWD, exists).source).toBe('home');
  });

  it('defaults to ~/.byline when nothing exists yet', () => {
    const p = resolvePaths({}, HOME, CWD, none);
    expect(p.source).toBe('home');
    expect(p.home).toBe(join(HOME, '.byline'));
  });

  it('lets per-path env overrides win over the resolved base', () => {
    const p = resolvePaths(
      {
        BYLINE_SITES: '/x/sites.yaml',
        BYLINE_PERSONAS: '/x/personas',
        BYLINE_ENV: '/x/.env',
        BYLINE_RUNS: '/x/runs',
      },
      HOME,
      CWD,
      none,
    );
    expect(p.configFile).toBe('/x/sites.yaml');
    expect(p.personasDir).toBe('/x/personas');
    expect(p.envFile).toBe('/x/.env');
    expect(p.runsDir).toBe('/x/runs');
  });

  it('reports every field as coming from the base when no per-path override is set', () => {
    const exists = (path: string) => path === join(HOME, '.byline');
    const p = resolvePaths({}, HOME, CWD, exists);
    for (const field of ['configFile', 'personasDir', 'envFile', 'runsDir'] as const) {
      expect(p.provenance[field].source).toBe('home');
      expect(p.provenance[field].via).toBeUndefined();
      expect(p.provenance[field].path).toBe(p[field]);
    }
  });

  it('marks only the overridden field as an override, naming the variable', () => {
    const p = resolvePaths(
      { BYLINE_HOME: '/custom', BYLINE_SITES: '/elsewhere/sites.yaml' },
      HOME,
      CWD,
      () => true,
    );
    // The BASE was resolved from $BYLINE_HOME...
    expect(p.source).toBe('env');
    // ...but the config file did not come from it, and saying "env" for that
    // field is exactly the lie this provenance exists to prevent.
    expect(p.provenance.configFile).toEqual({
      path: '/elsewhere/sites.yaml',
      source: 'override',
      via: 'BYLINE_SITES',
    });
    expect(p.provenance.personasDir.source).toBe('env');
    expect(p.provenance.envFile.source).toBe('env');
    expect(p.provenance.runsDir.source).toBe('env');
  });

  it('names each per-path override variable', () => {
    const p = resolvePaths(
      {
        BYLINE_SITES: '/a.yaml',
        BYLINE_PERSONAS: '/b',
        BYLINE_ENV: '/c.env',
        BYLINE_RUNS: '/d',
      },
      HOME,
      CWD,
      none,
    );
    expect(p.provenance.configFile.via).toBe('BYLINE_SITES');
    expect(p.provenance.personasDir.via).toBe('BYLINE_PERSONAS');
    expect(p.provenance.envFile.via).toBe('BYLINE_ENV');
    expect(p.provenance.runsDir.via).toBe('BYLINE_RUNS');
  });

  it('reports the repo branch per field when the dev checkout matched', () => {
    const exists = (path: string) => path === join(CWD, 'config', 'sites.yaml');
    const p = resolvePaths({}, HOME, CWD, exists);
    expect(p.provenance.configFile).toEqual({
      path: join(CWD, 'config', 'sites.yaml'),
      source: 'repo',
    });
    expect(p.provenance.runsDir.path).toBe(join(CWD, '.runs'));
  });
});

// The rename from writeblogs → byline must not orphan an existing install.
// A user with a working ~/.writeblogs/ (four sites, live keys, five MCP
// registrations) has to keep working untouched until they choose to move.
describe('pre-rename config keeps working', () => {
  const home = '/home/u';
  const legacy = `${home}/.writeblogs`;
  const current = `${home}/.byline`;

  it('reads ~/.writeblogs when ~/.byline does not exist yet, and says so', () => {
    const p = resolvePaths({}, home, '/tmp', (path) => path === legacy);
    expect(p.home).toBe(legacy);
    // A distinct source, not folded into `home` — status/doctor surface it and
    // point at migrate, rather than silently reading a directory whose name no
    // longer matches the product.
    expect(p.source).toBe('legacy');
    expect(p.configFile).toBe(`${legacy}/config.yaml`);
  });

  it('prefers ~/.byline once it exists, without touching the old one', () => {
    const p = resolvePaths({}, home, '/tmp', (path) => path === legacy || path === current);
    expect(p.home).toBe(current);
    expect(p.source).toBe('home');
  });

  it('honours a legacy WRITEBLOGS_HOME and reports the variable the user actually set', () => {
    const p = resolvePaths({ WRITEBLOGS_HOME: '/custom' }, home, '/tmp', () => false);
    expect(p.home).toBe('/custom');
    expect(p.source).toBe('env');
  });

  it('lets BYLINE_HOME win when both are set', () => {
    const p = resolvePaths(
      { BYLINE_HOME: '/new', WRITEBLOGS_HOME: '/old' },
      home, '/tmp', () => false,
    );
    expect(p.home).toBe('/new');
  });

  it('names the legacy variable in provenance when that is the one that is set', () => {
    // Printing BYLINE_SITES at someone who set WRITEBLOGS_SITES would send them
    // hunting for a variable that is not in their environment.
    const p = resolvePaths({ WRITEBLOGS_SITES: '/x/s.yaml' }, home, '/tmp', () => false);
    expect(p.provenance.configFile.via).toBe('WRITEBLOGS_SITES');
    expect(p.provenance.configFile.source).toBe('override');
  });

  it('names the new variable when the new one is set', () => {
    const p = resolvePaths({ BYLINE_SITES: '/x/s.yaml' }, home, '/tmp', () => false);
    expect(p.provenance.configFile.via).toBe('BYLINE_SITES');
  });

  it('creates ~/.byline, not ~/.writeblogs, on a machine with neither', () => {
    const p = resolvePaths({}, home, '/tmp', () => false);
    expect(p.home).toBe(current);
    expect(p.source).toBe('home');
  });
});
