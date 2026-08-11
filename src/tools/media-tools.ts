import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { getLibrary, indexFileFor, ledgerFileFor } from '../media/library.js';
import { staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { searchAssets } from '../media/search.js';
import { readIndex, readLedger, writeIndex } from '../media/store.js';
import type { LibraryConfig, MediaConfig, MediaIndex } from '../media/types.js';
import type { Paths } from '../config/paths.js';
import type { SitesConfig } from '../config/sites.js';
import { handler } from './shared.js';

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
  a: { scan?: boolean; library?: string },
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
    unused: number;
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
    const usedIds = new Set(ledger.records.map((r) => r.id));
    const assets = index?.assets ?? [];

    return {
      name,
      path: lib.path,
      scanned: index !== null,
      ...(index ? { scanned_at: index.scanned_at } : {}),
      assets: assets.length,
      images: assets.filter((x) => x.kind === 'image').length,
      videos: assets.filter((x) => x.kind === 'video').length,
      enriched: assets.filter((x) => x.enriched).length,
      unused: assets.filter((x) => !usedIds.has(x.id)).length,
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
  const site = a.site ?? '';
  const excludeIds = unusedOnly
    ? new Set(
        ledger.records
          .filter((r) => ctx.media.reuseScope === 'global' || r.site === site)
          .map((r) => r.id),
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

export function registerMediaTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_media_libraries',
    {
      title: 'List media libraries',
      description:
        'List the local media libraries byline is configured to use, with asset counts, how many are still unused, and whether the index is up to date. Pass scan: true to walk the folder and rebuild the index first — that is how a new or changed library becomes searchable. Byline never writes inside your library folder.',
      inputSchema: {
        library: z.string().optional().describe('Limit to one library. Omit for all of them.'),
        scan: z
          .boolean()
          .default(false)
          .describe('Walk the folder and rebuild the index before reporting.'),
      },
    },
    handler('list_media_libraries', (a: { library?: string; scan?: boolean }) =>
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
          .describe('The site this is for. Decides what counts as already used when reuse_scope is "site".'),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    handler('find_media', (a: Parameters<typeof findMedia>[1]) => findMedia(ctx, a).then(ok)),
  );
}
