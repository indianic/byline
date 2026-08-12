import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * Ghost 6.44, verified by live probe on 2026-07-28.
 *
 * Every entry was confirmed by publishing a post and reading it back, not from
 * documentation. Four separate defects reached production because mocked tests
 * agreed with an assumption; each was caught by a single real API call. Do not
 * widen this list without a probe that proves the change.
 */
export const GHOST_HTML_PROFILE: HtmlProfile = {
  platform: 'ghost',
  label: 'Ghost',

  preserved: new Set([
    'p', 'h2', 'h3', 'h4', 'strong', 'em', 'blockquote',
    'ul', 'ol', 'li', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'figure', 'figcaption', 'img', 'hr', 'code',
    // Verified by live probe 2026-08-12 against the probed Ghost install: a bare
    // <iframe>, a <figure><iframe>...<figcaption> wrapper, a Vimeo player
    // iframe, a Bunny Stream embed with loading="lazy", and an iframe carrying
    // an inline style="" all survived a create-draft / read-back / delete
    // round trip unchanged. Ghost additionally WRAPS the iframe in its own
    // <figure class="kg-card kg-embed-card"> on top of whatever figure the
    // caller supplied — this is the mechanism a YouTube/Vimeo/Bunny Stream
    // embed relies on. See src/media/embed.ts (embed_video) and
    // docs/GHOST-NOTES.md for the full probe.
    'iframe',
  ]),

  /**
   * Ghost unwraps these on ingest: the inner text survives but every style,
   * border, and background is lost. A div-based card silently becomes bare text,
   * which is worse than an error because the post still publishes.
   */
  unwrapped: new Set([
    'div', 'section', 'aside', 'span', 'small', 'pre', 'mark',
    'dl', 'dt', 'dd', 'header', 'footer', 'article', 'main', 'nav',
  ]),

  inlineStyles: true,
  classAttributes: false,

  /**
   * A standalone <blockquote> is a native Ghost node: the converter rebuilds it
   * and throws away the inline style and any inner <p>. A bare
   * `<blockquote style="...">` came back as `<blockquote>`.
   */
  blockquote: 'native-rebuilt',

  generatesHeadingIds: true,
  keepsLinkTarget: false,

  /**
   * A styled <table> is the only container that survives ingest with its styling,
   * so it is listed first and is what we recommend to writers. A standalone
   * <blockquote> is second: per `blockquote: 'native-rebuilt'` above, Ghost
   * rebuilds it as a native node and discards its custom styling, but the
   * element itself does survive and is styled by the site theme, so it remains
   * an acceptable (if unstyled) summary-block container.
   */
  visualContainers: ['table', 'blockquote'],

  notes: [
    'Use a styled <table> for any visual block. It is the only container that keeps its styling.',
    'Do NOT add a target attribute to any link — Ghost strips it on ingest, so it is dead weight. rel="noopener noreferrer" does survive.',
    'Never write id attributes on headings — Ghost generates them automatically.',
    'No <style> blocks. Inline styles only.',
    'No class attributes.',
    // Measured, not assumed — 2026-08-12: a <video src="..." controls> tag is
    // stripped entirely on ingest; nothing of it survives, not even as unwrapped
    // text. A streaming embed (<iframe>, via embed_video) is the only way to put
    // video in a Ghost post.
    'Never use a <video> tag — Ghost strips it completely on ingest, with nothing surviving. Use embed_video to turn a YouTube/Vimeo/Bunny Stream URL into an <iframe> embed instead; that is the only way to put video in a Ghost post.',
  ],

  verified: true,
};
