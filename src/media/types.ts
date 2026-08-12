/** The three aspect buckets the image tools already accept. One vocabulary, not two. */
export type Aspect = '16:9' | '4:3' | '1:1';

export type MediaKind = 'image' | 'video';

export interface LibraryConfig {
  name: string;
  /** Absolute, `~` already expanded. */
  path: string;
  recursive: boolean;
  /** Where the index and ledger live. Defaults to `<byline home>/media`. */
  indexPath?: string;
  /**
   * Why this library cannot be used, if it cannot. Mirrors `SiteConfig.unavailable`:
   * a broken library still loads so the others keep working, and `getLibrary`
   * refuses it at point of use.
   */
  unavailable?: string;
}

export interface MediaConfig {
  defaultLibrary?: string;
  /** `site` — used on one site, still free elsewhere. `global` — used once, ever. */
  reuseScope: 'site' | 'global';
  libraries: Record<string, LibraryConfig>;
  /** Config-level complaints, folded into SetupState.problems by loadContext. */
  problems: string[];
}

export interface AssetSource {
  filename_tokens: string[];
  folder_tokens: string[];
  /** Where `captured_at` came from. `mtime` is a much weaker claim than `exif`. */
  captured_from: 'exif' | 'mtime';
  exif?: Record<string, string>;
}

export interface AssetEnrichment {
  by: string;
  at: string;
  caption: string;
  keywords: string[];
  look: string;
  has_people: boolean;
  text_in_image: boolean;
}

export interface Asset {
  /** `sha256:<hex>` of the file's bytes. The only identity that survives a rename. */
  id: string;
  /** Relative to the library root, POSIX separators, so an index is portable. */
  path: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  aspect: Aspect | null;
  duration_s: number | null;
  captured_at: string;
  scanned_at: string;
  /** Part of the hash cache key. A file whose mtime and size are unchanged is not rehashed. */
  mtime_ms: number;
  source: AssetSource;
  enriched?: AssetEnrichment;
}

export interface MediaIndex {
  version: 1;
  library: string;
  root: string;
  scanned_at: string;
  assets: Asset[];
}

export type UsageState = 'reserved' | 'published';

export interface UsageRecord {
  id: string;
  site: string;
  state: UsageState;
  hosted_url: string;
  post_url?: string;
  slot?: string;
  at: string;
}

export interface UsageLedger {
  version: 1;
  library: string;
  records: UsageRecord[];
}
