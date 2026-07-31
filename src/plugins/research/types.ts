import type { KeyedProvider } from '../provider.js';

/**
 * How far back a search may reach.
 *
 * These members are the ones Task 1's live probe MEASURED both providers to
 * honour — see the recency table in `docs/RESEARCH-NOTES.md`. Do not add a
 * member without a probe showing both providers respect it: a window one
 * provider silently ignores would make `RESEARCH_STALE` fire for reasons the
 * user cannot act on.
 */
export type RecencyWindow = 'day' | 'week' | 'month';

export interface SearchOptions {
  window: RecencyWindow;
  maxResults: number;
}

/** One source, with its date when the provider gives one. */
export interface Finding {
  url: string;
  title: string;
  snippet: string;
  /**
   * ISO 8601, or null when the provider returned no date.
   *
   * NEVER inferred, never `new Date()`, never parsed out of a relative string
   * like "2 hours ago" without recording that it was derived. The news guard
   * refuses findings it cannot date, and a fabricated date would defeat it
   * exactly the way any-non-empty-string defeated the original guard.
   */
  publishedAt: string | null;
  /**
   * The provider's own relevance score, when it gives one. Tavily populates it;
   * Brave returns none, so `null`.
   *
   * Carried because **a fresh date is not evidence a result is about the
   * query.** MEASURED 2026-07-30 (see `docs/RESEARCH-NOTES.md`): under a
   * narrow `days` window Tavily backfills the result count with off-topic
   * filler that still carries a same-day `published_date` — an ASUS tablet
   * unboxing video came back for a stock-market query, stamped today. Code
   * that treats `publishedAt` as proof of aboutness lets that through the
   * news guard.
   *
   * **Deliberately NOT gated on.** No usable threshold has been measured, and
   * inventing one would be exactly the "never encode an unverified external
   * fact" defect. It is surfaced in the brief so the writer can discount
   * filler, and nothing refuses on it.
   */
  relevance: number | null;
  provider: string;
}

/** Why a particular provider ran. What stops the configurable default being silent. */
export type SelectedBy = 'explicit' | 'env-default' | 'sole-configured' | 'registry-order';

export interface ResearchResult {
  provider: string;
  query: string;
  /** The window actually requested, echoed back so the guard can check against it. */
  window: RecencyWindow;
  /**
   * A synthesized answer. Present only for a provider whose `synthesizes` is
   * true (Tavily); absent for Brave.
   *
   * ORIENTATION ONLY. It carries no URL, so `citation_provenance` can verify
   * nothing lifted from it, and `build_writing_brief` renders it under a header
   * saying so. Every claim that reaches the article must trace to a `Finding`.
   */
  answer?: string;
  findings: Finding[];
  selectedBy: SelectedBy;
}

/**
 * A research provider.
 *
 * Deliberately NOT a fallback chain member. Brave returns ranked snippets and
 * Tavily returns a synthesis plus sources — an automatic swap would silently
 * change what the writer receives, which is condition (b) in
 * `docs/ADDING-A-PLATFORM.md`. The user picks one; see `selectProvider`.
 */
export interface ResearchProvider extends KeyedProvider {
  /**
   * Whether this provider can populate `answer`. Declared, never guessed.
   *
   * **Declarative, and deliberately never branched on.** No production code
   * reads it: `build_writing_brief` branches on `answer`'s own presence
   * (`craft/brief.ts`), because a provider that *can* synthesize still returns
   * no answer for some queries — rendering the orientation section off
   * `synthesizes` would print an empty header. What it buys is a required
   * answer at the boundary: `ResearchProvider` cannot be implemented without
   * stating whether the adapter returns a synthesis, which is the ONE
   * structural difference between the two providers and the reason Byline
   * never substitutes one for the other. A third adapter must answer the
   * question before its author can decide whether that swap would be silent.
   * Asserted per adapter in `tests/plugins/research/`.
   */
  readonly synthesizes: boolean;
  withKey(key: string): ResearchProvider;
  /** `selectedBy` is the registry's business, not the adapter's. */
  search(query: string, opts: SearchOptions): Promise<Omit<ResearchResult, 'selectedBy'>>;
}
