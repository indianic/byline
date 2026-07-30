import type { SiteConfig } from '../../../config/sites.js';
import { ToolError } from '../../../errors.js';
import { ghostToken } from './auth.js';
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
        hint:
          res.status === 401
            ? `Check the admin key for "${this.slug}" is the Admin API Key in id:secret form`
            : 'Run health_check to test all configured APIs',
      });
    }
    return body;
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
   * Ghost wants tags and authors as objects, and rejects explicit nulls.
   *
   * `feature_image_id` is dropped here rather than sent: it exists only for
   * WordPress's `featured_media`, Ghost has no field for it, and Ghost
   * rejects unknown fields silently rather than erroring — sending it would
   * do nothing except risk `droppedFields` below misreporting it as
   * discarded content.
   */
  private toGhostPost(post: Partial<PostInput>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(post)) {
      if (v === undefined || k === 'feature_image_id') continue;
      if (k === 'tags') out.tags = (v as string[]).map((name) => ({ name }));
      else if (k === 'authors') out.authors = (v as string[]).map((id) => ({ id }));
      else out[k] = v;
    }
    return out;
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
      if (
        value === undefined ||
        key === 'html' ||
        key === 'tags' ||
        key === 'authors' ||
        key === 'feature_image_id'
      )
        continue;
      const back = returned[key];
      if (back === null || back === undefined || back === '') {
        dropped.push(key);
      }
    }
    return dropped;
  }

  async createPost(post: PostInput): Promise<PostResult> {
    this.assertResolved(post.html);
    const body = (await this.request('posts/?source=html', {
      method: 'POST',
      body: JSON.stringify({ posts: [this.toGhostPost(post)] }),
    })) as { posts?: Array<Record<string, unknown>> };
    const created = body.posts?.[0];
    if (!created) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: 'Ghost returned no post object',
      });
    }
    const dropped = this.droppedFields(post, created);
    return {
      id: String(created.id),
      url: String(created.url),
      status: String(created.status),
      ...(dropped.length > 0
        ? {
            warnings: [
              `Ghost discarded these fields: ${dropped.join(', ')}. Check the field names against the Ghost Admin API.`,
            ],
          }
        : {}),
    };
  }

  async updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult> {
    this.assertResolved(patch.html);
    const current = (await this.request(`posts/${id}/?fields=id,updated_at`)) as {
      posts?: Array<{ updated_at?: string }>;
    };
    const updatedAt = current.posts?.[0]?.updated_at;
    if (!updatedAt) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: `No post ${id} on site "${this.slug}"`,
      });
    }

    const body = (await this.request(`posts/${id}/?source=html`, {
      method: 'PUT',
      body: JSON.stringify({ posts: [{ ...this.toGhostPost(patch), updated_at: updatedAt }] }),
    })) as { posts?: Array<Record<string, unknown>> };
    const updated = body.posts?.[0];
    if (!updated) {
      throw new ToolError({
        api: `ghost:${this.slug}`,
        code: 'NO_POST',
        message: 'Ghost returned no post object after update',
      });
    }
    const dropped = this.droppedFields(patch, updated);
    return {
      id: String(updated.id),
      url: String(updated.url),
      status: String(updated.status),
      ...(dropped.length > 0
        ? {
            warnings: [
              `Ghost discarded these fields: ${dropped.join(', ')}. Check the field names against the Ghost Admin API.`,
            ],
          }
        : {}),
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
