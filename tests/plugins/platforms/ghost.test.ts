import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '../../../src/config/sites.js';
import { ToolError } from '../../../src/errors.js';
import { GhostAdapter, mimeFor } from '../../../src/plugins/platforms/ghost/index.js';
import { FAKE_ADMIN_KEY } from '../../fixtures/keys.js';

const SITE: SiteConfig = {
  slug: 'personal',
  platform: 'ghost',
  url: 'https://blog.example.com',
  apiUrl: 'https://blog.example.com/ghost/api/admin',
  credentials: { admin_api_key: FAKE_ADMIN_KEY },
};

function stub(status: number, body: unknown, capture?: (u: string, i: RequestInit) => void) {
  return vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    capture?.(String(url), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

// Regression (LEAK 4): SiteConfig.adminApiKey used to be a separate,
// Ghost-shaped field duplicating `credentials.admin_api_key` — always ''
// for WordPress and unused there. It has been removed; `credentials` is now
// the only source. This proves the adapter actually authenticates from
// `credentials.admin_api_key`, not from some other field, by checking the
// signed JWT it sends is built from the fixture's `credentials` value.
describe('GhostAdapter reads its key from credentials.admin_api_key', () => {
  it('builds the Authorization header from site.credentials.admin_api_key', async () => {
    let authHeader: string | undefined;
    vi.stubGlobal(
      'fetch',
      stub(200, { site: { title: 'x', version: '6.44' } }, (_u, init) => {
        authHeader = (init.headers as Record<string, string>).Authorization;
      }),
    );
    await new GhostAdapter(SITE).healthCheck();
    expect(authHeader).toMatch(/^Ghost /);
    // The JWT's header segment encodes `kid`, which ghostToken derives from
    // the id half of credentials.admin_api_key (FAKE_ADMIN_KEY) — decoding
    // it proves THIS credential, not an empty or different one, was signed.
    const jwt = authHeader!.slice('Ghost '.length);
    const [headerB64] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString());
    expect(header.kid).toBe(FAKE_ADMIN_KEY.split(':')[0]);
  });
});

describe('GhostAdapter.healthCheck', () => {
  it('reports ok with the Ghost version on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/config/')) {
          return new Response(JSON.stringify({ config: { version: '6.44.1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ site: { title: "Example Blog", version: '6.44' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const r = await new GhostAdapter(SITE).healthCheck();
    expect(r).toEqual({
      slug: 'personal',
      platform: 'ghost',
      ok: true,
      status: 200,
      detail: "Example Blog (Ghost 6.44.1)",
    });
  });

  // Regression: `/site/` requires no auth at all — verified live against
  // the probed Ghost install on 2026-07-29, a fabricated key got a 200 back
  // with the real site title. healthCheck must probe an endpoint that
  // actually requires the signed JWT (`/config/`), not `/site/`, or an
  // invalid key is reported as healthy. See docs/GHOST-NOTES.md.
  it('probes an endpoint that requires authentication, not the public /site/ endpoint', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      stub(401, { errors: [{ message: 'Unknown Admin API Key' }] }, (u) => {
        requestedUrl = u;
      }),
    );
    const r = await new GhostAdapter(SITE).healthCheck();
    expect(requestedUrl).not.toMatch(/\/site\/(\?|$)/);
    expect(r.ok).toBe(false);
  });

  it('reports failure without throwing on 401', async () => {
    vi.stubGlobal('fetch', stub(401, { errors: [{ message: 'Unknown Admin API Key' }] }));
    const r = await new GhostAdapter(SITE).healthCheck();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toContain('Unknown Admin API Key');
  });

  it('reports failure without throwing on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    );
    const r = await new GhostAdapter(SITE).healthCheck();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ENOTFOUND');
  });
});

describe('GhostAdapter request shape', () => {
  it('sends the Ghost auth scheme and Accept-Version v6.0', async () => {
    let seen: RequestInit = {};
    vi.stubGlobal(
      'fetch',
      stub(200, { site: { title: 'T', version: '6.44' } }, (_u, i) => {
        seen = i;
      }),
    );
    await new GhostAdapter(SITE).healthCheck();
    const headers = seen.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Ghost ey/);
    expect(headers['Accept-Version']).toBe('v6.0');
  });
});

describe('GhostAdapter.createPost', () => {
  it('posts to ?source=html and unwraps the response', async () => {
    let url = '';
    let body: any;
    vi.stubGlobal(
      'fetch',
      stub(
        201,
        {
          // Real Ghost echoes every field it accepted; the mock must too, or the
          // write-back check correctly flags the mock's own omissions.
          posts: [
            {
              id: 'p1',
              url: 'https://blog.example.com/x/',
              status: 'published',
              title: 'T',
            },
          ],
        },
        (u, i) => {
          url = u;
          body = JSON.parse(String(i.body));
        },
      ),
    );

    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>Hi</p>',
      status: 'published',
      tags: ['AI'],
      authors: ['abc'],
    });

    expect(url).toBe('https://blog.example.com/ghost/api/admin/posts/?source=html');
    expect(body.posts[0].html).toBe('<p>Hi</p>');
    expect(body.posts[0].tags).toEqual([{ name: 'AI' }]);
    expect(body.posts[0].authors).toEqual([{ id: 'abc' }]);
    expect(r).toEqual({ id: 'p1', url: 'https://blog.example.com/x/', status: 'published' });
  });

  // Regression: passing `excerpt` (read-only) instead of `custom_excerpt` returned
  // 201 with the value silently discarded, and the tool reported success.
  it('warns when Ghost silently discards a field the caller set', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, {
        posts: [
          {
            id: 'p1',
            url: 'u',
            status: 'draft',
            title: 'T',
            custom_excerpt: null,
            og_title: null,
          },
        ],
      }),
    );
    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      custom_excerpt: 'this will be dropped',
      og_title: 'so will this',
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings?.[0]).toContain('custom_excerpt');
    expect(r.warnings?.[0]).toContain('og_title');
  });

  it('reports no warnings when every field round-trips', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, {
        posts: [
          {
            id: 'p1',
            url: 'u',
            status: 'draft',
            title: 'T',
            custom_excerpt: 'kept',
            og_title: 'kept',
          },
        ],
      }),
    );
    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'draft',
      custom_excerpt: 'kept',
      og_title: 'kept',
    });
    expect(r.warnings).toBeUndefined();
  });

  it('uses the configured api_url endpoint rather than deriving one', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      stub(200, { site: { title: 'T', version: '6.44' } }, (u) => {
        url = u;
      }),
    );
    await new GhostAdapter({ ...SITE, apiUrl: 'https://cms.elsewhere.com/ghost/api/admin' })
      .healthCheck();
    expect(url).toBe('https://cms.elsewhere.com/ghost/api/admin/site/');
  });

  it('omits undefined optional fields from the payload', async () => {
    let body: any;
    vi.stubGlobal(
      'fetch',
      stub(201, { posts: [{ id: 'p1', url: 'u', status: 'draft' }] }, (_u, i) => {
        body = JSON.parse(String(i.body));
      }),
    );
    await new GhostAdapter(SITE).createPost({ title: 'T', html: '<p>x</p>', status: 'draft' });
    expect('feature_image' in body.posts[0]).toBe(false);
    expect('tags' in body.posts[0]).toBe(false);
  });

  it("throws a ToolError carrying Ghost's own message", async () => {
    vi.stubGlobal('fetch', stub(422, { errors: [{ message: 'Title cannot be blank' }] }));
    await expect(
      new GhostAdapter(SITE).createPost({ title: '', html: '<p>x</p>', status: 'draft' }),
    ).rejects.toThrowError(/Title cannot be blank/);
  });

  it('rejects HTML that still contains the image placeholder', async () => {
    vi.stubGlobal('fetch', stub(201, { posts: [{ id: 'p', url: 'u', status: 'draft' }] }));
    try {
      await new GhostAdapter(SITE).createPost({
        title: 'T',
        html: '<p>a</p>[[content_image]]<p>b</p>',
        status: 'draft',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ToolError).code).toBe('UNRESOLVED_PLACEHOLDER');
    }
  });
});

describe('GhostAdapter.uploadImage', () => {
  it('sends multipart with purpose=image and returns the hosted url', async () => {
    let init: RequestInit = {};
    vi.stubGlobal(
      'fetch',
      stub(201, { images: [{ url: 'https://blog.example.com/content/images/a.png' }] }, (_u, i) => {
        init = i;
      }),
    );
    const r = await new GhostAdapter(SITE).uploadImage(Buffer.from('png'), 'hero.png');
    expect(r.url).toBe('https://blog.example.com/content/images/a.png');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('purpose')).toBe('image');
    // Content-Type must be left unset so fetch adds the multipart boundary
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  // Regression: a Blob with no type uploads as application/octet-stream and Ghost
  // rejects it with 415 "Please select a valid image." Caught only against the live API.
  it('gives the uploaded blob a real image MIME type', async () => {
    let init: RequestInit = {};
    vi.stubGlobal(
      'fetch',
      stub(201, { images: [{ url: 'https://blog.example.com/content/images/a.png' }] }, (_u, i) => {
        init = i;
      }),
    );
    await new GhostAdapter(SITE).uploadImage(Buffer.from('png'), 'hero.png');
    const filePart = (init.body as FormData).get('file') as File;
    expect(filePart.type).toBe('image/png');
    expect(filePart.type).not.toBe('');
  });
});

describe('mimeFor', () => {
  it('maps the image extensions Ghost accepts', () => {
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.JPG')).toBe('image/jpeg');
    expect(mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeFor('a.webp')).toBe('image/webp');
    expect(mimeFor('a.gif')).toBe('image/gif');
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
  });

  it('falls back to octet-stream on an unknown extension', () => {
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
    expect(mimeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('GhostAdapter.listAuthors', () => {
  it('uses /users/ — not /users/me/, which 404s for integrations', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      stub(200, { users: [{ id: 'u1', name: 'Jane Doe' }] }, (u) => {
        url = u;
      }),
    );
    const r = await new GhostAdapter(SITE).listAuthors();
    expect(url).toContain('/users/?limit=all');
    expect(url).not.toContain('users/me');
    expect(r[0]).toEqual({ id: 'u1', name: 'Jane Doe' });
  });
});

describe('GhostAdapter.updatePost', () => {
  it('fetches updated_at then PUTs it back for collision detection', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL, i: RequestInit = {}) => {
        calls.push(`${i.method ?? 'GET'} ${String(u)}`);
        const body =
          String(u).includes('?source=html') && i.method === 'PUT'
            ? { posts: [{ id: 'p1', url: 'u', status: 'published' }] }
            : { posts: [{ id: 'p1', updated_at: '2026-07-28T10:00:00.000Z' }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    await new GhostAdapter(SITE).updatePost('p1', { title: 'New' });
    expect(calls[0]).toContain('GET');
    expect(calls[1]).toContain('PUT');
    expect(calls[1]).toContain('?source=html');
  });
});

describe('GhostAdapter scheduling', () => {
  const SCHEDULED = '2026-08-04T09:00:00.000Z';

  it('sends publish_at under Ghost’s own name, published_at', async () => {
    let sent: any;
    vi.stubGlobal(
      'fetch',
      stub(201, { posts: [{ id: 'p1', url: 'u', status: 'scheduled', published_at: SCHEDULED }] }, (_u, i) => {
        sent = JSON.parse(String(i.body)).posts[0];
      }),
    );

    await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });

    expect(sent.published_at).toBe(SCHEDULED);
    // The rename has to be real. Under the old field name this value reached
    // Ghost through a loop that copies every unrecognised key verbatim, so a
    // `publish_at` leaking through would look like it worked while Ghost
    // ignored it.
    expect(sent.publish_at).toBeUndefined();
    expect(sent.status).toBe('scheduled');
  });

  it('reports the publish time Ghost stored, not the one that was requested', async () => {
    // `title` is echoed back because `droppedFields` checks every sent field;
    // omitting it here would produce a warning about `title` and mask whether
    // the scheduling path added one of its own.
    vi.stubGlobal(
      'fetch',
      stub(201, { posts: [{ id: 'p1', url: 'u', title: 'T', status: 'scheduled', published_at: SCHEDULED }] }),
    );
    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    expect(r.publish_at).toBe(SCHEDULED);
    expect(r.warnings).toBeUndefined();
  });

  // `droppedFields` looks up each sent key in the response by that key's name.
  // `publish_at` is stored under `published_at`, so an unguarded lookup finds
  // nothing and reports a field Ghost saved correctly as discarded.
  it('does not report publish_at as discarded when Ghost stored it', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, { posts: [{ id: 'p1', url: 'u', status: 'scheduled', published_at: SCHEDULED }] }),
    );
    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'scheduled',
      publish_at: SCHEDULED,
    });
    expect(JSON.stringify(r.warnings ?? [])).not.toContain('publish_at');
  });

  it('refuses to report success when Ghost published instead of scheduling', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, {
        posts: [{ id: 'p1', url: 'https://blog.example.com/t/', status: 'published', published_at: SCHEDULED }],
      }),
    );
    await expect(
      new GhostAdapter(SITE).createPost({
        title: 'T',
        html: '<p>x</p>',
        status: 'scheduled',
        publish_at: SCHEDULED,
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_NOT_APPLIED' });
  });

  it('warns when Ghost stored a different instant than was sent', async () => {
    vi.stubGlobal(
      'fetch',
      stub(201, {
        posts: [{ id: 'p1', url: 'u', status: 'published', published_at: '2026-08-04T11:00:00.000Z' }],
      }),
    );
    // status "published" with a past date is backdating, so no schedule
    // assertion runs — but the time still has to be verified.
    const r = await new GhostAdapter(SITE).createPost({
      title: 'T',
      html: '<p>x</p>',
      status: 'published',
      publish_at: '2026-08-04T09:00:00.000Z',
    });
    expect(r.warnings?.join(' ')).toContain('2026-08-04T11:00:00.000Z');
  });

  // Ghost puts the useful half of a 422 in `context`; `message` is the generic
  // "Validation error, cannot save post." Losing `context` leaves a caller
  // with a validation failure that names no field.
  it('surfaces Ghost’s validation context, where the real reason lives', async () => {
    vi.stubGlobal(
      'fetch',
      stub(422, {
        errors: [
          {
            message: 'Validation error, cannot save post.',
            context: 'Date must be at least -2 minutes in the future.',
          },
        ],
      }),
    );
    await expect(
      new GhostAdapter(SITE).createPost({
        title: 'T',
        html: '<p>x</p>',
        status: 'scheduled',
        publish_at: SCHEDULED,
      }),
    ).rejects.toMatchObject({ hint: 'Date must be at least -2 minutes in the future.' });
  });

  it('schedules an existing draft through updatePost', async () => {
    let put: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL, i: RequestInit = {}) => {
        if (i.method === 'PUT') {
          put = JSON.parse(String(i.body)).posts[0];
          return new Response(
            JSON.stringify({ posts: [{ id: 'p1', url: 'u', status: 'scheduled', published_at: SCHEDULED }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ posts: [{ id: 'p1', updated_at: '2026-08-01T10:00:00.000Z' }] }), {
          status: 200,
        });
      }),
    );

    const r = await new GhostAdapter(SITE).updatePost('p1', { status: 'scheduled', publish_at: SCHEDULED });
    expect(put.published_at).toBe(SCHEDULED);
    expect(put.status).toBe('scheduled');
    expect(r.publish_at).toBe(SCHEDULED);
  });
});

describe('GhostAdapter.siteTimezone', () => {
  // Measured 2026-08-03: /settings/ is a flat array of {key,value} pairs and
  // `timezone` holds an IANA name — never a numeric offset.
  it('reads the timezone key out of the settings array', async () => {
    vi.stubGlobal(
      'fetch',
      stub(200, {
        settings: [
          { key: 'title', value: 'Blog' },
          { key: 'timezone', value: 'Asia/Kolkata' },
          { key: 'locale', value: 'en' },
        ],
      }),
    );
    expect(await new GhostAdapter(SITE).siteTimezone()).toEqual({ kind: 'iana', zone: 'Asia/Kolkata' });
  });

  // Assuming UTC for a Kolkata blog publishes five and a half hours early and
  // reports success. A refusal is the only honest answer.
  it.each([
    ['the key is absent', { settings: [{ key: 'title', value: 'Blog' }] }],
    ['the value is empty', { settings: [{ key: 'timezone', value: '' }] }],
    ['the value is not a string', { settings: [{ key: 'timezone', value: 5.5 }] }],
    ['there are no settings at all', {}],
  ])('throws rather than defaulting to UTC when %s', async (_label, body) => {
    vi.stubGlobal('fetch', stub(200, body));
    await expect(new GhostAdapter(SITE).siteTimezone()).rejects.toMatchObject({
      code: 'NO_SITE_TIMEZONE',
    });
  });
});

describe('GhostAdapter keeps the social card pointing at the hero', () => {
  /** GET returns `before`; PUT captures what was actually sent. */
  function stubUpdate(before: Record<string, unknown>) {
    const sent: { body?: any } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL, i: RequestInit = {}) => {
        if (i.method === 'PUT') {
          sent.body = JSON.parse(String(i.body)).posts[0];
          return new Response(
            JSON.stringify({
              posts: [{ id: 'p1', url: 'u', title: 'T', status: 'published', ...sent.body }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ posts: [{ id: 'p1', updated_at: '2026-08-01T10:00:00.000Z', ...before }] }),
          { status: 200 },
        );
      }),
    );
    return sent;
  }

  const OLD = 'https://x/old-hero.png';
  const NEW = 'https://x/new-hero.png';

  // The measured defect: create_post defaults og_image to feature_image, so
  // changing the hero later left four live posts showing distinct in-article
  // images and one shared social card.
  it('moves og_image and twitter_image with the hero when they were defaulted', async () => {
    const sent = stubUpdate({ feature_image: OLD, og_image: OLD, twitter_image: OLD });
    await new GhostAdapter(SITE).updatePost('p1', { feature_image: NEW });
    expect(sent.body.og_image).toBe(NEW);
    expect(sent.body.twitter_image).toBe(NEW);
  });

  // Silently overwriting a deliberate choice would be a worse bug than the one
  // being fixed.
  it('leaves a deliberately different social image alone, and says so', async () => {
    const custom = 'https://x/custom-card.png';
    const sent = stubUpdate({ feature_image: OLD, og_image: custom, twitter_image: custom });
    const r = await new GhostAdapter(SITE).updatePost('p1', { feature_image: NEW });
    expect(sent.body.og_image).toBeUndefined();
    expect(r.warnings?.join(' ')).toContain('deliberate choice');
    expect(r.warnings?.join(' ')).toContain(custom);
  });

  it('never overrides an og_image the caller passed explicitly', async () => {
    const explicit = 'https://x/explicit.png';
    const sent = stubUpdate({ feature_image: OLD, og_image: OLD, twitter_image: OLD });
    await new GhostAdapter(SITE).updatePost('p1', { feature_image: NEW, og_image: explicit });
    expect(sent.body.og_image).toBe(explicit);
    expect(sent.body.twitter_image).toBe(NEW);
  });

  it('does nothing when the hero is not being changed', async () => {
    const sent = stubUpdate({ feature_image: OLD, og_image: OLD, twitter_image: OLD });
    const r = await new GhostAdapter(SITE).updatePost('p1', { title: 'New title' });
    expect(sent.body.og_image).toBeUndefined();
    expect(r.warnings ?? []).toEqual([]);
  });

  it('does nothing when the post had no social images to begin with', async () => {
    const sent = stubUpdate({ feature_image: OLD });
    const r = await new GhostAdapter(SITE).updatePost('p1', { feature_image: NEW });
    expect(sent.body.og_image).toBeUndefined();
    expect(r.warnings ?? []).toEqual([]);
  });
});
