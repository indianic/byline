import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.js';

/**
 * End-to-end coverage for the real `runInit`.
 *
 * Both defects covered here were CROSS-FUNCTION: every individual function did
 * exactly what its own unit test said, and the composition was still wrong.
 * That is the class of bug this file exists for, and the only way to see it is
 * to drive the entry point.
 *
 * `@clack/prompts` is mocked so answers can be scripted; stdin/stdout are
 * stubbed as a TTY so `requireTty` does not bail before anything runs; `HOME`
 * is redirected to an empty temp directory so nothing here touches the real
 * machine's `~/.byline` or `~/.claude.json`.
 */

/** Scripted answers, reset per test. `confirm` and `select` pop from these. */
let confirmAnswers: boolean[] = [];
let textAnswers: (string | null)[] = [];
let selectAnswers: unknown[] = [];
/** Every prompt message asked, in order — how a re-prompt is detected. */
let asked: string[] = [];

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  confirm: vi.fn(async (o: { message: string }) => {
    asked.push(o.message);
    return confirmAnswers.length > 0 ? confirmAnswers.shift()! : false;
  }),
  text: vi.fn(async (o: { message: string }) => {
    asked.push(o.message);
    return textAnswers.length > 0 ? (textAnswers.shift() ?? null) : null;
  }),
  password: vi.fn(async (o: { message: string }) => {
    asked.push(o.message);
    return textAnswers.length > 0 ? (textAnswers.shift() ?? null) : null;
  }),
  select: vi.fn(async (o: { message: string }) => {
    asked.push(o.message);
    return selectAnswers.length > 0 ? selectAnswers.shift() : null;
  }),
  multiselect: vi.fn(async () => []),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

const savedEnv = { ...process.env };
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
}

let fakeHome: string;
let savedCwd: string;
let savedStdinTTY: boolean | undefined;
let savedStdoutTTY: boolean | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'wb-init-e2e-'));

  // Move out of the repo before running anything. `detectRepoConfig` looks for
  // `config/sites.yaml` relative to the CURRENT WORKING DIRECTORY, and vitest
  // runs with cwd at the repo root — so without this, `init` offers to migrate
  // the maintainer's real config and, if a prompt answers yes, actually copies
  // their sites and personas into the temp home. The tests still passed that
  // way, which is exactly what made it worth fixing: they were reading real
  // files and answering a prompt nobody meant to be in the script.
  savedCwd = process.cwd();
  process.chdir(fakeHome);

  process.env.HOME = fakeHome;
  delete process.env.BYLINE_HOME;
  delete process.env.BYLINE_SITES;
  delete process.env.BYLINE_PERSONAS;
  delete process.env.BYLINE_ENV;
  delete process.env.BYLINE_RUNS;

  confirmAnswers = [];
  textAnswers = [];
  selectAnswers = [];
  asked = [];

  savedStdinTTY = process.stdin.isTTY;
  savedStdoutTTY = process.stdout.isTTY;
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
});

afterEach(() => {
  vi.clearAllMocks();
  restoreEnv();
  process.chdir(savedCwd);
  process.stdin.isTTY = savedStdinTTY;
  process.stdout.isTTY = savedStdoutTTY;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('runInit', () => {
  /**
   * Finding 2 regression.
   *
   * `init` used to call `ensureHome(paths)` unconditionally before the blog
   * loop, and separately ran `seedPersonaTemplate` unconditionally at the end —
   * so a user who declined every single prompt (no migration copy, no blog, no
   * image generation) still ended up with `~/.byline/` created on disk.
   * `resolvePaths` (src/config/paths.ts) picks `~/.byline/` over a
   * repo-local `config/sites.yaml` checkout the moment the directory exists AT
   * ALL, even empty — so this permanently shadowed a working checkout, and
   * `doctor`'s "you're reading from the repo, run migrate" message (which only
   * prints when `paths.source === 'repo'`) stopped appearing right when it was
   * the one thing that would have explained where the user's config went.
   *
   * With nothing in the temp HOME, `detectInstalledEditors` finds no AI tools,
   * so `promptAndWriteEditorConfigs` returns without needing an answer.
   */
  it('never creates ~/.byline/ when every prompt is declined (Finding 2)', async () => {
    await runInit([]);
    expect(existsSync(join(fakeHome, '.byline'))).toBe(false);
  });

  /**
   * Final-whole-branch-review regression, and the most destructive defect this
   * project shipped.
   *
   * `promptSlug` checked only the slugs added in THIS session's loop, and
   * `writeSiteToConfig` replaced unconditionally — while `add_site`, the OTHER
   * writer of the same file, refused with SITE_EXISTS. The two writers
   * disagreed. Re-adding an existing short name replaced a Ghost site with a
   * WordPress one at a different URL, overwrote its credential variable, and
   * moved `default_site`. No warning, and no way back through the tool.
   *
   * Here the wizard is driven to the blog loop and told to reuse the
   * already-configured slug. `promptSlug` must reject it and re-prompt; the
   * second answer is an empty skip, which ends the loop. The existing site must
   * come through untouched.
   */
  it('does not replace an already-configured blog when its short name is reused', async () => {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    const original =
      'sites:\n' +
      '  myblog:\n' +
      '    platform: ghost\n' +
      '    url: https://original.example.com\n' +
      '    admin_api_key: ${MYBLOG_ADMIN_API_KEY}\n' +
      'default_site: myblog\n';
    writeFileSync(join(home, 'config.yaml'), original);
    writeFileSync(join(home, '.env'), 'MYBLOG_ADMIN_API_KEY=original-key\n', { mode: 0o600 });

    // Yes to "set up a blog", then No to everything after. (There is no
    // migration offer to answer: cwd is a temp directory, not a checkout.)
    confirmAnswers = [true, false, false, false];
    // Platform picker → ghost.
    selectAnswers = ['ghost'];
    // The taken slug, then an empty answer to skip out of the loop.
    textAnswers = ['myblog', null];

    await runInit([]);

    // The load-bearing assertion. `promptSlug` must REJECT the taken name and
    // ask again — so the slug question appears twice, and the run never
    // advances to the address question. Asserting only on the file would pass
    // even with the collision check removed, because the exhausted script
    // skips the site before anything is written; that is a second line of
    // defence, not this defect.
    const slugPrompts = asked.filter((m) => m.includes('Short name for this blog'));
    expect(slugPrompts).toHaveLength(2);
    expect(asked.some((m) => m.includes('Your blog address'))).toBe(false);

    // And the config is byte-identical: not replaced, not reordered, and
    // default_site has not moved.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(original);
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('MYBLOG_ADMIN_API_KEY=original-key');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wordpress');
  });

  /**
   * The other half of the same review finding: `makeDefault` was
   * `added.length === 0`, so the first blog of ANY session stole `default_site`
   * from a migrated site even under a brand-new slug. Declining to add
   * anything must certainly not move it.
   */
  it('leaves default_site alone when no blog is added', async () => {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'sites:\n  first:\n    platform: ghost\n    url: https://first.example.com\n    admin_api_key: ${FIRST_ADMIN_API_KEY}\ndefault_site: first\n',
    );

    await runInit([]);

    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('default_site: first');
  });
});
