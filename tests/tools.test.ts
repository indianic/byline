import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadPersonas } from '../src/config/personas.js';
import { SLUG_PATTERN, loadSites, usableSites } from '../src/config/sites.js';
import { type Context, loadContext } from '../src/context.js';
import { buildServer } from '../src/index.js';
import { MIN_SCHEDULE_LEAD_MS, clearTimezoneCache } from '../src/plugins/platforms/schedule.js';
import { IMAGE_LOOKS } from '../src/craft/image-style.js';
import type { PlatformPlugin } from '../src/plugins/platforms/types.js';
import { PLATFORM_PLUGINS } from '../src/plugins/registry.js';
import { TavilyResearch } from '../src/plugins/research/tavily/index.js';
import * as windowModule from '../src/plugins/research/window.js';
import { FAKE_ADMIN_KEY, FAKE_KEY_SECRET } from './fixtures/keys.js';

const SITES = `
default_site: personal
sites:
  personal:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: \${PERSONAL_GHOST_KEY}
    default_author: jane-doe
`;

const PERSONA = `
slug: jane-doe
name: Jane Doe
role: CTO
writing_style: Analytical
tone_of_voice: Dry
platform_authors:
  personal: "author-1"
`;

function makeContext(): Context {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ctx-'));
  const sitesFile = join(dir, 'sites.yaml');
  writeFileSync(sitesFile, SITES);
  const personasDir = mkdtempSync(join(tmpdir(), 'wb-p-'));
  writeFileSync(join(personasDir, 'jane-doe.yaml'), PERSONA);
  const env = { PERSONAL_GHOST_KEY: FAKE_ADMIN_KEY };
  const sites = loadSites(sitesFile, env);
  const personas = loadPersonas(personasDir);
  const runsDir = mkdtempSync(join(tmpdir(), 'wb-runs-'));
  const paths = {
    home: dir,
    source: 'env' as const,
    configFile: sitesFile,
    personasDir,
    envFile: join(dir, '.env'),
    runsDir,
  };
  return {
    paths,
    sitesFile,
    personasDir,
    sites,
    personas,
    // No media libraries configured for this fixture — matches what
    // loadMedia returns for a config.yaml with no `media:` block, so
    // create_post/update_post's promoteUsedMedia has a real (empty)
    // MediaConfig to read rather than a Context this test double never gave
    // one, per Context's contract that `media` is never absent.
    media: { reuseScope: 'site', libraries: {}, problems: [] },
    runsDir,
    env,
    setup: {
      configured: usableSites(sites).length > 0,
      paths,
      siteCount: Object.keys(sites.sites).length,
      usableSiteCount: usableSites(sites).length,
      personaCount: personas.size,
      // The fixture stubs fetch rather than calling a real provider, so the
      // image tools must not be gated out from under the existing tests.
      imageProviders: ['gemini'],
      problems: [],
      siteProblems: [],
    },
  };
}

const WP_SITES = `
default_site: wptest
sites:
  wptest:
    platform: wordpress
    url: https://wp.example.com
    username: editor
    app_password: \${WPTEST_APP_PASSWORD}
`;

/**
 * A WordPress equivalent of `makeContext()`, for tests that need to prove
 * something through the MCP tool layer specifically for WordPress (e.g. C3:
 * `feature_image_id` surviving zod's argument parsing into
 * `PostInput.feature_image_id`) rather than against Ghost, which ignores that
 * field entirely.
 */
function makeWordPressContext(): Context {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wp-ctx-'));
  const sitesFile = join(dir, 'sites.yaml');
  writeFileSync(sitesFile, WP_SITES);
  const personasDir = mkdtempSync(join(tmpdir(), 'wb-wp-p-'));
  const env = { WPTEST_APP_PASSWORD: 'abcd EFGH ijkl MNOP' };
  const sites = loadSites(sitesFile, env);
  const personas = loadPersonas(personasDir);
  const runsDir = mkdtempSync(join(tmpdir(), 'wb-wp-runs-'));
  const paths = {
    home: dir,
    source: 'env' as const,
    configFile: sitesFile,
    personasDir,
    envFile: join(dir, '.env'),
    runsDir,
  };
  return {
    paths,
    sitesFile,
    personasDir,
    sites,
    personas,
    // See makeContext()'s identical comment above.
    media: { reuseScope: 'site', libraries: {}, problems: [] },
    runsDir,
    env,
    setup: {
      configured: usableSites(sites).length > 0,
      paths,
      siteCount: Object.keys(sites.sites).length,
      usableSiteCount: usableSites(sites).length,
      personaCount: personas.size,
      imageProviders: ['gemini'],
      problems: [],
      siteProblems: [],
    },
  };
}

let client: Client;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([
    client.connect(clientTransport),
    buildServer(makeContext()).connect(serverTransport),
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text: string }>)[0]!;
  return JSON.parse(first.text);
}

async function callWith(ctx: Context, name: string, args: Record<string, unknown> = {}) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([c.connect(ct), buildServer(ctx).connect(st)]);
  const res = await c.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text: string }>)[0]!;
  await c.close();
  return JSON.parse(first.text);
}

describe('tool registration', () => {
  it('exposes all twenty tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_site',
      'build_writing_brief',
      'create_post',
      'embed_video',
      'find_media',
      'generate_image',
      'generate_images',
      'get_persona',
      'health_check',
      'list_authors',
      'list_media_libraries',
      'list_personas',
      'list_sites',
      'remove_site',
      'research_topic',
      'score_draft',
      'update_post',
      'upload_image',
      'upload_images',
      'use_media',
    ]);
  });

  // Regression (LEAK 3): tool descriptions register once at startup, so a
  // description hardcoding "raw Ghost author id (24 hex chars)" is simply
  // wrong on a mixed Ghost + WordPress install — WordPress's own ids are
  // integers, not hex. The description must describe the `author` field
  // platform-neutrally and point the caller at list_authors instead of
  // asserting one platform's id shape as if it were universal.
  it('describes create_post\'s author field platform-neutrally, not hardcoding Ghost', async () => {
    const tools = (await client.listTools()).tools;
    const createPost = tools.find((t) => t.name === 'create_post')!;
    const authorDescription = (createPost.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties?.author?.description;
    expect(authorDescription).toBeDefined();
    expect(authorDescription).not.toContain('24 hex chars');
    expect(authorDescription).not.toMatch(/raw Ghost/);
    expect(authorDescription).toContain('list_authors');
  });
});

describe('list_sites', () => {
  it('returns configured sites without any key material', async () => {
    const r = await call('list_sites');
    expect(r.sites[0].slug).toBe('personal');
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY_SECRET);
    expect(JSON.stringify(r)).not.toContain('credentials');
  });
});

describe('add_site', () => {
  // envVarNameFor collapses every non-alphanumeric run to `_`, so `my-blog`
  // and `my_blog` both derive MY_BLOG_ADMIN_API_KEY. The CLI's promptSlug has
  // always refused the second shape; add_site's slug was an unconstrained
  // z.string(), so an AI tool could add a site that silently overwrote another
  // site's credential. Both writers now enforce SLUG_PATTERN.
  it.each([
    ['my_blog', 'underscore — collides with my-blog in the env var namespace'],
    ['My-Blog', 'uppercase — collides with my-blog'],
    ['blog.example', 'dot — collides with blogexample'],
    ['-leading', 'does not start alphanumeric'],
    ['has space', 'whitespace'],
  ])('refuses the slug %j (%s) and never touches sites.yaml', async (slug) => {
    const ctx = makeContext();
    const before = readFileSync(ctx.sitesFile, 'utf8');

    const r = await callWith(ctx, 'add_site', {
      slug,
      platform: 'ghost',
      url: 'https://newsite.example.com',
      credentials: { admin_api_key: 'NEWSITE_GHOST_KEY' },
    });

    expect(r.ok).not.toBe(true);
    // The rule must be stated, not just refused — the caller is an AI tool
    // that has to pick a different name without guessing at the alphabet.
    expect(JSON.stringify(r)).toMatch(/lowercase letters, digits, and hyphens/i);
    // The real defect would be a refusal that wrote anyway.
    expect(readFileSync(ctx.sitesFile, 'utf8')).toBe(before);
  });

  it('still accepts every slug shape the CLI can produce', async () => {
    // Guards the other direction: an over-tight pattern would lock out names
    // promptSlug hands users as examples.
    for (const slug of ['personal', 'company-blog', 'wp2', 'a']) {
      expect(SLUG_PATTERN.test(slug)).toBe(true);
    }

    const ctx = makeContext();
    const r = await callWith(ctx, 'add_site', {
      slug: 'company-blog',
      platform: 'ghost',
      url: 'https://newsite.example.com',
      credentials: { admin_api_key: 'COMPANY_BLOG_GHOST_KEY' },
    });
    expect(r.ok).toBe(true);
    expect(r.added).toBe('company-blog');
  });

  it('rejects an unknown platform naming the supported ones, and never touches sites.yaml', async () => {
    const ctx = makeContext();
    const before = readFileSync(ctx.sitesFile, 'utf8');
    const r = await callWith(ctx, 'add_site', {
      slug: 'newsite',
      platform: 'wordpres', // misspelled on purpose
      url: 'https://newsite.example.com',
      credentials: { admin_api_key: 'NEWSITE_GHOST_KEY' },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_PLATFORM');
    expect(r.message).toContain('ghost');
    // The actual defect under test: the bad platform must never reach disk.
    // Comparing only the error response would miss a write that happened anyway.
    const after = readFileSync(ctx.sitesFile, 'utf8');
    expect(after).toBe(before);
  });

  it('succeeds against a brand-new install with no config file yet, creating it (including parent dirs)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-fresh-'));
    // Nested and not yet created — add_site must make the whole path, not just
    // write into a directory that happens to already exist.
    const home = join(base, 'nested', 'home');
    const ctx = loadContext({ BYLINE_HOME: home });

    const r = await callWith(ctx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'FIRST_GHOST_KEY' },
    });

    expect(r.ok).toBe(true);
    expect(r.added).toBe('first');
    expect(readFileSync(ctx.sitesFile, 'utf8')).toContain('first');
  });

  // Regression: add_site's early-return path (env var not yet set — the
  // ORDINARY path for a brand-new site, per the tool's own `note`) used to
  // return before resyncing `ctx.sites`/`ctx.setup`. The site was written to
  // disk but invisible to every other tool in the same process until a
  // restart: list_sites showed no usable sites, and create_post said "No
  // sites are set up" — actively misleading, since a site IS set up; it just
  // needs its key. Uses a custom env object (not process.env) so this also
  // exercises threading `ctx.env` through the resync rather than reading the
  // ambient process env.
  it('resyncs ctx.sites/ctx.setup on the early-return path, so list_sites and create_post see the new site immediately', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-unset-key-'));
    const home = join(base, 'home');
    const env = { BYLINE_HOME: home } as NodeJS.ProcessEnv;
    delete env.NEVER_SET_KEY_XYZ;
    const ctx = loadContext(env);

    const added = await callWith(ctx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'NEVER_SET_KEY_XYZ' },
    });
    expect(added.ok).toBe(true);
    expect(added.note).toContain('NEVER_SET_KEY_XYZ');

    const listed = await callWith(ctx, 'list_sites', {});
    expect(listed.ok).toBe(true);
    expect(listed.usable).toEqual([]);
    expect(listed.sites).toHaveLength(1);
    expect(listed.sites[0].usable).toBe(false);

    const created = await callWith(ctx, 'create_post', {
      site: 'first',
      title: 'T',
      html: '<p>x</p>',
      schema: false,
    });
    expect(created.ok).toBe(false);
    expect(created.code).toBe('SETUP_INCOMPLETE');
    expect(created.message).not.toContain('No sites are set up');
    expect(created.message).toContain('NEVER_SET_KEY_XYZ');
  });

  // Regression: `{ ...parsed }` on a bare scalar silently "worked" — spreading a
  // string produces an object keyed by index ("0", "1", ...) — so add_site
  // returned ok:true and rewrote a `config.yaml` containing just `hello` into
  // gibberish like `"0": h\n"1": e\n...`. The old code threw a raw parser/type
  // error instead; the fix is a real ToolError, and the file must survive
  // untouched.
  it('rejects a config file that parses to a bare scalar rather than a mapping, without touching the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-scalar-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(ctx.sitesFile, 'hello\n');

    const r = await callWith(ctx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'SCALAR_GHOST_KEY' },
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_CONFIG');
    expect(readFileSync(ctx.sitesFile, 'utf8')).toBe('hello\n');
  });

  // Regression: malformed YAML propagated as the parser's raw error under
  // code UNEXPECTED, with no hint pointing at the fix — the same class of
  // defect the "No sites are set up" message was raised for.
  it('wraps malformed YAML in a ToolError naming the file, not a raw parser error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-badyaml-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(ctx.sitesFile, 'sites:\n  personal: [unterminated\n');

    const r = await callWith(ctx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'BADYAML_GHOST_KEY' },
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_CONFIG');
    expect(r.message).toContain(ctx.sitesFile);
  });

  // Regression: the resync before either return path validates the ENTIRE
  // config via loadSites, not just the site being added. An unrelated
  // pre-existing broken site (here: "legacy", missing `url`) made loadSites
  // throw, and — since the write to disk had already succeeded — that threw
  // exception used to propagate all the way out as `ok:false`, reporting a
  // completed write as a failure and leaving the user stuck: retrying said
  // SITE_EXISTS, but list_sites showed nothing.
  it('reports a completed write as ok:true and warns about an unrelated pre-existing broken site (missing url)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-addsite-warn-url-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(
      ctx.sitesFile,
      `
sites:
  legacy:
    platform: ghost
    admin_api_key: \${LEGACY_KEY}
`,
    );

    const r = await callWith(ctx, 'add_site', {
      slug: 'brandnew',
      platform: 'ghost',
      url: 'https://brandnew.example.com',
      credentials: { admin_api_key: 'BRANDNEW_GHOST_KEY' },
    });

    expect(r.ok).toBe(true);
    expect(r.added).toBe('brandnew');
    expect(r.warning).toBeTruthy();
    expect(String(r.warning)).toContain('legacy');

    // The write really happened — this is the fact the response must reflect.
    expect(readFileSync(ctx.sitesFile, 'utf8')).toContain('brandnew');

    // Retry now correctly reports the site already exists, rather than the
    // old dead-end where an "ok:false" add followed by a "SITE_EXISTS" retry
    // and an empty list_sites left no coherent path forward.
    const retry = await callWith(ctx, 'add_site', {
      slug: 'brandnew',
      platform: 'ghost',
      url: 'https://brandnew.example.com',
      credentials: { admin_api_key: 'BRANDNEW_GHOST_KEY' },
    });
    expect(retry.ok).toBe(false);
    expect(retry.code).toBe('SITE_EXISTS');

    const listed = await callWith(ctx, 'list_sites', {});
    expect(listed.ok).toBe(true);
  });

  // Same reproduction, the reviewer's other broken-config variant: an
  // unrelated site declaring an unknown platform instead of a missing url.
  // Unlike the missing-url case above, this no longer produces a `warning` —
  // per Task 3 (src/config/sites.ts), `loadSites` now marks an unknown-platform
  // site `unavailable` instead of throwing for the whole file, so the reload
  // right here fully succeeds and "legacy" simply comes back unusable.
  it('reports a completed write as ok:true and marks an unrelated pre-existing broken site (unknown platform) unavailable, with no reload warning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-addsite-warn-platform-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(
      ctx.sitesFile,
      `
sites:
  legacy:
    platform: joomla
    url: https://legacy.example.com
    admin_api_key: \${LEGACY_KEY}
`,
    );

    const r = await callWith(ctx, 'add_site', {
      slug: 'brandnew',
      platform: 'ghost',
      url: 'https://brandnew.example.com',
      credentials: { admin_api_key: 'BRANDNEW_GHOST_KEY' },
    });

    expect(r.ok).toBe(true);
    expect(r.added).toBe('brandnew');
    expect(r.warning).toBeUndefined();
    expect(readFileSync(ctx.sitesFile, 'utf8')).toContain('brandnew');
    expect(ctx.sites.sites.legacy?.unavailable).toContain('joomla');
    expect(ctx.sites.sites.brandnew).toBeDefined();
  });

  // Regression: a `sites:` key holding a scalar (not corrupted, just a
  // hand-edit mistake) slipped past the mapping guard on `readRawSitesConfig`
  // because the guard only checked the TOP-LEVEL parsed value — `sites: hello`
  // parses to a mapping at the top level, so it sailed through, and add_site
  // then crashed trying to assign a property onto the string `"hello"` with a
  // raw `UNEXPECTED`/"Cannot create property" message instead of a ToolError.
  it('rejects a `sites:` key that holds a scalar rather than a mapping, with a ToolError naming the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-sites-scalar-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(ctx.sitesFile, 'sites: hello\n');

    const r = await callWith(ctx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'SITESSCALAR_GHOST_KEY' },
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_CONFIG');
    expect(r.message).toContain(ctx.sitesFile);
    expect(r.message).not.toContain('Cannot create property');
    expect(readFileSync(ctx.sitesFile, 'utf8')).toBe('sites: hello\n');
  });

  // The adjacent states that must keep working exactly as before: a `sites:`
  // list, a whole-file list, comments-only, empty file, and `sites: null`.
  it('still treats sites: as a list, and a whole-file list, as errors without corrupting the file', async () => {
    const listHome = mkdtempSync(join(tmpdir(), 'wb-sites-list-'));
    const listCtx = loadContext({ BYLINE_HOME: listHome });
    mkdirSync(dirname(listCtx.sitesFile), { recursive: true });
    writeFileSync(listCtx.sitesFile, 'sites:\n  - a\n  - b\n');
    const listResult = await callWith(listCtx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'SITESLIST_GHOST_KEY' },
    });
    expect(listResult.ok).toBe(false);
    expect(listResult.code).toBe('INVALID_CONFIG');
    expect(readFileSync(listCtx.sitesFile, 'utf8')).toBe('sites:\n  - a\n  - b\n');

    const wholeHome = mkdtempSync(join(tmpdir(), 'wb-whole-list-'));
    const wholeCtx = loadContext({ BYLINE_HOME: wholeHome });
    mkdirSync(dirname(wholeCtx.sitesFile), { recursive: true });
    writeFileSync(wholeCtx.sitesFile, '- a\n- b\n');
    const wholeResult = await callWith(wholeCtx, 'add_site', {
      slug: 'first',
      platform: 'ghost',
      url: 'https://first.example.com',
      credentials: { admin_api_key: 'WHOLELIST_GHOST_KEY' },
    });
    expect(wholeResult.ok).toBe(false);
    expect(wholeResult.code).toBe('INVALID_CONFIG');
    expect(readFileSync(wholeCtx.sitesFile, 'utf8')).toBe('- a\n- b\n');
  });

  it('still treats comments-only, empty, and `sites: null` files as "no sites yet" and succeeds', async () => {
    for (const [label, content] of [
      ['comments only', '# just a comment\n'],
      ['empty file', ''],
      ['sites null', 'sites: null\n'],
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), `wb-nosites-${label.replace(/\s+/g, '-')}-`));
      const ctx = loadContext({ BYLINE_HOME: home });
      mkdirSync(dirname(ctx.sitesFile), { recursive: true });
      writeFileSync(ctx.sitesFile, content);
      const r = await callWith(ctx, 'add_site', {
        slug: 'first',
        platform: 'ghost',
        url: 'https://first.example.com',
        credentials: { admin_api_key: 'NOSITES_GHOST_KEY' },
      });
      expect(r.ok).toBe(true);
      expect(r.added).toBe('first');
    }
  });

  // Reviewer's finding: a secret credential field's value is supposed to be
  // the NAME of a .env variable, not the secret itself. The rewrite from
  // `env_var: z.string().regex(/^[A-Z0-9_]+$/)` to
  // `credentials: z.record(z.string(), z.string())` dropped that format check
  // entirely — a malformed name (spaces, punctuation, lowercase) used to be
  // rejected here; without the check it silently writes `${malformed}` into
  // config.yaml, which `resolveEnv`'s ENV_REF regex (src/config/sites.ts)
  // then fails to match on reload, falling through to treating the whole
  // literal string as the credential value — the site loads as "usable" with
  // garbage credentials and no `unavailable` warning.
  it('rejects a malformed .env variable name for a secret field, leaving config.yaml byte-unchanged', async () => {
    const ctx = makeContext();
    const before = readFileSync(ctx.sitesFile, 'utf8');

    const r = await callWith(ctx, 'add_site', {
      slug: 'newsite',
      platform: 'ghost',
      url: 'https://newsite.example.com',
      credentials: { admin_api_key: 'not a valid env name! $$${}' },
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_CREDENTIALS');
    expect(r.message).toContain('admin_api_key');

    // The actual defect under test: comparing only the response would miss a
    // write that happened anyway (the reviewer's exact reproduction). Compare
    // the file's bytes, not just "does not contain".
    const after = readFileSync(ctx.sitesFile, 'utf8');
    expect(after).toBe(before);
  });

  it('accepts a valid UPPER_SNAKE_CASE .env variable name for a secret field', async () => {
    const ctx = makeContext();

    const r = await callWith(ctx, 'add_site', {
      slug: 'newsite',
      platform: 'ghost',
      url: 'https://newsite.example.com',
      credentials: { admin_api_key: 'NEWSITE_GHOST_KEY' },
    });

    expect(r.ok).toBe(true);
    expect(r.added).toBe('newsite');
    expect(readFileSync(ctx.sitesFile, 'utf8')).toContain('${NEWSITE_GHOST_KEY}');
  });

  // The new env-var-name check must apply ONLY to secret fields. A non-secret
  // field (e.g. a WordPress username) takes a literal value and may contain
  // lowercase letters, dots, or hyphens — none of which are valid in an env
  // var name, and none of which should be rejected here. Ghost has no
  // non-secret field, so a synthetic plugin is injected into PLATFORM_PLUGINS
  // for this one test (the way the reviewer did), and removed again
  // afterward so it cannot leak into other tests.
  it('does not apply the env-var-name check to a non-secret field (e.g. a WordPress-style username)', async () => {
    const testPlugin: PlatformPlugin = {
      id: 'testplatform',
      label: 'Test Platform',
      credentialSchema: z
        .object({ platform: z.string(), url: z.string(), username: z.string() })
        .passthrough(),
      credentialFields: [
        {
          name: 'username',
          label: 'Username',
          secret: false,
          example: 'jane.doe-admin',
          help: 'Your login username.',
        },
      ],
      defaultApiUrl: (siteUrl) => `${siteUrl}/api`,
      makeAdapter: (site) => ({
        slug: site.slug,
        platform: 'testplatform',
        healthCheck: async () => ({
          slug: site.slug,
          platform: 'testplatform',
          ok: true,
          detail: 'ok',
        }),
        uploadImage: async () => {
          throw new Error('not implemented in test plugin');
        },
        createPost: async () => {
          throw new Error('not implemented in test plugin');
        },
        updatePost: async () => {
          throw new Error('not implemented in test plugin');
        },
        listTags: async () => {
          throw new Error('not implemented in test plugin');
        },
        listAuthors: async () => {
          throw new Error('not implemented in test plugin');
        },
      }),
      isAuthorId: () => false,
      htmlProfile: async () => ({
        platform: 'testplatform',
        label: 'Test Platform',
        preserved: new Set<string>(),
        unwrapped: new Set<string>(),
        inlineStyles: false,
        classAttributes: false,
        blockquote: 'passthrough',
        generatesHeadingIds: false,
        keepsLinkTarget: false,
        visualContainers: [],
        notes: [],
        verified: false,
      }),
    };
    PLATFORM_PLUGINS.testplatform = testPlugin;

    try {
      const ctx = makeContext();
      const r = await callWith(ctx, 'add_site', {
        slug: 'newsite',
        platform: 'testplatform',
        url: 'https://newsite.example.com',
        credentials: { username: 'jane.doe-admin' },
      });

      expect(r.ok).toBe(true);
      expect(r.added).toBe('newsite');
      expect(readFileSync(ctx.sitesFile, 'utf8')).toContain('jane.doe-admin');
    } finally {
      delete PLATFORM_PLUGINS.testplatform;
    }
  });
});

describe('remove_site', () => {
  it('returns a ToolError naming init, not a raw ENOENT, against a brand-new install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-fresh-rm-'));
    const ctx = loadContext({ BYLINE_HOME: home });

    const r = await callWith(ctx, 'remove_site', { slug: 'whatever' });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIG_NOT_FOUND');
    expect(r.hint).toBeTruthy();
    expect(String(r.hint)).toMatch(/init|add_site/);
  });

  // Regression: removing the LAST site wrote `sites: {}` to disk (a completed,
  // successful removal), then called `loadSites`, which rejects any file
  // defining zero sites — so the response was `{"ok":false}` for a removal
  // that had, in fact, already succeeded, and `ctx.setup` was left claiming
  // the removed site still exists and is usable.
  it('succeeds when removing the last remaining site, leaving a valid empty config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-rm-last-'));
    const sitesFile = join(dir, 'sites.yaml');
    writeFileSync(
      sitesFile,
      `
sites:
  only:
    platform: ghost
    url: https://only.example.com
    admin_api_key: \${ONLY_GHOST_KEY}
`,
    );
    const personasDir = mkdtempSync(join(tmpdir(), 'wb-rm-last-p-'));
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = join(dir, '.env');
    process.env.ONLY_GHOST_KEY = 'id:secret';
    const ctx = loadContext();
    expect(ctx.setup.usableSiteCount).toBe(1);

    const r = await callWith(ctx, 'remove_site', { slug: 'only' });

    expect(r.ok).toBe(true);
    expect(r.removed).toBe('only');
    expect(ctx.setup.siteCount).toBe(0);
    expect(ctx.setup.usableSiteCount).toBe(0);
    expect(ctx.setup.configured).toBe(false);
    delete process.env.BYLINE_SITES;
    delete process.env.BYLINE_PERSONAS;
    delete process.env.BYLINE_ENV;
    delete process.env.ONLY_GHOST_KEY;
  });

  // Same hole as add_site, applied to remove_site: the resync after a
  // successful removal validates every REMAINING site via loadSites, not
  // just the one removed. An unrelated site that was already broken before
  // this call throws there too, and used to propagate as `ok:false` even
  // though the removal itself had already succeeded and been written to disk.
  it('reports a completed removal as ok:true and warns about an unrelated pre-existing broken site', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-rmsite-warn-'));
    const ctx = loadContext({ BYLINE_HOME: home });
    mkdirSync(dirname(ctx.sitesFile), { recursive: true });
    writeFileSync(
      ctx.sitesFile,
      `
sites:
  removable:
    platform: ghost
    url: https://removable.example.com
    admin_api_key: \${REMOVABLE_GHOST_KEY}
  broken:
    platform: ghost
    admin_api_key: \${BROKEN_GHOST_KEY}
`,
    );

    const r = await callWith(ctx, 'remove_site', { slug: 'removable' });

    expect(r.ok).toBe(true);
    expect(r.removed).toBe('removable');
    expect(r.warning).toBeTruthy();
    expect(String(r.warning)).toContain('broken');

    const after = readFileSync(ctx.sitesFile, 'utf8');
    expect(after).not.toContain('removable');
    expect(after).toContain('broken');
  });
});

describe('add_site / remove_site keep ctx.setup in sync', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('add_site: usableSiteCount and configured reflect the newly usable site immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-stale-add-'));
    const sitesFile = join(dir, 'sites.yaml');
    writeFileSync(
      sitesFile,
      `
sites:
  aaa:
    platform: ghost
    url: https://aaa.example.com
    admin_api_key: \${AAA_GHOST_KEY}
`,
    );
    const personasDir = mkdtempSync(join(tmpdir(), 'wb-stale-add-p-'));
    delete process.env.AAA_GHOST_KEY;
    delete process.env.BBB_GHOST_KEY;
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = join(dir, '.env');
    const ctx = loadContext();
    // Baseline: the only site is unusable.
    expect(ctx.setup.usableSiteCount).toBe(0);
    expect(ctx.setup.configured).toBe(false);

    process.env.BBB_GHOST_KEY = 'id:secret';
    const r = await callWith(ctx, 'add_site', {
      slug: 'bbb',
      platform: 'ghost',
      url: 'https://bbb.example.com',
      credentials: { admin_api_key: 'BBB_GHOST_KEY' },
    });
    expect(r.ok).toBe(true);

    // The very next read of ctx.setup must not still describe the pre-add world.
    expect(ctx.setup.usableSiteCount).toBe(1);
    expect(ctx.setup.configured).toBe(true);
  });

  it('remove_site: usableSiteCount and configured reflect the removed site immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-stale-rm-'));
    const sitesFile = join(dir, 'sites.yaml');
    // Two sites so removing one still leaves a valid (if unusable) config —
    // loadSites rejects a file with zero sites, which is a separate concern
    // from the staleness bug under test here.
    writeFileSync(
      sitesFile,
      `
sites:
  good:
    platform: ghost
    url: https://good.example.com
    admin_api_key: \${GOOD_GHOST_KEY}
  bad:
    platform: ghost
    url: https://bad.example.com
    admin_api_key: \${BAD_GHOST_KEY}
`,
    );
    const personasDir = mkdtempSync(join(tmpdir(), 'wb-stale-rm-p-'));
    delete process.env.BAD_GHOST_KEY;
    process.env.GOOD_GHOST_KEY = 'id:secret';
    process.env.BYLINE_SITES = sitesFile;
    process.env.BYLINE_PERSONAS = personasDir;
    process.env.BYLINE_ENV = join(dir, '.env');
    const ctx = loadContext();
    expect(ctx.setup.siteCount).toBe(2);
    expect(ctx.setup.usableSiteCount).toBe(1);
    expect(ctx.setup.configured).toBe(true);

    // Remove the only usable site, leaving just the unusable one.
    const r = await callWith(ctx, 'remove_site', { slug: 'good' });
    expect(r.ok).toBe(true);

    expect(ctx.setup.siteCount).toBe(1);
    expect(ctx.setup.usableSiteCount).toBe(0);
    expect(ctx.setup.configured).toBe(false);
  });
});

describe('get_persona', () => {
  it('returns the persona', async () => {
    expect((await call('get_persona', { slug: 'jane-doe' })).persona.name).toBe('Jane Doe');
  });

  it('returns an error envelope naming valid slugs', async () => {
    const r = await call('get_persona', { slug: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_PERSONA');
    expect(r.message).toContain('jane-doe');
  });
});

describe('build_writing_brief', () => {
  it('returns a reproducible brief', async () => {
    const a = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'blog',
      seed: 5,
    });
    const b = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'blog',
      seed: 5,
    });
    expect(a.brief).toBe(b.brief);
    expect(a.seed).toBe(5);
  });
});

describe('build_writing_brief research gate', () => {
  it('refuses news mode with no research', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'news',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_REQUIRED');
    expect(r.message).toContain('cannot be written from training data');
  });

  it('refuses news mode with only whitespace research', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'news',
      research: '   ',
    });
    expect(r.code).toBe('RESEARCH_REQUIRED');
  });

  it('allows news mode once substantial research is supplied', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'news',
      // 200-char minimum for a BYOR string (substance is the only thing that
      // can honestly be checked about a hand-pasted string) — see the
      // RESEARCH_THIN guard in src/tools/craft-tools.ts.
      research: 'TCS revenue per employee rose 3.4% in FY26. '.repeat(5),
    });
    expect(r.ok).toBe(true);
    expect(r.brief).toContain('TCS revenue per employee rose 3.4%');
  });

  it('allows blog mode without research', async () => {
    const r = await call('build_writing_brief', { persona: 'jane-doe', topic: 'AI', mode: 'blog' });
    expect(r.ok).toBe(true);
  });
});

describe('create_post metadata', () => {
  function stubCreate(capture: (body: any) => void) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const body = JSON.parse(String(i.body));
        capture(body);
        // Echo everything back so the write-back check stays quiet.
        return new Response(
          JSON.stringify({
            posts: [{ ...body.posts[0], id: 'p1', url: 'https://u', status: 'draft' }],
          }),
          { status: 201 },
        );
      }),
    );
  }

  it('passes social and SEO fields through to Ghost', async () => {
    let body: any;
    stubCreate((b) => {
      body = b;
    });
    await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      custom_excerpt: 'Listing blurb',
      meta_title: 'SEO title',
      meta_description: 'SEO description',
      og_title: 'Facebook title',
      og_description: 'Facebook description',
      twitter_title: 'X title',
      twitter_description: 'X description',
      feature_image: 'https://img/hero.png',
      feature_image_caption: 'Caption',
      images: 'hero',
    });
    const p = body.posts[0];
    expect(p.custom_excerpt).toBe('Listing blurb');
    expect(p.meta_title).toBe('SEO title');
    expect(p.og_title).toBe('Facebook title');
    expect(p.twitter_description).toBe('X description');
    expect(p.feature_image_caption).toBe('Caption');
    // excerpt is read-only in Ghost and must never be sent
    expect('excerpt' in p).toBe(false);
  });

  it('falls back to the feature image for both social cards', async () => {
    let body: any;
    stubCreate((b) => {
      body = b;
    });
    await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      feature_image: 'https://img/hero.png',
      images: 'hero',
    });
    expect(body.posts[0].og_image).toBe('https://img/hero.png');
    expect(body.posts[0].twitter_image).toBe('https://img/hero.png');
  });

  it('injects Article and FAQPage JSON-LD by default', async () => {
    let body: any;
    stubCreate((b) => {
      body = b;
    });
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      meta_description: 'D',
      faq: [{ question: 'Q1?', answer: 'A1' }],
      images: 'none',
    });
    const head = body.posts[0].codeinjection_head as string;
    expect(head).toContain('application/ld+json');
    expect(head).toContain('FAQPage');
    expect(head).toContain('Jane Doe');
    expect(r.schema_injected).toBe(true);
  });

  it('omits schema when explicitly disabled', async () => {
    let body: any;
    stubCreate((b) => {
      body = b;
    });
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      schema: false,
      images: 'none',
    });
    expect('codeinjection_head' in body.posts[0]).toBe(false);
    expect(r.schema_injected).toBe(false);
  });

  // Regression (LEAK 1): schema_injected used to report Boolean(codeinjection)
  // — true whenever the JSON-LD was BUILT, regardless of whether the platform
  // actually stored it. Ghost silently dropping a field is exactly what
  // droppedFields()/warnings already detect; this proves schema_injected is
  // now derived from that outcome, not from intent.
  it('reports schema_injected: false, with a warning, when Ghost itself discards the injected schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              // codeinjection_head comes back null: Ghost accepted the request
              // but did not store the field, exactly like the custom_excerpt
              // drop below, just for a different field.
              posts: [{ id: 'p1', url: 'u', status: 'draft', codeinjection_head: null }],
            }),
            { status: 201 },
          ),
      ),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      meta_description: 'D',
      schema: true,
      images: 'none',
    });
    expect(r.ok).toBe(true);
    expect(r.schema_injected).toBe(false);
    expect(r.warnings?.some((w: string) => w.includes('codeinjection_head'))).toBe(true);
  });

  it('surfaces Ghost warnings when a field is discarded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              posts: [{ id: 'p1', url: 'u', status: 'draft', title: 'T', custom_excerpt: null }],
            }),
            { status: 201 },
          ),
      ),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      custom_excerpt: 'dropped',
      schema: false,
      images: 'none',
    });
    expect(r.warnings?.[0]).toContain('custom_excerpt');
  });
});

describe('score_draft', () => {
  it('returns a scorecard', async () => {
    const r = await call('score_draft', { html: '<p class="x">a</p>' });
    expect(r.verdict).toBe('blocked');
  });

  // Regression: `profileFor`'s bare fallback (no explicit `site`, no
  // `default_site`) must resolve to a USABLE site, not just the first one
  // declared in the file. `requireSetup(ctx, 'sites')` only guarantees SOME
  // site works — an unlucky ordering (the broken site declared first) must
  // not refuse scoring when a working site is right there. Reverting
  // `profileFor` to `Object.keys(ctx.sites.sites)[0]!` picks "aaa" (unusable)
  // here and this test fails with a MISSING_ENV error instead of a scorecard.
  it('falls back to the first USABLE site, not just the first declared one, when there is no default_site', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-profilefor-'));
    const sitesFile = join(dir, 'sites.yaml');
    writeFileSync(
      sitesFile,
      `
sites:
  aaa:
    platform: ghost
    url: https://aaa.example.com
    admin_api_key: \${AAA_NEVER_SET_KEY}
  bbb:
    platform: ghost
    url: https://bbb.example.com
    admin_api_key: \${BBB_SET_KEY}
`,
    );
    const personasDir = mkdtempSync(join(tmpdir(), 'wb-profilefor-p-'));
    const env = { BBB_SET_KEY: 'id:secret' } as NodeJS.ProcessEnv;
    delete env.AAA_NEVER_SET_KEY;
    const sites = loadSites(sitesFile, env);
    // Confirm the fixture actually reproduces the unlucky ordering: "aaa" is
    // declared (and iterates) first, and is the one that's unusable.
    expect(Object.keys(sites.sites)[0]).toBe('aaa');
    expect(sites.sites.aaa?.unavailable).toBeTruthy();
    expect(sites.sites.bbb?.unavailable).toBeUndefined();
    expect(sites.defaultSite).toBeUndefined();

    const runsDir = mkdtempSync(join(tmpdir(), 'wb-profilefor-r-'));
    const paths = {
      home: dir,
      source: 'env' as const,
      configFile: sitesFile,
      personasDir,
      envFile: join(dir, '.env'),
      runsDir,
    };
    const ctx: Context = {
      paths,
      sitesFile,
      personasDir,
      sites,
      personas: new Map(),
      runsDir,
      env,
      setup: {
        configured: usableSites(sites).length > 0,
        paths,
        siteCount: Object.keys(sites.sites).length,
        usableSiteCount: usableSites(sites).length,
        personaCount: 0,
        imageProviders: [],
        problems: [],
        siteProblems: [],
      },
    };

    const r = await callWith(ctx, 'score_draft', { html: '<p>Clean draft with no issues at all.</p>' });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBeDefined();
  });
});

describe('create_post', () => {
  it('resolves a persona slug to the site author id', async () => {
    let body: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ id: 'p1', url: 'https://u', status: 'published' }] }),
          { status: 201 },
        );
      }),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: 'jane-doe',
      // This test is about author resolution, not images.
      images: 'none',
    });
    expect(body.posts[0].authors).toEqual([{ id: 'author-1' }]);
    expect(body.posts[0].status).toBe('published');
    expect(r.url).toBe('https://u');
  });

  it('defaults status to published', async () => {
    let body: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ id: 'p', url: 'u', status: 'published' }] }),
          { status: 201 },
        );
      }),
    );
    await call('create_post', { site: 'personal', title: 'T', html: '<p>x</p>', images: 'none' });
    expect(body.posts[0].status).toBe('published');
  });

  it('returns an error envelope when Ghost rejects the post', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [{ message: 'Validation failed on posts' }] }), {
            status: 422,
          }),
      ),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.message).toContain('Validation failed on posts');
  });

  it('rejects an empty title at the schema layer, before any HTTP call', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await client.callTool({
      name: 'create_post',
      arguments: { site: 'personal', title: '', html: '<p>x</p>' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('validation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not warn when the persona has an author id for the target site', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({
            posts: [{ ...body.posts[0], id: 'p1', url: 'u', status: 'draft' }],
          }),
          { status: 201 },
        );
      }),
    );
    // The fixture persona has an id for "personal" only.
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: 'jane-doe',
      // This test is about author resolution, not images — pass a hero and
      // opt out of the inline requirement so the images gate doesn't muddy
      // the assertion below.
      feature_image: 'https://img/hero.png',
      images: 'hero',
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it('errors when the persona slug does not exist', async () => {
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: 'unknown-person',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_PERSONA');
  });

  it('accepts a raw Ghost author id to byline someone with no persona file', async () => {
    let body: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ ...body.posts[0], id: 'p1', url: 'u', status: 'draft' }] }),
          { status: 201 },
        );
      }),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: '2f88554eddb5d9c28bf29a5f',
      schema: false,
      // Author resolution is what this test checks; feature_image plus
      // images: "hero" side-steps the fixture's configured image provider's
      // enforcement gate.
      feature_image: 'https://img/hero.png',
      images: 'hero',
    });
    expect(body.posts[0].authors).toEqual([{ id: '2f88554eddb5d9c28bf29a5f' }]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it('errors with UNKNOWN_PERSONA for an author string that is neither a raw id nor a known persona slug', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const b = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ ...b.posts[0], id: 'p1', url: 'u', status: 'draft' }] }),
          { status: 201 },
        );
      }),
    );
    // Unknown slug still errors; this asserts the id-vs-slug branch did not
    // mistake a slug for an id.
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: 'no-ids-persona',
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_PERSONA');
  });

  it('warns and names the persona, site, and fix when the persona exists but has no author id for the target site', async () => {
    const ctx = makeContext();
    // A real persona, but its platform_authors map has no entry for "personal" —
    // the branch this whole describe block is nominally about, and the one
    // spot no existing test actually exercised.
    writeFileSync(
      join(ctx.personasDir, 'no-site-author.yaml'),
      `
slug: no-site-author
name: No Site Author
role: Writer
writing_style: Plain
tone_of_voice: Neutral
platform_authors:
  some-other-site: "author-9"
`,
    );
    ctx.personas = loadPersonas(ctx.personasDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ ...body.posts[0], id: 'p1', url: 'u', status: 'draft' }] }),
          { status: 201 },
        );
      }),
    );

    const r = await callWith(ctx, 'create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      author: 'no-site-author',
      schema: false,
      // Isolates this test to the one warning it's actually about — without
      // this, the fixture's configured image provider would refuse the
      // request and break the assertions below.
      feature_image: 'https://img/hero.png',
      images: 'hero',
    });

    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    // Names the persona, the site, and what to do about it — the only signal
    // that this post is about to publish under the wrong byline.
    expect(r.warnings[0]).toContain('no-site-author');
    expect(r.warnings[0]).toContain('"personal"');
    expect(r.warnings[0]).toContain('platform_authors');
  });
});

// Real user report: an image provider was configured and working, but an
// agent read the brief's images-on-by-default section, got the OLD
// non-blocking "no feature_image" nudge from create_post, and still
// published with no hero image and a stock photo standing in for a
// generated inline image — recording the nudge as "expected". A warning an
// agent can shrug off is not a guard. `images` (default "both") now makes
// the product's stated default an enforced contract: refuse to publish when
// the selected state's required image(s) are missing, UNLESS no image
// provider is configured at all — in which case the caller cannot comply,
// so nothing is enforced (see the last describe block below).
describe('create_post — enforces the default image contract (images: "both" | "hero" | "inline" | "none")', () => {
  const HERO = 'https://img/hero.png';
  const INLINE_HTML = '<p>x</p><figure><img src="https://img/inline.png" alt="a"></figure>';
  const NO_IMAGE_HTML = '<p>x</p>';

  /** Echoes the post back, exactly what create_post needs to succeed quietly. */
  function stubQuietCreate() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ ...body.posts[0], id: 'p1', url: 'https://u', status: 'draft' }] }),
          { status: 201 },
        );
      }),
    );
  }

  it('refuses images: "both" (the default) when neither a hero nor an inline image is present', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: NO_IMAGE_HTML,
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('IMAGES_REQUIRED');
    expect(r.message).toContain('feature_image');
    expect(r.message).toContain('<img');
    // Names the fix as a sequence and the opt-out, so a caller who genuinely
    // wants no image is not stuck.
    expect(r.hint).toContain('generate_image');
    expect(r.hint).toContain('upload_image');
    expect(r.hint).toContain('images: "none"');
  });

  it('defaults to "both" when images is omitted entirely — not just when passed explicitly', async () => {
    stubQuietCreate();
    const r = await call('create_post', { site: 'personal', title: 'T', html: NO_IMAGE_HTML, schema: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('IMAGES_REQUIRED');
  });

  it('refuses images: "both" when only the hero is missing (inline present)', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: INLINE_HTML,
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('HERO_IMAGE_REQUIRED');
    expect(r.message).toContain('feature_image');
    expect(r.hint).toContain('images: "none"');
  });

  it('refuses images: "both" when only the inline image is missing (hero present)', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: NO_IMAGE_HTML,
      feature_image: HERO,
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INLINE_IMAGE_REQUIRED');
    expect(r.message).toContain('<img');
    expect(r.hint).toContain('images: "none"');
  });

  it('publishes images: "both" when both a hero and an inline image are present', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: INLINE_HTML,
      feature_image: HERO,
      schema: false,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses images: "hero" when feature_image is missing, even with an inline image present', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: INLINE_HTML,
      images: 'hero',
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('HERO_IMAGE_REQUIRED');
    expect(r.hint).toContain('images: "none"');
  });

  it('publishes images: "hero" with only a feature_image, no inline image required', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: NO_IMAGE_HTML,
      feature_image: HERO,
      images: 'hero',
      schema: false,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses images: "inline" when there is no inline <img>, even with feature_image present', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: NO_IMAGE_HTML,
      feature_image: HERO,
      images: 'inline',
      schema: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INLINE_IMAGE_REQUIRED');
    expect(r.hint).toContain('images: "none"');
  });

  it('publishes images: "inline" with only an inline image, no feature_image required', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: INLINE_HTML,
      images: 'inline',
      schema: false,
    });
    expect(r.ok).toBe(true);
  });

  it('never refuses images: "none", even with neither a hero nor an inline image', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: NO_IMAGE_HTML,
      images: 'none',
      schema: false,
    });
    expect(r.ok).toBe(true);
  });

  it('does not add the old non-blocking nudge anywhere — the enforcement above replaced it', async () => {
    // A dropped custom_excerpt already produces warnings[0] elsewhere in this
    // file. With both images present (so the gate passes) and the excerpt
    // dropped by the platform, the only warning present must be about the
    // excerpt — there is no second "no feature_image" warning left to emit.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ posts: [{ id: 'p1', url: 'u', status: 'draft', title: 'T', custom_excerpt: null }] }),
            { status: 201 },
          ),
      ),
    );
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: INLINE_HTML,
      feature_image: HERO,
      custom_excerpt: 'dropped',
      schema: false,
    });
    expect(r.warnings).toEqual([expect.stringContaining('custom_excerpt')]);
  });
});

describe('create_post — image enforcement only applies when an image provider is configured', () => {
  it('publishes images: "both" with no images at all when no image provider is configured', async () => {
    const ctx = makeContext();
    ctx.setup = { ...ctx.setup, imageProviders: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        const body = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({ posts: [{ ...body.posts[0], id: 'p1', url: 'https://u', status: 'draft' }] }),
          { status: 201 },
        );
      }),
    );
    const r = await callWith(ctx, 'create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      schema: false,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });
});

// Regression (LEAK 1): schema_injected reported Boolean(codeinjection) — true
// whenever the JSON-LD was BUILT, never checking whether the platform
// actually stored it. WordPress core has no head-injection field at all, so
// every create_post with schema: true against WordPress reported
// schema_injected: true while the structured data was silently discarded —
// the exact silent-wrong-result class this project exists to close, and a
// headline feature (AEO/GEO) besides. Goes through the real MCP tool layer
// (`callWith`), the same path a real client uses.
describe('create_post — schema_injected reflects outcome, not intent (LEAK 1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns schema_injected: false, with a warning, when WordPress discards the injected schema', async () => {
    const ctx = makeWordPressContext();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const url = String(u);
        if (url.includes('context=edit')) {
          return new Response(
            JSON.stringify({
              id: 9,
              link: 'https://wp.example.com/p/',
              status: 'draft',
              title: { raw: 'T' },
              content: { raw: '<p>x</p>' },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ id: 9, link: 'https://wp.example.com/p/', status: 'draft' }),
          { status: 201 },
        );
      }),
    );

    const r = await callWith(ctx, 'create_post', {
      site: 'wptest',
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      schema: true,
      meta_description: 'D',
      // This test is about schema_injected, not images.
      images: 'none',
    });

    expect(r.ok).toBe(true);
    expect(r.schema_injected).toBe(false);
    expect(r.warnings?.some((w: string) => w.includes('codeinjection_head'))).toBe(true);
  });
});

// Regression (C3): `types.ts` claimed `feature_image_id` "flows through
// upload_image's tool result into PostInput.feature_image_id" — true for the
// adapter, but `create_post`/`update_post`'s MCP tool schemas had no such
// field, so the MCP SDK's zod parsing stripped it from every real client
// call before the handler ever saw it. This test goes through the actual MCP
// tool layer (`callWith`, exactly like a real client would call it), not the
// WordPressAdapter directly, so it fails if the schema regresses even though
// every WordPressAdapter unit test still passes.
describe('create_post — feature_image_id reaches WordPress (C3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets featured_media on a WordPress post created through the MCP tool layer', async () => {
    const ctx = makeWordPressContext();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        const url = String(u);
        calls.push({ url, init });
        if (url.includes('context=edit')) {
          return new Response(
            JSON.stringify({
              id: 55,
              link: 'https://wp.example.com/hero-test/',
              status: 'draft',
              title: { raw: 'Hero test' },
              content: { raw: '<p>Body</p>' },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ id: 55, link: 'https://wp.example.com/hero-test/', status: 'draft' }),
          { status: 201 },
        );
      }),
    );

    const r = await callWith(ctx, 'create_post', {
      site: 'wptest',
      title: 'Hero test',
      html: '<p>Body</p>',
      status: 'draft',
      schema: false,
      // The exact shape upload_image's tool result carries: a URL plus the
      // native id, both surviving zod parsing.
      feature_image: 'https://wp.example.com/hero.png',
      feature_image_id: '77',
      // This test is about feature_image_id forwarding, not the inline image;
      // a hero is already supplied above.
      images: 'hero',
    });

    expect(r.ok).toBe(true);
    expect(r.id).toBe('55');

    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'));
    expect(createCall).toBeDefined();
    const body = JSON.parse(String(createCall!.init!.body));
    // The central claim under test: featured_media actually made it into the
    // request WordPress received, proving feature_image_id was not stripped
    // by the MCP tool schema on the way in.
    expect(body.featured_media).toBe(77);
    expect(r.warnings?.some((w: string) => w.startsWith('feature_image:'))).not.toBe(true);
  });

  it('also forwards feature_image_id through update_post', async () => {
    const ctx = makeWordPressContext();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        const url = String(u);
        calls.push({ url, init });
        if (url.includes('context=edit')) {
          return new Response(
            JSON.stringify({ id: 55, link: 'https://wp.example.com/hero-test/', status: 'draft' }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ id: 55, link: 'https://wp.example.com/hero-test/', status: 'draft' }),
          { status: 200 },
        );
      }),
    );

    await callWith(ctx, 'update_post', {
      site: 'wptest',
      post_id: '55',
      feature_image: 'https://wp.example.com/hero.png',
      feature_image_id: '88',
    });

    const updateCall = calls.find((c) => c.init?.method && c.init.method !== 'GET');
    expect(updateCall).toBeDefined();
    const body = JSON.parse(String(updateCall!.init!.body));
    expect(body.featured_media).toBe(88);
  });
});

describe('health_check', () => {
  it('reports each API independently and never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const r = await call('health_check');
    expect(r.sites[0].ok).toBe(false);
    expect(Array.isArray(r.images)).toBe(true);
  });

  // Task 6: `health_check`'s handler calls `researchHealth()` alongside
  // `imageHealth()` and folds the result into the response under `research`.
  // Before this, only `providerFamilies()` in isolation was tested — nothing
  // proved the MCP tool layer actually surfaces the research probe, the same
  // "wired up but never asserted end to end" gap the images field would have
  // had if `Array.isArray(r.images)` above were the only images assertion.
  it('carries a research field alongside images, with one result per research provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const r = await call('health_check');
    expect(Array.isArray(r.research)).toBe(true);
    const names = (r.research as Array<{ provider: string }>).map((p) => p.provider).sort();
    expect(names).toEqual(['brave', 'tavily']);
    // Neither BRAVE_API_KEY nor TAVILY_API_KEY is set in this fixture
    // context, and an unconfigured provider's healthCheck() returns ok:false
    // without touching the network — so this holds even though `fetch` is
    // stubbed to fail every call.
    expect((r.research as Array<{ ok: boolean }>).every((p) => p.ok === false)).toBe(true);
  });
});

describe('setup gate', () => {
  it('returns SETUP_INCOMPLETE from create_post when nothing is configured', async () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-gate-')) });
    const result = await callWith(ctx, 'create_post', {
      site: 'nope',
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      schema: false,
    });
    expect(result.code).toBe('SETUP_INCOMPLETE');
    expect(result.hint).toContain('init');
  });

  it('still answers health_check when nothing is configured', async () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-gate2-')) });
    const result = await callWith(ctx, 'health_check', {});
    // Not gated: the diagnostic path must survive a broken state.
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(false);
  });
});

/**
 * The de-peopled retry, driven through the REAL MCP tool layer.
 *
 * Testing this against `generateImage` directly would prove the chain works,
 * not that `generate_image` composes and gates correctly — and "the adapter's
 * own tests passed while the tool layer dropped the value" is this codebase's
 * signature defect (see feature_image_id in docs/ADDING-A-PLATFORM.md).
 *
 * Only Gemini is configured here, so Grok contributes NOT_CONFIGURED — which
 * is deliberately the awkward case: a machine with one provider unconfigured
 * must still be able to tell a refusal from a breakage.
 */
describe('generate_image — the people contract', () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedXai = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
  });

  afterEach(() => {
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
  });

  const pngBody = () =>
    JSON.stringify({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }] } },
      ],
    });

  /** Record every prompt Gemini was actually sent. */
  function stubGemini(reply: (prompt: string) => Response): string[] {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        const prompt = parsed.contents?.[0]?.parts?.[0]?.text ?? '';
        seen.push(prompt);
        return reply(prompt);
      }),
    );
    return seen;
  }

  const okResponse = () => new Response(pngBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  const safetyResponse = () =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('defaults to photoreal_people and composes the style server-side', async () => {
    const seen = stubGemini(okResponse);

    const r = await call('generate_image', { prompt: 'a nurse checking a ward chart', slot: 'hero' });

    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // The caller sent a bare subject; the tool supplied everything else — the
    // medium anchor, the scene, the city, the people clause and the negatives.
    // Either medium anchor is valid: roughly one prompt in twelve is drawn as
    // an editorial illustration rather than a photograph.
    expect(seen[0]).toMatch(/^(Photograph\.|Editorial illustration)/);
    expect(seen[0]).toContain('nurse checking a ward chart');
    expect(seen[0]).toMatch(/Include people engaged/i);
    expect(seen[0]).toMatch(/If the subject does not already fix the location/i);
    expect(seen[0]).toMatch(/The setting is in /);
    expect(seen[0]).toMatch(/no text/i);
    expect(r.people_dropped).toBeUndefined();
  });

  // Checked across EVERY look rather than one hand-picked value. A single look
  // passes or fails depending on which medium its hash draws, so one example
  // would be a coin flip dressed up as a test — it would have passed today and
  // broken the day someone edited an unrelated string.
  it('passes the brief\'s look through verbatim on every photographic look', async () => {
    let photographic = 0;
    for (const look of IMAGE_LOOKS) {
      const seen = stubGemini(okResponse);
      await call('generate_image', { prompt: 'a warehouse aisle', look });
      if (seen[0]!.startsWith('Photograph.')) {
        expect(seen[0], look).toContain(look);
        photographic++;
      } else {
        // An illustration has no lens or aperture, so the camera register is
        // deliberately dropped rather than sent into a contradiction.
        expect(seen[0], look).not.toContain(look);
      }
    }
    expect(photographic, 'most looks should still yield photographs').toBeGreaterThan(
      IMAGE_LOOKS.length / 2,
    );
  });

  it('retries without people when every provider refuses, and says that it did', async () => {
    const seen = stubGemini((prompt) => (/Include people engaged/i.test(prompt) ? safetyResponse() : okResponse()));

    const r = await call('generate_image', { prompt: 'a clinic reception desk', slot: 'hero' });

    expect(r.ok).toBe(true);
    expect(r.people_dropped).toBe(true);
    expect(r.people_dropped_reason).toMatch(/SAFETY/i);
    // Two attempts: the people prompt, then the de-peopled one.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/Include people engaged/i);
    expect(seen[1]).not.toMatch(/Include people engaged/i);
    // And the subject survived the retry — a peopleless image of the WRONG
    // thing would be worse than the refusal.
    expect(seen[1]).toContain('clinic reception desk');
  });

  it('does NOT retry when a provider broke rather than refused', async () => {
    // A 500 is not a refusal. Retrying de-peopled here would silently drop the
    // people requirement because the network blipped, and the article would
    // publish looking fine with nobody in the picture and nobody told why.
    const seen = stubGemini(() => new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 }));

    const r = await call('generate_image', { prompt: 'a clinic reception desk' });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('ALL_PROVIDERS_FAILED');
    expect(seen).toHaveLength(1);
  });

  it('does not retry when the caller asked for a scene, since there is nothing to drop', async () => {
    const seen = stubGemini(safetyResponse);

    const r = await call('generate_image', { prompt: 'an empty server aisle', style: 'photoreal_scene' });

    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('style diagram skips the photographic contract entirely', async () => {
    const seen = stubGemini(okResponse);

    await call('generate_image', { prompt: 'three boxes connected left to right', style: 'diagram' });

    expect(seen[0]).not.toMatch(/^Photograph\./);
    expect(seen[0]).not.toMatch(/one or two people/i);
    expect(seen[0]).toContain('boxes connected left to right');
  });
});

// Task 7 review (Finding 1): the original research_topic tests never called
// research_topic. Two hand-rolled a fake `server.registerTool` stub instead of
// using this file's real harness, and two called `research()` from
// src/plugins/research/index.ts directly, skipping src/tools/research-tools.ts
// entirely. Nothing proved `ctx.env` was actually plumbed through, that the
// zod defaults for `window`/`max_results` survived the MCP SDK's argument
// parsing, or that the error codes actually reached a real client — exactly
// the class of gap that let `feature_image_id` ship doing nothing for four
// phases (see the C3 describe block above). These go through `call`/`callWith`
// like every other tool in this file, with the network stubbed at `fetch`.
describe('research_topic', () => {
  // BRAVE_API_KEY / TAVILY_API_KEY must never be ambiently set for these
  // tests — that is what makes "ctx.env, not process.env" a meaningful claim
  // rather than a coincidence of whatever is in the shell running the suite.
  const savedEnv = {
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    BYLINE_RESEARCH_PROVIDER: process.env.BYLINE_RESEARCH_PROVIDER,
    WRITEBLOGS_RESEARCH_PROVIDER: process.env.WRITEBLOGS_RESEARCH_PROVIDER,
  };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BYLINE_RESEARCH_PROVIDER;
    delete process.env.WRITEBLOGS_RESEARCH_PROVIDER;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  /** A fresh, sites-less context — research_topic touches no site. */
  function researchContext(env: Record<string, string> = {}): Context {
    const home = mkdtempSync(join(tmpdir(), 'wb-research-'));
    return loadContext({ BYLINE_HOME: home, ...env } as NodeJS.ProcessEnv);
  }

  const braveResponse = (results: unknown[]) => new Response(JSON.stringify({ results }), { status: 200 });
  const tavilyResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('honours a key present in ctx.env (and absent from process.env)', async () => {
    const ctx = researchContext({ TAVILY_API_KEY: 'fake-tavily-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tavilyResponse({ results: [{ url: 'https://a.test/1', title: 'A', content: 's' }] })),
    );

    const r = await callWith(ctx, 'research_topic', { topic: 'quantum batteries' });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('tavily');
  });

  it('refuses with RESEARCH_NOT_CONFIGURED when nothing is configured', async () => {
    const ctx = researchContext();
    const r = await callWith(ctx, 'research_topic', { topic: 'quantum batteries' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_NOT_CONFIGURED');
  });

  // The defaults are declared with zod's `.default(...)` in the inputSchema —
  // exactly the layer that silently stripped `feature_image_id` before. Spying
  // on the real TavilyResearch.prototype.search (still calling through to the
  // stubbed fetch) captures precisely what the adapter received: if a default
  // were dropped, `window`/`maxResults` would arrive `undefined` here, not
  // merely render oddly downstream.
  it('applies the zod defaults for window and max_results all the way to the provider', async () => {
    const ctx = researchContext({ TAVILY_API_KEY: 'fake-tavily-key' });
    vi.stubGlobal('fetch', vi.fn(async () => tavilyResponse({ results: [] })));
    const searchSpy = vi.spyOn(TavilyResearch.prototype, 'search');

    const r = await callWith(ctx, 'research_topic', { topic: 'quantum batteries' });

    expect(r.ok).toBe(true);
    expect(searchSpy).toHaveBeenCalledWith('quantum batteries', { window: 'week', maxResults: 10 });
  });

  // THE no-fallback rule: naming a provider with no key must refuse, never
  // silently return the other (configured) provider's results.
  it('refuses RESEARCH_PROVIDER_UNCONFIGURED for a named-but-unconfigured provider, and never falls back', async () => {
    const ctx = researchContext({ BRAVE_API_KEY: 'fake-brave-key' }); // tavily has no key
    const fetchMock = vi.fn(async () =>
      braveResponse([{ url: 'https://brave.test/1', title: 'Should never be returned' }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await callWith(ctx, 'research_topic', { topic: 'quantum batteries', provider: 'tavily' });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_PROVIDER_UNCONFIGURED');
    // The configured provider (brave) must never have been consulted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('brave.test');
  });

  it('returns findings plus selectedBy on the happy path, in the provider\'s own order', async () => {
    const ctx = researchContext({ BRAVE_API_KEY: 'fake-brave-key', TAVILY_API_KEY: 'fake-tavily-key' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        braveResponse([
          { url: 'https://c.test/3', title: 'Third', description: 'c', page_age: '2026-07-30T01:00:00' },
          { url: 'https://a.test/1', title: 'First', description: 'a', page_age: '2026-07-30T02:00:00' },
          { url: 'https://b.test/2', title: 'Second', description: 'b', page_age: '2026-07-30T03:00:00' },
        ]),
      ),
    );

    const r = await callWith(ctx, 'research_topic', { topic: 'quantum batteries' });

    expect(r.ok).toBe(true);
    // Both configured, no provider/env pin: registry order picks brave.
    expect(r.provider).toBe('brave');
    expect(r.selectedBy).toBe('registry-order');
    // Unsorted, unfiltered — exactly the order the provider returned.
    expect((r.findings as Array<{ url: string }>).map((f) => f.url)).toEqual([
      'https://c.test/3',
      'https://a.test/1',
      'https://b.test/2',
    ]);
  });
});

// Task 8. `findings` on build_writing_brief. THE feature_image_id regression
// this guards against: a field added to BriefInput and to buildBrief does
// nothing at all if the zod inputSchema does not declare it — the MCP SDK
// strips any key the input schema doesn't declare, before the handler ever
// runs. That shipped, typechecked, built, and passed every adapter unit test
// for four phases because those tests called the adapter directly with the
// field already present, never through a real client. These tests go through
// `call`/`callWith` — a real MCP client round-trip — for exactly that reason.
describe('build_writing_brief research origin', () => {
  const findings = {
    provider: 'tavily',
    query: 'cricket',
    window: 'day' as const,
    answer: 'India won by 4 wickets.',
    selectedBy: 'sole-configured' as const,
    findings: [
      {
        url: 'https://a.test/report',
        title: 'India win',
        snippet: 'India chased 214 with 4 wickets in hand.',
        publishedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        relevance: null,
        provider: 'tavily',
      },
    ],
  };

  it('lets findings survive the tool layer and reach the brief', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings,
    });
    expect(r.ok).toBe(true);
    expect(r.researchOrigin).toBe('provider');
    // The findings' actual content reached the brief text, not just a count.
    expect(r.brief).toContain('https://a.test/report');
    expect(r.brief).toContain('India chased 214');
  });

  it("marks Tavily's synthesis as orientation only, never citable", async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings,
    });
    expect(r.ok).toBe(true);
    expect(r.brief).toContain('India won by 4 wickets.');
    expect(r.brief.toLowerCase()).toContain('not citable');
  });

  it('refuses both research and findings, naming which to drop', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      research: 'x'.repeat(300),
      findings,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_CONFLICT');
  });

  it('refuses news mode with neither', async () => {
    const r = await call('build_writing_brief', { persona: 'jane-doe', topic: 'cricket', mode: 'news' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_REQUIRED');
  });

  it('refuses findings with an empty findings array', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: { ...findings, findings: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_EMPTY');
  });

  it('refuses findings where every publishedAt is null', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: { ...findings, findings: [{ ...findings.findings[0], publishedAt: null }] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_UNDATED');
  });

  it('refuses findings whose only dates fall outside the window', async () => {
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: { ...findings, findings: [{ ...findings.findings[0], publishedAt: old }] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_STALE');
  });

  it('refuses a BYOR string too thin to be research', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      research: 'AI is growing fast',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_THIN');
  });

  // The chosen BYOR strength: substance only. A URL-less string is ACCEPTED,
  // because legitimate notes (a customer call, a paywalled report) have no
  // public URL — but the result says plainly it was trusted, not checked.
  it('accepts a substantial BYOR string with no URLs, and says it is trusted not checked', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      research: 'Notes from a call with the head coach on 30 July. '.repeat(8),
    });
    expect(r.ok).toBe(true);
    expect(r.researchOrigin).toBe('byor');
    expect(r.brief).toContain('TRUSTED, NOT VERIFIED');
    expect((r.warnings as string[]).join(' ')).toContain('0 source URLs');
  });

  it('still needs no research at all in blog mode', async () => {
    const r = await call('build_writing_brief', { persona: 'jane-doe', topic: 'evergreen', mode: 'blog' });
    expect(r.ok).toBe(true);
    expect(r.researchOrigin).toBe('none');
  });

  // An empty findings array is never useful research. Gated behind news mode it
  // let blog mode render "GROUND THE ARTICLE IN THIS", a non-citable synthesis,
  // and an empty "CITE THESE" list, with researchOrigin: "provider" and zero
  // sources behind the article. Reachable by the ordinary flow: research
  // returns nothing and the topic is evergreen.
  it('refuses an empty findings array in blog mode too', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'blog',
      findings: { ...findings, findings: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_EMPTY');
  });

  // The grace is 6 hours at every window, not one whole day. `maxAgeDays + 1`
  // doubled the day window: a 47-hour-old source passed `window: 'day'`.
  it('refuses a two-day-old source under a one-day window', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: {
        ...findings,
        findings: [
          {
            ...findings.findings[0],
            publishedAt: new Date(Date.now() - 47 * 3600 * 1000).toISOString(),
          },
        ],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_STALE');
  });

  it('still accepts a source just past the window edge, within the coarse-timestamp grace', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: {
        ...findings,
        findings: [
          {
            ...findings.findings[0],
            publishedAt: new Date(Date.now() - 27 * 3600 * 1000).toISOString(),
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it('treats a far-future publishedAt as undated rather than fresh', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: {
        ...findings,
        findings: [{ ...findings.findings[0], publishedAt: '2099-01-01T00:00:00.000Z' }],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RESEARCH_UNDATED');
  });

  it('treats an unparseable publishedAt as undated, and never quotes it as a date', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: {
        ...findings,
        findings: [{ ...findings.findings[0], publishedAt: 'yesterday-ish' }],
      },
    });
    expect(r.ok).toBe(false);
    // Not RESEARCH_STALE with `Newest: yesterday-ish` — it was never a date.
    expect(r.code).toBe('RESEARCH_UNDATED');
    expect(JSON.stringify(r)).not.toContain('Newest');
  });

  // The guard passes on ONE in-window finding, on purpose — an article may cite
  // background alongside its breaking sources. What must not happen is the rest
  // being rendered as though they had passed too.
  it('accepts a mixed-age set but marks and warns about the stale one', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      findings: {
        ...findings,
        findings: [
          findings.findings[0],
          {
            url: 'https://old.test/x',
            title: 'Old',
            snippet: 'Background from three months ago.',
            publishedAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
            relevance: null,
            provider: 'tavily',
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.brief).toContain('OUTSIDE the day window');
    expect(r.brief).toContain('2 source(s), 2 dated, 1 inside the day window');
    expect((r.warnings as string[]).join(' ')).toContain('1 of 2 sources fall outside the day window');
  });

  // Follow-up review N1: `tallyWindow` defaults `now` to `Date.now()` when
  // omitted, and both the guard here and `buildBrief` used to call it without
  // passing one — each capturing its OWN clock reading, sub-millisecond apart.
  // Measured: with `publishedAt` exactly at the cutoff, 2 of 500 requests had
  // the guard accept while the brief's rendered header then reported the
  // source OUTSIDE the window it had just been admitted into.
  //
  // Racing the real clock to reproduce that (2-in-500) is neither reliable
  // nor "deterministic" as required. Mocking global `Date.now()` isn't a
  // clean substitute either: the MCP SDK itself calls `Date.now()` (request
  // timing in `shared/protocol.js`) before either of ours runs, so a simple
  // call-count-based mock cannot reliably target "the guard's call" and "the
  // brief's call" specifically. What IS fully deterministic, and exactly
  // what "thread a single now through one request" means at the call sites,
  // is that `tallyWindow` — the sole freshness authority both the guard
  // (`craft-tools.ts`) and the renderer (`brief.ts`) defer to — is invoked
  // TWICE per news-mode `findings` request, and BOTH invocations must carry
  // the SAME explicit `now`, not each defaulting its own. Spying on the
  // actual exported function pins exactly that, with no clock involved:
  // reverting to two independent `Date.now()` calls means at least one
  // invocation is missing the third argument entirely (`undefined`, not a
  // number), which fails the very first assertion below.
  it('threads one explicit `now` through both the guard and the brief for a single request', async () => {
    const spy = vi.spyOn(windowModule, 'tallyWindow');
    try {
      const r = await call('build_writing_brief', {
        persona: 'jane-doe',
        topic: 'cricket',
        mode: 'news',
        findings,
      });
      expect(r.ok).toBe(true);
      // One call from the guard, one from buildBrief.
      expect(spy).toHaveBeenCalledTimes(2);
      const nows = spy.mock.calls.map((args) => args[2]);
      expect(nows[0]).toBeTypeOf('number');
      expect(nows[1]).toBeTypeOf('number');
      // The same instant both times — not two clock readings sub-milliseconds
      // apart.
      expect(nows[0]).toBe(nows[1]);
      // Deterministic consequence of the same inputs: the guard's tally and
      // the brief's tally must be the identical verdict, not merely two
      // verdicts that happen to agree this run.
      expect(spy.mock.results[0]!.value).toEqual(spy.mock.results[1]!.value);
      // And the observable agreement this whole module exists to guarantee:
      // the guard admitted the finding as in-window, and the brief's header
      // says the same thing rather than re-judging it as outside.
      expect(r.brief).toContain('1 source(s), 1 dated, 1 inside the day window');
      expect(r.brief).not.toContain('OUTSIDE the day window');
      expect(r.warnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  // Task 9 builds the citation cross-check. Until it lands, nothing may promise
  // it — not the description, and not a warning the host model relays.
  it('never promises a score_draft cross-check in the URL-less BYOR warning', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'cricket',
      mode: 'news',
      research: 'Notes from a call with the head coach on 30 July. '.repeat(8),
    });
    expect(r.ok).toBe(true);
    expect((r.warnings as string[]).join(' ')).toContain('cannot be attributed inline');
    expect(JSON.stringify(r)).not.toContain('cross-check');
  });
});

// Task 9: `findings` must be declared in score_draft's zod inputSchema, or the
// MCP SDK silently strips it and the citation_provenance check reports "not
// evaluated" forever while every unit test (which calls scoreDraft directly,
// bypassing zod) still passes. feature_image_id shipped exactly that way —
// added to the type and the adapter, absent from the tool schema — for four
// phases. This test goes through the real MCP client/server transport, not a
// direct function call, so it is the one that would have caught it.
describe('score_draft findings survive the tool layer', () => {
  it('lets score_draft findings survive the tool layer and enable the check', async () => {
    const r = await call('score_draft', {
      html: '<p><a href="https://invented.test/x" rel="noopener noreferrer">x</a></p>',
      findings: [
        { url: 'https://a.test/r', title: 'A', snippet: 's', publishedAt: null, relevance: null, provider: 'tavily' },
      ],
    });
    const check = r.checks.find((c: { name: string }) => c.name === 'citation_provenance');
    expect(check.detail).not.toContain('not evaluated');
    expect(check.findings.join(' ')).toContain('https://invented.test/x');
  });

  // An empty findings array is a real research_topic outcome (a caller who
  // threads the field through unconditionally can produce one), and through
  // the real zod schema `[]` is wire-valid where `undefined` would be
  // omitted entirely — so this exercises a path the direct-function-call
  // tests in tests/craft/score.test.ts cannot.
  it('reports not evaluated for an empty findings array through the tool layer', async () => {
    const r = await call('score_draft', {
      html: '<p><a href="https://x.test/" rel="noopener noreferrer">x</a></p>',
      findings: [],
    });
    const check = r.checks.find((c: { name: string }) => c.name === 'citation_provenance');
    expect(check.detail).toContain('not evaluated');
    expect(check.ok).toBe(true);
  });
});

// The MCP SDK silently strips any key the input schema does not declare, so a
// field can exist on `PostInput`, be mapped correctly by every adapter, pass
// `tsc`, and still never reach the adapter from a real client. That is exactly
// how `feature_image_id` shipped doing nothing. These go through the real tool
// layer for that reason — the adapter suites cannot see this class of defect.
describe('create_post scheduling, through the real tool layer', () => {
  const ghostStub = (respond: (body: any) => unknown) => {
    let sent: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        if (i.body) sent = JSON.parse(String(i.body));
        return new Response(JSON.stringify(respond(sent)), { status: 201 });
      }),
    );
    return () => sent;
  };

  it('forwards publish_at to the adapter as Ghost’s published_at', async () => {
    const when = new Date(Date.now() + 3_600_000);
    when.setMilliseconds(0);
    const iso = when.toISOString();
    const sent = ghostStub(() => ({
      posts: [{ id: 'p1', url: 'u', title: 'T', status: 'scheduled', published_at: iso }],
    }));

    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
      status: 'scheduled',
      publish_at: iso,
    });

    expect(sent().posts[0].status).toBe('scheduled');
    expect(sent().posts[0].published_at).toBe(iso);
    expect(r.ok).toBe(true);
    expect(r.publish_at).toBe(iso);
  });

  // Each of these must be refused BEFORE any request is made — a guard that
  // only runs after the post exists is not a guard.
  it.each([
    ['scheduled with no publish_at', { status: 'scheduled' }, 'SCHEDULE_TIME_REQUIRED'],
    // A bare date is refused whatever the blog's timezone turns out to be, so
    // it must not cost a timezone lookup — see `needsSiteTimezone`.
    ['a bare date', { status: 'scheduled', publish_at: '2026-08-04' }, 'PUBLISH_AT_UNPARSEABLE'],
    ['a phrase', { status: 'scheduled', publish_at: 'next friday 9am' }, 'PUBLISH_AT_UNPARSEABLE'],
  ])('refuses %s without contacting the platform', async (_label, args, code) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      ...(args as Record<string, unknown>),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(fetchSpy, 'the guard must run before any network call').not.toHaveBeenCalled();
  });

  it('refuses a too-soon time, and a future time paired with status "published"', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const base = { site: 'personal', title: 'T', html: '<p>x</p>', images: 'none' };

    expect((await call('create_post', { ...base, status: 'scheduled', publish_at: soon })).code).toBe(
      'SCHEDULE_TIME_TOO_SOON',
    );
    expect((await call('create_post', { ...base, status: 'published', publish_at: later })).code).toBe(
      'SCHEDULE_STATUS_MISMATCH',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('backdates with a past time and status "published"', async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    past.setMilliseconds(0);
    const iso = past.toISOString();
    const sent = ghostStub(() => ({
      posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published', published_at: iso }],
    }));

    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
      status: 'published',
      publish_at: iso,
    });
    expect(sent().posts[0].published_at).toBe(iso);
    expect(r.ok).toBe(true);
  });

  // The floor is a measured number, not a slogan. If the constant moves, the
  // sentence the host model reads has to move with it — a description
  // promising a floor the guard no longer enforces is repeated to the user as
  // fact.
  it('states the real lead-time floor in the tool description', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['create_post', 'update_post']) {
      const desc = (tools.find((t) => t.name === name)!.inputSchema as any).properties.publish_at
        .description as string;
      expect(desc, name).toContain(`at least ${MIN_SCHEDULE_LEAD_MS / 60_000} minutes in the future`);
    }
  });
});

describe('update_post scheduling', () => {
  it('refuses publish_at with no status, since what it means depends on the post’s current state', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await call('update_post', {
      site: 'personal',
      post_id: 'p1',
      publish_at: '2026-09-04T09:00:00Z',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PUBLISH_AT_NEEDS_STATUS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('schedules an existing draft', async () => {
    const when = new Date(Date.now() + 3_600_000);
    when.setMilliseconds(0);
    const iso = when.toISOString();
    let put: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        if (i.method === 'PUT') {
          put = JSON.parse(String(i.body));
          return new Response(
            JSON.stringify({ posts: [{ id: 'p1', url: 'u', status: 'scheduled', published_at: iso }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ posts: [{ id: 'p1', updated_at: '2026-08-01T10:00:00.000Z' }] }),
          { status: 200 },
        );
      }),
    );

    const r = await call('update_post', {
      site: 'personal',
      post_id: 'p1',
      status: 'scheduled',
      publish_at: iso,
    });
    expect(put.posts[0].published_at).toBe(iso);
    expect(put.posts[0].status).toBe('scheduled');
    expect(r.publish_at).toBe(iso);
  });
});

// The rule the user asked for, proven through the real tool layer: "10am
// tomorrow" is 10am ON THE BLOG. Nothing about this machine may enter into it.
describe('a wall-clock publish_at is read in the blog’s timezone', () => {
  beforeEach(() => clearTimezoneCache());

  /** Ghost, answering /settings/ with a timezone and echoing the post back. */
  function ghostInZone(zone: string) {
    const calls: string[] = [];
    let sent: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL, i: RequestInit = {}) => {
        const url = String(u);
        calls.push(url);
        if (url.includes('settings/')) {
          return new Response(
            JSON.stringify({ settings: [{ key: 'title', value: 'T' }, { key: 'timezone', value: zone }] }),
            { status: 200 },
          );
        }
        sent = JSON.parse(String(i.body));
        return new Response(
          JSON.stringify({
            posts: [
              {
                id: 'p1',
                url: 'u',
                title: 'T',
                status: 'scheduled',
                published_at: sent.posts[0].published_at,
              },
            ],
          }),
          { status: 201 },
        );
      }),
    );
    return { calls, sent: () => sent };
  }

  const post = (publish_at: string) => ({
    site: 'personal',
    title: 'T',
    html: '<p>x</p>',
    images: 'none' as const,
    schema: false,
    status: 'scheduled' as const,
    publish_at,
  });

  it('converts 10am on an Asia/Kolkata blog to 04:30Z', async () => {
    const g = ghostInZone('Asia/Kolkata');
    const r = await call('create_post', post('2026-09-04T10:00'));
    expect(r.ok).toBe(true);
    expect(g.sent().posts[0].published_at).toBe('2026-09-04T04:30:00.000Z');
    expect(r.publish_at).toBe('2026-09-04T04:30:00.000Z');
    // What the user actually asked for, echoed back in their own terms.
    expect(r.publish_at_local).toBe('2026-09-04 10:00:00 (Asia/Kolkata)');
  });

  // Same string, different blog timezone, different instant. This is the pair
  // that makes the rule observable — either alone would also pass under a
  // naive host-timezone implementation.
  it('converts the SAME 10am to 06:00Z on an Asia/Dubai blog', async () => {
    const g = ghostInZone('Asia/Dubai');
    const r = await call('create_post', post('2026-09-04T10:00'));
    expect(g.sent().posts[0].published_at).toBe('2026-09-04T06:00:00.000Z');
    expect(r.publish_at_local).toBe('2026-09-04 10:00:00 (Asia/Dubai)');
  });

  it('takes an explicit offset at face value and does not consult the blog', async () => {
    const g = ghostInZone('Asia/Kolkata');
    const r = await call('create_post', post('2026-09-04T10:00:00Z'));
    expect(g.sent().posts[0].published_at).toBe('2026-09-04T10:00:00.000Z');
    expect(g.calls.some((u) => u.includes('settings/'))).toBe(false);
  });

  // A blog's timezone is a setting, not a per-request fact. Fetching it on
  // every publish would add a round trip to every post.
  it('fetches the blog timezone once, not once per post', async () => {
    const g = ghostInZone('Asia/Kolkata');
    await call('create_post', post('2026-09-04T10:00'));
    await call('create_post', post('2026-09-05T10:00'));
    expect(g.calls.filter((u) => u.includes('settings/'))).toHaveLength(1);
  });

  // Never silently assume UTC: that publishes five and a half hours early for
  // a Kolkata blog while reporting success.
  it('refuses rather than guessing when the blog reports no timezone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL) =>
        String(u).includes('settings/')
          ? new Response(JSON.stringify({ settings: [{ key: 'title', value: 'T' }] }), { status: 200 })
          : new Response(JSON.stringify({ posts: [{ id: 'p', url: 'u', status: 'scheduled' }] }), {
              status: 201,
            }),
      ),
    );
    const r = await call('create_post', post('2026-09-04T10:00'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_SITE_TIMEZONE');
  });
});

// Fix 3: `score_draft` returned all thirteen checks with their full prose on
// every call, passing ones included, which is roughly a thousand tokens of
// nothing actionable per score — and scores happen repeatedly per article.
// These go through the real tool layer because the trimming lives there, not in
// `scoreDraft`, and a unit test calling `scoreDraft` directly cannot see it.
describe('score_draft output trimming', () => {
  const CLEAN = '<table style="border:1px solid #ddd;"><tr><td>In short.</td></tr></table><h2>A</h2><p>[[content_image]]</p>';

  it('omits passing checks by default and lists them by name instead', async () => {
    const r = await call('score_draft', { html: CLEAN });
    const returned = r.checks.map((c: { name: string }) => c.name);
    // Everything returned in full is either failing or unevaluated.
    for (const c of r.checks) {
      expect(c.ok === false || c.evaluated === false, c.name).toBe(true);
    }
    expect(Array.isArray(r.passed)).toBe(true);
    // Nothing vanishes: every check is either returned in full or named.
    expect(returned.length + r.passed.length).toBe(13);
  });

  it('returns every check in full when verbose is set', async () => {
    const r = await call('score_draft', { html: CLEAN, verbose: true });
    expect(r.checks).toHaveLength(13);
    expect(r.passed).toBeUndefined();
    expect(r.checks.some((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  // The regression this nearly shipped: "not evaluated" is not "passed".
  // citation_provenance with no findings verified nothing, and collapsing it
  // into a name in `passed` would report unverified citations as checked.
  it('keeps an unevaluated check visible even though it is ok', async () => {
    const r = await call('score_draft', { html: CLEAN });
    const prov = r.checks.find((c: { name: string }) => c.name === 'citation_provenance');
    expect(prov).toBeDefined();
    expect(prov.ok).toBe(true);
    expect(prov.evaluated).toBe(false);
    expect(prov.detail).toContain('not evaluated');
    expect(r.passed).not.toContain('citation_provenance');
  });

  it('reports publishable and a summary through the tool layer', async () => {
    const r = await call('score_draft', { html: CLEAN });
    expect(r.publishable).toBe(true);
    expect(r.verdict).toBe('advisory');
    expect(r.summary).toContain('Publishable');
  });

  it('reports a blocking failure as not publishable', async () => {
    const r = await call('score_draft', { html: '<p class="x">a</p>' });
    expect(r.verdict).toBe('blocked');
    expect(r.publishable).toBe(false);
    expect(r.summary).toContain('NOT publishable');
  });
});

// Fix 5: `slug` did not exist anywhere in the post path, so an auto-generated
// seventy-character URL could only be shortened by hand in the platform's admin
// UI — after publication, which is when it is already being shared. Declared in
// the tool schema as well as on `PostInput`, because the MCP SDK strips
// undeclared keys and that is precisely how `feature_image_id` shipped inert.
describe('slug, through the real tool layer', () => {
  const ghostStub = (respond: (body: any) => unknown) => {
    let sent: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, i: RequestInit = {}) => {
        if (i.body) sent = JSON.parse(String(i.body));
        return new Response(JSON.stringify(respond(sent)), { status: 201 });
      }),
    );
    return () => sent;
  };

  it('reaches the adapter from create_post and is sent to the platform', async () => {
    const sent = ghostStub(() => ({
      posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published', slug: 'short-one' }],
    }));
    const r = await call('create_post', {
      site: 'personal',
      title: 'A very long headline that would otherwise become the whole URL',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
      slug: 'short-one',
    });
    expect(sent().posts[0].slug).toBe('short-one');
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  // The silent-wrong-result this guards: both platforms append a counter on a
  // collision, so the caller shares a URL the post does not live at. Ghost's
  // droppedFields cannot see it — a substituted slug is non-empty.
  it('warns when the platform stored a different slug than the one sent', async () => {
    ghostStub(() => ({
      posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published', slug: 'short-one-2' }],
    }));
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
      slug: 'short-one',
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('short-one-2');
    expect(r.warnings.join(' ')).toContain('already taken');
  });

  it('warns when the platform returns no slug at all', async () => {
    ghostStub(() => ({ posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published' }] }));
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
      slug: 'short-one',
    });
    expect(r.warnings.join(' ')).toContain('could not be verified');
  });

  // Ghost's updatePost does an optimistic-concurrency GET for `updated_at`
  // before the PUT, so the stub has to answer both.
  it('reaches the adapter from update_post too', async () => {
    const sent = ghostStub(() => ({
      posts: [
        {
          id: 'p1',
          url: 'u',
          title: 'T',
          status: 'published',
          slug: 'renamed',
          updated_at: '2026-08-10T00:00:00.000Z',
        },
      ],
    }));
    const r = await call('update_post', { site: 'personal', post_id: 'p1', slug: 'renamed' });
    expect(r.ok).toBe(true);
    expect(sent().posts[0].slug).toBe('renamed');
  });

  it('is not sent when the caller omits it, so the platform keeps generating one', async () => {
    const sent = ghostStub(() => ({
      posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published', slug: 'auto-generated' }],
    }));
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      images: 'none',
      schema: false,
    });
    expect(sent().posts[0].slug).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });
});

// Fix 4: illustrating one article took twelve tool calls — generate, read back
// to check, upload, four times over. The batch pair makes it two. These go
// through the real tool layer because that is where the batching, the
// per-image error isolation and the filename live.
describe('generate_images / upload_images — the batch pair', () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedXai = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.XAI_API_KEY;
  });

  afterEach(() => {
    // Restored per key. Reassigning process.env detaches it from the real
    // process environment and os.homedir() goes stale for the whole worker.
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
  });

  /** A real PNG header, so the dimensions in the result are genuinely parsed. */
  function pngBytes(w: number, h: number): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'ascii');
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([sig, ihdr]);
  }

  const geminiOk = (data: Buffer, mimeType = 'image/png') =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('generates every image in one call and reports dimensions read from the bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiOk(pngBytes(1344, 768))));

    const r = await call('generate_images', {
      images: [
        { prompt: 'a control room at shift change', slot: 'hero' },
        { prompt: 'an engineer at a terminal', slot: 'inline' },
        { prompt: 'a server aisle', slot: 'gallery', style: 'photoreal_scene' },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.generated).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.images).toHaveLength(3);
    for (const img of r.images) {
      expect(img.ok).toBe(true);
      expect(img.width).toBe(1344);
      expect(img.height).toBe(768);
      expect(img.format).toBe('png');
      expect(img.path).toMatch(/\.png$/);
    }
    // Order is preserved, so a caller can match results back to its own slots.
    expect(r.images.map((i: { slot: string }) => i.slot)).toEqual(['hero', 'inline', 'gallery']);
  });

  // The defect this closes: every file was written `.png` regardless of what
  // came back, and both adapters read the upload Content-Type off the
  // extension — so a Gemini JPEG was uploaded declaring itself a PNG.
  it('names the file for the format the provider actually returned', async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)]);
    vi.stubGlobal('fetch', vi.fn(async () => geminiOk(jpegBytes, 'image/jpeg')));

    const r = await call('generate_image', { prompt: 'a warehouse aisle', slot: 'hero' });
    expect(r.ok).toBe(true);
    expect(r.format).toBe('jpeg');
    expect(r.mime).toBe('image/jpeg');
    expect(r.path).toMatch(/\.jpg$/);
    expect(r.path).not.toMatch(/\.png$/);
  });

  // One safety-blocked prompt in a gallery of four must not throw away the
  // three that worked — that is the whole reason the batch reports per item
  // instead of failing as a unit.
  it('isolates a failure to its own image and keeps the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        const prompt = String(init?.body ?? '');
        if (prompt.includes('protest')) {
          return new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return geminiOk(pngBytes(1344, 768));
      }),
    );

    const r = await call('generate_images', {
      images: [
        { prompt: 'a quiet office', slot: 'a', style: 'photoreal_scene' },
        { prompt: 'a protest outside a building', slot: 'b', style: 'photoreal_scene' },
        { prompt: 'a boardroom', slot: 'c', style: 'photoreal_scene' },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.generated).toBe(2);
    expect(r.failed).toBe(1);
    const failedEntry = r.images.find((i: { ok: boolean }) => !i.ok);
    expect(failedEntry.slot).toBe('b');
    // Nothing fails silently: the error names the API and a real code.
    expect(failedEntry.error.api).toBeTruthy();
    expect(failedEntry.error.code).toBeTruthy();
    expect(r.note).toContain('1 of 3');
    // The successes are still usable.
    for (const good of r.images.filter((i: { ok: boolean }) => i.ok)) {
      expect(good.path).toBeTruthy();
    }
  });

  // The setup gate is resolved when the context is built, not read from the
  // live environment on each call, so this needs its own empty context rather
  // than deleting the env var mid-test.
  it('refuses the whole batch when no image provider is configured', async () => {
    const ctx = loadContext({ BYLINE_HOME: mkdtempSync(join(tmpdir(), 'wb-img-batch-')) });
    const r = await callWith(ctx, 'generate_images', { images: [{ prompt: 'x', slot: 'hero' }] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SETUP_INCOMPLETE');
  });

  it('uploads several files in one call and reports each result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiOk(pngBytes(800, 600))));
    const gen = await call('generate_images', {
      images: [
        { prompt: 'one', slot: 'hero' },
        { prompt: 'two', slot: 'inline' },
      ],
    });
    const paths = gen.images.map((i: { path: string }) => i.path);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ images: [{ url: 'https://cdn.test/x.png' }] }), { status: 201 }),
      ),
    );
    const r = await call('upload_images', {
      site: 'personal',
      images: [
        { path: paths[0], alt: 'first' },
        { path: paths[1], alt: 'second' },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.uploaded).toBe(2);
    expect(r.failed).toBe(0);
    for (const up of r.images) {
      expect(up.ok).toBe(true);
      expect(up.url).toBe('https://cdn.test/x.png');
      // The local path comes back so a caller can match a URL to the slot it
      // generated, without tracking array positions itself.
      expect(up.path).toBeTruthy();
    }
  });

  it('isolates an unreadable file to its own entry rather than failing the upload batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ images: [{ url: 'https://cdn.test/x.png' }] }), { status: 201 }),
      ),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ images: [{ url: 'https://cdn.test/x.png' }] }), { status: 201 })));
    const r = await call('upload_images', {
      site: 'personal',
      images: [{ path: '/nonexistent/definitely-not-here.png' }],
    });
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(1);
    expect(r.images[0].ok).toBe(false);
    expect(r.images[0].error.code).toBe('FILE_NOT_FOUND');
  });
});
