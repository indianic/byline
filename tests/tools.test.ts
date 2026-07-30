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
import type { PlatformPlugin } from '../src/plugins/platforms/types.js';
import { PLATFORM_PLUGINS } from '../src/plugins/registry.js';
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
  it('exposes all thirteen tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_site',
      'build_writing_brief',
      'create_post',
      'generate_image',
      'get_persona',
      'health_check',
      'list_authors',
      'list_personas',
      'list_sites',
      'remove_site',
      'score_draft',
      'update_post',
      'upload_image',
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
    expect(r.message).toContain('last30days');
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

  it('allows news mode once research is supplied', async () => {
    const r = await call('build_writing_brief', {
      persona: 'jane-doe',
      topic: 'AI',
      mode: 'news',
      research: 'TCS revenue per employee rose 3.4% in FY26.',
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
    await call('create_post', { site: 'personal', title: 'T', html: '<p>x</p>' });
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
    const r = await call('create_post', { site: 'personal', title: 'T', html: '<p>x</p>' });
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
      // This test is about author resolution, not images — pass one so the
      // fixture's configured image provider (see makeContext) doesn't add
      // its own "no feature_image" nudge and muddy the assertion below.
      feature_image: 'https://img/hero.png',
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
      // Author resolution is what this test checks; feature_image side-steps
      // the fixture's configured image provider adding its own nudge.
      feature_image: 'https://img/hero.png',
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
      // this, the fixture's configured image provider would add a second
      // warning and break the exact toHaveLength(1) below.
      feature_image: 'https://img/hero.png',
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

// Real user report: an image provider was configured and working, but
// articles kept publishing with no hero image. Nothing in the MCP protocol
// lets a server FORCE the calling agent to call generate_image before
// create_post — the brief can instruct it, but the only code-level lever
// left is to name the gap when it happens, loudly enough to notice, without
// blocking the publish (a false positive here — an article that genuinely
// doesn't want an image — must not become a hard failure).
describe('create_post — nudges toward the default image, does not enforce it', () => {
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

  it('warns when an image provider is configured and no feature_image was set', async () => {
    stubQuietCreate();
    const r = await call('create_post', { site: 'personal', title: 'T', html: '<p>x</p>', schema: false });
    expect(r.ok).toBe(true);
    expect(r.warnings?.some((w: string) => w.includes('feature_image') && w.includes('gemini'))).toBe(true);
  });

  it('does not warn once feature_image is set', async () => {
    stubQuietCreate();
    const r = await call('create_post', {
      site: 'personal',
      title: 'T',
      html: '<p>x</p>',
      schema: false,
      feature_image: 'https://img/hero.png',
    });
    expect(r.warnings).toBeUndefined();
  });

  it('does not warn when no image provider is configured — there is no default to nudge toward', async () => {
    stubQuietCreate();
    const ctx = makeContext();
    ctx.setup = { ...ctx.setup, imageProviders: [] };
    const r = await callWith(ctx, 'create_post', { site: 'personal', title: 'T', html: '<p>x</p>', schema: false });
    expect(r.warnings).toBeUndefined();
  });

  it('appends the nudge AFTER the platform\'s own warnings, never shifting their index', async () => {
    // A dropped custom_excerpt already produces warnings[0] elsewhere in this
    // file. This proves adding the nudge cannot silently move that index —
    // the excerpt warning must stay first even when both fire together.
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
      html: '<p>x</p>',
      custom_excerpt: 'dropped',
      schema: false,
    });
    expect(r.warnings?.[0]).toContain('custom_excerpt');
    expect(r.warnings?.some((w: string) => w.includes('feature_image'))).toBe(true);
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
    // The caller sent a bare subject; the tool supplied everything else.
    expect(seen[0]).toMatch(/^Photograph\./);
    expect(seen[0]).toContain('nurse checking a ward chart');
    expect(seen[0]).toMatch(/one or two people/i);
    expect(seen[0]).toMatch(/no text/i);
    expect(r.people_dropped).toBeUndefined();
  });

  it('passes the brief\'s look through verbatim when given one', async () => {
    const seen = stubGemini(okResponse);
    const look = 'Shot on a 24mm lens at f/5.6, broad ambient daylight, deep depth of field.';

    await call('generate_image', { prompt: 'a warehouse aisle', look });

    expect(seen[0]).toContain(look);
  });

  it('retries without people when every provider refuses, and says that it did', async () => {
    const seen = stubGemini((prompt) => (/one or two people/i.test(prompt) ? safetyResponse() : okResponse()));

    const r = await call('generate_image', { prompt: 'a clinic reception desk', slot: 'hero' });

    expect(r.ok).toBe(true);
    expect(r.people_dropped).toBe(true);
    expect(r.people_dropped_reason).toMatch(/SAFETY/i);
    // Two attempts: the people prompt, then the de-peopled one.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/one or two people/i);
    expect(seen[1]).not.toMatch(/one or two people/i);
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
