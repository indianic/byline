import { describe, expect, it } from 'vitest';
import { GHOST_HTML_PROFILE } from '../../../src/plugins/platforms/ghost/html-profile.js';

describe('Ghost HTML profile', () => {
  it('preserves the tags verified by live probe', () => {
    for (const tag of ['p', 'h2', 'h3', 'h4', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'a',
                       'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
                       'img', 'hr', 'code', 'iframe']) {
      expect(GHOST_HTML_PROFILE.preserved.has(tag)).toBe(true);
    }
    // Pins the exact membership: a widened list (extra tag added alongside the
    // correct ones) would pass the per-tag assertions above but must fail here.
    expect(GHOST_HTML_PROFILE.preserved.size).toBe(23);
  });

  // Regression: the probe on 2026-08-12 found score_draft's BLOCKING
  // platform_html check rejecting a plain <iframe> with "disallowed tag
  // <iframe>", even though Ghost keeps it verbatim (and wraps it in its own
  // kg-embed-card figure). embed_video exists specifically to put video into
  // an article via <iframe>; the scorer must not block its own output.
  it('preserves iframe — a video embed must not be rejected as a disallowed tag', () => {
    expect(GHOST_HTML_PROFILE.preserved.has('iframe')).toBe(true);
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

  // Measured 2026-08-12: <video> is stripped completely on ingest — nothing of
  // it survives. The notes must say so, and point at the only way video
  // actually gets into a Ghost post.
  it('warns that <video> is stripped entirely and names embed_video as the alternative', () => {
    const videoNote = GHOST_HTML_PROFILE.notes.find((n) => /<video>/.test(n));
    expect(videoNote).toBeDefined();
    expect(videoNote).toMatch(/strips it completely|stripped completely/);
    expect(videoNote).toContain('embed_video');
  });
});
