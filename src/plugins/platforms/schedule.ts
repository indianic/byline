import { ToolError } from '../../errors.js';

/**
 * Publish timing: the one place that decides what a `status` + `publish_at`
 * pair is allowed to mean.
 *
 * It lives here, above both adapters, because Ghost and WordPress do
 * **opposite things** with the same input and neither one is safe to expose
 * raw. Everything below was measured on 2026-08-03 against a real Ghost 6.x
 * install and a real WordPress install — see `docs/GHOST-NOTES.md` and
 * `docs/WORDPRESS-NOTES.md`. Nothing here is from documentation or memory.
 */

/** What a caller may ask for. `scheduled` is the member this module exists for. */
export type PostStatus = 'published' | 'draft' | 'scheduled';

/**
 * How far ahead a scheduled time must be before Byline will send it.
 *
 * **This is a floor derived from measurement, not a preference.** WordPress
 * does not reject a `future` post whose date is too close — it silently
 * rewrites the status to `publish` and the article goes live immediately, with
 * a 201 and no error anywhere in the response. Measured against WordPress's
 * own clock (read from the `Date` response header on the very same request, so
 * clock skew is excluded rather than assumed away): a lead of **45 s published
 * immediately; 60 s scheduled**. Re-measured from two different points within
 * the minute, with identical results, so the boundary is a lead-time rule and
 * not an artefact of where in the minute the request lands. The exact cut-off
 * between 45 s and 60 s was not pinned down.
 *
 * Ghost is the opposite kind of strict: it *rejects* rather than silently
 * publishing (422 `Date must be at least -2 minutes in the future.`) and
 * accepts anything from `now - 2 min` onward, so a floor that satisfies
 * WordPress satisfies Ghost automatically.
 *
 * Two minutes therefore sits above the highest measured requirement with
 * roughly 75 s of slack, which is what absorbs clock skew between this machine
 * and the platform — the measured skew was under a second on both servers
 * probed, but a badly-synced host is exactly the case that would otherwise
 * publish an article the user asked to schedule. That slack is a cushion, not
 * a guarantee: `assertScheduleApplied` below re-checks what the platform
 * actually did, because a large enough skew defeats any fixed margin.
 */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;

/**
 * A blog's own timezone — the authority for what a wall-clock publish time means.
 *
 * Two shapes because the two platforms expose two different things (measured
 * 2026-08-03): Ghost's `GET /settings/` carries an IANA zone name under the
 * `timezone` key (`"Asia/Kolkata"`, `"Asia/Dubai"`), while WordPress's
 * `GET /wp-json/` root carries `timezone_string` — which is **empty on a site
 * configured by UTC offset rather than by city** — alongside `gmt_offset`.
 *
 * The distinction is not cosmetic: an IANA zone knows about daylight saving and
 * a fixed offset does not, so `fixed` must never be synthesised from an IANA
 * zone by sampling it once. A blog in `America/New_York` is -05:00 in January
 * and -04:00 in July, and a fixed offset captured in one of those months
 * schedules every post an hour wrong for half the year.
 */
export type SiteTimezone =
  | { kind: 'iana'; zone: string }
  | { kind: 'fixed'; offsetMinutes: number; label: string };

/** How a `SiteTimezone` should read in a message to a human. */
export function timezoneLabel(tz: SiteTimezone): string {
  return tz.kind === 'iana' ? tz.zone : tz.label;
}

/**
 * A date-time carrying an **explicit** UTC designator or offset.
 *
 * When a caller writes one of these they have already said which instant they
 * mean, so the blog's timezone is not consulted and does not need fetching.
 */
const OFFSET_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A wall-clock date-time with no timezone on it at all — `2026-08-04T10:00`.
 *
 * **This is the normal form, and it is read in the BLOG's timezone.** "Publish
 * at 10am tomorrow" means 10am on the blog, and nothing about the machine
 * running Byline enters into it — not its clock's zone, not the user's. The
 * same string sent to a Kolkata blog and a UTC blog is deliberately two
 * different instants, because it is two different local mornings.
 *
 * Which is why this must never reach a bare `Date.parse`: the ECMAScript spec
 * parses an offset-less date-time as the HOST's local time, so `Date.parse`
 * would silently substitute the server's zone for the blog's — the exact
 * mistake this rule exists to prevent, and one that only shows up as an
 * article going live at the wrong hour. `wallClockToUtc` does the conversion
 * instead.
 *
 * A bare `YYYY-MM-DD` is still refused: "publish it on the 4th" has no hour in
 * it, and picking midnight on the caller's behalf is a decision this module has
 * no basis for making.
 */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** True when the caller already said which instant they meant. */
export function hasExplicitOffset(value: string): boolean {
  return OFFSET_DATETIME_RE.test(value.trim());
}

/**
 * True only for a value whose meaning genuinely depends on the blog's timezone.
 *
 * Callers use this to decide whether to spend a network round trip looking the
 * timezone up. It is deliberately false for MALFORMED input as well as for
 * offset-bearing input: `"next friday"` and `"2026-08-04"` are refused whatever
 * the blog's timezone turns out to be, so fetching it first would be a wasted
 * request — and, worse, would replace a precise "that is not a date and time"
 * with whatever error the network happened to produce.
 */
export function needsSiteTimezone(value: string): boolean {
  const raw = value.trim();
  return !OFFSET_DATETIME_RE.test(raw) && WALL_CLOCK_RE.test(raw);
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The offset, in ms, that `zone` was at a given UTC instant.
 *
 * Derived from `Intl` rather than from a table, so it is correct across
 * daylight-saving changes and historical offset changes without this project
 * shipping a copy of the tz database.
 */
function zoneOffsetMs(utcMs: number, zone: string): number {
  let fmt = FORMATTERS.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      // `Intl` throws a bare `RangeError` for an unknown zone name. That would
      // escape as an UNEXPECTED error naming nothing, and the value came from
      // the PLATFORM — a blog whose timezone setting this Node build has no
      // tz data for is a real situation, not a programming mistake.
      throw new ToolError({
        api: 'schedule',
        code: 'SITE_TIMEZONE_UNKNOWN',
        message: `The blog reported its timezone as "${zone}", which is not a timezone this system recognises.`,
        hint: 'Check the blog\'s timezone setting, or pass publish_at with an explicit offset — "2026-08-04T10:00:00+05:30".',
      });
    }
    FORMATTERS.set(zone, fmt);
  }
  const parts = fmt.formatToParts(new Date(utcMs));
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  // `hour12: false` renders midnight as `24` in some ICU versions rather than
  // `00`, which would push the computed offset a full day out.
  const hour = num('hour') % 24;
  const asUtc = Date.UTC(num('year'), num('month') - 1, num('day'), hour, num('minute'), num('second'));
  return asUtc - utcMs;
}

/**
 * The UTC instant at which `zone`'s wall clock reads the given local fields.
 *
 * Two passes, and both are needed. The offset a zone is at depends on the
 * instant, and the instant is what is being solved for — so the first pass
 * uses the offset at the wall-clock fields read as if they were UTC (right to
 * within a day), and the second re-reads the offset at that much better guess.
 * A single pass is wrong for any wall-clock time within a day's offset of a
 * daylight-saving change.
 *
 * The result is round-trip verified by the caller (`parsePublishAt`), which is
 * what catches a local time that does not exist at all — the hour a
 * spring-forward skips.
 */
function wallClockToUtc(wallAsUtcMs: number, zone: string): number {
  const firstGuess = wallAsUtcMs - zoneOffsetMs(wallAsUtcMs, zone);
  return wallAsUtcMs - zoneOffsetMs(firstGuess, zone);
}

/** Renders a UTC instant as `YYYY-MM-DDTHH:mm:ss` in `zone`, for round-trip checking. */
function renderInZone(utcMs: number, zone: string): string {
  return new Date(utcMs + zoneOffsetMs(utcMs, zone)).toISOString().slice(0, 19);
}

/**
 * Milliseconds since epoch for a `publish_at` value.
 *
 * A value carrying its own offset is taken at its word and `zone` is ignored.
 * A wall-clock value is read **in the blog's timezone**, which is why `zone`
 * is required for one and not the other.
 *
 * Shape is checked before any parsing because `Date.parse` is far too
 * permissive to define "a time someone meant": `"5"`, `"2026"`, and `"2026-08"`
 * all parse successfully, and any of them reaching a publish field would
 * schedule an article at an instant the caller never wrote down.
 */
export function parsePublishAt(
  value: string,
  zone: SiteTimezone | undefined,
  field = 'publish_at',
): number {
  const raw = value.trim();

  if (OFFSET_DATETIME_RE.test(raw)) {
    const ms = Date.parse(raw.replace(' ', 'T'));
    if (Number.isNaN(ms)) {
      throw new ToolError({
        api: 'schedule',
        code: 'PUBLISH_AT_UNPARSEABLE',
        message: `${field}: "${value}" is shaped like a date-time but is not a real one.`,
        hint: 'Check the month, day, and hour are in range.',
      });
    }
    return ms;
  }

  const m = WALL_CLOCK_RE.exec(raw);
  if (!m) {
    throw new ToolError({
      api: 'schedule',
      code: 'PUBLISH_AT_UNPARSEABLE',
      message: `${field}: "${value}" is not a date and time.`,
      hint: 'Write it as "2026-08-04T10:00" — a date and a time of day, read in the blog\'s own timezone. A date with no time is refused, because it does not say what hour to publish at.',
    });
  }
  if (zone === undefined) {
    throw new ToolError({
      api: 'schedule',
      code: 'SITE_TIMEZONE_UNKNOWN',
      message: `${field}: "${value}" has no timezone on it, and the blog's own timezone could not be determined.`,
      hint: 'Byline reads a plain time like this in the blog\'s timezone, so it needs to know what that is. Either the platform did not report one, or the request to fetch it failed. Pass an explicit offset instead — "2026-08-04T10:00:00+05:30".',
    });
  }

  const [, y, mo, d, h, mi, s] = m;
  const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'));
  // Rejects an impossible calendar date (2026-13-45, 2026-02-30) — `Date.UTC`
  // silently rolls those over into a real but different day.
  const rolled = new Date(wallAsUtc);
  if (
    rolled.getUTCFullYear() !== Number(y) ||
    rolled.getUTCMonth() !== Number(mo) - 1 ||
    rolled.getUTCDate() !== Number(d) ||
    rolled.getUTCHours() !== Number(h)
  ) {
    throw new ToolError({
      api: 'schedule',
      code: 'PUBLISH_AT_UNPARSEABLE',
      message: `${field}: "${value}" is shaped like a date-time but is not a real one.`,
      hint: 'Check the month, day, and hour are in range.',
    });
  }

  if (zone.kind === 'fixed') return wallAsUtc - zone.offsetMinutes * 60_000;

  const utcMs = wallClockToUtc(wallAsUtc, zone.zone);
  // Round-trip check. If the instant we computed does not read back as the
  // wall-clock time that was asked for, that time does not exist in this zone
  // — the hour a daylight-saving spring-forward skips. Publishing an hour off
  // and saying nothing is exactly the silent-wrong-result this module refuses
  // to produce.
  const wanted = new Date(wallAsUtc).toISOString().slice(0, 19);
  if (renderInZone(utcMs, zone.zone) !== wanted) {
    throw new ToolError({
      api: 'schedule',
      code: 'PUBLISH_AT_NONEXISTENT_LOCAL_TIME',
      message: `${field}: ${wanted.replace('T', ' ')} does not exist in ${zone.zone} — the clocks skip that hour for daylight saving.`,
      hint: 'Pick a time an hour either side, or pass an explicit UTC offset to say exactly which instant you mean.',
    });
  }
  return utcMs;
}

/**
 * The timezone lookup, memoised per site.
 *
 * A blog's timezone is a setting, not a per-request fact, and fetching it on
 * every `create_post` would add a round trip to every publish. Only SUCCESSES
 * are cached — the same rule WordPress's `htmlProfile` cache states and for
 * the same reason: caching a failure turns one flaky request into a
 * process-lifetime outage for that site.
 */
const TIMEZONE_CACHE = new Map<string, SiteTimezone>();

export async function cachedTimezone(
  key: string,
  load: () => Promise<SiteTimezone>,
): Promise<SiteTimezone> {
  const hit = TIMEZONE_CACHE.get(key);
  if (hit) return hit;
  const loaded = await load();
  TIMEZONE_CACHE.set(key, loaded);
  return loaded;
}

/** Test seam: forget every memoised timezone. */
export function clearTimezoneCache(): void {
  TIMEZONE_CACHE.clear();
}

/**
 * Whole-second UTC ISO — the exact form both platforms store.
 *
 * Ghost and WordPress each truncate sub-second precision on write (measured:
 * `…:51.364Z` came back `…:51.000Z`). Truncating here rather than sending
 * milliseconds and tolerating the difference later is what lets
 * `publishTimeWarning` compare what was stored against what was asked for as
 * an exact equality — a comparison that would otherwise have to be fuzzy, and
 * so would stop catching a platform that really did store the wrong instant.
 */
export function toWholeSecondIso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/**
 * A UTC instant as the blog's own wall clock reads it, e.g.
 * `2026-08-04 10:00 (Asia/Kolkata)`.
 *
 * Used in the result and in every refusal, because the whole point of this
 * module is that the caller thinks in the blog's local time and Byline
 * publishes in UTC. Showing only one of the two makes the other unverifiable.
 */
export function renderLocal(utcMs: number, tz: SiteTimezone): string {
  const shifted =
    tz.kind === 'iana'
      ? renderInZone(utcMs, tz.zone)
      : new Date(utcMs + tz.offsetMinutes * 60_000).toISOString().slice(0, 19);
  return `${shifted.replace('T', ' ')} (${timezoneLabel(tz)})`;
}

export interface ResolvedTiming {
  status: PostStatus;
  /** Whole-second UTC ISO, present only when the caller supplied a time. */
  publishAtIso?: string;
  publishAtMs?: number;
  /**
   * The same instant on the blog's wall clock, present whenever a time was
   * given and the blog's timezone was known. This is what the caller asked
   * for; `publishAtIso` is what the platform is told.
   */
  publishAtLocal?: string;
}

/**
 * Decide what a `status` + `publish_at` pair means, or refuse it.
 *
 * The table below is the entire contract, and every row is a measurement:
 *
 * | status      | publish_at   | Ghost                | WordPress            | here     |
 * |-------------|--------------|----------------------|----------------------|----------|
 * | `scheduled` | future       | schedules            | schedules            | allowed  |
 * | `scheduled` | absent       | 422                  | **publishes now**    | refused  |
 * | `scheduled` | past/too soon| 422                  | **publishes now**    | refused  |
 * | `published` | past         | backdates            | backdates            | allowed  |
 * | `published` | future       | **publishes now**    | **schedules**        | refused  |
 * | `draft`     | any          | stored, stays draft  | stored, stays draft  | allowed  |
 *
 * The two refusals are the load-bearing ones, and they are refusals rather
 * than warnings for the same reason: in both rows at least one platform does
 * something the caller plainly did not ask for, and does it with a 2xx and no
 * error. `published` + a future time is the sharper of the two — it is not
 * that one platform is stricter, it is that the SAME request publishes
 * immediately on Ghost and schedules on WordPress. An article written once and
 * sent to both sites would go live on one and not the other, from one input,
 * with nothing in either response saying so. There is no correct way to
 * forward that ambiguity, so it is rejected at the door and the caller is told
 * to say `scheduled` if scheduling is what they meant.
 */
export function resolveTiming(
  status: PostStatus,
  publishAt: string | undefined,
  zone: SiteTimezone | undefined,
  now: number = Date.now(),
): ResolvedTiming {
  if (publishAt === undefined) {
    if (status === 'scheduled') {
      throw new ToolError({
        api: 'schedule',
        code: 'SCHEDULE_TIME_REQUIRED',
        message: 'status "scheduled" needs a publish_at time, and none was given.',
        hint: 'Pass publish_at as a date and time of day, e.g. "2026-08-04T10:00" — read in the blog\'s own timezone. WordPress does not reject a scheduled post with no date; it publishes it immediately.',
      });
    }
    return { status };
  }

  const ms = parsePublishAt(publishAt, zone);
  const iso = toWholeSecondIso(ms);
  const lead = ms - now;
  // Every message below says the instant in UTC *and*, when the caller wrote a
  // wall-clock time, in the blog's own zone. A refusal that answers "10:00 is
  // in the past" to someone who asked for 10am tomorrow is not actionable
  // until they can see which 10:00 Byline actually resolved it to.
  const local = zone !== undefined ? { publishAtLocal: renderLocal(ms, zone) } : {};
  const when =
    zone !== undefined && !hasExplicitOffset(publishAt)
      ? `${iso} — ${renderLocal(ms, zone)} on the blog`
      : iso;

  if (status === 'scheduled') {
    if (lead < MIN_SCHEDULE_LEAD_MS) {
      const how =
        lead < 0
          ? `${Math.round(-lead / 1000)}s in the past`
          : `only ${Math.round(lead / 1000)}s away`;
      throw new ToolError({
        api: 'schedule',
        code: 'SCHEDULE_TIME_TOO_SOON',
        message: `publish_at (${when}) is ${how}; a scheduled post must be at least ${MIN_SCHEDULE_LEAD_MS / 60_000} minutes in the future.`,
        hint: 'Measured 2026-08-03: WordPress silently publishes a "future" post immediately when its date is under about a minute away — it returns 201 with the status rewritten to "publish" and no error. Pick a later time, or pass status "published" to publish now.',
      });
    }
    return { status, publishAtIso: iso, publishAtMs: ms, ...local };
  }

  if (status === 'published' && lead > 0) {
    throw new ToolError({
      api: 'schedule',
      code: 'SCHEDULE_STATUS_MISMATCH',
      message: `publish_at (${when}) is in the future, but status is "published".`,
      hint: 'Use status "scheduled" to publish at that time. This combination is refused because the platforms disagree about it: measured 2026-08-03, Ghost publishes the article immediately and stores the future date anyway, while WordPress schedules it — the same request, two different outcomes.',
    });
  }

  // `published` with a past time (backdating) and `draft` with any time.
  // Measured identical on both platforms: the date is stored as given, to the
  // second, arbitrarily far back (3 years was probed), and a draft stays a
  // draft rather than being scheduled by the presence of a date.
  return { status, publishAtIso: iso, publishAtMs: ms, ...local };
}

/**
 * Confirm the platform actually scheduled the post, and refuse to report
 * success when it did not.
 *
 * This is the check `MIN_SCHEDULE_LEAD_MS` cannot replace. That margin is a
 * fixed guess about clock skew, and a host whose clock is minutes off defeats
 * any fixed guess; this reads back what the platform stored and compares it to
 * what was asked for, which is true regardless of whose clock was wrong.
 *
 * It **throws rather than repairing**. Byline does not set the post back to a
 * draft on its own: on `update_post` the post may well have been legitimately
 * published before this call ever ran, and "unpublish it" would then be a
 * destructive act nobody asked for, taken automatically, on live content. So
 * the error names the post, its live URL, and the platform's own clock, and
 * leaves the decision with the person whose blog it is.
 */
export function assertScheduleApplied(opts: {
  api: string;
  platform: string;
  /** The status value this platform uses for a scheduled post. */
  scheduledToken: string;
  requestedIso: string;
  returnedStatus: string;
  id: string;
  url: string;
  /** The `Date` response header, so the diagnosis names a real clock. */
  serverDate: string | null;
}): void {
  if (opts.returnedStatus === opts.scheduledToken) return;
  const clock = opts.serverDate
    ? `${opts.platform}'s own clock read ${new Date(opts.serverDate).toISOString()} when it handled the request`
    : `${opts.platform} sent no Date header, so its clock could not be read`;
  throw new ToolError({
    api: opts.api,
    code: 'SCHEDULE_NOT_APPLIED',
    message:
      `${opts.platform} did not schedule this post. It was asked for publish_at ${opts.requestedIso} ` +
      `with status "${opts.scheduledToken}", and returned status "${opts.returnedStatus}" instead. ` +
      `The post exists as id ${opts.id} at ${opts.url}. ${clock}.`,
    hint:
      `If the status is a published one, the article is LIVE NOW even though scheduling was requested. ` +
      `Byline did not change it — decide what should happen and say so: update_post with status "draft" ` +
      `takes it down, or update_post with status "scheduled" and a later publish_at re-schedules it. ` +
      `A clock difference between this machine and ${opts.platform} is the usual cause.`,
  });
}

/**
 * A platform's stored publish time as canonical UTC ISO, or null if it cannot
 * be read.
 *
 * The two platforms report the same instant in two different shapes: Ghost
 * echoes full ISO with `Z`, WordPress echoes `date_gmt` with no offset marker
 * at all (`2026-08-04T09:00:00`), which is UTC by definition. Left alone, that
 * difference reaches `PostResult.publish_at` and the caller gets a value whose
 * format depends on which blog they published to — for the same moment in
 * time. Both adapters route through here so there is one shape, and one place
 * that knows WordPress's offset-less form is UTC.
 */
export function normaliseStoredTime(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(stored) ? stored : `${stored}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Warn when the stored publish time is not the one that was sent.
 *
 * Advisory, never fatal — the post exists and the caller needs to be told what
 * time it actually carries, not have the call fail after the write already
 * happened. Both values are compared as instants rather than as strings, so
 * WordPress's naive `2026-08-04T09:00:00` and Ghost's `2026-08-04T09:00:00.000Z`
 * are recognised as the same moment instead of as a spurious difference.
 */
export function publishTimeWarning(
  requestedIso: string,
  stored: string | null | undefined,
  platform: string,
): string | null {
  if (!stored) {
    return `publish_at: ${platform} returned no publish time, so the ${requestedIso} that was sent could not be verified.`;
  }
  const normalised = normaliseStoredTime(stored);
  if (normalised === null) {
    return `publish_at: ${platform} returned "${stored}", which is not a readable date, so the ${requestedIso} that was sent could not be verified.`;
  }
  if (Date.parse(normalised) === Date.parse(requestedIso)) return null;
  return `publish_at: sent ${requestedIso} but ${platform} stored ${normalised}.`;
}

/**
 * Warn when the stored slug is not the one that was sent.
 *
 * Advisory, never fatal — by the time this runs the post exists, and failing
 * the call would leave the caller with a published article and an error. What
 * they need is to be told the real URL.
 *
 * Both platforms normalise a slug (case, punctuation, length) and both resolve
 * a collision by appending a counter, so `my-post` can legitimately come back
 * as `my-post-2` pointing at a different URL than the one the caller is about
 * to share. Nothing else would surface that: Ghost's `droppedFields` only asks
 * whether a field came back non-empty, and a substituted slug is non-empty.
 *
 * Lives here, beside `publishTimeWarning`, and is shared by both adapters for
 * the same reason that one is: two platforms checking the same invariant in two
 * places is how they end up checking it differently.
 */
export function slugWarning(
  requested: string,
  stored: unknown,
  platform: string,
): string | null {
  if (typeof stored !== 'string' || stored === '') {
    return `slug: ${platform} returned no slug, so the "${requested}" that was sent could not be verified.`;
  }
  if (stored === requested) return null;
  return `slug: sent "${requested}" but ${platform} stored "${stored}", so the post's URL ends in "${stored}". A counter suffix means the slug was already taken.`;
}
