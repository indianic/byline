/**
 * What survives a platform's HTML ingest.
 *
 * Lives in craft/, not plugins/, on purpose: the writing and scoring logic must
 * not import any adapter, or every brief would depend on every platform. Plugins
 * import this type and export instances; craft takes an instance as a parameter.
 *
 * Every field here exists because getting it wrong shipped a broken post. Do not
 * widen a profile from platform documentation — verify by live probe, the way
 * Ghost's was.
 */
export interface HtmlProfile {
  /**
   * Lowercase machine id of the platform this describes — e.g. `'ghost'`,
   * `'wordpress'`. For comparing, keying, or branching on which platform this
   * is. Never interpolate this into human-readable text: it will not be
   * capitalised the way the brand name is (`'wordpress'` is not `WordPress`).
   * Use `label` for anything the user or the host model reads.
   */
  platform: string;
  /**
   * Human-readable display name — e.g. `'Ghost'`, `'WordPress'` — for
   * interpolating into scorecards and writing briefs. This is the only field
   * that should appear in message text; `platform` is for logic.
   */
  label: string;
  /** Tags that survive with their styling intact. */
  preserved: ReadonlySet<string>;
  /** Tags whose inner text survives but whose element and styling are discarded. */
  unwrapped: ReadonlySet<string>;
  /** Whether inline `style=` attributes survive. */
  inlineStyles: boolean;
  /** Whether `class=` attributes survive. */
  classAttributes: boolean;
  /**
   * `native-rebuilt`: a standalone blockquote is reconstructed as a native node,
   * discarding its style and any inner <p>. `passthrough`: it survives as written.
   */
  blockquote: 'native-rebuilt' | 'passthrough';
  /** Whether the platform generates heading ids itself, making hand-written ones wrong. */
  generatesHeadingIds: boolean;
  /** Whether `target=` on a link survives. */
  keepsLinkTarget: boolean;
  /**
   * Elements acceptable as a summary/visual block container, ordered best first.
   * "Best" means the container survives ingest with its custom styling intact —
   * that entry is what other code should recommend to writers as *the* container
   * to use. Later entries also survive ingest (so they remain acceptable as a
   * summary block for gating purposes) but may lose their styling and be
   * restyled by the platform's own theme instead.
   */
  visualContainers: readonly string[];
  /** Platform-specific guidance, copied verbatim into the writing brief. */
  notes: readonly string[];
  /**
   * Whether every field above was confirmed by a live probe against a real
   * account on this platform, rather than reasoned from documentation or
   * carried over as a placeholder. Drives the header `buildBrief` renders for
   * this profile (`htmlRules` in `brief.ts`) — claiming "VERIFIED BY LIVE
   * PROBE" for an unverified profile is exactly the kind of inverted claim
   * that misleads whoever reads the brief. A platform can have both: e.g.
   * WordPress's permissive (holds `unfiltered_html`) branch is verified, its
   * restrictive branch is not, and each resolves to its own `HtmlProfile`
   * with its own value here.
   */
  verified: boolean;
}
