// src/tools/image-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError, ok } from '../errors.js';
import { composeImagePrompt, type ImageStyle } from '../craft/image-style.js';
import { AllProvidersFailed, generateImage } from '../plugins/images/index.js';
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

export function registerImageTools(server: McpServer, ctx: Context): void {
  // ---- generate_image ----
  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate a photograph with Gemini, falling back to Grok. Pass `prompt` as the SUBJECT ONLY — what is happening and where; the photographic style is applied for you. Writes a PNG under the runs directory and returns its path plus which provider produced it.',
      inputSchema: {
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
            "The camera register from build_writing_brief's IMAGES block, passed verbatim so every image in one article matches. Omitted, one is derived from the prompt.",
          ),
        provider: z
          .enum(['gemini', 'grok'])
          .optional()
          .describe('Pin a provider; disables fallback'),
      },
    },
    handler(
      'generate_image',
      async (a: {
        prompt: string;
        slot: string;
        aspect: '16:9' | '4:3' | '1:1';
        style: ImageStyle;
        look?: string;
        provider?: 'gemini' | 'grok';
      }) => {
        requireSetup(ctx, 'images');
        const opts = {
          aspect: a.aspect,
          ...(a.provider ? { provider: a.provider } : {}),
        };

        let img: Awaited<ReturnType<typeof generateImage>>;
        let peopleDropped: string | undefined;

        try {
          img = await generateImage(composeImagePrompt(a.style, a.prompt, a.look), opts);
        } catch (e) {
          // Retry WITHOUT people only when every provider actually refused.
          //
          // A 401, an exhausted quota, or a dead socket is not a refusal, and
          // treating it as one would silently drop the people requirement
          // because the network blipped — the article would publish looking
          // fine, with nobody in the picture and nobody told why.
          if (!(a.style === 'photoreal_people' && e instanceof AllProvidersFailed && refusedOnSafety(e))) {
            throw e;
          }
          peopleDropped = e.failures
            .filter((f) => f.code === 'SAFETY')
            .map((f) => `${f.provider}: ${f.message}`)
            .join('; ');
          img = await generateImage(composeImagePrompt('photoreal_scene', a.prompt, a.look), opts);
        }

        mkdirSync(ctx.runsDir, { recursive: true });
        const path = join(ctx.runsDir, `${Date.now()}-${basename(a.slot)}.png`);
        writeFileSync(path, img.data);
        return ok({
          path,
          bytes: img.data.length,
          provider: img.provider,
          fallback_used: img.fallbackUsed,
          ...(img.fallbackReason ? { fallback_reason: img.fallbackReason } : {}),
          ...(peopleDropped
            ? {
                people_dropped: true,
                people_dropped_reason: `Every provider refused a prompt asking for people, so this image has none. ${peopleDropped}`,
              }
            : {}),
        });
      },
    ),
  );

  // ---- upload_image ----
  server.registerTool(
    'upload_image',
    {
      title: 'Upload image',
      description: "Upload a local image to a site's media store and return the hosted URL.",
      inputSchema: {
        site: z.string(),
        path: z.string().describe('Local path returned by generate_image'),
        alt: z.string().optional(),
      },
    },
    handler('upload_image', async (a: { site: string; path: string; alt?: string }) => {
      requireSetup(ctx, 'sites');
      let file: Buffer;
      try {
        file = readFileSync(a.path);
      } catch {
        throw new ToolError({
          api: 'upload_image',
          code: 'FILE_NOT_FOUND',
          message: `Cannot read image at ${a.path}`,
          hint: 'Use the path returned by generate_image',
        });
      }
      return ok(await adapterFor(ctx, a.site).uploadImage(file, basename(a.path), a.alt));
    }),
  );
}
