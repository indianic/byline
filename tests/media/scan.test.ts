import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nearestAspect, scanLibrary, tokenise, tokeniseFilename } from '../../src/media/scan.js';
import type { LibraryConfig } from '../../src/media/types.js';

/** A real 1x1 PNG. Byte-accurate, so inspectImage reads genuine magic bytes. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function libWith(files: Record<string, Buffer | string>): LibraryConfig {
  const root = mkdtempSync(join(tmpdir(), 'bl-scan-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return { name: 'shots', path: root, recursive: true };
}

describe('tokenise', () => {
  it('lowercases and splits on non-alphanumerics, with no extension handling', () => {
    // tokenise is a pure splitter: it does not know "JPG" is an extension.
    // Extension stripping lives in tokeniseFilename (see below), because
    // tokenise's other caller — folder segments — has no extension to strip
    // and must not have one guessed at and removed.
    expect(tokenise('Team_Standup-01.JPG')).toEqual(['team', 'standup', '01', 'jpg']);
  });

  it('drops single-character fragments', () => {
    expect(tokenise('a-photo')).toEqual(['photo']);
  });

  it('returns an empty array for text with no usable tokens', () => {
    expect(tokenise('__--__')).toEqual([]);
  });

  it('keeps both segments of a dotted folder-style name, not just the first', () => {
    // A folder named `2026.08` is never extension-stripped by any caller;
    // `tokenise` must not treat the `.08` as a trailing extension.
    expect(tokenise('2026.08')).toEqual(['2026', '08']);
  });

  it('keeps a real word that happens to follow a dot', () => {
    // The lone '2' between the dots is a single character and is correctly
    // dropped by the length filter — but 'final' must survive, which it does
    // not today: the extension-strip regex eats '.2-final' as a whole.
    expect(tokenise('v1.2-final')).toEqual(['v1', 'final']);
  });
});

describe('tokeniseFilename', () => {
  it('strips a trailing extension and tokenises what remains', () => {
    expect(tokeniseFilename('Team_Standup-01.JPG')).toEqual(['team', 'standup', '01']);
  });

  it('does not drop real tokens in a multi-dot filename', () => {
    // Only the trailing `.png` is an extension; `.08.11-standup` is filename,
    // and `tokenise` (with no extension-stripping of its own) must keep it whole.
    expect(tokeniseFilename('2026.08.11-standup.png')).toEqual(['2026', '08', '11', 'standup']);
  });
});

describe('nearestAspect', () => {
  it('buckets 1920x1080 as 16:9', () => {
    expect(nearestAspect(1920, 1080)).toBe('16:9');
  });

  it('buckets 4032x3024 as 4:3', () => {
    expect(nearestAspect(4032, 3024)).toBe('4:3');
  });

  it('buckets a square as 1:1', () => {
    expect(nearestAspect(800, 800)).toBe('1:1');
  });

  it('buckets a portrait 3:4 as 1:1, the nearest of the three it has', () => {
    expect(nearestAspect(3024, 4032)).toBe('1:1');
  });
});

describe('scanLibrary', () => {
  // `MEDIA_EXTENSIONS` is a plain object, so `MEDIA_EXTENSIONS["constructor"]`
  // is `Object.prototype.constructor` — truthy. A file named `x.constructor`
  // therefore passed the "is this indexable?" test and was then read as if it
  // declared a `kind` and a `mime`.
  it('does not index a file whose extension is an Object.prototype key', () => {
    const lib = libWith({
      'real.png': PNG_1x1,
      'weird.constructor': PNG_1x1,
      'weird.__proto__': PNG_1x1,
      'weird.valueOf': PNG_1x1,
    });
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['real.png']);
  });

  it('indexes an image with a content-hash id and real dimensions', () => {
    const lib = libWith({ 'portraits/team-standup-01.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);

    expect(idx.assets).toHaveLength(1);
    const a = idx.assets[0]!;
    expect(a.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.path).toBe('portraits/team-standup-01.png');
    expect(a.kind).toBe('image');
    expect(a.mime).toBe('image/png');
    expect(a.width).toBe(1);
    expect(a.height).toBe(1);
    expect(a.aspect).toBe('1:1');
    expect(a.source.filename_tokens).toEqual(['team', 'standup', '01']);
    expect(a.source.folder_tokens).toEqual(['portraits']);
    expect(a.source.captured_from).toBe('mtime');
  });

  it('gives two copies of the same bytes the same id', () => {
    const lib = libWith({ 'a.png': PNG_1x1, 'nested/b.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets).toHaveLength(2);
    expect(idx.assets[0]!.id).toBe(idx.assets[1]!.id);
  });

  it('indexes video by extension with null dimensions', () => {
    const lib = libWith({ 'clips/demo.mp4': Buffer.from('not really an mp4') });
    const idx = scanLibrary(lib, null);
    const a = idx.assets[0]!;
    expect(a.kind).toBe('video');
    expect(a.mime).toBe('video/mp4');
    expect(a.width).toBeNull();
    expect(a.aspect).toBeNull();
    expect(a.duration_s).toBeNull();
  });

  it('ignores files with unknown extensions', () => {
    const lib = libWith({ 'notes.txt': 'hello', 'a.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets).toHaveLength(1);
    expect(idx.assets[0]!.path).toBe('a.png');
  });

  it('ignores dotfiles and dot-directories', () => {
    const lib = libWith({ '.hidden.png': PNG_1x1, '.git/x.png': PNG_1x1, 'ok.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['ok.png']);
  });

  it('does not descend when recursive is false', () => {
    const lib = { ...libWith({ 'top.png': PNG_1x1, 'sub/deep.png': PNG_1x1 }), recursive: false };
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['top.png']);
  });

  it('reuses the previous id when mtime and size are unchanged', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const doctored = {
      ...first,
      assets: [{ ...first.assets[0]!, id: 'sha256:CACHED', enriched: undefined }],
    };
    const second = scanLibrary(lib, doctored);
    expect(second.assets[0]!.id).toBe('sha256:CACHED');
  });

  it('rehashes when the file changed, even at the same size', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const file = join(lib.path, 'a.png');
    writeFileSync(file, PNG_1x1);
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const second = scanLibrary(lib, first);
    expect(second.assets[0]!.id).toBe(first.assets[0]!.id);
    expect(second.assets[0]!.mtime_ms).not.toBe(first.assets[0]!.mtime_ms);
  });

  it('carries enrichment forward for an unchanged file', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const enriched = {
      ...first,
      assets: [
        {
          ...first.assets[0]!,
          enriched: {
            by: 'gemini',
            at: '2026-08-11T00:00:00.000Z',
            caption: 'a dot',
            keywords: ['dot'],
            look: 'flat',
            has_people: false,
            text_in_image: false,
          },
        },
      ],
    };
    const second = scanLibrary(lib, enriched);
    expect(second.assets[0]!.enriched?.caption).toBe('a dot');
  });

  it('drops an asset whose file no longer exists', () => {
    const lib = libWith({ 'a.png': PNG_1x1 });
    const first = scanLibrary(lib, null);
    const stale = {
      ...first,
      assets: [...first.assets, { ...first.assets[0]!, id: 'sha256:GONE', path: 'gone.png' }],
    };
    const second = scanLibrary(lib, stale);
    expect(second.assets.map((a) => a.path)).toEqual(['a.png']);
  });

  it('tokenises a dotted folder name without losing the segment after the dot', () => {
    const lib = libWith({ '2026.08/team-standup.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    const a = idx.assets[0]!;
    expect(a.source.folder_tokens).toEqual(expect.arrayContaining(['2026', '08']));
  });

  it('tokenises a multi-dot filename without losing the segment before the extension', () => {
    const lib = libWith({ '2026.08.11-standup.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    const a = idx.assets[0]!;
    expect(a.source.filename_tokens).toEqual(expect.arrayContaining(['11', 'standup']));
    expect(a.source.filename_tokens).not.toContain('png');
  });

  it('sorts assets by path so the written index is stable', () => {
    const lib = libWith({ 'z.png': PNG_1x1, 'a.png': PNG_1x1, 'm/b.png': PNG_1x1 });
    const idx = scanLibrary(lib, null);
    expect(idx.assets.map((a) => a.path)).toEqual(['a.png', 'm/b.png', 'z.png']);
  });
});
