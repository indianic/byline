import type { Finding, RecencyWindow } from './types.js';

/**
 * Normalise a date-time string to explicit UTC, or null if it is not one.
 *
 * **A date-time form carrying no offset is parsed as LOCAL time** by the
 * ECMAScript spec, so a bare `Date.parse` on one is wrong by the running
 * machine's offset (+5:30 on the maintainer's box, up to 14h elsewhere) — well
 * outside `DATE_GRACE_MS`. Measured 2026-07-30: Brave's `page_age` arrives in
 * exactly that form (`"2026-07-30T07:52:29"`, no `Z`), so a 55-minute-old
 * article would date five and a half hours out and the window check would then
 * admit or refuse it for entirely the wrong reason — on a field the news guard
 * treats as measured.
 *
 * Lives HERE, not in an adapter, and this is the second time it has moved.
 * It began in `brave/index.ts` because Brave was the only caller; when
 * `window.ts` needed it too, it was exported from there and imported back —
 * which left the family's shared freshness authority depending on ONE
 * provider's adapter. That inverts the plugin boundary: remove or restructure
 * Brave and the shared module breaks, for a function that was never a Brave
 * concept. Reusing it rather than writing a second Z-appending parser was
 * right (`SLUG_PATTERN` and `IMAGE_LOOKS` both drifted from exactly that); the
 * location was not. Adapters import it from here.
 *
 * Returns null rather than guessing when the value is absent or unparseable.
 * A RELATIVE string ("9 hours ago") must never be resolved against the clock
 * into this field — that would put a derived timestamp where downstream code
 * expects a measured one.
 */
export function isoUtc(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(stamped);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Days a window reaches back. The members Task 1 measured both providers to honour. */
const WINDOW_DAYS: Record<RecencyWindow, number> = { day: 1, week: 7, month: 30 };

/**
 * How far outside the window a date is still treated as inside it.
 *
 * Fixed, and deliberately NOT scaled by window size. A grace of "one more day"
 * is +100% at `day` and +3% at `month` — largest exactly where recency matters
 * most, which is backwards. Six hours is the same allowance at every window.
 *
 * The reason is provider timestamp COARSENESS, not timezone skew: both adapters
 * already normalise to ISO-with-`Z` at the boundary through this file (`isoUtc`
 * for Brave's `page_age`, `isoWireDate` for Tavily's RFC 1123
 * `published_date`), so no offset survives to be tolerated here. What does
 * survive is precision loss — `docs/RESEARCH-NOTES.md`
 * measured Tavily returning dates rounded to exact hour boundaries
 * (`Thu, 30 Jul 2026 04:00:00 GMT`, `02:00:00 GMT`), and a publisher's own
 * `published_date` is often the article's date rather than its last update. Six
 * hours covers that rounding without admitting a genuinely stale source: a
 * two-day-old article can no longer pass a one-day window.
 *
 * The same allowance runs the other way, as the tolerance on "is this date in
 * the future" — a clock a few minutes ahead is rounding, a date next year is not
 * a date worth trusting.
 */
export const DATE_GRACE_MS = 6 * 3600 * 1000;

/**
 * A full ISO 8601 date, `YYYY-MM-DD` at minimum, optionally with a time and
 * (optionally) an explicit offset.
 *
 * `Date.parse` alone is too permissive to define "a readable date": `"5"`,
 * `"0"`, `"2026"`, and `"2026-07"` all parse successfully (as 2001-04-30,
 * 1999-12-31, 2026-01-01, and 2026-07-01 respectively), which let them count
 * as dated, classify as in- or out-of-window, and print on the brief in the
 * date position. A bare year or year-month is syntax `Date.parse` accepts
 * that neither research provider was ever MEASURED to emit — see
 * `docs/RESEARCH-NOTES.md` — so it is required to look like one of the two
 * shapes that actually were measured (this, or RFC 1123 below) before it is
 * trusted as one.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * RFC 1123, Tavily's raw wire format for `published_date` before the adapter
 * normalises it — e.g. `"Thu, 30 Jul 2026 04:00:00 GMT"`. Measured in
 * `docs/RESEARCH-NOTES.md`.
 */
const RFC1123_DATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Milliseconds since epoch for a date-SHAPED string, or null for anything
 * else — including date-shaped junk `Date.parse` would happily accept (see
 * `ISO_DATE_RE`'s doc) and a string that fails to parse despite matching a
 * shape (`"2026-13-45T00:00:00Z"`).
 *
 * A `YYYY-MM-DDTHH:mm:ss` form with no `Z` and no offset is parsed by
 * `Date.parse` as host-LOCAL time per the ECMAScript spec, shifting by up to
 * ~14 hours depending on the machine's timezone — well past `DATE_GRACE_MS`.
 * This is the exact trap `isoUtc` — forty lines above, in this file — already
 * documents and fixes for Brave's `page_age`. Both adapters
 * normalise to ISO-with-`Z` before a `Finding` is built, so this cannot
 * arrive from either provider — but `findings` reaches `build_writing_brief`
 * as MCP input from the host model, which is not bound by that. Reusing
 * `isoUtc` (rather than a second hand-written Z-appending parser here) keeps
 * that one rule in one place; it is a no-op on a bare date and on an
 * already-offset datetime, and only changes the result for the no-offset
 * case it exists to fix.
 *
 * RFC 1123 strings are NOT run through `isoUtc`: they always carry an
 * explicit `GMT`, and appending `Z` to one (`isoUtc`'s fix for the ISO case)
 * would corrupt it into unparseable text instead.
 */
function parseDate(raw: string): number | null {
  if (ISO_DATE_RE.test(raw)) {
    const iso = isoUtc(raw);
    const ms = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }
  if (RFC1123_DATE_RE.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * ISO-with-`Z` for a provider's raw wire date, or null for anything that is
 * not one of the two MEASURED formats — the form an adapter needs to build
 * `Finding.publishedAt`.
 *
 * **Never throws.** `new Date(value).toISOString()` raises
 * `RangeError: Invalid time value` on a truthy-but-unparseable string, and an
 * exception inside a field mapper propagates out of `search()` and discards
 * the ENTIRE search result over one malformed character in one field of one
 * finding — the rule the Brave adapter's `decodeEntities` already states, and
 * which the Tavily adapter broke until this existed. A date nobody can read
 * costs that one finding its date; `classifyDate` then counts it `undated`,
 * which is what the news guard is for.
 *
 * Calls `parseDate`, deliberately, rather than `isoUtc`: `isoUtc` appends `Z`
 * to any value carrying no offset, which turns Tavily's
 * `"Thu, 30 Jul 2026 04:00:00 GMT"` into unparseable text. `parseDate` is the
 * one place that already tells the two measured shapes apart, so an adapter
 * and the window check agree by construction. (Brave's `page_age` is ISO by
 * measurement and calls `isoUtc` directly — the narrower rule, not a second
 * copy of this one.)
 */
export function isoWireDate(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const ms = parseDate(raw);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * What a finding's `publishedAt` is worth.
 *
 * `undated` covers three inputs that must be treated identically, because a date
 * nobody can act on is not a date: absent, unparseable (not date-shaped, or
 * date-shaped but not a real date — a bare truthiness test counts either as
 * dated and then prints it on the brief as though it were one), and further
 * in the future than the grace allows.
 */
export type DateVerdict =
  | { kind: 'in-window'; at: number }
  | { kind: 'out-of-window'; at: number }
  | { kind: 'undated'; why: 'missing' | 'unparseable' | 'future' };

export function classifyDate(
  publishedAt: string | null | undefined,
  window: RecencyWindow,
  now: number = Date.now(),
): DateVerdict {
  if (!publishedAt?.trim()) return { kind: 'undated', why: 'missing' };
  const at = parseDate(publishedAt.trim());
  if (at === null) return { kind: 'undated', why: 'unparseable' };
  // Upper bound. Without one, `2099-01-01` reads as fresher than anything real
  // and passes every window as breaking news.
  if (at > now + DATE_GRACE_MS) return { kind: 'undated', why: 'future' };
  const cutoff = now - WINDOW_DAYS[window] * 24 * 3600 * 1000 - DATE_GRACE_MS;
  return at >= cutoff ? { kind: 'in-window', at } : { kind: 'out-of-window', at };
}

export interface WindowTally {
  /** One verdict per finding, in the findings' own order. Never re-sorted. */
  verdicts: DateVerdict[];
  inWindow: number;
  outOfWindow: number;
  undated: number;
  /** Findings carrying a date that can actually be read: `inWindow + outOfWindow`. */
  dated: number;
  /** ISO of the newest usable date, or null when none is usable. */
  newest: string | null;
}

/**
 * Classify a whole result against the window it declares.
 *
 * The `window` argument is the one the payload carries, which is the CALLER's
 * own claim about what was requested — see the guard in `craft-tools.ts`.
 */
export function tallyWindow(
  findings: readonly Finding[],
  window: RecencyWindow,
  now: number = Date.now(),
): WindowTally {
  const verdicts = findings.map((f) => classifyDate(f.publishedAt, window, now));
  let newestAt: number | null = null;
  for (const v of verdicts) {
    if (v.kind !== 'undated' && (newestAt === null || v.at > newestAt)) newestAt = v.at;
  }
  return {
    verdicts,
    inWindow: verdicts.filter((v) => v.kind === 'in-window').length,
    outOfWindow: verdicts.filter((v) => v.kind === 'out-of-window').length,
    undated: verdicts.filter((v) => v.kind === 'undated').length,
    dated: verdicts.filter((v) => v.kind !== 'undated').length,
    // Compared numerically, not by string sort: `dated.sort().reverse()[0]` is
    // only correct while every adapter emits ISO-with-Z, and Tavily's own wire
    // format (RFC 1123) would sort by weekday name.
    newest: newestAt === null ? null : new Date(newestAt).toISOString(),
  };
}
