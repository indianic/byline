import { ToolError } from '../../../errors.js';
import { isoUtc } from '../window.js';
import type { Finding, RecencyWindow, ResearchProvider, ResearchResult, SearchOptions } from '../types.js';

/**
 * The endpoint measured to carry a publication date — see the Brave rows in
 * `docs/RESEARCH-NOTES.md`. The news endpoint is used rather than `/web/search`
 * because the news guard refuses findings it cannot date, and an endpoint that
 * returns undated results makes this provider unusable in news mode.
 *
 * MEASURED: this is also the endpoint whose result array sits at the
 * top-level `body.results[]` — `/web/search` nests its results one level
 * deeper at `body.web.results[]`. Since this adapter only ever calls
 * `/news/search`, it reads `body.results` and nothing else; it does not need
 * to branch on endpoint the way a hypothetical dual-endpoint adapter would.
 */
const ENDPOINT = 'https://api.search.brave.com/res/v1/news/search';

/**
 * Brave's own freshness codes, as measured.
 *
 * MEASURED: these are candidate-pool FILTERS, not sort orders. `freshness=pd`
 * returned a day-old result ranked ahead of a 55-minute-old one. Nothing here
 * may assume the first result is the newest.
 */
const FRESHNESS: Record<RecencyWindow, string> = { day: 'pd', week: 'pw', month: 'pm' };

/**
 * Brave's `title` and `description` are untyped free text and **can contain raw
 * HTML** — `<strong>` tags wrapping matched query terms, confirmed on a live
 * result 2026-07-30. Brave also HTML-escapes the underlying page text (`&lt;`,
 * `&amp;`, `&#39;`, …) while injecting those highlight tags unescaped, so ONE
 * string can mix raw markup with entity-encoded text.
 *
 * The output is a plain-text snippet that flows into a writing brief, and from
 * there an LLM may quote it into generated HTML that gets published. So the
 * postcondition is absolute:
 *
 *   for ANY input, the output contains nothing an HTML parser would treat as a
 *   tag — i.e. no `<` followed by `/`, `!`, `?`, or an ASCII letter (HTML5's
 *   "tag open state") anywhere, and no `<` at the very end either (see the
 *   concatenation note below).
 *
 * Two earlier designs failed, both for the same structural reason: **entity
 * decoding was allowed to influence tag detection.**
 *
 *  - strip-then-decode stripped literal tags first and decoded last, so
 *    `&lt;script&gt;` — never a tag on the wire — decoded *after* stripping
 *    into a literal `<script>`. The stripper *produced* markup it never
 *    received.
 *  - decode-then-strip inverted that, but then a decoded quote moved the tag
 *    boundaries the stripper was looking for: `<a title="foo&quot;bar">` has
 *    exactly one quoted attribute value on the wire, yet after a global decode
 *    the scanner sees `"foo"bar"`, closes the quote early, mistakes the real
 *    `>` for quoted text, and leaves the whole `<a title="foo"bar">` tag
 *    standing in the output.
 *
 * So this is a single left-to-right pass over the RAW input:
 *
 *  1. Tag detection reads only raw characters. In real HTML `&quot;` inside an
 *     attribute value is text, not a quote delimiter — a tokenizer resolves
 *     character references into the attribute's value buffer without ever
 *     changing quote state. Scanning raw input reproduces that, which makes the
 *     desync *structurally impossible* rather than a case to be handled.
 *  2. A tag-open is consumed and dropped whole, using raw quoting rules, so a
 *     literal `>` inside a quoted attribute value (`<a title="a > b">`) cannot
 *     end the tag early and leave a `b">` fragment behind.
 *  3. Anything else accumulates into a text run; entities are decoded only
 *     inside a run, after the run's boundaries are already fixed. A decoded
 *     quote therefore cannot move a boundary — the boundaries were decided
 *     before it existed.
 *  4. Decoded text can still *contain* tag-like sequences (`&lt;script&gt;` is
 *     a text run that decodes to `<script>`), and joining two runs across a
 *     dropped tag can create one that neither run had (`&lt;<b>script&gt;`
 *     joins to `<script>`). So the assembled text gets `dropTags` applied to a
 *     fixed point. No entities remain at that stage, so this cannot cascade
 *     into a decoding problem; the iteration is only because deleting a span
 *     joins its neighbours, and it terminates because every pass that changes
 *     anything strictly shortens the string.
 *  5. An unterminated tag-open (`<script src=x` with no `>`) is REMOVED, not
 *     kept as literal text, and a trailing `<` is dropped for the same reason:
 *     `Finding.snippet` values are concatenated into one writing brief, and two
 *     individually-"safe" snippets must not be able to complete a tag at their
 *     join (`"… <script src=x"` + `"> alert(1) …"`).
 *
 * What is deliberately NOT preserved: angle-bracket notation immediately
 * followed by a letter, e.g. `Array<string>`, is deleted along with real tags,
 * because HTML5 says `<s` opens a tag and this function's job is to emit text
 * no parser can read as markup. Prose with spaced brackets — `a &lt; b &gt; c`
 * → `a < b > c` — IS preserved, because `< b >` is not a tag to any parser.
 * Both cases are pinned by tests so the behaviour is documented rather than
 * surprising. Nothing here throws for any input: a reference that cannot be
 * decoded stays literal text.
 */
function stripHtml(s: string): string {
  let out = '';
  let run = '';
  let i = 0;
  while (i < s.length) {
    if (isTagOpen(s, i)) {
      // Raw tag boundary. Flush the text run BEFORE it, decoding only the run.
      out += decodeEntities(run);
      run = '';
      i = endOfTag(s, i);
      continue;
    }
    run += s.charAt(i);
    i++;
  }
  out += decodeEntities(run);

  // Step 4: decoded text (and run joins) can be tag-like even where the raw
  // input was not. Neutralise on fully-decoded text, to a fixed point.
  out = dropTagsToFixedPoint(out).replace(/\s+/g, ' ').trim();

  // Step 5: a trailing '<' is the one character that is harmless alone and
  // unsafe as soon as another snippet is appended after it in the brief.
  while (out.endsWith('<')) out = out.slice(0, -1).trimEnd();
  return out;
}

/**
 * HTML5's tag-open state: `<` followed by `/`, `!`, `?`, or an ASCII letter.
 * A `<` followed by anything else — a space, a digit, another `<`, end of
 * input — is a literal character per spec, never the start of a tag. That gate
 * is what keeps `"a < b > c"` intact while still catching `<script>`,
 * `</script>`, `<!--`, and Brave's own `<strong>`.
 */
function isTagOpen(s: string, i: number): boolean {
  return s.charAt(i) === '<' && /[a-zA-Z!/?]/.test(s.charAt(i + 1));
}

/**
 * Index just past the tag opening at `start`, using RAW quoting rules: a `>`
 * inside a quoted attribute value does not end the tag. An unterminated tag
 * consumes to the end of the string — dropped rather than left as literal
 * text, so it cannot complete a tag when snippets are concatenated.
 */
function endOfTag(s: string, start: number): number {
  let i = start + 1;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s.charAt(i);
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i + 1;
    }
    i++;
  }
  return s.length;
}

/** One pass: drop every tag-open span, keep everything else verbatim. */
function dropTags(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (isTagOpen(s, i)) {
      i = endOfTag(s, i);
      continue;
    }
    out += s.charAt(i);
    i++;
  }
  return out;
}

/**
 * Deleting a span joins the text on either side of it, and that join can form a
 * tag-open the input never contained (`a<<b>c` → `a<c`). Iterating to a fixed
 * point is what makes "no tag-open sequence survives" true rather than merely
 * likely. Terminates: any pass that changes the string removes at least the two
 * characters of a tag-open, so the length strictly decreases.
 */
function dropTagsToFixedPoint(s: string): string {
  let cur = s;
  for (;;) {
    const next = dropTags(cur);
    if (next === cur) return cur;
    cur = next;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decodes named (`&amp;`) and numeric (`&#60;`, `&#x3C;`) references in a
 * single left-to-right pass. `String.replace` never rescans its own output, so
 * `&amp;lt;` correctly decodes only the outer `&amp;` (to the literal text
 * `&lt;`) rather than cascading into `<`, exactly as a browser would.
 *
 * Anything that cannot be decoded is left as literal text — this never throws
 * and never guesses:
 *
 *  - out-of-range code points (`&#99999999;`, `&#x110000;`) would make
 *    `String.fromCodePoint` throw `RangeError`, and that exception would
 *    propagate out of `search()` and discard the ENTIRE search result over one
 *    malformed character in one field of one finding. Range-checked instead.
 *  - lone surrogates (`&#xD800;`–`&#xDFFF;`) do not throw but would put an
 *    unpaired UTF-16 code unit into text headed for JSON and an LLM prompt.
 *  - unknown names are left alone; `Object.hasOwn` is required because a bare
 *    object literal would otherwise resolve `&constructor;` / `&toString;` to
 *    an inherited `Object.prototype` member and splice a function's source text
 *    into the snippet.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match: string, ref: string) => {
    if (ref.charAt(0) === '#') {
      const isHex = ref.charAt(1) === 'x' || ref.charAt(1) === 'X';
      const codePoint = parseInt(ref.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      return String.fromCodePoint(codePoint);
    }
    return Object.hasOwn(NAMED_ENTITIES, ref) ? (NAMED_ENTITIES[ref] as string) : match;
  });
}

interface BraveResult {
  url?: string;
  title?: string;
  description?: string;
  /** ISO 8601 when present. Absent on some results — never substituted. */
  page_age?: string;
  age?: string;
}

interface BraveResponse {
  results?: BraveResult[];
  message?: string;
  error?: { detail?: string };
}

export class BraveResearch implements ResearchProvider {
  readonly name = 'brave';
  /** Brave returns ranked snippets and never a synthesis. */
  readonly synthesizes = false;
  readonly credential = {
    name: 'BRAVE_API_KEY',
    label: 'Brave Search API key',
    secret: true,
    example: 'BSA…',
    help: 'brave.com/search/api → subscribe to the free "Data for Search" plan → API Keys → Add API key. https://api-dashboard.search.brave.com/app/keys',
  } as const;

  constructor(private readonly apiKey = process.env.BRAVE_API_KEY ?? '') {}

  configured(): boolean {
    return this.apiKey.length > 0;
  }

  withKey(key: string): ResearchProvider {
    return new BraveResearch(key);
  }

  /**
   * Gates on the search endpoint itself, which requires the subscription token.
   *
   * Measured 2026-07-30 with a fabricated-but-well-formed key — see
   * `docs/RESEARCH-NOTES.md`. Brave exposes no unauthenticated status endpoint
   * to be tempted by, which is what made Ghost's `/site/` a four-phase defect.
   *
   * The probe query is `'ok'` (two characters), not one — Brave itself accepts
   * a 1-char query (measured: 200), but the sibling Tavily adapter rejects a
   * 1-char query with 400 for every key, real or fabricated. Both adapters
   * share this one probe query so the 2-character floor is one fact in one
   * place, not re-derived per provider. `ok` in the response comes from the
   * HTTP status alone, never from the key merely being present.
   */
  async healthCheck() {
    if (!this.configured()) {
      return { provider: this.name, ok: false, detail: 'BRAVE_API_KEY is not set' };
    }
    try {
      const res = await fetch(`${ENDPOINT}?q=ok&count=1`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      });
      return res.ok
        ? { provider: this.name, ok: true, status: res.status, detail: 'Brave Search reachable, key accepted' }
        : { provider: this.name, ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
    } catch (e) {
      return { provider: this.name, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async search(query: string, opts: SearchOptions): Promise<Omit<ResearchResult, 'selectedBy'>> {
    if (!this.configured()) {
      throw new ToolError({
        api: 'brave',
        code: 'RESEARCH_PROVIDER_UNCONFIGURED',
        message: 'BRAVE_API_KEY is not set',
        hint: 'Run `byline init` to add it.',
      });
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(opts.maxResults, 20)));
    url.searchParams.set('freshness', FRESHNESS[opts.window]);

    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
    });
    const body = (await res.json()) as BraveResponse;

    if (!res.ok) {
      throw new ToolError({
        api: 'brave',
        status: res.status,
        code: 'BRAVE_ERROR',
        message: body.error?.detail ?? body.message ?? `Brave returned ${res.status}`,
      });
    }

    const findings: Finding[] = (body.results ?? [])
      .filter((r): r is BraveResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, opts.maxResults)
      .map((r) => ({
        url: r.url,
        title: stripHtml(r.title ?? '') || r.url,
        // Stripped, not passed through: Brave's description can carry raw
        // <strong> markup. Measured 2026-07-30.
        snippet: stripHtml(r.description ?? ''),
        // `page_age` only, normalised to explicit UTC. `age` is a RELATIVE
        // string ("2 hours ago") and resolving it against the clock would put a
        // derived timestamp in a field the news guard treats as measured.
        // Absent or unparseable means null, never a guess.
        publishedAt: isoUtc(r.page_age),
        // Brave returns no relevance score. Honestly null rather than a
        // fabricated 1.0, which would read as "maximally relevant".
        relevance: null,
        provider: this.name,
      }));

    // No `answer` key at all, not `answer: undefined` — `synthesizes` is false
    // and the field's absence is what tells the brief there is no synthesis.
    return { provider: this.name, query, window: opts.window, findings };
  }
}
