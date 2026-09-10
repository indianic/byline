// src/tools/persona-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { articleLedgerPath, readArticleLedger } from '../articles/store.js';
import { getPersona } from '../config/personas.js';
import type { Context } from '../context.js';
import { ToolError, fail, ok } from '../errors.js';
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
      const adapter = adapterFor(ctx, a.site);
      // Platforms whose author listing has a best-effort part (LinkedIn's
      // organisation lookup) implement `listAuthorsDetailed` to carry a
      // failure there as a warning rather than dropping it silently — see
      // `PlatformAdapter.listAuthorsDetailed`'s doc comment. Platforms with
      // nothing best-effort about the listing have no reason to implement it,
      // so this falls back to the plain `listAuthors` when it is absent.
      const { authors, warnings } = adapter.listAuthorsDetailed
        ? await adapter.listAuthorsDetailed()
        : { authors: await adapter.listAuthors(), warnings: [] };
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
        ...(warnings.length > 0 ? { warnings } : {}),
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
        personas: [...ctx.personas.values()].map((p) => {
          // A missing ledger is a persona with nothing recorded yet — 0 is
          // the honest count. A CORRUPT ledger, read here for EVERY persona,
          // must not take the whole ungated listing down with it: one
          // persona's damaged file is not a reason to hide every other
          // persona's real article count, or their name and sites, from a
          // caller. So a corrupt ledger is caught per persona and reported as
          // `articles: null` with the failure named in `articles_error` —
          // never as a fabricated 0, which would read as "nothing published"
          // when the truth is "unreadable". `build_writing_brief` still
          // throws loudly for the one persona actually being drafted for.
          let articles: number | null;
          let articles_error: string | undefined;
          try {
            articles = readArticleLedger(
              articleLedgerPath(ctx.paths.home, p.slug),
              p.slug,
            ).records.length;
          } catch (e) {
            articles = null;
            const err = e instanceof ToolError ? e : new ToolError(fail(e, 'articles'));
            articles_error = err.hint ? `${err.message} ${err.hint}` : err.message;
          }
          return {
            slug: p.slug,
            name: p.name,
            role: p.role,
            focus: p.beats_or_focus_areas,
            sites: Object.keys(p.platform_authors),
            articles,
            ...(articles_error !== undefined ? { articles_error } : {}),
          };
        }),
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
