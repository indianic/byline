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
    expect(composeImagePrompt('photoreal_people', 'x')).toMatch(/Include people engaged in the activity/i);
    expect(composeImagePrompt('photoreal_scene', 'x')).not.toMatch(/Include people engaged in the activity/i);
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
    expect(p).toMatch(/Vary age, build and gender/i);
  });

  // The mechanism changed and is worth stating: asking a model to make people
  // "diverse" in the abstract produces a stock-library composite. Naming the
  // CITY produces architecture, clothing, light and faces that actually belong
  // together — so every people prompt must carry a region.
  it('always names a specific city, which is what now drives who appears', () => {
    for (const subject of ['a clinic reception', 'x', 'two engineers reviewing a rollout plan']) {
      expect(composeImagePrompt('photoreal_people', subject), subject).toMatch(/The setting is in /);
    }
  });

  // The real anti-monoculture proof, and far stronger than matching a sentence:
  // across many subjects the tool must actually reach many different cities. A
  // contract that said the right words but always resolved to one place would
  // pass a string match and still produce fifty identical posts.
  it('reaches many different cities across subjects, not one default', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const p = composeImagePrompt('photoreal_people', `subject number ${i}`);
      seen.add(/The setting is in ([^,—]+)/.exec(p)![1]!);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('keeps people subordinate to the setting rather than imposing a demographic', () => {
    // The subject still drives the image; the region only removes the default.
    expect(composeImagePrompt('photoreal_people', 'x')).toMatch(
      /ethnicity follows the city named above/i,
    );
  });

  it('says nothing about demographics when no people were asked for', () => {
    expect(composeImagePrompt('photoreal_scene', 'x')).not.toMatch(/ethnicity/i);
  });
});

describe('variety — the point of all these axes', () => {
  const prompts = (n: number, style: 'photoreal_people' | 'photoreal_scene' = 'photoreal_people') =>
    Array.from({ length: n }, (_, i) => composeImagePrompt(style, `article subject number ${i}`));

  const axis = (p: string, re: RegExp) => re.exec(p)?.[0] ?? '';

  // Before this, every image shared one of four looks, one fixed setting
  // sentence and one fixed people sentence — so a blog's images read as one
  // template no matter how different the articles were.
  it('produces a large number of DISTINCT prompts, not a handful of templates', () => {
    const set = new Set(prompts(300));
    expect(set.size).toBeGreaterThan(200);
  });

  it.each([
    ['look', /Shot on[^.]+\.|Tight close-up[^.]+\.|Aerial view[^.]+\.|High-key[^.]+\.|Blue-hour[^.]+\.|Handheld[^.]+\./],
    ['scene', /set it in [^.]+\.|set it outdoors[^.]+\.|set it at [^.]+\.|set it on [^.]+\./],
    ['region', /The setting is in [^,—]+/],
    ['energy', /Catch [^.]+\./],
  ])('reaches many different %s values across subjects', (_name, re) => {
    const seen = new Set(prompts(400).map((p) => axis(p, re)).filter(Boolean));
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  // The axes must move INDEPENDENTLY. Salted separately, twelve options each
  // gives thousands of combinations; salted identically they would move in
  // lockstep and a Bengaluru cafe would always be shot at blue hour.
  it('varies the axes independently rather than in lockstep', () => {
    const pairs = new Set(
      prompts(400).map(
        (p) => `${axis(p, /The setting is in [^,—]+/)}|${axis(p, /set it in [^.]+\.|set it outdoors[^.]+\.|set it at [^.]+\.|set it on [^.]+\./)}`,
      ),
    );
    // Lockstep caps this at the length of the shorter list (12). A weakly
    // avalanched hash capped it at 36, which is why `hash` finalises before
    // anyone takes it modulo. 400 subjects now reach ~128 of the 144 possible
    // pairs, so the bar is set where a regression in mixing would be caught
    // rather than merely where lockstep would be.
    expect(pairs.size).toBeGreaterThan(100);
  });

  // Lighting specifically — the complaint was that every image looked the same
  // and was lit the same. Daylight-only was literally true before: all four
  // original looks were daylight.
  it('covers night, artificial and bright daylight lighting, not just daylight', () => {
    const all = IMAGE_LOOKS.join(' ').toLowerCase();
    for (const condition of ['after dark', 'fluorescent', 'tungsten', 'blue-hour', 'midday', 'overcast']) {
      expect(all, condition).toContain(condition);
    }
  });

  it('covers close-up and aerial framing, not just eye-level', () => {
    const all = IMAGE_LOOKS.join(' ').toLowerCase();
    expect(all).toContain('close-up');
    expect(all).toContain('aerial');
    expect(all).toContain('low angle');
  });
});

describe('illustration — the occasional alternative', () => {
  const illustrated = (p: string) => p.startsWith('Editorial illustration');

  it('stays a small minority of images', () => {
    const n = 600;
    const count = Array.from({ length: n }, (_, i) =>
      composeImagePrompt('photoreal_people', `subject ${i}`),
    ).filter(illustrated).length;
    const share = count / n;
    // 1 in 12 by construction. Bounded on BOTH sides: zero would mean the
    // feature silently does nothing, and a third would change what this
    // product is.
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.2);
  });

  it('never tells an illustration it is not an illustration', () => {
    const p = Array.from({ length: 600 }, (_, i) =>
      composeImagePrompt('photoreal_people', `subject ${i}`),
    ).find(illustrated)!;
    expect(p).not.toMatch(/Not an illustration/i);
    expect(p).not.toMatch(/Photograph\./);
    // A drawing has no lens or aperture.
    expect(p).not.toMatch(/\d{2}mm|f\/\d/);
  });

  // The text rule is the one negative that must NEVER be dropped: gibberish
  // signage gives a drawing away exactly as fast as a photograph.
  it('keeps the no-text and no-tech-slop rules whichever medium is drawn', () => {
    for (let i = 0; i < 200; i++) {
      const p = composeImagePrompt('photoreal_people', `subject ${i}`);
      expect(p, p.slice(0, 30)).toMatch(/No text, letters, numbers, logos, watermarks, or signage/);
      expect(p, p.slice(0, 30)).toMatch(/no glowing circuitry/i);
    }
  });

  it('names what the illustration must NOT be, since bare "illustration" is what produces slop', () => {
    const p = Array.from({ length: 600 }, (_, i) =>
      composeImagePrompt('photoreal_people', `subject ${i}`),
    ).find(illustrated)!;
    for (const anti of ['Not a 3D render', 'not flat corporate vector art', 'not a cartoon mascot']) {
      expect(p).toContain(anti);
    }
  });
});

describe('coherence within one article', () => {
  // The brief hands the same `look` to every image in one article. Region and
  // medium key off it so both images land in one city and one medium — a hero
  // in Tokyo with an inline image in Nairobi reads as two unrelated stock
  // pictures, which is the problem, not the fix.
  it('puts both images of an article in the same city and medium', () => {
    for (const look of IMAGE_LOOKS) {
      const hero = composeImagePrompt('photoreal_people', 'the hero subject', look);
      const inline = composeImagePrompt('photoreal_people', 'a completely different inline subject', look);
      const city = (p: string) => /The setting is in ([^,—]+)/.exec(p)![1];
      expect(city(hero), look).toBe(city(inline));
      expect(hero.startsWith('Editorial illustration')).toBe(inline.startsWith('Editorial illustration'));
    }
  });

  // ...but the two images must not be the same picture twice.
  it('still gives the two images different scenes and different moments', () => {
    const look = IMAGE_LOOKS[0]!;
    const hero = composeImagePrompt('photoreal_people', 'the hero subject', look);
    const inline = composeImagePrompt('photoreal_people', 'a completely different inline subject', look);
    const scene = (p: string) => /set it (?:in|outdoors|at|on) [^.]+\./.exec(p)?.[0];
    const energy = (p: string) => /Catch [^.]+\./.exec(p)?.[0];
    expect(scene(hero)).not.toBe(scene(inline));
    expect(energy(hero)).not.toBe(energy(inline));
  });
});

describe('the no-text rule is actionable, not just a prohibition', () => {
  // Measured 2026-08-03: a generated illustration rendered four lines of
  // confident gibberish on a document in the centre of the frame, with "no
  // text" already in the prompt. Telling the model what the surfaces must BE
  // gives it something to draw; telling it what to avoid does not.
  it('says what paper and screens must positively look like, in both mediums', () => {
    const photo = composeImagePrompt('photoreal_people', 'x');
    const drawn = Array.from({ length: 600 }, (_, i) =>
      composeImagePrompt('photoreal_people', `subject ${i}`),
    ).find((p) => p.startsWith('Editorial illustration'))!;
    for (const p of [photo, drawn]) {
      expect(p).toMatch(/is blank or carries only indistinct marks/);
      expect(p).toMatch(/never letters or word-shapes/);
    }
  });
});
