import { describe, expect, it } from 'vitest';
import type { Finding } from '../../../src/plugins/research/types.js';
import { classifyDate, tallyWindow } from '../../../src/plugins/research/window.js';

// Frozen reference instant, injected explicitly everywhere below — no test
// here races the real wall clock.
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

describe('classifyDate — date SHAPE, not just Date.parse success', () => {
  // Follow-up review N2: `Date.parse` alone accepts date-shaped junk neither
  // provider was ever measured to emit — "5", "0", a bare year, a
  // year-month — and that junk then gets classified as in- or
  // out-of-window and printed on the brief in the date position, exactly
  // like a real date. Only what the two providers were measured to emit
  // (full ISO, or Tavily's raw RFC 1123) may qualify as dated.
  it.each(['5', '0', '2026', '2026-07', 'Invalid Date', 'yesterday-ish'])(
    'treats %s as undated:unparseable, not as a date to judge',
    (junk) => {
      const v = classifyDate(junk, 'day', NOW);
      expect(v).toEqual({ kind: 'undated', why: 'unparseable' });
    },
  );

  it('still accepts a bare ISO date (YYYY-MM-DD), the minimum shape named in the fix', () => {
    const v = classifyDate('2026-07-31', 'day', NOW);
    expect(v.kind).not.toBe('undated');
  });

  it('still accepts a full ISO datetime with an explicit Z', () => {
    const v = classifyDate('2026-07-31T05:00:00.000Z', 'day', NOW);
    expect(v).toEqual({ kind: 'in-window', at: Date.parse('2026-07-31T05:00:00.000Z') });
  });

  it("still accepts Tavily's raw RFC 1123 wire format", () => {
    // NOW is 2026-07-31T12:00:00Z; this is ~4 hours earlier, well inside a
    // day window.
    const v = classifyDate('Fri, 31 Jul 2026 08:00:00 GMT', 'day', NOW);
    expect(v).toEqual({ kind: 'in-window', at: Date.parse('Fri, 31 Jul 2026 08:00:00 GMT') });
  });

  it('a date-shaped-but-invalid calendar value (bad month/day) is still unparseable', () => {
    // Matches the ISO shape (\d{4}-\d{2}-\d{2}...) but is not a real date —
    // Date.parse itself returns NaN for this one, same result as before the
    // shape check was added, via a different path.
    const v = classifyDate('2026-13-45T00:00:00Z', 'day', NOW);
    expect(v).toEqual({ kind: 'undated', why: 'unparseable' });
  });
});

describe('classifyDate — a Z-less datetime is UTC, not host-local', () => {
  // Follow-up review N3: `'2026-07-31T11:00:00'` (no `Z`, no offset) is, per
  // the ECMAScript spec, parsed as LOCAL time — exactly the trap
  // `src/plugins/research/brave/index.ts`'s `isoUtc` already documents and
  // fixes for Brave's `page_age`. `window.ts` must apply the same fix,
  // because `findings` reaches `build_writing_brief` as MCP input from the
  // host model, which is not bound by what the adapters normalise.
  //
  // Forcing TZ here (rather than trusting whatever zone the test runner
  // happens to be in) is what makes this test fail reliably if the fix is
  // ever dropped — on a UTC-hosted CI box, local and UTC parsing of the same
  // string coincide, and a test that trusted the ambient zone would pass
  // whether or not the bug was present.
  const originalTz = process.env.TZ;

  it('parses a naive datetime as UTC even when the host clock is +5:30', () => {
    process.env.TZ = 'Asia/Kolkata';
    try {
      // No Z, no offset. If this were parsed as local (+5:30) time it would
      // resolve to 2026-07-31T05:30:00Z — a different instant, 5.5 hours off.
      const v = classifyDate('2026-07-31T11:00:00', 'day', NOW);
      expect(v.kind).not.toBe('undated');
      if (v.kind !== 'undated') {
        expect(v.at).toBe(Date.parse('2026-07-31T11:00:00Z'));
        expect(v.at).not.toBe(Date.parse('2026-07-31T05:30:00Z'));
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('a Z-less datetime that would only pass the window under UTC is correctly judged in-window', () => {
    process.env.TZ = 'Asia/Kolkata';
    try {
      // Day window: cutoff is NOW - 30h (24h + 6h grace). This finding is
      // 26 hours before NOW under UTC — inside the window. Under a wrong
      // local (+5:30) interpretation it would read as 31.5 hours old —
      // outside it.
      const naive = new Date(NOW - 26 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '');
      const v = classifyDate(naive, 'day', NOW);
      expect(v.kind).toBe('in-window');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('tallyWindow — a single injected `now`', () => {
  const finding = (over: Partial<Finding> & { url: string }): Finding => ({
    title: `Title for ${over.url}`,
    snippet: `Snippet for ${over.url}`,
    publishedAt: new Date(NOW - 3600 * 1000).toISOString(),
    relevance: null,
    provider: 'tavily',
    ...over,
  });

  it('two calls with the same explicit now agree, even exactly at the cutoff', () => {
    // Day window cutoff is NOW - 30h exactly.
    const atCutoff = new Date(NOW - 30 * 3600 * 1000).toISOString();
    const a = tallyWindow([finding({ url: 'https://a.test/1', publishedAt: atCutoff })], 'day', NOW);
    const b = tallyWindow([finding({ url: 'https://a.test/1', publishedAt: atCutoff })], 'day', NOW);
    expect(a).toEqual(b);
    expect(a.inWindow).toBe(1);
    expect(a.outOfWindow).toBe(0);
  });
});
