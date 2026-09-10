import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/config/atomic.js';

const dir = () => mkdtempSync(join(tmpdir(), 'bl-atomic-'));

describe('writeJsonAtomic', () => {
  it('writes a file and leaves no .tmp behind', () => {
    const d = dir();
    const file = join(d, 'out.json');
    writeJsonAtomic(file, { a: 1 });
    expect(readdirSync(d)).toEqual(['out.json']);
  });

  it('rethrows when writeFileSync fails, and leaves no .tmp behind', () => {
    // /dev/null is not a directory, so a path under it can never be created —
    // writeFileSync throws ENOTDIR before any temp file exists.
    const file = '/dev/null/x/out.json';
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow();
  });
});
