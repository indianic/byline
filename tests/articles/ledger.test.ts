import { describe, expect, it } from 'vitest';
import {
  recentArticles,
  recentChoices,
  recordArticle,
  recordShare,
  siblings,
} from '../../src/articles/ledger.js';
import type { ArticleLedger, ArticleRecord } from '../../src/articles/types.js';

const empty: ArticleLedger = { version: 1, persona: 'jane-doe', records: [] };

function rec(overrides: Partial<ArticleRecord> = {}): Omit<ArticleRecord, 'recorded_at' | 'shares'> {
  return {
    id: 'personal:1',
    persona: 'jane-doe',
    site: 'personal',
    platform: 'ghost',
    post_id: '1',
    url: 'https://blog.example.com/first/',
    title: 'First article',
    tags: ['ai'],
    status: 'published',
    ...overrides,
  };
}

describe('recordArticle', () => {
  it('inserts a new record, stamping recorded_at and an empty shares array', () => {
    const ledger = recordArticle(empty, rec());
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]!.recorded_at).toBeTruthy();
    expect(ledger.records[0]!.shares).toEqual([]);
  });

  it('does not mutate the input ledger', () => {
    recordArticle(empty, rec());
    expect(empty.records).toHaveLength(0);
  });

  it('upsert replaces a record with the same id rather than appending', () => {
    const once = recordArticle(empty, rec({ title: 'Draft title' }));
    const twice = recordArticle(once, rec({ title: 'Final title' }));
    expect(twice.records).toHaveLength(1);
    expect(twice.records[0]!.title).toBe('Final title');
  });

  it('appends a distinct id as a second record', () => {
    const once = recordArticle(empty, rec({ id: 'personal:1' }));
    const twice = recordArticle(once, rec({ id: 'personal:2', post_id: '2' }));
    expect(twice.records).toHaveLength(2);
  });

  it('preserves a pre-existing shares array across an upsert of the same id', () => {
    const withOne = recordArticle(empty, rec({ title: 'Draft title' }));
    const { ledger: shared } = recordShare(withOne, 'https://blog.example.com/first/', {
      site: 'linkedin-co',
      platform: 'linkedin',
      url: 'https://linkedin.com/posts/123',
      at: '2026-09-05T00:00:00.000Z',
    });

    const republished = recordArticle(shared, rec({ title: 'Final title' }));

    expect(republished.records).toHaveLength(1);
    expect(republished.records[0]!.title).toBe('Final title');
    expect(republished.records[0]!.shares).toHaveLength(1);
    expect(republished.records[0]!.shares[0]!.platform).toBe('linkedin');
  });
});

describe('recentArticles', () => {
  const withThree: ArticleLedger = {
    version: 1,
    persona: 'jane-doe',
    records: [
      { ...rec({ id: 'p:1', post_id: '1', title: 'Oldest' }), recorded_at: '2026-08-01T00:00:00.000Z', shares: [] },
      { ...rec({ id: 'p:2', post_id: '2', title: 'Middle' }), recorded_at: '2026-08-15T00:00:00.000Z', shares: [] },
      { ...rec({ id: 'p:3', post_id: '3', title: 'Newest' }), recorded_at: '2026-09-01T00:00:00.000Z', shares: [] },
    ],
  };

  it('returns records newest first', () => {
    expect(recentArticles(withThree, 5).map((r) => r.title)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('truncates to n', () => {
    expect(recentArticles(withThree, 2).map((r) => r.title)).toEqual(['Newest', 'Middle']);
  });

  it('returns an empty array for an empty ledger', () => {
    expect(recentArticles(empty, 5)).toEqual([]);
  });
});

describe('recentChoices', () => {
  const withThree: ArticleLedger = {
    version: 1,
    persona: 'jane-doe',
    records: [
      {
        ...rec({ id: 'p:1', post_id: '1' }),
        choices: { hook: 0, arc: 1 },
        recorded_at: '2026-08-01T00:00:00.000Z',
        shares: [],
      },
      {
        ...rec({ id: 'p:2', post_id: '2' }),
        choices: { hook: 1 },
        recorded_at: '2026-08-15T00:00:00.000Z',
        shares: [],
      },
      {
        ...rec({ id: 'p:3', post_id: '3' }),
        choices: { hook: 2, arc: 4 },
        recorded_at: '2026-09-01T00:00:00.000Z',
        shares: [],
      },
    ],
  };

  it('unions choices over only the last n records, excluding older ones', () => {
    const avoided = recentChoices(withThree, 2);
    // Only the two most recent records (p:3, p:2) contribute: hook from both,
    // arc only from p:3. p:1's arc:1 must not appear.
    expect(avoided.hook?.sort()).toEqual([1, 2]);
    expect(avoided.arc).toEqual([4]);
  });

  it('ignores records with no choices', () => {
    const noChoices = recordArticle(empty, rec());
    expect(recentChoices(noChoices, 5)).toEqual({});
  });

  it('returns an empty object for an empty ledger', () => {
    expect(recentChoices(empty, 5)).toEqual({});
  });
});

describe('recordShare', () => {
  const withOne = recordArticle(empty, rec());

  it('appends a share to the record matching the URL', () => {
    const { ledger, matched } = recordShare(withOne, 'https://blog.example.com/first/', {
      site: 'linkedin-co',
      platform: 'linkedin',
      url: 'https://linkedin.com/posts/123',
      at: '2026-09-05T00:00:00.000Z',
    });
    expect(matched).toBe(true);
    expect(ledger.records[0]!.shares).toHaveLength(1);
    expect(ledger.records[0]!.shares[0]!.platform).toBe('linkedin');
  });

  it('returns matched:false and an unchanged ledger for an unknown URL', () => {
    const { ledger, matched } = recordShare(withOne, 'https://blog.example.com/no-such-post/', {
      site: 'linkedin-co',
      platform: 'linkedin',
      url: 'https://linkedin.com/posts/456',
      at: '2026-09-05T00:00:00.000Z',
    });
    expect(matched).toBe(false);
    expect(ledger).toEqual(withOne);
  });
});

describe('siblings', () => {
  it('returns records with a matching series', () => {
    const withSeries = recordArticle(
      recordArticle(empty, rec({ id: 'p:1', post_id: '1', series: 'gulf-modernisation' })),
      rec({ id: 'p:2', post_id: '2', series: 'other-series' }),
    );
    expect(siblings(withSeries, 'gulf-modernisation').map((r) => r.id)).toEqual(['p:1']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(siblings(empty, 'gulf-modernisation')).toEqual([]);
  });
});
