import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ToolError } from '../errors.js';
import type { MediaIndex, UsageLedger } from './types.js';

/**
 * Write via a temp file and rename.
 *
 * `renameSync` within one filesystem is atomic, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. Writing in place would make
 * an interrupted `scan` destroy the index it was rebuilding — recoverable — and
 * an interrupted ledger write destroy usage history, which is not.
 */
function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    // Best-effort cleanup so a failed write doesn't leave `.tmp` debris on
    // disk. The cleanup itself may fail (e.g. tmp was never created because
    // writeFileSync threw first) — that must never mask the real failure,
    // so it is swallowed and the original error is always rethrown.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * Read an index, or null if there isn't a usable one.
 *
 * Every failure returns null, because the index is DERIVED: a missing,
 * corrupt, or future-versioned file all mean the same thing to a caller — scan
 * again. Refusing to run would strand a user behind a file they never wrote by
 * hand and cannot repair.
 */
export function readIndex(file: string): MediaIndex | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MediaIndex;
    if (parsed?.version !== 1 || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeIndex(file: string, index: MediaIndex): void {
  writeAtomic(file, index);
}

/**
 * Read a ledger, or an empty one if it has never been written.
 *
 * Deliberately the OPPOSITE of `readIndex` on corruption: this THROWS. A
 * corrupt index costs a rescan; a corrupt ledger is unrecoverable usage
 * history, and silently continuing with an empty one would republish every
 * photograph the user has already used and report success. Loud beats tidy.
 */
export function readLedger(file: string, library: string): UsageLedger {
  if (!existsSync(file)) return { version: 1, library, records: [] };

  let parsed: UsageLedger;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as UsageLedger;
  } catch (e) {
    throw new ToolError({
      api: 'media',
      code: 'LEDGER_UNREADABLE',
      message: `The usage ledger at ${file} could not be read: ${(e as Error).message}`,
      hint: 'Restore it from a backup. Deleting it loses the record of which media you have already published, and byline will start reusing images.',
    });
  }

  if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
    throw new ToolError({
      api: 'media',
      code: 'LEDGER_UNREADABLE',
      message: `The usage ledger at ${file} is not in a format this version understands.`,
      hint: 'Restore it from a backup rather than deleting it — deleting it loses which media you have already published.',
    });
  }

  return parsed;
}

export function writeLedger(file: string, ledger: UsageLedger): void {
  writeAtomic(file, ledger);
}
