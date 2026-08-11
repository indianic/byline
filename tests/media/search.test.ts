import { describe, expect, it } from 'vitest';
import { searchAssets } from '../../src/media/search.js';
import type { Asset } from '../../src/media/types.js';

function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    path: `${over.id}.png`,
    kind: 'image',
    mime: 'image/png',
    bytes: 100,
    width: 1920,
    height: 1080,
    aspect: '16:9',
    duration_s: null,
    captured_at: '2026-01-01T00:00:00.000Z',
    scanned_at: '2026-08-11T00:00:00.000Z',
    mtime_ms: 0,
    source: { filename_tokens: [], folder_tokens: [], captured_from: 'mtime' },
    ...over,
  } as Asset;
}

const KEYWORDED = asset({
  id: 'sha256:kw',
  enriched: {
    by: 'gemini',
    at: '2026-08-11T00:00:00.000Z',
    caption: 'people at a desk',
    keywords: ['standup', 'whiteboard'],
    look: 'flat',
    has_people: true,
    text_in_image: false,
  },
});

const FILENAMED = asset({
  id: 'sha256:fn',
  source: { filename_tokens: ['standup'], folder_tokens: [], captured_from: 'mtime' },
});

const FOLDERED = asset({
  id: 'sha256:fd',
  source: { filename_tokens: [], folder_tokens: ['standup'], captured_from: 'mtime' },
});

describe('searchAssets', () => {
  it('ranks a keyword match above a filename match above a folder match', () => {
    const hits = searchAssets([FOLDERED, FILENAMED, KEYWORDED], { query: 'standup' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:kw', 'sha256:fn', 'sha256:fd']);
  });

  it('names the matched field and tokens in why', () => {
    const [hit] = searchAssets([KEYWORDED], { query: 'standup' });
    expect(hit!.why).toContainEqual({ field: 'keywords', tokens: ['standup'] });
  });

  it('excludes assets that matched nothing', () => {
    expect(searchAssets([KEYWORDED], { query: 'submarine' })).toHaveLength(0);
  });

  it('returns everything, unranked, for an empty query', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], { query: '' });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it('filters by kind before ranking', () => {
    const video = asset({ id: 'sha256:v', kind: 'video', aspect: null });
    const hits = searchAssets([KEYWORDED, video], { query: '', kind: 'video' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:v']);
  });

  it('filters by aspect', () => {
    const square = asset({ id: 'sha256:sq', aspect: '1:1' });
    const hits = searchAssets([KEYWORDED, square], { query: '', aspect: '1:1' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:sq']);
  });

  it('filters by hasPeople, treating un-enriched assets as unknown and excluding them', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], { query: '', hasPeople: true });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:kw']);
  });

  it('excludes ids in excludeIds', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED], {
      query: 'standup',
      excludeIds: new Set(['sha256:kw']),
    });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:fn']);
  });

  it('breaks ties on captured_at, most recent first', () => {
    const older = asset({ ...FILENAMED, id: 'sha256:old', captured_at: '2020-01-01T00:00:00.000Z' });
    const newer = asset({ ...FILENAMED, id: 'sha256:new', captured_at: '2026-06-01T00:00:00.000Z' });
    const hits = searchAssets([older, newer], { query: 'standup' });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:new', 'sha256:old']);
  });

  it('honours limit', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED, FOLDERED], { query: 'standup', limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it('returns empty array when limit is 0', () => {
    const hits = searchAssets([KEYWORDED, FILENAMED, FOLDERED], { query: 'standup', limit: 0 });
    expect(hits).toHaveLength(0);
  });

  it('filters by hasPeople: false, excluding un-enriched assets', () => {
    const enrichedFalse = asset({
      id: 'sha256:enriched-false',
      enriched: {
        by: 'gemini',
        at: '2026-08-11T00:00:00.000Z',
        caption: 'empty room',
        keywords: [],
        look: 'minimal',
        has_people: false,
        text_in_image: false,
      },
    });
    const hits = searchAssets([enrichedFalse, FILENAMED], { query: '', hasPeople: false });
    expect(hits.map((h) => h.asset.id)).toEqual(['sha256:enriched-false']);
  });
});
