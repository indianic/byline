import type { HtmlProfile } from '../../../craft/html-profile.js';
import type { PlatformAdapter } from '../types.js';
import type { WordPressAdapter } from './index.js';

/**
 * This was the design's central claim, and the most likely place to be wrong.
 *
 * WordPress runs the content it receives through KSES before saving it. A user
 * who lacks the `unfiltered_html` capability has every `style=` attribute
 * stripped out; a user who holds it does not. Administrators and editors hold
 * that capability on a single-site install, but on a WordPress **multisite**
 * network only Super Admins do — an ordinary editor who publishes a styled
 * post fine on single-site gets it silently flattened on multisite. That is
 * why this profile cannot be a constant the way Ghost's is: it must be derived
 * per authenticated user, per site.
 *
 * The permissive branch (capability present) was confirmed by a live probe on
 * 2026-07-29 against a real WordPress install, WordPress account `indianic`,
 * role administrator, single-site install — see `docs/WORDPRESS-NOTES.md` for
 * the full request-by-request account. Every element/attribute claim in
 * `PERMISSIVE_PRESERVED` and the permissive `buildProfile` branch below is
 * measured: `content.raw` round-tripped byte-identical to what was sent for
 * every one of them.
 *
 * The restrictive branch (capability absent) remains UNVERIFIED — confirm by
 * a future probe with an account that genuinely lacks `unfiltered_html`
 * (an Author/Contributor role, or any account on a multisite network that is
 * not a Super Admin). The only account available for the 2026-07-29 probe was
 * an administrator, who always holds the capability, so this branch is still
 * reasoned from WordPress's documented KSES behaviour, not measured. Do not
 * remove these markers on the strength of that probe.
 */

/**
 * Resolved profiles, memoised per site.
 *
 * Keyed by `adapter.slug` rather than the adapter object itself, because
 * `makeAdapter(site)` constructs a brand-new adapter on every single call
 * (see `src/plugins/registry.ts` and `src/tools/craft-tools.ts`'s `profileFor`)
 * — a WeakMap keyed on the adapter instance would never hit. Per the caching
 * contract documented on `PlatformPlugin.htmlProfile`, this is treated as
 * stable for the lifetime of the process: a site's capabilities are not
 * expected to change between one `score_draft` call and the next.
 */
const cache = new Map<string, HtmlProfile>();

/**
 * Measured against a real WordPress install (administrator, single-site).
 * EVERY tag below round-trips through `content.raw` byte-identical to what
 * was sent — none of them are unwrapped, rebuilt, or have an attribute
 * stripped. `div`/`section`/`aside`/`span`/`small`/`mark`/`pre` are
 * structural elements kept as elements (not unwrapped the way Ghost unwraps
 * them), so they belong in `preserved`, not in `unwrapped`. `unfiltered_html`
 * therefore has no non-empty `unwrapped` set for this account: WordPress
 * core, for a user who holds the capability, does not unwrap any HTML
 * element on ingest.
 *
 * The original 2026-07-29 human-run probe (see `docs/WORDPRESS-NOTES.md`)
 * covered only a subset of this list: `div section aside span small mark pre
 * table td p blockquote a h2`. The rest — `h3 h4 strong em ul ol li img hr
 * code thead th figure figcaption` — were claimed measured here without
 * actually being exercised anywhere repeatable. Every one of them is now
 * covered by the automated, self-cleaning probe in
 * `tests/integration/wordpress.integration.test.ts` (`RUN_INTEGRATION=1`),
 * which round-trips the complete tag list above against the live site on
 * every run. Widening this set further should extend that test, not just
 * this comment.
 */
const PERMISSIVE_PRESERVED = new Set([
  'p', 'h2', 'h3', 'h4', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'hr', 'code',
  'div', 'section', 'aside', 'span', 'small', 'mark', 'pre',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
  // Verified by live probe 2026-08-12 against the probed WordPress install,
  // account holding unfiltered_html: a bare <iframe>, a <figure><iframe>...<figcaption>
  // wrapper, a Bunny Stream embed, and a `<!-- wp:embed -->` block all
  // round-tripped in content.raw unchanged. The same probe measured that a
  // remote <video src> ALSO survives on WordPress — unlike Ghost, which strips
  // it entirely — but byline still does not upload video, so that only matters
  // for a hand-written <video> tag, not for embed_video's own output. See
  // docs/WORDPRESS-NOTES.md for the full probe. Do NOT add 'iframe' to
  // RESTRICTIVE_PRESERVED below on the strength of this probe — this account
  // holds unfiltered_html, and whether KSES strips <iframe> for an account
  // that lacks it remains UNVERIFIED (see that set's doc comment).
  'iframe',
]);
const PERMISSIVE_UNWRAPPED = new Set<string>([]);

/**
 * UNVERIFIED — no probe has run against an account that genuinely lacks
 * `unfiltered_html` (see the module doc comment above). Reasoned from KSES's
 * documented default allowed-tag list (`$allowedposttags` in
 * wp-includes/kses.php), not measured.
 *
 * `table`/`thead`/`tbody`/`tr`/`th`/`td` and `figure`/`figcaption` are listed
 * here, not in `RESTRICTIVE_UNWRAPPED`, because KSES's documented behaviour
 * strips *attributes* it does not allow (`style=`, in particular) without
 * deleting the *element* — a plain, unstyled `<table>` is still a table.
 * `unfiltered_html` gates whether `style=` survives, not whether these
 * structural tags are stripped or unwrapped. An earlier version of this set
 * put the table family in `RESTRICTIVE_UNWRAPPED`, which — combined with
 * `visualContainers` being forced empty for the same reason — made
 * `score_draft`'s `ai_summary_block` check (which is BLOCKING) impossible to
 * pass on this path, and told a writer in the same breath that a `<table>`
 * summary block was required and that `<table>` would be stripped. Do not
 * reintroduce that without a probe that actually shows table elements being
 * deleted, not just destyled, for an account lacking the capability.
 *
 * `iframe` is deliberately NOT in this set. WordPress core's documented
 * `wp_kses_allowed_html('post')` list for an account lacking `unfiltered_html`
 * does not include `iframe` at all, so the documented (not measured) behaviour
 * is that KSES strips it outright — UNVERIFIED, same as everything else here:
 * the only account ever available (2026-07-29 and 2026-08-12) held
 * `unfiltered_html` unconditionally, so no probe has shown what actually
 * happens to an <iframe> for an account that lacks it. Do not add 'iframe'
 * here without a probe against such an account that shows it surviving.
 */
const RESTRICTIVE_PRESERVED = new Set([
  'p', 'h2', 'h3', 'h4', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'hr', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
]);
const RESTRICTIVE_UNWRAPPED = new Set(['div', 'section', 'aside', 'span', 'small']);

/**
 * Notes for an account that holds `unfiltered_html` (single-site admins and
 * editors; multisite super-admins). Distinct from `RESTRICTIVE_NOTES` below —
 * and from Ghost's notes, which recommend a styled `<table>` for a visual
 * block. Ghost unwraps `<div>` to bare text on ingest, so a table is Ghost's
 * only styled container; WordPress, for this account, is the opposite: `<div>`
 * survives with its `style=` intact, so a styled `<div>` card is the natural
 * choice here, not a table.
 */
const PERMISSIVE_NOTES: readonly string[] = [
  'This WordPress account holds the unfiltered_html capability (measured by live probe on 2026-07-29): inline style="" attributes, class="" attributes, and essentially every structural element survive WordPress\'s content sanitizer unchanged.',
  'Use a styled <div> for a visual summary block — unlike Ghost, where <div> is unwrapped to bare text, WordPress keeps it as an element with its style="" intact for this account.',
  '<blockquote style="..."> also survives passthrough, inner <p> included — it is not rebuilt as a native node the way Ghost rebuilds it.',
  'Hand-written id attributes on headings survived unchanged in the stored content (content.raw) for this account — WordPress did not strip or overwrite them. (Whether the rendered theme output auto-generates ids for headings that lack one was not tested by this probe.)',
  'target="_blank" on a link survives, along with rel="noopener noreferrer".',
  'This capability check is per-account, not per-site: another author on the same install may lack unfiltered_html (this is the normal case on a multisite network, where only Super Admins hold it) and get every style stripped. Do not assume this guidance applies to every author on this site.',
];

/**
 * Notes for an account that lacks `unfiltered_html` — the normal case for an
 * Editor or Author on a WordPress multisite network, and the fail-safe answer
 * whenever the capability could not be read at all (network error, unexpected
 * response shape, a 403 on `users/me`). UNVERIFIED: no probe has exercised
 * this path (see the module doc comment above) — these notes are reasoned
 * from KSES's documented behaviour, not measured.
 */
const RESTRICTIVE_NOTES: readonly string[] = [
  'This WordPress account does not hold the unfiltered_html capability (or it could not be confirmed), so every inline style="" attribute is expected to be stripped by WordPress\'s content sanitizer on save — UNVERIFIED, no probe has run against an account that actually lacks this capability.',
  'Do not rely on any inline style or class surviving. Write plain, structural HTML — headings, paragraphs, lists, links, tables, and images — and let the site theme handle appearance.',
  'Use a plain <table> (no style="" attribute) for a visual summary block. KSES strips attributes it does not allow, not the structural element itself — UNVERIFIED for this specific account, but there is no documented WordPress behaviour that deletes a bare <table>, so it is the safe structural choice, not a styled one.',
  'This is the safe assumption when nothing else is known — it is also what an ordinary editor on a WordPress multisite network gets by default, since only Super Admins hold unfiltered_html there.',
];

/**
 * Builds the profile for one resolved capability state.
 *
 * `visualContainers` is ordered best-first, where "best" means the container
 * keeps its own custom styling. With `inlineStyles: true` (measured), `div` is
 * listed first: it is the natural container for a styled card on WordPress,
 * where (unlike Ghost) it survives ingest as an element with its style
 * intact.
 *
 * `table` is second, and it is here because leaving it out broke cross-posting
 * outright. `score_draft`'s BLOCKING `ai_summary_block` check accepts only the
 * containers in this list, and a styled `<table>` is the ONLY summary container
 * that works on Ghost — a `<div>` there is unwrapped to bare text. So one
 * article written once and published to both platforms, which is the workflow
 * the README advertises, was unsatisfiable: the same HTML scored `pass` on
 * Ghost and `blocked` on WordPress. Observed twice on live publishes, 2026-07-29
 * and 2026-07-30.
 *
 * Its inclusion is measured, not reasoned: `docs/WORDPRESS-NOTES.md` records
 * `<table>` round-tripping byte-identical WITH inline styles for an account
 * holding `unfiltered_html`. It sits after `div` because on this platform a
 * styled div is still the better-looking choice; it is simply no longer the
 * only accepted one.
 *
 * `blockquote` is third — also measured to survive passthrough with its style
 * and inner `<p>` intact, so it remains an acceptable alternative.
 *
 * With `inlineStyles: false` (UNVERIFIED), no container is confirmed to keep
 * custom *styling*, but `<table>` still exists as a plain structural element
 * (see `RESTRICTIVE_PRESERVED`'s doc comment) — so it is listed, unstyled,
 * rather than leaving the array empty. An empty array here made
 * `score_draft`'s BLOCKING `ai_summary_block` check impossible to ever pass
 * on this path (`[].some(...)` is always false), which is also the fail-safe
 * branch taken on any error reading capabilities — meaning one transient
 * network blip could brick scoring for a site with no way to recover short of
 * a process restart. A brief built from this profile must produce a draft
 * that can pass `score_draft`; leaving this empty broke that contract.
 */
export function buildProfile(inlineStyles: boolean): HtmlProfile {
  return {
    platform: 'wordpress',
    label: 'WordPress',

    preserved: inlineStyles ? PERMISSIVE_PRESERVED : RESTRICTIVE_PRESERVED,
    unwrapped: inlineStyles ? PERMISSIVE_UNWRAPPED : RESTRICTIVE_UNWRAPPED,

    inlineStyles,
    // Measured together with inlineStyles on 2026-07-29: class="myclass" round-tripped
    // unchanged for the permissive account. Not independently probed for the
    // restrictive path (UNVERIFIED), so held conservative (false) there.
    classAttributes: inlineStyles,

    // Measured 2026-07-29 (permissive): a standalone <blockquote style="..."> with its
    // inner <p> survived byte-identical, i.e. passthrough, not rebuilt. The restrictive
    // path is UNVERIFIED and stays conservative.
    blockquote: 'passthrough',
    // Measured 2026-07-29: a hand-written <h2 id="myid"> round-tripped unchanged in
    // content.raw — WordPress did not strip or overwrite it. That is the ONLY thing
    // this probe tested; whether the rendered theme output (content.rendered)
    // auto-generates ids for headings that lack one was never measured, and no claim
    // about content.rendered belongs here or in docs/WORDPRESS-NOTES.md.
    // `generatesHeadingIds` describes the STORED content only, and for that, this
    // account's WordPress does not generate or overwrite ids. UNVERIFIED for the
    // restrictive path.
    generatesHeadingIds: false,
    // Measured 2026-07-29: target="_blank" round-tripped unchanged for the permissive
    // account. UNVERIFIED for the restrictive path, held conservative (false) there.
    keepsLinkTarget: inlineStyles,

    // See this function's doc comment for why the restrictive branch is
    // ['table'] rather than [] — a plain table is structural, not styled.
    visualContainers: inlineStyles ? ['div', 'table', 'blockquote'] : ['table'],

    notes: inlineStyles ? PERMISSIVE_NOTES : RESTRICTIVE_NOTES,

    // Only the permissive branch was confirmed by the 2026-07-29 live probe;
    // the restrictive branch is reasoned from documented KSES behaviour, never
    // measured (see the module doc comment). `buildBrief`'s header text is
    // conditioned on this so an unverified profile never claims to be
    // "VERIFIED BY LIVE PROBE".
    verified: inlineStyles,
  };
}

/**
 * Whether the authenticated user behind `adapter` holds `unfiltered_html`.
 *
 * Unlike the old version of this function, a failed read is NOT swallowed
 * into `false` here — it is thrown, so `resolveWordPressProfile` can tell
 * "genuinely lacks the capability" (a successful read that came back false)
 * apart from "the read itself failed" (network error, non-2xx, malformed
 * body) and avoid caching the latter. See `resolveWordPressProfile` for how
 * each is handled.
 */
async function hasUnfilteredHtml(adapter: WordPressAdapter): Promise<boolean> {
  const capabilities = await adapter.getCapabilities();
  return capabilities.unfiltered_html === true;
}

/**
 * Resolves the WordPress HTML profile for the authenticated user behind
 * `adapter`, deriving `inlineStyles` from their live `unfiltered_html`
 * capability rather than assuming a constant.
 *
 * Memoises per site (`adapter.slug`) so that repeated calls — `score_draft`
 * and `build_writing_brief` each resolve a profile on every invocation — do
 * not each cost an HTTP round-trip. See the module-level `cache` doc comment
 * for why this is keyed by slug rather than by adapter identity.
 *
 * A FAILED capability read (network error, non-2xx, malformed body) is
 * deliberately NOT cached — only a successful read is, whatever its boolean
 * value. Caching a failure the same as a successful "does not hold it" would
 * mean a single transient network blip permanently forces the restrictive
 * profile on every subsequent `score_draft`/`build_writing_brief` call for
 * that site until the process restarts. Instead, a failed read returns the
 * restrictive profile for THIS call only (same fail-safe direction as
 * before: never guess permissive) and is retried in full on the next call.
 */
export async function resolveWordPressProfile(adapter: PlatformAdapter): Promise<HtmlProfile> {
  const cached = cache.get(adapter.slug);
  if (cached) return cached;

  let inlineStyles: boolean;
  try {
    inlineStyles = await hasUnfilteredHtml(adapter as WordPressAdapter);
  } catch {
    return buildProfile(false);
  }

  const profile = buildProfile(inlineStyles);
  cache.set(adapter.slug, profile);
  return profile;
}
