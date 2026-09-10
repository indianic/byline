import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * UNVERIFIED — reasoned from Medium's editor, not measured by paste: Medium
 * has no publishing API for Byline to probe the way Ghost's and WordPress's
 * were, so nothing here has been confirmed by pasting real HTML into a real
 * Medium draft and reading the result back. It is reasoned from Medium's own
 * documented paste/import behaviour and widely observed editor limits
 * (no tables, two visual heading sizes, title/subtitle as separate fields).
 * Do not promote any line here to verified without an actual paste probe.
 */
export const MEDIUM_HTML_PROFILE: HtmlProfile = {
  platform: 'medium',
  label: 'Medium',

  preserved: new Set([
    'p', 'h1', 'h2', 'h3', 'strong', 'em', 'a', 'blockquote',
    'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'code', 'pre', 'hr',
  ]),

  unwrapped: new Set(['div', 'section', 'aside', 'span', 'small', 'mark', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h4']),

  inlineStyles: false,
  classAttributes: false,
  blockquote: 'passthrough',
  generatesHeadingIds: true,
  keepsLinkTarget: false,

  visualContainers: ['blockquote'],

  notes: [
    "UNVERIFIED — reasoned from Medium's editor, not measured by paste: Medium has no tables — its editor does not support a pasted <table>, so present comparisons as a bulleted list instead.",
    "Medium's Title and Subtitle are separate fields set outside the article body — never put the article title inside the HTML body itself.",
    "Medium's editor visually distinguishes only two heading sizes on paste — write H2 for every section heading and avoid relying on H3 for meaningful hierarchy.",
  ],

  verified: false,
  kind: 'article',
};
