import type { SiteConfig } from '../../../config/sites.js';
import { ToolError } from '../../../errors.js';
import { basicAuthHeader } from './auth.js';
import type { HealthResult, PlatformAdapter, PostInput, PostResult } from '../types.js';

interface WordPressErrorBody {
  code?: string;
  message?: string;
  data?: { status?: number };
}

/** The `wp/v2/posts` response shape requested with `?context=edit`. */
interface WordPressPostResponse {
  id: number;
  link: string;
  status: string;
  title?: { raw?: string; rendered?: string };
  content?: { raw?: string; rendered?: string };
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/**
 * WordPress's media endpoint takes raw bytes rather than a multipart part, but
 * still needs to know what those bytes are. Confirmed by live probe on
 * 2026-07-29 against a real WordPress install: an upload with no `Content-Type`
 * at all is rejected outright with a 400
 * `{"code":"rest_upload_no_content_type","message":"No Content-Type supplied."}`
 * — harder than Ghost's 415 for the same class of mistake. The `Content-Type`
 * header is therefore always set explicitly, never left to guesswork.
 */
export function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Fields `PostInput` carries that WordPress core has no place to store.
 *
 * Each reason is surfaced verbatim in a warning naming the field — see
 * `unsupportedFieldWarnings`. Silently dropping any of these is exactly the
 * failure class this task exists to close: a `create_post` that reports
 * success while the caller's SEO/social metadata vanished.
 */
const UNSUPPORTED_FIELD_REASONS: Record<string, string> = {
  meta_title: 'WordPress core has no SEO title field; it needs a plugin such as Yoast SEO or RankMath, so it was not sent.',
  meta_description:
    'WordPress core has no SEO description field; it needs a plugin such as Yoast SEO or RankMath, so it was not sent.',
  canonical_url: 'WordPress core has no canonical URL field; it needs an SEO plugin, so it was not sent.',
  og_title: 'WordPress core has no Open Graph title field; it needs an SEO plugin, so it was not sent.',
  og_description: 'WordPress core has no Open Graph description field; it needs an SEO plugin, so it was not sent.',
  og_image: 'WordPress core has no Open Graph image field; it needs an SEO plugin, so it was not sent.',
  twitter_title: 'WordPress core has no Twitter Card title field; it needs an SEO plugin, so it was not sent.',
  twitter_description:
    'WordPress core has no Twitter Card description field; it needs an SEO plugin, so it was not sent.',
  twitter_image: 'WordPress core has no Twitter Card image field; it needs an SEO plugin, so it was not sent.',
  codeinjection_head:
    'WordPress core has no head-injection field; injecting arbitrary <head> markup (e.g. JSON-LD) needs a plugin or theme support, so it was not sent.',
  feature_image_alt:
    'WordPress does not accept alt text on the post endpoint; it must be set on the media object with a follow-up request, so it was not sent here.',
  feature_image_caption:
    'WordPress does not accept a caption on the post endpoint; it belongs to the media/attachment object, so it was not sent.',
  // Not in the platform's documented "cannot accept" list, but nothing in this
  // adapter maps it to WordPress's `date`/`date_gmt` fields yet — warning
  // rather than silently dropping it until that mapping is built and verified.
  published_at: "Scheduling/backdating is not wired up for WordPress yet, so it was not sent.",
};

export class WordPressAdapter implements PlatformAdapter {
  readonly slug: string;
  readonly platform = 'wordpress';
  private readonly base: string;

  constructor(private readonly site: SiteConfig) {
    this.slug = site.slug;
    this.base = site.apiUrl;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: basicAuthHeader(this.site.credentials.username ?? '', this.site.credentials.app_password ?? ''),
    };
  }

  /**
   * Shared request path for every WordPress REST call.
   *
   * On a non-2xx response, the WordPress REST API returns `{ code, message }`
   * (`data.status` is read defensively but its presence was not itself part of
   * what the probe checked) — confirmed by live probe on 2026-07-29, e.g. the
   * media-upload 400 above. `message` is the only useful diagnostic, so it is
   * surfaced verbatim. The credential is never interpolated into any thrown
   * message.
   */
  private async request(path: string, init: RequestInit = {}, json = true): Promise<unknown> {
    const url = `${this.base}/${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...this.headers(),
          ...(json ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (e) {
      throw new ToolError({
        api: `wordpress:${this.slug}`,
        code: 'NETWORK',
        message: `Cannot reach ${this.site.url}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (!res.ok) {
      const errBody = body as WordPressErrorBody;
      throw new ToolError({
        api: `wordpress:${this.slug}`,
        status: res.status,
        code: res.status === 401 ? 'UNAUTHORIZED' : 'WORDPRESS_ERROR',
        message:
          errBody.message ??
          (res.status === 401
            ? `WordPress rejected the credentials for "${this.slug}"`
            : `WordPress returned ${res.status} for ${path}`),
        hint:
          res.status === 401
            ? `Check the username and Application Password for "${this.slug}"`
            : 'Run health_check to test all configured APIs',
      });
    }
    return body;
  }

  /**
   * `GET {base}/wp/v2/users/me?context=edit` — confirmed by live probe on
   * 2026-07-29 (200, identifies the authenticated user, `capabilities` object
   * present alongside `name`).
   */
  async healthCheck(): Promise<HealthResult> {
    try {
      const body = (await this.request('wp/v2/users/me?context=edit')) as {
        name?: string;
      };
      return {
        slug: this.slug,
        platform: this.platform,
        ok: true,
        status: 200,
        detail: `Authenticated as ${body.name ?? 'unknown user'}`,
      };
    } catch (e) {
      const err = e instanceof ToolError ? e : undefined;
      return {
        slug: this.slug,
        platform: this.platform,
        ok: false,
        ...(err?.status !== undefined ? { status: err.status } : {}),
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * The authenticated user's WordPress capabilities (e.g. `unfiltered_html`),
   * used by `html-profile.ts` to decide whether inline `style=` attributes
   * survive this account's content sanitizer. Confirmed by live probe on
   * 2026-07-29: `capabilities` is an object of capability name -> boolean under
   * `?context=edit`, per `healthCheck`'s use of the same endpoint —
   * `capabilities.unfiltered_html === true` for the administrator account
   * probed, `capabilities.manage_network === false` (single-site, not
   * multisite). Only this account's own capabilities were probed; a
   * restricted account (one that actually lacks `unfiltered_html`) was not
   * available to test, so that branch of `html-profile.ts` stays UNVERIFIED.
   *
   * Throws (rather than returning a default) on any network error, non-2xx
   * response, or a body missing/malformed `capabilities` — callers that need
   * a restrictive fallback on failure (see `html-profile.ts`) do that
   * themselves rather than this method silently guessing permissive.
   */
  async getCapabilities(): Promise<Record<string, boolean>> {
    const body = (await this.request('wp/v2/users/me?context=edit')) as { capabilities?: unknown };
    if (!body.capabilities || typeof body.capabilities !== 'object' || Array.isArray(body.capabilities)) {
      throw new ToolError({
        api: `wordpress:${this.slug}`,
        code: 'NO_CAPABILITIES',
        message: `WordPress returned no capabilities for the authenticated user on "${this.slug}"`,
      });
    }
    return body.capabilities as Record<string, boolean>;
  }

  /**
   * WordPress's media endpoint takes the raw file body, not a multipart form —
   * unlike Ghost. `Content-Disposition` carries the filename and `Content-Type`
   * is set explicitly (see `mimeFor`); `json = false` on `request` stops the
   * shared helper from overwriting it with `application/json`.
   */
  async uploadImage(file: Buffer, filename: string, alt?: string): Promise<{ url: string; id?: string }> {
    const created = (await this.request(
      'wp/v2/media',
      {
        method: 'POST',
        body: new Uint8Array(file),
        headers: {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': mimeFor(filename),
        },
      },
      false,
    )) as { id?: number; source_url?: string };

    if (created.id === undefined || !created.source_url) {
      throw new ToolError({
        api: `wordpress:${this.slug}`,
        code: 'NO_IMAGE_URL',
        message: 'WordPress accepted the upload but returned no source_url',
      });
    }

    // This adapter never attempts alt_text on the upload request itself — only
    // as a follow-up `POST /wp/v2/media/{id}`. Confirmed by live probe on
    // 2026-07-29: the follow-up call returns 200 and sets it. (Whether the
    // initial upload request would also accept alt_text inline was not tested;
    // the follow-up approach is what is used and confirmed working.)
    if (alt) {
      await this.request(`wp/v2/media/${created.id}`, {
        method: 'POST',
        body: JSON.stringify({ alt_text: alt }),
      });
    }

    // The attachment id is what `applyFeatureImage` needs for `featured_media` —
    // WordPress's REST API has no way to look an id up from a URL after the
    // fact, so it must be carried alongside the URL from the moment of upload.
    return { url: created.source_url, id: String(created.id) };
  }

  /** One warning per field the caller set that WordPress core cannot store — never a silent drop. */
  private unsupportedFieldWarnings(input: Partial<PostInput>): string[] {
    const warnings: string[] = [];
    for (const [field, reason] of Object.entries(UNSUPPORTED_FIELD_REASONS)) {
      if ((input as Record<string, unknown>)[field] !== undefined) {
        warnings.push(`${field}: ${reason}`);
      }
    }
    return warnings;
  }

  /** Only the fields WordPress core accepts directly, built from whatever subset is present. */
  private buildBaseBody(input: Partial<PostInput>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    // Sent as raw HTML, unchanged — see the read-back diff for whether WordPress rewrote it.
    if (input.html !== undefined) body.content = input.html;
    if (input.status !== undefined) body.status = input.status === 'published' ? 'publish' : 'draft';
    // WordPress's own `excerpt` is writable, unlike Ghost's (where `custom_excerpt` is
    // the writable field and `excerpt` is read-only) — see the `PostInput` doc comment.
    if (input.custom_excerpt !== undefined) body.excerpt = input.custom_excerpt;
    return body;
  }

  /**
   * WordPress core posts support exactly one `author` (integer id); `PostInput.authors`
   * is Ghost-shaped (an array, for Ghost's multi-author posts). The first id is used;
   * any others are named in a warning rather than silently dropped.
   */
  private applyAuthors(body: Record<string, unknown>, authors: string[] | undefined, warnings: string[]): void {
    if (authors === undefined || authors.length === 0) return;
    const [first, ...rest] = authors;
    body.author = Number(first);
    if (rest.length > 0) {
      warnings.push(
        `authors: WordPress core posts support a single author; used "${first}" and ignored: ${rest.join(', ')}.`,
      );
    }
  }

  /**
   * WordPress's accepted field, `featured_media`, is an integer attachment id, not the
   * URL that `PostInput.feature_image` carries. `PostInput.feature_image_id` is the
   * companion field `uploadImage`'s own `id` flows into (see `uploadImage` above and
   * `PlatformAdapter.uploadImage`'s doc comment) — when it is present, it is used
   * directly. Confirmed by live probe on 2026-07-29: `featured_media` set to an
   * attachment id from `wp/v2/media` returns 201 and is stored correctly.
   *
   * `feature_image_id` is now part of the `create_post`/`update_post` MCP tool
   * schemas (see `src/tools/post-tools.ts`), so a caller going through the tool
   * layer can populate it.
   *
   * `Number(feature_image_id)` is validated before use: a non-numeric string
   * (a caller passing the URL into the id field by mistake, say) would
   * otherwise produce `NaN`, which JSON-serialises `featured_media` to `null`
   * — WordPress would silently clear/ignore the featured image with no
   * warning at all. That is caught here and reported instead.
   */
  private applyFeatureImage(
    body: Record<string, unknown>,
    feature_image: string | undefined,
    feature_image_id: string | undefined,
    warnings: string[],
  ): void {
    if (feature_image === undefined && feature_image_id === undefined) return;
    if (feature_image_id !== undefined) {
      const id = Number(feature_image_id);
      if (Number.isFinite(id)) {
        body.featured_media = id;
        return;
      }
      warnings.push(
        `feature_image_id: "${feature_image_id}" is not a valid numeric WordPress media id, so no featured image was set. Use the id upload_image returned, not a URL or slug.`,
      );
      return;
    }
    warnings.push(
      'feature_image: WordPress needs an integer media id (featured_media) to set a featured image; a URL was given with no accompanying feature_image_id, which this adapter cannot resolve to an id on its own, so no featured image was set.',
    );
  }

  /**
   * Resolves tag names (Ghost-shaped, from `PostInput.tags`) to WordPress term ids,
   * creating any tag that does not already exist.
   *
   * `GET /wp/v2/tags?search=` is a SUBSTRING match — confirmed by live probe on
   * 2026-07-29: searching "ProbeAI" returned both "ProbeAI" and "ProbeAI Ethics" —
   * so taking the first result would silently tag the post with the wrong term.
   * The match must be exact, case-insensitively, before it is trusted; only when
   * no exact match exists is a new tag created.
   */
  private async resolveTagIds(names: string[]): Promise<{ ids: number[]; warnings: string[] }> {
    const ids: number[] = [];
    const warnings: string[] = [];
    for (const name of names) {
      const matches = (await this.request(`wp/v2/tags?search=${encodeURIComponent(name)}`)) as Array<{
        id: number;
        name: string;
      }>;
      const exact = matches.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (exact) {
        ids.push(exact.id);
        continue;
      }
      const created = (await this.request('wp/v2/tags', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })) as { id?: number };
      if (created.id !== undefined) {
        ids.push(created.id);
      } else {
        warnings.push(`tags: could not resolve or create the tag "${name}"`);
      }
    }
    return { ids, warnings };
  }

  /**
   * Compares only the fields that were actually sent (so a partial `updatePost` never
   * flags an untouched field) against WordPress's `?context=edit` read-back. WordPress's
   * default response returns `content.rendered` with `wpautop` applied — diffing against
   * that would manufacture a false warning on every single call, so `.raw` is required.
   */
  /**
   * When `readBack.title?.raw` / `readBack.content?.raw` is present, this compares
   * it against what was sent and warns on a mismatch. When it is ABSENT — a
   * malformed or unexpected read-back response — the old version of this method
   * silently returned no warning for that field, which reads as "verified
   * identical" when in fact verification never ran at all. That false all-clear
   * is worse than no comparison: a caller sees no warning and reasonably assumes
   * WordPress didn't rewrite their content, when the truth is nobody checked.
   */
  private diffReadBack(sent: { title?: string; html?: string }, readBack: WordPressPostResponse): string[] {
    const warnings: string[] = [];
    if (sent.title !== undefined) {
      if (readBack.title?.raw === undefined) {
        warnings.push(
          'title: could not verify — the read-back response had no title.raw to compare against what was sent.',
        );
      } else if (readBack.title.raw !== sent.title) {
        warnings.push('title: WordPress returned different raw content than was sent (rewritten on save).');
      }
    }
    if (sent.html !== undefined) {
      if (readBack.content?.raw === undefined) {
        warnings.push(
          'content: could not verify — the read-back response had no content.raw to compare against what was sent.',
        );
      } else if (readBack.content.raw !== sent.html) {
        warnings.push('content: WordPress returned different raw content than was sent (rewritten on save).');
      }
    }
    return warnings;
  }

  /**
   * Refuse HTML that still carries the writing brief's image placeholder.
   *
   * Ghost has always guarded this; WordPress did not, so an article whose
   * `[[content_image]]` was never swapped for real `<figure>` markup published
   * with that literal text visible on the page. Nothing in this codebase
   * performs the substitution — the caller does, after `upload_image` returns
   * a URL — which makes forgetting it an ordinary mistake rather than an
   * exotic one, and the two platforms disagreeing about it is exactly the
   * shape of defect this project keeps shipping.
   */
  private assertResolved(html: string | undefined): void {
    if (html?.includes('[[content_image]]')) {
      throw new ToolError({
        api: `wordpress:${this.slug}`,
        code: 'UNRESOLVED_PLACEHOLDER',
        message: 'HTML still contains [[content_image]]',
        hint: 'Replace the placeholder with the <figure> markup before publishing',
      });
    }
  }

  async createPost(post: PostInput): Promise<PostResult> {
    this.assertResolved(post.html);
    const warnings = this.unsupportedFieldWarnings(post);
    const body = this.buildBaseBody(post);
    this.applyAuthors(body, post.authors, warnings);
    this.applyFeatureImage(body, post.feature_image, post.feature_image_id, warnings);
    if (post.tags !== undefined && post.tags.length > 0) {
      const { ids, warnings: tagWarnings } = await this.resolveTagIds(post.tags);
      if (ids.length > 0) body.tags = ids;
      warnings.push(...tagWarnings);
    }

    const created = (await this.request('wp/v2/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as WordPressPostResponse;

    // A second GET is used rather than trusting the create response's own
    // shape — confirmed necessary and sufficient by live probe on 2026-07-29:
    // `content.raw` on this read-back round-tripped byte-identical to the HTML
    // that was sent for every construct probed (styled <div>/<table>/
    // <blockquote>, hand-written heading ids, class attributes, target=
    // "_blank", rel="noopener noreferrer").
    const readBack = (await this.request(`wp/v2/posts/${created.id}?context=edit`)) as WordPressPostResponse;
    warnings.push(...this.diffReadBack({ title: post.title, html: post.html }, readBack));

    return {
      id: String(created.id),
      url: String(created.link),
      status: String(created.status),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult> {
    this.assertResolved(patch.html);
    const warnings = this.unsupportedFieldWarnings(patch);
    const body = this.buildBaseBody(patch);
    this.applyAuthors(body, patch.authors, warnings);
    this.applyFeatureImage(body, patch.feature_image, patch.feature_image_id, warnings);
    if (patch.tags !== undefined && patch.tags.length > 0) {
      const { ids, warnings: tagWarnings } = await this.resolveTagIds(patch.tags);
      if (ids.length > 0) body.tags = ids;
      warnings.push(...tagWarnings);
    }

    // PUT is accepted for updates — confirmed by the self-cleaning update step
    // in tests/integration/wordpress.integration.test.ts (an actual title
    // update, read back and verified) run against a real WordPress install while
    // building this. WordPress core registers WP_REST_Server::EDITABLE (PUT,
    // PATCH, POST) for the single-post route, consistent with the observed
    // result.
    const updated = (await this.request(`wp/v2/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })) as WordPressPostResponse;

    const readBack = (await this.request(`wp/v2/posts/${id}?context=edit`)) as WordPressPostResponse;
    warnings.push(...this.diffReadBack({ title: patch.title, html: patch.html }, readBack));

    return {
      id: String(updated.id),
      url: String(updated.link),
      status: String(updated.status),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async listTags(): Promise<Array<{ id: string; name: string; slug: string }>> {
    const body = (await this.request('wp/v2/tags?per_page=100')) as Array<{
      id: number;
      name: string;
      slug: string;
    }>;
    return body.map((t) => ({ id: String(t.id), name: t.name, slug: t.slug }));
  }

  /** `context=edit` is what makes WordPress include `email` — it is edit-context-only. */
  async listAuthors(): Promise<Array<{ id: string; name: string; email?: string }>> {
    const body = (await this.request('wp/v2/users?per_page=100&context=edit')) as Array<{
      id: number;
      name: string;
      email?: string;
    }>;
    return body.map((u) => ({
      id: String(u.id),
      name: u.name,
      ...(u.email ? { email: u.email } : {}),
    }));
  }
}
