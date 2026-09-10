import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { articleLedgerPath, readArticleLedger, writeArticleLedger } from '../../src/articles/store.js';
import type { ArticleLedger } from '../../src/articles/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'bl-articles-store-'));

describe('articleLedgerPath', () => {
  it('joins home, "articles", and "<persona>.json"', () => {
    expect(articleLedgerPath('/home/.byline', 'jane-doe')).toBe('/home/.byline/articles/jane-doe.json');
  });
});

describe('readArticleLedger', () => {
  it('returns an empty ledger with the persona set when the file does not exist', () => {
    const l = readArticleLedger(join(dir(), 'nope.json'), 'jane-doe');
    expect(l).toEqual({ version: 1, persona: 'jane-doe', records: [] });
  });

  it('THROWS LEDGER_UNREADABLE on unparseable JSON', () => {
    const file = join(dir(), 'jane-doe.json');
    writeFileSync(file, '{ not json');
    try {
      readArticleLedger(file, 'jane-doe');
      expect.unreachable('readArticleLedger should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('LEDGER_UNREADABLE');
    }
  });

  it('THROWS LEDGER_UNREADABLE on an unrecognised version', () => {
    const file = join(dir(), 'jane-doe.json');
    writeFileSync(file, JSON.stringify({ version: 99, persona: 'jane-doe', records: [] }));
    expect(() => readArticleLedger(file, 'jane-doe')).toThrow(/LEDGER_UNREADABLE|not in a format/i);
  });

  it('THROWS LEDGER_UNREADABLE naming the record index and field when a record lacks recorded_at', () => {
    const file = join(dir(), 'jane-doe.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        persona: 'jane-doe',
        records: [
          {
            id: 'personal:1',
            persona: 'jane-doe',
            site: 'personal',
            platform: 'ghost',
            post_id: '1',
            url: 'https://blog.example.com/first/',
            title: 'First article',
            tags: ['ai'],
            status: 'published',
            // recorded_at deliberately omitted
            shares: [],
          },
        ],
      }),
    );
    try {
      readArticleLedger(file, 'jane-doe');
      expect.unreachable('readArticleLedger should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('LEDGER_UNREADABLE');
      expect((e as ToolError).message).toContain('record 0');
      expect((e as ToolError).message).toContain('recorded_at');
    }
  });

  it('round-trips records written by writeArticleLedger', () => {
    const file = join(dir(), 'jane-doe.json');
    const ledger: ArticleLedger = {
      version: 1,
      persona: 'jane-doe',
      records: [
        {
          id: 'personal:1',
          persona: 'jane-doe',
          site: 'personal',
          platform: 'ghost',
          post_id: '1',
          url: 'https://blog.example.com/first/',
          title: 'First article',
          tags: ['ai'],
          status: 'published',
          recorded_at: '2026-09-01T00:00:00.000Z',
          shares: [],
        },
      ],
    };
    writeArticleLedger(file, ledger);
    expect(readArticleLedger(file, 'jane-doe')).toEqual(ledger);
  });
});
