import { describe, expect, it } from 'vitest';
import { ToolError } from '../../../src/errors.js';
import {
  MIN_SCHEDULE_LEAD_MS,
  assertScheduleApplied,
  hasExplicitOffset,
  needsSiteTimezone,
  parsePublishAt,
  publishTimeWarning,
  renderLocal,
  resolveTiming,
  toWholeSecondIso,
  type SiteTimezone,
} from '../../../src/plugins/platforms/schedule.js';

/** A fixed "now" so nothing here depends on when the suite runs. */
const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/**
 * Stand-in blog timezones. Every `at()` value carries an explicit offset, so
 * for those cases the zone is present but unused — which is itself part of the
 * contract: an explicit offset is taken at face value and the blog's timezone
 * must not override it.
 */
const UTC: SiteTimezone = { kind: 'fixed', offsetMinutes: 0, label: 'UTC+00:00' };
const KOLKATA: SiteTimezone = { kind: 'iana', zone: 'Asia/Kolkata' };
const NEW_YORK: SiteTimezone = { kind: 'iana', zone: 'America/New_York' };

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    return `NOT_A_TOOL_ERROR:${String(e)}`;
  }
  return 'DID_NOT_THROW';
};

describe('parsePublishAt', () => {
  it('accepts an explicit UTC or offset date-time', () => {
    expect(parsePublishAt('2026-08-04T09:00:00Z', UTC)).toBe(Date.parse('2026-08-04T09:00:00Z'));
    expect(parsePublishAt('2026-08-04T09:00:00+05:30', UTC)).toBe(Date.parse('2026-08-04T03:30:00Z'));
    expect(parsePublishAt('2026-08-04T09:00:00-0500', UTC)).toBe(Date.parse('2026-08-04T14:00:00Z'));
  });

  // A wall-clock time is the NORMAL form and is read in the blog's timezone.
  // It is refused only when that timezone could not be determined — never
  // silently reinterpreted as UTC or as this machine's zone.
  it('refuses a wall-clock time only when the blog timezone is unknown', () => {
    expect(codeOf(() => parsePublishAt('2026-08-04T09:00:00', undefined))).toBe('SITE_TIMEZONE_UNKNOWN');
    expect(parsePublishAt('2026-08-04T09:00:00', UTC)).toBe(Date.parse('2026-08-04T09:00:00Z'));
  });

  // An explicit offset means the caller already said which instant they meant,
  // so the blog's timezone must not be applied on top of it.
  it('ignores the blog timezone when the value carries its own offset', () => {
    expect(parsePublishAt('2026-08-04T09:00:00Z', KOLKATA)).toBe(Date.parse('2026-08-04T09:00:00Z'));
    expect(parsePublishAt('2026-08-04T09:00:00+05:30', NEW_YORK)).toBe(Date.parse('2026-08-04T03:30:00Z'));
  });

  it('refuses a date with no time — midnight is a choice nobody made', () => {
    expect(codeOf(() => parsePublishAt('2026-08-04', UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
  });

  // `Date.parse` accepts every one of these and returns a real instant:
  // "5" -> 2001-04-30, "2026" -> 2026-01-01, "2026-08" -> 2026-08-01. Any of
  // them reaching a publish field would schedule an article at a moment the
  // caller never wrote down, so the shape is checked before the parse.
  it.each(['5', '0', '2026', '2026-08', 'tomorrow', 'next friday 9am', ''])(
    'refuses %o, which Date.parse would otherwise turn into a real instant',
    (bad) => {
      expect(codeOf(() => parsePublishAt(bad, UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
    },
  );

  it('refuses a well-shaped string that is not a real date', () => {
    expect(codeOf(() => parsePublishAt('2026-13-45T00:00:00Z', UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
  });
});

describe('toWholeSecondIso', () => {
  // Both platforms truncate sub-second precision on write (measured: sending
  // `…:51.364Z` stored `…:51.000Z`). Truncating before sending is what lets the
  // read-back comparison be an exact equality instead of a fuzzy one.
  it('truncates rather than rounds, so the sent value is the stored value', () => {
    expect(toWholeSecondIso(Date.parse('2026-08-04T09:00:00.999Z'))).toBe('2026-08-04T09:00:00.000Z');
    expect(toWholeSecondIso(Date.parse('2026-08-04T09:00:00.000Z'))).toBe('2026-08-04T09:00:00.000Z');
  });
});

describe('resolveTiming — the measured rule table', () => {
  describe('status "scheduled"', () => {
    it('accepts a time comfortably in the future', () => {
      const r = resolveTiming('scheduled', at(60 * 60_000), UTC, NOW);
      expect(r.status).toBe('scheduled');
      expect(r.publishAtIso).toBe('2026-08-03T13:00:00.000Z');
    });

    // WordPress does not reject this — it publishes the article immediately.
    it('refuses a missing time', () => {
      expect(codeOf(() => resolveTiming('scheduled', undefined, UTC, NOW))).toBe('SCHEDULE_TIME_REQUIRED');
    });

    it('refuses a past time', () => {
      expect(codeOf(() => resolveTiming('scheduled', at(-60_000), UTC, NOW))).toBe('SCHEDULE_TIME_TOO_SOON');
    });

    // The measured band: WordPress silently published at 45s of lead and
    // scheduled at 60s. Anything inside the floor must be refused here rather
    // than sent and hoped about.
    it('refuses a time inside the lead floor, even though it is genuinely in the future', () => {
      expect(codeOf(() => resolveTiming('scheduled', at(45_000), UTC, NOW))).toBe('SCHEDULE_TIME_TOO_SOON');
      expect(codeOf(() => resolveTiming('scheduled', at(MIN_SCHEDULE_LEAD_MS - 1000), UTC, NOW))).toBe(
        'SCHEDULE_TIME_TOO_SOON',
      );
    });

    it('accepts exactly at the floor', () => {
      expect(resolveTiming('scheduled', at(MIN_SCHEDULE_LEAD_MS), UTC, NOW).status).toBe('scheduled');
    });

    // A floor that no longer clears WordPress's measured requirement would let
    // articles publish immediately again, so pin it rather than trusting the
    // constant to stay put.
    it('keeps a floor above the 60s WordPress was measured to need', () => {
      expect(MIN_SCHEDULE_LEAD_MS).toBeGreaterThan(60_000);
    });

    it('names the failing rule in the error, not just "invalid"', () => {
      try {
        resolveTiming('scheduled', at(-60_000), UTC, NOW);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        const err = e as ToolError;
        expect(err.message).toContain('60s in the past');
        expect(err.hint).toMatch(/WordPress/);
      }
    });
  });

  describe('status "published"', () => {
    it('allows backdating with a past time', () => {
      const r = resolveTiming('published', at(-30 * 86_400_000), UTC, NOW);
      expect(r.status).toBe('published');
      expect(r.publishAtIso).toBe('2026-07-04T12:00:00.000Z');
    });

    it('allows no time at all — publish now', () => {
      expect(resolveTiming('published', undefined, UTC, NOW)).toEqual({ status: 'published' });
    });

    // THE divergence this module exists for. Ghost publishes immediately and
    // stores the future date anyway; WordPress schedules. One input, two
    // outcomes, neither platform reporting a problem.
    it('refuses a FUTURE time, because the two platforms disagree about it', () => {
      expect(codeOf(() => resolveTiming('published', at(60 * 60_000), UTC, NOW))).toBe('SCHEDULE_STATUS_MISMATCH');
    });

    it('points the caller at "scheduled" rather than just refusing', () => {
      try {
        resolveTiming('published', at(60 * 60_000), UTC, NOW);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as ToolError).hint).toContain('scheduled');
      }
    });
  });

  describe('status "draft"', () => {
    // Measured identical on both platforms: the date is stored, the post stays
    // a draft, and the presence of a date does not schedule anything.
    it('accepts any time, past or future, and stays a draft', () => {
      expect(resolveTiming('draft', at(60 * 60_000), UTC, NOW).status).toBe('draft');
      expect(resolveTiming('draft', at(-60 * 60_000), UTC, NOW).status).toBe('draft');
      expect(resolveTiming('draft', undefined, UTC, NOW)).toEqual({ status: 'draft' });
    });
  });
});

describe('assertScheduleApplied', () => {
  const base = {
    api: 'wordpress:wptest',
    platform: 'WordPress',
    scheduledToken: 'future',
    requestedIso: '2026-08-04T09:00:00.000Z',
    id: '42',
    url: 'https://blog.example.com/?p=42',
    serverDate: 'Mon, 03 Aug 2026 12:00:00 GMT',
  };

  it('passes silently when the platform really did schedule it', () => {
    expect(() => assertScheduleApplied({ ...base, returnedStatus: 'future' })).not.toThrow();
  });

  // The failure this whole feature is defended against: a 201, no error, and a
  // live article the caller asked to be scheduled.
  it('throws when the platform published instead of scheduling', () => {
    expect(codeOf(() => assertScheduleApplied({ ...base, returnedStatus: 'publish' }))).toBe(
      'SCHEDULE_NOT_APPLIED',
    );
  });

  it('names the post, its URL, and the platform clock so the failure is actionable', () => {
    try {
      assertScheduleApplied({ ...base, returnedStatus: 'publish' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as ToolError;
      expect(err.message).toContain('42');
      expect(err.message).toContain('https://blog.example.com/?p=42');
      expect(err.message).toContain('2026-08-03T12:00:00.000Z');
      expect(err.message).toContain('"publish"');
      // The caller must be told the article is live and that Byline left it
      // that way — an error that only says "failed" would leave them assuming
      // nothing happened.
      expect(err.hint).toContain('LIVE NOW');
      expect(err.hint).toContain('Byline did not change it');
    }
  });

  it('still reports usefully when the platform sent no Date header', () => {
    try {
      assertScheduleApplied({ ...base, returnedStatus: 'publish', serverDate: null });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ToolError).message).toContain('no Date header');
    }
  });
});

describe('publishTimeWarning', () => {
  it('is silent when the stored instant matches', () => {
    expect(publishTimeWarning('2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00.000Z', 'Ghost')).toBeNull();
  });

  // WordPress returns `date_gmt` with no offset marker; it is UTC by
  // definition. Comparing as strings would report every correct WordPress
  // write as a mismatch.
  it('treats an offset-less WordPress date_gmt as the UTC it is', () => {
    expect(publishTimeWarning('2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00', 'WordPress')).toBeNull();
  });

  it('reports a genuine difference with both instants', () => {
    const w = publishTimeWarning('2026-08-04T09:00:00.000Z', '2026-08-04T11:00:00', 'WordPress');
    expect(w).toContain('2026-08-04T09:00:00.000Z');
    expect(w).toContain('2026-08-04T11:00:00.000Z');
  });

  // "No warning" must mean "verified identical", never "nobody checked" — the
  // same false all-clear `diffReadBack` was fixed for.
  it('warns rather than staying silent when there is nothing to compare against', () => {
    expect(publishTimeWarning('2026-08-04T09:00:00.000Z', null, 'Ghost')).toContain('could not be verified');
    expect(publishTimeWarning('2026-08-04T09:00:00.000Z', 'not-a-date', 'Ghost')).toContain(
      'could not be verified',
    );
  });
});

describe('the blog’s timezone is the authority', () => {
  // The rule, stated as a test: the SAME string sent to two blogs is two
  // different instants, because it is two different local mornings. Nothing
  // about the machine running this is consulted.
  it('reads one wall-clock string as a different instant per blog', () => {
    const tenAm = '2026-08-04T10:00';
    expect(parsePublishAt(tenAm, KOLKATA)).toBe(Date.parse('2026-08-04T04:30:00Z'));
    expect(parsePublishAt(tenAm, UTC)).toBe(Date.parse('2026-08-04T10:00:00Z'));
    expect(parsePublishAt(tenAm, { kind: 'iana', zone: 'Asia/Dubai' })).toBe(
      Date.parse('2026-08-04T06:00:00Z'),
    );
    // 5.5 hours, the offset form of the same Kolkata blog.
    expect(parsePublishAt(tenAm, { kind: 'fixed', offsetMinutes: 330, label: 'UTC+05:30' })).toBe(
      Date.parse('2026-08-04T04:30:00Z'),
    );
  });

  // The host's own timezone must never leak in. `Date.parse` on an offset-less
  // string returns host-local time, which is the exact bug this guards: on a
  // machine set to Asia/Kolkata, a naive implementation would give the right
  // answer for the Kolkata blog and the wrong one for the UTC blog, so a test
  // that only checked one zone would pass while being wrong.
  it('does not depend on the host timezone, whatever this machine is set to', () => {
    const hostOffsetMin = -new Date('2026-08-04T10:00:00').getTimezoneOffset();
    expect(parsePublishAt('2026-08-04T10:00', UTC)).toBe(Date.parse('2026-08-04T10:00:00Z'));
    // Stated as a fact about the machine so a failure here reads as "the host
    // zone leaked in" rather than as an unrelated arithmetic error.
    if (hostOffsetMin !== 0) {
      expect(parsePublishAt('2026-08-04T10:00', UTC)).not.toBe(Date.parse('2026-08-04T10:00:00'));
    }
  });

  it('accepts a space instead of T, and seconds when given', () => {
    expect(parsePublishAt('2026-08-04 10:00', UTC)).toBe(Date.parse('2026-08-04T10:00:00Z'));
    expect(parsePublishAt('2026-08-04T10:00:30', UTC)).toBe(Date.parse('2026-08-04T10:00:30Z'));
  });

  describe('daylight saving', () => {
    // Neither blog in this project observes DST, so this is the only place the
    // two-pass conversion is exercised at all. A single-pass implementation
    // gets these wrong by an hour.
    it('resolves a wall-clock time on either side of a DST change', () => {
      // 2026-03-08 is the US spring-forward. Before it New York is -05:00,
      // after it -04:00.
      expect(parsePublishAt('2026-03-07T10:00', NEW_YORK)).toBe(Date.parse('2026-03-07T15:00:00Z'));
      expect(parsePublishAt('2026-03-09T10:00', NEW_YORK)).toBe(Date.parse('2026-03-09T14:00:00Z'));
    });

    // The case that actually distinguishes one pass from two, and the reason
    // the day-either-side cases above are not enough: those agree under both
    // implementations. New York switches at 07:00Z on 2026-03-08. A local
    // 04:00 that morning is already EDT (-04:00), so the answer is 08:00Z —
    // but reading the wall-clock fields as if they were UTC lands at 04:00Z,
    // which is still EST (-05:00), so a single pass answers 09:00Z. An hour
    // wrong, on a valid time, with nothing to indicate it.
    it('is right for a local time whose naive-UTC reading falls the other side of the change', () => {
      expect(parsePublishAt('2026-03-08T04:00', NEW_YORK)).toBe(Date.parse('2026-03-08T08:00:00Z'));
      // The autumn change, 06:00Z on 2026-11-01, in the same shape.
      expect(parsePublishAt('2026-11-01T03:00', NEW_YORK)).toBe(Date.parse('2026-11-01T08:00:00Z'));
    });

    // 02:30 on spring-forward day does not happen — the clocks jump 02:00 to
    // 03:00. Publishing an hour off and saying nothing is the silent wrong
    // result this refuses to produce.
    it('refuses a local time the clocks skip entirely', () => {
      expect(codeOf(() => parsePublishAt('2026-03-08T02:30', NEW_YORK))).toBe(
        'PUBLISH_AT_NONEXISTENT_LOCAL_TIME',
      );
    });

    it('accepts an ambiguous autumn time rather than refusing it', () => {
      // 2026-11-01 01:30 happens twice. Unlike the skipped hour, both readings
      // are real instants, so picking one is defensible where inventing one is
      // not. Pinned so a change in which one is picked is a visible decision.
      const ms = parsePublishAt('2026-11-01T01:30', NEW_YORK);
      expect(ms).toBe(Date.parse('2026-11-01T05:30:00Z'));
    });
  });

  it('rejects a timezone name this system has no data for', () => {
    expect(codeOf(() => parsePublishAt('2026-08-04T10:00', { kind: 'iana', zone: 'Mars/Olympus' }))).toBe(
      'SITE_TIMEZONE_UNKNOWN',
    );
  });

  it('rejects an impossible calendar date rather than rolling it over', () => {
    // `Date.UTC(2026, 12, 45)` silently becomes a real but different day.
    expect(codeOf(() => parsePublishAt('2026-13-45T10:00', UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
    expect(codeOf(() => parsePublishAt('2026-02-30T10:00', UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
    expect(codeOf(() => parsePublishAt('2026-08-04T25:00', UTC))).toBe('PUBLISH_AT_UNPARSEABLE');
  });
});

describe('needsSiteTimezone — deciding whether to spend a network call', () => {
  it('is true only for a wall-clock value, whose meaning actually depends on it', () => {
    expect(needsSiteTimezone('2026-08-04T10:00')).toBe(true);
    expect(needsSiteTimezone('2026-08-04 10:00:30')).toBe(true);
  });

  it('is false for a value that already carries its own offset', () => {
    expect(needsSiteTimezone('2026-08-04T10:00:00Z')).toBe(false);
    expect(needsSiteTimezone('2026-08-04T10:00:00+05:30')).toBe(false);
    expect(hasExplicitOffset('2026-08-04T10:00:00+05:30')).toBe(true);
    expect(hasExplicitOffset('2026-08-04T10:00')).toBe(false);
  });

  // Malformed input is refused whatever the blog's timezone turns out to be,
  // so looking it up first would waste a request AND replace a precise
  // "that is not a date and time" with whatever the network happened to do.
  it('is false for malformed input, so a bad value is refused without a round trip', () => {
    for (const bad of ['2026-08-04', 'tomorrow', 'next friday 9am', '', '2026']) {
      expect(needsSiteTimezone(bad), bad).toBe(false);
    }
  });
});

describe('renderLocal', () => {
  it('shows the instant on the blog’s own clock, labelled', () => {
    expect(renderLocal(Date.parse('2026-08-04T04:30:00Z'), KOLKATA)).toBe(
      '2026-08-04 10:00:00 (Asia/Kolkata)',
    );
    expect(renderLocal(Date.parse('2026-08-04T10:00:00Z'), UTC)).toBe('2026-08-04 10:00:00 (UTC+00:00)');
  });
});

describe('resolveTiming carries the blog-local time through', () => {
  it('reports both the UTC instant and the blog’s wall clock', () => {
    const r = resolveTiming('scheduled', '2026-08-04T10:00', KOLKATA, NOW);
    expect(r.publishAtIso).toBe('2026-08-04T04:30:00.000Z');
    expect(r.publishAtLocal).toBe('2026-08-04 10:00:00 (Asia/Kolkata)');
  });

  // A refusal saying only "04:30 is in the past" to someone who asked for 10am
  // is not actionable until they can see which 10am it resolved to.
  it('names the blog-local time in a refusal, not just the UTC instant', () => {
    try {
      resolveTiming('scheduled', '2026-08-03T10:00', KOLKATA, NOW);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ToolError).message).toContain('(Asia/Kolkata)');
    }
  });
});
