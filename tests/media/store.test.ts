import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { readIndex, readLedger, writeIndex, writeLedger } from '../../src/media/store.js';
import type { MediaIndex, UsageLedger } from '../../src/media/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'bl-store-'));

const INDEX: MediaIndex = {
  version: 1,
  library: 'shots',
  root: '/tmp/shots',
  scanned_at: '2026-08-11T00:00:00.000Z',
  assets: [],
};

const LEDGER: UsageLedger = { version: 1, library: 'shots', records: [] };

describe('readIndex', () => {
  it('returns null when the file does not exist', () => {
    expect(readIndex(join(dir(), 'nope.json'))).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', () => {
    const file = join(dir(), 'i.json');
    writeFileSync(file, '{ not json');
    expect(readIndex(file)).toBeNull();
  });

  it('returns null for a version it does not understand', () => {
    const file = join(dir(), 'i.json');
    writeFileSync(file, JSON.stringify({ ...INDEX, version: 99 }));
    expect(readIndex(file)).toBeNull();
  });

  it('round-trips a written index', () => {
    const file = join(dir(), 'i.json');
    writeIndex(file, INDEX);
    expect(readIndex(file)).toEqual(INDEX);
  });
});

describe('writeIndex', () => {
  it('creates the parent directory', () => {
    const file = join(dir(), 'deep', 'nested', 'i.json');
    writeIndex(file, INDEX);
    expect(readIndex(file)).toEqual(INDEX);
  });

  it('leaves no temp file behind', () => {
    const d = dir();
    writeIndex(join(d, 'i.json'), INDEX);
    expect(readdirSync(d)).toEqual(['i.json']);
  });
});

describe('readLedger', () => {
  it('returns an empty ledger when the file does not exist', () => {
    const l = readLedger(join(dir(), 'nope.json'), 'shots');
    expect(l).toEqual({ version: 1, library: 'shots', records: [] });
  });

  it('THROWS on unparseable JSON instead of returning empty', () => {
    const file = join(dir(), 'u.json');
    writeFileSync(file, '{ not json');
    expect(() => readLedger(file, 'shots')).toThrow(/could not be read/i);
  });

  it('round-trips records', () => {
    const file = join(dir(), 'u.json');
    const l: UsageLedger = {
      ...LEDGER,
      records: [
        {
          id: 'sha256:a',
          site: 'personal',
          state: 'reserved',
          hosted_url: 'https://x/1.png',
          at: '2026-08-11T00:00:00.000Z',
        },
      ],
    };
    writeLedger(file, l);
    expect(readLedger(file, 'shots')).toEqual(l);
  });

  it('THROWS with LEDGER_UNREADABLE and a hint when version is not 1', () => {
    const file = join(dir(), 'u.json');
    writeFileSync(file, JSON.stringify({ ...LEDGER, version: 99 }));
    try {
      readLedger(file, 'shots');
      expect.unreachable('readLedger should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe('LEDGER_UNREADABLE');
      expect(err.hint).toBeTruthy();
    }
  });

  it('THROWS with LEDGER_UNREADABLE and a hint when records is not an array', () => {
    const file = join(dir(), 'u.json');
    writeFileSync(file, JSON.stringify({ version: 1, library: 'shots', records: {} }));
    try {
      readLedger(file, 'shots');
      expect.unreachable('readLedger should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe('LEDGER_UNREADABLE');
      expect(err.hint).toBeTruthy();
    }
  });

  it('THROWS with LEDGER_UNREADABLE and a hint when records is missing entirely', () => {
    const file = join(dir(), 'u.json');
    writeFileSync(file, JSON.stringify({ version: 1, library: 'shots' }));
    try {
      readLedger(file, 'shots');
      expect.unreachable('readLedger should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe('LEDGER_UNREADABLE');
      expect(err.hint).toBeTruthy();
    }
  });
});

describe('writeAtomic (via writeLedger) failure cleanup', () => {
  it('removes the .tmp file and rethrows the original error when renameSync fails', () => {
    const d = dir();
    const file = join(d, 'target.json');
    // Force renameSync(tmp, file) to fail deterministically: make the
    // destination path an existing directory, so writeFileSync(tmp, ...)
    // succeeds but renameSync fails with EISDIR.
    mkdirSync(file);

    let thrown: unknown;
    try {
      writeLedger(file, LEDGER);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as NodeJS.ErrnoException).code).toBe('EISDIR');

    const entries = readdirSync(d);
    expect(entries).not.toContain('target.json.tmp');
  });
});
