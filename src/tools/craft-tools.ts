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
import { findingSchema, researchResultSchema } from '../plugins/research/schema.js';
import type { Finding, ResearchResult } from '../plugins/research/types.js';
import { tallyWindow } from '../plugins/research/window.js';
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
        'RESEARCH IS MANDATORY IN NEWS MODE, from exactly ONE origin: either your own findings as `research` (your web access, /last30days, or notes a human pasted — TRUSTED but not verified by Byline), ' +
        'or a research_topic result as `findings` (checked to exist, and that AT LEAST ONE finding is dated and inside the window; any that are not are marked on the brief). Passing both is refused. ' +
        'Do not summarise a recent topic from your own knowledge — the model cutoff cannot know the last 30 days, and an article built on recalled facts will carry stale or invented figures. ' +
        'If it is unclear whether a topic depends on recent events, ASK THE USER rather than guessing; an evergreen topic should use mode: "blog", which needs no research at all. ' +
        'Returns the seed so a brief can be reproduced, plus researchOrigin and any warnings.',
      inputSchema: {
        persona: z.string(),
        topic: z.string(),
        mode: z.enum(['blog', 'news']).default('blog'),
        research: z.string().optional().describe('Research findings to ground the article in'),
        findings: researchResultSchema
          .optional()
          .describe(
            'A whole research_topic result. Mutually exclusive with `research` — passing both is refused. This is the checkable origin: the findings are checked to exist, and, in news mode, at least one of them to be dated and inside the window it declares. Findings that are undated or outside that window are accepted (an article may cite background too) but marked as such on the brief.',
          ),
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
        findings?: ResearchResult;
        word_count?: number;
        language?: string;
        seed?: number;
        site?: string;
      }) => {
        requireSetup(ctx, 'personas');

        // One instant for the whole request. `tallyWindow` defaults `now` to
        // `Date.now()` when omitted, so the guard below and `buildBrief`
        // (called later, in the same request) would otherwise each capture
        // their OWN clock reading — sub-millisecond apart, but the cutoff
        // moves between them. Measured: with `publishedAt` exactly at the
        // cutoff, 2 of 500 requests had the guard accept while the brief's
        // header then reported the source OUTSIDE the window. Capturing once
        // here and threading it through both calls makes that impossible
        // rather than merely rare — the one thing this module exists to
        // guarantee.
        const now = Date.now();

        // One article, one research origin. Merging makes provenance
        // unanswerable — you could not tell which claim came from where, so
        // citation_provenance would have nothing to check against.
        if (a.research?.trim() && a.findings) {
          throw new ToolError({
            api: 'build_writing_brief',
            code: 'RESEARCH_CONFLICT',
            message:
              'Both `research` and `findings` were supplied. An article has exactly one research origin.',
            hint: 'Drop `research` to use the provider findings (checkable, dated), or drop `findings` to use your own notes.',
          });
        }

        // Mode-independent: an empty findings array is never useful research.
        // Gating this behind news mode let a blog-mode brief render
        // "GROUND THE ARTICLE IN THIS", a non-citable synthesis, and then an
        // empty "SOURCES — CITE THESE" list, while recording the article's
        // origin as "provider" with zero sources behind it.
        if (a.findings && a.findings.findings.length === 0) {
          throw new ToolError({
            api: 'build_writing_brief',
            code: 'RESEARCH_EMPTY',
            message: `${a.findings.provider} returned no findings for this topic.`,
            hint: 'Widen the window or reword the topic. If the topic does not depend on recent events, build the brief with no research at all.',
          });
        }

        if (a.mode === 'news') {
          if (a.findings) {
            // Verifiable, so actually verified — with one honest caveat: the
            // window the dates are checked against is `a.findings.window`,
            // which arrives INSIDE the caller-supplied payload. It is the
            // caller's own claim about what was requested; nothing here binds
            // it to what `research_topic` actually ran with. Existence and
            // datedness are checkable outright, the window only relative to
            // that claim.
            const tally = tallyWindow(a.findings.findings, a.findings.window, now);
            if (tally.dated === 0) {
              throw new ToolError({
                api: 'build_writing_brief',
                code: 'RESEARCH_UNDATED',
                message: `Not one of ${a.findings.findings.length} findings from ${a.findings.provider} carries a usable publication date.`,
                hint: 'News mode needs dated sources. Try the other provider, or use mode: "blog".',
              });
            }
            if (tally.inWindow === 0) {
              throw new ToolError({
                api: 'build_writing_brief',
                code: 'RESEARCH_STALE',
                message: `Every dated finding is older than the requested ${a.findings.window} window. Newest: ${tally.newest}.`,
                hint: 'The event may not be indexed yet. Widen the window, or use mode: "blog".',
              });
            }
            // At least ONE finding is in-window, which is the pass condition on
            // purpose: an article legitimately cites background alongside its
            // breaking sources. The rest are not silently promoted to fresh —
            // `buildBrief` marks every out-of-window and undated source on the
            // brief itself and warns how many there are.
          } else {
            // A hand-supplied string is NOT verifiable, and pretending
            // otherwise is what made the original guard — satisfied by any
            // non-empty string — a speed bump rather than a gate. What can
            // honestly be checked is substance. What cannot is said out loud,
            // here and in the brief and in the README.
            const supplied = a.research?.trim() ?? '';
            if (supplied.length < 200) {
              throw new ToolError({
                api: 'build_writing_brief',
                code: supplied.length === 0 ? 'RESEARCH_REQUIRED' : 'RESEARCH_THIN',
                message:
                  supplied.length === 0
                    ? 'News mode requires research. An article about recent events cannot be written from training data.'
                    : `The supplied research is ${supplied.length} characters — too thin to ground an article (200 minimum).`,
                hint: 'Either paste real notes or search output as `research` — which Byline TRUSTS but cannot verify — or call research_topic and pass its result as `findings`, which Byline does verify. For an evergreen piece, use mode: "blog".',
              });
            }
          }
        }

        const profile = await profileFor(ctx, a.site);

        // Three explicit call sites, NOT one call with a cast past the union.
        // `as Parameters<typeof buildBrief>[0]` would typecheck unconditionally
        // and silence the union at the exact place the union exists to protect —
        // the same mistake `ImageProvider.withKey` was added to eliminate (see
        // src/plugins/images/types.ts). A conditional spread cannot narrow to a
        // discriminated union, so branch at the call instead.
        const base = {
          persona: getPersona(ctx.personas, a.persona),
          topic: a.topic,
          mode: a.mode,
          profile,
          imageProviders: ctx.setup.imageProviders,
          // Same instant the guard above just checked findings against —
          // see the comment on `const now` for why this must not be a
          // second `Date.now()` call.
          now,
          ...(a.word_count !== undefined ? { wordCount: a.word_count } : {}),
          ...(a.language !== undefined ? { language: a.language } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
        };

        return ok(
          a.findings
            ? buildBrief({ ...base, findings: a.findings })
            : a.research !== undefined
              ? buildBrief({ ...base, research: a.research })
              : buildBrief(base),
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
        'Mechanically score a draft for human-voice quality: burstiness, AI-tell phrasing, paragraph uniformity, evidence density, target-platform HTML validity, and — when `findings` is passed — whether every cited URL actually came from the research. Pass `mode` matching how the draft was written: blog is scored for first-hand experience and first person, news for third-person reporter voice and attribution density instead. No external API is called. ' +
        'READ `publishable` AND `summary`, NOT the verdict alone. Only three of the thirteen checks can block. ' +
        'verdict "blocked" (publishable: false) means fix and re-score. ' +
        'verdict "advisory" means the draft IS publishable and the listed items are optional improvements — apply the cheap ones as inline edits if you like, but DO NOT rewrite the article and DO NOT re-score in a loop chasing them. ' +
        'verdict "pass" means everything passed.',
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
        findings: z
          .array(findingSchema)
          .optional()
          .describe(
            'The `findings` array from the research_topic result this draft was written from. Supplying it enables the citation_provenance check, which verifies every cited URL actually came from the research. Omit it and that check reports "not evaluated" rather than passing.',
          ),
        mode: z
          .enum(['blog', 'news'])
          .default('blog')
          .describe(
            'Must match the mode the draft was written in. News reports are judged by the OPPOSITE standard to blog posts: a blog needs first-hand experience and first person, a report forbids both and is judged on attribution density instead. Scoring a news report as a blog reports its correct third-person voice as a failure.',
          ),
        verbose: z
          .boolean()
          .default(false)
          .describe(
            'Return the full detail of every check, including the ones that passed. Off by default: a passing check has nothing actionable in it, and returning all thirteen with their prose every call was roughly a thousand wasted tokens per score. With this off you still get every FAILING check in full, plus the names of the ones that passed.',
          ),
      },
    },
    handler(
      'score_draft',
      async (a: {
        html: string;
        site?: string;
        feature_image?: FeatureImageInput;
        findings?: Finding[];
        mode: 'blog' | 'news';
        verbose: boolean;
      }) => {
        const profile = await profileFor(ctx, a.site);
        const card = scoreDraft(a.html, profile, a.feature_image, a.findings, a.mode);
        if (a.verbose) return ok(card);
        // Kept in full: every FAILING check, because it is the only actionable
        // part, and every UNEVALUATED one, because "nothing verified this" is
        // not a pass and must never vanish into a count. Everything genuinely
        // passing collapses to its name.
        const kept = card.checks.filter((c) => !c.ok || c.evaluated === false);
        return ok({
          ...card,
          checks: kept,
          passed: card.checks.filter((c) => c.ok && c.evaluated !== false).map((c) => c.name),
        });
      },
    ),
  );
}
