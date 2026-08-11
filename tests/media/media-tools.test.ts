import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMedia, listMediaLibraries } from '../../src/tools/media-tools.js';
import type { MediaCtx } from '../../src/tools/media-tools.js';
import { ledgerFileFor, loadMedia } from '../../src/media/library.js';
import { writeLedger } from '../../src/media/store.js';
import { ToolError } from '../../src/errors.js';
import type { UsageLedger } from '../../src/media/types.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(files: string[], opts: { reuseScope?: 'site' | 'global' } = {}): MediaCtx {
  const home = mkdtempSync(join(tmpdir(), 'bl-home-'));
  const root = join(home, 'shots');
  mkdirSync(root, { recursive: true });
  for (const rel of files) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), PNG_1x1);
  }
  const configFile = join(home, 'config.yaml');
  const mediaBlock = opts.reuseScope
    ? `media:\n  reuse_scope: ${opts.reuseScope}\n  libraries:\n    - name: shots\n      path: ${root}\n`
    : `media:\n  libraries:\n    - name: shots\n      path: ${root}\n`;
  writeFileSync(configFile, `sites: {}\n${mediaBlock}`);

  // No cast. If this object is missing something the functions read, the
  // narrow MediaCtx is the only thing that will say so — tests are not typechecked.
  return { paths: { home }, media: loadMedia(configFile, {}) };
}

/**
 * Mark the given asset id as used on `site`, via a REAL ledger file written
 * with the same `writeLedger` the tools read back — not a fabricated object
 * handed straight to the function under test. This is what the reviewer
 * flagged as missing: every prior test ran against an empty ledger, which is
 * exactly the condition under which both defects shipped.
 */
function markUsed(ctx: MediaCtx, id: string, site: string): void {
  const lib = ctx.media.libraries.shots!;
  const file = ledgerFileFor(lib, ctx.paths.home);
  const ledger: UsageLedger = {
    version: 1,
    library: lib.name,
    records: [
      {
        id,
        site,
        state: 'published',
        hosted_url: `https://${site}.example/uploads/x.png`,
        at: new Date().toISOString(),
      },
    ],
  };
  writeLedger(file, ledger);
}

describe('listMediaLibraries', () => {
  it('reports zero assets before a scan and says the index is missing', async () => {
    const out = await listMediaLibraries(ctxWith(['a.png']), {});
    expect(out.libraries[0]!.name).toBe('shots');
    expect(out.libraries[0]!.scanned).toBe(false);
    expect(out.libraries[0]!.assets).toBe(0);
  });

  it('reports counts after a scan (site scope, ledger empty, so any site gives the same answer)', async () => {
    const ctx = ctxWith(['a.png', 'b/c.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await listMediaLibraries(ctx, { site: 'siteA' });
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

  it('under site scope, omits `unused` and explains why when no site is given for a non-empty ledger', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const noSite = await listMediaLibraries(ctx, {});
    expect(noSite.libraries[0]!.unused).toBeUndefined();
    expect(noSite.libraries[0]!.unused_note).toMatch(/site/i);

    const forUsedSite = await listMediaLibraries(ctx, { site: 'siteA' });
    expect(forUsedSite.libraries[0]!.unused).toBe(0);
    expect(forUsedSite.libraries[0]!.unused_note).toBeUndefined();

    const forOtherSite = await listMediaLibraries(ctx, { site: 'siteB' });
    expect(forOtherSite.libraries[0]!.unused).toBe(1);
  });

  it('under global scope, counts `unused` without needing a site', async () => {
    const ctx = ctxWith(['a.png'], { reuseScope: 'global' });
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const out = await listMediaLibraries(ctx, {});
    expect(out.libraries[0]!.unused).toBe(0);
    expect(out.libraries[0]!.unused_note).toBeUndefined();
  });
});

describe('findMedia', () => {
  it('finds by filename token and reports why', async () => {
    const ctx = ctxWith(['portraits/team-standup.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: 'standup', site: 'siteA' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.path).toBe('portraits/team-standup.png');
    expect(out.results[0]!.local_path).toContain('portraits/team-standup.png');
    expect(out.results[0]!.why[0]!.field).toBe('filename');
  });

  it('reports the library as un-enriched so weak results are explained', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const out = await findMedia(ctx, { query: '', site: 'siteA' });
    expect(out.enriched).toBe(false);
    expect(out.note).toMatch(/enrich/i);
  });

  it('refuses with a hint when the library has never been scanned', async () => {
    const ctx = ctxWith(['a.png']);
    await expect(findMedia(ctx, { query: 'x', site: 'siteA' })).rejects.toThrow(/scan/i);
  });

  it('under site scope, throws a ToolError instead of silently returning used assets when unused_only is true and no site is given', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    // The old inline reimplementation defaulted a missing `site` to '', which
    // matched no real record, so `unused_only: true` excluded nothing and
    // handed back the already-used asset. This must now refuse instead.
    const call = findMedia(ctx, { query: '' });
    await expect(call).rejects.toThrow(ToolError);
    await expect(call).rejects.toThrow(/site/i);
    try {
      await findMedia(ctx, { query: '' });
      throw new Error('expected findMedia to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).hint).toMatch(/site/i);
    }
  });

  it('under site scope, excludes an asset used on the given site', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const out = await findMedia(ctx, { query: '', site: 'siteA', unused_only: true });
    expect(out.results).toHaveLength(0);
  });

  it('under site scope, still returns an asset used on a DIFFERENT site', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const out = await findMedia(ctx, { query: '', site: 'siteB', unused_only: true });
    expect(out.results).toHaveLength(1);
  });

  it('under global scope, excludes an asset used anywhere, regardless of which site is asked about', async () => {
    const ctx = ctxWith(['a.png'], { reuseScope: 'global' });
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const forOtherSite = await findMedia(ctx, { query: '', site: 'siteB', unused_only: true });
    expect(forOtherSite.results).toHaveLength(0);

    // Global scope needs no site at all — the site is genuinely irrelevant.
    const noSite = await findMedia(ctx, { query: '', unused_only: true });
    expect(noSite.results).toHaveLength(0);
  });

  it('with unused_only: false, returns used assets and requires no site', async () => {
    const ctx = ctxWith(['a.png']);
    await listMediaLibraries(ctx, { scan: true });
    const found = await findMedia(ctx, { query: '', unused_only: false });
    const id = found.results[0]!.id;
    markUsed(ctx, id, 'siteA');

    const out = await findMedia(ctx, { query: '', unused_only: false });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.id).toBe(id);
  });
});
