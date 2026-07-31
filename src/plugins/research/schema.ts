import { z } from 'zod';
import type { Finding, ResearchResult } from './types.js';

/**
 * The wire shape of a `Finding`, validated once.
 *
 * Two MCP tools accept findings — `build_writing_brief` nested inside a whole
 * result, `score_draft` as a bare array — and the MCP SDK strips any key an
 * input schema does not declare, so this MUST stay in exact agreement with the
 * `Finding` interface in `./types.ts`. Two hand-maintained copies of one shape
 * is how SLUG_PATTERN, IMAGE_LOOKS, and the image providers' env var names all
 * drifted before.
 */
export const findingSchema = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  publishedAt: z.string().nullable(),
  relevance: z.number().nullable(),
  provider: z.string(),
});

/** A whole `research_topic` result, as `build_writing_brief` receives it. */
export const researchResultSchema = z.object({
  provider: z.string(),
  query: z.string(),
  window: z.enum(['day', 'week', 'month']),
  answer: z.string().optional(),
  selectedBy: z.enum(['explicit', 'env-default', 'sole-configured', 'registry-order']),
  findings: z.array(findingSchema),
});

/**
 * The agreement above, enforced by the compiler — in BOTH directions.
 *
 * This lives in `src/`, not in a test, deliberately. `tsconfig.json` sets
 * `rootDir: src`, so test files are never typechecked: a `const f: Finding =
 * {…}` annotation in a spec file is decoration, and the runtime parse test in
 * `tests/plugins/research/select.test.ts` can only catch a field DELETED from
 * the schema. It cannot catch one ADDED to the interface — add `sourceRank` to
 * `Finding`, forget this file, and the MCP SDK silently strips it out of
 * `build_writing_brief` and `score_draft` while every test stays green. That
 * is `feature_image_id` verbatim, which took four phases to notice.
 *
 * Each assignment fails when the SOURCE type is missing a member the TARGET
 * requires, so the pair covers both drift directions:
 *   - a field added to an interface → the `: Finding` / `: ResearchResult`
 *     line fails, because the inferred schema type lacks it;
 *   - a field added to a schema → the `: z.infer<…>` line fails, because the
 *     interface lacks it.
 * Both were demonstrated red before this was committed. These values are never
 * read and nothing here runs; the check is entirely `npm run typecheck`.
 */
const _findingAgrees: Finding = {} as z.infer<typeof findingSchema>;
const _findingAgreesBack: z.infer<typeof findingSchema> = {} as Finding;
const _resultAgrees: ResearchResult = {} as z.infer<typeof researchResultSchema>;
const _resultAgreesBack: z.infer<typeof researchResultSchema> = {} as ResearchResult;
void _findingAgrees;
void _findingAgreesBack;
void _resultAgrees;
void _resultAgreesBack;
