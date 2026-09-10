import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SiteConfig } from '../../../config/sites.js';
import { ToolError } from '../../../errors.js';
import { expandPath } from '../../../media/library.js';
import type { SiteTimezone } from '../schedule.js';
import type { HealthResult, PlatformAdapter, PostInput, PostResult } from '../types.js';
import { renderHandoffPage, type HandoffInput } from './handoff-page.js';
import { htmlToMarkdown } from './markdown.js';
import type { ExportSpec } from './types.js';

/**
 * Fields `PostInput` carries that no export platform has anywhere to put —
 * there is no API to send them to, only a folder on disk. Mirrors Ghost's and
 * WordPress's `UNSUPPORTED_FIELD_REASONS` mechanism: one warning per field
 * naming the reason, never a silent drop.
 */
const UNSUPPORTED_FIELD_REASONS: Record<string, string> = {
  codeinjection_head: 'has no head-injection field; nothing was sent.',
  og_title: 'has no Open Graph fields; nothing was sent.',
  og_description: 'has no Open Graph fields; nothing was sent.',
  og_image: 'has no Open Graph fields; nothing was sent.',
  twitter_title: 'has no Twitter Card fields; nothing was sent.',
  twitter_description: 'has no Twitter Card fields; nothing was sent.',
  twitter_image: 'has no Twitter Card fields; nothing was sent.',
  feature_image_id: 'has no native media id — this is a plain file export, not an API upload.',
  newsletter: 'has no newsletter.',
  email_segment: 'has no newsletter.',
  authors: 'assigns authorship in its own editor, not through this export.',
};

/** Lowercase, hyphenated, ASCII-safe — used only to NAME the export folder. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * What every export writes to `meta.json`, so a later `updatePost` can read
 * back what it does not receive again in the patch. Carries `feature_image`
 * (the already-moved `images/<file>` reference, or whatever hosted URL was
 * passed in) and `feature_image_alt` so `updatePost` can re-list the hero on
 * the hand-off page without the caller re-sending it on every patch.
 */
interface StoredMeta {
  title: string;
  slug?: string;
  custom_excerpt?: string;
  meta_title?: string;
  meta_description?: string;
  tags?: string[];
  categories?: string[];
  canonical_url?: string;
  feature_image?: string;
  feature_image_alt?: string;
  status: string;
  exported_at: string;
}

interface WritableExport {
  title: string;
  html: string;
  status: string;
  slug?: string;
  custom_excerpt?: string;
  meta_title?: string;
  meta_description?: string;
  tags?: string[];
  categories?: string[];
  canonical_url?: string;
  feature_image?: string;
  feature_image_alt?: string;
}

/**
 * Publishes to a folder on disk instead of an API — Medium, Substack, and
 * LinkedIn Article all have no publishing API to call, so `create_post`
 * writes a hand-off folder (`article.html`, `article.md`, `meta.json`,
 * `index.html`, `images/`) that a human pastes into the platform's own
 * editor by hand. See `docs/ADDING-A-PLATFORM.md`'s checklist — this adapter
 * is the export-platform adaptation of it referenced from the task brief.
 */
export class ExportAdapter implements PlatformAdapter {
  readonly slug: string;
  readonly platform: string;

  constructor(
    private readonly site: SiteConfig,
    private readonly spec: ExportSpec,
  ) {
    this.slug = site.slug;
    this.platform = spec.platformId;
  }

  /**
   * `<export_dir>/<site-slug>`. Throws rather than silently falling back to
   * `process.cwd()` when `export_dir` is empty — the exact trap
   * `loadMedia`'s `path`/`index_path` handling already guards against for a
   * media library, and the same failure mode here would write an export into
   * wherever the MCP host happened to launch from.
   */
  private root(): string {
    const raw = this.site.credentials.export_dir ?? '';
    if (!raw.trim()) {
      throw new ToolError({
        api: `${this.platform}:${this.slug}`,
        code: 'EXPORT_DIR_MISSING',
        message: `Site "${this.slug}" has no export_dir configured.`,
        hint: 'Add export_dir to this site\'s block in config.yaml, e.g. "~/Documents/byline-post".',
      });
    }
    return join(expandPath(raw, process.env), this.site.slug);
  }

  /**
   * Verifies the export folder is writable — nothing else. There is no
   * credential to check: an export platform authenticates the human, not
   * Byline, so `ok: true` here says only that Byline can write to disk.
   */
  async healthCheck(): Promise<HealthResult> {
    let root: string;
    try {
      root = this.root();
    } catch (e) {
      return {
        slug: this.slug,
        platform: this.platform,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    try {
      await mkdir(root, { recursive: true });
      const probe = join(root, '.byline-write-test');
      await writeFile(probe, '');
      await rm(probe);
      return {
        slug: this.slug,
        platform: this.platform,
        ok: true,
        detail: `Folder writable: ${root}. No credential is involved — this checks only that Byline can write here.`,
      };
    } catch (e) {
      return {
        slug: this.slug,
        platform: this.platform,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Writes the file into `<root>/_inbox/<sha256-8>-<safe-filename>` and
   * returns a `file://` URL. `createPost`/`updatePost` later move whichever
   * of these are actually referenced into the post's own `images/` folder —
   * until then they sit in `_inbox` because `uploadImage` runs before the
   * post's folder (which needs the title) exists.
   *
   * `filename` is caller-supplied (an MCP tool argument) and untrusted:
   * `basename()` strips any directory component (so `../../evil.png` cannot
   * walk out of `_inbox`), and every character outside a safe allowlist is
   * replaced. A filename that is empty or only dots after that — `.`, `..`,
   * `...` — is refused outright rather than silently producing a hidden or
   * meaningless file.
   */
  async uploadImage(file: Buffer, filename: string, _alt?: string): Promise<{ url: string; id?: string }> {
    const safe = basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!safe || /^\.+$/.test(safe)) {
      throw new ToolError({
        api: `${this.platform}:${this.slug}`,
        code: 'INVALID_FILENAME',
        message: `Refusing to upload image with filename "${filename}" — it has no usable name.`,
        hint: 'Pass a filename with at least one non-dot, non-slash character, e.g. "photo.jpg".',
      });
    }
    const hash = createHash('sha256').update(file).digest('hex').slice(0, 8);
    const inbox = join(this.root(), '_inbox');
    await mkdir(inbox, { recursive: true });
    const dest = this.confine(inbox, join(inbox, `${hash}-${safe}`), 'Uploaded image destination');
    await writeFile(dest, file);
    return { url: `file://${dest}`, id: dest };
  }

  /** An export platform has no clock Byline can read — see `PlatformAdapter.siteTimezone`'s doc comment. */
  async siteTimezone(): Promise<SiteTimezone> {
    throw new ToolError({
      api: `${this.platform}:${this.slug}`,
      code: 'NO_SITE_TIMEZONE',
      message: `${this.spec.label} has no clock for Byline to read.`,
      hint: `${this.spec.label} has no clock. publish_at is not supported; schedule inside ${this.spec.label}'s editor.`,
    });
  }

  private assertResolved(html: string | undefined): void {
    if (html?.includes('[[content_image]]')) {
      throw new ToolError({
        api: `${this.platform}:${this.slug}`,
        code: 'UNRESOLVED_PLACEHOLDER',
        message: 'HTML still contains [[content_image]]',
        hint: 'Replace the placeholder with the <figure> markup before publishing',
      });
    }
  }

  private refuseScheduling(status: string | undefined): void {
    if (status !== 'scheduled') return;
    throw new ToolError({
      api: `${this.platform}:${this.slug}`,
      code: 'SCHEDULING_UNSUPPORTED',
      message: `${this.spec.label} cannot be scheduled through Byline — it has no publishing API.`,
      hint: `Export as a draft and schedule the post inside ${this.spec.label}'s own editor.`,
    });
  }

  private unsupportedFieldWarnings(input: Partial<PostInput>): string[] {
    const warnings: string[] = [];
    for (const [field, reason] of Object.entries(UNSUPPORTED_FIELD_REASONS)) {
      const value = (input as Record<string, unknown>)[field];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        warnings.push(`${field}: ${this.spec.label} ${reason}`);
      }
    }
    if (input.slug !== undefined) {
      warnings.push(`slug: used to name the export folder; ${this.spec.label} assigns its own URL`);
    }
    return warnings;
  }

  /**
   * Resolve `candidate` and refuse it unless it is `base` itself or a
   * descendant of `base`. The one path-containment check used everywhere
   * this adapter turns caller-supplied input into a filesystem path — the
   * article folder, `updatePost`'s id, `uploadImage`'s destination, and the
   * inbox move below all go through this.
   *
   * This is a LEXICAL check (`resolve`, not `realpath`): it reasons about the
   * path string, never the bytes actually on disk. A symlink already sitting
   * inside `_inbox` pointing outside `base` would resolve its containing
   * path as confined and is not detected. Nothing Byline itself ever writes
   * is a symlink, and planting one here first needs write access to the
   * user's own home directory — at which point confine() is no longer the
   * layer doing the protecting.
   */
  private confine(base: string, candidate: string, what: string): string {
    const root = resolve(base);
    const target = resolve(candidate);
    const rel = relative(root, target);
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) return target;
    throw new ToolError({
      api: `${this.platform}:${this.slug}`,
      code: 'PATH_OUTSIDE_EXPORT_DIR',
      message: `${what} resolves outside the export folder ${root}: ${target}`,
      hint: 'Byline only writes inside the configured export_dir.',
    });
  }

  /**
   * Whether `url` *claims* to be a `file://` path under this site's
   * `_inbox` — a cheap, unresolved prefix check, deliberately not the
   * security boundary. Two outcomes follow from it:
   *
   * - `false`: an image outside `_inbox` entirely (a hosted URL, or a
   *   `file://` path elsewhere on disk) is legitimate and deliberately left
   *   alone — nobody calls `moveOne` on it, and it survives in the HTML
   *   unchanged.
   * - `true`: `moveOne` is then given the chance to act on it, and it is
   *   `moveOne` — via `confine` — that actually resolves the path and
   *   throws `PATH_OUTSIDE_EXPORT_DIR` if a `..` segment makes it walk back
   *   out of `_inbox` (e.g. `_inbox/../../../../secret.txt`, which starts
   *   with the right prefix as a raw string but resolves elsewhere). That
   *   split — a permissive gate here, the actual containment check at the
   *   one place that touches the filesystem — is what turns "an arbitrary
   *   readable file gets moved into the bundle" into a loud, refused error
   *   instead of a silent skip.
   */
  private isOwnInboxFile(url: string | undefined): url is string {
    if (!url || !url.startsWith('file://')) return false;
    const path = url.slice('file://'.length);
    return path === join(this.root(), '_inbox') || path.startsWith(`${join(this.root(), '_inbox')}${sep}`);
  }

  /**
   * Moves every `file://.../_inbox/<file>` image this adapter wrote —
   * referenced by `feature_image` or by an `<img src="file://...">` inside
   * the article HTML — into `<folder>/images/`, and rewrites every such
   * reference in the returned HTML to the relative path `images/<file>` the
   * file now lives at. Returns the image list the hand-off page's download
   * links and insertion markers are built from.
   */
  private async collectAndMoveImages(
    folder: string,
    html: string,
    featureImage: string | undefined,
    featureImageAlt: string | undefined,
  ): Promise<{
    html: string;
    images: Array<{ file: string; alt: string; role: 'hero' | 'inline' }>;
    featureImage: string | undefined;
  }> {
    const imagesDir = join(folder, 'images');
    const inbox = join(this.root(), '_inbox');
    const moved = new Map<string, string>();
    const images: Array<{ file: string; alt: string; role: 'hero' | 'inline' }> = [];

    // `isOwnInboxFile` already confined every path passed here, but `moveOne`
    // re-confines to `_inbox` itself before touching the filesystem — the
    // same defense-in-depth as `updatePost`'s belt-and-braces re-check, so a
    // future caller of this private helper cannot reintroduce the escape by
    // skipping the `isOwnInboxFile` gate.
    const moveOne = async (fileUrl: string): Promise<string> => {
      const absPath = this.confine(inbox, fileUrl.slice('file://'.length), 'Inbox image');
      const cached = moved.get(absPath);
      if (cached) return cached;
      await mkdir(imagesDir, { recursive: true });
      const file = basename(absPath);
      await rename(absPath, join(imagesDir, file));
      const rel = `images/${file}`;
      moved.set(absPath, rel);
      return rel;
    };

    let heroRel: string | undefined;
    if (this.isOwnInboxFile(featureImage)) {
      heroRel = await moveOne(featureImage);
      images.push({ file: basename(heroRel), alt: featureImageAlt ?? '', role: 'hero' });
    }

    let rewrittenHtml = html;
    for (const tagMatch of html.matchAll(/<img\b[^>]*>/gi)) {
      const tagStr = tagMatch[0];
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tagStr)?.[1];
      if (!src || !this.isOwnInboxFile(src)) continue;
      const rel = await moveOne(src);
      const newTag = tagStr.split(src).join(rel);
      rewrittenHtml = rewrittenHtml.split(tagStr).join(newTag);
      if (rel !== heroRel) {
        const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tagStr)?.[1] ?? '';
        images.push({ file: basename(rel), alt, role: 'inline' });
      }
    }

    // `featureImage` reported back is the reference `meta.json` should store:
    // the moved `images/<file>` path if it came from `_inbox`, or whatever
    // was passed in unchanged if it is a hosted/external URL that was never
    // ours to move.
    return { html: rewrittenHtml, images, featureImage: heroRel ?? featureImage };
  }

  /** Writes all four files for a folder that already exists (or is being created for the first time). */
  private async writeExport(folder: string, post: WritableExport): Promise<void> {
    const { html, images, featureImage } = await this.collectAndMoveImages(
      folder,
      post.html,
      post.feature_image,
      post.feature_image_alt,
    );

    const meta: StoredMeta = {
      title: post.title,
      ...(post.slug !== undefined ? { slug: post.slug } : {}),
      ...(post.custom_excerpt !== undefined ? { custom_excerpt: post.custom_excerpt } : {}),
      ...(post.meta_title !== undefined ? { meta_title: post.meta_title } : {}),
      ...(post.meta_description !== undefined ? { meta_description: post.meta_description } : {}),
      ...(post.tags !== undefined ? { tags: post.tags } : {}),
      ...(post.categories !== undefined ? { categories: post.categories } : {}),
      ...(post.canonical_url !== undefined ? { canonical_url: post.canonical_url } : {}),
      ...(featureImage !== undefined ? { feature_image: featureImage } : {}),
      ...(post.feature_image_alt !== undefined ? { feature_image_alt: post.feature_image_alt } : {}),
      status: post.status,
      exported_at: new Date().toISOString(),
    };

    const markdown = htmlToMarkdown(html);

    // The hero already living in `images/` from a *previous* write (an
    // `updatePost` whose patch carried no fresh `feature_image`) is not in
    // `images` — `collectAndMoveImages` only reports files it moved just
    // now. Re-list it here so the hand-off page keeps showing the hero after
    // an unrelated edit, without re-moving anything.
    const alreadyListed = images.some((img) => img.role === 'hero');
    const handoffImages =
      !alreadyListed && featureImage?.startsWith('images/')
        ? [{ file: basename(featureImage), alt: post.feature_image_alt ?? '', role: 'hero' as const }, ...images]
        : images;

    // These four writes are not atomic — a crash or an EIO between any two of
    // them leaves the folder with a stale mix (e.g. a rewritten article.html
    // next to yesterday's meta.json). Accepted trade-off: there is no tmp+
    // rename scheme here because the four files are independently useful to
    // the human reading them (an export is a hand-off folder, not a
    // transactional store), so a loud failure with a possibly-inconsistent
    // folder beats the complexity of staging and atomically swapping five
    // separate paths (four files plus images/).
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'article.html'), html, 'utf8');
    await writeFile(join(folder, 'article.md'), markdown, 'utf8');
    await writeFile(join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    const handoffInput: HandoffInput = {
      label: this.spec.label,
      title: post.title,
      ...(post.custom_excerpt !== undefined ? { subtitle: post.custom_excerpt } : {}),
      tags: post.tags ?? [],
      articleHtml: html,
      articleMarkdown: markdown,
      images: handoffImages,
      pasteSteps: this.spec.pasteSteps,
      meta: { status: post.status },
    };
    await writeFile(join(folder, 'index.html'), renderHandoffPage(handoffInput), 'utf8');
  }

  async createPost(post: PostInput): Promise<PostResult> {
    this.assertResolved(post.html);
    this.refuseScheduling(post.status);

    const warnings = this.unsupportedFieldWarnings(post);
    const dateStr = new Date().toISOString().slice(0, 10);
    // Always slugified, never the caller's raw string verbatim — `post.slug`
    // is an ordinary MCP tool argument, and `slug: '../../../../tmp/x'` used
    // as-is would name a folder outside `export_dir`. `confine` below is the
    // second, independent check on the result.
    const folderSlug = slugify(post.slug?.trim() || post.title);
    const root = this.root();
    const folder = this.confine(root, join(root, `${dateStr}-${folderSlug}`), 'Article folder');

    await this.writeExport(folder, post);

    return {
      id: folder,
      url: `file://${folder}/index.html`,
      status: 'exported',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** `id` is the folder `createPost` returned. Re-reads `meta.json`, merges the patch over it, and rewrites all four files. */
  async updatePost(id: string, patch: Partial<PostInput>): Promise<PostResult> {
    this.assertResolved(patch.html);
    this.refuseScheduling(patch.status);

    // `id` is round-tripped from a prior `createPost`/`updatePost` result,
    // but it is still caller-supplied text by the time it reaches an MCP
    // tool call — confine it to `root()` before it is used as a path at all.
    const folder = this.confine(this.root(), id, 'Post id');
    let existing: StoredMeta;
    try {
      existing = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8')) as StoredMeta;
    } catch {
      throw new ToolError({
        api: `${this.platform}:${this.slug}`,
        code: 'NO_POST',
        message: `No export found at "${folder}"`,
      });
    }

    const warnings = this.unsupportedFieldWarnings(patch);
    const html = patch.html ?? (await readFile(join(folder, 'article.html'), 'utf8'));

    const merged: WritableExport = {
      title: patch.title ?? existing.title,
      html,
      status: patch.status ?? existing.status,
      ...((patch.slug ?? existing.slug) !== undefined ? { slug: patch.slug ?? existing.slug } : {}),
      ...((patch.custom_excerpt ?? existing.custom_excerpt) !== undefined
        ? { custom_excerpt: patch.custom_excerpt ?? existing.custom_excerpt }
        : {}),
      ...((patch.meta_title ?? existing.meta_title) !== undefined
        ? { meta_title: patch.meta_title ?? existing.meta_title }
        : {}),
      ...((patch.meta_description ?? existing.meta_description) !== undefined
        ? { meta_description: patch.meta_description ?? existing.meta_description }
        : {}),
      ...((patch.tags ?? existing.tags) !== undefined ? { tags: patch.tags ?? existing.tags } : {}),
      ...((patch.categories ?? existing.categories) !== undefined
        ? { categories: patch.categories ?? existing.categories }
        : {}),
      ...((patch.canonical_url ?? existing.canonical_url) !== undefined
        ? { canonical_url: patch.canonical_url ?? existing.canonical_url }
        : {}),
      // `feature_image` merges like every other field now that it lives in
      // `meta.json`. A patch with no fresh `feature_image` carries the
      // stored `images/<file>` reference forward unchanged:
      // `collectAndMoveImages` only moves it if it is (still) a `file://`
      // path under `_inbox` — an `images/<file>` value is not, so nothing
      // gets re-moved, and `writeExport` re-lists it on the hand-off page.
      ...((patch.feature_image ?? existing.feature_image) !== undefined
        ? { feature_image: patch.feature_image ?? existing.feature_image }
        : {}),
      ...((patch.feature_image_alt ?? existing.feature_image_alt) !== undefined
        ? { feature_image_alt: patch.feature_image_alt ?? existing.feature_image_alt }
        : {}),
    };

    await this.writeExport(folder, merged);

    return {
      id: folder,
      url: `file://${folder}/index.html`,
      status: 'exported',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Export platforms have no tag list to fetch — returns empty honestly, not a warning. */
  async listTags(): Promise<Array<{ id: string; name: string; slug: string }>> {
    return [];
  }

  async listAuthors(): Promise<Array<{ id: string; name: string; email?: string }>> {
    return [];
  }
}
