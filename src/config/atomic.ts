import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write via a temp file and rename.
 *
 * `renameSync` within one filesystem is atomic, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. Writing in place would make
 * an interrupted `scan` destroy the index it was rebuilding — recoverable — and
 * an interrupted ledger write destroy usage history, which is not.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
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
