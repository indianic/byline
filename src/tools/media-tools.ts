import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { getLibrary, indexFileFor, ledgerFileFor } from '../media/library.js';
import { isUsed, promote, reserve, staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { searchAssets } from '../media/search.js';
import { readIndex, readLedger, writeIndex, writeLedger } from '../media/store.js';
import type { LibraryConfig, MediaConfig, MediaIndex } from '../media/types.js';
import type { Paths } from '../config/paths.js';
import type { SitesConfig } from '../config/sites.js';
import { adapterFor, handler } from './shared.js';

/**
 * Exactly what the read-only media tools touch.
 *
 * Declared field by field rather than as `Context`, because test files are NOT
 * typechecked in this repo: a test that casts a small object to `Context` keeps
 * passing on the day a function starts reading a field that object never had.
 * A real `Context` satisfies this structurally, so production callers are
 * unchanged, and a test builds `{ paths: { home }, media }` with no cast.
 */
export interface MediaCtx {
  paths: Pick<Paths, 'home'>;
  media: MediaConfig;
}

/** …plus sites, for the tools that upload. */
export interface UploadCtx extends MediaCtx {
  sites: SitesConfig;
}

/** The index for a library, refusing with a fix rather than returning nothing. */
function requireIndex(ctx: MediaCtx, lib: LibraryConfig): MediaIndex {
  const index = readIndex(indexFileFor(lib, ctx.paths.home));
  if (!index) {
    throw new ToolError({
      api: 'media',
      code: 'NOT_SCANNED',
      message: `Media library "${lib.name}" has not been scanned yet.`,
      hint: 'Call list_media_libraries with scan: true, or run `byline media scan`.',
    });
  }
  return index;
}

export async function listMediaLibraries(
  ctx: MediaCtx,
  a: { scan?: boolean; library?: string; site?: string },
): Promise<{
  libraries: {
    name: string;
    path: string;
    scanned: boolean;
    scanned_at?: string;
    assets: number;
    images: number;
    videos: number;
    enriched: number;
    /**
     * Absent, not a guess, when reuse_scope is "site" and no `site` was given:
     * "unused" means something different per site under that scope, and
     * inventing a library-wide number would silently disagree with what
     * find_media excludes for any particular site. See `unused_note`.
     */
    unused?: number;
    unused_note?: string;
    stale_reservations: number;
    unavailable?: string;
  }[];
  reuse_scope: 'site' | 'global';
  default_library?: string;
}> {
  const names = a.library ? [a.library] : Object.keys(ctx.media.libraries);

  const libraries = names.map((name) => {
    const lib = ctx.media.libraries[name];
    if (!lib) {
      return {
        name,
        path: '',
        scanned: false,
        assets: 0,
        images: 0,
        videos: 0,
        enriched: 0,
        unused: 0,
        stale_reservations: 0,
        unavailable: `No media library named "${name}".`,
      };
    }
    if (lib.unavailable) {
      return {
        name,
        path: lib.path,
        scanned: false,
        assets: 0,
        images: 0,
        videos: 0,
        enriched: 0,
        unused: 0,
        stale_reservations: 0,
        unavailable: lib.unavailable,
      };
    }

    const indexFile = indexFileFor(lib, ctx.paths.home);
    let index = readIndex(indexFile);

    if (a.scan) {
      index = scanLibrary(lib, index);
      writeIndex(indexFile, index);
    }

    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), lib.name);
    const assets = index?.assets ?? [];

    // Under "site" scope, "unused" is only answerable for a specific site —
    // the same asset can be used on site B and still free for site A. Without
    // a `site` to resolve against, report that honestly instead of quietly
    // computing a library-wide figure that would disagree with what
    // find_media actually excludes for any one site.
    const canCountUnused = ctx.media.reuseScope === 'global' || a.site !== undefined;
    const unused = canCountUnused
      ? assets.filter((x) => !isUsed(ledger, x.id, a.site ?? '', ctx.media.reuseScope)).length
      : undefined;

    return {
      name,
      path: lib.path,
      scanned: index !== null,
      ...(index ? { scanned_at: index.scanned_at } : {}),
      assets: assets.length,
      images: assets.filter((x) => x.kind === 'image').length,
      videos: assets.filter((x) => x.kind === 'video').length,
      enriched: assets.filter((x) => x.enriched).length,
      ...(unused !== undefined
        ? { unused }
        : {
            unused_note:
              'reuse_scope is "site" and no `site` was given, so "unused" cannot be answered library-wide. Pass `site` to get a count for that site.',
          }),
      stale_reservations: staleReservations(ledger).length,
    };
  });

  return {
    libraries,
    reuse_scope: ctx.media.reuseScope,
    ...(ctx.media.defaultLibrary ? { default_library: ctx.media.defaultLibrary } : {}),
  };
}

export async function findMedia(
  ctx: MediaCtx,
  a: {
    query: string;
    library?: string;
    kind?: 'image' | 'video';
    aspect?: '16:9' | '4:3' | '1:1';
    has_people?: boolean;
    unused_only?: boolean;
    site?: string;
    limit?: number;
  },
): Promise<{
  library: string;
  enriched: boolean;
  results: {
    id: string;
    path: string;
    local_path: string;
    kind: string;
    mime: string;
    width: number | null;
    height: number | null;
    aspect: string | null;
    caption?: string;
    keywords?: string[];
    score: number;
    why: { field: string; tokens: string[] }[];
  }[];
  note?: string;
}> {
  const lib = getLibrary(ctx.media, a.library);
  const index = requireIndex(ctx, lib);
  const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), lib.name);

  const unusedOnly = a.unused_only !== false;

  // Under "site" scope, "used" means used-on-that-site — a missing `site`
  // has no real record to compare against, so `''` would match nothing and
  // unused_only would silently exclude nothing, offering every already-
  // published photo again. Refuse instead of no-opping the one guarantee
  // this tool exists to provide. "global" scope needs no site at all.
  if (unusedOnly && ctx.media.reuseScope === 'site' && !a.site) {
    throw new ToolError({
      api: 'media',
      code: 'SITE_REQUIRED',
      message:
        'unused_only requires `site` when reuse_scope is "site": without it, "already used" cannot be resolved to any real record, so nothing would be excluded.',
      hint: 'Pass `site` naming which site this is for, or pass `unused_only: false` if you deliberately want everything, including already-used assets.',
    });
  }

  const excludeIds = unusedOnly
    ? new Set(
        [...new Set(ledger.records.map((r) => r.id))].filter((id) =>
          isUsed(ledger, id, a.site ?? '', ctx.media.reuseScope),
        ),
      )
    : undefined;

  const hits = searchAssets(index.assets, {
    query: a.query,
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.aspect ? { aspect: a.aspect } : {}),
    ...(a.has_people !== undefined ? { hasPeople: a.has_people } : {}),
    ...(excludeIds ? { excludeIds } : {}),
    limit: a.limit ?? 10,
  });

  const enrichedCount = index.assets.filter((x) => x.enriched).length;
  const enriched = enrichedCount > 0;

  return {
    library: lib.name,
    enriched,
    results: hits.map((h) => ({
      id: h.asset.id,
      path: h.asset.path,
      local_path: join(lib.path, h.asset.path),
      kind: h.asset.kind,
      mime: h.asset.mime,
      width: h.asset.width,
      height: h.asset.height,
      aspect: h.asset.aspect,
      ...(h.asset.enriched ? { caption: h.asset.enriched.caption } : {}),
      ...(h.asset.enriched ? { keywords: h.asset.enriched.keywords } : {}),
      score: h.score,
      why: h.why,
    })),
    ...(enriched
      ? {}
      : {
          note: 'No asset in this library has been enriched, so matching used filenames and folder names only. Run `byline media enrich` for keywords and captions.',
        }),
  };
}

export async function useMedia(
  ctx: UploadCtx,
  a: {
    site: string;
    library?: string;
    assets: { path: string; alt?: string }[];
  },
): Promise<{
  library: string;
  images: { ok: boolean; path: string; url?: string; id?: string; error?: string }[];
  uploaded: number;
  failed: number;
}> {
  const lib = getLibrary(ctx.media, a.library);
  const index = requireIndex(ctx, lib);
  const adapter = adapterFor(ctx, a.site);
  const ledgerFile = ledgerFileFor(lib, ctx.paths.home);

  const byPath = new Map(index.assets.map((x) => [x.path, x]));

  // Resolve EVERY asset before uploading anything. A batch that uploads two
  // files and then discovers the third is a typo has already spent two
  // reservations on an article that will not be written.
  const resolved = a.assets.map((want) => {
    const asset = byPath.get(want.path);
    if (!asset) {
      throw new ToolError({
        api: 'media',
        code: 'ASSET_NOT_FOUND',
        message: `"${want.path}" is not in the index for media library "${lib.name}".`,
        hint: 'Use the `path` exactly as find_media returned it, or rescan if the file is new.',
      });
    }
    return { asset, alt: want.alt };
  });

  const images: { ok: boolean; path: string; url?: string; id?: string; error?: string }[] = [];
  let ledger = readLedger(ledgerFile, lib.name);

  for (const { asset, alt } of resolved) {
    const full = join(lib.path, asset.path);
    try {
      const bytes = readFileSync(full);
      const uploaded = await adapter.uploadImage(bytes, basename(asset.path), alt);
      images.push({
        ok: true,
        path: asset.path,
        url: uploaded.url,
        ...(uploaded.id ? { id: uploaded.id } : {}),
      });
      // Reserved only AFTER the bytes reached the platform. Reserving a failed
      // upload would retire a photograph that was never published.
      ledger = reserve(ledger, {
        id: asset.id,
        site: a.site,
        hosted_url: uploaded.url,
        at: new Date().toISOString(),
      });
    } catch (e) {
      images.push({
        ok: false,
        path: asset.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  writeLedger(ledgerFile, ledger);

  const failed = images.filter((i) => !i.ok).length;
  return { library: lib.name, images, uploaded: images.length - failed, failed };
}

/**
 * Confirm reservations that made it into a published post.
 *
 * Called by `create_post` and `update_post`. Never throws: a publish that
 * succeeded must not be reported as failed because a ledger write did, so a
 * problem here is returned as a count of zero and the post stands.
 */
export function promoteUsedMedia(
  ctx: MediaCtx,
  hostedUrls: string[],
  postUrl: string,
): { promoted: number; problems: string[] } {
  let total = 0;
  const problems: string[] = [];

  for (const lib of Object.values(ctx.media.libraries)) {
    if (lib.unavailable) continue;
    const file = ledgerFileFor(lib, ctx.paths.home);
    try {
      const before = readLedger(file, lib.name);
      const { ledger, promoted } = promote(before, hostedUrls, postUrl);
      if (promoted > 0) {
        writeLedger(file, ledger);
        total += promoted;
      }
    } catch (e) {
      // Never rethrown: the post is already live, and failing the tool now
      // would report a successful publish as a failure. Never swallowed
      // either — the caller folds this into the warnings it already returns,
      // so a ledger that stopped recording is visible the moment it happens.
      problems.push(
        `Could not update the usage ledger for media library "${lib.name}": ${
          e instanceof Error ? e.message : String(e)
        }. The post published fine, but this asset may be offered again. Run \`byline media status\` to check.`,
      );
    }
  }

  return { promoted: total, problems };
}

export function registerMediaTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_media_libraries',
    {
      title: 'List media libraries',
      description:
        'List the local media libraries byline is configured to use, with asset counts, how many are still unused, and whether the index is up to date. Pass scan: true to walk the folder and rebuild the index first — that is how a new or changed library becomes searchable. When reuse_scope is "site", the `unused` count is only reported if you pass `site` — otherwise the response explains why in `unused_note` instead of guessing. Byline never writes inside your library folder.',
      inputSchema: {
        library: z.string().optional().describe('Limit to one library. Omit for all of them.'),
        scan: z
          .boolean()
          .default(false)
          .describe('Walk the folder and rebuild the index before reporting.'),
        site: z
          .string()
          .optional()
          .describe(
            'The site to count "unused" for. Only needed when reuse_scope is "site" — without it, the `unused` count for that library is omitted (see `unused_note`) rather than guessed. Ignored when reuse_scope is "global".',
          ),
      },
    },
    handler('list_media_libraries', (a: { library?: string; scan?: boolean; site?: string }) =>
      listMediaLibraries(ctx, a).then(ok),
    ),
  );

  server.registerTool(
    'find_media',
    {
      title: 'Find local media',
      description:
        'Search a local media library by keyword and get back ranked candidates with their local paths, ready to pass to use_media. Excludes anything already used by default. Each result carries a `why` naming the tokens that matched, so you can judge the match rather than trust the score. Requires a scan first — call list_media_libraries with scan: true if this refuses.',
      inputSchema: {
        query: z
          .string()
          .describe('What the image should show, in plain words. An empty string browses everything matching the filters.'),
        library: z.string().optional().describe('Which library. Defaults to the configured default.'),
        kind: z.enum(['image', 'video']).optional(),
        aspect: z.enum(['16:9', '4:3', '1:1']).optional(),
        has_people: z
          .boolean()
          .optional()
          .describe('Only assets known to contain people, or known not to. Un-enriched assets are excluded either way, because nothing has established it for them.'),
        unused_only: z
          .boolean()
          .default(true)
          .describe('Exclude assets already used. Defaults true — this is what stops the same photo appearing in two posts.'),
        site: z
          .string()
          .optional()
          .describe(
            'The site this is for. REQUIRED when unused_only is in effect (the default true) and reuse_scope is "site" — the tool throws rather than silently skip the exclusion. Not required when reuse_scope is "global" (used anywhere excludes it everywhere), or when unused_only: false.',
          ),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    handler('find_media', (a: Parameters<typeof findMedia>[1]) => findMedia(ctx, a).then(ok)),
  );

  server.registerTool(
    'use_media',
    {
      title: 'Use local media',
      description:
        'Upload one or more local library assets to a site and record them as used, so the same file is never published twice. Pass the `path` values exactly as find_media returned them. Returns the hosted URL for each, ready for feature_image or an inline <img>. One failure does not fail the batch — check every entry.',
      inputSchema: {
        site: z.string().describe('Which site to upload to.'),
        library: z.string().optional().describe('Which library. Defaults to the configured default.'),
        assets: z
          .array(
            z.object({
              path: z.string().describe('The `path` from a find_media result, not an absolute path.'),
              alt: z.string().optional().describe('Alt text describing what is visible in the frame.'),
            }),
          )
          .min(1)
          .max(12),
      },
    },
    handler('use_media', (a: Parameters<typeof useMedia>[1]) => useMedia(ctx, a).then(ok)),
  );
}
