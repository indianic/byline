// src/tools/image-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { composeImagePrompt, type ImageStyle } from '../craft/image-style.js';
import { AllProvidersFailed, generateImage } from '../plugins/images/index.js';
import { extensionFor, inspectImage } from '../plugins/images/inspect.js';
import { requireSetup } from '../setup.js';
import { adapterFor, handler } from './shared.js';

/**
 * Codes that mean "the providers declined", as opposed to "the providers broke".
 *
 * `NOT_CONFIGURED` counts as declining because it is not evidence of anything
 * going wrong — but a refusal has to be present too, or a machine with no image
 * keys at all would look like a safety block and retry pointlessly.
 */
const DECLINED = new Set(['SAFETY', 'NOT_CONFIGURED']);

function refusedOnSafety(e: AllProvidersFailed): boolean {
  return e.failures.some((f) => f.code === 'SAFETY') && e.failures.every((f) => DECLINED.has(f.code));
}

/**
 * How many images in a batch are generated at once.
 *
 * The round trips are what the batch tools exist to remove — four images used
 * to cost twelve tool calls — so this only has to be greater than one to
 * deliver most of the win. It is deliberately small: these are paid image
 * endpoints with per-minute limits, and a batch of eight fired simultaneously
 * is a good way to convert a slow success into a rate-limited failure.
 */
const BATCH_CONCURRENCY = 3;

/** Run `tasks` with a fixed concurrency ceiling, preserving input order. */
async function pooled<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await run(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ImageSpec {
  prompt: string;
  slot: string;
  aspect: '16:9' | '4:3' | '1:1';
  style: ImageStyle;
  look?: string;
  provider?: 'gemini' | 'grok';
}

/** The result shape both `generate_image` and `generate_images` report per image. */
interface GeneratedRecord {
  slot: string;
  path: string;
  bytes: number;
  provider: string;
  fallback_used: boolean;
  format: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  fallback_reason?: string;
  people_dropped?: boolean;
  people_dropped_reason?: string;
}

/**
 * Generate one image and write it to the runs directory.
 *
 * Shared by the single and batch tools so the two cannot diverge in what they
 * produce — the de-peopling retry, the filename, and the reported metadata are
 * defined once. Throws on failure; the batch caller catches per item.
 */
async function generateOne(ctx: Context, spec: ImageSpec): Promise<GeneratedRecord> {
  const opts = {
    aspect: spec.aspect,
    ...(spec.provider ? { provider: spec.provider } : {}),
  };

  let img: Awaited<ReturnType<typeof generateImage>>;
  let peopleDropped: string | undefined;

  try {
    img = await generateImage(composeImagePrompt(spec.style, spec.prompt, spec.look), opts);
  } catch (e) {
    // Retry WITHOUT people only when every provider actually refused.
    //
    // A 401, an exhausted quota, or a dead socket is not a refusal, and
    // treating it as one would silently drop the people requirement because
    // the network blipped — the article would publish looking fine, with
    // nobody in the picture and nobody told why.
    if (!(spec.style === 'photoreal_people' && e instanceof AllProvidersFailed && refusedOnSafety(e))) {
      throw e;
    }
    peopleDropped = e.failures
      .filter((f) => f.code === 'SAFETY')
      .map((f) => `${f.provider}: ${f.message}`)
      .join('; ');
    img = await generateImage(composeImagePrompt('photoreal_scene', spec.prompt, spec.look), opts);
  }

  const info = inspectImage(img.data);
  mkdirSync(ctx.runsDir, { recursive: true });
  // Named after what the bytes ARE, not after what this tool used to assume
  // they were. Every file was written `.png` regardless of the provider's
  // mime, and both adapters derive the upload Content-Type from the extension
  // — so a Gemini JPEG was uploaded declaring itself a PNG. `info.mime` is
  // read from the magic bytes and only falls back to the provider's claim when
  // the format was not recognised.
  const ext = extensionFor(info.mime ?? img.mime);
  const path = join(ctx.runsDir, `${Date.now()}-${basename(spec.slot)}.${ext}`);
  writeFileSync(path, img.data);

  return {
    slot: spec.slot,
    path,
    bytes: img.data.length,
    provider: img.provider,
    fallback_used: img.fallbackUsed,
    format: info.format,
    mime: info.mime,
    width: info.width,
    height: info.height,
    ...(img.fallbackReason ? { fallback_reason: img.fallbackReason } : {}),
    ...(peopleDropped
      ? {
          people_dropped: true,
          people_dropped_reason: `Every provider refused a prompt asking for people, so this image has none. ${peopleDropped}`,
        }
      : {}),
  };
}

/** The per-image zod shape, shared so the single and batch tools accept the same thing. */
const imageSpecShape = {
  prompt: z
    .string()
    .describe(
      'The SUBJECT only — what is happening and where, specific to this article. Do not include camera, lighting, or style words; those are added for you.',
    ),
  slot: z.string().default('image').describe('Filename stem, e.g. "hero" or "inline"'),
  aspect: z.enum(['16:9', '4:3', '1:1']).default('16:9'),
  style: z
    .enum(['photoreal_people', 'photoreal_scene', 'diagram'])
    .default('photoreal_people')
    .describe(
      'photoreal_people (default) — a photograph with people doing the work, for the hero/feature image. photoreal_scene — a photograph with no people required. diagram — no photographic styling at all; an escape hatch, and rarely right, since image models render text as gibberish.',
    ),
  look: z
    .string()
    .optional()
    .describe(
      "The camera register from build_writing_brief's IMAGES block, passed verbatim so every image in one article matches.",
    ),
  provider: z.enum(['gemini', 'grok']).optional().describe('Pin a provider; disables fallback'),
};

export function registerImageTools(server: McpServer, ctx: Context): void {
  // ---- generate_image ----
  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate ONE photograph with Gemini, falling back to Grok. Pass `prompt` as the SUBJECT ONLY — what is happening and where; the photographic style is applied for you. Writes the file under the runs directory, named for the format the provider actually returned, and reports its path, pixel dimensions and mime. Do NOT read the file back to check it — the dimensions and format in this result are read from the image bytes. To make several images for one article, use generate_images instead: it is one call rather than one per image.',
      inputSchema: imageSpecShape,
    },
    handler('generate_image', async (a: ImageSpec) => {
      requireSetup(ctx, 'images');
      return ok(await generateOne(ctx, a));
    }),
  );

  // ---- generate_images ----
  //
  // An article needs a hero and at least one in-body image, and often a gallery
  // — four images meant four generate_image calls, four reads to check them,
  // and four uploads. The batch pair collapses that to two calls.
  server.registerTool(
    'generate_images',
    {
      title: 'Generate images (batch)',
      description:
        'Generate SEVERAL photographs in one call — the normal way to illustrate an article, which needs a hero and at least one in-body image. Same rules as generate_image: `prompt` is the SUBJECT ONLY, and pass the same `look` to every image in an article so they match. ' +
        'One image failing does NOT fail the batch: each result carries ok:true with its path, dimensions and mime, or ok:false with the error naming the provider and why. Check every entry. A prompt refused on safety grounds is reported per image and can be reworded and re-run on its own. ' +
        'The files are written under the runs directory; do not read them back to verify them — the dimensions and format come from the bytes.',
      inputSchema: {
        images: z
          .array(z.object(imageSpecShape))
          .min(1)
          .max(8)
          .describe('One entry per image. Give each a distinct `slot` so the files are told apart.'),
      },
    },
    handler('generate_images', async (a: { images: ImageSpec[] }) => {
      requireSetup(ctx, 'images');
      const results = await pooled(a.images, BATCH_CONCURRENCY, async (spec) => {
        try {
          return { ok: true as const, ...(await generateOne(ctx, spec)) };
        } catch (e) {
          // Per-image failure, never a silent drop and never a dead batch: the
          // error names the failing API and its code, exactly as the single
          // tool would have reported it.
          const err =
            e instanceof ToolError
              ? { api: e.api, code: e.code, message: e.message }
              : { api: 'images', code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) };
          return { ok: false as const, slot: spec.slot, error: err };
        }
      });
      const failed = results.filter((r) => !r.ok).length;
      return ok({
        images: results,
        generated: results.length - failed,
        failed,
        ...(failed > 0
          ? {
              note: `${failed} of ${results.length} image(s) failed. The rest succeeded and their paths are usable. Reword and retry only the failed slots.`,
            }
          : {}),
      });
    }),
  );

  // ---- upload_image ----
  server.registerTool(
    'upload_image',
    {
      title: 'Upload image',
      description:
        "Upload ONE local image to a site's media store and return the hosted URL. To upload several, use upload_images — one call instead of one per file.",
      inputSchema: {
        site: z.string(),
        path: z.string().describe('Local path returned by generate_image'),
        alt: z.string().optional(),
      },
    },
    handler('upload_image', async (a: { site: string; path: string; alt?: string }) => {
      requireSetup(ctx, 'sites');
      return ok(await uploadOne(ctx, a.site, a.path, a.alt));
    }),
  );

  // ---- upload_images ----
  server.registerTool(
    'upload_images',
    {
      title: 'Upload images (batch)',
      description:
        "Upload SEVERAL local images to one site's media store in a single call — the companion to generate_images. Each result carries ok:true with the hosted url and native id, or ok:false with the error naming the failing API. One failure does not abort the rest.",
      inputSchema: {
        site: z.string(),
        images: z
          .array(
            z.object({
              path: z.string().describe('Local path returned by generate_image or generate_images'),
              alt: z.string().optional(),
            }),
          )
          .min(1)
          .max(12),
      },
    },
    handler(
      'upload_images',
      async (a: { site: string; images: Array<{ path: string; alt?: string }> }) => {
        requireSetup(ctx, 'sites');
        // Sequential on purpose. These are multipart uploads to one blog's
        // media endpoint, where the round trips are already amortised by the
        // single call, and hammering a shared WordPress or Ghost install with
        // parallel writes buys little and risks a 429 mid-article.
        const results: Array<Record<string, unknown>> = [];
        for (const img of a.images) {
          try {
            results.push({ ok: true, ...(await uploadOne(ctx, a.site, img.path, img.alt)) });
          } catch (e) {
            const err =
              e instanceof ToolError
                ? { api: e.api, code: e.code, message: e.message }
                : { api: 'upload_images', code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) };
            results.push({ ok: false, path: img.path, error: err });
          }
        }
        const failed = results.filter((r) => r.ok !== true).length;
        return ok({ images: results, uploaded: results.length - failed, failed });
      },
    ),
  );
}

/**
 * Read one local image and push it to a site's media store.
 *
 * Shared by the single and batch upload tools. The `alt` is passed through to
 * the adapter, which is the only place that knows whether the platform stores
 * it on the media object or ignores it.
 */
async function uploadOne(
  ctx: Context,
  site: string,
  path: string,
  alt: string | undefined,
): Promise<Record<string, unknown>> {
  let file: Buffer;
  try {
    file = readFileSync(path);
  } catch {
    throw new ToolError({
      api: 'upload_image',
      code: 'FILE_NOT_FOUND',
      message: `Cannot read image at ${path}`,
      hint: 'Use the path returned by generate_image or generate_images',
    });
  }
  const uploaded = await adapterFor(ctx, site).uploadImage(file, basename(path), alt);
  return { path, ...uploaded };
}
