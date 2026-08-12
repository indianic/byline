import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listMediaLibraries, useMedia } from '../../src/tools/media-tools.js';
import { promoteUsedMedia } from '../../src/tools/media-tools.js';
import { readLedger } from '../../src/media/store.js';
import { ledgerFileFor } from '../../src/media/library.js';
import { loadMedia } from '../../src/media/library.js';
import { ToolError } from '../../src/errors.js';
import type { UploadCtx } from '../../src/tools/media-tools.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A 1x1 JPEG. Real magic bytes (`FF D8 FF`), so `inspectImage` reports
 * `image/jpeg` for it no matter what the file on disk is named.
 */
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** Four bytes of nothing, named like a video. Never uploaded, so never parsed. */
const NOT_REALLY_A_VIDEO = Buffer.from([0x00, 0x00, 0x00, 0x18]);

function ctxWith(
  files: Record<string, Buffer> = { 'a.png': PNG_1x1 },
  opts: { reuseScope?: 'site' | 'global' } = {},
): UploadCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-use-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), bytes);
  }
  const configFile = join(home, 'config.yaml');
  const scope = opts.reuseScope ? `  reuse_scope: ${opts.reuseScope}\n` : '';
  writeFileSync(
    configFile,
    `sites: {}\nmedia:\n${scope}  libraries:\n    - name: shots\n      path: ${root}\n`,
  );
  return { paths: { home }, media: loadMedia(configFile, {}), sites: { sites: {} } };
}

/** Stand in for the platform adapter. Asserted at runtime, since tests are not typechecked. */
const uploadImage = vi.fn(async (_f: Buffer, name: string) => ({
  url: `https://blog.example.com/content/${name}`,
  id: '42',
}));

vi.mock('../../src/tools/shared.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/shared.js')>()),
  adapterFor: () => ({ uploadImage }),
}));

describe('useMedia', () => {
  it('uploads and reserves the asset', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png', alt: 'a dot' }] });

    expect(out.uploaded).toBe(1);
    expect(out.images[0]!.ok).toBe(true);
    expect(out.images[0]!.url).toMatch(/^https:\/\//);
    expect(typeof out.images[0]!.id).toBe('string');

    const lib = ctx.media.libraries.shots!;
    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots');
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]!.state).toBe('reserved');
    expect(ledger.records[0]!.site).toBe('personal');
  });

  it('refuses an asset that is not in the index', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    await expect(
      useMedia(ctx, { site: 'personal', assets: [{ path: 'ghost.png' }] }),
    ).rejects.toThrow(/not in the index/i);
  });

  it('reports one failure per asset without failing the batch', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    uploadImage.mockRejectedValueOnce(new Error('boom'));
    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    expect(out.failed).toBe(1);
    expect(out.images[0]!.ok).toBe(false);
    const lib = ctx.media.libraries.shots!;
    // A failed upload must NOT be reserved -- nothing reached the platform.
    expect(readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots').records).toHaveLength(0);
  });
});

describe('useMedia and the usage ledger', () => {
  it('refuses an asset already published on this site, naming the post it went into', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const first = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    promoteUsedMedia(ctx, [first.images[0]!.url!], 'https://blog.example.com/post/one/');

    const before = uploadImage.mock.calls.length;
    const again = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    // The bytes must not reach the platform a second time.
    expect(uploadImage.mock.calls.length).toBe(before);
    expect(again.uploaded).toBe(0);
    expect(again.failed).toBe(1);
    expect(again.images[0]!.ok).toBe(false);
    expect(again.images[0]!.code).toBe('ALREADY_USED');
    expect(again.images[0]!.error).toContain('https://blog.example.com/post/one/');
    expect(again.images[0]!.hint).toMatch(/allow_reuse/);

    const lib = ctx.media.libraries.shots!;
    expect(readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots').records).toHaveLength(1);
  });

  it('names the hosted URL when the prior use is only reserved, never published', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const first = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    const again = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    expect(again.images[0]!.ok).toBe(false);
    expect(again.images[0]!.error).toContain(first.images[0]!.url!);
  });

  it('refuses the second copy of one asset inside a single batch', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const out = await useMedia(ctx, {
      site: 'personal',
      assets: [{ path: 'a.png' }, { path: 'a.png' }],
    });
    expect(out.uploaded).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.images[1]!.code).toBe('ALREADY_USED');
  });

  it('does not fail the batch: the fresh asset in it still uploads', async () => {
    const ctx = ctxWith({ 'a.png': PNG_1x1, 'b.png': Buffer.concat([PNG_1x1, Buffer.from('b')]) });
    await listMediaLibraries(ctx, { scan: true });
    await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    const out = await useMedia(ctx, {
      site: 'personal',
      assets: [{ path: 'a.png' }, { path: 'b.png' }],
    });
    expect(out.images[0]!.ok).toBe(false);
    expect(out.images[1]!.ok).toBe(true);
    expect(out.uploaded).toBe(1);
  });

  it('uploads a used asset again when allow_reuse is set deliberately', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    const out = await useMedia(ctx, {
      site: 'personal',
      assets: [{ path: 'a.png' }],
      allow_reuse: true,
    });
    expect(out.uploaded).toBe(1);
    expect(out.images[0]!.ok).toBe(true);

    const lib = ctx.media.libraries.shots!;
    expect(readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots').records).toHaveLength(2);
  });

  it('under site scope, the same asset is still free for a different site', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    const other = await useMedia(ctx, { site: 'company', assets: [{ path: 'a.png' }] });
    expect(other.uploaded).toBe(1);
  });

  it('under global scope, a use on any site refuses it everywhere', async () => {
    const ctx = ctxWith({ 'a.png': PNG_1x1 }, { reuseScope: 'global' });
    await listMediaLibraries(ctx, { scan: true });
    await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });

    const other = await useMedia(ctx, { site: 'company', assets: [{ path: 'a.png' }] });
    expect(other.images[0]!.code).toBe('ALREADY_USED');
    expect(other.uploaded).toBe(0);
  });
});

describe('useMedia and what it can actually upload', () => {
  it('refuses a video rather than posting one as application/octet-stream', async () => {
    const ctx = ctxWith({ 'clip.mp4': NOT_REALLY_A_VIDEO });
    await listMediaLibraries(ctx, { scan: true });

    const before = uploadImage.mock.calls.length;
    try {
      await useMedia(ctx, { site: 'personal', assets: [{ path: 'clip.mp4' }] });
      throw new Error('expected useMedia to refuse a video');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).api).toBe('media');
      expect((e as ToolError).code).toBe('VIDEO_NOT_SUPPORTED');
      expect((e as ToolError).hint).toBeTruthy();
    }
    // Refused before anything reached the platform.
    expect(uploadImage.mock.calls.length).toBe(before);
  });

  it('uploads under a filename built from the magic-byte mime, not the extension on disk', async () => {
    // A file NAMED .png whose bytes are a JPEG. Both adapters derive the
    // upload Content-Type from the filename extension, so passing the name
    // through verbatim would declare a JPEG to be a PNG — the exact defect
    // `inspectImage` was written for, and the one scan.ts corrects `mime` for.
    const ctx = ctxWith({ 'mislabelled.png': JPEG_1x1 });
    await listMediaLibraries(ctx, { scan: true });

    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'mislabelled.png' }] });
    expect(out.uploaded).toBe(1);
    const name = uploadImage.mock.calls.at(-1)![1];
    expect(name).toBe('mislabelled.jpg');
  });
});

// Running as root ignores directory permissions, so the write below would
// succeed and the test would assert nothing. Skipped with a named reason
// rather than silently passing.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('useMedia when the ledger cannot be written', () => {
  it.skipIf(asRoot)('returns every hosted URL and reports the failure instead of losing the batch', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });

    // A REAL read-only directory where the ledger belongs: the ledger read
    // still succeeds (no file yet, so an empty ledger), and `writeAtomic`'s
    // temp write fails with a real EACCES. No filesystem mock involved.
    const lib = ctx.media.libraries.shots!;
    const ledgerFile = ledgerFileFor(lib, ctx.paths.home);
    mkdirSync(dirname(ledgerFile), { recursive: true });
    chmodSync(dirname(ledgerFile), 0o500);

    const out = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] }).finally(() =>
      chmodSync(dirname(ledgerFile), 0o700),
    );

    expect(out.uploaded).toBe(1);
    expect(out.images[0]!.ok).toBe(true);
    expect(out.images[0]!.url).toMatch(/^https:\/\//);
    expect(out.problems).toHaveLength(1);
    expect(out.problems![0]).toContain(ledgerFile);
    expect(out.problems![0]).toMatch(/media/i);
    expect(out.problems![0]).toMatch(/not recorded|may be offered again/i);
  });
});

describe('promoteUsedMedia', () => {
  it('promotes a reservation whose url appears in the published post', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const used = await useMedia(ctx, { site: 'personal', assets: [{ path: 'a.png' }] });
    const url = used.images[0]!.url!;

    const { promoted } = promoteUsedMedia(ctx, [url], 'https://blog.example.com/post/');
    expect(promoted).toBe(1);

    const lib = ctx.media.libraries.shots!;
    const ledger = readLedger(ledgerFileFor(lib, ctx.paths.home), 'shots');
    expect(ledger.records[0]!.state).toBe('published');
  });

  it('reports a broken ledger against the library, naming a tool that exists', async () => {
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    const lib = ctx.media.libraries.shots!;
    writeFileSync(ledgerFileFor(lib, ctx.paths.home), 'not json at all');

    const out = promoteUsedMedia(ctx, ['https://blog.example.com/content/a.png'], 'https://blog/p/');
    expect(out.promoted).toBe(0);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('shots');
    expect(out.problems[0]).toContain('list_media_libraries');
    expect(out.problems[0]).not.toMatch(/byline media/i);
  });

  it('reports an unavailable library instead of silently never promoting it', async () => {
    // Unmount the drive between use_media and create_post: the reservation
    // can never be promoted, and before this the loop just `continue`d, so
    // the post published, the ledger never moved, and nothing said so.
    const ctx = ctxWith();
    await listMediaLibraries(ctx, { scan: true });
    ctx.media.libraries.shots!.unavailable = 'Media library "shots" points at /nope, which is gone.';

    const out = promoteUsedMedia(ctx, ['https://blog.example.com/content/a.png'], 'https://blog/p/');
    expect(out.promoted).toBe(0);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('shots');
  });

  it('promotes nothing and throws nothing when no media was used', () => {
    const ctx = ctxWith();
    expect(promoteUsedMedia(ctx, ['https://blog/x.png'], 'https://blog/post/')).toEqual({
      promoted: 0,
      problems: [],
    });
  });
});
