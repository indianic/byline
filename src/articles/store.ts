import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../config/atomic.js';
import { ToolError } from '../errors.js';
import type { ArticleLedger } from './types.js';

/** `<byline home>/articles/<persona>.json` — one ledger per persona. */
export function articleLedgerPath(home: string, persona: string): string {
  return join(home, 'articles', `${persona}.json`);
}

/**
 * Read a persona's article ledger, or an empty one if it has never been
 * written.
 *
 * Mirrors `media/store.ts`'s `readLedger` rules exactly, for the same reason:
 * a missing ledger is a brand-new persona and an empty history is the honest
 * answer, but a CORRUPT one is unrecoverable memory of what this persona has
 * already published. Continuing with an empty ledger there would silently let
 * a brief repeat a hook, an example, or a keyword it should be avoiding, and
 * report success while doing it. Loud beats tidy.
 */
export function readArticleLedger(file: string, persona: string): ArticleLedger {
  if (!existsSync(file)) return { version: 1, persona, records: [] };

  let parsed: ArticleLedger;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as ArticleLedger;
  } catch (e) {
    throw new ToolError({
      api: 'articles',
      code: 'LEDGER_UNREADABLE',
      message: `The article ledger at ${file} could not be read: ${(e as Error).message}`,
      hint: 'Restore it from a backup. Deleting it loses the record of what this persona has already published, and briefs will start repeating shapes and keywords.',
    });
  }

  if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
    throw new ToolError({
      api: 'articles',
      code: 'LEDGER_UNREADABLE',
      message: `The article ledger at ${file} is not in a format this version understands.`,
      hint: 'Restore it from a backup rather than deleting it — deleting it loses what this persona has already published.',
    });
  }

  const isNonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
  const fieldChecks: Array<[field: string, valid: (v: unknown) => boolean]> = [
    ['id', isNonEmptyString],
    ['persona', isNonEmptyString],
    ['site', isNonEmptyString],
    ['url', isNonEmptyString],
    ['title', isNonEmptyString],
    ['recorded_at', (v) => typeof v === 'string'],
    ['tags', Array.isArray],
    ['shares', Array.isArray],
  ];
  parsed.records.forEach((record, index) => {
    const r = record as unknown as Record<string, unknown>;
    for (const [field, valid] of fieldChecks) {
      if (!valid(r[field])) {
        throw new ToolError({
          api: 'articles',
          code: 'LEDGER_UNREADABLE',
          message: `The article ledger at ${file} is not in a format this version understands: record ${index} has an invalid "${field}".`,
          hint: 'Restore it from a backup rather than deleting it — deleting it loses what this persona has already published.',
        });
      }
    }
  });

  return parsed;
}

export function writeArticleLedger(file: string, ledger: ArticleLedger): void {
  writeJsonAtomic(file, ledger);
}
