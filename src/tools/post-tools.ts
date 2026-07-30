// src/tools/post-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPersona } from '../config/personas.js';
import { getSite } from '../config/sites.js';
import type { Context } from '../context.js';
import { buildArticleSchema } from '../craft/schema.js';
import { ok } from '../errors.js';
import { getPlugin, makeAdapter } from '../plugins/registry.js';
import { requireSetup } from '../setup.js';
import { adapterFor, handler } from './shared.js';

export function registerPostTools(server: McpServer, ctx: Context): void {
  // ---- create_post ----
  server.registerTool(
    'create_post',
    {
      title: 'Create post',
      description:
        'Publish an article. Defaults to status "published" — pass "draft" only when the user asked for a draft. The author accepts a persona slug and resolves to that site\'s author id. HTML must not still contain [[content_image]].',
      inputSchema: {
        site: z.string(),
        title: z.string().min(1),
        html: z.string().min(1),
        status: z.enum(['published', 'draft']).default('published'),

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
        status: 'published' | 'draft';
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

        const result = await makeAdapter(site).createPost({
          title: a.title,
          html: a.html,
          status: a.status,
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

        // Images are the default the moment a provider key exists — the
        // writing brief instructs generate_image + upload_image for exactly
        // this reason. Nothing here can FORCE the calling agent to do that;
        // an MCP server only ever responds to tool calls, it cannot demand
        // one. This is the observable half of the fix: a post that reaches
        // create_post with a working image key configured and no
        // feature_image gets a named, non-blocking nudge instead of shipping
        // with no signal that a default was skipped. Appended AFTER the
        // platform's own warnings, never mixed into `localWarnings` above,
        // so it can never shift the index of a warning about something the
        // platform itself did.
        const imageNudge =
          !a.feature_image && ctx.setup.imageProviders.length > 0
            ? [
                `No feature_image was set, but an image provider (${ctx.setup.imageProviders.join(', ')}) is configured. ` +
                  'By default every article gets a hero image: call generate_image then upload_image, and pass the ' +
                  'result as feature_image — unless the user explicitly asked to skip images or supplied their own.',
              ]
            : [];
        const warnings = [...localWarnings, ...(result.warnings ?? []), ...imageNudge];
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
        return ok({
          ...result,
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
      description: 'Edit an existing post in place. Only the fields you pass are changed.',
      inputSchema: {
        site: z.string(),
        post_id: z.string(),
        title: z.string().optional(),
        html: z.string().optional(),
        status: z.enum(['published', 'draft']).optional(),
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
      async (a: Record<string, unknown> & { site: string; post_id: string }) => {
        requireSetup(ctx, 'sites');
        const { site, post_id, ...patch } = a;
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        return ok(await adapterFor(ctx, site).updatePost(post_id, clean));
      },
    ),
  );
}
