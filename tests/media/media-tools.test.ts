import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMedia, listMediaLibraries } from '../../src/tools/media-tools.js';
import type { MediaCtx } from '../../src/tools/media-tools.js';
import { loadMedia } from '../../src/media/library.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(files: string[]): MediaCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-home-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  for (const rel of files) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), PNG_1x1);
  }
  const configFile = join(home, 'config.yaml');
  writeFileSync(configFile, `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${root}\n`);

  // No cast. If this object is missing something the functions read, the
  // narrow MediaCtx is the only thing that will say so — tests are not typechecked.
  return { paths: { home }, media: loadMedia(configFile, {}) };
}

describe('listMediaLibraries', () => {
  it('reports zero assets before a scan and says the index is missing', async () => {
    const out = await listMediaLibraries(ctxWith(['a.png']), {});
    expect(out.libraries[0]!.name).toBe('shots');
    expect(out.libraries[0]!.scanned).toBe(false);
    expect(out.libraries[0]!.assets).toBe(0);
  });

  it('reports counts after a scan', async () => {
    const ctx = ctxWith(['a.png', 'b/c.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await listMediaLibraries(ctx, {});
    expect(out.libraries[0]!.scanned).toBe(true);
    expect(out.libraries[0]!.assets).toBe(2);
    expect(out.libraries[0]!.unused).toBe(2);
    expect(out.libraries[0]!.stale_reservations).toBe(0);
  });

  it('lists an unavailable library with its reason rather than omitting it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bl-home-'));
    const configFile = join(home, 'config.yaml');
    writeFileSync(configFile, 'sites: {}\nmedia:\n  libraries:\n    - name: gone\n      path: /nope\n');
    const ctx: MediaCtx = { paths: { home }, media: loadMedia(configFile, {}) };
    const out = await listMediaLibraries(ctx, {});
    expect(out.libraries[0]!.unavailable).toMatch(/does not exist/i);
  });
});

describe('findMedia', () => {
  it('finds by filename token and reports why', async () => {
    const ctx = ctxWith(['portraits/team-standup.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: 'standup' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.path).toBe('portraits/team-standup.png');
    expect(out.results[0]!.local_path).toContain('portraits/team-standup.png');
    expect(out.results[0]!.why[0]!.field).toBe('filename');
  });

  it('reports the library as un-enriched so weak results are explained', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: '' });
    expect(out.enriched).toBe(false);
    expect(out.note).toMatch(/enrich/i);
  });

  it('refuses with a hint when the library has never been scanned', async () => {
    const ctx = ctxWith(['a.png']);
    await expect(findMedia(ctx, { query: 'x' })).rejects.toThrow(/scan/i);
  });
});
