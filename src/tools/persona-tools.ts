// src/tools/persona-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPersona } from '../config/personas.js';
import type { Context } from '../context.js';
import { ok } from '../errors.js';
import { requireSetup } from '../setup.js';
import { adapterFor, handler } from './shared.js';

export function registerPersonaTools(server: McpServer, ctx: Context): void {
  // ---- list_authors ----
  server.registerTool(
    'list_authors',
    {
      title: 'List authors',
      description:
        "List the author accounts on a site, with their platform ids. Pass an id as create_post's `author` to byline someone who has no persona file, or copy it into a persona's platform_authors.",
      inputSchema: { site: z.string() },
    },
    handler('list_authors', async (a: { site: string }) => {
      requireSetup(ctx, 'sites');
      const authors = await adapterFor(ctx, a.site).listAuthors();
      const byId = new Map(
        [...ctx.personas.values()].flatMap((p) =>
          Object.entries(p.platform_authors)
            .filter(([s]) => s === a.site)
            .map(([, id]) => [id, p.slug] as const),
        ),
      );
      return ok({
        site: a.site,
        authors: authors.map((u) => ({
          ...u,
          persona: byId.get(u.id) ?? null,
        })),
      });
    }),
  );

  // ---- list_personas ----
  // Not gated: read-only, and useful before any site exists.
  server.registerTool(
    'list_personas',
    { title: 'List personas', description: 'List available author personas.', inputSchema: {} },
    handler('list_personas', async () =>
      ok({
        personas: [...ctx.personas.values()].map((p) => ({
          slug: p.slug,
          name: p.name,
          role: p.role,
          focus: p.beats_or_focus_areas,
          sites: Object.keys(p.platform_authors),
        })),
      }),
    ),
  );

  // ---- get_persona ----
  // Not gated: read-only, and useful before any site exists.
  server.registerTool(
    'get_persona',
    {
      title: 'Get persona',
      description: 'Full author profile — voice, style, bias, and instructions.',
      inputSchema: { slug: z.string() },
    },
    handler('get_persona', async (a: { slug: string }) =>
      ok({ persona: getPersona(ctx.personas, a.slug) }),
    ),
  );
}
