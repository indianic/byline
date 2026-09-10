import { describe, expect, it } from 'vitest';
import type { ArticleRecord } from '../../src/articles/types.js';
import type { Persona } from '../../src/config/personas.js';
import { buildBrief } from '../../src/craft/brief.js';
import { planSeries } from '../../src/craft/series.js';
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
  theme: 'migrating a legacy fleet to Kubernetes',
  mode: 'blog' as const,
  profile: GHOST_HTML_PROFILE,
};

describe('planSeries', () => {
  it('yields count slots with pairwise-distinct hooks and arcs', () => {
    const plan = planSeries({ ...base, count: 4, seed: 100 });
    expect(plan.slots).toHaveLength(4);
    expect(new Set(plan.slots.map((s) => s.choices.hook))).toHaveProperty('size', 4);
    expect(new Set(plan.slots.map((s) => s.choices.arc))).toHaveProperty('size', 4);
  });

  // The defect this replaces: at count 4, 200 candidates per slot failed to
  // find a fully-distinct shape for 13 of 299 seeds tried (measured), and the
  // old code threw SERIES_UNPLANNABLE. 5000 candidates per slot, scored on the
  // cheap `drawChoices` draw rather than a full brief, never has to give up at
  // this count: every one of hook/arc/humanTexture/personaPresence has at
  // least 4 options, so 4 slots can always be given 4 distinct indexes.
  it('never fails at count 4 across seeds 0..299, and every slot reports no repeats', () => {
    for (let seed = 0; seed < 300; seed++) {
      const plan = planSeries({ ...base, count: 4, seed });
      for (const dim of ['hook', 'arc', 'humanTexture', 'personaPresence'] as const) {
        const values = plan.slots.map((s) => s.choices[dim]);
        expect(new Set(values), `seed ${seed} dimension ${dim}`).toHaveProperty('size', 4);
      }
      for (const slot of plan.slots) {
        expect(slot.repeats, `seed ${seed} slot ${slot.n}`).toEqual([]);
      }
    }
  });

  it('every slot seed reproduces that slot\'s choices through buildBrief', () => {
    const plan = planSeries({ ...base, count: 4, seed: 100 });
    for (const slot of plan.slots) {
      const brief = buildBrief({
        persona: PERSONA,
        topic: base.theme,
        mode: base.mode,
        profile: base.profile,
        seed: slot.seed,
      });
      expect(brief.choices).toEqual(slot.choices);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = planSeries({ ...base, count: 4, seed: 100 });
    const b = planSeries({ ...base, count: 4, seed: 100 });
    expect(a).toEqual(b);
  });

  it('derives series_id from the seed, base36-prefixed', () => {
    const plan = planSeries({ ...base, count: 2, seed: 100 });
    expect(plan.series_id).toBe('srs-' + (100).toString(36));
    expect(plan.seed).toBe(100);
  });

  // At count 12, each of hook (5 options), arc (4), humanTexture (5) and
  // personaPresence (5) mathematically MUST repeat at least `count -
  // optionCount` times — there are only that many distinct indexes to go
  // around. This is not a failure: it never throws, and every forced repeat
  // is named in the slot's `repeats` array. The candidate search (5000 per
  // slot, scored on the cheap `drawChoices` draw) reliably finds the
  // theoretical minimum rather than settling for something worse.
  it('completes count: 12 with exactly the forced-minimum number of repeats per dimension', () => {
    const plan = planSeries({ ...base, count: 12, seed: 1 });
    expect(plan.slots).toHaveLength(12);

    // Every option of every SERIES_DIMENSIONS dimension must have been used
    // at least once by the time all 12 slots are filled.
    for (const dim of ['hook', 'arc', 'humanTexture', 'personaPresence'] as const) {
      const used = new Set(plan.slots.map((s) => s.choices[dim]));
      const optionCount = { hook: 5, arc: 4, humanTexture: 5, personaPresence: 5 }[dim];
      expect(used.size, dim).toBe(optionCount);
    }

    const repeatCounts: Record<string, number> = { hook: 0, arc: 0, humanTexture: 0, personaPresence: 0 };
    for (const slot of plan.slots) {
      for (const dim of slot.repeats) repeatCounts[dim] = (repeatCounts[dim] ?? 0) + 1;
    }
    // Forced minimum = count (12) - that dimension's option count.
    expect(repeatCounts.hook).toBe(7);
    expect(repeatCounts.arc).toBe(8);
    expect(repeatCounts.humanTexture).toBe(7);
    expect(repeatCounts.personaPresence).toBe(7);
  });

  it('reproduces every slot\'s choices through buildBrief at count 12 too', () => {
    const plan = planSeries({ ...base, count: 12, seed: 1 });
    for (const slot of plan.slots) {
      const brief = buildBrief({
        persona: PERSONA,
        topic: base.theme,
        mode: base.mode,
        profile: base.profile,
        seed: slot.seed,
      });
      expect(brief.choices).toEqual(slot.choices);
    }
  });

  it('completes a count-12 plan in under 500ms', () => {
    const start = performance.now();
    planSeries({ ...base, count: 12, seed: 1 });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('each slot preview holds the first 70 characters of the picked text', () => {
    const plan = planSeries({ ...base, count: 2, seed: 100 });
    for (const slot of plan.slots) {
      expect(slot.preview.hook!.length).toBeLessThanOrEqual(70);
      expect(slot.preview.arc!.length).toBeLessThanOrEqual(70);
      expect(slot.preview.humanTexture!.length).toBeLessThanOrEqual(70);
      expect(slot.preview.personaPresence!.length).toBeLessThanOrEqual(70);
    }
  });

  it('numbers slots from 1', () => {
    const plan = planSeries({ ...base, count: 3, seed: 100 });
    expect(plan.slots.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it('renders the SERIES PLAN prose verbatim, with no ALREADY PUBLISHED block when history is empty', () => {
    const plan = planSeries({ ...base, count: 3, seed: 100 });
    expect(plan.brief).toContain('=== SERIES PLAN — 3 ARTICLES ON: migrating a legacy fleet to Kubernetes ===');
    expect(plan.brief).toContain(`build_writing_brief({ seed: <slot seed>, series: "${plan.series_id}" })`);
    expect(plan.brief).not.toContain('ALREADY PUBLISHED');
  });

  it('appends the ALREADY PUBLISHED block when history.recent is non-empty', () => {
    const recent: ArticleRecord[] = [
      {
        id: 'personal:1',
        persona: 'jane-doe',
        site: 'personal',
        platform: 'ghost',
        post_id: '1',
        url: 'https://blog.example.com/prior-article/',
        title: 'Prior article',
        tags: [],
        status: 'published',
        recorded_at: '2026-01-01T00:00:00.000Z',
        shares: [],
      },
    ];
    const plan = planSeries({
      ...base,
      count: 3,
      seed: 100,
      history: { recent, avoid: {} },
    });
    expect(plan.brief).toContain('ALREADY PUBLISHED BY THIS AUTHOR');
    expect(plan.brief).toContain('Prior article — https://blog.example.com/prior-article/');
  });

  it('applies the caller\'s history.avoid to the anti-repeat draw for every slot', () => {
    // Same fixed seed as the tools.test.ts anti-repeat test: seed 6 draws
    // hook: 2 with no history for this persona/profile.
    const withoutHistory = planSeries({ ...base, count: 1, seed: 6 });
    expect(withoutHistory.slots[0]!.choices.hook).toBe(2);

    const withHistory = planSeries({
      ...base,
      count: 1,
      seed: 6,
      history: { recent: [], avoid: { hook: [2] } },
    });
    expect(withHistory.slots[0]!.choices.hook).not.toBe(2);
  });
});
