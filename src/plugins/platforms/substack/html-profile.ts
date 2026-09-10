import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * UNVERIFIED — reasoned from Substack's editor, not measured by paste:
 * Substack has no publishing API for Byline to probe, so nothing here has
 * been confirmed by pasting real HTML into a real Substack draft and reading
 * the result back. Same tag vocabulary as Medium's editor plus a wider
 * heading range (H4–H6), reasoned from Substack's own documented paste and
 * Markdown-import support. Do not promote any line here to verified without
 * an actual paste probe.
 */
export const SUBSTACK_HTML_PROFILE: HtmlProfile = {
  platform: 'substack',
  label: 'Substack',

  preserved: new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'a', 'blockquote',
    'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'code', 'pre', 'hr',
  ]),

  unwrapped: new Set(['div', 'section', 'aside', 'span', 'small', 'mark', 'table', 'thead', 'tbody', 'tr', 'th', 'td']),

  inlineStyles: false,
  classAttributes: false,
  blockquote: 'passthrough',
  generatesHeadingIds: true,
  keepsLinkTarget: false,

  visualContainers: ['blockquote'],

  notes: [
    "UNVERIFIED — reasoned from Substack's editor, not measured by paste: Substack has no tables — present comparisons as a bulleted list instead.",
    "Substack's pull-quote style corresponds to a <blockquote> — use it for the one visual callout the brief asks for.",
    "Buttons are not pasteable in Substack's editor — a call-to-action button in the source HTML will not survive; write it as a plain link instead.",
  ],

  verified: false,
  kind: 'article',
};
