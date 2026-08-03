import { ToolError } from '../../errors.js';
import type { ProviderHealth } from '../provider.js';
import { BraveResearch } from './brave/index.js';
import { TavilyResearch } from './tavily/index.js';
import type { RecencyWindow, ResearchProvider, ResearchResult, SelectedBy } from './types.js';

/**
 * Every research provider, in registry order.
 *
 * **Order is load-bearing and was decided by measurement, not preference.**
 * **Brave first**, decided by the probe on
 * 2026-07-30: on one query in one two-minute window, Brave's freshest result
 * was ~55 minutes old and Tavily's freshest on-topic dated result was ~4h39m
 * — roughly 5x staler on the exact axis this order is chosen for, since the
 * news guard refuses findings it cannot date closely enough to trust.
 *
 * Tavily is not the weaker provider overall: its `content` is richer and its
 * `answer` synthesis is a capability Brave lacks. It is second only on
 * recency. See the recency table in `docs/RESEARCH-NOTES.md`.
 *
 * This is NOT a fallback chain and nothing here iterates it looking for a
 * provider that works. `selectProvider` picks exactly one, before any request.
 */
export function researchProviders(env: NodeJS.ProcessEnv = process.env): ResearchProvider[] {
  // Each provider's env var is read from its OWN `credential.name` rather than
  // named again here — two sources for one fact is how GEMINI_API_KEY/
  // XAI_API_KEY drifted before `credential` existed.
  const brave = new BraveResearch('');
  const tavily = new TavilyResearch('');
  return [
    new BraveResearch(env[brave.credential.name] ?? ''),
    new TavilyResearch(env[tavily.credential.name] ?? ''),
  ];
}

const names = (chain: readonly ResearchProvider[]): string => chain.map((p) => p.name).join(', ');

/**
 * Pick the one provider this call will use.
 *
 * Resolved ONCE, from configuration alone, before any network request. That is
 * what makes the no-fallback rule enforceable: substitution can only happen in
 * response to a runtime failure, and no runtime failure is visible from here.
 *
 * Order: explicit argument, then BYLINE_RESEARCH_PROVIDER (falling back to
 * WRITEBLOGS_RESEARCH_PROVIDER), then the sole configured provider, then
 * registry order.
 *
 * A named provider whose key is missing is REFUSED, never redirected — the two
 * providers return different shapes, so quietly handing back the other one
 * would change what the writer receives without saying so.
 */
export function selectProvider(
  opts: {
    env?: NodeJS.ProcessEnv;
    provider?: string;
    chain?: ResearchProvider[];
  } = {},
): { provider: ResearchProvider; selectedBy: SelectedBy } {
  const env = opts.env ?? process.env;
  const chain = opts.chain ?? researchProviders(env);

  const named = (want: string, selectedBy: SelectedBy): { provider: ResearchProvider; selectedBy: SelectedBy } => {
    const found = chain.find((p) => p.name === want);
    if (!found) {
      throw new ToolError({
        api: 'research',
        code: 'RESEARCH_UNKNOWN_PROVIDER',
        message: `No research provider "${want}". Available: ${names(chain) || 'none'}`,
        hint: 'Pass provider: "brave" or provider: "tavily".',
      });
    }
    if (!found.configured()) {
      // Deliberately NOT falling through to the other provider. See the doc
      // comment above and `docs/RESEARCH-NOTES.md`.
      throw new ToolError({
        api: 'research',
        code: 'RESEARCH_PROVIDER_UNCONFIGURED',
        message: `Research provider "${want}" is not configured — ${found.credential.name} is unset.`,
        hint: `Set ${found.credential.name}, or name a configured provider. Byline will not silently use a different provider: ${names(chain)} return different shapes.`,
      });
    }
    return { provider: found, selectedBy };
  };

  if (opts.provider) return named(opts.provider, 'explicit');

  const pinned = env.BYLINE_RESEARCH_PROVIDER ?? env.WRITEBLOGS_RESEARCH_PROVIDER;
  if (pinned?.trim()) return named(pinned.trim(), 'env-default');

  const configured = chain.filter((p) => p.configured());
  if (configured.length === 0) {
    throw new ToolError({
      api: 'research',
      code: 'RESEARCH_NOT_CONFIGURED',
      message: 'No research provider is configured.',
      hint: 'Run `byline init` to add a Brave or Tavily key — or skip research entirely and pass your own findings as `research`.',
    });
  }
  if (configured.length === 1) return { provider: configured[0]!, selectedBy: 'sole-configured' };
  return { provider: configured[0]!, selectedBy: 'registry-order' };
}

export async function research(
  query: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    provider?: string;
    window?: RecencyWindow;
    maxResults?: number;
    chain?: ResearchProvider[];
  } = {},
): Promise<ResearchResult> {
  const { provider, selectedBy } = selectProvider(opts);
  const window = opts.window ?? 'week';
  try {
    const out = await provider.search(query, { window, maxResults: opts.maxResults ?? 10 });
    return { ...out, selectedBy };
  } catch (e) {
    // Rethrown, never retried against the other provider. A failure here is a
    // failure of the provider the user chose, and reporting it is the honest
    // answer — silently returning a different shape is not.
    if (e instanceof ToolError) throw e;
    throw new ToolError({
      api: 'research',
      code: 'RESEARCH_FAILED',
      message: `${provider.name} search failed: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Run health_check to confirm the key still works.',
    });
  }
}

export async function researchHealth(chain = researchProviders()): Promise<ProviderHealth[]> {
  return Promise.all(chain.map((p) => p.healthCheck()));
}

export type { Finding, RecencyWindow, ResearchProvider, ResearchResult, SearchOptions, SelectedBy } from './types.js';
