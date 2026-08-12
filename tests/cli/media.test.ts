import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMedia } from '../../src/cli/media.js';

let out: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(() => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore per key. Never `process.env = { ...saved }` — that detaches the
  // object from the process environment and os.homedir() goes stale for every
  // later test in this worker.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bl-cli-'));
  writeFileSync(join(dir, 'config.yaml'), 'sites: {}\n');
  setEnv('BYLINE_HOME', dir);
  return dir;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function libraryDir(files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'bl-photos-'));
  for (const rel of files) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), PNG);
  }
  return root;
}

describe('byline media add', () => {
  it('writes the library into config.yaml', async () => {
    const dir = home();
    const root = libraryDir();
    await runMedia(['add', root]);
    const cfg = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
    expect(cfg.media.libraries[0].path).toBe(root);
  });

  it('derives the library name from the folder when --name is omitted', async () => {
    const dir = home();
    const root = libraryDir();
    await runMedia(['add', root]);
    const cfg = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
    expect(cfg.media.libraries[0].name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('honours an explicit --name', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(), '--name', 'holiday-shots']);
    const cfg = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
    expect(cfg.media.libraries[0].name).toBe('holiday-shots');
  });

  it('TELLS THE USER a running MCP server will not see it until restart', async () => {
    home();
    await runMedia(['add', libraryDir()]);
    expect(out).toMatch(/restart/i);
  });

  it('scans immediately so the library is usable without a second command', async () => {
    home();
    await runMedia(['add', libraryDir(['a.png', 'b/c.png'])]);
    expect(out).toMatch(/2/);
  });

  it('reports a missing folder without a stack trace', async () => {
    home();
    await runMedia(['add', '/nope/nowhere']);
    expect(out).toMatch(/does not exist/i);
    expect(out).not.toMatch(/at Object\.|node:internal/);
  });
});

describe('byline media list', () => {
  it('says plainly when nothing is configured, and how to fix it', async () => {
    home();
    await runMedia(['list']);
    expect(out).toMatch(/none configured/i);
    expect(out).toMatch(/byline media add/);
  });

  it('shows counts after an add', async () => {
    home();
    await runMedia(['add', libraryDir(['a.png', 'b.png', 'c.png'])]);
    out = '';
    await runMedia(['list']);
    expect(out).toMatch(/3/);
  });

  it('shows a broken library WITH its reason rather than hiding it', async () => {
    const dir = home();
    writeFileSync(
      join(dir, 'config.yaml'),
      'sites: {}\nmedia:\n  libraries:\n    - name: gone\n      path: /nope/nowhere\n',
    );
    await runMedia(['list']);
    expect(out).toMatch(/gone/);
    expect(out).toMatch(/does not exist/i);
  });
});

describe('byline media remove', () => {
  it('requires --yes before forgetting a library', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(), '--name', 'shots']);
    out = '';
    await runMedia(['remove', 'shots']);
    expect(out).toMatch(/--yes/);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media.libraries).toHaveLength(1);
  });

  it('removes with --yes and says the folder was left alone', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    await runMedia(['add', root, '--name', 'shots']);
    out = '';
    await runMedia(['remove', 'shots', '--yes']);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media.libraries).toHaveLength(0);
    expect(out).toMatch(/not deleted|left|untouched/i);
    expect(readFileSync(join(root, 'a.png')).length).toBeGreaterThan(0);
  });
});

describe('byline media <unknown>', () => {
  it('names the valid subcommands instead of failing blankly', async () => {
    home();
    await runMedia(['frobnicate']);
    expect(out).toMatch(/add/);
    expect(out).toMatch(/list/);
  });
});

// The brief's own test code (above, verbatim) covers add/list/remove/unknown
// only, even though the brief's prose calls for scan, status, and release too.
// `release` in particular is the subcommand the brief says matters most — a
// reservation stuck by a failed publish had no remedy but hand-editing JSON —
// so leaving it untested here would repeat exactly the "shipped, exported,
// unreachable" pattern this task exists to close. These fill that gap without
// touching anything the brief specified.

describe('byline media scan', () => {
  it('reports added/removed/unchanged for a rescan', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    await runMedia(['add', root, '--name', 'shots']);
    writeFileSync(join(root, 'b.png'), PNG);
    out = '';
    await runMedia(['scan', 'shots']);
    expect(out).toMatch(/1 added/);
    expect(out).toMatch(/shots/);
  });

  it('names an unknown library rather than crashing', async () => {
    home();
    await runMedia(['scan', 'nope']);
    expect(out).toMatch(/no media library named "nope"/i);
    expect(out).not.toMatch(/at Object\.|node:internal/);
  });
});

describe('byline media status', () => {
  it('reports index and ledger file locations', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    out = '';
    await runMedia(['status']);
    expect(out).toMatch(/shots/);
    expect(out).toMatch(/index:/);
    expect(out).toMatch(/ledger:/);
    expect(out).toMatch(join(dir, 'media', 'shots.index.json'));
    expect(out).toMatch(join(dir, 'media', 'shots.usage.json'));
  });
});

describe('byline media release', () => {
  it('clears a reservation stuck by a failed publish', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    const ledgerFile = join(dir, 'media', 'shots.usage.json');
    writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        library: 'shots',
        records: [
          {
            id: 'sha256:stuck',
            site: 'blog',
            state: 'reserved',
            hosted_url: 'https://example.com/stuck.png',
            at: new Date().toISOString(),
          },
        ],
      }),
    );

    out = '';
    await runMedia(['release', 'sha256:stuck', '--library', 'shots']);

    expect(out).toMatch(/released/i);
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    expect(ledger.records).toHaveLength(0);
  });

  it('leaves a published record alone and says nothing changed', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    const ledgerFile = join(dir, 'media', 'shots.usage.json');
    writeFileSync(
      ledgerFile,
      JSON.stringify({
        version: 1,
        library: 'shots',
        records: [
          {
            id: 'sha256:live',
            site: 'blog',
            state: 'published',
            hosted_url: 'https://example.com/live.png',
            post_url: 'https://example.com/posts/live',
            at: new Date().toISOString(),
          },
        ],
      }),
    );

    out = '';
    await runMedia(['release', 'sha256:live', '--library', 'shots']);

    expect(out).toMatch(/nothing changed/i);
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].state).toBe('published');
  });

  it('says plainly when there is nothing to release for that id', async () => {
    home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    out = '';
    await runMedia(['release', 'sha256:neverwas', '--library', 'shots']);
    expect(out).toMatch(/nothing changed/i);
  });
});
