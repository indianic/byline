import { tokenise } from './scan.js';
import type { Asset, Aspect, MediaKind } from './types.js';

export interface SearchQuery {
  query: string;
  kind?: MediaKind;
  aspect?: Aspect;
  hasPeople?: boolean;
  excludeIds?: Set<string>;
  limit?: number;
}

export interface SearchHit {
  asset: Asset;
  score: number;
  /** Which tokens matched where. Returned so a bad ranking is diagnosable. */
  why: { field: string; tokens: string[] }[];
}

/**
 * Field weights.
 *
 * Keywords outrank everything because a human or a vision model chose them for
 * this image. A folder name is the weakest signal in the set — it is shared by
 * every file beneath it, so it says the least about any one of them.
 */
const WEIGHTS: Record<string, number> = {
  keywords: 4,
  caption: 2,
  filename: 2,
  folder: 1,
};

function fieldsOf(asset: Asset): Record<string, string[]> {
  return {
    keywords: asset.enriched?.keywords.flatMap(tokenise) ?? [],
    caption: asset.enriched ? tokenise(asset.enriched.caption) : [],
    filename: asset.source.filename_tokens,
    folder: asset.source.folder_tokens,
  };
}

/**
 * Rank assets against a query. Deterministic, no embeddings, no network.
 *
 * An empty query is not an error — it means "everything matching the filters",
 * which is how a caller browses. Every hit then scores 0 and the order is the
 * tiebreak alone.
 */
export function searchAssets(assets: Asset[], q: SearchQuery): SearchHit[] {
  const wanted = tokenise(q.query);

  const candidates = assets.filter((a) => {
    if (q.kind && a.kind !== q.kind) return false;
    if (q.aspect && a.aspect !== q.aspect) return false;
    // An un-enriched asset has no answer for has_people. Excluding it is the
    // honest reading: the filter asked for a property nothing has established.
    if (q.hasPeople !== undefined && a.enriched?.has_people !== q.hasPeople) return false;
    if (q.excludeIds?.has(a.id)) return false;
    return true;
  });

  const hits: SearchHit[] = [];

  for (const asset of candidates) {
    if (wanted.length === 0) {
      hits.push({ asset, score: 0, why: [] });
      continue;
    }

    let score = 0;
    const why: { field: string; tokens: string[] }[] = [];

    for (const [field, tokens] of Object.entries(fieldsOf(asset))) {
      const present = new Set(tokens);
      const matched = wanted.filter((t) => present.has(t));
      if (matched.length === 0) continue;
      score += matched.length * WEIGHTS[field]!;
      why.push({ field, tokens: matched });
    }

    if (score > 0) hits.push({ asset, score, why });
  }

  hits.sort((a, b) => b.score - a.score || b.asset.captured_at.localeCompare(a.asset.captured_at));

  return q.limit ? hits.slice(0, q.limit) : hits;
}
