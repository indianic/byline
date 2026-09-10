import { describe, expect, it } from 'vitest';
import { compareVoice, normaliseSamples, voiceFingerprint, type VoiceFingerprint } from '../../src/craft/voice.js';

const fp = (overrides: Partial<VoiceFingerprint>): VoiceFingerprint => ({
  sentences: 10,
  meanLength: 20,
  sd: 5,
  contractionRate: 0,
  firstPersonRate: 0,
  ...overrides,
});

describe('voiceFingerprint', () => {
  it('counts sentences and computes the mean length', () => {
    const text =
      'This is one short sentence. Here is a second sentence that runs a bit longer than the first. ' +
      'Third one now. And a fourth sentence closes the passage out nicely.';
    const fp = voiceFingerprint(text);
    expect(fp.sentences).toBe(4);
    // words: 5, 13, 3, 9 -> mean 7.5
    expect(fp.meanLength).toBeCloseTo(7.5, 1);
  });

  it('measures the contraction rate across sentences', () => {
    const text =
      "I don't think that's right. This sentence has no contraction at all. " +
      "It's a good thing we checked twice. This one also has none in it.";
    const fp = voiceFingerprint(text);
    expect(fp.sentences).toBe(4);
    expect(fp.contractionRate).toBeCloseTo(0.5, 5);
  });

  it('does not count a possessive "\'s" as a contraction', () => {
    const fp = voiceFingerprint("The client's feedback was clear.");
    expect(fp.sentences).toBe(1);
    expect(fp.contractionRate).toBe(0);
  });

  it('counts "it\'s" as a contraction of "it is"', () => {
    const fp = voiceFingerprint("It's a good time.");
    expect(fp.sentences).toBe(1);
    expect(fp.contractionRate).toBe(1);
  });

  it('does not count a proper-noun possessive "\'s" as a contraction', () => {
    const fp = voiceFingerprint("Sam's dog barked.");
    expect(fp.sentences).toBe(1);
    expect(fp.contractionRate).toBe(0);
  });

  it('counts a sentence once even when it carries both "\'s" and "n\'t" contractions', () => {
    const fp = voiceFingerprint("That's why we don't.");
    expect(fp.sentences).toBe(1);
    expect(fp.contractionRate).toBe(1);
  });
});

describe('compareVoice', () => {
  const sample = fp({ meanLength: 20 });

  it('flags a draft whose sentences run far shorter than the samples (9 vs 20)', () => {
    const draft = fp({ meanLength: 9 });
    const result = compareVoice(sample, draft);
    expect(result.ok).toBe(false);
    expect(result.findings.join(' ')).toMatch(/Sentences average 9 words.*author's samples average 20/);
  });

  it('does not flag a draft within tolerance of the sample length (18 vs 20)', () => {
    const draft = fp({ meanLength: 18 });
    const result = compareVoice(sample, draft);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('flags when the author contracts heavily but the draft does not', () => {
    const heavySample = fp({ meanLength: 20, contractionRate: 0.4 });
    const flatDraft = fp({ meanLength: 20, contractionRate: 0.02 });
    const result = compareVoice(heavySample, flatDraft);
    expect(result.ok).toBe(false);
    expect(result.findings.join(' ')).toMatch(/does(n't| not)/);
  });

  it('flags the mirror case: the draft contracts heavily but the author does not', () => {
    const flatSample = fp({ meanLength: 20, contractionRate: 0.02 });
    const heavyDraft = fp({ meanLength: 20, contractionRate: 0.4 });
    const result = compareVoice(flatSample, heavyDraft);
    expect(result.ok).toBe(false);
  });
});

describe('voiceFingerprint feeding compareVoice end to end', () => {
  it('produces a sample/draft pair that compareVoice can compare', () => {
    const sampleText =
      'When we started this project the team had almost no budget to speak of at all. ' +
      'We spent the first six weeks arguing about a database that nobody ever migrated in the end. ' +
      'Eventually somebody senior enough said no and the whole plan finally changed for the better.';
    const draftText = 'We shipped it fast. The team was tired. Nobody really cared. It broke twice.';
    const result = compareVoice(voiceFingerprint(sampleText), voiceFingerprint(draftText));
    expect(result.ok).toBe(false);
  });
});

describe('normaliseSamples', () => {
  it('splits on blank lines, trims, and drops empties', () => {
    expect(normaliseSamples('a\n\nb\n\n\n')).toEqual(['a', 'b']);
  });

  it('returns an empty array for undefined input', () => {
    expect(normaliseSamples(undefined)).toEqual([]);
  });
});
