// src/plugins/platforms/linkedin/index.ts
//
// UNVERIFIED IN FULL. Every request shape in this file — every endpoint path,
// every field name, every header, the shape of a success body and an error
// body — is reasoned from LinkedIn's published REST API documentation, never
// measured against a real access token. Nothing here has run against a live
// LinkedIn account. `tests/integration/linkedin.integration.test.ts` is the
// probe that can promote any of it to verified; until it has actually run
// against a real token, treat every line below as a documented claim, not a
// measured one. See `docs/platforms/linkedin.md` and this plugin's
// `README.md` for the same caveat in the words a user reads.
import type { SiteConfig } from '../../../config/sites.js';
import { ToolError } from '../../../errors.js';
import { mimeFor } from '../../images/inspect.js';
import { bearerAuthHeader } from './auth.js';
import type { SiteTimezone } from '../schedule.js';
import type { HealthResult, PlatformAdapter, PostInput, PostResult } from '../types.js';

/**
 * A released LinkedIn API version, `YYYYMM`. UNVERIFIED — LinkedIn publishes
 * a new one roughly monthly and this is simply a plausible recent one, never
 * confirmed live; `api_version` on the site's own config overrides it. See
 * the header comment above for what UNVERIFIED means for this whole file.
 */
export const LINKEDIN_VERSION = '202509';

/** LinkedIn's own literal placeholder — see `plugin.ts`'s `credentialFields` help text. */
const AUTHOR_URN_ME = 'urn:li:person:me';

/**
 * Fields `PostInput` carries that a LinkedIn feed post has nowhere to put —
 * there is no article metadata surface on a feed post, only `commentary` and
 * (optionally) one attached article link. Mirrors WordPress's and the export
 * platforms' `UNSUPPORTED_FIELD_REASONS` mechanism: one warning per field
 * naming the reason, never a silent drop. `feature_image` is handled
 * separately below — it is not simply unsupported, it needs its companion
 * `feature_image_id` to do anything at all.
 */
const UNSUPPORTED_FIELD_REASONS: Record<string, string> = {
  slug: 'LinkedIn feed posts have no slug; nothing was sent.',
  meta_title: 'LinkedIn feed posts have no meta_title; nothing was sent.',
  meta_description: 'LinkedIn feed posts have no meta_description; nothing was sent.',
  og_title: 'LinkedIn feed posts have no og_title; nothing was sent.',
  og_description: 'LinkedIn feed posts have no og_description; nothing was sent.',
  og_image: 'LinkedIn feed posts have no og_image; nothing was sent.',
  twitter_title: 'LinkedIn feed posts have no twitter_title; nothing was sent.',
  twitter_description: 'LinkedIn feed posts have no twitter_description; nothing was sent.',
  twitter_image: 'LinkedIn feed posts have no twitter_image; nothing was sent.',
  codeinjection_head: 'LinkedIn feed posts have no codeinjection_head; nothing was sent.',
  categories: 'LinkedIn feed posts have no categories; nothing was sent.',
  newsletter: 'LinkedIn feed posts have no newsletter; nothing was sent.',
  email_segment: 'LinkedIn feed posts have no email_segment; nothing was sent.',
  feature_image_caption: 'LinkedIn feed posts have no feature_image_caption; nothing was sent.',
  feature_image_alt: 'LinkedIn feed posts have no feature_image_alt; nothing was sent.',
  authors: 'LinkedIn feed posts have no authors; nothing was sent.',
};

/** Common named/numeric HTML entities `toCommentary` needs to decode before a post reaches LinkedIn as plain text. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const codepoint =
        ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

/** "machine learning" -> "#MachineLearning". Non-alphanumeric characters are dropped, not replaced. */
function tagToHashtag(tag: string): string {
  const words = tag.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return `#${pascal}`;
}

/** The `initializeUpload` response shape LinkedIn is documented to return. UNVERIFIED. */
interface InitializeUploadResponse {
  value?: { uploadUrl?: string; image?: string };
}

/** LinkedIn's documented error body shape — `{ message }`. UNVERIFIED against a real error response. */
interface LinkedInErrorBody {
  message?: string;
}

/**
 * A LinkedIn feed post (`POST /rest/posts`) — one `commentary` string, one
 * optional attached article link. Byline never creates a LinkedIn draft
 * (`createPost` refuses anything but `status: 'published'`) and never
 * schedules one (`siteTimezone` throws): LinkedIn feed posts go live the
 * instant `createPost` is called, which is why `create_post`'s hand-off
 * wording tells the caller to swap `[[article_url]]` for the real URL
 * themselves before calling it.
 *
 * See the header comment at the top of this file: every request/response
 * shape below is UNVERIFIED until `tests/integration/linkedin.integration.test.ts`
 * has actually run against a live token.
 */
export class LinkedInAdapter implements PlatformAdapter {
  readonly slug: string;
  readonly platform = 'linkedin';
  private readonly base: string;
  private readonly accessToken: string;
  private readonly configuredAuthorUrn: string;
  private readonly apiVersion: string;

  /**
   * Resolves the literal `urn:li:person:me` placeholder to a real URN, from
   * `/v2/userinfo`'s `sub` — cached as a Promise (not just the resolved
   * value) so two calls racing before the first response lands still share
   * one in-flight request rather than firing two. Per adapter INSTANCE, per
   * the decision recorded in the Phase 5b brief — a fresh `LinkedInAdapter`
   * (a fresh tool call, in this codebase's `makeAdapter`) resolves again.
   */
  private meUrnPromise: Promise<string> | undefined;

  constructor(private readonly site: SiteConfig) {
    this.slug = site.slug;
    this.base = site.apiUrl;
    this.accessToken = site.credentials.access_token ?? '';
    this.configuredAuthorUrn = site.credentials.author_urn ?? '';
    this.apiVersion = site.credentials.api_version?.trim() || LINKEDIN_VERSION;
  }

  /**
   * LinkedIn's REST family (`/rest/...`) is documented to need `LinkedIn-Version`
   * and `X-Restli-Protocol-Version` on every call; the OpenID Connect endpoint
   * (`/v2/userinfo`) is a different surface and is not documented to need
   * either — both UNVERIFIED, so the distinction is made defensively rather
   * than sending headers that might be rejected on an endpoint that never
   * asked for them.
   */
  private headers(path: string, json: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: bearerAuthHeader(this.accessToken) };
    if (path.startsWith('rest/')) {
      headers['LinkedIn-Version'] = this.apiVersion;
      headers['X-Restli-Protocol-Version'] = '2.0.0';
    }
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return (await this.requestFull(path, init)).body;
  }

  private async requestFull(
    path: string,
    init: RequestInit = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    const url = `${this.base}/${path}`;
    const json = init.body !== undefined && typeof init.body === 'string';
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...this.headers(path, json), ...(init.headers ?? {}) },
      });
    } catch (e) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NETWORK',
        message: `Cannot reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`,
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
      const errBody = body as LinkedInErrorBody;
      const authFailure = res.status === 401 || res.status === 403;
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        status: res.status,
        code: authFailure ? 'UNAUTHORIZED' : 'LINKEDIN_ERROR',
        message: errBody.message ?? `LinkedIn returned ${res.status} for ${path}`,
        hint: authFailure
          ? `Check the access token for "${this.slug}" — it may have expired (LinkedIn tokens last about 60 days).`
          : 'Run health_check to test all configured APIs',
      });
    }
    return { body, headers: res.headers };
  }

  /**
   * `GET /v2/userinfo` — the OpenID Connect endpoint LinkedIn's `openid`/
   * `profile` scopes expose. Genuinely requires the bearer token: an
   * unauthenticated or expired token is documented to answer 401. See
   * `docs/ADDING-A-PLATFORM.md`'s rule on `healthCheck()` gating on an
   * endpoint that actually requires the credential — this is that endpoint
   * for LinkedIn, UNVERIFIED until probed live with a fabricated token
   * (`tests/integration/linkedin.integration.test.ts`).
   */
  async healthCheck(): Promise<HealthResult> {
    try {
      const body = (await this.request('v2/userinfo')) as { name?: string; sub?: string };
      return {
        slug: this.slug,
        platform: this.platform,
        ok: true,
        status: 200,
        detail: `Authenticated as ${body.name ?? 'unknown'} (${body.sub ?? 'unknown'})`,
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

  /** Resolves the configured `author_urn`, expanding the literal `me` placeholder via `/v2/userinfo`. */
  private async authorUrn(): Promise<string> {
    if (this.configuredAuthorUrn !== AUTHOR_URN_ME) return this.configuredAuthorUrn;
    if (!this.meUrnPromise) {
      this.meUrnPromise = (async () => {
        const body = (await this.request('v2/userinfo')) as { sub?: string };
        if (!body.sub) {
          throw new ToolError({
            api: `linkedin:${this.slug}`,
            code: 'NO_USERINFO_SUB',
            message: `LinkedIn's userinfo endpoint returned no "sub" to resolve "${AUTHOR_URN_ME}" against for "${this.slug}".`,
            hint: 'Set author_urn to a real urn:li:person:... or urn:li:organization:... instead of "me".',
          });
        }
        return `urn:li:person:${body.sub}`;
      })();
    }
    return this.meUrnPromise;
  }

  /**
   * `uploadImage`'s two-step (UNVERIFIED): `POST /rest/images?action=initializeUpload`
   * returns a one-time `uploadUrl` and the image's own URN; the bytes are then
   * `PUT` there directly (not through `requestFull` — `uploadUrl` is
   * documented as its own signed endpoint, not another `/rest/` call, so it
   * gets only `Authorization` and `Content-Type`, not the LinkedIn-Version /
   * X-Restli-Protocol-Version pair). LinkedIn exposes no public URL for an
   * uploaded image — `url` and `id` are both the image's own urn; see this
   * plugin's `README.md`.
   */
  async uploadImage(file: Buffer, filename: string, _alt?: string): Promise<{ url: string; id?: string }> {
    const author = await this.authorUrn();
    const init = (await this.request('rest/images?action=initializeUpload', {
      method: 'POST',
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    })) as InitializeUploadResponse;

    const uploadUrl = init.value?.uploadUrl;
    const imageUrn = init.value?.image;
    if (!uploadUrl || !imageUrn) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NO_UPLOAD_URL',
        message: 'LinkedIn accepted the initializeUpload request but returned no uploadUrl/image.',
      });
    }

    let putRes: Response;
    try {
      putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: bearerAuthHeader(this.accessToken),
          'Content-Type': mimeFor(filename),
        },
        body: new Uint8Array(file),
      });
    } catch (e) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NETWORK',
        message: `Cannot reach LinkedIn's upload URL: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (!putRes.ok) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        status: putRes.status,
        code: 'IMAGE_UPLOAD_FAILED',
        message: `LinkedIn rejected the image upload with ${putRes.status}`,
      });
    }

    return { url: imageUrn, id: imageUrn };
  }

  /** LinkedIn feed posts publish immediately — see `PlatformAdapter.siteTimezone`'s doc comment for why this is the right thing to throw rather than default. */
  async siteTimezone(): Promise<SiteTimezone> {
    throw new ToolError({
      api: `linkedin:${this.slug}`,
      code: 'NO_SITE_TIMEZONE',
      message: 'LinkedIn posts publish immediately; publish_at is not supported.',
    });
  }

  /** One warning per field the caller set that a LinkedIn feed post has nowhere to put — never a silent drop. */
  private unsupportedFieldWarnings(input: Partial<PostInput>): string[] {
    const warnings: string[] = [];
    for (const [field, reason] of Object.entries(UNSUPPORTED_FIELD_REASONS)) {
      const value = (input as Record<string, unknown>)[field];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        warnings.push(`${field}: ${reason}`);
      }
    }
    return warnings;
  }

  /**
   * HTML -> the plain-text `commentary` LinkedIn actually stores. Strips
   * every tag (`</p>` becomes a paragraph break first, so paragraphs
   * survive as blank lines), decodes entities, collapses 3+ blank lines
   * down to one, then appends the canonical URL (once, if not already
   * present) and hashtags built from `tags` — in that order, exactly as
   * specified in the Phase 5b brief.
   */
  private toCommentary(post: Pick<PostInput, 'html'> & Partial<Pick<PostInput, 'canonical_url' | 'tags'>>): string {
    let text = post.html.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<[^>]+>/g, '');
    text = decodeEntities(text);
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    if (post.canonical_url && !text.includes(post.canonical_url)) {
      text = `${text}\n\n${post.canonical_url}`;
    }
    if (post.tags && post.tags.length > 0) {
      text = `${text}\n\n${post.tags.map(tagToHashtag).join(' ')}`;
    }
    return text;
  }

  private assertPublishable(status: PostInput['status'] | undefined): void {
    if (status !== 'published') {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'DRAFTS_UNSUPPORTED',
        message: 'LinkedIn feed posts publish immediately. Byline does not create LinkedIn drafts.',
      });
    }
  }

  private assertResolved(html: string): void {
    if (html.includes('[[article_url]]')) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'UNRESOLVED_PLACEHOLDER',
        message: 'HTML still contains [[article_url]]',
        hint: 'Swap [[article_url]] for the published article URL before calling create_post — Byline does not do this substitution for you.',
      });
    }
  }

  private assertCommentaryLength(commentary: string): void {
    if (commentary.length > 3000) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'COMMENTARY_TOO_LONG',
        message: `Commentary is ${commentary.length} characters; LinkedIn's limit is 3000.`,
        hint: 'Shorten html (or the hashtags derived from tags) before posting.',
      });
    }
  }

  async createPost(post: PostInput): Promise<PostResult> {
    this.assertPublishable(post.status);
    this.assertResolved(post.html);

    const warnings = this.unsupportedFieldWarnings(post);
    if (post.feature_image !== undefined && post.feature_image_id === undefined) {
      warnings.push(
        "feature_image: LinkedIn needs the image URN from upload_image's id (feature_image_id); a URL alone cannot be attached.",
      );
    }

    const commentary = this.toCommentary(post);
    this.assertCommentaryLength(commentary);

    const author = await this.authorUrn();
    const body = {
      author,
      commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(post.canonical_url
        ? {
            content: {
              article: {
                source: post.canonical_url,
                title: post.title,
                ...(post.custom_excerpt ? { description: post.custom_excerpt } : {}),
                ...(post.feature_image_id ? { thumbnail: post.feature_image_id } : {}),
              },
            },
          }
        : {}),
    };

    const { headers } = await this.requestFull('rest/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const id = headers.get('x-restli-id');
    if (!id) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NO_POST',
        message: 'LinkedIn accepted the post but returned no x-restli-id header to identify it.',
      });
    }
    const url = `https://www.linkedin.com/feed/update/${id}/`;

    // Read back and compare — the same principle as every other adapter's
    // write-back diff: a 2xx response is not proof LinkedIn stored what was
    // sent. UNVERIFIED shape; a failed read-back becomes a warning, never a
    // failed publish — the post is already live.
    try {
      const readBack = (await this.request(`rest/posts/${encodeURIComponent(id)}`)) as { commentary?: string };
      if (readBack.commentary !== undefined && readBack.commentary !== commentary) {
        warnings.push('commentary: LinkedIn returned different text than was sent.');
      }
    } catch (e) {
      warnings.push(
        `commentary: could not verify — reading the post back failed (${e instanceof Error ? e.message : String(e)}).`,
      );
    }

    return {
      id,
      url,
      status: 'published',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Patches `commentary` only — UNVERIFIED, implemented from LinkedIn's
   * documented partial-update shape (`{ patch: { $set: { ... } } }`) and
   * never confirmed against a live post. Every other field is either
   * unsupported (same warnings as `createPost`) or simply not resendable
   * through this endpoint per the brief, so `patch.html` is the only thing
   * that actually changes anything here.
   */
  async updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult> {
    if (patch.status !== undefined) this.assertPublishable(patch.status);
    const warnings = this.unsupportedFieldWarnings(patch);
    if (patch.feature_image !== undefined && patch.feature_image_id === undefined) {
      warnings.push(
        "feature_image: LinkedIn needs the image URN from upload_image's id (feature_image_id); a URL alone cannot be attached.",
      );
    }

    if (patch.html === undefined) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NOTHING_TO_UPDATE',
        message: 'update_post on a LinkedIn site only patches the commentary text — pass html.',
      });
    }
    this.assertResolved(patch.html);
    const commentary = this.toCommentary({ html: patch.html, canonical_url: patch.canonical_url, tags: patch.tags });
    this.assertCommentaryLength(commentary);

    await this.request(`rest/posts/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ patch: { $set: { commentary } } }),
    });

    return {
      id,
      url: `https://www.linkedin.com/feed/update/${id}/`,
      status: 'published',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** LinkedIn feed posts have no tag list of their own — hashtags live inside `commentary`, not as a separate taxonomy. */
  async listTags(): Promise<Array<{ id: string; name: string; slug: string }>> {
    return [];
  }

  /**
   * The authenticated person, plus (best-effort) any organisation this token
   * administers — `GET /rest/organizationAcls?...` per the brief. UNVERIFIED
   * shape for both calls. The organisation lookup failing does not fail the
   * whole call: a personal-only token with no `r_organization_admin`-class
   * access is expected to have nothing there, and this degrades to the
   * person alone. Unlike `listAuthors`, this can say so: a failed org lookup
   * becomes one warning naming the endpoint and the HTTP status (or error
   * message when there is no status), never a silently dropped result — see
   * `PlatformAdapter.listAuthorsDetailed`'s doc comment for why this exists
   * as a separate method rather than changing `listAuthors`'s shape.
   */
  async listAuthorsDetailed(): Promise<{
    authors: Array<{ id: string; name: string; email?: string }>;
    warnings: string[];
  }> {
    const info = (await this.request('v2/userinfo')) as { sub?: string; name?: string };
    if (!info.sub) {
      throw new ToolError({
        api: `linkedin:${this.slug}`,
        code: 'NO_USERINFO_SUB',
        message: `LinkedIn's userinfo endpoint returned no "sub" for "${this.slug}".`,
      });
    }
    const authors: Array<{ id: string; name: string }> = [
      { id: `urn:li:person:${info.sub}`, name: info.name ?? 'You' },
    ];
    const warnings: string[] = [];

    try {
      const orgs = (await this.request(
        'rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(localizedName)))',
      )) as { elements?: Array<{ organization?: string; 'organization~'?: { localizedName?: string } }> };
      for (const el of orgs.elements ?? []) {
        if (el.organization) {
          authors.push({ id: el.organization, name: el['organization~']?.localizedName ?? el.organization });
        }
      }
    } catch (e) {
      const err = e instanceof ToolError ? e : undefined;
      const isAuthFailure = err?.status === 401 || err?.status === 403;
      const detail = err?.status !== undefined ? String(err.status) : e instanceof Error ? e.message : String(e);
      const reason = isAuthFailure
        ? ' — organisation URNs need Community Management API approval'
        : '';
      warnings.push(
        `organisations: GET /rest/organizationAcls failed (${detail})${reason}; person URN listed only.`,
      );
    }

    return { authors, warnings };
  }

  /** Delegates to `listAuthorsDetailed`, dropping the (non-fatal) warnings — see that method for why they exist. */
  async listAuthors(): Promise<Array<{ id: string; name: string; email?: string }>> {
    return (await this.listAuthorsDetailed()).authors;
  }
}
