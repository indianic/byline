import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../../src/config/paths.js';
import { SLUG_RULE, loadSites } from '../../src/config/sites.js';
import {
  decideClosing,
  persistSite,
  promptSlug,
  promptUrl,
  readConfiguredSites,
  readConfiguredState,
} from '../../src/cli/init.js';
import type { Prompter } from '../../src/cli/credentials.js';
import { ensureHome } from '../../src/cli/home-config.js';
import { ghostPlugin } from '../../src/plugins/platforms/ghost/plugin.js';
import { wordpressPlugin } from '../../src/plugins/platforms/wordpress/plugin.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wb-init-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const paths = () => resolvePaths({ BYLINE_HOME: home }, '/nowhere', '/nowhere');

describe('persistSite', () => {
  it('puts the secret in .env and only a reference in config.yaml', () => {
    const p = paths();
    const result = persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://blog.example.com', values: { admin_api_key: 'id:secret' } },
      true,
    );

    const config = readFileSync(p.configFile, 'utf8');
    expect(config).toContain('admin_api_key: ${PERSONAL_ADMIN_API_KEY}');
    // The whole reason config.yaml is shareable.
    expect(config).not.toContain('id:secret');

    expect(readFileSync(p.envFile, 'utf8')).toContain('PERSONAL_ADMIN_API_KEY=id:secret');
    expect(result.envVars).toEqual(['PERSONAL_ADMIN_API_KEY']);
  });

  it('writes a non-secret field literally into config.yaml and keeps it out of .env', () => {
    const p = paths();
    persistSite(
      p,
      wordpressPlugin,
      {
        slug: 'wptest',
        platform: 'wordpress',
        url: 'https://blog.example.com',
        values: { username: 'editor', app_password: 'abcd EFGH ijkl MNOP' },
      },
      true,
    );

    const config = readFileSync(p.configFile, 'utf8');
    expect(config).toContain('username: editor');
    expect(config).toContain('app_password: ${WPTEST_APP_PASSWORD}');
    const env = readFileSync(p.envFile, 'utf8');
    expect(env).toContain('WPTEST_APP_PASSWORD="abcd EFGH ijkl MNOP"');
    expect(env).not.toContain('username');
  });

  it('produces a config the real loader accepts as usable — the only proof that matters', () => {
    // A site can be written with a perfectly plausible-looking ${VAR} that
    // loadSites never resolves, and it loads "usable" with an empty
    // credential. Round-tripping through the real loader is what catches that.
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'my-blog', platform: 'ghost', url: 'https://blog.example.com', values: { admin_api_key: 'id:secret' } },
      true,
    );
    const env: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(p.envFile, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"|"$/g, '');
    }
    const loaded = loadSites(p.configFile, env);
    expect(loaded.defaultSite).toBe('my-blog');
    expect(loaded.sites['my-blog']!.unavailable).toBeUndefined();
    expect(loaded.sites['my-blog']!.credentials.admin_api_key).toBe('id:secret');
  });

  it('adds a second site without unseating the first as default', () => {
    const p = paths();
    persistSite(p, ghostPlugin, { slug: 'first', platform: 'ghost', url: 'https://a.com', values: { admin_api_key: 'k1' } }, true);
    persistSite(p, ghostPlugin, { slug: 'second', platform: 'ghost', url: 'https://b.com', values: { admin_api_key: 'k2' } }, false);
    const config = readFileSync(p.configFile, 'utf8');
    expect(config).toContain('default_site: first');
    expect(config).toContain('first:');
    expect(config).toContain('second:');
  });
});

describe('decideClosing', () => {
  // Finding 1: `init`'s closing branch used to ask only `added.length === 0` —
  // this session's loop — and so told a user who had just migrated a fully
  // working config.yaml that "no blog is configured", contradicting the file
  // list printed seconds earlier. These assert the decision now comes from
  // what is actually on disk (`ConfiguredState`), not from that flag.

  it('reports ready and names a usable site even when this session added none — the migration case', () => {
    // This is exactly Finding 1's scenario: a migration lands usable sites,
    // the user declines to add another one this run, so `added` stays empty.
    const closing = decideClosing({ siteCount: 2, usableSites: ['personal', 'work'] }, []);
    expect(closing).toEqual({ kind: 'ready', site: 'personal' });
  });

  it('prefers a site this session actually added, when it is among the usable ones', () => {
    const closing = decideClosing({ siteCount: 2, usableSites: ['personal', 'work'] }, ['work']);
    expect(closing).toEqual({ kind: 'ready', site: 'work' });
  });

  it('reports unusable — not "no blog configured" — when sites exist but none work', () => {
    const closing = decideClosing({ siteCount: 1, usableSites: [] }, []);
    expect(closing).toEqual({ kind: 'unusable' });
  });

  it('reports none only when nothing is declared at all', () => {
    const closing = decideClosing({ siteCount: 0, usableSites: [] }, []);
    expect(closing).toEqual({ kind: 'none' });
  });
});

describe('readConfiguredState', () => {
  it('sees a migrated, already-credentialed config as ready — without any session-local flag', () => {
    // Simulates step 2 of Finding 1's repro: files land on disk (here via
    // persistSite, standing in for a migration copy) with no session loop
    // ever touching `added`.
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://blog.example.com', values: { admin_api_key: 'id:secret' } },
      true,
    );
    const state = readConfiguredState(p, {});
    expect(state).toEqual({ siteCount: 1, usableSites: ['personal'], siteSlugs: ['personal'] });
    expect(decideClosing(state, [])).toEqual({ kind: 'ready', site: 'personal' });
  });

  it('does not call a copied config "ready" when its credentials are unset', () => {
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://blog.example.com', values: { admin_api_key: 'id:secret' } },
      true,
    );
    // The secret landed in .env under PERSONAL_ADMIN_API_KEY; wipe it to
    // simulate a config.yaml that was copied but whose .env was not (or a
    // key that was later revoked and unset).
    writeFileSync(p.envFile, '', 'utf8');
    const state = readConfiguredState(p, {});
    expect(state).toEqual({ siteCount: 1, usableSites: [], siteSlugs: ['personal'] });
    expect(decideClosing(state, [])).toEqual({ kind: 'unusable' });
  });

  it('reports nothing declared when there is no config.yaml at all', () => {
    const p = paths();
    const state = readConfiguredState(p, {});
    expect(state).toEqual({ siteCount: 0, usableSites: [], siteSlugs: [] });
    expect(decideClosing(state, [])).toEqual({ kind: 'none' });
  });
});

/** A `Prompter` test double: `text()` returns each of `answers` in turn (then null), `problem()` is recorded. */
function scriptedPrompter(answers: readonly (string | null)[]): Prompter & { problems: string[] } {
  let i = 0;
  const problems: string[] = [];
  return {
    text: async () => (i < answers.length ? (answers[i++] ?? null) : null),
    choose: async () => null,
    note: () => {},
    problem: (t: string) => {
      problems.push(t);
    },
    problems,
  };
}

describe('promptSlug', () => {
  // Finding 1: `taken` used to be only `added` (this session's loop), so a
  // slug already on disk — migrated in, or added in an earlier session — was
  // never rejected here, and silently replaced that site in
  // `writeSiteToConfig` a few lines later. This is the exact scenario:
  // "personal" is already configured (as `readConfiguredState().siteSlugs`
  // would report it), and the user tries to reuse that name.

  it('rejects a slug that already exists on disk and asks again', async () => {
    const p = scriptedPrompter(['personal', 'personal-2']);
    const slug = await promptSlug(['personal', 'indianic'], p);
    expect(slug).toBe('personal-2');
    expect(p.problems).toEqual(['"personal" is already configured. Pick a different name.']);
  });

  it('accepts a slug that is not on disk and not in this session\'s `added` on the first try', async () => {
    const p = scriptedPrompter(['brand-new']);
    const slug = await promptSlug(['personal', 'indianic'], p);
    expect(slug).toBe('brand-new');
    expect(p.problems).toEqual([]);
  });

  it('rejects a slug already added earlier in the SAME session, even with an empty disk state', async () => {
    const p = scriptedPrompter(['second', 'third']);
    const slug = await promptSlug(['second'], p);
    expect(slug).toBe('third');
    expect(p.problems).toEqual(['"second" is already configured. Pick a different name.']);
  });

  it('returns null when the user enters nothing', async () => {
    const slug = await promptSlug(['personal'], scriptedPrompter([null]));
    expect(slug).toBeNull();
  });

  // The re-run menu offers "+new" alongside the configured slugs. That
  // sentinel must be unreachable as a real slug, or a blog could shadow it.
  it('refuses the new-blog menu sentinel as a slug, because it is not a legal slug', async () => {
    const p = scriptedPrompter(['+new', 'ok-name']);
    expect(await promptSlug([], p)).toBe('ok-name');
    expect(p.problems).toEqual([SLUG_RULE]);
  });
});

describe('promptUrl', () => {
  it('keeps the current address when the user enters nothing', async () => {
    expect(await promptUrl(scriptedPrompter([null]), 'https://blog.example.com')).toBe('https://blog.example.com');
  });

  // Unchanged for a NEW blog: empty still means skip, and the caller abandons.
  it('returns null when there is no current address and nothing is entered', async () => {
    expect(await promptUrl(scriptedPrompter([null]))).toBeNull();
  });

  it('accepts a replacement address and normalises it the same way either mode does', async () => {
    expect(await promptUrl(scriptedPrompter(['blog.new.example.com/']), 'https://old.example.com')).toBe(
      'https://blog.new.example.com',
    );
  });

  it('re-asks on an unparseable address rather than keeping the old one by accident', async () => {
    const p = scriptedPrompter(['http://', 'https://good.example.com']);
    expect(await promptUrl(p, 'https://old.example.com')).toBe('https://good.example.com');
    expect(p.problems).toHaveLength(1);
  });
});

describe('persistSite with replace — the update path', () => {
  it('rewrites an existing site in place, changing only what changed', () => {
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://old.example.com', values: { admin_api_key: 'old:key' } },
      true,
    );
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://new.example.com', values: { admin_api_key: 'old:key' } },
      false,
      { replace: true },
    );

    const config = readFileSync(p.configFile, 'utf8');
    expect(config).toContain('url: https://new.example.com');
    expect(config).not.toContain('old.example.com');
    // One site, not two, and still the default.
    expect(config).toContain('default_site: personal');
    const env = readFileSync(p.envFile, 'utf8');
    expect(env.match(/PERSONAL_ADMIN_API_KEY=/g)).toHaveLength(1);
    expect(env).toContain('PERSONAL_ADMIN_API_KEY=old:key');
  });

  // Important #1 from the phase-8 re-run review: `persistSite` used to
  // recompute the env var name on every write, so an update silently renamed
  // a hand-set `${VAR}` reference and left the OLD secret behind in `.env`
  // under a name config.yaml no longer pointed at — a live credential
  // duplicated on disk that `remove_site` would never clean up. Reproduces
  // the review's exact repro: a config.yaml hand-edited to reference
  // `${MY_CUSTOM_GHOST_KEY}` instead of the computed `MYBLOG_ADMIN_API_KEY`.
  it('reuses a hand-named env var reference on update instead of renaming it, and leaves no orphaned copy of the secret', () => {
    const p = paths();
    ensureHome(p);
    writeFileSync(
      p.configFile,
      'default_site: myblog\nsites:\n  myblog:\n    platform: ghost\n    url: https://admin.example.com\n    admin_api_key: ${MY_CUSTOM_GHOST_KEY}\n',
      'utf8',
    );
    writeFileSync(p.envFile, 'MY_CUSTOM_GHOST_KEY=aaaa:bbbb\nOTHER_ADMIN_API_KEY=cccc:dddd\n', 'utf8');

    const configBefore = readFileSync(p.configFile, 'utf8');
    expect(configBefore).toContain('admin_api_key: ${MY_CUSTOM_GHOST_KEY}');

    // The update path: same slug, `replace: true`, and — the realistic case —
    // the user actually rotated the key while they were in there.
    persistSite(
      p,
      ghostPlugin,
      { slug: 'myblog', platform: 'ghost', url: 'https://admin.example.com', values: { admin_api_key: 'new:secret' } },
      false,
      { replace: true },
    );

    const configAfter = readFileSync(p.configFile, 'utf8');
    // The hand-chosen name survives — not renamed to the computed
    // MYBLOG_ADMIN_API_KEY.
    expect(configAfter).toContain('admin_api_key: ${MY_CUSTOM_GHOST_KEY}');
    expect(configAfter).not.toContain('MYBLOG_ADMIN_API_KEY');

    const envAfter = readFileSync(p.envFile, 'utf8');
    const envKeys = envAfter
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.slice(0, l.indexOf('=')));
    // Exactly the two names that were there before, still there — one copy of
    // the (now-rotated) secret, not two. No MYBLOG_ADMIN_API_KEY was created.
    expect(envKeys.sort()).toEqual(['MY_CUSTOM_GHOST_KEY', 'OTHER_ADMIN_API_KEY']);
    expect(envAfter).toContain('MY_CUSTOM_GHOST_KEY=new:secret');
    expect(envAfter).toContain('OTHER_ADMIN_API_KEY=cccc:dddd');
  });

  it('still refuses to replace without the explicit flag — the collision guard is untouched', () => {
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://a.example.com', values: { admin_api_key: 'k' } },
      true,
    );
    expect(() =>
      persistSite(
        p,
        wordpressPlugin,
        {
          slug: 'personal',
          platform: 'wordpress',
          url: 'https://b.example.com',
          values: { username: 'editor', app_password: 'pw' },
        },
        false,
      ),
    ).toThrow(/already exists/);
  });
});

describe('readConfiguredSites', () => {
  it('hands back credentials RESOLVED from .env, which is what makes "keep" possible', () => {
    // A `${VAR}` reference cannot be probed and cannot be kept. The update
    // walk needs the real value, without ever asking the user for it.
    const p = paths();
    persistSite(
      p,
      ghostPlugin,
      { slug: 'personal', platform: 'ghost', url: 'https://blog.example.com', values: { admin_api_key: 'id:secret' } },
      true,
    );
    const sites = readConfiguredSites(p, {});
    expect(sites!.sites.personal!.credentials.admin_api_key).toBe('id:secret');
    expect(sites!.sites.personal!.url).toBe('https://blog.example.com');
    expect(sites!.sites.personal!.platform).toBe('ghost');
  });

  it('returns null when there is nothing configured, and creates nothing by asking', () => {
    const p = paths();
    expect(readConfiguredSites(p, {})).toBeNull();
    expect(existsSync(p.configFile)).toBe(false);
  });
});
