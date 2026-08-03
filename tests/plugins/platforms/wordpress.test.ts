import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { basicAuthHeader } from '../../../src/plugins/platforms/wordpress/auth.js';
import { WordPressAdapter, mimeFor } from '../../../src/plugins/platforms/wordpress/index.js';
import type { SiteConfig } from '../../../src/config/sites.js';
import { buildBrief } from '../../../src/craft/brief.js';
import { scoreDraft } from '../../../src/craft/score.js';
import type { Persona } from '../../../src/config/personas.js';

const site: SiteConfig = {
  slug: 'wp',
  platform: 'wordpress',
  url: 'https://wp.example.com',
  apiUrl: 'https://wp.example.com/wp-json',
  credentials: { username: 'editor', app_password: 'abcd EFGH ijkl MNOP' },
};

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

describe('basicAuthHeader', () => {
  it('base64-encodes username:password', () => {
    expect(basicAuthHeader('editor', 'pw')).toBe(`Basic ${Buffer.from('editor:pw').toString('base64')}`);
  });

  it('preserves the spaces WordPress displays in an application password', () => {
    // WordPress shows the password in space-separated groups and accepts it
    // either way. Reformatting it is a silent way to break a paste that worked.
    const h = basicAuthHeader('editor', 'abcd EFGH ijkl');
    expect(Buffer.from(h.slice('Basic '.length), 'base64').toString()).toBe('editor:abcd EFGH ijkl');
  });
});

describe('WordPressAdapter.healthCheck', () => {
  it('sends Basic auth to users/me with context=edit', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 3, name: 'Ed', capabilities: {} }), { status: 200 }));
    const r = await new WordPressAdapter(site).healthCheck();
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toContain('/wp/v2/users/me');
    expect(calls[0]!.url).toContain('context=edit');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  // Regression, mirroring Ghost's. Ghost's healthCheck probed `GET /site/`
  // for four phases believing it required auth; it did not, so a
  // fabricated-but-well-formed key returned ok:true with the real site title.
  // `init` accepted wrong keys and `doctor` stayed green until the first
  // create_post. See docs/ADDING-A-PLATFORM.md.
  //
  // Two independent things have to hold, and a probe can fail either way:
  // the request must actually CARRY the credential (one that sends no
  // Authorization header cannot be authenticated by any endpoint), and a
  // rejection must produce ok:false rather than being swallowed. The live
  // counterpart in tests/integration/wordpress.integration.test.ts covers the
  // third — that the endpoint really does require auth — which no mock can
  // establish, since that is a property of the remote install.
  it('carries the credential on the probe and reports a rejected one as unhealthy', async () => {
    const calls = stub(
      () => new Response(JSON.stringify({ code: 'incorrect_password', message: 'Bad app password.' }), { status: 401 }),
    );

    const r = await new WordPressAdapter(site).healthCheck();

    const sent = (calls[0]!.init!.headers as Record<string, string>).Authorization ?? '';
    expect(sent, 'the health probe sent no credential at all').toBeTruthy();
    expect(Buffer.from(sent.slice('Basic '.length), 'base64').toString()).toBe(
      `${site.credentials.username}:${site.credentials.app_password}`,
    );
    // And the endpoint probed is the authenticated one, not a public read.
    expect(calls[0]!.url).toContain('/wp/v2/users/me');
    expect(r.ok).toBe(false);
  });

  it('reports a 401 with the real body rather than a generic failure', async () => {
    stub(() => new Response(JSON.stringify({ code: 'incorrect_password', message: 'Bad app password.' }), { status: 401 }));
    const r = await new WordPressAdapter(site).healthCheck();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toContain('Bad app password');
  });

  it('never puts the application password in its output', async () => {
    stub(() => new Response('nope', { status: 500 }));
    const r = await new WordPressAdapter(site).healthCheck();
    expect(JSON.stringify(r)).not.toContain('abcd EFGH');
  });
});

/**
 * Every response below carries `title.raw` / `content.raw` (the `context=edit`
 * shape), never `.rendered` — asserting against `.rendered` would encode
 * WordPress's wpautop transformations as if they were our own bug.
 */
function wpResponses(overrides: {
  create?: Record<string, unknown>;
  readBack?: Record<string, unknown>;
}) {
  const create = {
    id: 42,
    link: 'https://wp.example.com/hello-world/',
    status: 'publish',
    ...overrides.create,
  };
  const readBack = {
    title: { raw: 'Hello' },
    content: { raw: '<p>Hi</p>' },
    ...overrides.readBack,
  };
  return (url: string, init?: RequestInit) => {
    if (url.includes('context=edit') && (!init || (init.method ?? 'GET') === 'GET')) {
      return new Response(JSON.stringify(readBack), { status: 200 });
    }
    return new Response(JSON.stringify(create), { status: init?.method === 'PUT' ? 200 : 201 });
  };
}

describe('WordPressAdapter.createPost', () => {
  it('maps status published -> publish and draft -> draft', async () => {
    let published: any;
    let draft: any;
    const calls1 = stub(
      wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }),
    );
    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'published' });
    published = JSON.parse(String(calls1.find((c) => c.init?.method === 'POST')!.init!.body));

    const calls2 = stub(
      wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }),
    );
    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    draft = JSON.parse(String(calls2.find((c) => c.init?.method === 'POST')!.init!.body));

    expect(published.status).toBe('publish');
    expect(draft.status).toBe('draft');
  });

  it('posts to /wp/v2/posts with the raw HTML as content', async () => {
    const calls = stub(
      wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>Raw &amp; unrendered</p>' } } }),
    );
    await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>Raw &amp; unrendered</p>',
      status: 'draft',
    });
    const createCall = calls.find((c) => c.init?.method === 'POST')!;
    expect(createCall.url).toContain('/wp/v2/posts');
    const body = JSON.parse(String(createCall.init!.body));
    expect(body.title).toBe('T');
    expect(body.content).toBe('<p>Raw &amp; unrendered</p>');
  });

  it('returns the url from the response link field', async () => {
    stub(wpResponses({ create: { link: 'https://wp.example.com/x/' }, readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.url).toBe('https://wp.example.com/x/');
    expect(r.id).toBe('42');
  });

  it('sets featured_media directly when feature_image_id is supplied', async () => {
    const calls = stub(wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      feature_image: 'https://wp.example.com/hero.png',
      feature_image_id: '9',
    });
    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'))!;
    const body = JSON.parse(String(createCall.init!.body));
    expect(body.featured_media).toBe(9);
    // Confirmed working by live probe on 2026-07-29: no warning is warranted once
    // an id is actually supplied.
    expect(r.warnings?.some((w) => w.startsWith('feature_image:'))).not.toBe(true);
  });

  it('warns about feature_image only when no feature_image_id accompanies it', async () => {
    stub(wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      feature_image: 'https://wp.example.com/hero.png',
    });
    expect(r.warnings?.some((w) => w.startsWith('feature_image:'))).toBe(true);
  });

  // Regression (I5/C3): Number("not-a-number") is NaN, which JSON.stringify
  // serialises as `null` — WordPress would silently clear/ignore the featured
  // image with no warning at all. A non-numeric feature_image_id must be
  // rejected with a warning, and must NOT be sent to WordPress as
  // `featured_media: null`.
  it('warns instead of sending NaN when feature_image_id is not numeric', async () => {
    const calls = stub(wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      feature_image: 'https://wp.example.com/hero.png',
      feature_image_id: 'https://wp.example.com/hero.png', // a URL passed by mistake
    });
    expect(r.warnings?.some((w) => w.startsWith('feature_image_id:'))).toBe(true);

    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'))!;
    const body = JSON.parse(String(createCall.init!.body));
    expect(body).not.toHaveProperty('featured_media');
  });

  it('reads the post back with context=edit rather than trusting the create response', async () => {
    const calls = stub(
      wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }),
    );
    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    const readCall = calls.find((c) => c.url.includes('context=edit'));
    expect(readCall).toBeDefined();
    expect(readCall!.url).toContain(`/wp/v2/posts/42`);
  });

  it('warns once per field WordPress core cannot store, naming the field', async () => {
    stub(wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      meta_title: 'seo title',
      meta_description: 'seo desc',
      canonical_url: 'https://example.com/x',
      og_title: 'og t',
      og_description: 'og d',
      og_image: 'https://example.com/og.png',
      twitter_title: 'tw t',
      twitter_description: 'tw d',
      twitter_image: 'https://example.com/tw.png',
      codeinjection_head: '<script>1</script>',
      feature_image_alt: 'alt text',
      feature_image_caption: 'caption text',
    });
    const fields = [
      'meta_title',
      'meta_description',
      'canonical_url',
      'og_title',
      'og_description',
      'og_image',
      'twitter_title',
      'twitter_description',
      'twitter_image',
      'codeinjection_head',
      'feature_image_alt',
      'feature_image_caption',
    ];
    expect(r.warnings).toBeDefined();
    for (const field of fields) {
      const matching = r.warnings!.filter((w) => w.startsWith(`${field}:`));
      expect(matching).toHaveLength(1);
    }
    // None of these unsupported fields should have made it into the request body.
    expect(r.warnings!.length).toBeGreaterThanOrEqual(fields.length);
  });

  it('produces no warnings when no unsupported field is set and content round-trips', async () => {
    stub(wpResponses({ readBack: { title: { raw: 'T' }, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.warnings).toBeUndefined();
  });

  it('warns when the read-back content differs from what was sent', async () => {
    stub(
      wpResponses({
        readBack: { title: { raw: 'T' }, content: { raw: '<p>REWRITTEN</p>' } },
      }),
    );
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => w.startsWith('content:'))).toBe(true);
  });

  it('warns when the read-back title differs from what was sent', async () => {
    stub(
      wpResponses({
        readBack: { title: { raw: 'REWRITTEN' }, content: { raw: '<p>x</p>' } },
      }),
    );
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.warnings!.some((w) => w.startsWith('title:'))).toBe(true);
  });
});

describe('WordPressAdapter.updatePost', () => {
  it('posts to /wp/v2/posts/{id}', async () => {
    const calls = stub(
      wpResponses({ readBack: { title: { raw: 'New' }, content: undefined } }),
    );
    await new WordPressAdapter(site).updatePost('42', { title: 'New' });
    const writeCall = calls.find((c) => c.init?.method && c.init.method !== 'GET');
    expect(writeCall).toBeDefined();
    expect(writeCall!.url).toContain('/wp/v2/posts/42');
    const body = JSON.parse(String(writeCall!.init!.body));
    expect(body.title).toBe('New');
  });

  it('only diffs the fields present in the patch', async () => {
    // html was not part of the patch, so a differing content.raw must not warn.
    stub(
      wpResponses({ readBack: { title: { raw: 'New' }, content: { raw: '<p>anything</p>' } } }),
    );
    const r = await new WordPressAdapter(site).updatePost('42', { title: 'New' });
    expect(r.warnings).toBeUndefined();
  });

  // Regression (M1): when the read-back response is missing content.raw/title.raw
  // for a field that WAS sent, the old `diffReadBack` silently produced no
  // warning at all — a false all-clear indistinguishable from "verified
  // identical". It must instead say verification did not run.
  it('reports that verification did not run when the read-back is missing content.raw', async () => {
    stub(wpResponses({ readBack: { title: { raw: 'T' }, content: undefined } }));
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => w.startsWith('content:') && w.includes('could not verify'))).toBe(true);
  });

  it('reports that verification did not run when the read-back is missing title.raw', async () => {
    stub(wpResponses({ readBack: { title: undefined, content: { raw: '<p>x</p>' } } }));
    const r = await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => w.startsWith('title:') && w.includes('could not verify'))).toBe(true);
  });
});

describe('mimeFor', () => {
  it('maps common image extensions', () => {
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.JPG')).toBe('image/jpeg');
    expect(mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeFor('a.webp')).toBe('image/webp');
    expect(mimeFor('a.gif')).toBe('image/gif');
  });

  it('falls back to octet-stream on an unknown extension', () => {
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
    expect(mimeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('WordPressAdapter.uploadImage', () => {
  it('posts raw bytes with an explicit Content-Type and Content-Disposition', async () => {
    let init: RequestInit = {};
    let url = '';
    const calls = stub(() => new Response(JSON.stringify({ id: 9, source_url: 'https://wp.example.com/hero.png' }), { status: 201 }));
    await new WordPressAdapter(site).uploadImage(Buffer.from('bytes'), 'hero.png');
    init = calls[0]!.init!;
    url = calls[0]!.url;

    expect(url).toContain('/wp/v2/media');
    // Raw bytes, not multipart — WordPress takes the body directly.
    expect(init.body).not.toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Disposition']).toBe('attachment; filename="hero.png"');
    // The MIME type MUST be explicit: Ghost returned 415 "Please select a valid
    // image" for a blob with none, and the same class of bug is plausible here.
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('returns the url from source_url', async () => {
    stub(() => new Response(JSON.stringify({ id: 9, source_url: 'https://wp.example.com/hero.png' }), { status: 201 }));
    const r = await new WordPressAdapter(site).uploadImage(Buffer.from('bytes'), 'hero.png');
    expect(r.url).toBe('https://wp.example.com/hero.png');
  });

  it('sets alt text with a follow-up request, since WordPress does not accept it on upload', async () => {
    const calls = stub((url) => {
      if (url.includes('/wp/v2/media/9')) {
        return new Response(JSON.stringify({ id: 9, alt_text: 'a hero image' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 9, source_url: 'https://wp.example.com/hero.png' }), { status: 201 });
    });
    await new WordPressAdapter(site).uploadImage(Buffer.from('bytes'), 'hero.png', 'a hero image');

    const altCall = calls.find((c) => c.url.includes('/wp/v2/media/9'));
    expect(altCall).toBeDefined();
    expect(JSON.parse(String(altCall!.init!.body))).toEqual({ alt_text: 'a hero image' });
  });

  it('does not make a follow-up request when no alt is given', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 9, source_url: 'https://wp.example.com/hero.png' }), { status: 201 }));
    await new WordPressAdapter(site).uploadImage(Buffer.from('bytes'), 'hero.png');
    expect(calls).toHaveLength(1);
  });
});

describe('WordPressAdapter.listTags', () => {
  it('lists all tags with ids as strings', async () => {
    stub(() => new Response(JSON.stringify([{ id: 5, name: 'AI', slug: 'ai' }]), { status: 200 }));
    const r = await new WordPressAdapter(site).listTags();
    expect(r).toEqual([{ id: '5', name: 'AI', slug: 'ai' }]);
  });
});

describe('WordPressAdapter tag resolution (via createPost)', () => {
  it('resolves an existing tag name to its id via /wp/v2/tags?search=', async () => {
    const calls = stub((url) => {
      if (url.includes('/wp/v2/tags?search=')) {
        return new Response(JSON.stringify([{ id: 7, name: 'AI' }]), { status: 200 });
      }
      if (url.includes('context=edit')) {
        return new Response(JSON.stringify({ title: { raw: 'T' }, content: { raw: '<p>x</p>' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 1, link: 'https://wp.example.com/x/', status: 'draft' }), { status: 201 });
    });

    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft', tags: ['AI'] });

    const searchCall = calls.find((c) => c.url.includes('/wp/v2/tags?search='));
    expect(searchCall).toBeDefined();
    expect(decodeURIComponent(searchCall!.url)).toContain('search=AI');

    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'));
    const body = JSON.parse(String(createCall!.init!.body));
    expect(body.tags).toEqual([7]);
  });

  // Regression: `search=` is a substring match. Searching "AI" also returns
  // "AI Ethics" — taking the first result would tag the post with the wrong term.
  it('matches a tag name exactly, case-insensitively, ignoring a substring match', async () => {
    const calls = stub((url) => {
      if (url.includes('/wp/v2/tags?search=')) {
        return new Response(
          JSON.stringify([
            { id: 1, name: 'AI Ethics' },
            { id: 2, name: 'ai' },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('context=edit')) {
        return new Response(JSON.stringify({ title: { raw: 'T' }, content: { raw: '<p>x</p>' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 1, link: 'u', status: 'draft' }), { status: 201 });
    });

    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft', tags: ['AI'] });

    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'));
    const body = JSON.parse(String(createCall!.init!.body));
    expect(body.tags).toEqual([2]); // the exact (case-insensitive) match, not "AI Ethics"
  });

  it('creates a tag that does not exist yet', async () => {
    const calls = stub((url, init) => {
      if (url.includes('/wp/v2/tags?search=')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/wp/v2/tags') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 99, name: 'Brand New' }), { status: 201 });
      }
      if (url.includes('context=edit')) {
        return new Response(JSON.stringify({ title: { raw: 'T' }, content: { raw: '<p>x</p>' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 1, link: 'u', status: 'draft' }), { status: 201 });
    });

    await new WordPressAdapter(site).createPost({ title: 'T', html: '<p>x</p>', status: 'draft', tags: ['Brand New'] });

    const createTagCall = calls.find((c) => c.url.endsWith('/wp/v2/tags') && c.init?.method === 'POST');
    expect(createTagCall).toBeDefined();
    expect(JSON.parse(String(createTagCall!.init!.body))).toEqual({ name: 'Brand New' });

    const createPostCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/wp/v2/posts'));
    const body = JSON.parse(String(createPostCall!.init!.body));
    expect(body.tags).toEqual([99]);
  });
});

describe('WordPressAdapter.listAuthors', () => {
  it('reads /wp/v2/users?per_page=100&context=edit and returns string ids', async () => {
    const calls = stub(() =>
      new Response(JSON.stringify([{ id: 3, name: 'Ed', email: 'ed@example.com' }, { id: 4, name: 'No Email' }]), {
        status: 200,
      }),
    );
    const r = await new WordPressAdapter(site).listAuthors();
    expect(calls[0]!.url).toContain('/wp/v2/users');
    expect(calls[0]!.url).toContain('per_page=100');
    expect(calls[0]!.url).toContain('context=edit');
    expect(r).toEqual([
      { id: '3', name: 'Ed', email: 'ed@example.com' },
      { id: '4', name: 'No Email' },
    ]);
  });
});

describe('WordPress html profile', () => {
  // The production cache in html-profile.ts is keyed by adapter.slug (per the
  // caching contract on PlatformPlugin.htmlProfile) so it survives across the
  // fresh adapter instances `makeAdapter` creates on every real tool call. That
  // means it also persists across `it` blocks in this file, since they all use
  // the same `site.slug`. Reset the module (and re-import) before each test so
  // the four scenarios below don't see each other's cached answer.
  let resolveWordPressProfile: (
    adapter: WordPressAdapter,
  ) => Promise<import('../../../src/craft/html-profile.js').HtmlProfile>;

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveWordPressProfile } = await import('../../../src/plugins/platforms/wordpress/html-profile.js'));
  });

  it('permits inline styles when the user holds unfiltered_html', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, name: 'A', capabilities: { unfiltered_html: true } }), { status: 200 }));
    const p = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(p.inlineStyles).toBe(true);
  });

  it('forbids inline styles when the user lacks it', async () => {
    // The multisite case: only super-admins hold unfiltered_html, so an editor
    // who publishes fine on single-site gets every style attribute stripped.
    stub(() => new Response(JSON.stringify({ id: 1, name: 'A', capabilities: {} }), { status: 200 }));
    const p = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(p.inlineStyles).toBe(false);
  });

  it('assumes the restrictive profile when the capability cannot be read', async () => {
    // Guessing permissive produces a draft that publishes unstyled with no
    // warning. Guessing restrictive produces a plainer draft that always works.
    stub(() => new Response('boom', { status: 500 }));
    const p = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(p.inlineStyles).toBe(false);
  });

  it('caches per adapter so scoring does not re-probe', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 1, capabilities: { unfiltered_html: true } }), { status: 200 }));
    const adapter = new WordPressAdapter(site);
    await resolveWordPressProfile(adapter);
    await resolveWordPressProfile(adapter);
    expect(calls.length).toBe(1);
  });

  // The real production call path (`profileFor` in src/tools/craft-tools.ts)
  // constructs a BRAND NEW adapter via `makeAdapter(site)` on every single
  // `score_draft`/`build_writing_brief` invocation — it never reuses the same
  // adapter object the way the test above does. A cache keyed on adapter
  // *identity* (e.g. a WeakMap) would pass the test above yet still issue one
  // HTTP call per tool invocation in production. This test constructs two
  // separate adapter instances for the same site to prove the cache is keyed
  // by something that survives that — `adapter.slug`.
  it('caches per site across freshly-constructed adapter instances, not just per adapter object', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 1, capabilities: { unfiltered_html: true } }), { status: 200 }));
    await resolveWordPressProfile(new WordPressAdapter(site));
    await resolveWordPressProfile(new WordPressAdapter(site));
    expect(calls.length).toBe(1);
  });

  it('labels itself WordPress (capital W, capital P), distinct from the lowercase platform id', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: {} }), { status: 200 }));
    const p = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(p.platform).toBe('wordpress');
    expect(p.label).toBe('WordPress');
  });

  it('carries its own notes, never Ghost\'s "styled <table>" instruction', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: {} }), { status: 200 }));
    const p = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(p.notes.length).toBeGreaterThan(0);
    expect(p.notes.some((n) => n.includes('styled <table>'))).toBe(false);
  });

  it('gives different notes for the permissive and restrictive capability states', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: { unfiltered_html: true } }), { status: 200 }));
    const permissive = await resolveWordPressProfile(new WordPressAdapter(site));

    vi.resetModules();
    ({ resolveWordPressProfile } = await import('../../../src/plugins/platforms/wordpress/html-profile.js'));
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: {} }), { status: 200 }));
    const restrictive = await resolveWordPressProfile(new WordPressAdapter(site));

    expect(permissive.notes).not.toEqual(restrictive.notes);
  });

  // Regression (C2, I4): only the permissive branch was confirmed by a live
  // probe; the restrictive branch is reasoned from documented KSES behaviour,
  // never measured. `verified` drives the honesty of buildBrief's header.
  it('marks the permissive profile verified and the restrictive profile unverified', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: { unfiltered_html: true } }), { status: 200 }));
    const permissive = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(permissive.verified).toBe(true);

    vi.resetModules();
    ({ resolveWordPressProfile } = await import('../../../src/plugins/platforms/wordpress/html-profile.js'));
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: {} }), { status: 200 }));
    const restrictive = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(restrictive.verified).toBe(false);
  });

  // Regression (C2): a FAILED capability read must not be cached the same way
  // a successful one is — before this fix, `hasUnfilteredHtml` swallowed every
  // error into `false` and `resolveWordPressProfile` cached whatever it
  // returned unconditionally, so a single transient network blip permanently
  // forced the restrictive profile for that site until the process restarted.
  it('does not cache a failed capability read, and retries on the next call', async () => {
    // First call: the capability read fails outright (500).
    stub(() => new Response('boom', { status: 500 }));
    const afterFailure = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(afterFailure.inlineStyles).toBe(false); // fail-safe: restrictive for this call

    // Second call, same adapter.slug: if the failure had been cached, this
    // stub would never be consulted and the result would still be
    // restrictive. It IS consulted, proving the failure was not cached.
    const calls = stub(
      () => new Response(JSON.stringify({ id: 1, capabilities: { unfiltered_html: true } }), { status: 200 }),
    );
    const afterRetry = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(afterRetry.inlineStyles).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  // C2's central claim: `score_draft` must be able to PASS on the restrictive
  // (unfiltered_html: false) path. Before the fix, `visualContainers: []`
  // made the BLOCKING `ai_summary_block` check ([].some(...) is always false)
  // impossible to ever satisfy, and `RESTRICTIVE_UNWRAPPED` containing `table`
  // made the recommended container simultaneously required and forbidden.
  it('builds a brief for the restrictive profile whose rules a conforming draft can pass score_draft against', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, capabilities: {} }), { status: 200 }));
    const restrictive = await resolveWordPressProfile(new WordPressAdapter(site));
    expect(restrictive.inlineStyles).toBe(false);
    // The fix: a real, non-empty container is recommended even though nothing
    // is confirmed to keep custom styling.
    expect(restrictive.visualContainers).toEqual(['table']);
    // I3: <figure>/<figcaption> must be preserved, since brief.ts documents
    // [[content_image]] as being replaced with a <figure> — the restrictive
    // profile must not flag content the pipeline itself generates.
    expect(restrictive.preserved.has('figure')).toBe(true);
    expect(restrictive.preserved.has('figcaption')).toBe(true);
    // The table family must be preserved, not unwrapped — KSES strips
    // attributes, not structural elements.
    for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td']) {
      expect(restrictive.preserved.has(tag)).toBe(true);
      expect(restrictive.unwrapped.has(tag)).toBe(false);
    }

    const persona: Persona = {
      slug: 'jane-doe',
      name: 'Jane Doe',
      gender: 'female',
      role: 'CTO',
      country: 'India',
      state: 'Gujarat',
      years_of_experience: 18,
      language_written: 'English',
      writing_style: 'Analytical',
      tone_of_voice: 'Dry',
      communication_style: 'Clear',
      storytelling_style: 'Narrative',
      sentence_structure: 'Varied',
      local_journalistic_style: '',
      cultural_influence: 'Indian IT',
      description: 'Delivery',
      subject_expertise: 'Cloud',
      industry_specialization: 'SaaS',
      beats_or_focus_areas: 'AI',
      personality_traits: 'Blunt',
      political_leaning: 'neutral',
      bias_tendency: 'Anti-hype',
      risk_tolerance_in_opinions: 'high',
      influence_level: 'senior',
      research_methodology: 'Primary data',
      persona_specific_instructions_for_ai: 'Name the real trade-off.',
      platform_authors: {},
    };

    const brief = buildBrief({
      persona,
      topic: 'AI agents in fintech',
      mode: 'blog',
      profile: restrictive,
      seed: 11,
    });
    // Prove the brief itself is honest about the restrictive path, then prove
    // a draft that follows its rules actually clears score_draft.
    expect(brief.brief).toContain('UNVERIFIED');
    // No tag is instructed to carry a style= attribute (the notes DO mention
    // `style=""` in prose, describing what gets stripped — that is fine; what
    // must never appear is an actual `<tag style=...` instruction).
    const instructedStyle = [...brief.brief.matchAll(/<(\w+)[^>]*\sstyle\s*=/g)].map((m) => m[1]);
    expect(instructedStyle).toEqual([]);

    // A draft built to the letter of the restrictive rules: a plain (unstyled)
    // <table> summary block above the first H2, no class/style attributes, no
    // tag outside RESTRICTIVE_PRESERVED, one [[content_image]] placeholder.
    const conformingHtml =
      '<table><tbody><tr><td><strong>In short:</strong> outcome pricing cuts fixed-fee risk.</td></tr></tbody></table>' +
      '<h2>What is outcome pricing?</h2>' +
      '<p>Outcome pricing ties fees to results rather than hours worked.</p>' +
      '<p>[[content_image]]</p>' +
      '<h3>How do you start?</h3>' +
      '<p>Start with one measurable outcome and a fixed baseline.</p>';

    const card = scoreDraft(conformingHtml, restrictive);
    const blockingChecks = card.checks.filter((c) => c.blocking);
    expect(
      blockingChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.findings.join('; ')}`),
    ).toEqual([]);
    expect(card.verdict).not.toBe('blocked');
  });
});

// Ghost has always refused an unreplaced placeholder; WordPress did not, so an
// article whose [[content_image]] was never swapped for real <figure> markup
// published with that literal text visible on the page. Nothing in this
// codebase performs the substitution — the caller does — so forgetting it is an
// ordinary mistake, and the two platforms disagreeing about it is the shape of
// defect this project keeps shipping.
describe('WordPressAdapter — unresolved image placeholder', () => {
  it('refuses to create a post whose HTML still contains [[content_image]]', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    await expect(
      new WordPressAdapter(site).createPost({
        title: 'T',
        html: '<p>Intro.</p>[[content_image]]<h2>Section</h2>',
        status: 'draft',
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER' });
    // The real assertion: it refused BEFORE writing anything to the site.
    expect(calls).toHaveLength(0);
  });

  it('refuses an update carrying the placeholder too', async () => {
    const calls = stub(() => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    await expect(
      new WordPressAdapter(site).updatePost('1', { html: '<p>x</p>[[content_image]]' }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER' });
    expect(calls).toHaveLength(0);
  });

  it('allows HTML that has had the placeholder replaced', async () => {
    stub(() => new Response(JSON.stringify({ id: 1, link: 'https://x/1', status: 'draft' }), { status: 201 }));
    await expect(
      new WordPressAdapter(site).createPost({
        title: 'T',
        html: '<p>Intro.</p><figure><img src="https://x/i.png" alt="a"></figure><h2>S</h2>',
        status: 'draft',
      }),
    ).resolves.toMatchObject({ id: '1' });
  });
});

describe('WordPressAdapter scheduling', () => {
  const SCHEDULED = '2026-08-04T09:00:00.000Z';
  /** What WordPress echoes back: UTC, no offset marker. */
  const WIRE = '2026-08-04T09:00:00';

  /** create + read-back, with the fields the scheduling path actually reads. */
  function schedulingStub(readBackOverrides: Record<string, unknown> = {}) {
    return stub((url, init) => {
      if (url.includes('context=edit') && (!init || (init.method ?? 'GET') === 'GET')) {
        return new Response(
          JSON.stringify({
            title: { raw: 'T' },
            content: { raw: '<p>x</p>' },
            status: 'future',
            date_gmt: WIRE,
            ...readBackOverrides,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: 42, link: 'https://wp.example.com/?p=42', status: 'future', date_gmt: WIRE }),
        { status: init?.method === 'PUT' ? 200 : 201 },
      );
    });
  }

  it('maps status scheduled -> future and publish_at -> date_gmt', async () => {
    const calls = schedulingStub();
    await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
    expect(body.status).toBe('future');
    // `date_gmt`, never `date`: `date` is read in the SITE's timezone, so a UTC
    // instant sent there lands at the wrong hour on any non-UTC site — and the
    // site this was probed against was UTC, which is exactly where that mistake
    // is invisible.
    expect(body.date_gmt).toBe(WIRE);
    expect(body.date).toBeUndefined();
  });

  it('strips the trailing Z, matching the form WordPress echoes back', async () => {
    const calls = schedulingStub();
    await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
    expect(body.date_gmt.endsWith('Z')).toBe(false);
  });

  // THE defect this feature is defended against. WordPress answers 201 with the
  // status quietly rewritten to `publish`, no error anywhere, and the article
  // live. Reporting that as a successful schedule is the failure.
  it('refuses to report success when WordPress published instead of scheduling', async () => {
    schedulingStub({ status: 'publish' });
    await expect(
      new WordPressAdapter(site).createPost({
        title: 'T',
        html: '<p>x</p>',
        status: 'scheduled',
        publish_at: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_NOT_APPLIED' });
  });

  it('checks the read-back, not the create response, since the create response is what got rewritten', async () => {
    // Create says `future`; the read-back — the post's actual state — says
    // `publish`. Trusting the create response here would report success.
    stub((url, init) => {
      if (url.includes('context=edit') && (!init || (init.method ?? 'GET') === 'GET') ) {
        return new Response(
          JSON.stringify({ title: { raw: 'T' }, content: { raw: '<p>x</p>' }, status: 'publish', date_gmt: WIRE }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: 42, link: 'https://wp.example.com/?p=42', status: 'future', date_gmt: WIRE }),
        { status: 201 },
      );
    });
    await expect(
      new WordPressAdapter(site).createPost({
        title: 'T',
        html: '<p>x</p>',
        status: 'scheduled',
        publish_at: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_NOT_APPLIED' });
  });

  it('reports the stored publish time back as explicit UTC', async () => {
    schedulingStub();
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    expect(r.publish_at).toBe(SCHEDULED);
    expect(r.status).toBe('future');
  });

  // It was listed in UNSUPPORTED_FIELD_REASONS while scheduling was unwired.
  // Leaving it there would now warn that a field was dropped on every call
  // where it was stored correctly.
  it('no longer warns that a publish time was not sent', async () => {
    schedulingStub();
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    expect(JSON.stringify(r.warnings ?? [])).not.toMatch(/publish_at|not wired up/);
  });

  it('warns when WordPress stored a different instant than was sent', async () => {
    schedulingStub({ status: 'publish', date_gmt: '2026-08-04T11:00:00' });
    const r = await new WordPressAdapter(site).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'published',
      publish_at: SCHEDULED,
    });
    expect(r.warnings?.join(' ')).toContain('2026-08-04T11:00:00.000Z');
  });

  // The status map used to be `status === 'published' ? 'publish' : 'draft'`,
  // which folds every unrecognised status into a draft. Adding `scheduled`
  // without touching it would have silently drafted every scheduled post.
  it('never folds an unhandled status into draft', async () => {
    for (const [input, wire] of [
      ['published', 'publish'],
      ['draft', 'draft'],
      ['scheduled', 'future'],
    ] as const) {
      const calls = schedulingStub({ status: wire });
      await new WordPressAdapter(site).createPost({
        title: 'T',
        html: '<p>x</p>',
        status: input,
        ...(input === 'scheduled' ? { publish_at: SCHEDULED } : {}),
      });
      const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
      expect(body.status, `${input} should map to ${wire}`).toBe(wire);
    }
  });
});

describe('WordPressAdapter.siteTimezone', () => {
  const root = (body: Record<string, unknown>) =>
    stub((url) => {
      if (url.endsWith('/wp-json/') || url.endsWith('/wp-json')) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

  // Measured 2026-08-03: the probed install returns gmt_offset as the STRING
  // "0", despite WordPress documenting it as a number. A `typeof === 'number'`
  // check would reject this exact real site, and arithmetic on "0" would
  // concatenate rather than add.
  it('accepts gmt_offset as a string, which is what a real install returned', async () => {
    root({ timezone_string: '', gmt_offset: '0' });
    expect(await new WordPressAdapter(site).siteTimezone()).toEqual({
      kind: 'fixed',
      offsetMinutes: 0,
      label: 'UTC+00:00',
    });
  });

  it('accepts gmt_offset as a number too', async () => {
    root({ timezone_string: '', gmt_offset: -8 });
    expect(await new WordPressAdapter(site).siteTimezone()).toEqual({
      kind: 'fixed',
      offsetMinutes: -480,
      label: 'UTC-08:00',
    });
  });

  // Half- and quarter-hour offsets are real: India 5.5, Nepal 5.75,
  // Chatham 12.75. Truncating hours would put those blogs 30-45 min out.
  it.each([
    ['5.5', 330, 'UTC+05:30'],
    ['5.75', 345, 'UTC+05:45'],
    ['-9.5', -570, 'UTC-09:30'],
  ])('handles the fractional offset %s', async (raw, offsetMinutes, label) => {
    root({ timezone_string: '', gmt_offset: raw });
    expect(await new WordPressAdapter(site).siteTimezone()).toEqual({ kind: 'fixed', offsetMinutes, label });
  });

  // An IANA name knows about daylight saving; a fixed offset cannot. When
  // WordPress offers both, the name has to win.
  it('prefers timezone_string over gmt_offset when the site is configured by city', async () => {
    root({ timezone_string: 'America/New_York', gmt_offset: '-5' });
    expect(await new WordPressAdapter(site).siteTimezone()).toEqual({
      kind: 'iana',
      zone: 'America/New_York',
    });
  });

  // Never UTC-by-default: that publishes at the wrong hour while reporting
  // success. A refusal sends the caller to an explicit offset instead.
  it('throws rather than assuming UTC when neither field is usable', async () => {
    root({ timezone_string: '', gmt_offset: null });
    await expect(new WordPressAdapter(site).siteTimezone()).rejects.toMatchObject({
      code: 'NO_SITE_TIMEZONE',
    });
  });
});
