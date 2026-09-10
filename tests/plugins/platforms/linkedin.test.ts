import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '../../../src/config/sites.js';
import { LINKEDIN_VERSION, LinkedInAdapter } from '../../../src/plugins/platforms/linkedin/index.js';

const SITE: SiteConfig = {
  slug: 'li',
  platform: 'linkedin',
  url: 'https://www.linkedin.com/in/someone',
  apiUrl: 'https://api.linkedin.com',
  credentials: {
    access_token: 'AQVfabricatedtoken',
    author_urn: 'urn:li:person:abc123',
  },
};

function stub(status: number, body: unknown, headers: Record<string, string> = {}, capture?: (u: string, i: RequestInit) => void) {
  return vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    capture?.(String(url), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('LinkedInAdapter.healthCheck', () => {
  it('reports ok with name and sub on 200 from /v2/userinfo', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      stub(200, { name: 'Jane Doe', sub: 'abc123' }, {}, (u) => {
        requestedUrl = u;
      }),
    );
    const r = await new LinkedInAdapter(SITE).healthCheck();
    expect(requestedUrl).toContain('/v2/userinfo');
    expect(r).toEqual({
      slug: 'li',
      platform: 'linkedin',
      ok: true,
      status: 200,
      detail: 'Authenticated as Jane Doe (abc123)',
    });
  });

  // Required by ADDING-A-PLATFORM.md rule 4: healthCheck must gate on an
  // endpoint that genuinely requires the credential. A fabricated token
  // against a mocked 401 must report ok: false, never ok: true.
  it('reports ok:false for a fabricated token (mocked 401)', async () => {
    vi.stubGlobal('fetch', stub(401, { message: 'Invalid access token' }));
    const r = await new LinkedInAdapter(SITE).healthCheck();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toContain('Invalid access token');
  });

  it('reports failure without throwing on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    );
    const r = await new LinkedInAdapter(SITE).healthCheck();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ENOTFOUND');
  });
});

describe('LinkedInAdapter request headers', () => {
  it('sends the Authorization bearer header on every call', async () => {
    let authHeader: string | undefined;
    vi.stubGlobal(
      'fetch',
      stub(200, { name: 'Jane', sub: 'abc123' }, {}, (_u, init) => {
        authHeader = (init.headers as Record<string, string>).Authorization;
      }),
    );
    await new LinkedInAdapter(SITE).healthCheck();
    expect(authHeader).toBe('Bearer AQVfabricatedtoken');
  });
});

describe('LinkedInAdapter.createPost', () => {
  function postSite(): SiteConfig {
    return { ...SITE, credentials: { ...SITE.credentials } };
  }

  it('refuses status !== "published" with DRAFTS_UNSUPPORTED', async () => {
    const adapter = new LinkedInAdapter(postSite());
    await expect(
      adapter.createPost({ title: 'T', html: '<p>hello</p>', status: 'draft' }),
    ).rejects.toMatchObject({ code: 'DRAFTS_UNSUPPORTED' });
  });

  it('refuses html containing [[article_url]] with UNRESOLVED_PLACEHOLDER', async () => {
    const adapter = new LinkedInAdapter(postSite());
    await expect(
      adapter.createPost({
        title: 'T',
        html: '<p>Read more: [[article_url]]</p>',
        status: 'published',
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER' });
  });

  it('refuses commentary over 3000 characters with COMMENTARY_TOO_LONG', async () => {
    const adapter = new LinkedInAdapter(postSite());
    const longHtml = `<p>${'a'.repeat(3001)}</p>`;
    await expect(
      adapter.createPost({ title: 'T', html: longHtml, status: 'published' }),
    ).rejects.toMatchObject({ code: 'COMMENTARY_TOO_LONG' });
  });

  it('sends the documented body, hits /rest/posts, and returns the feed/update URL from x-restli-id', async () => {
    let sentBody: unknown;
    let sentHeaders: Record<string, string> = {};
    let requestCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        requestCount++;
        const u = String(url);
        if (u.includes('/rest/posts/') && init.method === undefined) {
          // read-back GET
          return new Response(JSON.stringify({ commentary: 'ignored-for-this-test' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        sentBody = init.body ? JSON.parse(String(init.body)) : undefined;
        sentHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-restli-id': 'urn:li:share:12345' },
        });
      }),
    );

    const adapter = new LinkedInAdapter(postSite());
    const result = await adapter.createPost({
      title: 'My Article',
      html: '<p>First paragraph.</p><p>Second paragraph.</p>',
      status: 'published',
      canonical_url: 'https://blog.example.com/my-article',
      custom_excerpt: 'A short excerpt',
      feature_image_id: 'urn:li:image:abc',
      tags: ['machine learning', 'ai ethics'],
    });

    expect(sentBody).toMatchObject({
      author: 'urn:li:person:abc123',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        article: {
          source: 'https://blog.example.com/my-article',
          title: 'My Article',
          description: 'A short excerpt',
          thumbnail: 'urn:li:image:abc',
        },
      },
    });
    expect((sentBody as { commentary: string }).commentary).toContain('First paragraph.');
    expect((sentBody as { commentary: string }).commentary).toContain('Second paragraph.');
    expect((sentBody as { commentary: string }).commentary).toContain('https://blog.example.com/my-article');
    expect((sentBody as { commentary: string }).commentary).toContain('#MachineLearning');
    expect((sentBody as { commentary: string }).commentary).toContain('#AiEthics');
    expect(sentHeaders['LinkedIn-Version']).toBe(LINKEDIN_VERSION);
    expect(sentHeaders['X-Restli-Protocol-Version']).toBe('2.0.0');

    expect(result.id).toBe('urn:li:share:12345');
    expect(result.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:12345/');
    expect(result.status).toBe('published');
  });

  it('throws NO_POST when the response carries no x-restli-id header', async () => {
    vi.stubGlobal('fetch', stub(201, {}));
    const adapter = new LinkedInAdapter(postSite());
    await expect(
      adapter.createPost({ title: 'T', html: '<p>hi</p>', status: 'published' }),
    ).rejects.toMatchObject({ code: 'NO_POST' });
  });

  it('warns naming the field for an unsupported field like og_title', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, {}, { 'x-restli-id': 'urn:li:share:1' }),
    );
    const adapter = new LinkedInAdapter(postSite());
    const result = await adapter.createPost({
      title: 'T',
      html: '<p>hi</p>',
      status: 'published',
      og_title: 'Some OG title',
    });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.startsWith('og_title:'))).toBe(true);
  });

  it('warns when feature_image is set without feature_image_id', async () => {
    vi.stubGlobal('fetch', stub(201, {}, { 'x-restli-id': 'urn:li:share:1' }));
    const adapter = new LinkedInAdapter(postSite());
    const result = await adapter.createPost({
      title: 'T',
      html: '<p>hi</p>',
      status: 'published',
      feature_image: 'https://example.com/photo.jpg',
    });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.startsWith('feature_image:'))).toBe(true);
  });

  it('resolves the literal urn:li:person:me author_urn via /v2/userinfo sub, memoised across calls', async () => {
    let userinfoCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        const u = String(url);
        if (u.includes('/v2/userinfo')) {
          userinfoCalls++;
          return new Response(JSON.stringify({ sub: 'resolved-sub', name: 'Me' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/rest/posts/')) {
          return new Response(JSON.stringify({ commentary: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-restli-id': 'urn:li:share:9' },
        });
      }),
    );
    const site: SiteConfig = { ...SITE, credentials: { ...SITE.credentials, author_urn: 'urn:li:person:me' } };
    const adapter = new LinkedInAdapter(site);
    await adapter.createPost({ title: 'T', html: '<p>hi 1</p>', status: 'published' });
    await adapter.createPost({ title: 'T2', html: '<p>hi 2</p>', status: 'published' });
    expect(userinfoCalls).toBe(1);
  });
});

describe('LinkedInAdapter.updatePost', () => {
  it('PATCHes commentary via { patch: { $set: { commentary } } }', async () => {
    let sentBody: unknown;
    let sentPath = '';
    vi.stubGlobal(
      'fetch',
      stub(200, {}, {}, (u, init) => {
        sentPath = u;
        sentBody = init.body ? JSON.parse(String(init.body)) : undefined;
      }),
    );
    const adapter = new LinkedInAdapter(SITE);
    const r = await adapter.updatePost('urn:li:share:12345', { html: '<p>updated text</p>' });
    expect(sentPath).toContain('rest/posts/');
    expect(sentBody).toEqual({ patch: { $set: { commentary: 'updated text' } } });
    expect(r.id).toBe('urn:li:share:12345');
  });

  it('throws NOTHING_TO_UPDATE when patch carries no html', async () => {
    const adapter = new LinkedInAdapter(SITE);
    await expect(adapter.updatePost('urn:li:share:1', { title: 'New title' })).rejects.toMatchObject({
      code: 'NOTHING_TO_UPDATE',
    });
  });
});

describe('LinkedInAdapter.uploadImage', () => {
  it('hits initializeUpload then PUTs the bytes to the returned uploadUrl', async () => {
    const calls: string[] = [];
    let putContentType: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('initializeUpload')) {
          return new Response(
            JSON.stringify({
              value: { uploadUrl: 'https://upload.linkedin.com/put-here', image: 'urn:li:image:xyz' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u === 'https://upload.linkedin.com/put-here') {
          putContentType = (init.headers as Record<string, string>)['Content-Type'];
          return new Response('', { status: 201 });
        }
        throw new Error(`unexpected url ${u}`);
      }),
    );
    const adapter = new LinkedInAdapter(SITE);
    const result = await adapter.uploadImage(Buffer.from('fake-bytes'), 'photo.jpg');
    expect(calls[0]).toContain('initializeUpload');
    expect(calls[1]).toBe('https://upload.linkedin.com/put-here');
    expect(putContentType).toBe('image/jpeg');
    expect(result).toEqual({ url: 'urn:li:image:xyz', id: 'urn:li:image:xyz' });
  });

  it('throws NO_UPLOAD_URL when initializeUpload returns no uploadUrl/image', async () => {
    vi.stubGlobal('fetch', stub(200, {}));
    const adapter = new LinkedInAdapter(SITE);
    await expect(adapter.uploadImage(Buffer.from('x'), 'a.png')).rejects.toMatchObject({
      code: 'NO_UPLOAD_URL',
    });
  });
});

describe('LinkedInAdapter.siteTimezone', () => {
  it('throws NO_SITE_TIMEZONE', async () => {
    const adapter = new LinkedInAdapter(SITE);
    await expect(adapter.siteTimezone()).rejects.toMatchObject({ code: 'NO_SITE_TIMEZONE' });
  });
});

describe('LinkedInAdapter.listTags', () => {
  it('returns empty', async () => {
    const adapter = new LinkedInAdapter(SITE);
    await expect(adapter.listTags()).resolves.toEqual([]);
  });
});

describe('LinkedInAdapter.listAuthors', () => {
  it('lists the authenticated person, plus organisations best-effort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v2/userinfo')) {
          return new Response(JSON.stringify({ sub: 'abc123', name: 'Jane Doe' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('organizationAcls')) {
          return new Response(
            JSON.stringify({
              elements: [{ organization: 'urn:li:organization:999', 'organization~': { localizedName: 'Acme Co' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    const authors = await new LinkedInAdapter(SITE).listAuthors();
    expect(authors).toEqual([
      { id: 'urn:li:person:abc123', name: 'Jane Doe' },
      { id: 'urn:li:organization:999', name: 'Acme Co' },
    ]);
  });

  it('degrades to the person alone when the organisation lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v2/userinfo')) {
          return new Response(JSON.stringify({ sub: 'abc123', name: 'Jane Doe' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ message: 'no access' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const authors = await new LinkedInAdapter(SITE).listAuthors();
    expect(authors).toEqual([{ id: 'urn:li:person:abc123', name: 'Jane Doe' }]);
  });
});

describe('LinkedInAdapter.listAuthorsDetailed', () => {
  // Finding: a failed organisation lookup must not be swallowed silently —
  // it becomes exactly one warning naming the endpoint and the HTTP status,
  // alongside the person author that always resolves.
  it('yields the person author plus one warning naming the endpoint and status on a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v2/userinfo')) {
          return new Response(JSON.stringify({ sub: 'abc123', name: 'Jane Doe' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ message: 'no access' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const result = await new LinkedInAdapter(SITE).listAuthorsDetailed!();
    expect(result.authors).toEqual([{ id: 'urn:li:person:abc123', name: 'Jane Doe' }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('GET /rest/organizationAcls');
    expect(result.warnings[0]).toContain('403');
  });

  it('carries no warnings when the organisation lookup succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v2/userinfo')) {
          return new Response(JSON.stringify({ sub: 'abc123', name: 'Jane Doe' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const result = await new LinkedInAdapter(SITE).listAuthorsDetailed!();
    expect(result.warnings).toEqual([]);
  });
});

describe('LinkedInAdapter.healthCheck network-level failure', () => {
  // A `fetch` that throws (not one that resolves with a non-2xx status) is
  // the shape Node's `fetch` actually throws for DNS/TLS/connection-refused
  // failures — `TypeError('fetch failed')`. `healthCheck` must catch it and
  // resolve `{ ok: false }`, the same contract as any other reachability
  // failure, never let it become an unhandled rejection that takes down the
  // caller (`health_check`, `doctor`, the `init` credential walk).
  it('resolves ok:false with the error message in detail, rather than rejecting, on a fetch TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const adapter = new LinkedInAdapter(SITE);
    await expect(adapter.healthCheck()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('fetch failed'),
    });
  });
});
