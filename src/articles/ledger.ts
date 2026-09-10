import type { ArticleLedger, ArticleRecord, ArticleShare } from './types.js';

/**
 * Record a publish. Upserts by `id` (`${site}:${post_id}`) so re-recording
 * the same post — a retried `create_post`, or a future caller — replaces its
 * entry rather than duplicating it. Returns a new ledger; the input is
 * untouched, matching `media/ledger.ts`'s non-mutation contract.
 *
 * A record already carrying that id keeps its accumulated `shares`: shares
 * are recorded separately (`recordShare`), and an upsert of the article's own
 * fields must not discard history of where it was shared.
 */
export function recordArticle(
  ledger: ArticleLedger,
  rec: Omit<ArticleRecord, 'recorded_at' | 'shares'>,
): ArticleLedger {
  const existing = ledger.records.find((r) => r.id === rec.id);
  const record: ArticleRecord = {
    ...rec,
    recorded_at: new Date().toISOString(),
    shares: existing?.shares ?? [],
  };
  const records = existing
    ? ledger.records.map((r) => (r.id === rec.id ? record : r))
    : [...ledger.records, record];
  return { ...ledger, records };
}

/** The `n` most recently recorded articles, newest first. */
export function recentArticles(ledger: ArticleLedger, n: number): ArticleRecord[] {
  return [...ledger.records]
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, n);
}

/**
 * The union of `choices` over the `n` most recently recorded articles, keyed
 * by dimension name — what `buildBrief`'s anti-repeat draw treats as "already
 * used recently" for this persona.
 *
 * Only the last `n` records contribute, not the whole ledger: an option this
 * persona used two months ago is not a repeat the way one used yesterday is.
 */
export function recentChoices(ledger: ArticleLedger, n: number): Record<string, number[]> {
  const avoid: Record<string, number[]> = {};
  for (const rec of recentArticles(ledger, n)) {
    if (!rec.choices) continue;
    for (const [dimension, idx] of Object.entries(rec.choices)) {
      const seen = (avoid[dimension] ??= []);
      if (!seen.includes(idx)) seen.push(idx);
    }
  }
  return avoid;
}

/**
 * Record a share of an already-published article to some other platform
 * (a `kind: 'social'` profile — Phase 5's territory; see `types.ts`).
 *
 * Matches on the article's own `url`, the same "what the platform actually
 * stored" principle `media/ledger.ts`'s `promote` uses for hosted image URLs.
 * `matched: false` on no match, with the ledger returned unchanged, so a
 * caller can tell a wiring bug (recording a share against the wrong ledger)
 * apart from a legitimate share of an article this persona ledger never
 * recorded.
 */
export function recordShare(
  ledger: ArticleLedger,
  articleUrl: string,
  share: ArticleShare,
): { ledger: ArticleLedger; matched: boolean } {
  let matched = false;
  const records = ledger.records.map((r) => {
    if (r.url !== articleUrl) return r;
    matched = true;
    return { ...r, shares: [...r.shares, share] };
  });
  return { ledger: { ...ledger, records }, matched };
}

/** Every recorded article in the given series, in ledger order. */
export function siblings(ledger: ArticleLedger, series: string): ArticleRecord[] {
  return ledger.records.filter((r) => r.series === series);
}
