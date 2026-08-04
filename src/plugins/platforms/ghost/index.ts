import type { SiteConfig } from '../../../config/sites.js';
import { ToolError } from '../../../errors.js';
import { ghostToken } from './auth.js';
import {
  assertScheduleApplied,
  normaliseStoredTime,
  publishTimeWarning,
  type SiteTimezone,
} from '../schedule.js';
import type { HealthResult, PlatformAdapter, PostInput, PostResult } from '../types.js';

interface GhostErrorBody {
  errors?: Array<{ message?: string; context?: string }>;
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

/** Ghost validates the uploaded part's MIME type, so it has to be set explicitly. */
export function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[ext] ?? 'application/octet-stream';
}

export class GhostAdapter implements PlatformAdapter {
  readonly slug: string;
  readonly platform = 'ghost';
  private readonly base: string;

  constructor(private readonly site: SiteConfig) {
    this.slug = site.slug;
    this.base = site.apiUrl;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Ghost ${ghostToken(this.site.credentials.admin_api_key ?? '', this.slug)}`,
      'Accept-Version': 'v6.0',
    };
    // Multipart requests must NOT set Content-Type — fetch adds the boundary.
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request(path: string, init: RequestInit = {}, json = true): Promise<unknown> {
    return (await this.requestFull(path, init, json)).body;
  }

  /**
   * As `request`, but also hands back Ghost's `Date` response header.
   *
   * Only the post-writing paths need it, and only to diagnose a scheduling
   * result: if Ghost stores a different publish time than was sent, the useful
   * question is what Ghost's own clock said at that moment, and the answer has
   * to come from the same response rather than from a second call made later.
   * `request` stays the shape every other call site already uses.
   */
  private async requestFull(
    path: string,
    init: RequestInit = {},
    json = true,
  ): Promise<{ body: unknown; serverDate: string | null }> {
    const url = `${this.base}/${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...this.headers(json), ...(init.headers ?? {}) },
      });
    } catch (e) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
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
      const first = (body as GhostErrorBody).errors?.[0];
      throw new ToolError({
        api: `ghost:${this.slug}`,
        status: res.status,
        code: res.status === 401 ? 'UNAUTHORIZED' : 'GHOST_ERROR',
        message:
          first?.message ??
          (res.status === 401
            ? `Ghost rejected the JWT for "${this.slug}"`
            : `Ghost returned ${res.status} for ${path}`),
        // `context` carries Ghost's actual reason on a 422 while `message` is
        // the generic "Validation error, cannot save post." — measured
        // 2026-08-03, where the two scheduling refusals ("Value in
        // published_at cannot be blank.", "Date must be at least -2 minutes in
        // the future.") appear ONLY in `context`. Without it a caller sees a
        // validation failure with nothing naming the field.
        hint:
          res.status === 401
            ? `Check the admin key for "${this.slug}" is the Admin API Key in id:secret form`
            : (first?.context ?? 'Run health_check to test all configured APIs'),
      });
    }
    return { body, serverDate: res.headers.get('date') };
  }

  /**
   * `GET /site/` requires no auth at all — a fabricated key gets the real
   * site title back with a 200 (verified against a real Ghost install,
   * 2026-07-29; see docs/GHOST-NOTES.md). `GET /config/` does require the
   * signed Admin JWT: the same fabricated key gets a genuine 401 "Unknown
   * Admin API Key" from Ghost itself. `config/` is checked first so a bad
   * key is caught before anything unauthenticated runs.
   */
  async healthCheck(): Promise<HealthResult> {
    try {
      const configBody = (await this.request('config/')) as {
        config?: { version?: string };
      };
      const version = configBody.config?.version ?? '?';

      // Best-effort only, and only reached once auth above has already
      // succeeded: `/site/` needs no auth, so it can add the friendly site
      // title to the detail string but can never turn a bad key into `ok: true`.
      let title = 'unknown';
      try {
        const siteBody = (await this.request('site/')) as { site?: { title?: string } };
        if (siteBody.site?.title) title = siteBody.site.title;
      } catch {
        // version from /config/ alone is still an informative success detail
      }

      return {
        slug: this.slug,
        platform: this.platform,
        ok: true,
        status: 200,
        detail: `${title} (Ghost ${version})`,
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
   * Ghost's `images/upload/` response is documented as `{ images: [{ url }] }`
   * only — no id. `id` is read defensively in case a future or self-hosted
   * Ghost version does carry one, but is never assumed present: Ghost's own
   * `createPost`/`updatePost` only ever take `feature_image` as a URL, so
   * there is nothing on this platform that needs it the way WordPress needs
   * an attachment id for `featured_media`.
   */
  async uploadImage(file: Buffer, filename: string, alt?: string): Promise<{ url: string; id?: string }> {
    const form = new FormData();
    // The Blob MUST carry a MIME type. Without it the part is sent as
    // application/octet-stream and Ghost rejects the upload with 415
    // "Please select a valid image."
    form.set('file', new Blob([new Uint8Array(file)], { type: mimeFor(filename) }), filename);
    form.set('purpose', 'image');
    if (alt) form.set('ref', alt);

    const body = (await this.request('images/upload/', { method: 'POST', body: form }, false)) as {
      images?: Array<{ url?: string; id?: string | number }>;
    };
    const image = body.images?.[0];
    const url = image?.url;
    if (!url) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_IMAGE_URL',
        message: 'Ghost accepted the upload but returned no image URL',
      });
    }
    return { url, ...(image?.id !== undefined ? { id: String(image.id) } : {}) };
  }

  /**
   * The blog's timezone, from `GET /settings/`.
   *
   * Measured 2026-08-03: `settings` is a flat array of `{ key, value }` pairs
   * (113 of them on the probed install), and `timezone` holds an IANA zone
   * name — `"Asia/Kolkata"` on one probed blog, `"Asia/Dubai"` on another.
   * Always an IANA name, never a numeric offset, which is what lets daylight
   * saving be resolved per instant rather than sampled once.
   *
   * Throws rather than falling back to UTC — see `PlatformAdapter.siteTimezone`.
   */
  async siteTimezone(): Promise<SiteTimezone> {
    const body = (await this.request('settings/')) as {
      settings?: Array<{ key?: string; value?: unknown }>;
    };
    const zone = body.settings?.find((s) => s.key === 'timezone')?.value;
    if (typeof zone !== 'string' || zone.trim() === '') {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_SITE_TIMEZONE',
        message: `Ghost returned no timezone setting for "${this.slug}".`,
        hint: 'Set the site timezone in Ghost (Settings → General → Publication language & timezone), or pass publish_at with an explicit offset.',
      });
    }
    return { kind: 'iana', zone: zone.trim() };
  }

  /**
   * Ghost wants tags and authors as objects, and rejects explicit nulls.
   *
   * `feature_image_id` is dropped here rather than sent: it exists only for
   * WordPress's `featured_media`, Ghost has no field for it, and Ghost
   * rejects unknown fields silently rather than erroring — sending it would
   * do nothing except risk `droppedFields` below misreporting it as
   * discarded content.
   *
   * `publish_at` is renamed to Ghost's own `published_at`. That rename is
   * explicit, and has to be: this loop copies every key it does not recognise
   * straight through, which is precisely how the field used to reach Ghost
   * back when `PostInput` called it `published_at` too — forwarded by
   * coincidence rather than by decision, unmentioned in any adapter, and
   * simultaneously reported as unsupported by the WordPress one.
   */
  private toGhostPost(post: Partial<PostInput>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(post)) {
      if (v === undefined || k === 'feature_image_id') continue;
      if (k === 'tags') out.tags = (v as string[]).map((name) => ({ name }));
      else if (k === 'authors') out.authors = (v as string[]).map((id) => ({ id }));
      // Ghost's status vocabulary already contains `scheduled`, so
      // `PostStatus` maps onto it one-for-one and needs no translation table.
      else if (k === 'publish_at') out.published_at = v;
      else out[k] = v;
    }
    return out;
  }

  /**
   * Everything a written post needs checked after the fact, in one place so
   * `createPost` and `updatePost` cannot verify it differently.
   *
   * `serverDate` is Ghost's own clock at the moment it handled the write —
   * only consulted when something went wrong, and only so the resulting error
   * names a real reading instead of speculating about whose clock was off.
   */
  private verifyWrite(
    sent: Partial<PostInput>,
    returned: Record<string, unknown>,
    serverDate: string | null,
  ): string[] {
    const warnings: string[] = [];
    const dropped = this.droppedFields(sent, returned);
    if (dropped.length > 0) {
      warnings.push(
        `Ghost discarded these fields: ${dropped.join(', ')}. Check the field names against the Ghost Admin API.`,
      );
    }

    if (sent.publish_at !== undefined) {
      const storedAt = returned.published_at;
      if (sent.status === 'scheduled') {
        assertScheduleApplied({
          api: `ghost:${this.slug}`,
          platform: 'Ghost',
          scheduledToken: 'scheduled',
          requestedIso: sent.publish_at,
          returnedStatus: String(returned.status),
          id: String(returned.id),
          url: String(returned.url),
          serverDate,
        });
      }
      const timeWarning = publishTimeWarning(
        sent.publish_at,
        typeof storedAt === 'string' ? storedAt : null,
        'Ghost',
      );
      if (timeWarning) warnings.push(timeWarning);
    }
    return warnings;
  }

  /**
   * The `publish_at` fragment of a `PostResult`, present only when a publish
   * time was asked for and Ghost echoed a readable one back.
   *
   * Routed through the shared `normaliseStoredTime` rather than passing
   * Ghost's own string through, so that the same instant reports identically
   * whether it came from Ghost or from WordPress — the two platforms echo it
   * in different shapes.
   */
  private storedPublishAt(
    sent: Partial<PostInput>,
    returned: Record<string, unknown>,
  ): { publish_at?: string } {
    if (sent.publish_at === undefined) return {};
    const raw = returned.published_at;
    const stored = normaliseStoredTime(typeof raw === 'string' ? raw : null);
    return stored === null ? {} : { publish_at: stored };
  }

  private assertResolved(html: string | undefined): void {
    if (html?.includes('[[content_image]]')) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'UNRESOLVED_PLACEHOLDER',
        message: 'HTML still contains [[content_image]]',
        hint: 'Replace the placeholder with the <figure> markup before publishing',
      });
    }
  }

  /**
   * Report any field the caller set that Ghost returned empty.
   *
   * Ghost silently ignores unknown or read-only fields — passing `excerpt`
   * instead of `custom_excerpt` returned 201 with the value discarded. Comparing
   * the request against the response turns that class of silent failure into a
   * visible warning.
   */
  private droppedFields(
    sent: Partial<PostInput>,
    returned: Record<string, unknown>,
  ): string[] {
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(sent)) {
      // 'feature_image_id' is never sent to Ghost (see toGhostPost) — checking
      // it here would always find it "missing" from the response and
      // misreport a field Ghost was never asked to store.
      //
      // 'publish_at' is sent, but under Ghost's name (`published_at`), so this
      // loop's `returned[key]` lookup would find nothing and report a field
      // Ghost stored correctly as discarded. It is verified by value instead —
      // see `verifyWrite`, which compares the stored instant against the one
      // that was sent rather than merely checking the key came back non-empty.
      if (
        value === undefined ||
        key === 'html' ||
        key === 'tags' ||
        key === 'authors' ||
        key === 'feature_image_id' ||
        key === 'publish_at'
      )
        continue;
      const back = returned[key];
      if (back === null || back === undefined || back === '') {
        dropped.push(key);
      }
    }
    return dropped;
  }

  /**
   * Keep the social card pointing at the hero when the hero changes.
   *
   * `create_post` DEFAULTS `og_image` and `twitter_image` to `feature_image`
   * (see post-tools.ts). Change the hero later with `update_post` and those two
   * keep the old URL, so the article shows the new picture while every share on
   * LinkedIn, X and WhatsApp shows the previous one. Measured on four live
   * posts: the in-article images were all distinct and all four social cards
   * still pointed at one shared image.
   *
   * The rule is deliberately narrow. A social image is only carried forward
   * when it currently EQUALS the outgoing hero — which is exactly the state
   * `create_post`'s defaulting produces. If it differs, somebody chose it on
   * purpose, and silently overwriting a deliberate choice would be a worse bug
   * than the one being fixed; that case warns instead. An explicit `og_image`
   * in the patch always wins and is left alone.
   *
   * Ghost-only by design: WordPress core has no Open Graph fields at all and
   * reports them as unsupported (`UNSUPPORTED_FIELD_REASONS`).
   */
  private carrySocialImages(
    patch: Partial<PostInput>,
    before: { feature_image?: string | null; og_image?: string | null; twitter_image?: string | null },
  ): string[] {
    const hero = patch.feature_image;
    if (hero === undefined || hero === before.feature_image) return [];

    const warnings: string[] = [];
    const fields = [
      ['og_image', before.og_image] as const,
      ['twitter_image', before.twitter_image] as const,
    ];
    for (const [field, existing] of fields) {
      if (patch[field] !== undefined) continue; // the caller decided; leave it.
      if (existing && existing === before.feature_image) {
        (patch as Record<string, unknown>)[field] = hero;
      } else if (existing) {
        warnings.push(
          `${field}: left unchanged at ${existing}, because it was set to something other than the previous feature image and is therefore a deliberate choice. The social card will not match the new hero image — pass ${field} explicitly if it should.`,
        );
      }
    }
    return warnings;
  }

  async createPost(post: PostInput): Promise<PostResult> {
    this.assertResolved(post.html);
    const { body: raw, serverDate } = await this.requestFull('posts/?source=html', {
      method: 'POST',
      body: JSON.stringify({ posts: [this.toGhostPost(post)] }),
    });
    const body = raw as { posts?: Array<Record<string, unknown>> };
    const created = body.posts?.[0];
    if (!created) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: 'Ghost returned no post object',
      });
    }
    const warnings = this.verifyWrite(post, created, serverDate);
    return {
      id: String(created.id),
      url: String(created.url),
      status: String(created.status),
      ...this.storedPublishAt(post, created),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult> {
    this.assertResolved(patch.html);
    // The social image fields are fetched alongside `updated_at` rather than in
    // a second request: this GET already has to happen for the optimistic
    // concurrency check, so carrying three more field names on it is free.
    const current = (await this.request(
      `posts/${id}/?fields=id,updated_at,feature_image,og_image,twitter_image`,
    )) as {
      posts?: Array<{
        updated_at?: string;
        feature_image?: string | null;
        og_image?: string | null;
        twitter_image?: string | null;
      }>;
    };
    const before = current.posts?.[0];
    const updatedAt = before?.updated_at;
    if (!updatedAt) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: `No post ${id} on site "${this.slug}"`,
      });
    }

    const socialWarnings = this.carrySocialImages(patch, before ?? {});

    const { body: raw, serverDate } = await this.requestFull(`posts/${id}/?source=html`, {
      method: 'PUT',
      body: JSON.stringify({ posts: [{ ...this.toGhostPost(patch), updated_at: updatedAt }] }),
    });
    const body = raw as { posts?: Array<Record<string, unknown>> };
    const updated = body.posts?.[0];
    if (!updated) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: 'Ghost returned no post object after update',
      });
    }
    const warnings = [...socialWarnings, ...this.verifyWrite(patch, updated, serverDate)];
    return {
      id: String(updated.id),
      url: String(updated.url),
      status: String(updated.status),
      ...this.storedPublishAt(patch, updated),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async listTags(): Promise<Array<{ id: string; name: string; slug: string }>> {
    const body = (await this.request('tags/?limit=all')) as {
      tags?: Array<{ id: string; name: string; slug: string }>;
    };
    return (body.tags ?? []).map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
  }

  /** `/users/me/` returns 404 for an integration — an integration is not a user. */
  async listAuthors(): Promise<Array<{ id: string; name: string; email?: string }>> {
    const body = (await this.request('users/?limit=all')) as {
      users?: Array<{ id: string; name: string; email?: string }>;
    };
    return (body.users ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      ...(u.email ? { email: u.email } : {}),
    }));
  }
}
