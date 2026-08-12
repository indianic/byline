import { describe, expect, it } from 'vitest';
import { scoreDraft } from '../../src/craft/score.js';
import { embedHtml, parseVideoUrl } from '../../src/media/embed.js';
import { GHOST_HTML_PROFILE } from '../../src/plugins/platforms/ghost/html-profile.js';
import { buildProfile } from '../../src/plugins/platforms/wordpress/html-profile.js';

// The bug the live probe on 2026-08-12 exposed: score_draft's BLOCKING
// platform_html check rejected a plain <iframe> with "disallowed tag
// <iframe>" for Ghost, even though Ghost keeps it verbatim (wrapping it in
// its own kg-embed-card figure). embed_video's whole purpose is to put video
// into an article via <iframe> — the scorer must not block its own output.
const EMBED_HTML = embedHtml(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'A demo');

function platformHtmlCheck(html: string, profile: Parameters<typeof scoreDraft>[1]) {
  return scoreDraft(html, profile).checks.find((c) => c.name === 'platform_html')!;
}

describe('score_draft accepts an iframe video embed', () => {
  it('does not flag an iframe as a disallowed tag for Ghost', () => {
    const check = platformHtmlCheck(EMBED_HTML, GHOST_HTML_PROFILE);
    expect(check.findings).not.toContain('disallowed tag <iframe>');
    expect(check.findings.join(' ')).not.toMatch(/disallowed tag <iframe>/);
  });

  it('does not flag an iframe as a disallowed tag for WordPress with unfiltered_html', () => {
    const permissive = buildProfile(true);
    const check = platformHtmlCheck(EMBED_HTML, permissive);
    expect(check.findings.join(' ')).not.toMatch(/disallowed tag <iframe>/);
  });

  // Documents the UNVERIFIED boundary rather than silently passing it: no
  // probe has ever run against a WordPress account lacking unfiltered_html,
  // so 'iframe' was deliberately NOT added to the restrictive profile, and
  // score_draft is expected to keep flagging it there until one does.
  it('STILL flags an iframe for WordPress WITHOUT unfiltered_html — UNVERIFIED path, not silently widened', () => {
    const restrictive = buildProfile(false);
    const check = platformHtmlCheck(EMBED_HTML, restrictive);
    expect(check.findings.join(' ')).toMatch(/disallowed tag <iframe>/);
  });
});
