import { describe, expect, it } from 'vitest';
import { GHOST_HTML_PROFILE } from '../../../src/plugins/platforms/ghost/html-profile.js';

describe('Ghost HTML profile', () => {
  it('preserves the tags verified by live probe', () => {
    for (const tag of ['p', 'h2', 'h3', 'h4', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'a',
                       'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
                       'img', 'hr', 'code']) {
      expect(GHOST_HTML_PROFILE.preserved.has(tag)).toBe(true);
    }
    // Pins the exact membership: a widened list (extra tag added alongside the
    // correct ones) would pass the per-tag assertions above but must fail here.
    expect(GHOST_HTML_PROFILE.preserved.size).toBe(22);
  });

  it('marks the unwrapped tags', () => {
    for (const tag of ['div', 'section', 'aside', 'span', 'small', 'pre', 'mark',
                       'dl', 'dt', 'dd', 'header', 'footer', 'article', 'main', 'nav']) {
      expect(GHOST_HTML_PROFILE.unwrapped.has(tag)).toBe(true);
    }
    // Pins the exact membership: a widened list (extra tag added alongside the
    // correct ones) would pass the per-tag assertions above but must fail here.
    expect(GHOST_HTML_PROFILE.unwrapped.size).toBe(15);
  });

  it('never lists a tag as both preserved and unwrapped', () => {
    for (const tag of GHOST_HTML_PROFILE.preserved) {
      expect(GHOST_HTML_PROFILE.unwrapped.has(tag)).toBe(false);
    }
  });

  it('records the behaviours that cost production bugs to learn', () => {
    expect(GHOST_HTML_PROFILE.inlineStyles).toBe(true);
    expect(GHOST_HTML_PROFILE.classAttributes).toBe(false);
    expect(GHOST_HTML_PROFILE.generatesHeadingIds).toBe(true);
    expect(GHOST_HTML_PROFILE.keepsLinkTarget).toBe(false);
    expect(GHOST_HTML_PROFILE.blockquote).toBe('native-rebuilt');
    expect(GHOST_HTML_PROFILE.visualContainers).toContain('table');
  });

  it('lists table before blockquote in visualContainers, since order is load-bearing', () => {
    // table keeps its styling and must stay the recommended container; blockquote
    // survives ingest (native-rebuilt) but loses custom styling, so it must come
    // second, not first.
    expect(GHOST_HTML_PROFILE.visualContainers).toEqual(['table', 'blockquote']);
    expect(GHOST_HTML_PROFILE.visualContainers[0]).toBe('table');
  });

  it('identifies as the ghost platform', () => {
    expect(GHOST_HTML_PROFILE.platform).toBe('ghost');
  });

  it('has a capitalised display label distinct from the machine id', () => {
    expect(GHOST_HTML_PROFILE.label).toBe('Ghost');
  });

  it('has non-empty notes', () => {
    expect(GHOST_HTML_PROFILE.notes.length).toBeGreaterThan(0);
  });
});
