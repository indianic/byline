import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMedia } from '../../src/cli/media.js';

let out: string;
const saved: Record<string, string | undefined> = {};
let savedExitCode: number | string | undefined | null;

function setEnv(k: string, v: string) {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(() => {
  out = '';
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore the process's own exit code: these tests assert on it deliberately,
  // and leaving a 1 behind would fail the whole run for an unrelated reason.
  process.exitCode = savedExitCode;
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

// ---------------------------------------------------------------------------
// Findings from the whole-branch review, each reproduced against the binary
// before it was fixed. Every one of these went green only after the fix.
// ---------------------------------------------------------------------------

/**
 * A config naming a library whose folder is NOT reachable, plus a ledger for it
 * under byline's own home.
 *
 * This is the shape the two "unavailable" findings turn on: the library folder
 * is gone, but the ledger never lived inside it — it is under `<home>/media/`,
 * so every reservation it holds is still perfectly readable.
 */
function unavailableWithReservation(dir: string, name: string, id: string, site = 'blog'): string {
  writeFileSync(
    join(dir, 'config.yaml'),
    `sites: {}\nmedia:\n  libraries:\n    - name: ${name}\n      path: /nope/nowhere\n`,
  );
  const ledgerFile = join(dir, 'media', `${name}.usage.json`);
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(
    ledgerFile,
    JSON.stringify({
      version: 1,
      library: name,
      records: [
        {
          id,
          site,
          state: 'reserved',
          hosted_url: 'https://example.com/stuck.png',
          at: new Date().toISOString(),
        },
      ],
    }),
  );
  return ledgerFile;
}

describe('byline media add — when the first scan fails', () => {
  /**
   * `<home>/media` is created as a FILE, so the mkdir inside `writeIndex`
   * fails for real. Same shape as the reviewer's unwritable `~/.byline/media`,
   * with no filesystem mock.
   */
  function breakIndexWrites(dir: string): void {
    writeFileSync(join(dir, 'media'), 'not a directory');
  }

  it('SAYS THE LIBRARY WAS ADDED rather than reporting the whole command as a failure', async () => {
    const dir = home();
    breakIndexWrites(dir);
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);

    expect(out).toMatch(/added/i);
    // The config write already happened, so the entry must be in the file and
    // the user must be told — otherwise the obvious retry hits LIBRARY_EXISTS.
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media.libraries).toHaveLength(1);
    expect(out).not.toMatch(/media command failed/);
  });

  it('still prints the restart notice, because config.yaml WAS written', async () => {
    const dir = home();
    breakIndexWrites(dir);
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    expect(out).toMatch(/restart/i);
  });

  it('names the error and points at `byline media scan <name>` to finish', async () => {
    const dir = home();
    breakIndexWrites(dir);
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    expect(out).toMatch(/byline media scan shots/);
    expect(out).toMatch(/EEXIST|ENOTDIR|not a directory/i);
    expect(process.exitCode).toBe(1);
  });
});

describe('byline media add — --index-path', () => {
  it('writes index_path, and puts the index there rather than under byline home', async () => {
    const dir = home();
    const idx = mkdtempSync(join(tmpdir(), 'bl-idx-'));
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots', '--index-path', idx]);
    const cfg = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
    expect(cfg.media.libraries[0].index_path).toBe(idx);
    expect(readFileSync(join(idx, 'shots.index.json'), 'utf8')).toMatch(/"assets"/);
  });

  it('refuses an index path inside the library folder — byline never writes in there', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    await runMedia(['add', root, '--name', 'shots', '--index-path', join(root, 'idx')]);
    expect(out).toMatch(/never write/i);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('byline media — unrecognised flags', () => {
  it('refuses a mistyped flag by name instead of silently doing nothing', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots', '--defualt']);
    expect(out).toMatch(/--defualt/);
    expect(process.exitCode).toBe(1);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media).toBeUndefined();
  });

  it('refuses a flag that belongs to a different subcommand', async () => {
    home();
    await runMedia(['list', '--yes']);
    expect(out).toMatch(/--yes/);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a value-taking flag given no value', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name']);
    expect(out).toMatch(/--name/);
    expect(process.exitCode).toBe(1);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media).toBeUndefined();
  });

  it('does not mistake a flag VALUE for a flag', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots', '--no-recursive']);
    const cfg = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
    expect(cfg.media.libraries[0].name).toBe('shots');
    expect(cfg.media.libraries[0].recursive).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});

describe('byline media scan — exit code and what "unchanged" means', () => {
  it('EXITS NON-ZERO when a library fails, so a script can tell', async () => {
    home();
    await runMedia(['scan', 'nosuchlib']);
    expect(process.exitCode).toBe(1);
    expect(out).not.toMatch(/Scan complete/);
    expect(out).toMatch(/1 librar/i);
  });

  it('exits 0 and says complete when every library scanned', async () => {
    home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    out = '';
    await runMedia(['scan']);
    expect(process.exitCode).toBe(0);
    expect(out).toMatch(/Scan complete/);
  });

  it('keeps scanning the rest after one library fails', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    // A broken library alongside a good one.
    writeFileSync(
      join(dir, 'config.yaml'),
      `sites: {}\nmedia:\n  libraries:\n    - name: shots\n      path: ${root}\n    - name: gone\n      path: /nope/nowhere\n`,
    );
    out = '';
    await runMedia(['scan']);
    expect(out).toMatch(/shots/);
    expect(out).toMatch(/gone/);
    expect(process.exitCode).toBe(1);
  });

  it('DOES NOT call a file whose bytes changed "unchanged"', async () => {
    home();
    const root = libraryDir(['a.png', 'b.png']);
    await runMedia(['add', root, '--name', 'shots']);
    // Appending bytes changes the content hash, so the asset's id changes and
    // its ledger record no longer refers to it. Reporting that as "unchanged"
    // is what hid the detachment.
    appendFileSync(join(root, 'a.png'), 'more-bytes');
    out = '';
    await runMedia(['scan', 'shots']);
    expect(out).toMatch(/1 changed/);
    expect(out).toMatch(/1 unchanged/);
    expect(out).not.toMatch(/2 unchanged/);
  });
});

describe('byline media status — an unavailable library', () => {
  it('REPORTS its stale reservations: the ledger is not inside the library folder', async () => {
    const dir = home();
    unavailableWithReservation(dir, 'archive', 'sha256:stuck');
    await runMedia(['status']);
    expect(out).toMatch(/archive/);
    expect(out).toMatch(/1 stale reservation/);
  });

  it('says the ledger itself is unreachable rather than inventing a zero', async () => {
    const dir = home();
    writeFileSync(
      join(dir, 'config.yaml'),
      'sites: {}\nmedia:\n  libraries:\n    - name: archive\n      path: /nope/nowhere\n      index_path: /nope/also-nowhere\n',
    );
    await runMedia(['status']);
    expect(out).not.toMatch(/0 stale reservations/);
    expect(out).toMatch(/cannot be counted|not reachable/i);
  });
});

describe('byline media release — from an unavailable library', () => {
  it('clears the reservation: nothing about it needs the library folder', async () => {
    const dir = home();
    const ledgerFile = unavailableWithReservation(dir, 'archive', 'sha256:stuck');
    await runMedia(['release', 'sha256:stuck', '--library', 'archive']);
    expect(out).toMatch(/released/i);
    expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).records).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });

  it('still says the library folder is unavailable, rather than pretending it is fine', async () => {
    const dir = home();
    unavailableWithReservation(dir, 'archive', 'sha256:stuck');
    await runMedia(['release', 'sha256:stuck', '--library', 'archive']);
    expect(out).toMatch(/does not exist/i);
  });
});

describe('byline media release — what it says about reuse afterwards', () => {
  function ledgerWith(dir: string, records: unknown[]): string {
    const file = join(dir, 'media', 'shots.usage.json');
    mkdirSync(join(dir, 'media'), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, library: 'shots', records }));
    return file;
  }

  it('names the site the reservation belonged to', async () => {
    const dir = home();
    await runMedia(['add', libraryDir(['a.png']), '--name', 'shots']);
    ledgerWith(dir, [
      {
        id: 'sha256:x',
        site: 'personal',
        state: 'reserved',
        hosted_url: 'https://example.com/x.png',
        at: new Date().toISOString(),
      },
    ]);
    out = '';
    await runMedia(['release', 'sha256:x', '--library', 'shots']);
    expect(out).toMatch(/personal/);
    expect(out).toMatch(/free for use_media/);
  });

  it('DOES NOT claim it is free again when a published record for the same id survives', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    writeFileSync(
      join(dir, 'config.yaml'),
      `sites: {}\nmedia:\n  reuse_scope: global\n  libraries:\n    - name: shots\n      path: ${root}\n`,
    );
    ledgerWith(dir, [
      {
        id: 'sha256:x',
        site: 'personal',
        state: 'published',
        hosted_url: 'https://example.com/x.png',
        post_url: 'https://example.com/p/1',
        at: new Date().toISOString(),
      },
      {
        id: 'sha256:x',
        site: 'work',
        state: 'reserved',
        hosted_url: 'https://example.com/x2.png',
        at: new Date().toISOString(),
      },
    ]);
    out = '';
    await runMedia(['release', 'sha256:x', '--library', 'shots']);
    expect(out).toMatch(/released/i);
    expect(out).toMatch(/not free|still/i);
    expect(out).not.toMatch(/It is free for use_media again\./);
  });
});

describe('byline media remove — reporting what actually happened', () => {
  it('reports the removal only when the config write actually removed something', async () => {
    const dir = home();
    const root = libraryDir(['a.png']);
    await runMedia(['add', root, '--name', 'shots']);
    out = '';
    await runMedia(['remove', 'shots', '--yes']);
    expect(out).toMatch(/Removed "shots" from config.yaml/);
    expect(parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).media.libraries).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });
});
