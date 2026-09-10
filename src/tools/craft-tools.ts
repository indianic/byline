// src/tools/craft-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recentArticles, recentChoices, siblings } from '../articles/ledger.js';
import { articleLedgerPath, readArticleLedger } from '../articles/store.js';
import { getPersona, type Persona } from '../config/personas.js';
import { getSite, usableSites } from '../config/sites.js';
import type { Context } from '../context.js';
import { buildBrief, type BriefInput } from '../craft/brief.js';
import type { HtmlProfile } from '../craft/html-profile.js';
import { CHECK_GUIDANCE, CHECK_NAMES, scoreDraft, type FeatureImageInput } from '../craft/score.js';
import { planSeries } from '../craft/series.js';
import { normaliseSamples, voiceFingerprint } from '../craft/voice.js';
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
 *
 * Refuses outright, with `NOT_AN_ARTICLE_PLATFORM`, when the resolved profile
 * is `kind: 'social'` (LinkedIn) — `build_writing_brief`, `plan_series` and
 * `score_draft` all call this, and none of them can honestly build or grade
 * an ARTICLE brief for a feed-post platform: an article brief for LinkedIn
 * would instruct headings, a summary block and an evidence count that a feed
 * post has no room for, while LinkedIn's own feed post is already written
 * inside the ARTICLE's brief (its LINKEDIN POST section) for whichever site
 * the article is actually published to. One check here, in the one place all
 * three tools already route through, replaces `score_draft`'s own separate
 * `kind: 'social'` check in `src/craft/score.ts` for every TOOL caller; that
 * check still exists for a direct caller of `scoreDraft()` that bypasses the
 * tool layer entirely (see its own test), so it is not deleted.
 */
async function profileFor(ctx: Context, slug?: string): Promise<{ profile: HtmlProfile; slug: string }> {
  requireSetup(ctx, 'sites');
  const target = slug ?? ctx.sites.defaultSite ?? usableSites(ctx.sites)[0]!;
  const site = getSite(ctx.sites, target);
  const profile = await getPlugin(site.platform).htmlProfile(makeAdapter(site));
  if (profile.kind === 'social') {
    throw new ToolError({
      api: 'craft',
      code: 'NOT_AN_ARTICLE_PLATFORM',
      message: `${profile.label} is a feed-post platform; Byline writes articles for it from the article's own brief.`,
      hint: 'Build the brief for the site the article is published to; its LINKEDIN POST section writes the feed post, and create_post on the LinkedIn site publishes it.',
    });
  }
  return { profile, slug: target };
}

/**
 * Other configured sites whose resolved `HtmlProfile` has `kind: 'social'` —
 * currently always LinkedIn — for the brief's LINKEDIN POST section
 * (`BriefInput.socialTargets`). Resolves every usable site's profile EXCEPT
 * the one the brief is being written for, which is skipped outright rather
 * than checked: the article's own target site is never a cross-post target
 * for its own brief, whatever kind of profile it resolves to. (In practice
 * `profileFor` already refuses a social target before this function is ever
 * called, but the exclusion holds regardless of that.) A failure resolving
 * any OTHER site is caught into `warnings` rather than failing the whole
 * brief — an unreachable second blog must not block writing the article for
 * the first one.
 */
async function socialTargets(
  ctx: Context,
  targetSlug: string,
): Promise<{ targets: Array<{ site: string; label: string }>; warnings: string[] }> {
  const targets: Array<{ site: string; label: string }> = [];
  const warnings: string[] = [];
  for (const slug of usableSites(ctx.sites)) {
    if (slug === targetSlug) continue;
    try {
      const profile = await getPlugin(getSite(ctx.sites, slug).platform).htmlProfile(
        makeAdapter(getSite(ctx.sites, slug)),
      );
      if (profile.kind === 'social') {
        targets.push({ site: slug, label: profile.label });
      }
    } catch (e) {
      warnings.push(
        `socialTargets: could not resolve site "${slug}" (${e instanceof Error ? e.message : String(e)}) — it was left out of the LINKEDIN POST section.`,
      );
    }
  }
  return { targets, warnings };
}

/**
 * A persona's ledger-derived anti-repeat history, exactly as `build_writing_brief`
 * reads it — shared with `plan_series` so both tools steer away from the same
 * recorded hooks, arcs and keywords rather than maintaining two copies of this
 * read. `series` is only meaningful for a single-article brief (surfacing
 * siblings already published under that series name); `plan_series` plans a
 * series before any of its articles exist, so it never passes one.
 */
function personaHistory(ctx: Context, persona: Persona, series?: string): NonNullable<BriefInput['history']> {
  const ledger = readArticleLedger(articleLedgerPath(ctx.paths.home, persona.slug), persona.slug);
  return {
    recent: recentArticles(ledger, 5),
    avoid: recentChoices(ledger, 3),
    ...(series ? { siblings: siblings(ledger, series) } : {}),
  };
}

export function registerCraftTools(server: McpServer, ctx: Context): void {
  // ---- plan_series ----
  server.registerTool(
    'plan_series',
    {
      title: 'Plan series',
      description:
        'Plan a series of N articles as pillar and spokes. Allocates one seed per article so no two share a hook, arc, texture or author presence, and lists what this author already published so the plan does not repeat it. Never fails to plan: when a series is longer than a dimension\'s option count, the repeats are listed per slot in `repeats`. Returns slot seeds; pass each to build_writing_brief with the series id. Byline does not invent the titles — you do, from the returned brief, and you show them to the user first.',
      inputSchema: {
        persona: z.string(),
        theme: z.string(),
        count: z.number().int().min(2).max(12),
        mode: z.enum(['blog', 'news']).default('blog'),
        site: z
          .string()
          .optional()
          .describe(
            'Which site this is written for — its platform decides which craft dimensions are available. Defaults to the default site.',
          ),
        seed: z.number().int().optional(),
      },
    },
    handler(
      'plan_series',
      async (a: {
        persona: string;
        theme: string;
        count: number;
        mode: 'blog' | 'news';
        site?: string;
        seed?: number;
      }) => {
        requireSetup(ctx, 'personas');
        const { profile } = await profileFor(ctx, a.site);
        const persona = getPersona(ctx.personas, a.persona);
        const history = personaHistory(ctx, persona);

        const plan = planSeries({
          persona,
          theme: a.theme,
          count: a.count,
          mode: a.mode,
          profile,
          history,
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
        });

        return ok(plan);
      },
    ),
  );

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
        "Also reads this persona's article ledger: recent articles are listed in the brief so it does not repeat their hook, example, or keyword, and can link back to them; pass `series` to also surface earlier articles in the same series. " +
        'Returns the seed so a brief can be reproduced (given the same ledger state — see `avoided`), plus researchOrigin and any warnings.',
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
        series: z
          .string()
          .optional()
          .describe(
            'Groups this article with others this persona has published under the same series name. When set, earlier articles recorded with the same series appear in the brief as THIS SERIES SO FAR, to link back to. Echoed unchanged in the result.',
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
        series?: string;
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

        const { profile, slug: targetSlug } = await profileFor(ctx, a.site);
        const persona = getPersona(ctx.personas, a.persona);

        // A missing ledger is a brand-new persona — empty history, nothing to
        // avoid. A CORRUPT one is surfaced as a ToolError rather than quietly
        // treated as empty: continuing would silently drop this persona's
        // memory of what it already published, letting a brief repeat a hook,
        // an example, or a keyword it should be avoiding without any signal
        // that the memory itself is broken.
        const history = personaHistory(ctx, persona, a.series);

        // Every OTHER usable site whose resolved profile is a LinkedIn-style
        // feed-post target — a per-site failure here becomes a warning
        // (merged into the result below), never a failed brief. Never
        // includes `targetSlug` itself; see `socialTargets`'s own comment.
        const social = await socialTargets(ctx, targetSlug);

        // Three explicit call sites, NOT one call with a cast past the union.
        // `as Parameters<typeof buildBrief>[0]` would typecheck unconditionally
        // and silence the union at the exact place the union exists to protect —
        // the same mistake `ImageProvider.withKey` was added to eliminate (see
        // src/plugins/images/types.ts). A conditional spread cannot narrow to a
        // discriminated union, so branch at the call instead.
        const base = {
          persona,
          topic: a.topic,
          mode: a.mode,
          profile,
          imageProviders: ctx.setup.imageProviders,
          // Same instant the guard above just checked findings against —
          // see the comment on `const now` for why this must not be a
          // second `Date.now()` call.
          now,
          history,
          ...(a.word_count !== undefined ? { wordCount: a.word_count } : {}),
          ...(a.language !== undefined ? { language: a.language } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
          ...(social.targets.length > 0 ? { socialTargets: social.targets } : {}),
        };

        const brief = a.findings
          ? buildBrief({ ...base, findings: a.findings })
          : a.research !== undefined
            ? buildBrief({ ...base, research: a.research })
            : buildBrief(base);

        // Echoed unchanged so a caller can pass it straight back into
        // create_post's `series` input and record it against this article.
        return ok({
          ...brief,
          ...(social.warnings.length > 0 ? { warnings: [...brief.warnings, ...social.warnings] } : {}),
          ...(a.series !== undefined ? { series: a.series } : {}),
        });
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
        'READ `publishable` AND `summary`, NOT the verdict alone. Only three checks can block — platform_html, structure and ai_summary_block. ' +
        'verdict "blocked" (publishable: false) means fix and re-score. ' +
        'verdict "advisory" means the draft IS publishable and the listed items are optional improvements — apply the cheap ones as inline edits if you like, but DO NOT rewrite the article and DO NOT re-score in a loop chasing them. ' +
        'verdict "pass" means everything passed. ' +
        'revision_guidance lists one edit per failing advisory check. Make those edits inline; do not rewrite the article.',
      inputSchema: {
        html: z.string(),
        persona: z
          .string()
          .optional()
          .describe(
            "Persona slug. When that persona has voice_samples, the draft's sentence rhythm is compared against them (voice_rhythm). Without it that check reports \"not evaluated\".",
          ),
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
            `Return the full detail of every check, including the ones that passed. Off by default: a passing check has nothing actionable in it, and returning all ${CHECK_NAMES.length} with their prose every call was roughly a thousand wasted tokens per score. With this off you still get every FAILING check in full, plus the names of the ones that passed.`,
          ),
      },
    },
    handler(
      'score_draft',
      async (a: {
        html: string;
        persona?: string;
        site?: string;
        feature_image?: FeatureImageInput;
        findings?: Finding[];
        mode: 'blog' | 'news';
        verbose: boolean;
      }) => {
        const { profile } = await profileFor(ctx, a.site);
        // A persona's voice_samples fingerprint their own rhythm once here,
        // rather than inside scoreDraft — scoreDraft takes the already-computed
        // fingerprint (via opts.voiceSample) so it never has to know how a
        // persona file is shaped.
        const voiceSample = a.persona
          ? (() => {
              const samples = normaliseSamples(getPersona(ctx.personas, a.persona!).extras.voice_samples);
              return samples.length > 0 ? voiceFingerprint(samples.join('\n\n')) : undefined;
            })()
          : undefined;
        const card = scoreDraft(
          a.html,
          profile,
          a.feature_image,
          a.findings,
          a.mode,
          voiceSample ? { voiceSample } : undefined,
        );

        // One edit per failing ADVISORY check, in the order `checks` lists
        // them (which follows CHECK_NAMES for a blog-mode draft, and the same
        // relative order with mode-specific names swapped in for news). Absent
        // entirely when nothing advisory failed — an empty array would still
        // read as "here is your revision list" to a host model looking for a
        // reason to keep editing.
        const advisoryFailures = card.checks.filter((c) => !c.blocking && !c.ok);
        const revisionGuidance =
          advisoryFailures.length > 0
            ? [
                'Keep every sourced claim; add no facts.',
                ...advisoryFailures.map((c) => CHECK_GUIDANCE[c.name] ?? `Address the ${c.name} finding.`),
              ]
            : undefined;

        if (a.verbose) return ok({ ...card, ...(revisionGuidance ? { revision_guidance: revisionGuidance } : {}) });
        // Kept in full: every FAILING check, because it is the only actionable
        // part, and every UNEVALUATED one, because "nothing verified this" is
        // not a pass and must never vanish into a count. Everything genuinely
        // passing collapses to its name.
        const kept = card.checks.filter((c) => !c.ok || c.evaluated === false);
        return ok({
          ...card,
          checks: kept,
          passed: card.checks.filter((c) => c.ok && c.evaluated !== false).map((c) => c.name),
          ...(revisionGuidance ? { revision_guidance: revisionGuidance } : {}),
        });
      },
    ),
  );
}
