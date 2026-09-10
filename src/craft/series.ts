import type { ArticleRecord } from '../articles/types.js';
import type { Persona } from '../config/personas.js';
import { drawChoices, type BriefInput } from './brief.js';
import { dimensionsFor } from './dimensions.js';
import type { HtmlProfile } from './html-profile.js';

/**
 * The dimensions a reader would notice repeating across a pillar-and-spokes
 * series, specifically — a narrower set than `ANTI_REPEAT_DIMENSIONS` in
 * `dimensions.ts`. `voice`, `story` and `cta` are still drawn per slot (via
 * `drawChoices`'s own anti-repeat logic against the persona's ledger), but this
 * module only enforces distinctness on the four the task brief names: the
 * opening device, the essay architecture, the prose texture and how the author
 * shows up. One rule, one list — this is the only place that list is written.
 */
const SERIES_DIMENSIONS = ['hook', 'arc', 'humanTexture', 'personaPresence'] as const;
type SeriesDimension = (typeof SERIES_DIMENSIONS)[number];

/**
 * How many candidate seeds each slot tries before settling for its
 * lowest-collision candidate. `drawChoices` (the cheap RNG-only draw, not the
 * full brief text) is what gets evaluated 5000 times per slot, which is why
 * this can afford to be two orders of magnitude larger than a full-brief
 * candidate search would tolerate.
 */
const CANDIDATES_PER_SLOT = 5000;

/** The spacing between slots' candidate-seed ranges, so they never collide. */
const SLOT_SEED_STRIDE = 1009;

export interface SeriesSlot {
  /** 1-indexed position in the series — slot 1 is the pillar. */
  n: number;
  /** The seed to pass to `build_writing_brief` for this slot. */
  seed: number;
  /** Every dimension `buildBrief` drew for this seed, keyed by `DimensionName`. */
  choices: Record<string, number>;
  /**
   * Which of `SERIES_DIMENSIONS` this slot could not give a still-unused index
   * to, because every one of that dimension's options was already claimed by
   * an earlier slot. Empty when this slot is fully distinct from every slot
   * before it. Once a series runs longer than a dimension's option count,
   * some slot has to repeat that dimension — this says exactly which one, on
   * exactly which slot, instead of the plan silently doing it.
   */
  repeats: string[];
  /**
   * The first 70 characters of the picked text for `hook`, `arc`,
   * `humanTexture` and `personaPresence` — enough for a caller to see at a
   * glance that four slots really did draw four different shapes, without
   * reprinting the full (multi-hundred-character) instruction for each.
   */
  preview: Record<string, string>;
}

export interface SeriesPlan {
  /** `'srs-' + seed.toString(36)` — pass unchanged to `build_writing_brief`'s `series`. */
  series_id: string;
  seed: number;
  count: number;
  slots: SeriesSlot[];
  /** The SERIES PLAN prose — see the brief text below for exactly what it says. */
  brief: string;
}

export interface PlanSeriesInput {
  persona: Persona;
  theme: string;
  count: number;
  mode: 'blog' | 'news';
  profile: HtmlProfile;
  seed?: number;
  history?: BriefInput['history'];
}

/**
 * The SERIES PLAN prose, verbatim per the task brief. The ALREADY PUBLISHED
 * block is appended only when `history.recent` is non-empty — an article-less
 * persona has nothing to warn the plan away from repeating.
 */
function renderPlanBrief(
  theme: string,
  count: number,
  persona: Persona,
  seriesId: string,
  history: PlanSeriesInput['history'],
): string {
  const base = `=== SERIES PLAN — ${count} ARTICLES ON: ${theme} ===
Propose ${count} article titles for ${persona.name} that together cover this theme as a
pillar and spokes. Article 1 is the pillar: it answers the theme's head question for
a reader who knows nothing. Every later article is a spoke: it answers ONE long-tail
question a reader would type, in depth, and links back to the pillar once. No two
articles share a primary keyword. No two open with the same device — each slot below
has already been given a distinct hook, arc, texture and author presence; build the
brief for slot n with build_writing_brief({ seed: <slot seed>, series: "${seriesId}" })
and it will draw exactly that shape. Return the titles as a numbered list with each
article's primary keyword and the question it answers, then stop and show the user
before writing anything.`;

  if (!history?.recent || history.recent.length === 0) return base;

  const lines = history.recent.map((r: ArticleRecord) => `- ${r.title} — ${r.url}`).join('\n');
  return `${base}\nALREADY PUBLISHED BY THIS AUTHOR — do not propose these angles again:\n${lines}`;
}

/**
 * Allocate one seed per article in a pillar-and-spokes series, so no two
 * articles open with the same hook, follow the same arc, carry the same prose
 * texture, or surface the author the same way — and never fail to produce a
 * plan.
 *
 * For slot `i` (0-indexed internally, `n = i + 1` in the result), candidate
 * seeds `seriesSeed + i * 1009 + k` are scored for `k` in `0..4999` using
 * `drawChoices` — the cheap RNG-only draw, not the full brief text, which is
 * what makes 5000 candidates per slot affordable. A candidate's score is the
 * number of `SERIES_DIMENSIONS` whose drawn index is already used by an
 * earlier slot; the first candidate scoring 0 is taken immediately, and
 * otherwise the lowest-scoring candidate seen wins, ties broken toward the
 * lowest `k` (the search never overwrites an equal-scoring earlier candidate).
 * `history` (the caller's ledger-derived anti-repeat state) is passed through
 * to every `drawChoices` call unchanged, so a persona's own publishing history
 * still steers the draw the same way it does for a single article.
 *
 * This never throws. Measured against `SERIES_DIMENSIONS`' real option counts
 * (hook 5, arc 4, humanTexture 5, personaPresence 5): at `count` 4, roughly
 * 1 seed in 25 (13/299 measured) cannot give every slot a fully distinct
 * shape from a candidate pool of only 200 — the number this code used to try
 * before giving up with `SERIES_UNPLANNABLE`. At `count` 12, a forced repeat
 * on every one of the four dimensions is mathematically certain (12 slots,
 * fewer than 12 options each) and is not a failure — it is reported per slot
 * in `repeats`.
 */
export function planSeries(input: PlanSeriesInput): SeriesPlan {
  const seriesSeed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const series_id = `srs-${seriesSeed.toString(36)}`;
  const options = dimensionsFor(input.profile);

  // Per dimension: the set of indexes used by an already-accepted slot.
  const used: Record<SeriesDimension, Set<number>> = {
    hook: new Set(),
    arc: new Set(),
    humanTexture: new Set(),
    personaPresence: new Set(),
  };

  const slots: SeriesSlot[] = [];

  for (let i = 0; i < input.count; i++) {
    let best: { seed: number; choices: Record<string, number>; score: number } | undefined;

    for (let k = 0; k < CANDIDATES_PER_SLOT; k++) {
      const candidateSeed = seriesSeed + i * SLOT_SEED_STRIDE + k;
      const { choices } = drawChoices(candidateSeed, input.profile, input.history?.avoid);

      const score = SERIES_DIMENSIONS.reduce(
        (acc, dim) => acc + (used[dim].has(choices[dim]) ? 1 : 0),
        0,
      );

      // Strictly-less, never equal, so the FIRST (lowest-k) candidate at any
      // given score is the one kept — the tie-break the task brief requires.
      if (!best || score < best.score) {
        best = { seed: candidateSeed, choices: { ...choices } as Record<string, number>, score };
        if (score === 0) break;
      }
    }

    // `best` is always set: CANDIDATES_PER_SLOT >= 1, so at least k=0 is scored.
    const accepted = best!;
    const repeats = SERIES_DIMENSIONS.filter((dim) => used[dim].has(accepted.choices[dim]!));

    for (const dim of SERIES_DIMENSIONS) {
      used[dim].add(accepted.choices[dim]!);
    }

    slots.push({
      n: i + 1,
      seed: accepted.seed,
      choices: accepted.choices,
      repeats,
      preview: {
        hook: options.hook[accepted.choices.hook!]!.slice(0, 70),
        arc: options.arc[accepted.choices.arc!]!.slice(0, 70),
        humanTexture: options.humanTexture[accepted.choices.humanTexture!]!.slice(0, 70),
        personaPresence: options.personaPresence[accepted.choices.personaPresence!]!.slice(0, 70),
      },
    });
  }

  return {
    series_id,
    seed: seriesSeed,
    count: input.count,
    slots,
    brief: renderPlanBrief(input.theme, input.count, input.persona, series_id, input.history),
  };
}
