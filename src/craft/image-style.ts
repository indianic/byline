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
] as const;

/** Leading token. Anchors the model on photography before it reads anything else. */
const MEDIUM = 'Photograph.';

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
  'Include one or two people engaged in the activity, with natural posture and clothing plausible for the setting. They are mid-task and not looking at the camera. No posed group shots, no handshake, no thumbs-up, no arms folded facing the lens. The people vary in age, ethnicity, and gender across images, appropriate to the setting and region — do not default to one demographic. Do not depict any identifiable real person or public figure.';

/**
 * Text is first because it is the single clearest AI tell: models render
 * signage and screen text as confident gibberish, and a reader spots it
 * instantly even when the rest of the frame is flawless.
 *
 * The medium exclusions name each failure mode rather than saying "be
 * realistic", because image models have strong defaults toward exactly these
 * for anything technology-shaped.
 */
const NEGATIVES =
  'No text, letters, numbers, logos, watermarks, or signage anywhere in the frame. Not an illustration, not a 3D render, not vector art, not isometric, not flat design, not neon-on-dark, no glowing circuitry, no abstract technology background.';

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
function lookFor(subject: string): string {
  let hash = 2166136261;
  for (let i = 0; i < subject.length; i++) {
    hash ^= subject.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return IMAGE_LOOKS[Math.abs(hash) % IMAGE_LOOKS.length]!;
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

  // Order matters: medium anchors the model, the look sets the camera, then the
  // subject, then where it happens, then who is in it, then everything to avoid.
  const parts = [MEDIUM, look ?? lookFor(trimmed), sentence, SETTING];
  if (style === 'photoreal_people') parts.push(PEOPLE);
  parts.push(NEGATIVES);

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
