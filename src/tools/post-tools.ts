// src/tools/post-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPersona } from '../config/personas.js';
import { getSite } from '../config/sites.js';
import type { Context } from '../context.js';
import { buildArticleSchema } from '../craft/schema.js';
import { hasInlineImage } from '../craft/score.js';
import { ToolError, ok } from '../errors.js';
import { getPlugin, makeAdapter } from '../plugins/registry.js';
import { extractImgSrcs, promoteUsedMedia } from './media-tools.js';
import {
  MIN_SCHEDULE_LEAD_MS,
  cachedTimezone,
  needsSiteTimezone,
  resolveTiming,
  type PostStatus,
  type ResolvedTiming,
} from '../plugins/platforms/schedule.js';
import type { PlatformAdapter } from '../plugins/platforms/types.js';
import { requireSetup } from '../setup.js';
import { adapterFor, handler } from './shared.js';

/**
 * The `publish_at` rules, in the words the host model reads.
 *
 * Shared by both tool descriptions, and it interpolates
 * `MIN_SCHEDULE_LEAD_MS` rather than restating it in prose. Two
 * hand-maintained copies of one number drift — `SLUG_PATTERN` and
 * `IMAGE_LOOKS` both proved that in code — and a description that promises a
 * floor the guard no longer enforces is worse than a vague one: the model
 * repeats it to the user as fact.
 */
const PUBLISH_AT_RULES =
  'a date and a time of day — "2026-08-04T10:00". ' +
  '**It is read in the TARGET BLOG\'S OWN timezone, never yours and never the user\'s.** ' +
  'So "publish at 10am tomorrow" is simply "2026-08-04T10:00": pass the wall-clock time the user said, ' +
  'verbatim. Do NOT convert it to UTC, do NOT convert it to your own timezone, and do NOT ask the user which ' +
  'timezone they mean — the blog decides, and Byline looks its timezone up from the platform. The same string ' +
  'sent to two blogs in two countries is two different instants, on purpose. ' +
  'An explicit offset ("2026-08-04T10:00:00+05:30" or "...Z") is also accepted and is then taken at face ' +
  'value, but only use one if the user actually named a timezone. ' +
  `Required with status "scheduled", where it must be at least ${MIN_SCHEDULE_LEAD_MS / 60_000} minutes in ` +
  'the future. With status "published" it must be in the PAST — that backdates the post; a future time with ' +
  'status "published" is refused, because Ghost would publish it immediately while WordPress would schedule ' +
  'it. The result reports publish_at_local, the time as the blog\'s own clock reads it — tell the user that ' +
  'one, not the UTC value.';

/**
 * Resolve `status` + `publish_at` for a specific blog, fetching that blog's
 * timezone only when the answer actually depends on it.
 *
 * The lookup is a network round trip, so it is skipped entirely when there is
 * no time to resolve, or when the caller already wrote an explicit offset and
 * has therefore already said which instant they meant. When it is needed it
 * goes through `cachedTimezone`, so a blog's timezone is fetched once per
 * process rather than once per post.
 *
 * A failed lookup is deliberately NOT swallowed into a UTC default. Assuming
 * UTC for a blog in Kolkata publishes five and a half hours early while
 * reporting success — the silent-wrong-result this whole module exists to
 * avoid. The error names the blog and says to pass an explicit offset instead.
 */
async function resolveTimingFor(
  adapter: PlatformAdapter,
  status: PostStatus,
  publishAt: string | undefined,
): Promise<ResolvedTiming> {
  const needsZone = publishAt !== undefined && needsSiteTimezone(publishAt);
  const zone = needsZone
    ? await cachedTimezone(`${adapter.platform}:${adapter.slug}`, () => adapter.siteTimezone())
    : undefined;
  return resolveTiming(status, publishAt, zone);
}

export function registerPostTools(server: McpServer, ctx: Context): void {
  // ---- create_post ----
  server.registerTool(
    'create_post',
    {
      title: 'Create post',
      description:
        'Publish an article. Defaults to status "published" — pass "draft" only when the user asked for a draft, or "scheduled" with publish_at to go live at a set time. The author accepts a persona slug and resolves to that site\'s author id. HTML must not still contain [[content_image]]. Every article gets a hero (feature_image) and an inline <img> by default when an image provider is configured — refused otherwise; pass images: "hero" | "inline" | "none" to opt out.',
      inputSchema: {
        site: z.string(),
        title: z.string().min(1),
        html: z.string().min(1),
        status: z
          .enum(['published', 'draft', 'scheduled'])
          .default('published')
          .describe(
            '"published" goes live now, "draft" is not visible, "scheduled" goes live at publish_at (which is then required).',
          ),
        publish_at: z
          .string()
          .optional()
          .describe(`When the post should be published, as ${PUBLISH_AT_RULES}`),
        images: z
          .enum(['both', 'hero', 'inline', 'none'])
          .default('both')
          .describe(
            'Which of the hero image (feature_image) and the in-body <img> are required before publishing. Only enforced when an image provider is configured; pass "none" if this article genuinely has no image.',
          ),

        slug: z
          .string()
          .optional()
          .describe(
            'The URL path segment, e.g. "legacy-modernisation-gulf". Omit it and the platform generates one from the full title, which turns a long headline into a long URL that cannot be changed through this API afterwards. Set it deliberately for anything that will be shared or indexed. The platform normalises what it is given and appends a counter on a collision, so the result warns if the stored slug differs from the one sent.',
          ),
        custom_excerpt: z.string().max(300).optional().describe('Shown in listings and feeds'),
        meta_title: z.string().optional().describe('SEO title; defaults to title'),
        meta_description: z.string().optional(),
        canonical_url: z.string().optional(),

        feature_image: z.string().optional().describe('URL from upload_image'),
        feature_image_id: z
          .string()
          .optional()
          .describe(
            "The native id upload_image returned alongside the url (its `id` field), needed by platforms that reference media by id rather than URL — e.g. WordPress's featured_media. Ghost has no such field and ignores this.",
          ),
        feature_image_alt: z.string().optional(),
        feature_image_caption: z.string().optional(),

        og_title: z.string().optional().describe('Facebook/LinkedIn card title'),
        og_description: z.string().optional(),
        og_image: z.string().optional().describe('Defaults to feature_image'),

        twitter_title: z.string().optional().describe('X card title'),
        twitter_description: z.string().optional(),
        twitter_image: z.string().optional().describe('Defaults to feature_image'),

        faq: z
          .array(z.object({ question: z.string(), answer: z.string() }))
          .optional()
          .describe('Builds FAQPage JSON-LD. Must match the visible FAQ section exactly.'),
        keywords: z.array(z.string()).optional().describe('Feeds Article JSON-LD'),
        schema: z
          .boolean()
          .default(true)
          .describe('Inject Article (+FAQPage) JSON-LD into the page head for AEO/GEO'),

        tags: z.array(z.string()).optional(),
        author: z
          .string()
          .optional()
          .describe(
            "Byline. Either a persona slug (resolved to that site's author id) or a raw platform-native author id, to attribute the post to someone with no persona file — the id's format is specific to the target site's platform and is not the same across every site. Omit to use the site default_author. Run list_authors against the target site to find its ids.",
          ),
      },
    },
    handler(
      'create_post',
      async (a: {
        site: string;
        title: string;
        html: string;
        status: PostStatus;
        publish_at?: string;
        images: 'both' | 'hero' | 'inline' | 'none';
        slug?: string;
        custom_excerpt?: string;
        meta_title?: string;
        meta_description?: string;
        canonical_url?: string;
        feature_image?: string;
        feature_image_id?: string;
        feature_image_alt?: string;
        feature_image_caption?: string;
        og_title?: string;
        og_description?: string;
        og_image?: string;
        twitter_title?: string;
        twitter_description?: string;
        twitter_image?: string;
        faq?: Array<{ question: string; answer: string }>;
        keywords?: string[];
        schema: boolean;
        tags?: string[];
        author?: string;
      }) => {
        requireSetup(ctx, 'sites');
        const site = getSite(ctx.sites, a.site);
        const adapter = makeAdapter(site);

        // Resolved BEFORE anything is uploaded, resolved, or written: a
        // publish time this pair of platforms cannot agree on is refused at
        // the door rather than after a post exists somewhere. `timing.status`
        // is what the adapter is given, so the tool layer never decides what
        // "scheduled" means on a particular platform — see schedule.ts.
        //
        // The adapter is passed in because a wall-clock time means whatever
        // THIS blog's clock says, and only the adapter can ask the platform
        // what that is.
        const timing = await resolveTimingFor(adapter, a.status, a.publish_at);

        const requested = a.author ?? site.defaultAuthor;
        let authors: string[] | undefined;
        let persona: ReturnType<typeof getPersona> | undefined;
        const localWarnings: string[] = [];

        if (requested && getPlugin(site.platform).isAuthorId(requested)) {
          // A raw author id: byline someone who has no persona file.
          authors = [requested];
        } else if (requested) {
          persona = getPersona(ctx.personas, requested);
          const id = persona.platform_authors[a.site];
          if (id) {
            authors = [id];
          } else {
            // Omitting authors makes Ghost attribute the post to the integration's
            // owner, so it publishes under the wrong name with no other signal.
            localWarnings.push(
              `Persona "${requested}" has no author id for site "${a.site}", so ${getPlugin(site.platform).label} attributed this post to the integration's default author. Add "${a.site}: <author id>" under platform_authors in personas/${requested}.yaml, or pass a raw author id as "author". Run list_authors to find ids.`,
            );
          }
        }

        // Every article gets a hero image and an inline image unless the caller
        // explicitly says otherwise (images: "hero" | "inline" | "none") — the
        // product's stated default. Previously this was only a non-blocking
        // nudge an agent could read, get, and still ignore; a post shipped with
        // no hero image and a stock photo in place of a generated inline image
        // while the agent recorded the nudge as "expected". Only enforced when
        // an image provider is actually configured: with none, the caller
        // cannot comply, and refusing would make create_post unusable for
        // anyone without an image key — images are optional in this product,
        // the default is not.
        if (ctx.setup.imageProviders.length > 0) {
          const needsHero = a.images === 'both' || a.images === 'hero';
          const needsInline = a.images === 'both' || a.images === 'inline';
          const missingHero = needsHero && !a.feature_image;
          const missingInline = needsInline && !hasInlineImage(a.html);
          const optOutHint =
            'Call generate_image, then upload_image, then pass the result as feature_image (hero) and/or embed it as an <img src="..."> in html (inline). If this article genuinely needs no image, pass images: "none"; to keep just one, pass images: "hero" or images: "inline".';
          if (missingHero && missingInline) {
            throw new ToolError({
              api: 'create_post',
              code: 'IMAGES_REQUIRED',
              message:
                'Refusing to publish: no feature_image was set and html has no inline <img> — this article has neither a hero image nor an inline image.',
              hint: optOutHint,
            });
          } else if (missingHero) {
            throw new ToolError({
              api: 'create_post',
              code: 'HERO_IMAGE_REQUIRED',
              message: `Refusing to publish: no feature_image was set, and images: "${a.images}" requires a hero image.`,
              hint: optOutHint,
            });
          } else if (missingInline) {
            throw new ToolError({
              api: 'create_post',
              code: 'INLINE_IMAGE_REQUIRED',
              message: `Refusing to publish: html has no inline <img ...src="...">, and images: "${a.images}" requires an inline image.`,
              hint: optOutHint,
            });
          }
        }

        // Social cards fall back to the feature image rather than shipping blank.
        const ogImage = a.og_image ?? a.feature_image;
        const twitterImage = a.twitter_image ?? a.feature_image;

        const codeinjection = a.schema
          ? buildArticleSchema({
              title: a.title,
              description: a.meta_description ?? a.custom_excerpt ?? '',
              ...(a.canonical_url ? { url: a.canonical_url } : {}),
              ...(a.feature_image ? { imageUrl: a.feature_image } : {}),
              authorName: persona?.name ?? 'Editorial team',
              ...(persona?.role ? { authorRole: persona.role } : {}),
              publisherName: new URL(site.url).hostname,
              publisherUrl: site.url,
              ...(a.faq?.length ? { faq: a.faq } : {}),
              ...(a.keywords?.length ? { keywords: a.keywords } : {}),
            })
          : undefined;

        const result = await adapter.createPost({
          title: a.title,
          html: a.html,
          status: timing.status,
          ...(timing.publishAtIso !== undefined ? { publish_at: timing.publishAtIso } : {}),
          ...(a.slug !== undefined ? { slug: a.slug } : {}),
          ...(a.custom_excerpt !== undefined ? { custom_excerpt: a.custom_excerpt } : {}),
          ...(a.meta_title !== undefined ? { meta_title: a.meta_title } : {}),
          ...(a.meta_description !== undefined ? { meta_description: a.meta_description } : {}),
          ...(a.canonical_url !== undefined ? { canonical_url: a.canonical_url } : {}),
          ...(a.feature_image !== undefined ? { feature_image: a.feature_image } : {}),
          ...(a.feature_image_id !== undefined ? { feature_image_id: a.feature_image_id } : {}),
          ...(a.feature_image_alt !== undefined ? { feature_image_alt: a.feature_image_alt } : {}),
          ...(a.feature_image_caption !== undefined
            ? { feature_image_caption: a.feature_image_caption }
            : {}),
          ...(a.og_title !== undefined ? { og_title: a.og_title } : {}),
          ...(a.og_description !== undefined ? { og_description: a.og_description } : {}),
          ...(ogImage !== undefined ? { og_image: ogImage } : {}),
          ...(a.twitter_title !== undefined ? { twitter_title: a.twitter_title } : {}),
          ...(a.twitter_description !== undefined
            ? { twitter_description: a.twitter_description }
            : {}),
          ...(twitterImage !== undefined ? { twitter_image: twitterImage } : {}),
          ...(codeinjection ? { codeinjection_head: codeinjection } : {}),
          ...(a.tags !== undefined ? { tags: a.tags } : {}),
          ...(authors ? { authors } : {}),
        });

        // The non-blocking "no feature_image" nudge that used to live here is
        // gone: it is now either redundant (the images-required check above
        // already refused the request before this line was ever reached) or
        // actively wrong (the caller explicitly opted out via images: "inline"
        // or "none", and nudging them back toward a hero image would
        // contradict their own instruction). One rule, one definition — the
        // enforcement block above is the only place this default is stated.
        const warnings = [...localWarnings, ...(result.warnings ?? [])];
        // Derived from what actually happened, not from whether the JSON-LD was
        // BUILT. WordPress core cannot accept codeinjection_head at all — its
        // adapter reports that as a warning naming the field
        // (unsupportedFieldWarnings in wordpress/index.ts), the same mechanism
        // Ghost uses when it silently drops a field it was sent
        // (droppedFields). Checking for that warning is what turns "we tried to
        // inject it" into "the platform actually stored it" — reporting the
        // former as if it were the latter is exactly the silent-wrong-result
        // class AEO/GEO cannot afford to join.
        const schemaInjected =
          Boolean(codeinjection) && !warnings.some((w) => w.includes('codeinjection_head'));

        // Confirm any library assets this post really published. The hosted URL
        // is what appears in the stored HTML, so this records what the platform
        // kept rather than what the caller intended it to keep.
        const referenced = [
          ...(a.feature_image ? [a.feature_image] : []),
          ...extractImgSrcs(a.html),
        ];
        const promotion = promoteUsedMedia(ctx, referenced, result.url);
        warnings.push(...promotion.problems);

        return ok({
          ...result,
          // The time the caller actually asked for, in the blog's own words.
          // `publish_at` is UTC because that is what the platform stores; a
          // user who said "10am tomorrow" should be told "10am tomorrow", not
          // handed an instant they have to convert back themselves.
          ...(timing.publishAtLocal !== undefined
            ? { publish_at_local: timing.publishAtLocal }
            : {}),
          schema_injected: schemaInjected,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      },
    ),
  );

  // ---- update_post ----
  server.registerTool(
    'update_post',
    {
      title: 'Update post',
      description:
        'Edit an existing post in place. Only the fields you pass are changed. Also the way to schedule an existing draft (status "scheduled" plus publish_at), to unschedule one (status "draft"), or to correct a post\'s date (publish_at in the past).',
      inputSchema: {
        site: z.string(),
        post_id: z.string(),
        title: z.string().optional(),
        html: z.string().optional(),
        slug: z
          .string()
          .optional()
          .describe(
            'Change the URL path segment. This CHANGES THE POST\'S URL — anything already linking to the old one breaks unless the platform redirects. The result warns if the platform stored a different slug than the one sent.',
          ),
        status: z.enum(['published', 'draft', 'scheduled']).optional(),
        publish_at: z
          .string()
          .optional()
          .describe(
            `${PUBLISH_AT_RULES} Note that Ghost refuses to move an already-published post back to "scheduled" (it answers "Your post is already published"); set it to "draft" first.`,
          ),
        custom_excerpt: z.string().max(300).optional(),
        meta_title: z.string().optional(),
        meta_description: z.string().optional(),
        canonical_url: z.string().optional(),
        feature_image: z.string().optional(),
        feature_image_id: z
          .string()
          .optional()
          .describe(
            "The native id upload_image returned alongside the url, needed by platforms that reference media by id rather than URL — e.g. WordPress's featured_media. Ghost has no such field and ignores this.",
          ),
        feature_image_alt: z.string().optional(),
        feature_image_caption: z.string().optional(),
        og_title: z.string().optional(),
        og_description: z.string().optional(),
        og_image: z.string().optional(),
        twitter_title: z.string().optional(),
        twitter_description: z.string().optional(),
        twitter_image: z.string().optional(),
        codeinjection_head: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler(
      'update_post',
      async (
        a: Record<string, unknown> & {
          site: string;
          post_id: string;
          status?: PostStatus;
          publish_at?: string;
        },
      ) => {
        requireSetup(ctx, 'sites');
        const { site, post_id, ...patch } = a;

        // A publish time with no status is the one combination that cannot be
        // resolved here, because what it means depends on the status the post
        // ALREADY has — measured 2026-08-03, the same `publish_at` alone
        // backdates a published post and does nothing visible to a draft. The
        // alternative to refusing is fetching the post first and inferring the
        // caller's intent from its current state, which is a guess dressed up
        // as a lookup. Ask for the status instead.
        if (a.publish_at !== undefined && a.status === undefined) {
          throw new ToolError({
            api: 'update_post',
            code: 'PUBLISH_AT_NEEDS_STATUS',
            message: 'publish_at was given with no status, so what it should do is ambiguous.',
            hint: 'Pass status too: "scheduled" to publish at that time, or "published" to backdate an already-live post to it.',
          });
        }
        // Same guard as create_post, from the same function — a scheduled time
        // that create_post refuses must not become reachable by updating a
        // draft instead.
        const adapter = adapterFor(ctx, site);
        const timing =
          a.status !== undefined
            ? await resolveTimingFor(adapter, a.status, a.publish_at)
            : undefined;

        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (timing) {
          clean.status = timing.status;
          if (timing.publishAtIso !== undefined) clean.publish_at = timing.publishAtIso;
        }
        const result = await adapter.updatePost(post_id, clean);

        // Same confirmation as create_post, applied to whatever this patch
        // actually touched. update_post takes a partial patch, so both fields
        // are guarded rather than assumed present.
        const referenced = [
          ...(typeof a.feature_image === 'string' ? [a.feature_image] : []),
          ...(typeof a.html === 'string' ? extractImgSrcs(a.html) : []),
        ];
        const promotion = promoteUsedMedia(ctx, referenced, result.url);
        const warnings = [...(result.warnings ?? []), ...promotion.problems];

        return ok({
          ...result,
          ...(timing?.publishAtLocal !== undefined
            ? { publish_at_local: timing.publishAtLocal }
            : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      },
    ),
  );
}
