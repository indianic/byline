import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { type EmbedProvider, embedHtml, parseVideoUrl } from '../media/embed.js';
import { getLibrary, indexFileFor, ledgerFileFor, libraryNamed } from '../media/library.js';
import { isUsed, promote, reserve, staleReservations } from '../media/ledger.js';
import { scanLibrary } from '../media/scan.js';
import { searchAssets } from '../media/search.js';
import { readIndex, readLedger, writeIndex, writeLedger } from '../media/store.js';
import { extensionFor } from '../plugins/images/inspect.js';
import type { LibraryConfig, MediaConfig, MediaIndex } from '../media/types.js';
import type { Paths } from '../config/paths.js';
import { getSite, type SitesConfig } from '../config/sites.js';
import { adapterFor, handler } from './shared.js';

/** What `embed_video` needs — just enough of `Context` to resolve a site's platform. */
export interface EmbedCtx {
  sites: SitesConfig;
}

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
      // Names a tool that exists. There is no `byline media` CLI command in
      // this release — `src/cli/main.ts` answers one with "Unknown command".
      hint: 'Call list_media_libraries with scan: true.',
    });
  }
  return index;
}

/** What `list_media_libraries` reports about one library. */
interface LibraryReport {
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
   *
   * Absent too when there is no library to count — an unconfigured name has
   * no assets and no ledger, and a zero there reads as "nothing is used"
   * rather than "there is nothing to ask about".
   */
  unused?: number;
  unused_note?: string;
  /**
   * Uploads that never made it into a post. Absent, rather than zero, when
   * there is no ledger to read — a fabricated zero is indistinguishable from
   * a genuine "none", which is exactly how a real reservation would be hidden.
   *
   * NOTHING IN THIS RELEASE CLEARS ONE. `release` exists in
   * `src/media/ledger.ts` and no tool or command reaches it, so the remedy is
   * to edit the ledger file by hand — see `stale_reservations_note`, which
   * names the file.
   */
  stale_reservations?: number;
  stale_reservations_note?: string;
  /** Why the library cannot be used at all — a config-level fault. */
  unavailable?: string;
  /** A runtime failure while reporting THIS library, e.g. a corrupt ledger. */
  problem?: string;
}

/** How to clear a reservation, given that no tool in this release can. */
function staleReservationNote(ledgerFile: string): string {
  return `Nothing in this release releases a reservation: publishing a post that carries the hosted URL promotes it, and there is no tool or CLI command that clears one otherwise. To drop a reservation that will never be published, edit ${ledgerFile} by hand and remove the record — it is plain JSON. Leave "published" records alone; deleting one puts a live photograph back into the unused pool.`;
}

/** The zeroed counts every report starts from. */
const NO_ASSETS = { scanned: false, assets: 0, images: 0, videos: 0, enriched: 0 } as const;

/**
 * Report one library, or say why it could not be reported.
 *
 * Per-library isolation is the point: this is the one tool whose job includes
 * reporting a BROKEN library, and a corrupt ledger used to throw out of the
 * enclosing `.map` so that no library was reported at all. `promoteUsedMedia`
 * has had this shape from the start; the asymmetry was not justified.
 */
function describeLibrary(
  ctx: MediaCtx,
  name: string,
  a: { scan?: boolean; site?: string },
): LibraryReport {
  const lib = libraryNamed(ctx.media.libraries, name);
  if (!lib) {
    return {
      name,
      path: '',
      ...NO_ASSETS,
      unavailable: `No media library named "${name}".`,
    };
  }

  try {
    return reportLibrary(ctx, lib, a);
  } catch (e) {
    return {
      name,
      path: lib.path,
      ...NO_ASSETS,
      ...(lib.unavailable ? { unavailable: lib.unavailable } : {}),
      problem: `Media library "${name}" could not be reported: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

function reportLibrary(
  ctx: MediaCtx,
  lib: LibraryConfig,
  a: { scan?: boolean; site?: string },
): LibraryReport {
  const ledgerFile = ledgerFileFor(lib, ctx.paths.home);

  if (lib.unavailable) {
    // The library folder is unreachable; the LEDGER is not inside it. It lives
    // under the byline home (or the configured index_path), so the reservation
    // count is still answerable — and a reservation on an unmounted drive is
    // exactly the case where a hardcoded zero hides an asset that is still
    // held. Reported when it can be read, omitted with a reason when it
    // cannot, never invented.
    const canReadLedger = existsSync(ledgerFile) || existsSync(dirname(ledgerFile));
    if (!canReadLedger) {
      return {
        name: lib.name,
        path: lib.path,
        ...NO_ASSETS,
        unavailable: lib.unavailable,
        stale_reservations_note: `The usage ledger for this library is at ${ledgerFile}, which is not reachable either, so reservations cannot be counted.`,
      };
    }
    const stale = staleReservations(readLedger(ledgerFile, lib.name)).length;
    return {
      name: lib.name,
      path: lib.path,
      ...NO_ASSETS,
      unavailable: lib.unavailable,
      stale_reservations: stale,
      ...(stale > 0 ? { stale_reservations_note: staleReservationNote(ledgerFile) } : {}),
    };
  }

  const indexFile = indexFileFor(lib, ctx.paths.home);
  let index = readIndex(indexFile);

  if (a.scan) {
    index = scanLibrary(lib, index);
    writeIndex(indexFile, index);
  }

  const ledger = readLedger(ledgerFile, lib.name);
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

  const stale = staleReservations(ledger).length;

  return {
    name: lib.name,
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
    stale_reservations: stale,
    ...(stale > 0 ? { stale_reservations_note: staleReservationNote(ledgerFile) } : {}),
  };
}

export async function listMediaLibraries(
  ctx: MediaCtx,
  a: { scan?: boolean; library?: string; site?: string },
): Promise<{
  libraries: LibraryReport[];
  reuse_scope: 'site' | 'global';
  default_library?: string;
}> {
  const names = a.library ? [a.library] : Object.keys(ctx.media.libraries);

  return {
    libraries: names.map((name) => describeLibrary(ctx, name, a)),
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
          // This note fires on every response in this release: nothing in the
          // codebase can write an `enriched` block yet. It therefore says what
          // is true — enrichment does not exist — rather than sending every
          // user to a command that does not exist either.
          note: 'No asset in this library has been enriched, so matching used filenames and folder names only. Enrichment — captions, keywords, and has_people — is not available in this release, so ranking rests on what the files and folders are named.',
        }),
  };
}

/**
 * The filename an asset is uploaded under: its own stem, and an extension
 * derived from the mime `scan` read out of the bytes.
 *
 * Both adapters derive the upload `Content-Type` from the filename extension —
 * `mimeFor` in the WordPress adapter, `IMAGE_MIME` in the Ghost one — so
 * passing `basename(asset.path)` through verbatim hands the platform whatever
 * the file happens to be NAMED. `scan` already corrected `asset.mime` from the
 * magic bytes for exactly this reason, and throwing that away here recreates
 * the defect `inspectImage` was written for. `image-tools.ts` names generated
 * files the same way, from `extensionFor(info.mime)`.
 */
function uploadNameFor(asset: { path: string; mime: string }): string {
  const stem = basename(asset.path).replace(/\.[^.]+$/, '');
  return `${stem}.${extensionFor(asset.mime)}`;
}

/** One entry of `use_media`'s per-asset report. */
interface UseResult {
  ok: boolean;
  path: string;
  url?: string;
  id?: string;
  /** Machine-readable reason this entry failed, e.g. `ALREADY_USED`. */
  code?: string;
  error?: string;
  /** What to do about it, the same field `ToolError` carries. */
  hint?: string;
}

export async function useMedia(
  ctx: UploadCtx,
  a: {
    site: string;
    library?: string;
    assets: { path: string; alt?: string }[];
    allow_reuse?: boolean;
  },
): Promise<{
  library: string;
  images: UseResult[];
  uploaded: number;
  failed: number;
  /** Present only when something went wrong that no single entry describes. */
  problems?: string[];
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
    // A video is INDEXED and SEARCHABLE, and cannot be uploaded. The upload
    // path is `adapter.uploadImage`, whose Content-Type tables cover images
    // only: a `.mp4` reaches Ghost as `application/octet-stream` and comes
    // back 415. Refused here, before anything is uploaded or reserved, rather
    // than failing halfway through a batch with a status code that says
    // nothing about why.
    if (asset.kind !== 'image') {
      throw new ToolError({
        api: 'media',
        code: 'VIDEO_NOT_SUPPORTED',
        message: `"${want.path}" is a ${asset.kind}, and byline cannot upload video yet: the media upload path handles images only.`,
        hint: 'Pass an image. Videos are indexed and searchable so you can find them, but publishing one is not implemented in this release — upload it through your platform directly.',
      });
    }
    return { asset, alt: want.alt };
  });

  const images: UseResult[] = [];
  let ledger = readLedger(ledgerFile, lib.name);

  for (const { asset, alt } of resolved) {
    const full = join(lib.path, asset.path);

    // The ledger is CONSULTED here, not merely written to below. `find_media`
    // offers `unused_only: false` — a legal escape hatch — so a model can hand
    // an already-published photograph straight back to this tool, and without
    // this check it would be uploaded again and reported as a success. Reading
    // is `isUsed`'s job and only `isUsed`'s: it is the one definition of
    // used/not-used, and this is the fourth caller of it, not a fourth copy.
    if (!a.allow_reuse && isUsed(ledger, asset.id, a.site, ctx.media.reuseScope)) {
      const prior = ledger.records.find(
        (r) => r.id === asset.id && (ctx.media.reuseScope === 'global' || r.site === a.site),
      );
      const where = prior?.post_url
        ? `it is already published in ${prior.post_url}`
        : `it was already uploaded to ${prior?.hosted_url ?? 'this site'} and is waiting to be published`;
      const scope =
        ctx.media.reuseScope === 'global'
          ? 'reuse_scope is "global", so a use on any site counts'
          : `on site "${prior?.site ?? a.site}"`;
      images.push({
        ok: false,
        path: asset.path,
        code: 'ALREADY_USED',
        error: `"${asset.path}" has already been used: ${where} (${scope}). It was not uploaded again.`,
        hint: 'Pick a different asset — find_media excludes used ones by default — or pass allow_reuse: true if publishing this same photograph twice is what you actually want.',
      });
      continue;
    }

    try {
      const bytes = readFileSync(full);
      const uploaded = await adapter.uploadImage(bytes, uploadNameFor(asset), alt);
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

  // A ledger write that throws must NOT destroy the result of a batch that
  // already reached the platform. Twelve photographs upload, `~/.byline/media`
  // turns out to be read-only, and the raw fs error would surface as
  // `{ ok: false, code: 'UNEXPECTED' }` with all twelve hosted URLs gone.
  // `promoteUsedMedia` is already careful never to throw for this exact
  // reason; the asymmetry was not justified.
  const problems: string[] = [];
  try {
    writeLedger(ledgerFile, ledger);
  } catch (e) {
    problems.push(
      `media: the usage ledger at ${ledgerFile} could not be written: ${
        e instanceof Error ? e.message : String(e)
      }. Every upload reported above still succeeded and its URL is usable, but these assets were NOT recorded as used, so they may be offered again. Fix write access to that file, then re-check with list_media_libraries.`,
    );
  }

  const failed = images.filter((i) => !i.ok).length;
  return {
    library: lib.name,
    images,
    uploaded: images.length - failed,
    failed,
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/**
 * Extract the `src` values from all `<img>` tags in HTML.
 *
 * Both `create_post` and `update_post` must extract the same set of image
 * references when confirming that library assets reached a published page.
 * A future change to what counts as a referenced image must land in one place,
 * not duplicated in two. This helper is that one place.
 *
 * @param html The article HTML.
 * @returns An array of `src` values in order of appearance, empty if no `<img>` tags.
 */
export function extractImgSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
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
    if (lib.unavailable) {
      // Reported, not skipped. Unmount the drive between `use_media` and
      // `create_post` and the reservation can never be promoted: the post
      // publishes, the ledger never moves, and the asset stays retired. That
      // is precisely the outcome nobody would notice without being told.
      //
      // Only when the post carried images at all: a post with none could not
      // have promoted anything from any library, so the warning would be
      // noise on every text-only post for anyone whose photo drive is
      // normally unplugged.
      if (hostedUrls.length === 0) continue;
      problems.push(
        `Media library "${lib.name}" is unavailable, so any reservation it holds was not confirmed against this post: ${lib.unavailable} The post published fine, but those assets stay reserved until the library is reachable again.`,
      );
      continue;
    }
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
        }. The post published fine, but this asset may be offered again. Call list_media_libraries to check.`,
      );
    }
  }

  return { promoted: total, problems };
}

/** What `embed_video` returns. */
export interface EmbedVideoResult {
  provider: EmbedProvider;
  embed_url: string;
  html: string;
  warnings: string[];
}

/**
 * Turn a video URL into the `<iframe>` embed HTML measured to survive both
 * platforms (see `src/media/embed.ts` and `docs/GHOST-NOTES.md` /
 * `docs/WORDPRESS-NOTES.md`, both probed 2026-08-12).
 *
 * `site` is optional and changes nothing about the HTML produced — it only
 * decides whether the WordPress caveat below applies. Without it, the caller
 * gets no warning either way, which is honest: nothing here can know which
 * platform the embed is headed for.
 */
export function embedVideo(
  ctx: EmbedCtx,
  a: { url: string; site?: string; caption?: string; title?: string },
): EmbedVideoResult {
  const embed = parseVideoUrl(a.url);
  const warnings: string[] = [];

  if (a.site) {
    const site = getSite(ctx.sites, a.site);
    if (site.platform === 'wordpress') {
      // Measured 2026-07-29/2026-08-12: an account HOLDING unfiltered_html
      // keeps an <iframe> unchanged. Whether an account LACKING it does too is
      // UNVERIFIED — no such account has ever been available to probe (see
      // docs/WORDPRESS-NOTES.md). This warns rather than silently assuming
      // either way, since resolving the live capability here would mean this
      // pure-URL tool making a network call just to answer a question
      // score_draft already answers for the account that will actually publish.
      warnings.push(
        `"${a.site}" is WordPress. This embed survives for an account holding the unfiltered_html capability (measured by live probe). Whether it survives for an account WITHOUT that capability is UNVERIFIED — WordPress's KSES filter is documented to strip <iframe> entirely for such an account, but no probe has confirmed it. If in doubt, publish a draft and check score_draft's platform_html result, or read the post back after publishing.`,
      );
    }
  }

  return {
    provider: embed.provider,
    embed_url: embed.embedUrl,
    html: embedHtml(embed, a.caption, a.title),
    warnings,
  };
}

export function registerMediaTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_media_libraries',
    {
      title: 'List media libraries',
      description:
        'List the local media libraries byline is configured to use, with asset counts, how many are still unused, whether it has been scanned, and when. Pass scan: true to walk the folder and rebuild the index first — that is how a new or changed library becomes searchable. When reuse_scope is "site", the `unused` count is only reported if you pass `site` — otherwise the response explains why in `unused_note` instead of guessing. Byline never writes inside your library folder.',
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
        kind: z
          .enum(['image', 'video'])
          .optional()
          .describe(
            'Videos are indexed and searchable, but they cannot be published yet: use_media refuses one, because the upload path handles images only. Search for them to see what you have; publish an image.',
          ),
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
            'The site this is for. REQUIRED when unused_only is in effect (the default true) and reuse_scope is "site" — the tool throws rather than silently skip the exclusion. Not required when reuse_scope is "global" (used anywhere excludes it everywhere), or when unused_only: false. The exclusion applies to THIS site only; use_media re-checks the ledger against whatever site it is given, so passing a different one there does not smuggle a used asset through.',
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
        'Upload one or more local library assets to a site and record them as used. Before uploading, each asset is checked against the usage ledger and REFUSED if it has been used before — under the default reuse_scope "site" that means used on THIS site, so the same photograph can still be published on another site unless reuse_scope is "global". A refusal names where the asset went last time and does not fail the rest of the batch; pass allow_reuse: true to override it deliberately. Images only: a video is refused, because byline cannot upload video yet. Pass the `path` values exactly as find_media returned them. Returns the hosted URL for each, ready for feature_image or an inline <img>. One failure does not fail the batch — check every entry.',
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
        allow_reuse: z
          .boolean()
          .default(false)
          .describe(
            'Upload an asset that the ledger says has already been used. Defaults false. Set it only when publishing the same photograph twice is the deliberate intent — the whole point of the ledger is that this does not happen by accident.',
          ),
      },
    },
    handler('use_media', (a: Parameters<typeof useMedia>[1]) => useMedia(ctx, a).then(ok)),
  );

  server.registerTool(
    'embed_video',
    {
      title: 'Embed video',
      description:
        'Turn a YouTube, Vimeo, or Bunny Stream URL into ready-to-paste <iframe> embed HTML — byline cannot upload video, so this is the way video goes into an article. Normalises whatever form the URL was copied in (a `watch?v=` link does not work inside an <iframe>; `/embed/ID` does) and refuses anything that is not one of the three supported providers, rather than passing an unrecognised URL through. ' +
        'Verified by live probe 2026-08-12: both Ghost and WordPress (for an account holding the unfiltered_html capability) keep the <iframe> and its <figure>/<figcaption> wrapper unchanged on ingest — Ghost additionally wraps it in its own kg-embed-card figure. For a WordPress account WITHOUT unfiltered_html, whether the <iframe> survives is UNVERIFIED; pass `site` naming a WordPress site to get that caveat back in `warnings`. ' +
        'A plain <video> tag is a separate, worse option: Ghost strips it completely, with nothing surviving.',
      inputSchema: {
        url: z.string().describe("A YouTube, Vimeo, or Bunny Stream video URL, in any of that provider's common forms."),
        site: z
          .string()
          .optional()
          .describe(
            'The site this embed is headed for. Changes nothing about the HTML produced — it only decides whether a WordPress caveat is added to `warnings`.',
          ),
        caption: z.string().optional().describe('Caption text under the video. Omitted from the HTML entirely when not given, rather than an empty <figcaption>.'),
        title: z
          .string()
          .optional()
          .describe('Accessible title attribute on the <iframe>. Defaults to "<Provider> video" (e.g. "YouTube video") when omitted.'),
      },
    },
    handler('embed_video', async (a: Parameters<typeof embedVideo>[1]) => ok(embedVideo(ctx, a))),
  );
}
