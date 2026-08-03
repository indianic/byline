import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';
import { WordPressAdapter } from '../../src/plugins/platforms/wordpress/index.js';
import { basicAuthHeader } from '../../src/plugins/platforms/wordpress/auth.js';
import type { SiteConfig } from '../../src/config/sites.js';

// Resolve config exactly the way the server does — `resolvePaths` +
// `loadSites`/`loadContext` — rather than calling `loadSites()` with no
// argument. That default is a relative `config/sites.yaml`, which bypassed
// path resolution entirely and broke the moment config moved to
// `~/.byline/config.yaml`. See tests/integration/ghost.integration.test.ts,
// which was fixed for exactly this.
const ctx = loadContext();
const site = ctx.sites.sites.wptest;
const skipReason = !site
  ? 'no site named "wptest" in the resolved config'
  : site.unavailable
    ? site.unavailable
    : undefined;

// `describe.skipIf` still EXECUTES the suite callback to collect tests — it
// only marks the collected tests as skipped afterward. Building the adapter
// (or anything else that depends on `site`) inside that callback would crash
// collection for every contributor whose config simply has no site named
// "wptest" (the common case for anyone other than the maintainer), since
// `site` is `undefined` there. Guard at module scope instead, and only enter
// `describe` — where `site` is guaranteed defined — when there is nothing to
// skip.
if (skipReason) {
  describe.skip(`WordPress integration (wptest only) — SKIPPED: ${skipReason}`, () => {
    it('skipped', () => {});
  });
} else {
  const usableSite: SiteConfig = site!;

  describe('WordPress integration (wptest only)', () => {
    const adapter = new WordPressAdapter(usableSite);

    function authHeaders(): Record<string, string> {
      return {
        Authorization: basicAuthHeader(
          usableSite.credentials.username ?? '',
          usableSite.credentials.app_password ?? '',
        ),
      };
    }

    /** Read a post back with `?context=edit`, the shape whose `.raw` fields are unrendered. */
    async function readPostRaw(id: string): Promise<{ title?: { raw?: string }; content?: { raw?: string }; excerpt?: { raw?: string } }> {
      const res = await fetch(`${usableSite.apiUrl}/wp/v2/posts/${id}?context=edit`, { headers: authHeaders() });
      return (await res.json()) as { title?: { raw?: string }; content?: { raw?: string }; excerpt?: { raw?: string } };
    }

    it('never targets a site other than wptest', () => {
      expect(usableSite.slug).toBe('wptest');
    });

    it('health check succeeds and reports the authenticated user', async () => {
      const r = await adapter.healthCheck();
      expect(r.ok, r.detail).toBe(true);
    });

    // The mirror of Ghost's fabricated-key regression, and the reason it
    // exists here at all: Ghost's healthCheck probed `GET /site/` for four
    // phases on the belief that it required auth. It did not, so a
    // fabricated-but-well-formed key came back ok:true with the real site
    // title — `init` accepted wrong keys, and `doctor` stayed green until the
    // user's first create_post.
    //
    // WordPress's healthCheck gates on `users/me?context=edit`, which SHOULD
    // require Basic auth. "It looks authenticated" is precisely what was
    // believed about `/site/`, so this asserts it against the live server
    // rather than against that belief. No mock can establish this: the fact
    // under test is a property of the remote WordPress install.
    it('health check reports a fabricated-but-well-formed application password as unhealthy', async () => {
      const badSite: SiteConfig = {
        ...usableSite,
        credentials: {
          ...usableSite.credentials,
          // Shaped exactly like a real one — 24 chars in six space-separated
          // groups of four — so nothing can reject it client-side for form.
          app_password: 'aaaa bbbb cccc dddd eeee ffff',
        },
      };

      const r = await new WordPressAdapter(badSite).healthCheck();

      expect(r.ok, `a fabricated app password was reported healthy: ${r.detail}`).toBe(false);
      expect(r.status).toBe(401);
    });

    it('reports unfiltered_html on this account, per the 2026-07-29 probe', async () => {
      const capabilities = await adapter.getCapabilities();
      expect(capabilities.unfiltered_html).toBe(true);
    });

    it('lists tags and authors', async () => {
      expect((await adapter.listTags()).length).toBeGreaterThanOrEqual(0);
      expect((await adapter.listAuthors()).length).toBeGreaterThan(0);
    });

    it(
      'creates a draft, round-trips styled HTML byte-identical, updates it, then deletes it',
      async () => {
        // Every construct here is one this probe confirms survives ingest
        // byte-identical for this account: inline style= on <div>, <table>,
        // and <blockquote> (blockquote passthrough with its inner <p>
        // intact); <div>/<section>/<aside>/<span>/<small>/<mark>/<pre> kept as
        // elements, not unwrapped; a hand-written heading id; class=;
        // target="_blank" with rel="noopener noreferrer".
        //
        // Extended (I2 fix) to cover EVERY tag `PERMISSIVE_PRESERVED` in
        // html-profile.ts claims as measured — `section`, `aside`, `span`,
        // `small`, `mark`, `pre`, `thead`, `th`, `figure`, `figcaption`,
        // `code`, `ul`, `ol`, `li`, `hr`, `strong`, `em` were previously
        // claimed measured by this probe's doc comments without this test (or
        // the original human-run probe) actually exercising them. Before this
        // fix, only `p h2 div table tbody tr td blockquote a` were covered
        // here.
        const html =
          '<p>Integration probe paragraph.</p>' +
          '<h2 id="probe-heading">Probe section</h2>' +
          '<div class="probe-card" style="padding:8px;background:#f5f5f5;"><p>Card body.</p></div>' +
          '<table style="width:100%;"><thead><tr><th>Header</th></tr></thead><tbody><tr><td style="padding:4px;">Cell</td></tr></tbody></table>' +
          '<blockquote style="border-left:2px solid #999;padding-left:8px;"><p>A quoted line.</p></blockquote>' +
          '<p>With <a href="https://wordpress.org" target="_blank" rel="noopener noreferrer">a link</a>.</p>' +
          '<h3>Probe subsection</h3>' +
          '<h4>Probe sub-subsection</h4>' +
          '<p>Some <strong>bold</strong> and <em>italic</em> and <span>span</span> and <small>small print</small> and <mark>marked</mark> text.</p>' +
          '<section><p>Section body.</p></section>' +
          '<aside><p>Aside body.</p></aside>' +
          '<pre>preformatted   text</pre>' +
          '<ul><li>First item</li><li>Second item</li></ul>' +
          '<ol><li>First step</li><li>Second step</li></ol>' +
          '<hr>' +
          '<p><code>inline_code()</code></p>' +
          '<figure><img src="https://wordpress.org/favicon.ico" alt="probe"><figcaption>Probe caption.</figcaption></figure>';

        // The creating call and every assertion that can fail live INSIDE the
        // try so a failed assertion still reaches the `finally` and deletes the
        // draft. Before this fix, `created` and its assertions ran ahead of the
        // try/finally — the exact case this test exists to catch (a write-back
        // mismatch) threw before cleanup ever ran, leaving a stray draft on the
        // live site.
        let created: Awaited<ReturnType<typeof adapter.createPost>> | undefined;
        try {
          created = await adapter.createPost({
            title: 'ZZ integration probe — safe to delete',
            html,
            status: 'draft',
            // Confirmed writable and round-tripped on 2026-07-29 — unlike Ghost,
            // where `excerpt` is read-only and `custom_excerpt` is the writable
            // field.
            custom_excerpt: 'ZZ integration probe excerpt — safe to delete.',
          });
          expect(created.id).toBeTruthy();
          expect(created.status).toBe('draft');
          // No warning means the write-back comparison found content.raw
          // byte-identical to what was sent — the central claim under test.
          expect(created.warnings, created.warnings?.join('; ')).toBeUndefined();

          const readBack = await readPostRaw(created.id);
          expect(readBack.content?.raw).toBe(html);
          expect(readBack.excerpt?.raw).toContain('ZZ integration probe excerpt');

          // UNVERIFIED before this run: WordPress core registers PUT for the
          // single-post route. Confirmed here by an actual update.
          const updated = await adapter.updatePost(created.id, {
            title: 'ZZ integration probe — UPDATED — safe to delete',
          });
          expect(updated.id).toBe(created.id);
          const readBackAfterUpdate = await readPostRaw(created.id);
          expect(readBackAfterUpdate.title?.raw).toBe('ZZ integration probe — UPDATED — safe to delete');
        } finally {
          if (created?.id) {
            const del = await fetch(`${usableSite.apiUrl}/wp/v2/posts/${created.id}?force=true`, {
              method: 'DELETE',
              headers: authHeaders(),
            });
            expect(del.ok, `delete failed: ${del.status}`).toBe(true);
          }
        }
      },
      20000,
    );

    it(
      'uploads a media asset then deletes it',
      async () => {
        // A 1x1 transparent PNG, so the upload is a real image WordPress accepts,
        // not an arbitrary byte string.
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        );
        // Same fix as the post test above: the upload and its assertions run
        // inside the try so a failed assertion still deletes the uploaded
        // media instead of leaving it stranded on the live site.
        let uploaded: { url: string; id?: string } | undefined;
        try {
          uploaded = await adapter.uploadImage(png, 'zz-probe.png', 'ZZ integration probe image');
          expect(uploaded.url).toContain('http');
          expect(uploaded.id).toBeTruthy();
        } finally {
          if (uploaded?.id) {
            const del = await fetch(`${usableSite.apiUrl}/wp/v2/media/${uploaded.id}?force=true`, {
              method: 'DELETE',
              headers: authHeaders(),
            });
            expect(del.ok, `media delete failed: ${del.status}`).toBe(true);
          }
        }
      },
      20000,
    );

    /** Removes a probe post whatever the assertions did. */
    const remove = async (id: string): Promise<void> => {
      await fetch(`${usableSite.apiUrl}/wp/v2/posts/${id}?force=true`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    };

    describe('scheduling', () => {
      /** Whole-second UTC ISO, the form `toWholeSecondIso` produces. */
      const isoAt = (offsetMs: number): string => {
        const d = new Date(Date.now() + offsetMs);
        d.setMilliseconds(0);
        return d.toISOString();
      };

      // A `future` post is not publicly visible before its date, so this is
      // safe against the live site.
      it(
        'schedules a post and reports back the time WordPress actually stored',
        async () => {
          const iso = isoAt(60 * 60_000);
          let id: string | undefined;
          try {
            const r = await adapter.createPost({
              title: 'ZZ scheduling probe — safe to delete',
              html: '<p>Scheduling probe.</p>',
              status: 'scheduled',
              publish_at: iso,
            });
            id = r.id;
            // WordPress's own token, not Byline's — proof the status map
            // reached the platform. Before `STATUS` existed, an unhandled
            // status fell through to `draft` with no error at all.
            expect(r.status).toBe('future');
            expect(r.publish_at).toBe(iso);
            expect(r.warnings ?? []).toEqual([]);
          } finally {
            if (id) await remove(id);
          }
        },
        20000,
      );

      // THE behaviour the whole feature is defended against, exercised live:
      // WordPress answers 201 and silently publishes when the date is too
      // close. The adapter must refuse to call that a scheduled post. This
      // calls the adapter directly, bypassing `resolveTiming`'s floor, because
      // the point is what WORDPRESS does — the guard is unit-tested separately.
      it(
        'catches WordPress silently publishing a too-soon post instead of scheduling it',
        async () => {
          let id: string | undefined;
          try {
            const r = await adapter.createPost({
              title: 'ZZ scheduling probe — safe to delete',
              html: '<p>x</p>',
              status: 'scheduled',
              // Measured 2026-08-03: 45s of lead publishes immediately.
              publish_at: isoAt(20_000),
            });
            id = r.id;
            expect.unreachable('WordPress published this; the adapter should have refused to report success');
          } catch (e) {
            const err = e as { code?: string; message?: string; hint?: string };
            expect(err.code).toBe('SCHEDULE_NOT_APPLIED');
            // The error has to be actionable: the post EXISTS and is live.
            expect(err.message).toMatch(/returned status "publish"/);
            expect(err.hint).toContain('LIVE NOW');
            // Recover the id from the message so the live post still gets
            // cleaned up — the throw is the correct behaviour, but it means
            // the id never came back through a return value.
            id = /id (\d+)/.exec(err.message ?? '')?.[1];
            expect(id, 'error message must name the post id, or it is not actionable').toBeTruthy();
          } finally {
            if (id) await remove(id);
          }
        },
        20000,
      );

      it(
        'schedules an existing draft through updatePost, then unschedules it',
        async () => {
          const iso = isoAt(60 * 60_000);
          let id: string | undefined;
          try {
            const draft = await adapter.createPost({
              title: 'ZZ scheduling probe — safe to delete',
              html: '<p>x</p>',
              status: 'draft',
            });
            id = draft.id;
            const scheduled = await adapter.updatePost(draft.id, { status: 'scheduled', publish_at: iso });
            expect(scheduled.status).toBe('future');
            expect(scheduled.publish_at).toBe(iso);

            const back = await adapter.updatePost(draft.id, { status: 'draft' });
            expect(back.status).toBe('draft');
          } finally {
            if (id) await remove(id);
          }
        },
        20000,
      );

      // Backdating publishes for real; created, checked, deleted.
      it(
        'backdates a published post to a past date',
        async () => {
          const iso = isoAt(-30 * 86_400_000);
          let id: string | undefined;
          try {
            const r = await adapter.createPost({
              title: 'ZZ backdate probe — safe to delete',
              html: '<p>x</p>',
              status: 'published',
              publish_at: iso,
            });
            id = r.id;
            expect(r.status).toBe('publish');
            expect(r.publish_at).toBe(iso);
            expect(r.warnings ?? []).toEqual([]);
          } finally {
            if (id) await remove(id);
          }
        },
        20000,
      );
    });
  });
}
