import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listMediaLibraries, useMedia } from '../../src/tools/media-tools.js';
import { promoteUsedMedia } from '../../src/tools/media-tools.js';
import { readLedger } from '../../src/media/store.js';
import { ledgerFileFor } from '../../src/media/library.js';
import { loadMedia } from '../../src/media/library.js';
import type { UploadCtx } from '../../src/tools/media-tools.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(): UploadCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-use-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.png'), PNG_1x1);
  const configFile = join(home, 'config.yaml');
  writeFileSync(configFile, `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${root}\n`);
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

  it('promotes nothing and throws nothing when no media was used', () => {
    const ctx = ctxWith();
    expect(promoteUsedMedia(ctx, ['https://blog/x.png'], 'https://blog/post/')).toEqual({
      promoted: 0,
      problems: [],
    });
  });
});
