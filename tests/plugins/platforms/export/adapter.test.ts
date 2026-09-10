import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteConfig } from '../../../../src/config/sites.js';
import { ToolError } from '../../../../src/errors.js';
import { ExportAdapter } from '../../../../src/plugins/platforms/export/adapter.js';
import type { ExportSpec } from '../../../../src/plugins/platforms/export/types.js';
import { GHOST_HTML_PROFILE } from '../../../../src/plugins/platforms/ghost/html-profile.js';

const SPEC: ExportSpec = {
  platformId: 'testexport',
  label: 'TestExport',
  pasteSteps: ['Open the editor.', 'Paste the article.'],
  profile: { ...GHOST_HTML_PROFILE, platform: 'testexport', label: 'TestExport', verified: false },
};

function makeSite(exportDir: string, slug = 'myexport'): SiteConfig {
  return {
    slug,
    platform: 'testexport',
    url: 'https://example.test',
    apiUrl: 'https://example.test',
    credentials: { export_dir: exportDir },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ExportAdapter.healthCheck', () => {
  it('is ok on a writable temp directory, and says only the folder was checked', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const result = await adapter.healthCheck();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('writable');
    expect(result.detail).toContain('No credential is involved');
  });

  it('is not ok when export_dir resolves through a file, not a directory', async () => {
    const filePath = join(dir, 'not-a-directory');
    writeFileSync(filePath, 'x');
    const adapter = new ExportAdapter(makeSite(filePath), SPEC);
    const result = await adapter.healthCheck();
    expect(result.ok).toBe(false);
  });

  it('is not ok when export_dir is missing entirely', async () => {
    const site = makeSite(dir);
    site.credentials = {};
    const adapter = new ExportAdapter(site, SPEC);
    const result = await adapter.healthCheck();
    expect(result.ok).toBe(false);
  });
});

describe('ExportAdapter.uploadImage', () => {
  it('writes the file under _inbox and returns a file:// URL', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const { url, id } = await adapter.uploadImage(Buffer.from('fake png bytes'), 'photo.png', 'alt text');
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain('/_inbox/');
    expect(url).toContain('photo.png');
    expect(id).toBe(url.slice('file://'.length));
    const stored = readFileSync(id!, 'utf8');
    expect(stored).toBe('fake png bytes');
  });
});

describe('ExportAdapter.siteTimezone', () => {
  it('throws NO_SITE_TIMEZONE with a hint naming the platform', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    await expect(adapter.siteTimezone()).rejects.toMatchObject({
      code: 'NO_SITE_TIMEZONE',
    });
    try {
      await adapter.siteTimezone();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ToolError).hint).toContain("TestExport has no clock");
      expect((e as ToolError).hint).toContain("schedule inside TestExport's editor");
    }
  });
});

describe('ExportAdapter.createPost', () => {
  it('refuses status "scheduled"', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    await expect(
      adapter.createPost({ title: 'T', html: '<p>x</p>', status: 'scheduled' }),
    ).rejects.toMatchObject({ code: 'SCHEDULING_UNSUPPORTED' });
  });

  it('refuses HTML that still contains the [[content_image]] placeholder', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    await expect(
      adapter.createPost({ title: 'T', html: '<p>[[content_image]]</p>', status: 'draft' }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER' });
  });

  it('moves an uploaded feature image into images/, rewrites nothing needed for it, and writes all four files', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const { url } = await adapter.uploadImage(Buffer.from('hero bytes'), 'hero.jpg');

    const result = await adapter.createPost({
      title: 'Legacy modernisation in the Gulf',
      html: '<p>Opening paragraph.</p>',
      status: 'draft',
      feature_image: url,
      feature_image_alt: 'A team at work',
    });

    expect(result.status).toBe('exported');
    expect(result.url).toMatch(/^file:\/\/.*\/index\.html$/);
    const folder = result.id;

    const today = new Date().toISOString().slice(0, 10);
    expect(folder).toContain(`${today}-legacy-modernisation-in-the-gulf`);

    // The article html/md/meta/index files all exist.
    const articleHtml = readFileSync(join(folder, 'article.html'), 'utf8');
    const articleMd = readFileSync(join(folder, 'article.md'), 'utf8');
    const meta = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'));
    const indexHtml = readFileSync(join(folder, 'index.html'), 'utf8');

    expect(articleHtml).toContain('Opening paragraph.');
    expect(articleMd).toContain('Opening paragraph.');
    expect(meta.title).toBe('Legacy modernisation in the Gulf');
    expect(meta.status).toBe('draft');
    expect(meta.feature_image_alt).toBe('A team at work');
    expect(indexHtml).toContain('Legacy modernisation in the Gulf');

    // The uploaded file moved out of _inbox and into images/.
    const movedPath = join(folder, 'images', basename(url.slice('file://'.length)));
    expect(readFileSync(movedPath, 'utf8')).toBe('hero bytes');
  });

  it('moves an inline <img> from _inbox into images/ and rewrites the src in article.html', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const { url } = await adapter.uploadImage(Buffer.from('inline bytes'), 'inline.jpg');

    const result = await adapter.createPost({
      title: 'A piece with an inline image',
      html: `<p>Before.</p><p><img src="${url}" alt="An inline shot"></p><p>After.</p>`,
      status: 'draft',
    });

    const articleHtml = readFileSync(join(result.id, 'article.html'), 'utf8');
    expect(articleHtml).not.toContain('file://');
    expect(articleHtml).toMatch(/<img src="images\/[^"]+\.jpg" alt="An inline shot">/);

    const file = basename(url.slice('file://'.length));
    expect(readFileSync(join(result.id, 'images', file), 'utf8')).toBe('inline bytes');
  });

  it('warns by name when og_title is set, since no export platform can store it', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const result = await adapter.createPost({
      title: 'T',
      html: '<p>Body.</p>',
      status: 'draft',
      og_title: 'A social title',
    });
    expect(result.warnings?.join(' ')).toContain('og_title');
  });

  it('warns about slug naming the folder rather than the platform URL', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const result = await adapter.createPost({
      title: 'T',
      html: '<p>Body.</p>',
      status: 'draft',
      slug: 'custom-slug',
    });
    expect(result.warnings?.join(' ')).toContain('slug: used to name the export folder');
    expect(result.id).toContain('custom-slug');
  });
});

describe('ExportAdapter.updatePost', () => {
  it('re-reads meta.json, merges the patch, and rewrites the files', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const created = await adapter.createPost({
      title: 'Original title',
      html: '<p>Original body.</p>',
      status: 'draft',
      tags: ['a'],
    });

    const updated = await adapter.updatePost(created.id, { html: '<p>Updated body.</p>' });
    expect(updated.status).toBe('exported');

    const articleHtml = readFileSync(join(created.id, 'article.html'), 'utf8');
    const meta = JSON.parse(readFileSync(join(created.id, 'meta.json'), 'utf8'));
    expect(articleHtml).toContain('Updated body.');
    // Fields not in the patch survive from the previous meta.json.
    expect(meta.title).toBe('Original title');
    expect(meta.tags).toEqual(['a']);
  });

  it('throws NO_POST for an id with no meta.json, inside export_dir but never created by createPost', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    // Inside the export root (so confinement passes) but never written —
    // this is the "wrong id" case, distinct from the "id outside export_dir
    // entirely" case covered under path confinement below.
    await expect(adapter.updatePost(join(dir, 'myexport', 'nope'), { title: 'x' })).rejects.toMatchObject({
      code: 'NO_POST',
    });
  });
});

describe('ExportAdapter path confinement (adversarial)', () => {
  it('createPost slugifies a slug containing "../" instead of using it verbatim in the folder path', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const result = await adapter.createPost({
      title: 'Fallback title',
      html: '<p>Body.</p>',
      status: 'draft',
      slug: '../../escape',
    });

    const today = new Date().toISOString().slice(0, 10);
    const root = join(dir, 'myexport');
    expect(result.id).toBe(join(root, `${today}-escape`));
    // Nothing escaped: the folder is a direct child of root, not a sibling
    // or ancestor.
    expect(existsSync(join(root, `${today}-escape`, 'meta.json'))).toBe(true);
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });

  it('updatePost throws PATH_OUTSIDE_EXPORT_DIR for an id outside export_dir and never touches that folder', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const outside = mkdtempSync(join(tmpdir(), 'wb-export-outside-'));
    const metaPath = join(outside, 'meta.json');
    writeFileSync(metaPath, JSON.stringify({ title: 'Untouched', status: 'draft' }));

    await expect(adapter.updatePost(outside, { title: 'Hijacked' })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_EXPORT_DIR',
    });

    // The foreign meta.json was never read or overwritten.
    expect(JSON.parse(readFileSync(metaPath, 'utf8')).title).toBe('Untouched');
    rmSync(outside, { recursive: true, force: true });
  });

  it('createPost throws PATH_OUTSIDE_EXPORT_DIR for an inline <img> that escapes _inbox via "..", and leaves the target file untouched', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const root = join(dir, 'myexport');
    // root/_inbox/../.. resolves back to `dir`, so this lands the escape at
    // `dir/outside/secret.txt` — one level above the export root itself.
    const outsideDir = join(dir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const secretPath = join(outsideDir, 'secret.txt');
    writeFileSync(secretPath, 'do not move me');

    const evilSrc = `file://${root}/_inbox/../../outside/secret.txt`;
    await expect(
      adapter.createPost({
        title: 'Escape attempt',
        html: `<p><img src="${evilSrc}" alt="x"></p>`,
        status: 'draft',
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_EXPORT_DIR' });

    expect(readFileSync(secretPath, 'utf8')).toBe('do not move me');
  });

  it('leaves a feature_image that is a file:// URL outside _inbox entirely unmoved and unchanged (a hosted/external image is legitimate)', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const externalPath = join(dir, 'external-hero.jpg');
    writeFileSync(externalPath, 'external bytes');
    const externalUrl = `file://${externalPath}`;

    const result = await adapter.createPost({
      title: 'External hero',
      html: '<p>Body.</p>',
      status: 'draft',
      feature_image: externalUrl,
      feature_image_alt: 'An external hero',
    });

    // The file was never touched or moved into images/.
    expect(readFileSync(externalPath, 'utf8')).toBe('external bytes');
    expect(existsSync(join(result.id, 'images'))).toBe(false);

    const meta = JSON.parse(readFileSync(join(result.id, 'meta.json'), 'utf8'));
    expect(meta.feature_image).toBe(externalUrl);
  });

  it('uploadImage sanitizes a filename containing "../" down to its basename', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const { url, id } = await adapter.uploadImage(Buffer.from('evil bytes'), '../../evil.png');
    const inbox = join(dir, 'myexport', '_inbox');
    expect(id).toMatch(/^.*\/[0-9a-f]{8}-evil\.png$/);
    expect(id!.startsWith(`${inbox}/`)).toBe(true);
    expect(url).toBe(`file://${id}`);
    expect(readFileSync(id!, 'utf8')).toBe('evil bytes');
  });

  it('uploadImage refuses a filename that is only dots', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    await expect(adapter.uploadImage(Buffer.from('x'), '..')).rejects.toMatchObject({
      code: 'INVALID_FILENAME',
    });
  });

  it('meta.json round-trips feature_image through updatePost with no fresh feature_image in the patch', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    const { url } = await adapter.uploadImage(Buffer.from('hero bytes'), 'hero.jpg');
    const created = await adapter.createPost({
      title: 'Has a hero',
      html: '<p>Body.</p>',
      status: 'draft',
      feature_image: url,
      feature_image_alt: 'A hero',
    });

    const metaAfterCreate = JSON.parse(readFileSync(join(created.id, 'meta.json'), 'utf8'));
    expect(metaAfterCreate.feature_image).toMatch(/^images\/[0-9a-f]{8}-hero\.jpg$/);

    const updated = await adapter.updatePost(created.id, { html: '<p>Updated body.</p>' });
    const metaAfterUpdate = JSON.parse(readFileSync(join(updated.id, 'meta.json'), 'utf8'));

    // feature_image and feature_image_alt survive an update that never
    // mentions them, and the hand-off page still lists the hero.
    expect(metaAfterUpdate.feature_image).toBe(metaAfterCreate.feature_image);
    expect(metaAfterUpdate.feature_image_alt).toBe('A hero');
    const indexHtml = readFileSync(join(updated.id, 'index.html'), 'utf8');
    expect(indexHtml).toContain(metaAfterUpdate.feature_image);
  });
});

describe('ExportAdapter.listTags / listAuthors', () => {
  it('return an empty list honestly, with no warning', async () => {
    const adapter = new ExportAdapter(makeSite(dir), SPEC);
    expect(await adapter.listTags()).toEqual([]);
    expect(await adapter.listAuthors()).toEqual([]);
  });
});
