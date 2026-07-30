// src/tools/craft-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPersona } from '../config/personas.js';
import { getSite, usableSites } from '../config/sites.js';
import type { Context } from '../context.js';
import { buildBrief } from '../craft/brief.js';
import type { HtmlProfile } from '../craft/html-profile.js';
import { scoreDraft, type FeatureImageInput } from '../craft/score.js';
import { ToolError, ok } from '../errors.js';
import { getPlugin, makeAdapter } from '../plugins/registry.js';
import { requireSetup } from '../setup.js';
import { handler } from './shared.js';

/**
 * The HTML profile for the site being written for.
 *
 * Defaults to the configured default site: the overwhelmingly common case is a
 * single blog, and making every caller name it would be noise. When no site is
 * resolvable the caller gets a SETUP_INCOMPLETE naming the fix, not a guess —
 * scoring against the wrong platform's rules is worse than refusing.
 *
 * The bare fallback (no explicit `slug`, no `default_site`) must be a USABLE
 * site, not just the first one declared — `requireSetup` only guarantees SOME
 * site works, and an unlucky ordering (the broken site declared first) must not
 * refuse scoring when a working site is right there.
 */
async function profileFor(ctx: Context, slug?: string): Promise<HtmlProfile> {
  requireSetup(ctx, 'sites');
  const target = slug ?? ctx.sites.defaultSite ?? usableSites(ctx.sites)[0]!;
  const site = getSite(ctx.sites, target);
  return getPlugin(site.platform).htmlProfile(makeAdapter(site));
}

export function registerCraftTools(server: McpServer, ctx: Context): void {
  // ---- build_writing_brief ----
  server.registerTool(
    'build_writing_brief',
    {
      title: 'Build writing brief',
      description:
        'Build a randomized, persona-specific writing brief covering voice, structure, visual blocks, AEO and GEO. ' +
        'RESEARCH IS MANDATORY IN NEWS MODE: run the /last30days skill FIRST and pass its findings as `research`. ' +
        'Do not summarise the topic from your own knowledge — the model cutoff cannot know the last 30 days, and ' +
        'an article built on recalled facts will carry stale or invented figures. This tool rejects news mode ' +
        'without research for that reason. Returns the seed so a brief can be reproduced.',
      inputSchema: {
        persona: z.string(),
        topic: z.string(),
        mode: z.enum(['blog', 'news']).default('blog'),
        research: z.string().optional().describe('Research findings to ground the article in'),
        word_count: z.number().int().min(300).max(5000).optional(),
        language: z.string().optional(),
        seed: z.number().int().optional(),
        site: z
          .string()
          .optional()
          .describe(
            'Which site this is written for — its platform decides the HTML rules. Defaults to the default site.',
          ),
      },
    },
    handler(
      'build_writing_brief',
      async (a: {
        persona: string;
        topic: string;
        mode: 'blog' | 'news';
        research?: string;
        word_count?: number;
        language?: string;
        seed?: number;
        site?: string;
      }) => {
        requireSetup(ctx, 'personas');
        // News mode without research produces an article built from training data,
        // which by definition cannot cover the last 30 days. Fail loudly rather
        // than quietly emitting a brief that invites invented figures.
        if (a.mode === 'news' && !a.research?.trim()) {
          throw new ToolError({
            api: 'build_writing_brief',
            code: 'RESEARCH_REQUIRED',
            message:
              'News mode requires research. Run the /last30days skill on this topic and pass its findings as `research`.',
            hint: 'For an evergreen piece that does not depend on recent events, use mode: "blog" instead.',
          });
        }
        const profile = await profileFor(ctx, a.site);
        return ok(
          buildBrief({
            persona: getPersona(ctx.personas, a.persona),
            topic: a.topic,
            mode: a.mode,
            profile,
            ...(a.research !== undefined ? { research: a.research } : {}),
            ...(a.word_count !== undefined ? { wordCount: a.word_count } : {}),
            ...(a.language !== undefined ? { language: a.language } : {}),
            ...(a.seed !== undefined ? { seed: a.seed } : {}),
          }),
        );
      },
    ),
  );

  // ---- score_draft ----
  server.registerTool(
    'score_draft',
    {
      title: 'Score draft',
      description:
        'Mechanically score a draft for human-voice quality: burstiness, AI-tell phrasing, paragraph uniformity, evidence density, first-hand experience, and target-platform HTML validity. Verdict blocked means fix before publishing. No external API is called.',
      inputSchema: {
        html: z.string(),
        site: z
          .string()
          .optional()
          .describe(
            'Which site this is written for — its platform decides the HTML rules. Defaults to the default site.',
          ),
        feature_image: z
          .object({
            url: z.string().optional(),
            alt: z.string().optional(),
            title: z.string().optional().describe('The article title, only used to catch alt text copied from it'),
          })
          .optional()
          .describe(
            'The feature image, which lives outside the HTML and is otherwise invisible to this tool. Omit it before the image exists; the check reports "not evaluated" rather than failing.',
          ),
      },
    },
    handler(
      'score_draft',
      async (a: { html: string; site?: string; feature_image?: FeatureImageInput }) => {
        const profile = await profileFor(ctx, a.site);
        return ok(scoreDraft(a.html, profile, a.feature_image));
      },
    ),
  );
}
