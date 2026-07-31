import { ToolError } from '../../../errors.js';
import type { Finding, RecencyWindow, ResearchProvider, ResearchResult, SearchOptions } from '../types.js';
import { isoWireDate } from '../window.js';

const ENDPOINT = 'https://api.tavily.com/search';

/**
 * Tavily takes a day count, not a named window. These values are the ones the
 * live probe measured it to honour — see the recency table in
 * `docs/RESEARCH-NOTES.md`.
 */
const DAYS: Record<RecencyWindow, number> = { day: 1, week: 7, month: 30 };

interface TavilyResult {
  url?: string;
  title?: string;
  /**
   * Long and markdown-flavoured, not a short excerpt. Measured 2026-07-30 and
   * reconfirmed 2026-07-31 (max observed 1434 chars in an 8-result probe) —
   * this is the snippet source and needs truncation.
   */
  content?: string;
  /**
   * RFC 1123 with an explicit GMT, e.g. `"Thu, 30 Jul 2026 04:00:00 GMT"`.
   * Measured to appear ONLY for `topic: "news"` — absent, not null, otherwise.
   */
  published_date?: string;
  /** Tavily's own relevance score. See `Finding.relevance`. */
  score?: number;
}

interface TavilyResponse {
  answer?: string | null;
  results?: TavilyResult[];
  detail?: { error?: string };
  error?: string;
}

export class TavilyResearch implements ResearchProvider {
  readonly name = 'tavily';
  /**
   * Tavily returns a synthesized answer alongside its sources. Declared rather
   * than inferred by the caller, because this is the ONE structural difference
   * between the two providers and it is why they are not interchangeable.
   */
  readonly synthesizes = true;
  readonly credential = {
    name: 'TAVILY_API_KEY',
    label: 'Tavily API key',
    secret: true,
    example: 'tvly-…',
    help: 'tavily.com → sign up → API Keys. The free tier gives 1,000 credits a month and needs no card. https://app.tavily.com',
  } as const;

  constructor(private readonly apiKey = process.env.TAVILY_API_KEY ?? '') {}

  configured(): boolean {
    return this.apiKey.length > 0;
  }

  withKey(key: string): ResearchProvider {
    return new TavilyResearch(key);
  }

  /**
   * Gates on the search endpoint, which requires the bearer token.
   *
   * Verified with a fabricated-but-well-formed key returning a real non-2xx —
   * see `docs/RESEARCH-NOTES.md`. `ok` comes from the status alone; the key
   * being present or `tvly-`-shaped proves nothing, which is the whole lesson
   * of Ghost's `/site/`.
   */
  async healthCheck() {
    if (!this.configured()) {
      return { provider: this.name, ok: false, detail: 'TAVILY_API_KEY is not set' };
    }
    try {
      // `query` must be at least 2 characters. MEASURED 2026-07-30 and
      // reconfirmed live 2026-07-31: Tavily answers a 1-char query with 400
      // `{"detail":{"error":"Query is too short. Min query length is 2
      // characters."}}` for EVERY key, real or fabricated — so a 1-char probe
      // here would report every valid key as broken, `byline init` would
      // refuse all of them, and a real key and a fake key would be
      // indistinguishable. Do not shorten this string.
      const res = await this.post({ query: 'ok', max_results: 1 });
      return res.ok
        ? { provider: this.name, ok: true, status: res.status, detail: 'Tavily reachable, key accepted' }
        : { provider: this.name, ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
    } catch (e) {
      return { provider: this.name, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private post(payload: Record<string, unknown>): Promise<Response> {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
    });
  }

  async search(query: string, opts: SearchOptions): Promise<Omit<ResearchResult, 'selectedBy'>> {
    if (!this.configured()) {
      throw new ToolError({
        api: 'tavily',
        code: 'RESEARCH_PROVIDER_UNCONFIGURED',
        message: 'TAVILY_API_KEY is not set',
        hint: 'Run `byline init` to add it.',
      });
    }

    const res = await this.post({
      query,
      // `topic: 'news'` is what makes `published_date` appear at all — measured,
      // see RESEARCH-NOTES.md. Without it the news guard has nothing to date.
      topic: 'news',
      days: DAYS[opts.window],
      include_answer: true,
      max_results: Math.min(opts.maxResults, 20),
    });
    const body = (await res.json()) as TavilyResponse;

    if (!res.ok) {
      throw new ToolError({
        api: 'tavily',
        status: res.status,
        code: 'TAVILY_ERROR',
        message: body.detail?.error ?? body.error ?? `Tavily returned ${res.status}`,
      });
    }

    const findings: Finding[] = (body.results ?? [])
      .filter((r): r is TavilyResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, opts.maxResults)
      .map((r) => ({
        url: r.url,
        title: r.title ?? r.url,
        // `content` is long and markdown-flavoured, not a short excerpt.
        // Truncated so one verbose source cannot crowd out the rest of the
        // brief; the URL is there for anyone who needs the full page.
        //
        // NOT passed through Brave's `stripHtml`, and that function is not
        // hoisted for this to share. Live probe 2026-07-31: topic: 'news',
        // days: 1, an 8-result request (6 returned) — zero HTML tag-open
        // sequences and zero character-entity references across every
        // `content` and `title` field. That is a sample of 8, not a
        // guarantee; if a later probe ever finds markup in Tavily `content`,
        // hoist `stripHtml` then, with that observation recorded.
        snippet: (r.content ?? '').slice(0, 1200),
        // RFC 1123 with an explicit GMT ("Thu, 30 Jul 2026 04:00:00 GMT"),
        // normalised to ISO so both providers hand consumers one format.
        // Present ONLY under topic: 'news' — measured.
        //
        // Through the shared `isoWireDate`, never `new Date(x).toISOString()`:
        // that throws RangeError on a truthy-but-unparseable value, and the
        // exception would propagate out of `search()` and discard the ENTIRE
        // result set over one malformed character in one field of one finding
        // — reported as RESEARCH_FAILED, pointing the user at a key that is
        // fine. A date nobody can read costs this finding its date and
        // nothing else; the news guard already refuses undated findings.
        // `isoUtc` is NOT the call here: it appends `Z` to a value with no
        // offset, which would corrupt every RFC 1123 string Tavily sends.
        publishedAt: isoWireDate(r.published_date),
        // Carried because a same-day date is NOT evidence of aboutness: under a
        // narrow `days` window Tavily backfills off-topic filler stamped today.
        // Surfaced, never gated on — no threshold has been measured. Live
        // probe 2026-07-31 reconfirmed the shape of this risk: scores spanned
        // 0.087 to 0.717 in one result set, with the lowest-scoring entries
        // the short, off-topic ones.
        relevance: typeof r.score === 'number' ? r.score : null,
        provider: this.name,
      }));

    // `answer` is read defensively even though `include_answer: true` is
    // always sent: measured, it is `null` when omitted, and a query with no
    // synthesizable fact can plausibly still return null even when requested.
    //
    // The key is OMITTED when Tavily returns no answer, not set to undefined:
    // the brief branches on the field's presence, and `answer: undefined`
    // survives a JSON round trip as a missing key anyway. Being explicit here
    // keeps the in-process object and the wire envelope saying the same thing.
    return {
      provider: this.name,
      query,
      window: opts.window,
      findings,
      ...(body.answer?.trim() ? { answer: body.answer.trim() } : {}),
    };
  }
}
