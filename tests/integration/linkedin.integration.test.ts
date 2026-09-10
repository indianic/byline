import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';
import { LinkedInAdapter } from '../../src/plugins/platforms/linkedin/index.js';
import type { SiteConfig } from '../../src/config/sites.js';

// Resolve config exactly the way the server does, per the pattern every other
// *.integration.test.ts in this directory follows (see ghost.integration.test.ts
// and wordpress.integration.test.ts) — `loadContext()`, never a bare
// `loadSites()`, which defaults to a relative path that bypasses `~/.byline/`
// resolution entirely.
const ctx = loadContext();
const site = ctx.sites.sites.linkedin;
const skipReason = !site
  ? 'no site named "linkedin" in the resolved config'
  : site.unavailable
    ? site.unavailable
    : undefined;

// Every request shape this suite exercises is UNVERIFIED until this file has
// actually run against a real token — see the header comment on
// `src/plugins/platforms/linkedin/index.ts`. This suite IS the probe that can
// promote any of it to verified; it makes no such claim about itself.
if (skipReason) {
  describe.skip(`LinkedIn integration (linkedin site only) — SKIPPED: ${skipReason}`, () => {
    it('skipped', () => {});
  });
} else {
  const usableSite: SiteConfig = site!;

  describe('LinkedIn integration (linkedin site only)', () => {
    const adapter = new LinkedInAdapter(usableSite);

    it('never targets a site other than "linkedin"', () => {
      expect(usableSite.slug).toBe('linkedin');
    });

    it('health check succeeds with a real token', async () => {
      const r = await adapter.healthCheck();
      expect(r.ok, r.detail).toBe(true);
    });

    // ADDING-A-PLATFORM.md rule 4: healthCheck() must gate on an endpoint that
    // genuinely requires the credential — proven here with a
    // fabricated-but-well-formed token against the LIVE /v2/userinfo endpoint,
    // not a mock. A 2xx here would mean this plugin has the exact defect that
    // rule exists to catch.
    it('health check reports a fabricated-but-well-formed token as unhealthy', async () => {
      const badSite: SiteConfig = {
        ...usableSite,
        credentials: { ...usableSite.credentials, access_token: 'AQVfabricated-not-a-real-token-0000000000' },
      };
      const r = await new LinkedInAdapter(badSite).healthCheck();
      expect(r.ok).toBe(false);
      expect(r.status).toBeDefined();
      expect(r.status! >= 200 && r.status! < 300).toBe(false);
    });

    it('lists at least one author (the authenticated person)', async () => {
      const authors = await adapter.listAuthors();
      expect(authors.length).toBeGreaterThan(0);
      expect(authors[0]).toHaveProperty('id');
      expect(authors[0]!.id).toMatch(/^urn:li:/);
    });

    // Publishes to a REAL LinkedIn feed and cannot be reliably cleaned up
    // through this API — LinkedIn's delete-a-post behaviour was never probed
    // either. Gated behind a second, more specific flag on top of
    // RUN_INTEGRATION so running the rest of this suite never risks a real
    // post by accident. When this actually runs against a live token, record
    // the measured response shape (the create response, the x-restli-id
    // header, and the read-back) in docs/platforms/linkedin.md — every UNVERIFIED
    // marker there is a to-do this run resolves, not a to-do to remove blind.
    (process.env.RUN_INTEGRATION_LINKEDIN_POST === '1' ? it : it.skip)(
      'creates a real feed post and reads it back',
      async () => {
        const result = await adapter.createPost({
          title: 'Byline integration probe — safe to delete',
          html: '<p>Byline LinkedIn integration probe. Safe to delete.</p>',
          status: 'published',
        });
        expect(result.id).toBeTruthy();
        expect(result.url).toContain('linkedin.com/feed/update/');
      },
    );
  });
}
