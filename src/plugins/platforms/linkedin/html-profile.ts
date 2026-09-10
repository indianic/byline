import type { HtmlProfile } from '../../../craft/html-profile.js';

/**
 * UNVERIFIED — reasoned from LinkedIn's own published `commentary` field
 * documentation, not measured against a live post. `create_post` never
 * actually sends this profile's `preserved`/`unwrapped` tags to LinkedIn at
 * all: `toCommentary` (`linkedin/index.ts`) strips every tag before the text
 * ever leaves this process, converting `</p>` to a paragraph break first.
 * This profile exists so `score_draft`'s `NOT_AN_ARTICLE_PLATFORM` refusal
 * (`kind: 'social'`) and `build_writing_brief`'s HTML-rules renderer have
 * something honest to describe LinkedIn with, not because any of these tags
 * survive ingest — none of them do; LinkedIn feed posts are plain text.
 *
 * NOTE: this is the `linkedin` API plugin (LinkedIn feed posts) — distinct
 * from `linkedin-article`, the paste-based export platform for LinkedIn's
 * long-form Article feature.
 */
export const LINKEDIN_POST_PROFILE: HtmlProfile = {
  platform: 'linkedin',
  label: 'LinkedIn',

  // The only element `toCommentary` treats as meaningful structure: `</p>`
  // becomes a paragraph break in the plain-text commentary. Every other tag
  // is unwrapped to bare text.
  preserved: new Set(['p']),

  unwrapped: new Set([
    'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'a', 'blockquote',
    'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'code', 'pre', 'hr',
    'div', 'section', 'aside', 'span', 'small', 'mark',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ]),

  inlineStyles: false,
  classAttributes: false,
  blockquote: 'passthrough',
  generatesHeadingIds: false,
  keepsLinkTarget: false,

  // Nothing survives as a styled visual container — a feed post is plain
  // text with line breaks, never a `<table>` or a styled `<div>` card.
  visualContainers: [],

  notes: [
    'This is a feed post, not an article. Formatting does not survive.',
    '3000 characters maximum; the first ~210 show before "see more".',
  ],

  verified: false,
  kind: 'social',
};
