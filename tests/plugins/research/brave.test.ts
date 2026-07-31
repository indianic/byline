import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import { BraveResearch } from '../../../src/plugins/research/brave/index.js';

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('BraveResearch', () => {
  it('declares its env var and that it does not synthesize', () => {
    const b = new BraveResearch('k');
    expect(b.name).toBe('brave');
    expect(b.credential.name).toBe('BRAVE_API_KEY');
    expect(b.credential.secret).toBe(true);
    expect(b.synthesizes).toBe(false);
  });

  it('is unconfigured with no key, and withKey returns a NEW instance', () => {
    const empty = new BraveResearch('');
    expect(empty.configured()).toBe(false);
    const bound = empty.withKey('k');
    expect(bound.configured()).toBe(true);
    expect(empty.configured()).toBe(false); // not mutated
    expect(bound).not.toBe(empty);
  });

  it('sends the key in X-Subscription-Token and maps results to findings', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        results: [
          { url: 'https://a.test/1', title: 'A', description: 'snippet a', page_age: '2026-07-30T12:00:00Z' },
          { url: 'https://b.test/2', title: 'B', description: 'snippet b' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await new BraveResearch('key-123').search('cricket', { window: 'day', maxResults: 5 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('q=cricket');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'key-123' });

    expect(out.provider).toBe('brave');
    expect(out.answer).toBeUndefined(); // Brave never synthesizes
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0]).toMatchObject({
      url: 'https://a.test/1',
      title: 'A',
      snippet: 'snippet a',
      publishedAt: '2026-07-30T12:00:00.000Z',
      // Brave gives no score. Honestly null, not a fabricated 1.0.
      relevance: null,
      provider: 'brave',
    });
  });

  // MEASURED 2026-07-30: Brave's page_age has NO timezone suffix. Per the ES
  // spec that parses as LOCAL time, so without normalisation this timestamp
  // would land hours off and the window guard would judge it on a wrong date.
  // This test fails on any machine if the adapter drops the UTC normalisation,
  // because it pins the absolute instant, not a re-serialised local string.
  it('treats a timezone-less page_age as UTC', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ results: [{ url: 'https://a.test/1', title: 'A', description: 's', page_age: '2026-07-30T07:52:29' }] }),
    );
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.publishedAt).toBe('2026-07-30T07:52:29.000Z');
    expect(Date.parse(out.findings[0]!.publishedAt!)).toBe(Date.UTC(2026, 6, 30, 7, 52, 29));
  });

  // MEASURED 2026-07-30: description can carry raw <strong> markup. Passed
  // through it leaks into the brief and from there into the article.
  it('strips HTML out of the title and snippet', async () => {
    vi.stubGlobal('fetch', async () =>
      json({
        results: [
          {
            url: 'https://a.test/1',
            title: 'The <strong>Sensex</strong> rallied',
            description: '...the <strong>Nifty reclaimed 24,000</strong>, snapping a run &amp; more',
          },
        ],
      }),
    );
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.title).toBe('The Sensex rallied');
    expect(out.findings[0]!.snippet).toBe('...the Nifty reclaimed 24,000, snapping a run & more');
    expect(out.findings[0]!.snippet).not.toContain('<');
  });

  // Helper for the stripHtml edge-case tests below: runs a single description
  // through search() and returns the resulting snippet, since stripHtml is
  // not exported and is only reachable through the adapter's mapping step.
  const strippedSnippet = async (description: string): Promise<string> => {
    vi.stubGlobal('fetch', async () =>
      json({ results: [{ url: 'https://a.test/1', title: 'T', description }] }),
    );
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 5 });
    return out.findings[0]!.snippet;
  };

  // Regression test for the "decode-after-strip" bug: the old order stripped
  // literal tags first and decoded entities last, so entity-encoded markup —
  // never a literal tag on the wire — decoded back into a real tag *after*
  // stripping had already run, and nothing stripped it again. Brave escapes
  // page text while injecting its own raw highlight tags, so both forms can
  // appear in one description; this pins that the entity-encoded form can
  // never survive as markup either.
  it('does not let entity-encoded markup decode back into a literal tag (injection case)', async () => {
    const snippet = await strippedSnippet('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(snippet).toBe('alert(1)');
    expect(snippet).not.toContain('<');
    expect(snippet).not.toContain('>');
  });

  // Regression test for the other failure mode: decoding entities first and
  // THEN stripping with a naive "anything between < and >" pattern corrupts
  // legitimate prose, because "a &lt; b &gt; c" decodes to "a < b > c" and a
  // naive tag pattern eats "< b >" as if it were a tag. A real HTML parser
  // never treats "< b" as a tag (the "<" is followed by a space, not a tag
  // name), so this snippet is meant to survive decoding untouched. This is a
  // claim about SPACED brackets only, not about prose in general: notation whose
  // '<' is immediately followed by a letter IS a tag-open to HTML5 and is
  // deleted — see the 'deletes angle-bracket notation' test below.
  it('does not corrupt legitimate prose containing a bare < and > (legitimate-prose case)', async () => {
    const snippet = await strippedSnippet('a &lt; b &gt; c');
    expect(snippet).toBe('a < b > c');
  });

  // Numeric character references (decimal and hex) were not handled by the
  // old named-entity-only whitelist. Confirms they decode AND that the
  // resulting tag-shaped text is still stripped, same as a literal tag.
  it('decodes numeric character references and still strips the resulting tag', async () => {
    expect(await strippedSnippet('&#60;script&#62;')).toBe('');
    expect(await strippedSnippet('&#x3C;script&#x3E;')).toBe('');
  });

  // A literal '>' inside a quoted attribute value must not end the tag
  // early — a quote-unaware regex stops at the first '>' and leaves a
  // fragment like `b">` behind.
  it('strips a tag whose attribute value contains a literal >', async () => {
    const snippet = await strippedSnippet('<a title="a > b">link</a>');
    expect(snippet).toBe('link');
    expect(snippet).not.toContain('<');
    expect(snippet).not.toContain('>');
  });

  // Like `strippedSnippet` but maps many descriptions in ONE search() call, so
  // a few thousand property-test inputs cost a few stubbed fetches instead of a
  // few thousand. `maxResults` is what search() slices on, so it must cover the
  // batch.
  const strippedSnippets = async (descriptions: string[]): Promise<string[]> => {
    vi.stubGlobal('fetch', async () =>
      json({ results: descriptions.map((description, i) => ({ url: `https://a.test/${i}`, title: 'T', description })) }),
    );
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: descriptions.length });
    return out.findings.map((f) => f.snippet);
  };

  // HTML5's tag-open state, and therefore the whole postcondition of stripHtml:
  // a '<' followed by '/', '!', '?', or an ASCII letter. Anything else after a
  // '<' is a literal character to every HTML parser.
  const TAG_OPEN = /<[a-zA-Z!/?]/;

  // THE Critical from the second review round. On the wire `&quot;` inside an
  // attribute value is TEXT, not a quote delimiter — a real tokenizer resolves
  // it into the attribute's value buffer without changing quote state. A design
  // that decodes before detecting tags turns it into a real quote, closes the
  // attribute early, mistakes the tag's real '>' for quoted text, and leaves
  // `<a title="foo"bar">` — a complete, well-formed tag — in the output.
  // Detection now reads raw characters only, so that desync cannot occur.
  it('strips a tag whose attribute value holds an entity-encoded quote (quote-desync case)', async () => {
    for (const input of [
      '<a title="foo&quot;bar">safe</a>',
      "<a title='foo&apos;bar'>safe</a>",
      '&lt;a title="foo&amp;quot;bar"&gt;safe&lt;/a&gt;',
      "&lt;a title='foo&amp;apos;bar'&gt;safe&lt;/a&gt;",
      '<a title="foo&#34;bar">safe</a>',
    ]) {
      const snippet = await strippedSnippet(input);
      expect(snippet, input).toBe('safe');
      expect(snippet, input).not.toMatch(TAG_OPEN);
    }
  });

  // The related variant: an attribute quote that never closes swallows the rest
  // of the string as attribute content, exactly as a tokenizer would, so no
  // `<a title="never closes>` fragment can be left behind.
  it('drops a tag whose quoted attribute value never closes', async () => {
    const snippet = await strippedSnippet('<a title="never closes>real<script>bad</script>');
    expect(snippet).toBe('');
    expect(snippet).not.toMatch(TAG_OPEN);
  });

  // Out-of-range numeric references reached String.fromCodePoint, which has no
  // range check, and the RangeError propagated out of search() and discarded the
  // ENTIRE search result over one malformed character in one field. Nothing in
  // stripHtml may throw for any input: an undecodable reference stays literal.
  it('leaves an undecodable numeric reference as literal text instead of throwing', async () => {
    expect(await strippedSnippet('&#99999999;')).toBe('&#99999999;');
    expect(await strippedSnippet('&#x110000;')).toBe('&#x110000;');
    expect(await strippedSnippet('&#xD800;')).toBe('&#xD800;'); // lone surrogate
    expect(await strippedSnippet('a &#99999999;script&#99999999; b')).toBe('a &#99999999;script&#99999999; b');
  });

  // A bare object literal inherits Object.prototype, so a whitelist lookup for
  // `&constructor;` / `&toString;` would return an inherited function and splice
  // its source text into the snippet. Own-property check only.
  it('does not resolve inherited Object.prototype members as named entities', async () => {
    expect(await strippedSnippet('&constructor; &toString; &hasOwnProperty;')).toBe(
      '&constructor; &toString; &hasOwnProperty;',
    );
  });

  // An unterminated tag-open is REMOVED, not kept as literal text: Finding
  // snippets are concatenated into one writing brief, and two individually
  // "safe" snippets must not be able to complete a real tag at their join.
  it('removes an unterminated tag-open rather than keeping it as literal text', async () => {
    expect(await strippedSnippet('breaking news <script src=x')).toBe('breaking news');
    expect(await strippedSnippet('trailing bracket &lt;')).toBe('trailing bracket');
  });

  it('keeps two snippets tag-free when the brief concatenates them', async () => {
    const a = await strippedSnippet('breaking news <script src=x');
    const b = await strippedSnippet('> alert(1) more text');
    expect(a).toBe('breaking news');
    expect(b).toBe('> alert(1) more text');
    expect(a + b).not.toMatch(TAG_OPEN);
    expect(`${a} ${b}`).not.toMatch(TAG_OPEN);
  });

  // Text runs are decoded separately, so a tag can also appear at the JOIN of
  // two runs on either side of a stripped tag — neither run contains one alone.
  it('neutralises a tag formed by joining two text runs across a stripped tag', async () => {
    expect(await strippedSnippet('&lt;<strong>script&gt;')).toBe('');
    expect(await strippedSnippet('a&lt;<b>c&gt;d')).toBe('ad');
  });

  // Documented, deliberate loss: HTML5 says '<s' opens a tag, so type-annotation
  // prose is indistinguishable from markup and is deleted. Producing text no
  // parser can read as markup is the postcondition; content fidelity for this
  // shape is not. Pinned here so the behaviour is documented, not surprising.
  it('deletes angle-bracket notation HTML5 reads as a tag-open, even in prose', async () => {
    expect(await strippedSnippet('Use Array<string> or List<Item> in TypeScript')).toBe(
      'Use Array or List in TypeScript',
    );
  });

  // Property test, not more examples: three rounds of hand-picked cases each
  // missed the next hole, so what closes the class is the postcondition asserted
  // over a generated population — every output tag-free, no input throwing, and
  // every PAIR of outputs still tag-free when concatenated (the brief joins them).
  const FUZZ_FRAGMENTS = [
    // raw tags, quoted and unquoted attributes, including a '>' inside quotes
    '<strong>', '</strong>', '<a href="x">', '</a>', '<a title="a > b">', "<a title='a > b'>",
    '<img src=x onerror=alert(1)>', '<!-- c -->', '<!doctype html>', '<?xml version="1.0"?>',
    // entity-encoded quotes inside attribute values (the Critical case)
    '<a title="foo&quot;bar">', "<a title='foo&apos;bar'>", '<a title="foo&#34;bar">',
    '&lt;a title="foo&amp;quot;bar"&gt;',
    // unterminated tags and bare bracket characters
    '<script src=x', '<a title="never closes>', '<', '</', '<!', '<?', '<3', '>', '<<', '><',
    // entity-encoded tags, double-encoded, numeric, hex, out-of-range, malformed
    '&lt;script&gt;', '&lt;/script&gt;', '&amp;lt;script&amp;gt;', '&#60;', '&#62;', '&#x3C;', '&#x3E;',
    '&#X3c;', '&#0;', '&#99999999;', '&#x110000;', '&#xD800;', '&#;', '&#x;', '&notanentity;',
    '&amp;', '&quot;', '&apos;', '&nbsp;', '&constructor;', '&',
    // plain prose, whitespace, and the characters the scanner tracks
    'plain text', 'a < b > c', 'Array<string>', 'x&y', 'script', 'alert(1)', 'the Nifty rallied',
    ' ', '\n', '\t', '"', "'", '=', '/', 'title=', 'src=x',
  ];

  // Deterministic PRNG (mulberry32) so a failure is reproducible from the seed.
  const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('property: 3000 generated inputs never yield a tag-open sequence, alone or concatenated', async () => {
    const rand = mulberry32(0x5eed);
    const inputs = Array.from({ length: 3000 }, () => {
      const parts = 1 + Math.floor(rand() * 8);
      let s = '';
      for (let p = 0; p < parts; p++) s += FUZZ_FRAGMENTS[Math.floor(rand() * FUZZ_FRAGMENTS.length)]!;
      return s;
    });

    const outputs: string[] = [];
    for (let i = 0; i < inputs.length; i += 250) {
      const chunk = inputs.slice(i, i + 250);
      try {
        outputs.push(...(await strippedSnippets(chunk)));
      } catch (e) {
        // A throw is itself a defect (one malformed field must never discard the
        // whole result), so name the offending input rather than the batch.
        for (const one of chunk) {
          try {
            await strippedSnippets([one]);
          } catch (inner) {
            throw new Error(`stripHtml threw on ${JSON.stringify(one)}: ${String(inner)}`);
          }
        }
        throw e;
      }
    }
    expect(outputs).toHaveLength(inputs.length);

    const offenders = inputs.filter((_, i) => TAG_OPEN.test(outputs[i]!) || outputs[i]!.endsWith('<'));
    expect(offenders.slice(0, 5)).toEqual([]);

    // Concatenation: exhaustive over a 100-output sample (10,000 ordered pairs),
    // plus every consecutive pair across all 3000, plus every output against
    // adversarial tails that only need a '<' handed to them to become a tag.
    const pairFailures: string[] = [];
    const sample = outputs.slice(0, 100);
    for (const a of sample) {
      for (const b of sample) if (TAG_OPEN.test(a + b)) pairFailures.push(`${JSON.stringify(a)} + ${JSON.stringify(b)}`);
    }
    for (let i = 0; i + 1 < outputs.length; i++) {
      const joined = outputs[i]! + outputs[i + 1]!;
      if (TAG_OPEN.test(joined)) pairFailures.push(JSON.stringify(joined));
    }
    for (const out of outputs) {
      for (const tail of ['script>', '/a>', '!--', 'b>', '?php']) {
        if (TAG_OPEN.test(out + tail)) pairFailures.push(`${JSON.stringify(out)} + ${JSON.stringify(tail)}`);
      }
    }
    expect(pairFailures.slice(0, 5)).toEqual([]);
  });

  // NEVER invent a date. A missing page_age is null, not now().
  it('yields publishedAt null when Brave gives no date', async () => {
    vi.stubGlobal('fetch', async () => json({ results: [{ url: 'https://a.test/1', title: 'A', description: 's' }] }));
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.publishedAt).toBeNull();
  });

  it('yields publishedAt null rather than a guess when page_age is unparseable', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ results: [{ url: 'https://a.test/1', title: 'A', description: 's', page_age: 'last Tuesday' }] }),
    );
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 5 });
    expect(out.findings[0]!.publishedAt).toBeNull();
  });

  it('caps results at maxResults', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://a.test/${i}`, title: `T${i}`, description: 's' }));
    vi.stubGlobal('fetch', async () => json({ results: many }));
    const out = await new BraveResearch('k').search('q', { window: 'day', maxResults: 3 });
    expect(out.findings).toHaveLength(3);
  });

  it('throws a ToolError carrying the HTTP status on a non-2xx', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'Invalid subscription token' }, 422));
    await expect(new BraveResearch('bad').search('q', { window: 'day', maxResults: 5 })).rejects.toThrow(ToolError);
  });

  it('refuses to search with no key rather than making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new BraveResearch('').search('q', { window: 'day', maxResults: 5 })).rejects.toThrow(ToolError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // THE regression test from ADDING-A-PLATFORM.md step 4. healthCheck must gate
  // on an authenticated endpoint; a fabricated-but-well-formed key must fail.
  it('reports ok:false for a fabricated key (mocked non-2xx)', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'Invalid subscription token' }, 422));
    const health = await new BraveResearch('BSA' + 'a'.repeat(29)).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.status).toBe(422);
  });

  it('reports ok:false with no key, without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const health = await new BraveResearch('').healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('BRAVE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The health probe query must be >= 2 characters — Tavily (Task 5) rejects a
  // 1-char query with 400 for every key, and both adapters share one probe
  // query ('ok') so that fact lives in one place, not two.
  it('probes healthCheck with a query at least 2 characters long', async () => {
    const fetchMock = vi.fn(async () => json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await new BraveResearch('key-123').healthCheck();
    const [url] = fetchMock.mock.calls[0]!;
    const q = new URL(String(url)).searchParams.get('q');
    expect(q).not.toBeNull();
    expect(q!.length).toBeGreaterThanOrEqual(2);
  });
});
