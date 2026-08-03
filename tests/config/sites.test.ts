import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { getSite, loadSites, usableSites } from '../../src/config/sites.js';

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sites-'));
  const file = join(dir, 'sites.yaml');
  writeFileSync(file, yaml);
  return file;
}

const VALID = `
default_site: personal
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PERSONAL_GHOST_KEY}
    default_author: jordan-reyes
`;

describe('loadSites', () => {
  it('resolves ${VAR} from the supplied environment', () => {
    const cfg = loadSites(fixture(VALID), { PERSONAL_GHOST_KEY: 'abc:def' });
    expect(cfg.sites.personal?.credentials.admin_api_key).toBe('abc:def');
    expect(cfg.sites.personal?.slug).toBe('personal');
    expect(cfg.sites.personal?.defaultAuthor).toBe('jordan-reyes');
    expect(cfg.defaultSite).toBe('personal');
  });

  it('derives the admin endpoint from url when api_url is absent', () => {
    const cfg = loadSites(fixture(VALID), { PERSONAL_GHOST_KEY: 'abc:def' });
    expect(cfg.sites.personal?.apiUrl).toBe('https://blog.example.com/ghost/api/admin');
  });

  it('uses an explicit api_url when the admin API lives elsewhere', () => {
    const y = `
sites:
  personal:
    platform: ghost
    url: https://www.example.com
    api_url: https://cms.example.com/ghost/api/admin
    admin_api_key: \${PERSONAL_GHOST_KEY}
`;
    const cfg = loadSites(fixture(y), { PERSONAL_GHOST_KEY: 'abc:def' });
    expect(cfg.sites.personal?.url).toBe('https://www.example.com');
    expect(cfg.sites.personal?.apiUrl).toBe('https://cms.example.com/ghost/api/admin');
  });

  it('strips a trailing slash from an explicit api_url', () => {
    const y = `
sites:
  personal:
    platform: ghost
    url: https://www.example.com
    api_url: https://cms.example.com/ghost/api/admin/
    admin_api_key: \${PERSONAL_GHOST_KEY}
`;
    expect(loadSites(fixture(y), { PERSONAL_GHOST_KEY: 'x:y' }).sites.personal?.apiUrl).toBe(
      'https://cms.example.com/ghost/api/admin',
    );
  });

  it('strips a trailing slash from the site url', () => {
    const y = VALID.replace('https://blog.example.com', 'https://blog.example.com/');
    const cfg = loadSites(fixture(y), { PERSONAL_GHOST_KEY: 'abc:def' });
    expect(cfg.sites.personal?.url).toBe('https://blog.example.com');
  });

  it('marks a site unavailable rather than throwing when its env var is missing', () => {
    const cfg = loadSites(fixture(VALID), {});
    expect(cfg.sites.personal?.unavailable).toContain('PERSONAL_GHOST_KEY');
    expect(cfg.sites.personal?.credentials.admin_api_key).toBe('');
  });

  // Regression (LEAK 2): the missing-variable message used to hardcode
  // Ghost's `<id:secret>` credential shape for every platform. A WordPress
  // site missing its app_password env var must be told to set it to an
  // Application Password shape, not to a Ghost admin key shape.
  it("uses the missing field's own example, not Ghost's <id:secret>, for a WordPress site", () => {
    const y = `
sites:
  mywp:
    platform: wordpress
    url: https://example.com
    username: editor
    app_password: \${MYWP_APP_PASSWORD}
`;
    const cfg = loadSites(fixture(y), {});
    expect(cfg.sites.mywp?.unavailable).toContain('MYWP_APP_PASSWORD');
    expect(cfg.sites.mywp?.unavailable).not.toContain('<id:secret>');
    expect(cfg.sites.mywp?.unavailable).toContain('xxxx xxxx xxxx xxxx xxxx xxxx');
  });

  it("still uses Ghost's own id:secret example for a Ghost site missing its admin_api_key", () => {
    const cfg = loadSites(fixture(VALID), {});
    expect(cfg.sites.personal?.unavailable).toContain('PERSONAL_GHOST_KEY=id:secret');
  });

  it('names each missing variable with its own field example when several are missing at once', () => {
    // `${VAR}` indirection isn't limited to `secret` fields — username isn't
    // secret, but referencing it via an env var is still valid YAML the
    // resolver has to handle. Both are unset here, so the message must pair
    // MYWP_USERNAME with username's own example ('editor') and
    // MYWP_APP_PASSWORD with app_password's own example, not swap them or
    // fall back to a single shared placeholder.
    const y = `
sites:
  mywp:
    platform: wordpress
    url: https://example.com
    username: \${MYWP_USERNAME}
    app_password: \${MYWP_APP_PASSWORD}
`;
    const cfg = loadSites(fixture(y), {});
    const msg = cfg.sites.mywp?.unavailable ?? '';
    expect(msg).toContain('MYWP_USERNAME');
    expect(msg).toContain('MYWP_APP_PASSWORD');
    expect(msg).toContain('MYWP_USERNAME=editor');
    expect(msg).toContain('MYWP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx');
  });

  it('keeps configured sites usable when a sibling site has no key', () => {
    const two = `
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PERSONAL_GHOST_KEY}
  indianic:
    platform: ghost
    url: https://www.indianic.com
    admin_api_key: \${INDIANIC_GHOST_KEY}
`;
    const cfg = loadSites(fixture(two), { PERSONAL_GHOST_KEY: 'abc:def' });
    expect(usableSites(cfg)).toEqual(['personal']);
    expect(getSite(cfg, 'personal').credentials.admin_api_key).toBe('abc:def');
    expect(() => getSite(cfg, 'indianic')).toThrowError(ToolError);
  });

  it('marks a site with an unknown platform unavailable instead of throwing', () => {
    const y = VALID.replace('platform: ghost', 'platform: nonexistent-platform-xyz');
    const cfg = loadSites(fixture(y), { PERSONAL_GHOST_KEY: 'x' });
    expect(cfg.sites.personal?.unavailable).toMatch(/nonexistent-platform-xyz/);
  });

  it('rejects a config with no sites', () => {
    expect(() => loadSites(fixture('sites: {}'), {})).toThrowError(ToolError);
  });

  it('marks a site declaring an unsupported platform unavailable, not the whole file', () => {
    const file = fixture(`
sites:
  x:
    platform: joomla
    url: https://example.com
    admin_api_key: \${K}
`);
    const cfg = loadSites(file, {});
    expect(cfg.sites.x?.unavailable).toMatch(/joomla/);
    expect(() => getSite(cfg, 'x')).toThrow(/joomla/);
  });

  it('marks a site with an unknown platform unavailable without breaking its siblings', () => {
    const file = fixture(`
sites:
  good:
    platform: ghost
    url: https://good.example.com
    admin_api_key: \${GOOD_KEY}
  future:
    platform: nonexistent-platform-xyz
    url: https://future.example.com
`);
    const cfg = loadSites(file, { GOOD_KEY: 'abc:def' });
    // The working site must survive. Rejecting the whole file for one unknown
    // platform took three live sites down when this was hand-edited.
    expect(cfg.sites.good?.unavailable).toBeUndefined();
    expect(usableSites(cfg)).toEqual(['good']);
    expect(cfg.sites.future?.unavailable).toMatch(/nonexistent-platform-xyz/);
    expect(cfg.sites.future?.unavailable).toMatch(/ghost/); // names what IS supported
  });

  it('still refuses the unknown-platform site at point of use', () => {
    const file = fixture(`
sites:
  future:
    platform: nonexistent-platform-xyz
    url: https://future.example.com
`);
    const cfg = loadSites(file, {});
    expect(() => getSite(cfg, 'future')).toThrow(/nonexistent-platform-xyz/);
  });

  it('rejects a ghost site with no admin_api_key', () => {
    const file = fixture(`
sites:
  x:
    platform: ghost
    url: https://example.com
`);
    expect(() => loadSites(file, {})).toThrow(/admin_api_key/);
  });

  it('reports a missing file with code CONFIG_NOT_FOUND', () => {
    try {
      loadSites('/nope/sites.yaml', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('CONFIG_NOT_FOUND');
    }
  });

  it('points a fresh user at `init`, not checkout-era advice to copy a repo file they do not have (Finding 6)', () => {
    try {
      loadSites('/nope/sites.yaml', {});
      expect.unreachable();
    } catch (e) {
      // The old hint ("Copy config/sites.yaml from the repo") assumed a
      // checkout, which a brand-new install by definition does not have.
      expect((e as ToolError).hint).toMatch(/init/);
      expect((e as ToolError).hint).not.toMatch(/repo/i);
    }
  });
});

describe('getSite', () => {
  const cfg = loadSites(fixture(VALID), { PERSONAL_GHOST_KEY: 'abc:def' });

  it('returns the named site', () => {
    expect(getSite(cfg, 'personal').url).toBe('https://blog.example.com');
  });

  it('lists valid slugs when the slug is unknown', () => {
    try {
      getSite(cfg, 'nope');
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('UNKNOWN_SITE');
      expect(err.message).toContain('personal');
    }
  });
});
