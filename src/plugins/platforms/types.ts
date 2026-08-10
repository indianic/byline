import type { z } from 'zod';
import type { SiteConfig } from '../../config/sites.js';
import type { HtmlProfile } from '../../craft/html-profile.js';
import type { PostStatus, SiteTimezone } from './schedule.js';

/**
 * One field a platform needs in order to authenticate.
 *
 * Exists because `add_site` used to hardcode Ghost's single `admin_api_key` and
 * could not express WordPress, which needs a non-secret username alongside a
 * secret application password. The `secret` flag is what decides whether a value
 * is written literally into config.yaml or indirected through `${ENV_VAR}` — so
 * config.yaml stays shareable and only .env holds anything sensitive.
 */
export interface CredentialField {
  /** Key written into config.yaml, e.g. 'admin_api_key' or 'username'. */
  name: string;
  /** Shown by the CLI when prompting, e.g. 'Admin API key'. */
  label: string;
  /**
   * true  → value is a secret; config.yaml gets ${ENV_VAR} and the value goes to .env
   * false → value is not sensitive and is written literally into config.yaml
   */
  secret: boolean;
  /** Placeholder shown in messages, e.g. 'id:secret' or 'xxxx xxxx xxxx'. */
  example: string;
  /** Where the user obtains it — a click path, not a URL. */
  help: string;
}

export interface HealthResult {
  slug: string;
  platform: string;
  ok: boolean;
  status?: number;
  detail: string;
}

export interface PostInput {
  title: string;
  html: string;
  /**
   * `scheduled` means "publish this at `publish_at`, not now". Each adapter
   * maps it to its own token — Ghost's `scheduled`, WordPress's `future` —
   * because the two platforms do not share one.
   */
  status: PostStatus;

  /**
   * The URL path segment, e.g. `legacy-modernisation-gulf`.
   *
   * Omit it and both platforms generate one from the title, which is how a
   * seven-word headline becomes a seventy-character URL — and neither platform
   * lets you change it afterwards through this API, so the only remedy was a
   * manual trip into the admin UI before the post was indexed or shared.
   *
   * Both platforms NORMALISE what they are given (case, punctuation) and both
   * resolve a collision by appending a counter, so the stored slug is not
   * guaranteed to be the one sent. Each adapter therefore compares the two and
   * warns on a difference rather than letting the post live at a URL the caller
   * never asked for — the same silent-wrong-result the write-back diff exists
   * to catch.
   */
  slug?: string;

  /** Shown in listings and feeds. Ghost's writable field — `excerpt` is read-only. */
  custom_excerpt?: string;

  // --- SEO ---
  meta_title?: string;
  meta_description?: string;
  canonical_url?: string;

  // --- Feature image ---
  feature_image?: string;
  /**
   * The platform-native identifier for `feature_image`, when one exists —
   * WordPress's numeric media attachment id, populated from `uploadImage`'s
   * `id`. A URL alone cannot be turned back into that id (`uploadImage`
   * uploads once; there is no reverse lookup), so this is a companion field
   * rather than a replacement for the URL: `feature_image` still carries the
   * URL every platform needs for display and for `og_image`/`twitter_image`
   * fallback, while this carries whatever native id the upload produced, for
   * platforms (like WordPress's `featured_media`) whose own field wants an id
   * rather than a URL. Ghost has no such field and ignores this.
   */
  feature_image_id?: string;
  feature_image_alt?: string;
  feature_image_caption?: string;

  // --- Open Graph (Facebook, LinkedIn, WhatsApp) ---
  og_title?: string;
  og_description?: string;
  og_image?: string;

  // --- X / Twitter card ---
  twitter_title?: string;
  twitter_description?: string;
  twitter_image?: string;

  /** Injected into <head>. Carries JSON-LD structured data for AEO/GEO. */
  codeinjection_head?: string;

  tags?: string[];
  authors?: string[];

  /**
   * When the post should carry as its publish time, as whole-second UTC ISO.
   *
   * Named `publish_at` and not `published_at` — the field it used to be called
   * — because past tense is wrong for its main use and actively misleading to
   * the model filling it in: with `status: 'scheduled'` this is a time that has
   * not happened yet. Each adapter maps it to its own wire field (Ghost's
   * `published_at`, WordPress's `date_gmt`); nothing forwards this name
   * verbatim. Under its old name the Ghost adapter DID forward it verbatim, by
   * accident, through a loop that copies every key — so the field was half-wired
   * on one platform and warned as unsupported on the other.
   *
   * What a given `status` + `publish_at` pair is permitted to mean is decided
   * once, in `resolveTiming` (`./schedule.ts`), before any adapter sees it.
   */
  publish_at?: string;
}

/** Fields the caller set that came back empty from the platform. */
export interface PostResult {
  id: string;
  url: string;
  status: string;
  /**
   * The publish time the platform actually stored, as UTC ISO — present
   * whenever `publish_at` was sent. Read back from the platform's own
   * response rather than echoed from the request, so it reports what is true
   * rather than what was asked for.
   */
  publish_at?: string;
  /** Non-fatal: fields the platform silently discarded. Never empty-but-absent. */
  warnings?: string[];
}

export interface PlatformAdapter {
  readonly slug: string;
  readonly platform: string;
  /**
   * Proves this site's stored credential actually works, right now.
   *
   * **The endpoint probed MUST require authentication.** `ok: true` is read by
   * `health_check`, by `doctor`, and — most consequentially — by the `init`
   * credential walk, which uses it to decide whether to accept a key the user
   * just typed. A probe against an endpoint that answers anonymously returns
   * `ok: true` for any string shaped like a credential, so all three report a
   * wrong key as working, and the first failure the user ever sees is their
   * first `create_post`.
   *
   * This is not hypothetical. `GhostAdapter.healthCheck` probed `GET /site/`,
   * which Ghost serves with no auth at all: a fabricated-but-well-formed key
   * (`'0'.repeat(24) + ':' + 'a'.repeat(64)`) came back `ok: true, status: 200`
   * with the real site title. It now gates on `GET /config/`, which answers
   * 401 for that same key. See `docs/ADDING-A-PLATFORM.md`.
   *
   * Verify by probing live with a fabricated key and confirming a non-2xx —
   * "this endpoint looks authenticated" is exactly what was believed about
   * `/site/`. Never derive `ok` from the credential merely being present or
   * well-formed; a malformed-key check is a useful early exit, not a substitute.
   */
  healthCheck(): Promise<HealthResult>;
  /**
   * Uploads an image and returns the hosted URL plus, when the platform has
   * one, its own native identifier for the upload.
   *
   * This exists because a URL is not always enough: Ghost's create/update
   * post API only ever wants a URL, but WordPress's `featured_media` field
   * wants the integer attachment id, and there is no way to derive one from
   * the other after the fact. Before this shape existed, `uploadImage`
   * returned only `{ url }`, and WordPress's `applyFeatureImage` had no id to
   * work with — the hero image silently never got set. Ghost populates `id`
   * only if its own response happens to carry one and omits it otherwise;
   * WordPress always populates it. `id`, when present, flows through
   * `upload_image`'s tool result into `PostInput.feature_image_id`.
   */
  uploadImage(file: Buffer, filename: string, alt?: string): Promise<{ url: string; id?: string }>;
  /**
   * The BLOG's own timezone — what a wall-clock `publish_at` is read in.
   *
   * "Publish at 10am tomorrow" means 10am *on the blog*. The machine running
   * Byline never enters into it, so this cannot be answered locally: it is a
   * setting on the platform and has to be fetched from it. Ghost reports an
   * IANA zone under the `timezone` key of `GET /settings/`; WordPress reports
   * `timezone_string` on `GET /wp-json/`, or — when the site is configured by
   * offset rather than by city — an empty string plus a `gmt_offset`.
   *
   * **Throw rather than defaulting to UTC.** A blog whose timezone could not
   * be read is a blog Byline cannot schedule for correctly, and quietly
   * assuming UTC would publish at the wrong hour for most of the world while
   * reporting success. `parsePublishAt` turns the absence into a refusal that
   * tells the caller to pass an explicit offset instead.
   *
   * Callers should not call this repeatedly — it is a setting, not a
   * per-request fact. `cachedTimezone` in `../schedule.ts` memoises it per
   * site, caching successes only.
   */
  siteTimezone(): Promise<SiteTimezone>;
  createPost(post: PostInput): Promise<PostResult>;
  updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult>;
  listTags(): Promise<Array<{ id: string; name: string; slug: string }>>;
  listAuthors(): Promise<Array<{ id: string; name: string; email?: string }>>;
}

/**
 * A publishing platform, packaged.
 *
 * Everything platform-specific hangs off this: how its credentials are shaped,
 * where its API lives, how it identifies an author, and (from Task 8) what HTML
 * survives its ingest. Adding a platform means adding a folder that exports one
 * of these plus one line in the registry — nothing else in the codebase changes.
 */
export interface PlatformPlugin {
  readonly id: string;
  /** Human-readable, shown by the CLI's platform picker. */
  readonly label: string;
  /**
   * Validates this platform's block in config.yaml. Ghost needs one `id:secret`
   * admin key; WordPress needs a username and an application password. Keeping
   * the schema next to the adapter is what stops config drifting from code.
   */
  readonly credentialSchema: z.ZodTypeAny;
  /** Every field this platform needs, in the order a human should be asked for them. */
  readonly credentialFields: readonly CredentialField[];
  /** Where the API lives when the user has not overridden `api_url`. */
  defaultApiUrl(siteUrl: string): string;
  makeAdapter(site: SiteConfig): PlatformAdapter;
  /**
   * True when the value is a native author id rather than a persona slug.
   * Ghost uses 24 lowercase hex chars; WordPress uses integers.
   */
  isAuthorId(value: string): boolean;
  /**
   * What survives this platform's HTML ingest.
   *
   * Async and adapter-taking because it is not always a constant: WordPress
   * strips inline styles unless the authenticated user holds `unfiltered_html`,
   * which admins have on single-site installs but only super-admins have on
   * multisite. Ghost's is fixed and ignores the adapter.
   *
   * Caching contract: this method makes no promise about being cheap or
   * side-effect-free — a WordPress implementation may issue an HTTP call to
   * check the authenticated user's capabilities. Implementations must not
   * assume they are called only once, but callers (e.g. `score_draft`,
   * `create_post`) are responsible for not repeating that call needlessly:
   * memoise the resolved profile per site, keyed by `adapter.slug`, and treat
   * it as stable for the lifetime of the process. WordPress's implementation
   * does exactly this — see the `cache` in
   * `src/plugins/platforms/wordpress/html-profile.ts`, which also documents
   * why a FAILED capability read must not be cached the same way a
   * successful one is.
   */
  htmlProfile(adapter: PlatformAdapter): Promise<HtmlProfile>;
}
