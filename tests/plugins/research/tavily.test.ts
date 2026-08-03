import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import { TavilyResearch } from '../../../src/plugins/research/tavily/index.js';

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('TavilyResearch', () => {
  it('declares its env var and that it DOES synthesize', () => {
    const t = new TavilyResearch('k');
    expect(t.name).toBe('tavily');
    expect(t.credential.name).toBe('TAVILY_API_KEY');
    expect(t.credential.secret).toBe(true);
    expect(t.synthesizes).toBe(true);
  });

  it('is unconfigured with no key, and withKey returns a NEW instance', () => {
    const empty = new TavilyResearch('');
    expect(empty.configured()).toBe(false);
    const bound = empty.withKey('k');
    expect(bound.configured()).toBe(true);
    expect(empty.configured()).toBe(false);
    expect(bound).not.toBe(empty);
  });

  it('requests the news topic and a day window, and maps results plus the answer', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        answer: 'India won by 4 wickets.',
        results: [
          {
            url: 'https://a.test/1',
            title: 'A',
            content: 'snippet a',
            // The RFC 1123 form Tavily actually returns, measured 2026-07-30.
            published_date: 'Thu, 30 Jul 2026 12:00:00 GMT',
            score: 0.94,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await new TavilyResearch('key-123').search('cricket', { window: 'day', maxResults: 5 });

    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ query: 'cricket', topic: 'news', days: 1, include_answer: true, max_results: 5 });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer key-123' });

    expect(out.provider).toBe('tavily');
    expect(out.answer).toBe('India won by 4 wickets.');
    expect(out.findings[0]).toMatchObject({
      url: 'https://a.test/1',
      title: 'A',
      snippet: 'snippet a',
      // Normalised from RFC 1123 to ISO, so both providers hand consumers of
      // Finding.publishedAt one unambiguous format.
      publishedAt: '2026-07-30T12:00:00.000Z',
      relevance: 0.94,
      provider: 'tavily',
    });
  });

  // A same-day date is NOT evidence a result is about the query: under a narrow
  // days window Tavily backfills off-topic filler stamped today (measured — an
  // ASUS unboxing video for a stock-market query). Carrying the score is what
  // lets the brief surface that; it is deliberately not gated on.
  it("carries Tavily's relevance score, and null when it gives none", async () => {
    vi.stubGlobal('fetch', async () =>
      json({
        results: [
          { url: 'https://a.test/1', title: 'A', content: 's', score: 0.11 },
          { url: 'https://b.test/2', title: 'B', content: 's' },
        ],
      }),
    );
    const out = await new TavilyResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.relevance).toBe(0.11);
    expect(out.findings[1]!.relevance).toBeNull();
  });

  it('truncates a very long content field rather than letting it crowd the brief', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ results: [{ url: 'https://a.test/1', title: 'A', content: 'x'.repeat(5000) }] }),
    );
    const out = await new TavilyResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.snippet.length).toBe(1200);
  });

  it('maps each window to the day count Tavily was measured to honour', async () => {
    const fetchMock = vi.fn(async () => json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const t = new TavilyResearch('k');
    for (const [window, days] of [['day', 1], ['week', 7], ['month', 30]] as const) {
      await t.search('q', { window, maxResults: 1 });
      const sent = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body));
      expect(sent.days).toBe(days);
    }
  });

  it('yields publishedAt null when Tavily gives no date', async () => {
    vi.stubGlobal('fetch', async () => json({ results: [{ url: 'https://a.test/1', title: 'A', content: 's' }] }));
    const out = await new TavilyResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.publishedAt).toBeNull();
  });

  // A malformed date must cost ONE finding its date, never the whole search.
  // `new Date('unknown').toISOString()` throws RangeError, and an exception in
  // the field mapper propagates out of search() and is reported as
  // RESEARCH_FAILED with a hint telling the user to check a key that is fine.
  it('yields publishedAt null for an unparseable date, and keeps every other finding', async () => {
    vi.stubGlobal('fetch', async () =>
      json({
        results: [
          { url: 'https://a.test/1', title: 'A', content: 's', published_date: 'unknown' },
          { url: 'https://b.test/2', title: 'B', content: 's', published_date: 'Thu, 30 Jul 2026 04:00:00 GMT' },
          // Date-shaped junk that Date.parse would silently accept as a real
          // date (a bare year parses as Jan 1) is not a date either.
          { url: 'https://c.test/3', title: 'C', content: 's', published_date: '2026' },
        ],
      }),
    );
    const out = await new TavilyResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings).toHaveLength(3);
    expect(out.findings[0]!.publishedAt).toBeNull();
    expect(out.findings[1]!.publishedAt).toBe('2026-07-30T04:00:00.000Z');
    expect(out.findings[2]!.publishedAt).toBeNull();
    // Order preserved: a bad date never removes or reorders anything.
    expect(out.findings.map((f) => f.url)).toEqual(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
  });

  it('omits answer entirely when Tavily returns none', async () => {
    vi.stubGlobal('fetch', async () => json({ results: [{ url: 'https://a.test/1', title: 'A', content: 's' }] }));
    const out = await new TavilyResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect('answer' in out).toBe(false);
  });

  it('throws a ToolError carrying the HTTP status on a non-2xx', async () => {
    vi.stubGlobal('fetch', async () => json({ detail: { error: 'Unauthorized' } }, 401));
    await expect(new TavilyResearch('bad').search('q', { window: 'day', maxResults: 5 })).rejects.toThrow(ToolError);
  });

  it('refuses to search with no key rather than making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new TavilyResearch('').search('q', { window: 'day', maxResults: 5 })).rejects.toThrow(ToolError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports ok:false for a fabricated key (mocked non-2xx)', async () => {
    vi.stubGlobal('fetch', async () => json({ detail: { error: 'Unauthorized' } }, 401));
    const health = await new TavilyResearch('tvly-' + 'a'.repeat(32)).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.status).toBe(401);
  });

  it('reports ok:false with no key, without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const health = await new TavilyResearch('').healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('TAVILY_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
