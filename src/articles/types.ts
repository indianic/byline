/** One share of a published article to a social/`kind: 'social'` platform. */
export interface ArticleShare {
  site: string;
  platform: string;
  url: string;
  at: string;
}

/**
 * One published article, recorded so a later brief for the same persona can
 * avoid repeating its shape and can link back to it.
 *
 * `id` is `${site}:${post_id}` — the pair that uniquely identifies a post on
 * one platform, mirroring how `create_post`/`update_post` already address a
 * post. `choices` mirrors exactly what `build_writing_brief` returned in its
 * result, keyed by `DimensionName`, so the anti-repeat draw in `buildBrief`
 * can compare like for like without this module depending on `craft/`.
 */
export interface ArticleRecord {
  id: string;
  persona: string;
  site: string;
  platform: string;
  post_id: string;
  url: string;
  title: string;
  slug?: string;
  topic?: string;
  primary_keyword?: string;
  tags: string[];
  seed?: number;
  choices?: Record<string, number>;
  series?: string;
  /** What the platform returned for this post's status (e.g. "published", "scheduled"). */
  status: string;
  /** UTC ISO, when known. */
  publish_at?: string;
  recorded_at: string;
  shares: ArticleShare[];
}

export interface ArticleLedger {
  version: 1;
  persona: string;
  records: ArticleRecord[];
}
