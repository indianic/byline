import { describe, expect, it } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import { selectProvider } from '../../../src/plugins/research/index.js';
import type { Finding, ResearchProvider } from '../../../src/plugins/research/types.js';

function fake(name: string, key: string): ResearchProvider {
  return {
    name,
    synthesizes: false,
    credential: { name: `${name.toUpperCase()}_API_KEY`, label: name, secret: true, example: 'k', help: 'h' },
    configured: () => key.length > 0,
    withKey: (k) => fake(name, k),
    healthCheck: async () => ({ provider: name, ok: key.length > 0, detail: '' }),
    search: async () => ({ provider: name, query: '', window: 'week' as never, findings: [] }),
  };
}

const both = () => [fake('brave', 'k1'), fake('tavily', 'k2')];
const braveOnly = () => [fake('brave', 'k1'), fake('tavily', '')];
const tavilyOnly = () => [fake('brave', ''), fake('tavily', 'k2')];
const neither = () => [fake('brave', ''), fake('tavily', '')];

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ToolError ? e.code : 'NOT_A_TOOL_ERROR';
  }
  return 'NO_THROW';
};

describe('selectProvider', () => {
  it('honours an explicit provider over the env default', () => {
    const got = selectProvider({ chain: both(), provider: 'tavily', env: { BYLINE_RESEARCH_PROVIDER: 'brave' } });
    expect(got.provider.name).toBe('tavily');
    expect(got.selectedBy).toBe('explicit');
  });

  it('uses BYLINE_RESEARCH_PROVIDER when no provider is named', () => {
    const got = selectProvider({ chain: both(), env: { BYLINE_RESEARCH_PROVIDER: 'tavily' } });
    expect(got.provider.name).toBe('tavily');
    expect(got.selectedBy).toBe('env-default');
  });

  it('falls back to WRITEBLOGS_RESEARCH_PROVIDER', () => {
    const got = selectProvider({ chain: both(), env: { WRITEBLOGS_RESEARCH_PROVIDER: 'tavily' } });
    expect(got.provider.name).toBe('tavily');
    expect(got.selectedBy).toBe('env-default');
  });

  it('uses the sole configured provider with no default set', () => {
    expect(selectProvider({ chain: tavilyOnly(), env: {} })).toMatchObject({
      selectedBy: 'sole-configured',
    });
    expect(selectProvider({ chain: tavilyOnly(), env: {} }).provider.name).toBe('tavily');
  });

  it('uses registry order when both are configured and no default is pinned', () => {
    const got = selectProvider({ chain: both(), env: {} });
    expect(got.provider.name).toBe(both()[0]!.name);
    expect(got.selectedBy).toBe('registry-order');
  });

  // THE no-fallback rule. Naming an unconfigured provider must never quietly
  // hand back the other one — the two return different SHAPES, so a silent
  // swap changes what the writer receives.
  it('refuses a named provider whose key is missing, and does NOT redirect', () => {
    expect(code(() => selectProvider({ chain: braveOnly(), provider: 'tavily', env: {} }))).toBe(
      'RESEARCH_PROVIDER_UNCONFIGURED',
    );
  });

  it('refuses an unknown provider name', () => {
    expect(code(() => selectProvider({ chain: both(), provider: 'exa', env: {} }))).toBe(
      'RESEARCH_UNKNOWN_PROVIDER',
    );
  });

  it('refuses when nothing is configured', () => {
    expect(code(() => selectProvider({ chain: neither(), env: {} }))).toBe('RESEARCH_NOT_CONFIGURED');
  });

  it('ignores an env default naming an unconfigured provider rather than swapping', () => {
    expect(code(() => selectProvider({ chain: braveOnly(), env: { BYLINE_RESEARCH_PROVIDER: 'tavily' } }))).toBe(
      'RESEARCH_PROVIDER_UNCONFIGURED',
    );
  });

  it('reads the env it is handed, never process.env', () => {
    const saved = process.env.BYLINE_RESEARCH_PROVIDER;
    process.env.BYLINE_RESEARCH_PROVIDER = 'tavily';
    try {
      expect(selectProvider({ chain: both(), env: {} }).selectedBy).toBe('registry-order');
    } finally {
      if (saved === undefined) delete process.env.BYLINE_RESEARCH_PROVIDER;
      else process.env.BYLINE_RESEARCH_PROVIDER = saved;
    }
  });

  it('puts the provider measured to date results most reliably first', async () => {
    const { researchProviders } = await import('../../../src/plugins/research/index.js');
    const order = researchProviders({ BRAVE_API_KEY: 'a', TAVILY_API_KEY: 'b' }).map((p) => p.name);
    // Pinned by the live probe: Brave ~55 min vs Tavily ~4h39m on the identical
    // query in the same window. See the recency table in docs/RESEARCH-NOTES.md.
    // Changing this is a decision backed by a new measurement, not a cleanup.
    expect(order).toEqual(['brave', 'tavily']);
  });

  it('keeps findingSchema in exact agreement with the Finding interface', async () => {
    const { findingSchema } = await import('../../../src/plugins/research/schema.js');
    const finding: Finding = {
      url: 'https://a.test/1',
      title: 'T',
      snippet: 's',
      publishedAt: null,
      relevance: null,
      provider: 'brave',
    };
    // Parses a real Finding, and drops nothing from it.
    expect(findingSchema.parse(finding)).toEqual(finding);
    // A Finding missing a declared field is rejected, not silently accepted.
    expect(findingSchema.safeParse({ ...finding, url: undefined }).success).toBe(false);
  });
});
