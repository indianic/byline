// src/tools/research-tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ok } from '../errors.js';
import { research } from '../plugins/research/index.js';
import { handler } from './shared.js';

export function registerResearchTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'research_topic',
    {
      title: 'Research a topic',
      description:
        'OPTIONAL: fetch attributable findings on a topic from a single configured research provider ' +
        '(Brave or Tavily). If you already have live web access, use it directly and pass what you find as ' +
        '`research` to build_writing_brief instead — this tool exists mainly for callers without one. ' +
        'What it adds is provenance: every finding carries its source URL, and its publication date wherever the ' +
        'provider supplies one, so claims drawn from it can be attributed. That provenance is what makes two ' +
        'downstream checks possible: build_writing_brief\'s news-mode recency guard, and score_draft\'s ' +
        'citation_provenance check, which cross-checks the URLs a draft links against these findings (advisory, ' +
        'not blocking). A hand-supplied `research` string gets neither: it is trusted, not verified. ' +
        'Before calling, decide whether the topic actually turns on recent events: ' +
        '"the Ashes result" does, "the history of the Ashes" does not. If that is genuinely unclear, ASK THE ' +
        'USER in chat rather than guessing. Byline never substitutes one provider for another — pick one ' +
        'explicitly with `provider`, or rely on BYLINE_RESEARCH_PROVIDER or whichever single provider is ' +
        'configured; an unconfigured named provider is refused, never swapped for the other. Findings come back ' +
        'in the provider\'s own order, with no re-sorting or relevance filtering by Byline — pass the WHOLE ' +
        'result as build_writing_brief\'s `findings` argument. Do NOT summarize it into `research`: that ' +
        'throws away the URLs and dates that make each finding checkable, and turns a verifiable origin into ' +
        'an unverifiable one.',
      inputSchema: {
        topic: z.string().describe('What to search for, in the words a person would use'),
        provider: z
          .enum(['brave', 'tavily'])
          .optional()
          .describe(
            'Pin a provider. Omit to use BYLINE_RESEARCH_PROVIDER, or the only configured one. Never falls back to the other. Brave returns ranked snippets with no synthesis; Tavily also returns a synthesis (`answer`) plus its own sources.',
          ),
        window: z
          .enum(['day', 'week', 'month'])
          .default('week')
          .describe('How far back to reach. Use "day" for something that happened in the last few hours.'),
        max_results: z.number().int().min(1).max(20).default(10),
      },
    },
    handler(
      'research_topic',
      async (a: {
        topic: string;
        provider?: 'brave' | 'tavily';
        window: 'day' | 'week' | 'month';
        max_results: number;
      }) =>
        ok(
          await research(a.topic, {
            env: ctx.env,
            window: a.window,
            maxResults: a.max_results,
            ...(a.provider !== undefined ? { provider: a.provider } : {}),
          }),
        ),
    ),
  );
}
