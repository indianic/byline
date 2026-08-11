import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';
import { loadMedia } from '../../src/media/library.js';
import { listMediaLibraries, findMedia, useMedia } from '../../src/tools/media-tools.js';
import type { UploadCtx } from '../../src/tools/media-tools.js';

const SITE = 'personal';
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Resolve config exactly the way the server does (loadContext, not a
// hand-built object) — same reasoning as ghost.integration.test.ts. `ctx.sites`
// is real; only `paths.home` is swapped for a temp directory below so the
// media index and usage ledger never touch the user's real ~/.byline.
const ctx = loadContext();
const site = ctx.sites.sites[SITE];
const skipReason = !site
  ? `no site named "${SITE}" in the resolved config`
  : site.unavailable
    ? site.unavailable
    : undefined;

describe('media library against a live site', () => {
  it.skipIf(Boolean(skipReason))(
    `uploads a library asset to "${SITE}" and reads the hosted URL back — SKIPPED unless configured: ${skipReason ?? 'n/a'}`,
    async () => {
      // A real library folder, in a temp dir, with a real PNG in it.
      const root = mkdtempSync(join(tmpdir(), 'bl-int-'));
      mkdirSync(join(root, 'probe'), { recursive: true });
      writeFileSync(join(root, 'probe', 'byline-integration-dot.png'), PNG_1x1);

      // A temp `paths.home` so the derived index and usage ledger land in
      // scratch, never in the user's real ~/.byline/media.
      const home = mkdtempSync(join(tmpdir(), 'bl-int-home-'));
      writeFileSync(
        join(home, 'config.yaml'),
        `sites: {}\nmedia:\n  libraries:\n    - name: probe\n      path: ${root}\n`,
      );

      // Real sites from the real config; a temp home so the index and ledger
      // land in scratch rather than the user's ~/.byline. Built field by
      // field per MediaCtx/UploadCtx — no `as Context` cast, so a function
      // that starts reading a field this object never had fails loudly
      // instead of silently passing.
      const mediaCtx: UploadCtx = {
        paths: { home },
        media: loadMedia(join(home, 'config.yaml'), process.env),
        sites: ctx.sites,
      };

      await listMediaLibraries(mediaCtx, { scan: true });

      // `find_media`'s unused_only defaults to true, and reuse_scope defaults
      // to "site" — so `site` must be passed here too, not only on the
      // post-upload check below, or the tool refuses with SITE_REQUIRED.
      const found = await findMedia(mediaCtx, { query: 'dot', library: 'probe', site: SITE });
      expect(found.results).toHaveLength(1);

      const used = await useMedia(mediaCtx, {
        site: SITE,
        library: 'probe',
        assets: [{ path: found.results[0]!.path, alt: 'a single dark pixel' }],
      });

      expect(used.failed).toBe(0);
      const url = used.images[0]!.url!;
      expect(url).toMatch(/^https:\/\//);

      // READ IT BACK. An upload that reports success and serves nothing is the
      // failure mode this whole test exists for.
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^image\//);

      // The asset must now be excluded from search for this site — proving
      // the ledger actually closed the loop.
      const after = await findMedia(mediaCtx, { query: 'dot', library: 'probe', site: SITE });
      expect(after.results).toHaveLength(0);
    },
  );
});
