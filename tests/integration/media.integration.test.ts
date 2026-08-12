import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Context, loadContext } from '../../src/context.js';
import { buildServer } from '../../src/index.js';
import { ledgerFileFor, loadMedia } from '../../src/media/library.js';
import { readLedger } from '../../src/media/store.js';
import { ghostToken } from '../../src/plugins/platforms/ghost/auth.js';
import { extractImgSrcs, listMediaLibraries, findMedia, useMedia } from '../../src/tools/media-tools.js';
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

// The publish half of this file reads a post back through the Ghost Admin API
// and deletes it there, so it is Ghost-specific. Skipped with a named reason
// rather than pointed at some other site.
const ghostSkipReason = skipReason ?? (site!.platform !== 'ghost' ? `site "${SITE}" is ${site!.platform}, not ghost` : undefined);

/** A real library folder, in a temp dir, with a real PNG in it. */
function tempLibrary(): { home: string; configFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'bl-int-'));
  mkdirSync(join(root, 'probe'), { recursive: true });
  writeFileSync(join(root, 'probe', 'byline-integration-dot.png'), PNG_1x1);

  // A temp `paths.home` so the derived index and usage ledger land in
  // scratch, never in the user's real ~/.byline/media.
  const home = mkdtempSync(join(tmpdir(), 'bl-int-home-'));
  const configFile = join(home, 'config.yaml');
  writeFileSync(configFile, `sites: {}\nmedia:\n  libraries:\n    - name: probe\n      path: ${root}\n`);
  return { home, configFile };
}

describe('media library against a live site', () => {
  it.skipIf(Boolean(skipReason))(
    `uploads a library asset to "${SITE}" and reads the hosted URL back — SKIPPED unless configured: ${skipReason ?? 'n/a'}`,
    async () => {
      const { home, configFile } = tempLibrary();

      // Real sites from the real config; a temp home so the index and ledger
      // land in scratch rather than the user's ~/.byline. Built field by
      // field per MediaCtx/UploadCtx — no `as Context` cast, so a function
      // that starts reading a field this object never had fails loudly
      // instead of silently passing.
      const mediaCtx: UploadCtx = {
        paths: { home },
        media: loadMedia(configFile, process.env),
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
      expect(used.problems).toBeUndefined();
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

      // And use_media itself must refuse it, without a second upload: the
      // ledger is consulted, not merely written.
      const again = await useMedia(mediaCtx, {
        site: SITE,
        library: 'probe',
        assets: [{ path: found.results[0]!.path }],
      });
      expect(again.uploaded).toBe(0);
      expect(again.images[0]!.code).toBe('ALREADY_USED');
    },
  );

  /**
   * The one that settles whether promotion works at all.
   *
   * `promote()` matches a reservation's `hosted_url` against the image URLs a
   * post carries, by EXACT STRING EQUALITY. Every unit test of it hands the
   * upload double a string and gets the identical string back, so the suite is
   * structurally incapable of noticing a platform that rewrites the URL — a
   * `__GHOST_URL__` placeholder, a protocol-relative form, a CDN host, a
   * `/size/w1000/` responsive prefix. If that ever happens, `promoted` is
   * permanently 0, every record stays `reserved`, nothing in this release can
   * `release` one, and every photograph is retired after a single use even
   * though the post published perfectly.
   *
   * So this goes through the real `create_post` tool — the MCP layer included,
   * because that layer has silently dropped a field before — and then reads the
   * post back off the live site to check what Ghost actually stored.
   */
  it.skipIf(Boolean(ghostSkipReason))(
    `publishes a library asset into a real post and promotes the reservation — SKIPPED unless configured: ${ghostSkipReason ?? 'n/a'}`,
    async () => {
      const { home, configFile } = tempLibrary();
      const media = loadMedia(configFile, process.env);
      const mediaCtx: UploadCtx = { paths: { home }, media, sites: ctx.sites };

      // A REAL Context: the resolved one, with only the home and the media
      // config swapped for the temp library. Not a cast, not a hand-built
      // double — `create_post` reads far more of it than this test knows about.
      const postCtx: Context = { ...ctx, paths: { ...ctx.paths, home }, media };

      await listMediaLibraries(mediaCtx, { scan: true });
      const found = await findMedia(mediaCtx, { query: 'dot', library: 'probe', site: SITE });
      const used = await useMedia(mediaCtx, {
        site: SITE,
        library: 'probe',
        assets: [{ path: found.results[0]!.path, alt: 'a single dark pixel' }],
      });
      expect(used.failed).toBe(0);
      const hostedUrl = used.images[0]!.url!;

      const ledgerFile = ledgerFileFor(media.libraries.probe!, home);
      expect(readLedger(ledgerFile, 'probe').records[0]!.state).toBe('reserved');

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'media-integration', version: '0' });
      await Promise.all([
        client.connect(clientTransport),
        buildServer(postCtx).connect(serverTransport),
      ]);

      let postId: string | undefined;
      try {
        const raw = await client.callTool({
          name: 'create_post',
          arguments: {
            site: SITE,
            title: 'ZZ media probe — safe to delete',
            // Draft: the reservation is promoted the same way for a draft as
            // for a published post, and nothing goes live on the real blog.
            status: 'draft',
            html: `<p>Media library probe.</p><img src="${hostedUrl}" alt="a single dark pixel"><p>End of probe.</p>`,
            feature_image: hostedUrl,
            feature_image_alt: 'a single dark pixel',
          },
        });
        const created = JSON.parse(
          (raw.content as Array<{ type: string; text: string }>)[0]!.text,
        ) as { ok: boolean; id?: string; url?: string; warnings?: string[]; error?: unknown };

        expect(created.ok, JSON.stringify(created)).toBe(true);
        postId = created.id;
        expect(postId).toBeTruthy();

        // A ledger problem would arrive folded into `warnings` — nothing here
        // may be about the media ledger.
        expect((created.warnings ?? []).filter((w) => /ledger|media library/i.test(w))).toEqual([]);

        // THE ASSERTION THIS TEST EXISTS FOR: the reservation became a
        // publication, naming the post it went into.
        const records = readLedger(ledgerFile, 'probe').records;
        expect(records).toHaveLength(1);
        expect(records[0]!.state).toBe('published');
        expect(records[0]!.post_url).toBe(created.url);
        expect(records.filter((r) => r.state === 'published')).toHaveLength(1);

        // Now what the PLATFORM stored, not what we sent it. `promote()`
        // compares strings, so a Ghost that rewrote this URL on ingest would
        // make every future match fail — and the unit suite could never see
        // it. Ghost's rendered HTML carries resized variants in `srcset`; the
        // `src` is what is compared here, and it must be the URL byte for byte.
        const readBack = await fetch(`${site!.apiUrl}/posts/${postId}/?formats=html`, {
          headers: {
            Authorization: `Ghost ${ghostToken(site!.credentials.admin_api_key ?? '', site!.slug)}`,
            'Accept-Version': 'v6.0',
          },
        });
        expect(readBack.status).toBe(200);
        const body = (await readBack.json()) as {
          posts?: Array<{ html?: string; feature_image?: string }>;
        };
        const storedHtml = body.posts?.[0]?.html ?? '';
        expect(extractImgSrcs(storedHtml)).toContain(hostedUrl);
        expect(body.posts?.[0]?.feature_image).toBe(hostedUrl);
      } finally {
        await client.close();
        if (postId) {
          const del = await fetch(`${site!.apiUrl}/posts/${postId}/`, {
            method: 'DELETE',
            headers: {
              Authorization: `Ghost ${ghostToken(site!.credentials.admin_api_key ?? '', site!.slug)}`,
              'Accept-Version': 'v6.0',
            },
          });
          expect(del.status).toBe(204);
        }
      }
    },
  );
});
