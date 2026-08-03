import { describe, expect, it } from 'vitest';
import type { Persona } from '../../src/config/personas.js';
import { buildBrief } from '../../src/craft/brief.js';
import {
  DIMENSIONS,
  HOOKS,
  HUMAN_TEXTURES,
  NEWS_LEDES,
  NEWS_STRUCTURES,
  PERSONA_PRESENCES,
} from '../../src/craft/dimensions.js';
import { IMAGE_LOOKS } from '../../src/craft/image-style.js';
import { GHOST_HTML_PROFILE } from '../../src/plugins/platforms/ghost/html-profile.js';
import type { Finding, ResearchResult } from '../../src/plugins/research/types.js';

const PERSONA = {
  slug: 'jane-doe',
  name: 'Jane Doe',
  gender: 'female',
  role: 'CTO',
  country: 'India',
  state: 'Gujarat',
  years_of_experience: 18,
  language_written: 'English',
  writing_style: 'Analytical',
  tone_of_voice: 'Dry',
  communication_style: 'Clear',
  storytelling_style: 'Narrative',
  sentence_structure: 'Varied',
  local_journalistic_style: '',
  cultural_influence: 'Indian IT',
  description: 'Delivery',
  subject_expertise: 'Cloud',
  industry_specialization: 'SaaS',
  beats_or_focus_areas: 'AI',
  personality_traits: 'Blunt',
  political_leaning: 'neutral',
  bias_tendency: 'Anti-hype',
  risk_tolerance_in_opinions: 'high',
  influence_level: 'senior',
  research_methodology: 'Primary data',
  persona_specific_instructions_for_ai: 'Name the real trade-off.',
  platform_authors: {},
} satisfies Persona;

const base = {
  persona: PERSONA,
  topic: 'AI agents in fintech',
  mode: 'blog' as const,
  profile: GHOST_HTML_PROFILE,
};

describe('buildBrief', () => {
  it('is deterministic for a given seed', () => {
    const a = buildBrief({ ...base, seed: 42 });
    const b = buildBrief({ ...base, seed: 42 });
    expect(a.brief).toBe(b.brief);
    expect(a.choices).toEqual(b.choices);
  });

  it('returns the seed it used so a brief can be reproduced', () => {
    const first = buildBrief(base);
    expect(buildBrief({ ...base, seed: first.seed }).brief).toBe(first.brief);
  });

  it('varies across seeds', () => {
    const briefs = new Set(
      Array.from({ length: 40 }, (_, i) => buildBrief({ ...base, seed: i }).brief),
    );
    expect(briefs.size).toBeGreaterThan(5);
  });

  it('reaches every option of every dimension across seeds', () => {
    const seen: Record<string, Set<number>> = {};
    for (let s = 0; s < 800; s++) {
      for (const [dim, idx] of Object.entries(buildBrief({ ...base, seed: s }).choices)) {
        (seen[dim] ??= new Set()).add(idx as number);
      }
    }
    for (const [dim, options] of Object.entries(DIMENSIONS)) {
      expect(seen[dim]?.size, `dimension ${dim}`).toBe(options.length);
    }
  });

  it('embeds the chosen hook text verbatim', () => {
    const b = buildBrief({ ...base, seed: 7 });
    expect(b.brief).toContain(HOOKS[b.choices.hook!]);
  });

  it('embeds persona fields', () => {
    const b = buildBrief({ ...base, seed: 1 }).brief;
    expect(b).toContain('Jane Doe');
    expect(b).toContain('Analytical');
    expect(b).toContain('Name the real trade-off.');
  });

  it('never asks for target="_blank" — Ghost strips it', () => {
    for (let s = 0; s < 30; s++) {
      expect(buildBrief({ ...base, seed: s }).brief).not.toContain('target="_blank"');
    }
  });

  it('requires rel="noopener noreferrer", which does survive', () => {
    expect(buildBrief({ ...base, seed: 1 }).brief).toContain('rel="noopener noreferrer"');
  });

  it('forbids hand-written heading ids', () => {
    expect(buildBrief({ ...base, seed: 1 }).brief).toMatch(
      /never.*id.*heading|heading.*id.*automatic|id attributes on headings/i,
    );
  });

  it('news mode demands recency and cites the research', () => {
    const b = buildBrief({ ...base, mode: 'news', research: 'Reddit says X', seed: 3 }).brief;
    expect(b).toContain('Reddit says X');
    expect(b.toLowerCase()).toContain('last 30 days');
  });

  it('blog mode does not demand recency', () => {
    const b = buildBrief({ ...base, mode: 'blog', seed: 3 }).brief;
    expect(b.toLowerCase()).not.toContain('last 30 days');
  });

  it('honours a custom word count', () => {
    expect(buildBrief({ ...base, wordCount: 1500, seed: 1 }).brief).toContain('1500');
  });

  it('defaults to 800 words', () => {
    expect(buildBrief({ ...base, seed: 1 }).brief).toContain('800');
  });

  it('names the target platform in the HTML rules', () => {
    const brief = buildBrief({ ...base, seed: 1 }).brief;
    expect(brief).toContain('HTML RULES (GHOST');
    expect(brief).toContain('<table>');
  });

  it('uses the platform display label, not the lowercase machine id, in prose', () => {
    const brief = buildBrief({ ...base, seed: 1 }).brief;
    expect(brief).toContain('Ghost unwraps them on ingest');
    expect(brief).toContain('Ghost-compatible HTML');
    expect(brief).not.toContain('ghost unwraps them on ingest');
    expect(brief).not.toContain('ghost-compatible HTML');
  });
});

describe('profile-driven visual guidance', () => {
  const plain = {
    ...GHOST_HTML_PROFILE,
    platform: 'testwp',
    label: 'TestWP',
    inlineStyles: false,
  };

  it('never instructs inline styles when the platform strips them', () => {
    for (let seed = 0; seed < 40; seed++) {
      const text = buildBrief({ ...base, profile: plain, seed }).brief;
      // A brief that tells the writer to emit style="..." on a platform that
      // strips it guarantees a blocked draft.
      expect(text).not.toMatch(/style\s*=\s*"/);
    }
  });

  it('still instructs inline styles when the platform keeps them', () => {
    const text = buildBrief({ ...base, profile: GHOST_HTML_PROFILE, seed: 1 }).brief;
    expect(text).toMatch(/style\s*=\s*"/);
  });

  it('a brief built for a style-stripping platform scores clean on it', () => {
    // The contract: following the brief must not produce a blocked draft.
    const text = buildBrief({ ...base, profile: plain, seed: 7 }).brief;
    const instructed = [...text.matchAll(/<(\w+)[^>]*style=/g)].map((m) => m[1]);
    expect(instructed).toEqual([]);
  });

  // `notes` is authored per-platform and copied into the brief verbatim
  // (Ghost's legitimately says "Use a styled <table>..."), so this fixture
  // gives its own notes rather than reusing `plain`'s Ghost-derived ones —
  // that keeps the assertion below scoped to the GENERATED prose in
  // `htmlRules()`, which is the only thing this fix is allowed to change.
  const stripped = {
    ...GHOST_HTML_PROFILE,
    platform: 'stripped',
    label: 'StrippedCo',
    inlineStyles: false,
    notes: [
      'Do NOT add a target attribute to any link.',
      'Never write id attributes on headings.',
    ],
  };

  it('never instructs a styled container when the platform strips inline styles', () => {
    const text = buildBrief({ ...base, profile: stripped, seed: 5 }).brief;
    expect(text).not.toMatch(/use a styled/i);
  });

  it('still instructs a styled container for Ghost', () => {
    const text = buildBrief({ ...base, profile: GHOST_HTML_PROFILE, seed: 5 }).brief;
    expect(text).toMatch(/use a styled <table>/i);
  });

  // Regression: a profile with an empty `unwrapped` set (WordPress, for an
  // account holding unfiltered_html — nothing is unwrapped on ingest for that
  // account) must not render "NEVER use ${unwrapped}" with nothing after it.
  it('omits the "NEVER use" line entirely when nothing is unwrapped', () => {
    const nothingUnwrapped = {
      ...GHOST_HTML_PROFILE,
      platform: 'testnowrap',
      label: 'TestNoWrap',
      unwrapped: new Set<string>(),
    };
    const text = buildBrief({ ...base, profile: nothingUnwrapped, seed: 5 }).brief;
    expect(text).not.toMatch(/NEVER use\s*\./i);
    expect(text).not.toContain('NEVER use .');
  });
});

// Regression (I4): the HTML rules header used to claim "VERIFIED BY LIVE
// PROBE" unconditionally, regardless of `profile.verified` — which was wrong
// for WordPress's restrictive (unfiltered_html: false) profile, never
// measured against a real account. The header must reflect the actual
// profile passed in, not a hardcoded claim.
describe('honest per-profile provenance header (I4)', () => {
  it('claims VERIFIED BY LIVE PROBE for a verified profile', () => {
    expect(GHOST_HTML_PROFILE.verified).toBe(true);
    const text = buildBrief({ ...base, profile: GHOST_HTML_PROFILE, seed: 2 }).brief;
    expect(text).toContain('HTML RULES (GHOST — STRICT, VERIFIED BY LIVE PROBE)');
  });

  it('does NOT claim VERIFIED BY LIVE PROBE for an unverified profile', () => {
    const unverified = {
      ...GHOST_HTML_PROFILE,
      platform: 'testunverified',
      label: 'TestUnverified',
      verified: false,
    };
    const text = buildBrief({ ...base, profile: unverified, seed: 2 }).brief;
    expect(text).not.toContain('VERIFIED BY LIVE PROBE');
    expect(text).toContain('HTML RULES (TESTUNVERIFIED — STRICT, UNVERIFIED');
  });
});

// The image contract reaches the writer. Images were the one visual element in
// this project left to improvisation — TABLE_THEMES pins a table's box-shadow
// blur to the hex digit while an image was specified in eleven words.
describe('image contract in the brief', () => {
  it('exposes the imported look list rather than a second copy of it', () => {
    // Identity, not deep equality. Two hand-maintained copies of one rule is
    // how SLUG_PATTERN and the providers' env var names drifted before.
    expect(DIMENSIONS.imageLook).toBe(IMAGE_LOOKS);
  });

  it('states images are on by default and names the look that was picked', () => {
    const b = buildBrief({ ...base, seed: 11 });
    expect(b.brief).toMatch(/ON BY DEFAULT/);
    expect(IMAGE_LOOKS.some((look) => b.brief.includes(look))).toBe(true);
  });

  // Found in real use: an agent with a working image key still often skipped
  // calling generate_image, because the old wording only said HOW to write
  // an image prompt, never that doing so was the default outcome unless the
  // user said otherwise. This is the phrasing that closes that gap, and it
  // is only honest to promise when a provider is actually configured.
  it('frames images as the default, overridable only by the user\'s own instruction', () => {
    const text = buildBrief({ ...base, seed: 11, imageProviders: ['gemini'] }).brief;
    expect(text).toMatch(/BY DEFAULT/);
    // \s+ rather than a literal space: the source wraps this phrase across a
    // line for readability, which embeds a real newline in the string.
    expect(text).toMatch(/unless\s+the\s+user\s+explicitly\s+said/i);
    expect(text).toMatch(/user's instruction always overrides/i);
  });

  it('does not ask for images at all when no provider is configured', () => {
    const text = buildBrief({ ...base, seed: 11, imageProviders: [] }).brief;
    // The instruction NOT to write the placeholder legitimately names it —
    // "do not write [[content_image]]" has to say the string to forbid it.
    // What must be absent is any instruction to PLACE one.
    expect(text).not.toMatch(/Place the \[\[content_image\]\] placeholder/);
    expect(text).not.toMatch(/Leave the literal text \[\[content_image\]\]/);
    expect(text).not.toMatch(/photoreal_people/);
    expect(text).not.toMatch(/generate_image with style/);
    // The JSON contract itself must not ask for image prompts nothing will
    // ever call generate_image with.
    expect(text).not.toContain('hero_image_prompt');
    expect(text).not.toContain('inline_image_prompt');
    expect(text).toMatch(/no image provider is configured/i);
    expect(text).toMatch(/publishes with NO/i);
  });

  it('omitting imageProviders assumes a provider exists, so every existing test above keeps its old meaning', () => {
    // BriefInput.imageProviders is optional specifically so the 30+ call
    // sites in this file that predate the field keep testing the image
    // content they were written to test, without every one of them having to
    // learn about provider configuration just to compile.
    const withField = buildBrief({ ...base, seed: 11, imageProviders: ['gemini'] }).brief;
    const omitted = buildBrief({ ...base, seed: 11 }).brief;
    expect(omitted).toBe(withField);
  });

  it('tells the writer the hero image must contain people, and which style to pass', () => {
    const text = buildBrief({ ...base, seed: 3 }).brief;
    expect(text).toMatch(/photoreal_people/);
    expect(text).toMatch(/photoreal_scene/);
    // The requirement itself, not just the parameter name.
    expect(text).toMatch(/people/i);
  });

  it('demands the prompt name THIS article\'s subject, which is what makes it relevant', () => {
    const text = buildBrief({ ...base, seed: 5 }).brief;
    expect(text).toMatch(/THIS article/i);
  });

  it('keeps every dimension reproducible from a seed once the look is added', () => {
    const a = buildBrief({ ...base, seed: 99 });
    const b = buildBrief({ ...base, seed: 99 });
    expect(a.brief).toBe(b.brief);
    expect(a.choices.imageLook).toBe(b.choices.imageLook);
  });
});

// The brief displays a seeded look AND the tool derives its own from a subject
// hash when none is passed. Printing a real brief showed the block promising a
// register the tool would then ignore — the brief has to tell the writer to
// pass it through, or it is describing something that will not happen.
describe('the brief does not promise a look the tool will not use', () => {
  it('tells the writer to pass the picked look through to generate_image', () => {
    const text = buildBrief({ ...base, seed: 11 }).brief;
    expect(text).toMatch(/look:/);
    expect(text).toMatch(/verbatim/i);
  });

  it('says what happens if the writer omits it, rather than leaving it implied', () => {
    expect(buildBrief({ ...base, seed: 11 }).brief).toMatch(/tool picks its own/i);
  });
});

// The brief claimed [[content_image]] "is replaced with a <figure> after the
// image is uploaded". Nothing replaces it — no code anywhere — so the caller
// must, and the brief never said with what markup. That is why a hand-written
// bare <img> overflowed its column on WordPress.
describe('the [[content_image]] replacement is specified, not implied', () => {
  it('names the caller as the one who replaces it, and warns both platforms refuse it', () => {
    const text = buildBrief({ ...base, seed: 4 }).brief;
    expect(text).toMatch(/YOU replace it yourself/);
    expect(text).toMatch(/REFUSE an article that still contains it/);
  });

  it('gives exact figure markup that cannot overflow, where styles survive', () => {
    // Ghost preserves inline styles, so the sizing that stops an image
    // breaking out of the content column is stated outright.
    const text = buildBrief({ ...base, seed: 4 }).brief;
    expect(text).toMatch(/<figure style=/);
    expect(text).toMatch(/width:100%;height:auto/);
    expect(text).toMatch(/border-radius/);
  });

  it('drops every style from the figure where the platform strips them', () => {
    // The restrictive WordPress path: KSES strips style=, so instructing it
    // would train the writer to produce attributes the platform discards —
    // the same mistake as asking Ghost for target="_blank". Caught by an
    // existing test that asserts the restrictive brief instructs NO styled tag.
    const restrictive = { ...GHOST_HTML_PROFILE, inlineStyles: false };
    const text = buildBrief({ ...base, profile: restrictive, seed: 4 }).brief;
    expect(text).toMatch(/<figure><img src="URL"/);
    expect(text).not.toMatch(/<figure style=/);
    expect(text).toMatch(/theme sizes the image/i);
  });
});

// The brief's research block had no test at all: a refactor that re-sorted
// findings by date, dropped `relevance`, or printed an unreadable string as a
// date passed the whole suite. These assert the text a writer actually reads.
describe('the research block tells the truth about each finding', () => {
  const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const finding = (over: Partial<Finding> & { url: string }): Finding => ({
    title: `Title for ${over.url}`,
    snippet: `Snippet for ${over.url}`,
    publishedAt: iso(HOUR),
    relevance: null,
    provider: 'tavily',
    ...over,
  });

  const result = (findings: Finding[], window: 'day' | 'week' | 'month' = 'day'): ResearchResult => ({
    provider: 'tavily',
    query: 'cricket',
    window,
    selectedBy: 'sole-configured',
    findings,
  });

  it("keeps the provider's order and never re-sorts by date", () => {
    // Oldest first, newest last — the order a date sort would invert. Provider
    // ranking is the only defence against a provider backfilling off-topic
    // filler stamped today (measured), so date order must never win.
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://first.test/a', publishedAt: iso(20 * HOUR) }),
        finding({ url: 'https://second.test/b', publishedAt: iso(10 * HOUR) }),
        finding({ url: 'https://third.test/c', publishedAt: iso(1 * HOUR) }),
      ]),
    });
    const order = ['https://first.test/a', 'https://second.test/b', 'https://third.test/c'].map(
      (u) => b.brief.indexOf(u),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(b.brief).toContain('[1] Title for https://first.test/a');
    expect(b.brief).toContain('[3] Title for https://third.test/c');
  });

  it('surfaces relevance when the provider scores it, and prints no relevance line when it does not', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://scored.test/a', relevance: 0.087 }),
        finding({ url: 'https://unscored.test/b', relevance: null }),
      ]),
    });
    expect(b.brief).toContain('relevance 0.09');
    // One relevance line only — the null one must not render as "relevance null".
    expect(b.brief.match(/relevance /g)).toHaveLength(1);
    expect(b.brief).not.toContain('relevance null');
  });

  it('says NO DATE GIVEN where the date would go, and warns how many', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://dated.test/a' }),
        finding({ url: 'https://undated.test/b', publishedAt: null }),
      ]),
    });
    expect(b.brief).toContain('NO DATE GIVEN by tavily — do not assert when this happened');
    expect(b.warnings).toContain(
      '1 of 2 sources carry no usable publication date — do not assert when those events happened.',
    );
  });

  it('treats an unreadable and a future date as no date at all', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://ok.test/a' }),
        finding({ url: 'https://junk.test/b', publishedAt: 'yesterday-ish' }),
        finding({ url: 'https://future.test/c', publishedAt: '2099-01-01T00:00:00.000Z' }),
      ]),
    });
    expect(b.brief).toContain('is not a readable date');
    expect(b.brief).toContain('which is in the future');
    // Neither is counted as dated, and neither is printed as a bare date.
    expect(b.brief).toContain('3 source(s), 1 dated, 1 inside the day window');
    expect(b.warnings).toContain(
      '2 of 3 sources carry no usable publication date — do not assert when those events happened.',
    );
  });

  it('marks an out-of-window source next to it, and warns how many', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://fresh.test/a', publishedAt: iso(4 * 60 * 1000) }),
        finding({ url: 'https://stale.test/b', publishedAt: iso(90 * DAY) }),
      ]),
    });
    expect(b.brief).toContain('OUTSIDE the day window this research asked for');
    expect(b.brief).toContain('do not present it as recent');
    expect(b.warnings).toContain(
      '1 of 2 sources fall outside the day window this research asked for — they are marked in the brief; do not present them as recent.',
    );
    // The fresh one carries no marker, so the two cannot be confused.
    expect(b.brief.match(/OUTSIDE the day window/g)).toHaveLength(1);
  });

  it('reports in-window count in the ORIGIN header, not just a total', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://fresh.test/a' }),
        finding({ url: 'https://stale.test/b', publishedAt: iso(90 * DAY) }),
        finding({ url: 'https://undated.test/c', publishedAt: null }),
      ]),
    });
    expect(b.brief).toContain(
      'ORIGIN: tavily, day window, 3 source(s), 2 dated, 1 inside the day window. Selected by: sole-configured.',
    );
    expect(b.researchOrigin).toBe('provider');
  });

  it('leaves an in-window source unmarked and unwarned', () => {
    const b = buildBrief({
      ...base,
      findings: result([finding({ url: 'https://fresh.test/a', publishedAt: iso(4 * 60 * 1000) })]),
    });
    expect(b.warnings).toEqual([]);
    expect(b.brief).not.toContain('OUTSIDE the');
    expect(b.brief).not.toContain('NO DATE GIVEN');
  });

  // Follow-up review N2: `Date.parse` alone is too permissive to define "a
  // readable date" — "5", "0", a bare year, and a year-month all parse
  // successfully, so a truthiness-plus-Date.parse guard let them through as
  // dated, out-of-window, and printed BARE in the date position: "5 —
  // OUTSIDE the day window…". A fragment that is not a date must never be
  // printed where a date goes, exactly like an unparseable string.
  it('treats date-shaped junk (a bare year, year-month, or bare number) as no usable date, never prints it bare', () => {
    const b = buildBrief({
      ...base,
      findings: result([
        finding({ url: 'https://ok.test/a' }),
        finding({ url: 'https://year.test/b', publishedAt: '2026' }),
        finding({ url: 'https://yearmonth.test/c', publishedAt: '2026-07' }),
        finding({ url: 'https://num.test/d', publishedAt: '5' }),
      ]),
    });
    expect(b.brief).toContain('gave "2026", which is not a readable date');
    expect(b.brief).toContain('gave "2026-07", which is not a readable date');
    expect(b.brief).toContain('gave "5", which is not a readable date');
    // None of the junk values is ever printed bare, the way a real date
    // would be — e.g. "5 — OUTSIDE the day window" or "2026 — OUTSIDE".
    expect(b.brief).not.toMatch(/^5 —/m);
    expect(b.brief).not.toMatch(/^2026 —/m);
    expect(b.brief).not.toMatch(/^2026-07 —/m);
    expect(b.brief).toContain('4 source(s), 1 dated, 1 inside the day window');
    expect(b.warnings).toContain(
      '3 of 4 sources carry no usable publication date — do not assert when those events happened.',
    );
  });
});

describe('author presence — the persona is not restated on every article', () => {
  // The defect this dimension exists for: the brief used to hardcode "State the
  // author's credential once, early, in the first person" on EVERY article, so
  // a blog written weekly reintroduced the same person every week.
  it('no longer orders the credential stated on every article', () => {
    for (let s = 0; s < 60; s++) {
      const b = buildBrief({ ...base, seed: s }).brief;
      expect(b, `seed ${s}`).not.toContain("State the author's credential once, early");
    }
  });

  it('always carries exactly one drawn AUTHOR PRESENCE instruction', () => {
    for (let s = 0; s < 40; s++) {
      const b = buildBrief({ ...base, seed: s });
      expect(b.brief).toContain('=== AUTHOR PRESENCE');
      expect(b.brief).toContain(PERSONA_PRESENCES[b.choices.personaPresence!]);
      // One drawn option, never two — a second would contradict the first.
      const present = PERSONA_PRESENCES.filter((o) => b.brief.includes(o));
      expect(present, `seed ${s}`).toHaveLength(1);
    }
  });

  // Four of the five options must not state a credential at all. If the pool
  // ever drifts toward "state it" variants, the whole point is lost.
  it('keeps most variants credential-free', () => {
    const statesIt = PERSONA_PRESENCES.filter((o) => /Stated once, plainly/.test(o));
    expect(statesIt).toHaveLength(1);
    expect(PERSONA_PRESENCES.length).toBeGreaterThanOrEqual(4);
  });

  // The standing rules that hold whichever variant is drawn.
  it('forbids the pasted-profile constructions on every seed', () => {
    for (let s = 0; s < 30; s++) {
      const b = buildBrief({ ...base, seed: s }).brief;
      expect(b).toContain('Never open a sentence with "As a CTO," or "In my experience as a CTO,"');
      expect(b).toContain('Never restate your expertise in the conclusion');
      expect(b).toContain('Never state your years of experience as a number');
    }
  });

  // The profile block is input to the writer's judgement, not text to copy.
  // Without this the model reproduces "Tone of voice: Dry" as a sentence.
  it('marks the author profile as shaping HOW to write, not what to say', () => {
    const b = buildBrief({ ...base, seed: 3 }).brief;
    expect(b).toContain('this shapes HOW you write, and is never copied onto the page');
    expect(b).toContain('None of these labels should ever appear as text in the article');
  });

  it('still tells the model who it is, so voice and judgement survive', () => {
    const b = buildBrief({ ...base, seed: 5 }).brief;
    expect(b).toContain('You are Jane Doe');
    expect(b).toContain('Write in FIRST PERSON as Jane Doe');
  });
});

describe('humanising rules', () => {
  it('draws exactly one texture and always carries the fixed rules', () => {
    for (let s = 0; s < 40; s++) {
      const b = buildBrief({ ...base, seed: s });
      expect(b.brief).toContain(HUMAN_TEXTURES[b.choices.humanTexture!]);
      expect(HUMAN_TEXTURES.filter((o) => b.brief.includes(o)), `seed ${s}`).toHaveLength(1);
      expect(b.brief).toContain('=== NEVER USE THESE ===');
      expect(b.brief).toContain('=== STRUCTURAL TELLS');
    }
  });

  // The structural rules are the half that actually matters; a word blacklist
  // alone just moves the tell somewhere else.
  it.each([
    'Paragraph length must be genuinely uneven',
    'Do not open two paragraphs in a row with the same word',
    'Do not write three consecutive sentences of similar length',
    'Take a position',
    'at least one sentence that only you could have written',
  ])('keeps the structural rule: %s', (rule) => {
    expect(buildBrief({ ...base, seed: 11 }).brief).toContain(rule);
  });

  // Sounding human must never become licence to invent. This is the one
  // failure here that cannot be undone once published.
  it('forbids fabrication as a humanising technique', () => {
    const b = buildBrief({ ...base, seed: 2 }).brief;
    expect(b).toContain('Do not introduce errors, typos, or slang');
    // Asserted up to the line wrap in the template, not through it.
    expect(b).toContain('Do not fabricate a statistic, a client, a date');
    expect(b).toContain('prior article you never wrote');
    expect(b).toContain('an invented specific is worse than a missing');
  });

  // The "assumed familiarity" variant gets closest to inventing a shared
  // history, so it has to carry the prohibition itself rather than relying on
  // a general rule further down the brief.
  it('stops the assumed-familiarity variant inventing a back catalogue', () => {
    const familiar = PERSONA_PRESENCES.find((o) => /Assumed familiarity/.test(o))!;
    expect(familiar).toContain('Do not invent a shared history');
    expect(familiar).toContain('no reference to a specific earlier article');
  });

  it('bans the tells that survived the old short list', () => {
    const b = buildBrief({ ...base, seed: 1 }).brief;
    for (const word of ['myriad', 'pivotal', 'leverage (as a verb)', 'moreover', 'furthermore']) {
      expect(b, word).toContain(word);
    }
  });
});

describe('appending dimensions did not disturb the existing ones', () => {
  // `buildBrief` draws one RNG value per dimension in insertion order, so a
  // dimension inserted anywhere but the END silently rewrites which hook, arc
  // and voice every previously recorded seed resolves to. These are the picks
  // measured immediately before personaPresence/humanTexture were added.
  it('resolves recorded seeds to the same hook, arc and voice as before', () => {
    // Captured by running buildBrief on the commit immediately BEFORE
    // personaPresence/humanTexture existed, not written from memory. Seeds
    // 0-29 were compared in full at the time; these five are the pinned
    // regression.
    const recorded: Record<number, [number, number, number]> = {
      0: [1, 0, 0],
      1: [3, 0, 2],
      2: [3, 1, 1],
      7: [0, 0, 3],
      29: [1, 0, 1],
    };
    for (const [seed, [hook, arc, voice]] of Object.entries(recorded)) {
      const c = buildBrief({ ...base, seed: Number(seed) }).choices;
      expect([c.hook, c.arc, c.voice], `seed ${seed}`).toEqual([hook, arc, voice]);
    }
  });
});

describe('persona extras — fields the schema does not name', () => {
  const withExtras = (extras: Record<string, string>) => ({
    ...base,
    persona: { ...PERSONA, extras } as Persona,
  });

  // The defect: zod strips unknown keys, so a 51-field persona silently became
  // 27 and the other 24 were discarded with no error and no way to tell.
  it('carries an unrecognised field into the brief instead of discarding it', () => {
    const b = buildBrief({ ...withExtras({ newsletter_style: 'Short, one idea per issue' }), seed: 1 }).brief;
    expect(b).toContain('=== ADDITIONAL AUTHOR DIRECTION ===');
    expect(b).toContain('newsletter style: Short, one idea per issue');
  });

  it('omits the block entirely when there are no extras', () => {
    expect(buildBrief({ ...withExtras({}), seed: 1 }).brief).not.toContain('ADDITIONAL AUTHOR DIRECTION');
  });

  // Stating one instruction twice in one prompt, in two registers, leaves the
  // model to weight them arbitrarily.
  it('does not also print a wired field as free text', () => {
    const b = buildBrief({
      ...withExtras({ avoid_in_writing: 'Clickbait', unwired_thing: 'Something else' }),
      seed: 1,
    }).brief;
    expect(b).toContain("Also never, per this author's own rules: Clickbait");
    const block = b.slice(b.indexOf('ADDITIONAL AUTHOR DIRECTION'));
    expect(block).toContain('unwired thing');
    expect(block).not.toContain('avoid in writing');
  });

  it.each([
    ['target_audience', 'Founders, CTOs', 'Written for: Founders, CTOs'],
    ['citation_preference', 'Government sources', 'Prefer these sources, in this order: Government sources'],
    ['use_of_humor', 'Light, never sarcastic', 'Humour: Light, never sarcastic'],
    ['preferred_quotes_from', 'Peter Drucker', 'prefer: Peter Drucker'],
  ])('wires %s into the section it belongs to', (key, value, expected) => {
    expect(buildBrief({ ...withExtras({ [key]: value }), seed: 1 }).brief).toContain(expected);
  });

  describe('preferred_article_length sets the default word count', () => {
    const wc = (v: string) => buildBrief({ ...withExtras({ preferred_article_length: v }), seed: 1 }).brief;

    it.each([
      ['1200-3500 words', 1200],
      ['about 2000', 2000],
      ['1,500+', 1500],
    ])('reads %o as a floor of %i', (input, expected) => {
      expect(wc(input)).toContain(`Minimum length: ${expected} words`);
    });

    // A caller asking for a length is deciding about THIS article; the persona
    // is a standing preference.
    it('yields to an explicit wordCount', () => {
      const b = buildBrief({
        ...withExtras({ preferred_article_length: '3000 words' }),
        wordCount: 700,
        seed: 1,
      }).brief;
      expect(b).toContain('Minimum length: 700 words');
    });

    it('falls back to 800 rather than fabricating a number it cannot parse', () => {
      expect(wc('as long as it needs to be')).toContain('Minimum length: 800 words');
    });
  });

  // `tsc` covers src/** only, so a double cast to Persona can reach the brief
  // without `extras` and turn every read into a TypeError.
  it('survives a persona built without extras at all', () => {
    const noExtras = { ...PERSONA } as Persona;
    delete (noExtras as Partial<Persona>).extras;
    expect(() => buildBrief({ ...base, persona: noExtras, seed: 1 })).not.toThrow();
  });
});

describe('news mode is reporting, not commentary', () => {
  const news = (seed: number) => buildBrief({ ...base, mode: 'news' as const, seed }).brief;

  it('draws a news lede and a report structure, not the blog hook and arc', () => {
    for (let s = 0; s < 30; s++) {
      const b = buildBrief({ ...base, mode: 'news' as const, seed: s });
      expect(b.brief).toContain(NEWS_LEDES[b.choices.newsLede!]);
      expect(b.brief).toContain(NEWS_STRUCTURES[b.choices.newsStructure!]);
    }
  });

  // The blog hook pool asks for a contrarian claim or a rhetorical question —
  // both wrong in a report.
  it('does not use the blog hook or arc in news mode', () => {
    const b = news(4);
    expect(HOOKS.some((h) => b.includes(h))).toBe(false);
    expect(b).not.toContain('=== HOOK — FOLLOW EXACTLY ===');
  });

  it.each([
    'No "I", no "we", no first-hand anecdote',
    'ATTRIBUTION IS THE WHOLE JOB',
    'Attribute to the most specific source you actually have',
    'a fabricated quote is the one error a',
    'No call to action',
    'last 30 days',
  ])('states the reporting rule: %s', (rule) => {
    expect(news(6)).toContain(rule);
  });

  // The news block must beat the persona machinery it contradicts, and say so.
  it('explicitly overrides AUTHOR PRESENCE rather than silently conflicting', () => {
    const b = news(9);
    expect(b).toContain('where the two disagree, this section wins');
    expect(b).toContain('AUTHOR PRESENCE below is overridden');
  });

  it('keeps the blog rules out of blog mode’s way', () => {
    const b = buildBrief({ ...base, mode: 'blog' as const, seed: 6 }).brief;
    expect(b).not.toContain('ATTRIBUTION IS THE WHOLE JOB');
    expect(b).toContain('=== HOOK — FOLLOW EXACTLY ===');
  });

  // Drawing conditionally would desync every later dimension between modes.
  it('draws the news dimensions on blog briefs too, so seeds stay aligned', () => {
    for (let s = 0; s < 20; s++) {
      const blog = buildBrief({ ...base, mode: 'blog' as const, seed: s }).choices;
      const rep = buildBrief({ ...base, mode: 'news' as const, seed: s }).choices;
      expect(blog.newsLede, `seed ${s}`).toBe(rep.newsLede);
      expect(blog.humanTexture, `seed ${s}`).toBe(rep.humanTexture);
      expect(blog.personaPresence, `seed ${s}`).toBe(rep.personaPresence);
    }
  });
});

describe('no section contradicts news mode', () => {
  // The brief is one prompt. A news block that forbids first person while the
  // EVIDENCE section demands "two concrete first-hand moments" leaves the
  // model to choose, which is the same brief-versus-brief contradiction that
  // made score_draft disagree with AUTHOR PRESENCE.
  it.each([
    'first-hand moments',
    'a number from your own delivery work',
    'Establish authority the way AUTHOR PRESENCE',
    'MICRO-STORY',
    'NARRATIVE VOICE',
    'Write in FIRST PERSON',
    'AUTHOR PRESENCE — HOW MUCH OF YOU',
    'CONCLUSION AND CTA',
    'STRUCTURE ARC',
  ])('news mode never says %o', (phrase) => {
    for (let s = 0; s < 20; s++) {
      expect(buildBrief({ ...base, mode: 'news' as const, seed: s }).brief, `seed ${s}`).not.toContain(phrase);
    }
  });

  it('blog mode still says all of them', () => {
    const b = buildBrief({ ...base, mode: 'blog' as const, seed: 3 }).brief;
    for (const phrase of ['first-hand moments', 'MICRO-STORY', 'AUTHOR PRESENCE — HOW MUCH OF YOU', 'CONCLUSION AND CTA', 'Write in FIRST PERSON']) {
      expect(b, phrase).toContain(phrase);
    }
  });

  it('replaces them with the reporting equivalent rather than just deleting them', () => {
    const b = buildBrief({ ...base, mode: 'news' as const, seed: 3 }).brief;
    expect(b).toContain('Authority in a report comes from sourcing');
    expect(b).toContain('at least one attributed claim per 200 words');
    expect(b).toContain('Write in the THIRD PERSON');
  });
});
