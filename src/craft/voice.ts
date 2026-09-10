// Deliberate circular import: score.ts imports from this file too. It only
// works because this module never reads THRESHOLDS (or any other score.ts
// export) at module top level — only inside function bodies, after both
// modules have finished loading. Move a THRESHOLDS read to top level here and
// the cycle breaks at load time.
import { sentences, THRESHOLDS } from './score.js';

/**
 * A statistical sketch of how someone writes, built from either a persona's
 * own `voice_samples` or a draft under score. The two are compared
 * sentence-shape to sentence-shape by `compareVoice` — this file never reads
 * for content or meaning, only rhythm.
 */
export interface VoiceFingerprint {
  sentences: number;
  /** Words per sentence, mean, 1 decimal. */
  meanLength: number;
  /** Sentence-length standard deviation, in words, 1 decimal. */
  sd: number;
  /**
   * Share of sentences containing a real contraction, 0..1: `n't`, `'re`,
   * `'ve`, `'ll`, `'d`, `'m` on any word, or `'s` — but only right after
   * it/that/there/here/he/she/what/who/where/how/let, where `'s` contracts
   * "is" or "has". A possessive `'s` ("the client's feedback", "Sam's dog")
   * is not a contraction and is never counted.
   */
  contractionRate: number;
  /** Share of sentences containing a first-person pronoun, 0..1. */
  firstPersonRate: number;
}

// A contraction: a word ending in an apostrophe + t/re/ve/ll/d/m — "don't",
// "we're", "we've", "we'll", "we'd", "I'm" — OR an apostrophe-s that
// contracts "is"/"has", which only happens right after one of the
// pronouns/determiners that take it: it's, that's, there's, here's, he's,
// she's, what's, who's, where's, how's, let's. A bare `'s` anywhere else is
// a possessive ("the client's feedback", "Sam's dog"), not a contraction,
// and must not be counted — that was this regex's bug before this fix.
// Either apostrophe glyph, since pasted prose commonly carries the curly one.
const CONTRACTION =
  /\w['’](?:t|re|ve|ll|d|m)\b|\b(?:it|that|there|here|he|she|what|who|where|how|let)['’]s\b/i;

const FIRST_PERSON = /\b(i|we|my|our|me|us)\b/i;

function mean(ns: number[]): number {
  return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length;
}

function stdev(ns: number[]): number {
  if (ns.length < 2) return 0;
  const m = mean(ns);
  return Math.sqrt(ns.reduce((a, b) => a + (b - m) ** 2, 0) / ns.length);
}

/** Fingerprint a passage of plain text (no HTML) — a persona's own writing, or a stripped draft. */
export function voiceFingerprint(text: string): VoiceFingerprint {
  const sents = sentences(text);
  const lengths = sents.map((s) => s.split(/\s+/).length);
  const contractions = sents.filter((s) => CONTRACTION.test(s)).length;
  const firstPerson = sents.filter((s) => FIRST_PERSON.test(s)).length;
  return {
    sentences: sents.length,
    meanLength: Number(mean(lengths).toFixed(1)),
    sd: Number(stdev(lengths).toFixed(1)),
    contractionRate: sents.length ? contractions / sents.length : 0,
    firstPersonRate: sents.length ? firstPerson / sents.length : 0,
  };
}

/** Render a 0..1 rate as a rounded whole-number percentage, e.g. 0.4 -> 40. */
export const pct = (rate: number): number => Math.round(rate * 100);

/**
 * Compare a draft's rhythm against an author's own voice sample.
 *
 * Advisory by nature: this can only ever say "this doesn't sound like you",
 * never "this is wrong". Both checks are independent — a draft can trip
 * either, neither, or both.
 */
export function compareVoice(
  sample: VoiceFingerprint,
  draft: VoiceFingerprint,
): { ok: boolean; findings: string[] } {
  const findings: string[] = [];

  const lower = sample.meanLength * (1 - THRESHOLDS.voiceLengthTolerance);
  const upper = sample.meanLength * (1 + THRESHOLDS.voiceLengthTolerance);
  if (draft.meanLength < lower || draft.meanLength > upper) {
    findings.push(
      `Sentences average ${draft.meanLength} words; the author's samples average ${sample.meanLength}. Shorten/lengthen toward that.`,
    );
  }

  if (
    sample.contractionRate >= THRESHOLDS.voiceContractionHigh &&
    draft.contractionRate < THRESHOLDS.voiceContractionLow
  ) {
    findings.push(
      `The author contracts in ${pct(sample.contractionRate)}% of sentences; the draft in ${pct(draft.contractionRate)}%. Write "doesn't", not "does not".`,
    );
  }
  if (
    draft.contractionRate >= THRESHOLDS.voiceContractionHigh &&
    sample.contractionRate < THRESHOLDS.voiceContractionLow
  ) {
    findings.push(
      `The draft contracts in ${pct(draft.contractionRate)}% of sentences; the author's samples in ${pct(sample.contractionRate)}%. Write "does not", not "doesn't" — the author's own writing rarely contracts.`,
    );
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Split a persona's `voice_samples` extra into separate passages.
 *
 * Splits on blank lines rather than on the array boundary that
 * `splitExtras` originally received, because by the time this runs
 * `voice_samples` has already been flattened to one string (see
 * `src/config/personas.ts`'s special-cased join for this key).
 */
export function normaliseSamples(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
