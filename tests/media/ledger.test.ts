import { describe, expect, it } from 'vitest';
import { isUsed, promote, release, reserve, staleReservations } from '../../src/media/ledger.js';
import type { UsageLedger } from '../../src/media/types.js';

const empty: UsageLedger = { version: 1, library: 'shots', records: [] };

const withOne = reserve(empty, {
  id: 'sha256:a',
  site: 'personal',
  hosted_url: 'https://blog/1.png',
  at: '2026-08-11T00:00:00.000Z',
  slot: 'hero',
});

describe('reserve', () => {
  it('adds a reserved record without mutating the input', () => {
    expect(empty.records).toHaveLength(0);
    expect(withOne.records).toHaveLength(1);
    expect(withOne.records[0]!.state).toBe('reserved');
  });
});

describe('isUsed', () => {
  it('reports an asset used on the same site', () => {
    expect(isUsed(withOne, 'sha256:a', 'personal', 'site')).toBe(true);
  });

  it('leaves it free on a different site under site scope', () => {
    expect(isUsed(withOne, 'sha256:a', 'nicgulf', 'site')).toBe(false);
  });

  it('marks it used everywhere under global scope', () => {
    expect(isUsed(withOne, 'sha256:a', 'nicgulf', 'global')).toBe(true);
  });

  it('reports an unknown id as unused', () => {
    expect(isUsed(withOne, 'sha256:zzz', 'personal', 'site')).toBe(false);
  });
});

describe('promote', () => {
  it('promotes a reserved record whose hosted url appears in the post', () => {
    const { ledger, promoted } = promote(withOne, ['https://blog/1.png'], 'https://blog/post/');
    expect(promoted).toBe(1);
    expect(ledger.records[0]!.state).toBe('published');
    expect(ledger.records[0]!.post_url).toBe('https://blog/post/');
  });

  it('promotes nothing when no url matches', () => {
    const { ledger, promoted } = promote(withOne, ['https://blog/other.png'], 'https://blog/post/');
    expect(promoted).toBe(0);
    expect(ledger.records[0]!.state).toBe('reserved');
  });

  it('is idempotent — re-promoting an already published record changes nothing', () => {
    const once = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const twice = promote(once, ['https://blog/1.png'], 'https://blog/other/');
    expect(twice.promoted).toBe(0);
    expect(twice.ledger.records[0]!.post_url).toBe('https://blog/post/');
  });
});

describe('release', () => {
  it('removes a reserved record', () => {
    const { ledger, released } = release(withOne, 'sha256:a');
    expect(released).toBe(1);
    expect(ledger.records).toHaveLength(0);
  });

  it('refuses to release a published record', () => {
    const published = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const { ledger, released } = release(published, 'sha256:a');
    expect(released).toBe(0);
    expect(ledger.records).toHaveLength(1);
  });
});

describe('staleReservations', () => {
  it('lists reserved records and excludes published ones', () => {
    const published = promote(withOne, ['https://blog/1.png'], 'https://blog/post/').ledger;
    const mixed = reserve(published, {
      id: 'sha256:b',
      site: 'personal',
      hosted_url: 'https://blog/2.png',
      at: '2026-08-11T00:00:00.000Z',
    });
    expect(staleReservations(mixed).map((r) => r.id)).toEqual(['sha256:b']);
  });
});
