import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../../src/context.js';

function home(configYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bl-ctx-'));
  writeFileSync(join(dir, 'config.yaml'), configYaml);
  return dir;
}

describe('loadContext media', () => {
  it('exposes an empty media config when none is set', () => {
    const dir = home('sites: {}\n');
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.media.libraries).toEqual({});
    expect(ctx.media.reuseScope).toBe('site');
  });

  it('exposes a configured library', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl-ctx-'));
    const shots = join(dir, 'shots');
    mkdirSync(shots, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${shots}\n`,
    );
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.media.libraries.shots?.path).toBe(shots);
  });

  it('folds a broken library into setup problems without throwing', () => {
    const dir = home('sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: /nope/nowhere\n');
    const ctx = loadContext({ BYLINE_HOME: dir });
    expect(ctx.setup.problems.join(' ')).toMatch(/does not exist/i);
  });
});
