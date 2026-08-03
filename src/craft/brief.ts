import type { Persona } from '../config/personas.js';
import type { ResearchResult } from '../plugins/research/types.js';
import { tallyWindow } from '../plugins/research/window.js';
import { dimensionsFor, type DimensionName } from './dimensions.js';
import type { HtmlProfile } from './html-profile.js';

interface BriefBase {
  persona: Persona;
  topic: string;
  mode: 'blog' | 'news';
  wordCount?: number;
  language?: string;
  seed?: number;
  profile: HtmlProfile;
  /**
   * Image providers whose key is actually configured, e.g. `['gemini']` —
   * pass `ctx.setup.imageProviders` straight through. This is what lets the
   * brief tell the truth about images instead of always assuming a provider
   * exists: when this is empty, instructing generate_image is worse than
   * useless — the call would simply fail with SETUP_INCOMPLETE, and asking
   * the writer to leave a `[[content_image]]` placeholder that nothing will
   * ever replace runs straight into `create_post`'s refusal to publish one.
   *
   * Optional, defaulting to "assume configured" (`undefined`, not `[]`) —
   * every REAL caller (`build_writing_brief`) always passes this, so the
   * only place it is omitted is a test that predates this field and is
   * exercising something else entirely. Erring toward the richer branch
   * keeps every such test's existing assertions about the image content
   * unchanged; a caller that means "no provider" has to say so with `[]`.
   */
  imageProviders?: readonly string[];
  /**
   * The instant to judge every finding's freshness against, as epoch ms.
   *
   * Optional, defaulting to `Date.now()` when omitted — so the 40-plus
   * existing `buildBrief` call sites (tests, and any caller that has no
   * reason to care) keep compiling and behaving unchanged. The one caller
   * that DOES care, `build_writing_brief` in `craft-tools.ts`, computes one
   * `Date.now()` for the whole request and passes it here AND to the guard's
   * own `tallyWindow` call — so both judge the same findings against the
   * same instant. Without that, each call defaults its own `now`
   * independently, and the guard's verdict and this brief's rendered header
   * can disagree at the millisecond the cutoff falls on (measured: 2 of 500
   * requests with `publishedAt` exactly at the cutoff). That disagreement is
   * exactly what `window.ts` — the sole freshness authority both call sites
   * defer to — exists to make impossible.
   */
  now?: number;
}

/**
 * One article, one research origin.
 *
 * A union rather than two optional fields, so `tsc` refuses a caller that
 * supplies both. Blending them makes provenance unanswerable: you cannot tell
 * which claim came from where, so `citation_provenance` has nothing solid to
 * check against and a later correction cannot be traced to a source.
 *
 * The runtime refusal in `craft-tools.ts` is NOT redundant with this — MCP
 * input is runtime data and no type can constrain it.
 */
type ResearchOrigin =
  | { research: string; findings?: never }
  | { findings: ResearchResult; research?: never }
  | { research?: never; findings?: never };

export type BriefInput = BriefBase & ResearchOrigin;

/** Render the target platform's ingest rules as brief text. */
function htmlRules(profile: HtmlProfile): string {
  const preserved = [...profile.preserved].map((t) => `<${t}>`).join(' ');
  const unwrapped = [...profile.unwrapped].map((t) => `<${t}>`).join(', ');
  // No `?? 'table'` fallback: an empty `visualContainers` means no container is
  // verified to keep its styling on this platform, and fabricating one would
  // instruct the writer to use a tag never confirmed to survive ingest.
  const container = profile.visualContainers[0];

  // Verified-correct wording for a platform that keeps inline styles (Ghost):
  // recommending a *styled* container is safe because the styling survives.
  // On a platform whose profile has `inlineStyles: false`, that same sentence
  // would tell the author to write `style=` attributes that get stripped on
  // ingest — the exact thing `score_draft`'s platform_html check blocks — so
  // the guidance is conditioned on what the platform actually keeps.
  const visualGuidance = container
    ? profile.inlineStyles
      ? `Use a styled <${container}> for any visual block — that is the only
  container that keeps its styling.`
      : `${profile.label} strips \`style=\` attributes for this account, so any
  visual block must be structural, not decorated with inline CSS. Use a plain
  <${container}> for any visual block — the site theme, not inline styles,
  supplies its appearance.`
    : `${profile.label} has no container confirmed to survive ingest with any
  styling, so write plain structural HTML for any visual block and let the
  site theme supply its appearance.`;

  // `label` (the display name, e.g. "Ghost") is used here, not `platform` (the
  // lowercase machine id) — this text is read by the host model, and
  // "wordpress unwraps them" reads as a typo where "WordPress unwraps them"
  // reads as a platform name.
  //
  // A platform whose profile has an empty `unwrapped` set (WordPress, for an
  // account holding unfiltered_html — measured 2026-07-29: nothing is unwrapped
  // on ingest for that account) has no tag to warn against here. Emitting
  // "NEVER use ${unwrapped}" with an empty list would read as "NEVER use ." —
  // so that line is only included when there is something to name.
  const neverUseLine =
    profile.unwrapped.size > 0
      ? `- NEVER use ${unwrapped}. ${profile.label} unwraps them on ingest: the text
  survives but every style is silently lost, so a div-based card publishes as bare
  unstyled text. ${visualGuidance}\n`
      : `- ${visualGuidance}\n`;

  // Honest per profile, not a blanket claim: a platform can resolve to more
  // than one HtmlProfile (WordPress's permissive vs. restrictive capability
  // states), and only some of those are actually backed by a live probe. This
  // used to say "VERIFIED BY LIVE PROBE" unconditionally, including for a
  // restrictive WordPress profile that was never measured against a real
  // account lacking unfiltered_html.
  const provenance = profile.verified
    ? 'STRICT, VERIFIED BY LIVE PROBE'
    : 'STRICT, UNVERIFIED — REASONED FROM DOCUMENTED PLATFORM BEHAVIOUR, NOT MEASURED';

  return `=== HTML RULES (${profile.label.toUpperCase()} — ${provenance}) ===
ALLOWED TAGS: ${preserved}
${neverUseLine}- Every tag on a single line. No line breaks inside a tag.
- No <br>. Use separate <p> tags.
${profile.notes.map((n) => `- ${n}`).join('\n')}`;
}

export interface Brief {
  brief: string;
  seed: number;
  choices: Partial<Record<DimensionName, number>>;
  /** Which origin grounded this article. Recorded so a correction can be traced. */
  researchOrigin: 'provider' | 'byor' | 'none';
  /** Non-fatal. Names what the research cannot support, without refusing it. */
  warnings: string[];
}

/** mulberry32 — small, fast, deterministic. Keeps briefs reproducible from a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const or = (v: string, fallback: string): string => (v.trim() ? v : fallback);

/**
 * `undefined` (the field omitted) assumes a provider IS configured — see
 * `BriefInput.imageProviders`'s doc comment for why. Only an explicit `[]`
 * means "no provider".
 */
const hasImageProvider = (imageProviders: readonly string[] | undefined): boolean =>
  imageProviders === undefined || imageProviders.length > 0;

/**
 * The rules that apply to every article, whichever texture was drawn.
 *
 * A constant rather than a template literal because nothing in it depends on
 * the persona, the platform, or the topic — and because it is long enough that
 * leaving it inline made the one 120-line template string in `buildBrief`
 * genuinely hard to read.
 *
 * **On what this is and is not.** It is a craft standard: be specific, vary
 * your rhythm, do not reach for the phrase everyone reaches for. Writing that
 * follows it is better to read, which is the whole justification — an article
 * a person actually finishes is what SEO, AEO and GEO are all downstream of.
 * It makes no claim about any particular detector, and none should be added:
 * that claim could not be verified from inside this codebase, and a promise
 * the host model repeats to a user as fact is exactly the kind of overclaim
 * this project has had to walk back before.
 *
 * The word list is the cheap half. The structural rules below it matter more —
 * model-written prose gives itself away far more through uniform paragraph
 * length, relentlessly parallel lists, and an argument that never once concedes
 * anything than through any individual word.
 */
const HUMANISING = `=== NEVER USE THESE ===
Words: delve, landscape (figurative), transformative, seamless, robust,
revolutionary, tapestry, testament, realm, myriad, plethora, pivotal, crucial,
vital, elevate, unlock, harness, streamline, cutting-edge, game-changer,
navigate (figurative), foster, bolster, underscore, embark, leverage (as a verb),
meticulous, intricate, multifaceted, holistic, paradigm, synergy.

Constructions: "it's not just X, it's Y", "in today's world", "in the
ever-evolving", "when it comes to", "it's worth noting that", "at the end of the
day", "in conclusion", "the fact that", "one thing is clear", "let's dive in",
"buckle up", "the bottom line", "that said" used more than once, "moreover" and
"furthermore" anywhere at all.

Openings: never begin the article, or any section, with a dictionary definition,
with "In an era where", with a rhetorical question you answer in the next
sentence, or by restating the H2 you just wrote.

=== STRUCTURAL TELLS — THESE MATTER MORE THAN THE WORD LIST ===
- Paragraph length must be genuinely uneven. Three consecutive paragraphs of
  similar length is the strongest single tell there is.
- Do not open two paragraphs in a row with the same word or the same
  construction. Vary where the sentence's subject lands.
- Do not write three consecutive sentences of similar length. Put a four-word
  sentence next to a thirty-word one and let the contrast do the work.
- Break at least one "rule" of the tricolon: not every list should have three
  items, and not every list should be parallel in grammar or length.
- No section may have the same internal shape as the section before it. If one
  opens with a claim and closes with an example, the next must not.
- Take a position. At least once, say plainly that a widely held view is wrong,
  and accept the cost of being wrong about it. Prose that hedges every claim
  reads as machine-written because it is what a model does when it has no stake.
- Every article needs at least one sentence that only you could have written —
  a number from your own work, a specific failure, a judgement you would defend
  in a room. If nothing in the draft qualifies, the draft is not finished.
- Contractions are allowed and usually better. Write "doesn't" unless the
  emphasis genuinely needs "does not".

=== WHAT NOT TO DO IN THE NAME OF SOUNDING HUMAN ===
Do not introduce errors, typos, or slang to seem informal. Do not pad with
filler to break up rhythm. Do not fabricate a statistic, a client, a date, or a
prior article you never wrote — an invented specific is worse than a missing
one, and it is the one mistake here that cannot be undone after publication.`;

/**
 * A persona's extras, tolerating one built without them.
 *
 * `Persona.extras` is required by the type, and `loadPersonas` always supplies
 * it — but `tsc` only covers `src/**`, so a test double or any object cast to
 * `Persona` can reach here without the field and turn every read into a
 * TypeError. This project has been bitten by exactly that: "a double can cast
 * past an interface it does not satisfy; assert behaviour at runtime". One
 * missing field should degrade to "this persona has no extras", not crash the
 * brief.
 */
function extrasOf(p: Persona): Record<string, string> {
  return p.extras ?? {};
}

/**
 * Extras that are WIRED somewhere specific rather than printed as free text.
 *
 * Each of these already has machinery in this brief that it belongs to — a
 * word count, the AVOID list, the evidence rules. Rendering them a second time
 * in the generic block would state the same instruction twice in one prompt,
 * in two different registers, which is how a model ends up weighting one of
 * them arbitrarily.
 */
const WIRED_EXTRAS = new Set([
  'preferred_article_length',
  'target_audience',
  'reading_level',
  'avoid_in_writing',
  'preferred_quotes_from',
  'quote_usage_frequency',
  'citation_preference',
  'fact_checking_level',
  'favorite_rhetorical_devices',
  'commonly_used_transitions',
  'use_of_humor',
]);

/**
 * The persona's own length preference, as a minimum word count.
 *
 * `preferred_article_length` is written the way a person writes it —
 * "1200-3500 words", "about 2000", "1,500+". The FIRST number is taken as the
 * floor, because the brief states a minimum and the low end of a stated range
 * is exactly that. Returns null rather than guessing when there is no number
 * to find, so the caller falls through to its own default instead of receiving
 * a fabricated one.
 *
 * An explicit `wordCount` argument still wins: the caller asking for a
 * specific length is a decision about THIS article, and the persona is a
 * standing preference.
 */
export function personaWordCount(p: Persona): number | null {
  const raw = extrasOf(p).preferred_article_length;
  if (!raw) return null;
  const match = /\d[\d,]*/.exec(raw);
  if (!match) return null;
  const n = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One brief line for an extra, or nothing at all.
 *
 * `$` in the template is replaced by the value. Returning '' rather than a
 * blank line matters: these are interpolated inside a template literal that
 * already supplies the newlines, so emitting an empty string collapses cleanly
 * instead of leaving a gap the reader has to interpret.
 */
function ex(p: Persona, key: string, template: string): string {
  const value = extrasOf(p)[key];
  return value ? `${template.replace('$', value)}\n` : '';
}

/**
 * The free-text extras, rendered for the writer.
 *
 * Only the ones with nowhere else to go — see `WIRED_EXTRAS`. Keys are printed
 * in file order and de-underscored, so `technology_writing_style` reads as
 * "technology writing style" rather than as a variable name. Returns an empty
 * string when there is nothing, so the brief does not carry an empty heading.
 */
function extrasBlock(p: Persona): string {
  const rows = Object.entries(extrasOf(p)).filter(([k]) => !WIRED_EXTRAS.has(k));
  if (rows.length === 0) return '';
  return `=== ADDITIONAL AUTHOR DIRECTION ===
These come from the persona file and are this author's own standing rules.
Treat them the way you treat the profile above: they shape the writing, they
are never quoted or listed on the page. Where one of them conflicts with an
instruction elsewhere in this brief, the instruction elsewhere wins — these
describe a habit, not a format.
${rows.map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`).join('\n')}
`;
}

export function buildBrief(input: BriefInput): Brief {
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const next = rng(seed);
  const p = input.persona;
  const words = input.wordCount ?? personaWordCount(p) ?? 800;
  const language = input.language ?? p.language_written;

  const dimensions = dimensionsFor(input.profile.inlineStyles);
  const choices: Partial<Record<DimensionName, number>> = {};
  const picked = {} as Record<DimensionName, string>;
  for (const name of Object.keys(dimensions) as DimensionName[]) {
    const options = dimensions[name];
    const idx = Math.floor(next() * options.length);
    choices[name] = idx;
    picked[name] = options[idx]!;
  }

  // The blog craft sections, suppressed entirely in news mode.
  //
  // News mode supplies its own lede and structure, and its rules contradict
  // these outright: HOOKS asks for a contrarian claim or a rhetorical
  // question, VOICES for first-person hard-won experience, STORIES for a
  // personal anecdote, and AUTHOR PRESENCE governs how a columnist refers to
  // themselves — none of which belong in a report. Emitting both and relying
  // on "this section wins" would leave two contradictory sets of instructions
  // in one prompt and let the model pick; not emitting them is the honest fix.
  const craftBlock =
    input.mode === 'news'
      ? ''
      : `=== HOOK — FOLLOW EXACTLY ===
${picked.hook}

=== STRUCTURE ARC — FOLLOW EXACTLY ===
${picked.arc}

=== NARRATIVE VOICE — APPLY THROUGHOUT ===
${picked.voice}

=== AUTHOR PRESENCE — HOW MUCH OF YOU REACHES THE PAGE ===
${picked.personaPresence}

This governs the whole article and overrides any instinct to introduce yourself.
It is drawn fresh for every piece, so do not fall back on the shape your last
article used. Whatever it says, these hold:
- Never state your years of experience as a number unless the line above
  explicitly tells you to state your credential.
- Never open a sentence with "As a ${or(p.role, 'professional')}," or "In my experience as a ${or(p.role, 'professional')},".
  That construction is the single most recognisable tell that a profile was
  pasted into a prompt.
- Never restate your expertise in the conclusion. Closing by reminding the
  reader who you are undoes everything the body earned.

=== MICRO-STORY — PLACE AS INSTRUCTED ===
${picked.story}`;

  // A report ends on its least important fact so an editor can cut from the
  // bottom. A call to action is the opposite of that.
  const ctaBlock =
    input.mode === 'news'
      ? ''
      : `=== CONCLUSION AND CTA ===
${picked.cta}`;

  const modeBlock =
    input.mode === 'news'
      ? `=== NEWS MODE — YOU ARE REPORTING, NOT COMMENTING ===
This is a news report. It is a different craft from the rest of this brief, and
where the two disagree, this section wins.

THE RULE THAT GOVERNS EVERYTHING ELSE: you are a reporter here, not a columnist.
Write in the THIRD PERSON. No "I", no "we", no first-hand anecdote, no personal
opinion, no advice to the reader. Your persona still governs word choice,
sentence rhythm and judgement about what matters — it does not put you in the
story. AUTHOR PRESENCE below is overridden: your name is the byline, and it
appears nowhere in the text.

ATTRIBUTION IS THE WHOLE JOB
- Every fact that is not self-evident carries its source in the same sentence
  or the one after: "according to <named source>", "<name>, <title>, said in a
  statement on <date>", "filings published on <date> show".
- Attribute to the most specific source you actually have. "Reports suggest",
  "experts say" and "it is understood" are refuges for a fact you cannot stand
  up — cut the claim instead.
- Distinguish what is confirmed from what is claimed. A company saying a thing
  is not the thing being true: "the company said" is not "the company did".
- If a figure is disputed, give both figures and both sources.

REGISTER — the plain, fast, factual style of a wire report or a national daily
- Short paragraphs, one or two sentences each. This is house style at every
  outlet that writes this way, and it is what makes a report scannable.
- Active voice, past tense, ordinary words. No adjectives of judgement:
  "significant", "shocking", "impressive", "concerning" are the reporter's
  opinion smuggled into a fact.
- Verbs of attribution stay neutral. "Said" is almost always right; "admitted",
  "claimed", "boasted" and "insisted" all editorialise.
- Give a number its unit, its period and its basis on first use.
- Name every person on first mention with their full name and title, then
  surname alone after.
- Direct quotes are verbatim and never invented. If you do not have a real
  quote, write reported speech — a fabricated quote is the one error a
  newsroom cannot survive.
- Open with the dateline convention if the location matters: CITY, Month DD —.

WHAT DOES NOT BELONG IN A REPORT
- No call to action. No "what this means for you" advice. No takeaways.
- No first-person experience, no "in my years", no anecdote from your own work.
- No rhetorical question as an opening.
- Recency is still the spine: lead with what changed in the last 30 days, and
  every substantive claim carries a date. If the research below does not
  support a claim, cut the claim — never invent a statistic.

=== LEDE — FOLLOW EXACTLY ===
${picked.newsLede}

=== REPORT STRUCTURE — FOLLOW EXACTLY ===
${picked.newsStructure}`
      : `=== BLOG MODE ===
This is an evergreen piece. Lead with a thesis or framework, not with news.
First-hand experience carries more weight than recency. Any research below is
supporting evidence, not the subject.`;

  /**
   * The exact `<figure>` the writer must swap `[[content_image]]` for.
   *
   * Styled only where inline styles actually survive ingest. On the restrictive
   * WordPress path KSES strips `style=`, so instructing it there would train
   * the writer to produce attributes the platform silently discards — the same
   * mistake as asking Ghost for `target="_blank"`, and the reason the brief
   * carries PLAIN_* variants of every other visual block. The sizing that stops
   * an image overflowing its column then has to come from the theme, which is
   * what themes do for an unstyled `<figure>` anyway.
   */
  const figureMarkup = input.profile.inlineStyles
    ? `<figure style="margin:32px 0;"><img src="URL" alt="what is actually visible in the frame" style="width:100%;height:auto;border-radius:12px;display:block;"><figcaption style="font-size:14px;color:#6b7280;text-align:center;margin-top:10px;">One line of context.</figcaption></figure>

The inline styles are not decoration. Without width:100%;height:auto an image wider
than the content column overflows it — on WordPress it breaks straight out of the
article container, and those styles are what stop it.

Ghost is different and you do not need to do anything about it: it REBUILDS a
<figure><img> into its own native image card, discarding these styles and applying
its own sizing. Verified by read-back on 2026-07-30. Write the markup exactly as
above either way — on Ghost it is harmlessly replaced, on WordPress it is what
holds the image inside the column.`
    : `<figure><img src="URL" alt="what is actually visible in the frame"><figcaption>One line of context.</figcaption></figure>

No style attributes: this platform strips them from the stored HTML, so adding them
here would produce markup the platform silently discards. The theme sizes the image.`;

  /**
   * Whether this article gets images at all, and what the writer must do
   * about it — conditioned on whether a provider is actually configured
   * rather than always assuming one, which used to send `generate_image`
   * calls to a machine with no key straight into `SETUP_INCOMPLETE`, and
   * left the writer instructed to leave a `[[content_image]]` placeholder
   * that nothing would ever replace.
   *
   * The "ON BY DEFAULT" framing is deliberate: it is the difference between
   * an instruction the writer can silently forget and one that states the
   * default outcome plus its one legitimate exception. The user's own
   * instructions about images always override this — that is said outright,
   * not left implied, because a default that cannot be overridden is not a
   * default, it is a rule with a hole in it.
   */
  const imageSection = hasImageProvider(input.imageProviders)
    ? `=== IMAGES — ON BY DEFAULT ===
An image provider is configured for this account, so this article gets a hero image
and an inline image BY DEFAULT — generate and upload both after writing, unless the
user explicitly said to skip images, write text only, or gave you a different image
instruction to follow instead. The user's instruction always overrides this default.

${picked.imagePlacement}
Leave the literal text [[content_image]] on its own, exactly once, while drafting.

YOU replace it yourself before calling create_post — nothing does it for you, and
both platforms REFUSE an article that still contains it. After upload_image returns
the hosted URL, swap the placeholder for exactly this, filling in the url and alt:

${figureMarkup}

This article's camera register, chosen from its seed:
${picked.imageLook}
Pass that line to generate_image verbatim as look:"..." on BOTH images, so the two match
and the article stays reproducible from its seed. Omit it and the tool picks its own.

Write each image prompt as a SUBJECT ONLY — what is happening and where. Do not write
camera, lighting, or style words in the prompt itself: generate_image adds the register
above plus the photographic rules for you, and repeating them fights its own instructions.

Every prompt must name something specific from THIS article — the actual industry, task,
setting, or moment you are writing about. A prompt that would fit any other article on any
other topic is the failure this rule exists to prevent.

- hero_image_prompt   → call generate_image with style:'photoreal_people', then
                        upload_image, then pass the resulting URL to create_post as
                        feature_image. MUST show people doing the work this article
                        is about. The hero is the post card and the social share
                        image, so it is the one everybody sees. Describe who they
                        are and what they are mid-way through doing.
- inline_image_prompt → call generate_image with style:'photoreal_scene', then
                        upload_image, then use the URL in the [[content_image]]
                        figure above. A different moment, detail, or step from the
                        same article — not a second angle on the hero.

Never ask for text, logos, screens with readable words, or signage in either image.`
    : `=== IMAGES ===
No image provider is configured for this account, so this article publishes with NO
images. Do NOT write a [[content_image]] placeholder anywhere — nothing will ever
replace it, and both platforms refuse an article that still contains one when it is
published. Do not call generate_image; it will fail with SETUP_INCOMPLETE. If the
user wants images, tell them to add a Gemini or xAI key with \`byline init\`, then
build the brief again.`;

  // The JSON contract's image fields, present only when the writer was
  // actually told to produce images. Leaving them in unconditionally used to
  // ask for hero_image_prompt/inline_image_prompt even on a machine the
  // "no provider configured" branch above just told NOT to call
  // generate_image — asking for a prompt nothing will ever use is the same
  // kind of dead instruction the IMAGES section itself exists to remove.
  const imageJsonFields = hasImageProvider(input.imageProviders)
    ? `  "hero_image_prompt": "SUBJECT ONLY. People doing the specific work THIS article is about, and where. No camera or style words. Pass to generate_image with style:'photoreal_people'",
  "inline_image_prompt": "SUBJECT ONLY. A different moment, detail, or step from THIS article. No camera or style words. Pass to generate_image with style:'photoreal_scene'",
  "hero_image_alt": "what is actually visible in the frame — the people and what they are doing. Not a restatement of the article title",
  "hero_image_caption": "one-line caption for the feature image",
  "inline_image_alt": "what is actually visible in the frame. Not a restatement of the article title",
  "inline_image_caption": "one-line caption",
`
    : '';

  const warnings: string[] = [];
  let researchOrigin: Brief['researchOrigin'] = 'none';
  let researchBlock: string;

  if (input.findings) {
    researchOrigin = 'provider';
    const f = input.findings;
    // Sources keep the PROVIDER's order, not date order. Neither provider sorts
    // newest-first (measured), and its ranking is by relevance — which is the
    // only defence against a provider backfilling off-topic filler that happens
    // to carry today's date. Re-sorting by date would put that filler first.
    // Every finding's date is judged against the window the result declares,
    // and the verdict is written next to that finding. The guard upstream only
    // requires ONE finding to be in-window — so without this, every other
    // source is rendered identically under a header naming that window, and a
    // ninety-day-old article reads exactly like a four-minute-old one.
    const tally = tallyWindow(f.findings, f.window, input.now ?? Date.now());
    const sources = f.findings
      .map((x, i) => {
        const v = tally.verdicts[i]!;
        // The absence of a usable date is stated where the date would go, not
        // by omitting the line — an omitted line reads as an oversight, and a
        // string `Date.parse` cannot read is not a date however date-shaped.
        const date =
          v.kind === 'in-window'
            ? x.publishedAt!
            : v.kind === 'out-of-window'
              ? `${x.publishedAt!} — OUTSIDE the ${f.window} window this research asked for; older than it looks, do not present it as recent`
              : v.why === 'missing'
                ? `NO DATE GIVEN by ${x.provider} — do not assert when this happened`
                : v.why === 'unparseable'
                  ? `NO USABLE DATE: ${x.provider} gave "${x.publishedAt}", which is not a readable date — do not assert when this happened`
                  : `NO USABLE DATE: ${x.provider} gave "${x.publishedAt}", which is in the future — do not assert when this happened`;
        // Surfaced so the writer can discount a fresh-but-irrelevant result.
        // Not gated on anywhere: no threshold has been measured.
        const rel =
          x.relevance === null ? '' : `\n    relevance ${x.relevance.toFixed(2)} (${x.provider}'s own score)`;
        return `[${i + 1}] ${x.title}\n    ${x.url}\n    ${date}${rel}\n    ${x.snippet}`;
      })
      .join('\n\n');

    // The synthesis is rendered because the user is paying for it, and labelled
    // NOT CITABLE because it carries no URL of its own — `citation_provenance`
    // can verify nothing lifted from it. Cite the numbered sources instead.
    const synthesis = f.answer
      ? `\n--- ${f.provider}'s SYNTHESIS — ORIENTATION ONLY, NOT CITABLE ---\n${f.answer}\n\nUse this to orient yourself. Do NOT cite it and do NOT quote it: it has no URL,\nso nothing in it can be attributed. Every claim you publish must trace to one of\nthe numbered sources below.\n`
      : '';

    // The header counts what is actually inside the window, not just what
    // carries a date. Reporting "N source(s), N dated" under a header naming
    // the window implied all N were fresh.
    researchBlock = `=== RESEARCH SUPPLIED — GROUND THE ARTICLE IN THIS ===
ORIGIN: ${f.provider}, ${f.window} window, ${f.findings.length} source(s), ${tally.dated} dated, ${tally.inWindow} inside the ${f.window} window. Selected by: ${f.selectedBy}.
${synthesis}
--- SOURCES — CITE THESE, BY URL ---
A recent date does NOT mean a source is about this topic. Search providers pad a
narrow date window with whatever they have, so a result stamped today can be
entirely unrelated (measured: a tablet unboxing video returned for a stock-market
query, dated today). Read each source before you lean on it, and drop any that is
not actually about ${input.topic}. Do not cite a source you would not defend.

${sources}`;

    if (tally.undated > 0) {
      warnings.push(
        `${tally.undated} of ${f.findings.length} sources carry no usable publication date — do not assert when those events happened.`,
      );
    }
    if (tally.outOfWindow > 0) {
      warnings.push(
        `${tally.outOfWindow} of ${f.findings.length} sources fall outside the ${f.window} window this research asked for — they are marked in the brief; do not present them as recent.`,
      );
    }
  } else if (input.research) {
    researchOrigin = 'byor';
    const urls = input.research.match(/https?:\/\/\S+/g) ?? [];
    researchBlock = `=== RESEARCH SUPPLIED — GROUND THE ARTICLE IN THIS ===
ORIGIN: supplied by the caller — TRUSTED, NOT VERIFIED BY BYLINE. Byline did not
fetch this, cannot confirm it is recent, and cannot confirm the text matches any
source it names. Treat every figure in it as the caller's claim, and do not add
figures of your own.

${input.research}`;
    if (urls.length === 0) {
      warnings.push(
        // States only what is true today. The earlier wording ("score_draft
        // cannot cross-check any citation") entailed that it WOULD cross-check
        // given URLs; it takes no findings at all, so that promised a
        // verification the user would not get.
        'The supplied research contains 0 source URLs. Claims from it cannot be attributed inline, and the GEO guidance below will be impossible to satisfy for those claims.',
      );
    }
  } else {
    researchBlock =
      '=== NO RESEARCH SUPPLIED ===\nDo not fabricate statistics. Where you would cite a figure you do not have, write from experience instead.';
  }

  return {
    seed,
    choices,
    researchOrigin,
    warnings,
    brief: `You are ${p.name}, ${or(p.role, 'an industry expert')} with ${p.years_of_experience} years of experience in ${or(p.subject_expertise, or(p.description, 'your field'))}.

That is who you ARE. It is not a thing you have to announce. How much of it
reaches the page is decided by AUTHOR PRESENCE below, and on most articles the
answer is "less than you think" — a person who writes regularly does not
reintroduce themselves to their own readers every week.

YOUR TASK: Write a comprehensive, SEO-optimised article about: ${input.topic}

CRITICAL REQUIREMENTS
- Minimum length: ${words} words
- Language: ${language}
- ${input.mode === 'news' ? `Write in the THIRD PERSON. ${p.name} is the byline, not a character in the story — see NEWS MODE below.` : `Write in FIRST PERSON as ${p.name}`}
- Location context: ${[p.state, p.country].filter(Boolean).join(', ') || 'global'}

YOUR AUTHOR PROFILE — this shapes HOW you write, and is never copied onto the page
Treat the lines below as settings on your own judgement, not as facts to state.
None of these labels should ever appear as text in the article: a reader learns
your tone by reading you, not by being told what your tone is.
- Writing style: ${or(p.writing_style, 'Professional')}
- Tone of voice: ${or(p.tone_of_voice, 'Engaging')}
- Communication style: ${or(p.communication_style, 'Clear')}
- Storytelling approach: ${or(p.storytelling_style, 'Narrative-driven')}
- Sentence structure: ${or(p.sentence_structure, 'Varied')}
- Focus areas: ${or(p.beats_or_focus_areas, or(p.industry_specialization, 'industry insights'))}
- Research methodology: ${or(p.research_methodology, 'Data-driven with first-hand experience')}
- Personality traits: ${or(p.personality_traits, 'Professional, knowledgeable')}
- Bias tendency: ${or(p.bias_tendency, 'none stated')}
- Risk tolerance in opinions: ${or(p.risk_tolerance_in_opinions, 'medium')}
- Cultural context: ${or(p.cultural_influence, or(p.local_journalistic_style, 'none stated'))}
${ex(p, 'target_audience', '- Written for: $ — pitch every explanation at the least specialist reader in that list.')}${ex(p, 'reading_level', '- Reading level: $')}
SPECIFIC AUTHOR INSTRUCTIONS
${or(p.persona_specific_instructions_for_ai, 'Provide actionable takeaways grounded in real experience.')}

${modeBlock}

${researchBlock}

${craftBlock}

${imageSection}

=== TABLE THEME — USE THESE EXACT COLOURS ===
${picked.tableTheme}

=== BLOCKQUOTE STYLE — USE EXACTLY ===
${picked.blockquote}

${ctaBlock}

=== LINKING RULES ===
- 8 to 10 external links maximum.
- Format: <a href="https://example.com" rel="noopener noreferrer">Anchor</a>
${input.profile.keepsLinkTarget ? '' : `- Do NOT add a target attribute to any link. ${input.profile.label} strips it on ingest, so it is dead weight.\n`}- Link only the first mention of any brand or source.
- Never leave a raw URL as plain text.
- Spread links out; never cluster several in one paragraph.

=== SUMMARY BLOCK — THE FIRST THING IN THE ARTICLE ===
Before the opening paragraph, before any heading, emit this block using the exact
skin below. It gives the reader the answer in five seconds and gives answer engines
a clean passage to lift.
${picked.summaryBlock}
Rules for its content: the bolded first sentence must answer the article's core
question completely on its own, with no pronouns pointing outside the block. Then
3-4 bullets, each opening with a bolded 2-4 word label followed by a specific fact
with a number or a named source. No bullet may be generic advice.

=== CALLOUT PANEL — USE ONCE, MID-ARTICLE ===
${picked.callout}
Place it where a reader is most likely to make an expensive mistake. One panel only.

=== AEO — ANSWER ENGINE OPTIMISATION ===
Answer engines (Google AI Overviews, Perplexity, ChatGPT search) lift self-contained
Q&A pairs. Structure for extraction:
- Phrase at least TWO H2 or H3 headings as the exact question a reader would type.
- Directly under each question heading, answer it completely in the first 40-60
  words, in one paragraph, before any elaboration. Lead with the answer, not context.
- Every answer paragraph must stand alone if quoted with no surrounding text. No
  "as mentioned above", no "this means", no pronouns referring outside the paragraph.
- Include one short definitional sentence of the form "X is Y" for the main concept.
- Close the article with an H2 of "Frequently asked questions" containing 3 H3
  question headings, each answered in 40-60 words.

=== GEO — GENERATIVE ENGINE OPTIMISATION ===
Generative engines cite what they can attribute and verify. Write to be quotable:
- Attribute every statistic inline with source AND date: "According to Deloitte's
  2024 study..." or "TCS reported in FY26...". A bare number is uncitable.
- Prefer specific over round numbers. 3.4% is citable; "around 3%" is not.
- Name entities in full on first use. Write the organisation, product, and person
  names out so a model can resolve them without the surrounding page.
- ${input.mode === 'news' ? 'Authority in a report comes from sourcing, never from the reporter. Name the document, the filing, the official and the date — that is what a generative engine can attribute and verify.' : 'Establish authority the way AUTHOR PRESENCE above tells you to, and no further.'}
  Generative engines weight first-hand specificity, not self-description: an
  unrepeatable operational detail is worth more to them than a stated job title,
  and a stated job title is what every competing article already has.
- ${input.mode === 'news' ? 'Give at least one fact that is not in every other report on this story — a figure from the primary document, a detail from a filing, a response nobody else obtained. Never a first-person observation.' : 'Give at least one claim that exists nowhere else — a first-hand observation, a number from your own delivery work, a named trade-off you have lived.'}
- Never assert a figure the research does not contain. An invented statistic that
  gets cited is worse than no citation at all.

=== SEO ===
- Title: primary keyword near the start, 50-60 characters.
- Meta description: 155-160 characters, primary keyword, subtle CTA.
- H2 headings carry keywords naturally; H3 supports its H2. Never skip a level.
- Primary keyword in the first paragraph, 1-2% density, LSI terms throughout.
- Paragraphs of 2-4 sentences.
- Reference the current year at least once.

${htmlRules(input.profile)}

=== EVIDENCE ===
- Include real figures, percentages, or comparative data, at least one per 250 words.
- One data table: benchmarks, tool comparison, case-study metrics, before/after, cost-benefit, or timeline.
- Cite recognised sources and hyperlink them.
${ex(p, 'citation_preference', '- Prefer these sources, in this order: $')}${ex(p, 'fact_checking_level', '- Fact-checking level: $. A claim you cannot source is cut, not softened.')}${ex(p, 'preferred_quotes_from', '- If you quote a thinker, prefer: $')}${ex(p, 'quote_usage_frequency', '- Quotation frequency: $. Never open the article with someone else\'s words.')}
- ${input.mode === 'news' ? 'Every substantive fact carries its source in the same sentence or the next. Aim for at least one attributed claim per 200 words — that density is what score_draft measures in news mode.' : 'Include at least two concrete first-hand moments — a named scenario, a specific trade-off, a decision you regretted. Spread them; at least one after the midpoint.'}

=== TEXTURE — APPLY THROUGHOUT ===
${picked.humanTexture}
${ex(p, 'favorite_rhetorical_devices', 'Devices this author actually reaches for: $. Use them where they earn their place; forcing one is worse than not using it.')}${ex(p, 'commonly_used_transitions', 'Transitions in this author\'s voice: $. Vary them — repeating one twice in an article is a tic, not a style.')}${ex(p, 'use_of_humor', 'Humour: $')}

${HUMANISING}
${ex(p, 'avoid_in_writing', '\nAlso never, per this author\'s own rules: $')}
${extrasBlock(p)}

=== OUTPUT FORMAT ===
Return ONLY a valid JSON object. No markdown, no code fences, no preamble.

Social titles must NOT duplicate the SEO title — a social card competes for a
click in a feed, a search title competes for a click in a result list. Write them
differently on purpose.

{
  "article_title": "50-60 character SEO title, primary keyword near the start",
  "meta_title": "50-60 chars — may equal article_title, or sharpen it for search",
  "meta_description": "155-160 characters, primary keyword, subtle CTA",
  "custom_excerpt": "1-2 sentences, max 300 chars, shown in listings and feeds",
  "og_title": "up to 88 chars — Facebook/LinkedIn/WhatsApp, curiosity-led, NOT the SEO title",
  "og_description": "up to 200 chars — the social hook, written to earn a click in a feed",
  "twitter_title": "up to 70 chars — punchier and shorter than og_title",
  "twitter_description": "up to 200 chars — sharpest framing, often the single most surprising number",
  "html_content": "single-line ${input.profile.label}-compatible HTML, summary block first",
  "word_count": 0,
  "faq": [
    {"question": "exact question a reader would type", "answer": "40-60 word self-contained answer"}
  ],
${imageJsonFields}  "tags": ["tag1", "tag2"],
  "primary_keyword": "main keyword",
  "secondary_keywords": ["k1", "k2", "k3"]
}

The faq array must mirror the Frequently asked questions section in html_content
exactly — same questions, same answers. It is used to build FAQPage structured
data, and schema that disagrees with the visible page is a manual-action risk.`,
  };
}
