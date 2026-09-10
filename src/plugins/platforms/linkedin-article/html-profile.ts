import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * UNVERIFIED — reasoned from LinkedIn Article's editor, not measured by
 * paste: LinkedIn's article-publishing surface has no API Byline can probe,
 * so nothing here has been confirmed by pasting real HTML into a real
 * LinkedIn article draft and reading the result back. Its editor is the
 * most restrictive of the three export platforms — no code, no tables, and
 * only two heading levels — reasoned from LinkedIn's own documented article
 * editor limits, not measured. Do not promote any line here to verified
 * without an actual paste probe.
 *
 * NOTE: this is `linkedin-article`, the paste-based export platform for
 * LinkedIn's long-form Article feature — distinct from the `linkedin` API
 * plugin (LinkedIn feed posts, `kind: 'social'`) that Phase 5b adds.
 */
export const LINKEDIN_ARTICLE_HTML_PROFILE: HtmlProfile = {
  platform: 'linkedin-article',
  label: 'LinkedIn Article',

  preserved: new Set(['p', 'h1', 'h2', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'img']),

  unwrapped: new Set([
    'div', 'section', 'aside', 'span', 'small', 'mark',
    'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'h3', 'h4', 'figure', 'figcaption', 'hr',
  ]),

  inlineStyles: false,
  classAttributes: false,
  blockquote: 'passthrough',
  generatesHeadingIds: true,
  keepsLinkTarget: false,

  visualContainers: ['blockquote'],

  notes: [
    "UNVERIFIED — reasoned from LinkedIn Article's editor, not measured by paste: no tables — present comparisons as a bulleted list instead.",
    "No code blocks survive LinkedIn Article's editor — <pre>/<code> are unwrapped to plain text, so do not instruct a code sample for this platform.",
    "Two heading levels only: LinkedIn Article's editor supports H1 and H2 — H3 and deeper are unwrapped to plain text.",
    "The cover image is set through LinkedIn's own editor control, not the article body — a <figure> in the body is not the hero image.",
  ],

  verified: false,
  kind: 'article',
};
