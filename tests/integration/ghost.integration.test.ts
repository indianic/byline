import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';
import { ghostToken } from '../../src/plugins/platforms/ghost/auth.js';
import { GhostAdapter } from '../../src/plugins/platforms/ghost/index.js';
import type { SiteConfig } from '../../src/config/sites.js';
import { FAKE_ADMIN_KEY } from '../fixtures/keys.js';

// Resolve config exactly the way the server does — `resolvePaths` +
// `loadSites`/`loadContext` — rather than calling `loadSites()` with no
// argument. That default is a relative `config/sites.yaml`, which bypassed
// path resolution entirely and broke the moment config moved to
// `~/.byline/config.yaml`.
const ctx = loadContext();
const site = ctx.sites.sites.personal;
const skipReason = !site
  ? 'no site named "personal" in the resolved config'
  : site.unavailable
    ? site.unavailable
    : undefined;

// `describe.skipIf` still EXECUTES the suite callback to collect tests — it
// only marks the collected tests as skipped afterward. Building the adapter
// (or anything else that depends on `site`) inside that callback would crash
// collection for every contributor whose config simply has no site named
// "personal" (the common case for anyone other than the maintainer), since
// `site` is `undefined` there. Guard at module scope instead, and only enter
// `describe` — where `site` is guaranteed defined — when there is nothing to
// skip.
if (skipReason) {
  describe.skip(`Ghost integration (personal blog only) — SKIPPED: ${skipReason}`, () => {
    it('skipped', () => {});
  });
} else {
  const usableSite: SiteConfig = site!;

  describe('Ghost integration (personal blog only)', () => {
    const adapter = new GhostAdapter(usableSite);

    it('never targets a production site', () => {
      expect(usableSite.slug).toBe('personal');
    });

    it('health check succeeds', async () => {
      const r = await adapter.healthCheck();
      expect(r.ok, r.detail).toBe(true);
      expect(r.detail).toMatch(/Ghost \d/);
    });

    // Regression (Critical, fixed 2026-07-29): `GET /site/` requires no auth
    // at all — a fabricated-but-well-formed key got a real 200 back from
    // this exact live site, with the real site title, before this fix. This
    // reproduces that exact probe against the live blog and asserts the
    // adapter now reports it as unhealthy.
    it('health check reports a fabricated-but-well-formed key as unhealthy', async () => {
      const badSite: SiteConfig = { ...usableSite, credentials: { admin_api_key: FAKE_ADMIN_KEY } };
      const r = await new GhostAdapter(badSite).healthCheck();
      expect(r.ok).toBe(false);
      expect(r.status).toBe(401);
    });

    it('lists authors via /users/ and not /users/me/', async () => {
      expect((await adapter.listAuthors()).length).toBeGreaterThan(0);
    });

    it('creates a draft, round-trips the HTML, then deletes it', async () => {
      const html =
        '<p>Integration probe paragraph.</p><h2>Probe section</h2><p>With <a href="https://ghost.org" rel="noopener noreferrer">a link</a>.</p>';
      // The creating call and its assertions live inside the try so a failed
      // assertion still reaches the `finally` and deletes the draft, rather
      // than leaving a stray post on the live site (same fix as
      // wordpress.integration.test.ts).
      let created: Awaited<ReturnType<typeof adapter.createPost>> | undefined;
      try {
        created = await adapter.createPost({
          title: 'ZZ integration probe — safe to delete',
          html,
          status: 'draft',
        });
        expect(created.id).toBeTruthy();
        expect(created.status).toBe('draft');

        // `site.apiUrl` — not a hand-built `${url}/ghost/api/admin` — because
        // the admin API can live at a different host/path than the public
        // site (the `api_url` override in config exists for exactly that;
        // two of three real sites 404'd on the derived endpoint).
        const res = await fetch(`${usableSite.apiUrl}/posts/${created.id}/?formats=html`, {
          headers: {
            Authorization: `Ghost ${ghostToken(usableSite.credentials.admin_api_key ?? '', usableSite.slug)}`,
            'Accept-Version': 'v6.0',
          },
        });
        const body = (await res.json()) as { posts?: Array<{ html?: string }> };
        expect(body.posts?.[0]?.html).toContain('Integration probe paragraph');
        // Ghost strips target="_blank" but keeps rel
        expect(body.posts?.[0]?.html).not.toContain('target=');
        expect(body.posts?.[0]?.html).toContain('noopener');
      } finally {
        if (created?.id) {
          const del = await fetch(`${usableSite.apiUrl}/posts/${created.id}/`, {
            method: 'DELETE',
            headers: {
              Authorization: `Ghost ${ghostToken(usableSite.credentials.admin_api_key ?? '', usableSite.slug)}`,
              'Accept-Version': 'v6.0',
            },
          });
          expect(del.status).toBe(204);
        }
      }
    });

    /** Removes a probe post whatever the assertions did. */
    const remove = async (id: string): Promise<void> => {
      await fetch(`${usableSite.apiUrl}/posts/${id}/`, {
        method: 'DELETE',
        headers: {
          Authorization: `Ghost ${ghostToken(usableSite.credentials.admin_api_key ?? '', usableSite.slug)}`,
          'Accept-Version': 'v6.0',
        },
      });
    };

    describe('scheduling', () => {
      // A scheduled post is not publicly visible before its time, so this is
      // safe to run against the live blog — unlike the backdating test below,
      // which genuinely publishes.
      it('schedules a post and reports back the time Ghost actually stored', async () => {
        const when = new Date(Date.now() + 60 * 60_000);
        when.setMilliseconds(0);
        const iso = when.toISOString();
        let created: Awaited<ReturnType<typeof adapter.createPost>> | undefined;
        try {
          created = await adapter.createPost({
            title: 'ZZ scheduling probe — safe to delete',
            html: '<p>Scheduling probe.</p>',
            status: 'scheduled',
            publish_at: iso,
          });
          // Ghost's own token, not Byline's — proof the mapping reached the
          // platform rather than merely satisfying a double.
          expect(created.status).toBe('scheduled');
          expect(created.publish_at).toBe(iso);
          expect(created.warnings ?? []).toEqual([]);
        } finally {
          if (created?.id) await remove(created.id);
        }
      });

      // The rule that would otherwise be known only from a mock. Ghost refuses
      // rather than silently publishing, and the reason is in `context`, which
      // the adapter surfaces as the hint.
      it('is refused by Ghost itself when the date is further back than its 2-minute floor', async () => {
        let id: string | undefined;
        try {
          const r = await adapter.createPost({
            title: 'ZZ scheduling probe — safe to delete',
            html: '<p>x</p>',
            status: 'scheduled',
            // Deliberately bypasses `resolveTiming` by calling the adapter
            // directly: this asserts what GHOST does, not what Byline's own
            // guard does. The guard is covered in schedule.test.ts.
            publish_at: new Date(Date.now() - 60 * 60_000).toISOString(),
          });
          id = r.id;
          expect.unreachable('Ghost should have rejected a past scheduled date');
        } catch (e) {
          expect((e as { status?: number }).status).toBe(422);
          expect(String((e as { hint?: string }).hint)).toMatch(/at least -2 minutes in the future/);
        } finally {
          if (id) await remove(id);
        }
      });

      it('schedules an existing draft through updatePost, then unschedules it', async () => {
        const when = new Date(Date.now() + 60 * 60_000);
        when.setMilliseconds(0);
        const iso = when.toISOString();
        let id: string | undefined;
        try {
          const draft = await adapter.createPost({
            title: 'ZZ scheduling probe — safe to delete',
            html: '<p>x</p>',
            status: 'draft',
          });
          id = draft.id;
          const scheduled = await adapter.updatePost(draft.id, { status: 'scheduled', publish_at: iso });
          expect(scheduled.status).toBe('scheduled');
          expect(scheduled.publish_at).toBe(iso);

          const back = await adapter.updatePost(draft.id, { status: 'draft' });
          expect(back.status).toBe('draft');
        } finally {
          if (id) await remove(id);
        }
      });

      // Backdating publishes for real, so the window is kept as short as
      // possible: created, read back, deleted. The title says so in case a
      // failure ever leaves one behind.
      it('backdates a published post to a past date', async () => {
        const when = new Date(Date.now() - 30 * 86_400_000);
        when.setMilliseconds(0);
        const iso = when.toISOString();
        let id: string | undefined;
        try {
          const r = await adapter.createPost({
            title: 'ZZ backdate probe — safe to delete',
            html: '<p>x</p>',
            status: 'published',
            publish_at: iso,
          });
          id = r.id;
          expect(r.status).toBe('published');
          expect(r.publish_at).toBe(iso);
          expect(r.warnings ?? []).toEqual([]);
        } finally {
          if (id) await remove(id);
        }
      });
    });
  });
}
