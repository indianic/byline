/**
 * The image contract: what every generated image must look like.
 *
 * This file exists because images were the one visual element in this project
 * left to improvisation. `TABLE_THEMES` in `dimensions.ts` pins a table's
 * box-shadow blur radius, border colour and alternating row backgrounds to the
 * hex digit; the entire specification for an image was "detailed prompt for the
 * hero image, 16:9, no text in image". A table was specified to the pixel and a
 * photograph was specified in a phrase, so what came out varied per run, per
 * model, and per however the writing model felt that day.
 *
 * Two things live here, and they live here TOGETHER on purpose:
 *
 *  - `IMAGE_LOOKS` — the per-article look. Varies, so a hundred articles don't
 *    share one camera setup and read as a template.
 *  - `composeImagePrompt` — the invariants. Every image, every time.
 *
 * `dimensions.ts` IMPORTS `IMAGE_LOOKS` rather than declaring its own copy. Two
 * hand-maintained copies of one rule is how `SLUG_PATTERN` and the image
 * providers' env var names drifted in earlier phases, and the composer needs
 * the list as much as the brief does — its whole purpose is to work for a
 * caller who never ran `build_writing_brief`.
 */

export type ImageStyle = 'photoreal_people' | 'photoreal_scene' | 'diagram';

/**
 * The per-article look — **camera and lighting only, never subject matter**.
 *
 * A look that named a place or a person would fight the article's actual topic,
 * which is the one thing that makes the image about this piece rather than any
 * other. The subject comes from the caller; these decide how it is shot.
 */
export const IMAGE_LOOKS = [
  'Shot on a 35mm lens at f/2, available window light from one side, shallow depth of field with the background falling softly out of focus, natural unsaturated colour, fine grain.',
  'Shot on an 85mm lens at f/1.8, soft diffused key light from the front left, compressed perspective, background well out of focus, clean neutral colour.',
  'Shot on a 24mm lens at f/5.6, broad ambient daylight, deep depth of field so the whole space reads, the subject occupying a modest part of a wider frame.',
  'Shot on a 50mm lens at f/2.8, warm low-angle late-afternoon light raking across the frame, moderate depth of field, visible highlight falloff.',
  'Shot on a 35mm lens at f/1.4 after dark, lit only by cool screen glow and one warm practical just out of frame, deep shadows, small pools of warm light in an otherwise dim room, high ISO grain left in.',
  'Shot on a 50mm lens at f/4 under cool white overhead fluorescent light, flat and even with almost no shadow, slightly clinical colour, everything in the frame legible.',
  'Shot on an 85mm lens at f/2, warm tungsten lamplight from behind and to one side, the subject rim-lit, background dropping into soft amber darkness.',
  'Tight close-up on a 100mm macro lens at f/2.8, filling the frame with hands and whatever they are handling, soft directional light from one side, faces out of frame or blurred well behind.',
  'Aerial view from directly overhead on a 20mm lens, roughly twenty metres up, the scene reading as a flat pattern of shapes and figures, hard midday light, sharp throughout.',
  'Shot on a 28mm lens at f/2.8 from a low angle close to the subject, slight wide-angle stretch at the edges, bright overcast daylight, energetic and a little off-balance.',
  'High-key look: 50mm at f/2.8, bright airy overexposed daylight flooding a pale room, minimal shadow, light neutral colours, an open and optimistic feel.',
  'Blue-hour exterior on a 35mm lens at f/2, deep blue sky behind warmly lit windows, mixed colour temperature between the warm interior light and the cool outside.',
  'Shot on a 24mm lens at f/8 in hard midday sunlight, strong directional shadows with defined edges, saturated colour, high contrast.',
  'Handheld reportage frame on a 35mm lens at f/2.8, caught mid-moment and slightly imperfectly composed, one element clipped by the frame edge, natural mixed indoor light.',
] as const;

/**
 * WHERE it happens, when the caller's subject has not already fixed that.
 *
 * Deliberately phrased as a conditional preference rather than a command:
 * `subject` is the only part of the prompt that makes the image about THIS
 * article, so a scene that overrode it would be the exact failure
 * `composeImagePrompt` exists to prevent. A subject that already names a
 * warehouse floor keeps its warehouse floor; one that says only "two engineers
 * reviewing a rollout plan" gets somewhere specific to be.
 */
export const IMAGE_SCENES = [
  'If the subject does not already fix the location, set it in a busy open-plan office with desks, cables and half-drunk coffee.',
  'If the subject does not already fix the location, set it in a glass-walled meeting room mid-session, with a whiteboard or screen partly filled.',
  'If the subject does not already fix the location, set it in a small private cabin or one-person office with the door ajar.',
  'If the subject does not already fix the location, set it in a busy neighbourhood cafe, laptops and cups sharing the table.',
  'If the subject does not already fix the location, set it outdoors on the steps or forecourt of an office building, mid-conversation, city behind.',
  'If the subject does not already fix the location, set it at a long lunch table with food actually on it, work spilling into the meal.',
  'If the subject does not already fix the location, set it in a corridor or stairwell where two people have stopped to talk properly.',
  'If the subject does not already fix the location, set it on a rooftop or balcony terrace during a break, the city skyline behind.',
  'If the subject does not already fix the location, set it in a co-working space with mismatched furniture and other people working nearby.',
  'If the subject does not already fix the location, set it in a home workspace — a real room in a real home, not a styled set.',
  'If the subject does not already fix the location, set it in a canteen or office pantry beside the coffee machine.',
  'If the subject does not already fix the location, set it in a large auditorium or training room between sessions, chairs half-empty.',
] as const;

/**
 * The part of the world the frame is in.
 *
 * This carries the architecture, the street outside the window, the clothing
 * and — without needing to say so demographically — the people. Naming a city
 * gets a far more specific and less generic frame than asking for "diverse
 * people" in the abstract, which produces a stock-library composite.
 */
export const IMAGE_REGIONS = [
  'The setting is in India — Bengaluru or Pune — with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Singapore, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Berlin, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in São Paulo, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Nairobi, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Tokyo, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Dubai, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Toronto, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Amsterdam, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Mexico City, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Warsaw, with architecture, light quality, street life and people consistent with that city.',
  'The setting is in Ho Chi Minh City, with architecture, light quality, street life and people consistent with that city.',
] as const;

/**
 * The human moment.
 *
 * The single biggest reason a set of generated images reads as one template is
 * that everyone in them is doing the same thing: looking pleasantly at a
 * screen. Real photography of working life has laughter, disagreement,
 * boredom and relief in it. None of these ask for a posed expression — they
 * ask for a moment that happens to be being photographed.
 */
export const IMAGE_ENERGY = [
  'Catch a genuinely funny moment — someone mid-laugh, the others reacting, nobody performing for a camera.',
  'Catch a real disagreement — two people arguing a point in good faith, one gesturing, the other unconvinced.',
  'Catch deep concentration — nobody talking, the room quiet, one person entirely absorbed in the work.',
  'Catch the moment something finally works — relief and a little disbelief, one person leaning back.',
  'Catch someone mid-explanation, hands doing half the talking, the others actually listening.',
  'Catch a quiet aside between two people while a larger group carries on behind them.',
  'Catch the tail end of a long day — coffee, loosened posture, a mess of paper, nobody at their most photogenic.',
  'Catch the frustration of something not working — a flat stare at a screen, arms braced on the desk.',
  'Catch an ordinary handover between colleagues, one passing something to the other mid-stride.',
  'Catch someone sipping coffee and thinking, half-turned away from the work in front of them.',
] as const;

/**
 * Photograph, or illustration.
 *
 * The project's default has always been photography, and it stays the strong
 * default: the positioning in README is "photographs, not AI art", and a
 * generated illustration is the single easiest thing for a reader to identify
 * as machine-made. But an occasional editorial illustration is a real thing
 * real publications do, and always-photography is its own kind of sameness.
 *
 * **The ratio is the design.** Eleven of twelve entries are the photographic
 * contract; one is illustration. Adding more would change what this product is
 * — and would reintroduce, at scale, exactly the flat-vector-with-glowing-
 * circuitry look that `NEGATIVES` was written to keep out. The illustration
 * entry is specific about being editorial line-and-wash with a limited palette
 * for that reason: "illustration" unqualified is what produces the slop.
 */
export const IMAGE_MEDIUMS = [
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'photo',
  'illustration',
] as const;

/** Leading token. Anchors the model on the medium before it reads anything else. */
const MEDIUM = 'Photograph.';

/**
 * The illustration alternative, drawn roughly one time in twelve.
 *
 * Every clause is load-bearing against a specific default. "Editorial" and
 * "hand-drawn ink line with flat washes" steer away from the flat-vector
 * corporate-blob style; "limited palette of three or four colours" prevents the
 * rainbow-gradient look; "visible drawing" keeps it honest about being a
 * drawing rather than attempting a photograph badly. Naming what it is NOT
 * matters as much here as in `NEGATIVES` — an unqualified "illustration" is
 * precisely the prompt that produces the slop this project avoids.
 */
const MEDIUM_ILLUSTRATION =
  'Editorial illustration in the style of a broadsheet newspaper opinion page. Hand-drawn ink line with flat colour washes, a limited palette of three or four colours plus paper white, visible drawing and imperfect linework. Characters are stylised but grounded and human, with real body language. Not a 3D render, not flat corporate vector art, not a cartoon mascot, not an infographic, no gradients, no neon.';

/**
 * Without this the model returns an immaculate, empty, showroom version of the
 * place — which is its own kind of AI tell, just a subtler one than six fingers.
 */
const SETTING =
  'A real, specific location consistent with the subject, lived-in rather than staged, with the ordinary incidental clutter a working place actually has.';

/**
 * The stock-photo tells are called out individually because "photorealistic
 * people" alone reliably produces four colleagues beaming at the lens over a
 * handshake, which reads as a stock library and not as an article's photograph.
 *
 * The last sentence is not stylistic. "Real people" in this project means
 * real-LOOKING; generating a recognisable person carries likeness and
 * misinformation problems, and a hero image never needs one.
 */
const PEOPLE =
  'Include people engaged in the activity — anywhere from one person alone to a table of five, whichever the moment calls for. Natural posture and clothing plausible for the setting and the city. They are mid-moment and not looking at the camera, and their expressions belong to what is actually happening rather than to a camera being present. No posed group shots, no handshake, no thumbs-up, no arms folded facing the lens, no ring of colleagues smiling at a laptop. Vary age, build and gender; ethnicity follows the city named above rather than being assembled to look varied. Do not depict any identifiable real person or public figure.';

/**
 * Text is first because it is the single clearest AI tell: models render
 * signage and screen text as confident gibberish, and a reader spots it
 * instantly even when the rest of the frame is flawless.
 *
 * "No text" alone was measured to be insufficient. A generated editorial
 * illustration on 2026-08-03 came back with a document held open in the middle
 * of the frame carrying four lines of confident gibberish — the instruction was
 * present and the model rendered word-shapes anyway. Saying what the surfaces
 * must POSITIVELY be (blank, or indistinct marks) gives the model something to
 * draw instead of something to avoid, which is a far more reliable instruction
 * than a prohibition. Illustration is the worse case: a drawing renders its
 * text crisply, where a photograph at f/1.8 blurs it away.
 *
 * The medium exclusions name each failure mode rather than saying "be
 * realistic", because image models have strong defaults toward exactly these
 * for anything technology-shaped.
 */
const NEGATIVES =
  'No text, letters, numbers, logos, watermarks, or signage anywhere in the frame. Any paper, screen, whiteboard or sign visible in the frame is blank or carries only indistinct marks — never letters or word-shapes, however small or out of focus. Not an illustration, not a 3D render, not vector art, not isometric, not flat design, not neon-on-dark, no glowing circuitry, no abstract technology background.';

/**
 * The negatives that survive when the medium IS a drawing.
 *
 * "Not an illustration" obviously cannot be sent with an illustration prompt —
 * it would contradict the instruction two clauses earlier and the model would
 * resolve that however it liked. What must NOT be dropped is the text rule:
 * gibberish signage is the clearest tell in a drawing as much as in a
 * photograph, and it is the reason every visual block elsewhere in this project
 * is an HTML table rather than a picture. The technology-slop exclusions stay
 * too, because they are exactly what an image model reaches for when asked to
 * illustrate anything software-shaped.
 */
const NEGATIVES_ILLUSTRATION =
  'No text, letters, numbers, logos, watermarks, or signage anywhere in the frame. Any paper, screen, whiteboard or sign visible in the frame is blank or carries only indistinct marks — never letters or word-shapes, however small or out of focus. No glowing circuitry, no neon-on-dark, no abstract technology background, no isometric grid.';

/**
 * `diagram` deliberately gets none of the photoreal contract — it is the escape
 * hatch for a caller who knows what they are asking for. The text warning stays
 * anyway, because a diagram whose labels are gibberish is worse than no
 * diagram. Note that every visual block elsewhere in this project is an HTML
 * `<table>` for exactly this reason; a generated picture is rarely the right
 * tool for something with words in it.
 */
const DIAGRAM_NOTE =
  'Simple, clean, high contrast. No text, letters, or numbers — image models render text as convincing gibberish.';

/**
 * Pick a look from the subject, deterministically.
 *
 * Reproducibility is a property of this whole system — the same inputs produce
 * the same article. The brief picks its dimensions from a seed, but the tool
 * layer has no seed and should not need one plumbed through it just to stay
 * consistent. Hashing the subject gives: same subject, same look; different
 * articles, different looks; and no new parameter on the wire.
 *
 * FNV-1a, chosen because it is four lines and stable across runs. Nothing here
 * needs cryptographic properties.
 */
function hash(value: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Avalanche the result before anyone takes it modulo a list length.
  //
  // FNV-1a's low bits are its weak point, and `% 12` reads exactly those. With
  // only the initial value differing between salts, two axes drawn from the
  // same subject came out correlated: 400 subjects produced 36 distinct
  // (region, scene) pairs out of a possible 144, so scene and region moved
  // together and most of the combinations this file exists to create were
  // unreachable. Independence is the whole design — twelve options on four
  // axes is thousands of combinations only if the axes are actually
  // independent, and twelve if they are not.
  //
  // This is the `lowbias32` finalizer; it mixes high bits down into low ones.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * One option from `list`, chosen deterministically from `key`.
 *
 * `salt` is what makes the axes INDEPENDENT. Without it every list would be
 * indexed by the same number, so scene, region and energy would move in
 * lockstep — a Bengaluru cafe would always be photographed at blue hour with
 * someone laughing, and twelve options per axis would still yield twelve
 * combinations instead of thousands.
 */
function pick<T>(list: readonly T[], key: string, salt: number): T {
  return list[hash(key, salt) % list.length]!;
}

/**
 * Build the prompt actually sent to an image provider.
 *
 * `subject` is carried through **verbatim** — it is the only part that makes
 * the image about this article rather than any other, and paraphrasing it is
 * the failure this contract exists to prevent.
 *
 * `look` is optional; omitted, it is derived from `subject` (see `lookFor`).
 */
export function composeImagePrompt(style: ImageStyle, subject: string, look?: string): string {
  const trimmed = subject.trim();
  const sentence = asSentence(trimmed);

  if (style === 'diagram') {
    return `${sentence} ${DIAGRAM_NOTE}`;
  }

  // WHICH key each axis is drawn from decides what varies between the two
  // images of one article, and it is a deliberate split.
  //
  // Scene and energy come from the SUBJECT, so the hero and the inline image
  // — different subjects — show different places and different moments. Two
  // frames of the same meeting from the same angle is the sameness this whole
  // file is fighting.
  //
  // Region and medium come from `look` when the caller supplied one, and
  // `look` is the value `build_writing_brief` hands to every image in a single
  // article precisely so they match. So both images land in the same city, and
  // are both photographs or both drawings. An article whose hero is in Tokyo
  // and whose inline image is in Nairobi reads as two unrelated stock pictures,
  // which is the opposite of the problem being solved. With no `look` passed
  // there is nothing article-level to key on, so the subject is used and each
  // image is simply independent.
  const sceneKey = trimmed;
  const articleKey = look ?? trimmed;

  const medium = pick(IMAGE_MEDIUMS, articleKey, 0x9e37);
  const illustrated = medium === 'illustration';

  const parts = [
    illustrated ? MEDIUM_ILLUSTRATION : MEDIUM,
    // A drawing has no lens or f-stop. Passing the camera register into an
    // illustration prompt asks the model to reconcile "hand-drawn ink line"
    // with "85mm at f/1.8", and what comes back is a photograph with a filter.
    ...(illustrated ? [] : [look ?? pick(IMAGE_LOOKS, trimmed, 0x1f83)]),
    sentence,
    pick(IMAGE_SCENES, sceneKey, 0x2545),
    pick(IMAGE_REGIONS, articleKey, 0x85eb),
    SETTING,
  ];

  if (style === 'photoreal_people') {
    parts.push(PEOPLE, pick(IMAGE_ENERGY, sceneKey, 0xc2b2));
  }

  parts.push(illustrated ? NEGATIVES_ILLUSTRATION : NEGATIVES);
  return parts.join(' ');
}

/**
 * Make the caller's subject stand as its own sentence.
 *
 * Callers write subjects as noun phrases — "a logistics coordinator checking
 * pallet barcodes" — which spliced in raw produced ". a logistics coordinator
 * ... warehouse A real, specific location", running the subject into the
 * following clause with no terminator and no capital. Every unit test passed;
 * it was visible only by printing a composed prompt and reading it.
 *
 * The subject's WORDS are still verbatim. Only the leading capital and a
 * trailing full stop are added, because a prompt the model reads as one
 * run-on sentence blurs the boundary between the subject and the constraints
 * around it.
 */
function asSentence(subject: string): string {
  if (subject === '') return '';
  const capitalised = subject[0]!.toUpperCase() + subject.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
