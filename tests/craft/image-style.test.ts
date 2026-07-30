import { describe, expect, it } from 'vitest';
import { IMAGE_LOOKS, composeImagePrompt } from '../../src/craft/image-style.js';

/**
 * The image contract, as tests.
 *
 * This file exists because `build_writing_brief` used to specify an image in
 * eleven words — "detailed prompt for the hero image, 16:9, no text in image" —
 * while `TABLE_THEMES` two files away pins a table's box-shadow blur radius to
 * the hex digit. A table was specified to the pixel and an image was specified
 * in a phrase, in a system whose whole premise is that visual choices come from
 * a declared list so they are reproducible.
 *
 * Everything asserted here is a property a reader would notice in the published
 * article: is it about this topic, does it look like a photograph, are there
 * people in it, is there gibberish text in the corner.
 */

describe('composeImagePrompt', () => {
  it('carries the caller subject verbatim, unparaphrased', () => {
    // The subject is the ONLY part that makes the image about this article.
    // Anything that rewrites or truncates it is the defect this contract exists
    // to prevent. Only the leading capital is normalised (see below), so the
    // words after the first are compared exactly.
    const subject = 'a warehouse worker scanning pallets with a handheld terminal';
    const tail = subject.slice(1);
    expect(composeImagePrompt('photoreal_people', subject)).toContain(tail);
    expect(composeImagePrompt('photoreal_scene', subject)).toContain(tail);
    expect(composeImagePrompt('diagram', subject)).toContain(tail);
  });

  it('stands the subject up as its own sentence', () => {
    // Found by PRINTING a composed prompt and reading it — every unit test
    // above passed while the output read:
    //   "...a wider frame. a logistics coordinator ... warehouse A real,
    //    specific location consistent with the subject..."
    // The subject ran straight into the following clause with no terminator
    // and no capital, blurring where the subject ended and the constraints
    // began.
    const p = composeImagePrompt('photoreal_scene', 'a conveyor sorting line mid-shift');
    expect(p).toContain('A conveyor sorting line mid-shift.');
    expect(p).not.toMatch(/mid-shift A real/);
  });

  it('does not double the terminator when the subject already has one', () => {
    const p = composeImagePrompt('photoreal_scene', 'A conveyor line runs past a scanning arch.');
    expect(p).not.toContain('arch..');
  });

  it('anchors on the medium before anything else', () => {
    // "Photograph." as the first token is what stops the model reaching for
    // illustration, which is its default for anything technology-shaped.
    expect(composeImagePrompt('photoreal_scene', 'a server room aisle')).toMatch(/^Photograph\./);
    expect(composeImagePrompt('photoreal_people', 'a server room aisle')).toMatch(/^Photograph\./);
  });

  it('adds the people clause only for photoreal_people', () => {
    expect(composeImagePrompt('photoreal_people', 'x')).toMatch(/one or two people/i);
    expect(composeImagePrompt('photoreal_scene', 'x')).not.toMatch(/one or two people/i);
  });

  it('rules out the stock-photo tells whenever it asks for people', () => {
    const p = composeImagePrompt('photoreal_people', 'x');
    expect(p).toMatch(/not looking at the camera/i);
    expect(p).toMatch(/handshake|shaking hands/i);
  });

  it('forbids identifiable real people whenever it asks for people', () => {
    // "Real people" here means real-LOOKING. Generating a recognisable person
    // is a different thing with likeness problems attached, and a hero image
    // never needs one.
    expect(composeImagePrompt('photoreal_people', 'x')).toMatch(/identifiable|public figure/i);
  });

  it('excludes text and every non-photographic medium on both photoreal styles', () => {
    for (const style of ['photoreal_people', 'photoreal_scene'] as const) {
      const p = composeImagePrompt(style, 'x');
      expect(p, style).toMatch(/no text/i);
      expect(p, style).toMatch(/illustration/i);
      expect(p, style).toMatch(/3d render/i);
      expect(p, style).toMatch(/vector/i);
      expect(p, style).toMatch(/isometric/i);
    }
  });

  it('asks for a real setting with the clutter real places have', () => {
    // Without this the model produces an immaculate, empty, showroom version of
    // the place, which is its own kind of AI tell.
    expect(composeImagePrompt('photoreal_scene', 'x')).toMatch(/clutter|lived-in|ordinary/i);
  });

  it('gives diagram none of the photoreal language', () => {
    const p = composeImagePrompt('diagram', 'a flow of three boxes');
    expect(p).toContain('flow of three boxes');
    expect(p).not.toMatch(/^Photograph\./);
    expect(p).not.toMatch(/one or two people/i);
    expect(p).not.toMatch(/shallow depth of field/i);
  });

  it('still warns diagram off text, because models render it as gibberish', () => {
    expect(composeImagePrompt('diagram', 'x')).toMatch(/no text|gibberish/i);
  });
});

describe('composeImagePrompt — the look', () => {
  it('derives a stable look from the subject when none is given', () => {
    // Reproducibility is a property of this whole system: the same inputs
    // produce the same article. Deriving the look from the subject keeps that
    // true without plumbing the brief's seed through the tool layer.
    const a = composeImagePrompt('photoreal_scene', 'a data centre aisle');
    const b = composeImagePrompt('photoreal_scene', 'a data centre aisle');
    expect(a).toBe(b);
  });

  it('spreads distinct subjects across the look list rather than collapsing onto one', () => {
    const subjects = [
      'a warehouse aisle',
      'a hospital reception desk',
      'a construction site trailer',
      'a commercial kitchen pass',
      'a rooftop solar array',
      'a bank branch counter',
      'a university lecture hall',
      'a fishing boat deck',
    ];
    const used = new Set(
      subjects.map((s) => {
        const prompt = composeImagePrompt('photoreal_scene', s);
        return IMAGE_LOOKS.find((look) => prompt.includes(look));
      }),
    );
    expect(used.size).toBeGreaterThan(1);
  });

  it('uses an explicit look when given one', () => {
    const chosen = IMAGE_LOOKS[2]!;
    expect(composeImagePrompt('photoreal_scene', 'x', chosen)).toContain(chosen);
  });
});

describe('IMAGE_LOOKS', () => {
  it('names a focal length and a lighting condition in every entry', () => {
    for (const look of IMAGE_LOOKS) {
      expect(look, look).toMatch(/\d{2}mm/);
      expect(look, look).toMatch(/light/i);
    }
  });

  it('never smuggles subject matter into a look', () => {
    // A look that named a place or a person would fight the article's actual
    // topic — the subject comes from the article, the look is camera and
    // lighting only.
    for (const look of IMAGE_LOOKS) {
      expect(look, look).not.toMatch(/office|warehouse|laptop|team|meeting|desk|worker/i);
    }
  });

  it('offers more than one look, or there is no variety to have', () => {
    expect(IMAGE_LOOKS.length).toBeGreaterThan(2);
  });
});

// Found by generating a real hero image and looking at it: both people came
// back as white men. Nothing in the contract said anything about who appears,
// so that was simply the model's default — and it would have been the default
// on every hero image this tool ever produced, which across a whole blog reads
// as a monoculture nobody notices until fifty posts are live.
describe('who appears', () => {
  it('asks for variety across images rather than leaving the model to default', () => {
    const p = composeImagePrompt('photoreal_people', 'a clinic reception desk');
    expect(p).toMatch(/vary in age, ethnicity, and gender/i);
    expect(p).toMatch(/do not default to one demographic/i);
  });

  it('keeps that subordinate to the setting rather than imposing it', () => {
    // "appropriate to the setting and region" — the subject still drives the
    // image; this only removes the default, it does not override the topic.
    expect(composeImagePrompt('photoreal_people', 'x')).toMatch(/appropriate to the setting and region/i);
  });

  it('says nothing about demographics when no people were asked for', () => {
    expect(composeImagePrompt('photoreal_scene', 'x')).not.toMatch(/ethnicity/i);
  });
});
