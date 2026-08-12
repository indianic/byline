import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inspectImage } from '../plugins/images/inspect.js';
import type { Asset, Aspect, LibraryConfig, MediaIndex, MediaKind } from './types.js';

/**
 * What byline will index, keyed by lowercase extension.
 *
 * An allow-list rather than a deny-list: a library folder holds sidecars, RAW
 * files, `.DS_Store` and half-finished exports, and indexing whatever happens
 * not to be excluded is how a search fills with junk.
 *
 * The mime here names the CONTAINER, from the extension. For images it is
 * corrected from the magic bytes below; a file named `.png` that is really a
 * JPEG must not be uploaded declaring itself a PNG, which is the defect
 * `inspectImage` was written for.
 *
 * That last sentence is a claim about the UPLOAD path, so it is only true
 * because `useMedia`'s `uploadNameFor` builds the upload filename from this
 * corrected `mime` rather than from the name on disk — both adapters read the
 * Content-Type off the extension. It was false when written: `use_media`
 * passed `basename(asset.path)` through verbatim, so a corrected mime was
 * shown to the model and never used.
 */
export const MEDIA_EXTENSIONS: Record<string, { kind: MediaKind; mime: string }> = {
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  png: { kind: 'image', mime: 'image/png' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
};

const ASPECT_RATIOS: Record<Aspect, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };

/**
 * The nearest of the three buckets `generate_image` already accepts.
 *
 * Compared on log-ratio so the distance is scale-invariant: without it, wide
 * ratios sit further apart in absolute terms than narrow ones and 1:1 wins
 * arguments it should lose. Portrait images have no bucket of their own and
 * land on 1:1, which is the closest of the three that exist — a known limit,
 * not a bug to be surprised by later.
 */
export function nearestAspect(width: number, height: number): Aspect {
  const ratio = width / height;
  let best: Aspect = '1:1';
  let bestDistance = Infinity;
  for (const name of Object.keys(ASPECT_RATIOS) as Aspect[]) {
    const distance = Math.abs(Math.log(ratio / ASPECT_RATIOS[name]));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

/**
 * Lowercase alphanumeric runs of two or more characters.
 *
 * Deliberately does no extension handling: `tokenise` has two callers with
 * different input shapes — `scanLibrary`'s folder segments (never have an
 * extension to strip; `2026.08` and `v1.2-final` are real tokens, not a name
 * plus a suffix) and the filename call site, which goes through
 * `tokeniseFilename` below instead. Stripping a trailing `.xxx` here would be
 * correct for the second caller and silently destructive for the first.
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * `tokenise`, but for a real filename: the trailing `.ext` is dropped first so
 * it never contributes a spurious `jpg`/`png` token alongside the real ones.
 * Use this at the one call site that has an actual filename with an extension
 * to strip; use plain `tokenise` for anything else (e.g. folder segments).
 */
export function tokeniseFilename(filename: string): string[] {
  return tokenise(filename.replace(/\.[^.]+$/, ''));
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function hashFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Every indexable file under `root`, as paths relative to it, POSIX-separated. */
function walk(root: string, recursive: boolean): string[] {
  const out: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Dotfiles are metadata, version control, and OS bookkeeping. None of it
      // is media, and `.git` in particular would be walked in full.
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MEDIA_EXTENSIONS[extensionOf(entry.name)]) continue;
      out.push(relative(root, full).split(sep).join('/'));
    }
  };

  visit(root);
  return out.sort();
}

/**
 * Build an index for one library, reusing what the previous index already knows.
 *
 * A file whose size and mtime both match its previous entry is NOT rehashed and
 * NOT re-inspected, and its enrichment carries forward. That cache is what keeps
 * a rescan of a few thousand photographs cheap; without it, `scan` would be an
 * operation nobody runs twice.
 *
 * An entry whose file has gone is dropped. The index describes what is on disk
 * right now; the ledger, which lives in a different file, is what remembers
 * assets that no longer exist.
 */
export function scanLibrary(
  lib: LibraryConfig,
  previous: MediaIndex | null,
  now: Date = new Date(),
): MediaIndex {
  const scannedAt = now.toISOString();
  const cache = new Map((previous?.assets ?? []).map((a) => [a.path, a]));
  const assets: Asset[] = [];

  for (const rel of walk(lib.path, lib.recursive)) {
    const full = join(lib.path, rel);
    const stat = statSync(full);
    const ext = extensionOf(rel);
    const declared = MEDIA_EXTENSIONS[ext]!;

    const prior = cache.get(rel);
    const unchanged =
      prior !== undefined && prior.bytes === stat.size && prior.mtime_ms === stat.mtimeMs;

    if (unchanged) {
      assets.push({ ...prior, scanned_at: scannedAt });
      continue;
    }

    const segments = rel.split('/');
    const filename = segments[segments.length - 1]!;
    const folders = segments.slice(0, -1);

    let width: number | null = null;
    let height: number | null = null;
    let mime = declared.mime;

    if (declared.kind === 'image') {
      // Magic bytes, never the filename. A `.png` that is really a JPEG must
      // upload as a JPEG, or the platform is told the wrong Content-Type.
      //
      // Exception, UNVERIFIED: `inspectImage` has no AVIF signature branch, so
      // an `.avif` file gets `info.mime === null` and `mime` here keeps the
      // extension-derived `image/avif` from `MEDIA_EXTENSIONS` below. That is
      // exactly the filename-as-truth shortcut this comment says we don't
      // take, narrowed to one format. Whether a real AVIF file's bytes match
      // its extension has not been checked against live bytes.
      const info = inspectImage(readFileSync(full));
      width = info.width;
      height = info.height;
      if (info.mime) mime = info.mime;
    }

    assets.push({
      id: hashFile(full),
      path: rel,
      kind: declared.kind,
      mime,
      bytes: stat.size,
      width,
      height,
      aspect: width && height ? nearestAspect(width, height) : null,
      // Video dimensions and duration need a container parser. Left null in
      // this plan rather than guessed — see the deviations note.
      duration_s: null,
      captured_at: new Date(stat.mtimeMs).toISOString(),
      scanned_at: scannedAt,
      mtime_ms: stat.mtimeMs,
      source: {
        filename_tokens: tokeniseFilename(filename),
        folder_tokens: folders.flatMap(tokenise),
        // EXIF is Plan 2. Recording WHERE the date came from keeps the weaker
        // claim visible instead of letting an mtime pass as a capture time.
        captured_from: 'mtime',
      },
      ...(prior?.enriched ? { enriched: prior.enriched } : {}),
    });
  }

  return {
    version: 1,
    library: lib.name,
    root: lib.path,
    scanned_at: scannedAt,
    assets,
  };
}
