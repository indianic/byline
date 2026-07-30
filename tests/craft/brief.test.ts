import { describe, expect, it } from 'vitest';
import type { Persona } from '../../src/config/personas.js';
import { buildBrief } from '../../src/craft/brief.js';
import { DIMENSIONS, HOOKS } from '../../src/craft/dimensions.js';
import { IMAGE_LOOKS } from '../../src/craft/image-style.js';
import { GHOST_HTML_PROFILE } from '../../src/plugins/platforms/ghost/html-profile.js';

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
