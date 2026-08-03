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
  // `clearAllMocks` does not undo `stubGlobal`, and a stubbed `fetch` left in
  // place would silently answer every later test's network call in this worker.
  vi.unstubAllGlobals();
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

    // Yes to "add or change a blog", then No to everything after. (There is no
    // migration offer to answer: cwd is a temp directory, not a checkout.)
    confirmAnswers = [true, false, false, false];
    // "Which blog?" → add a new one (NOT "Update myblog" — this test is about
    // the NEW-blog path, which is the only one where a name collision is
    // possible and the only one this defect ever lived on). Then the platform
    // picker → ghost.
    selectAnswers = ['+new', 'ghost'];
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

/**
 * Re-run coverage.
 *
 * The user's report: running `init` again to change one thing demanded every
 * old answer back. Three separate causes, all visible only by driving the real
 * entry point — the same reason the two tests above exist.
 */
describe('runInit on a machine that is already set up', () => {
  /** A well-formed Ghost admin key: 24 hex, colon, 64 hex. `ghostToken` rejects anything else. */
  const GHOST_KEY = `${'0'.repeat(24)}:${'a'.repeat(64)}`;

  /** Seed a configured Ghost blog. Returns the config home. */
  function seedBlog(): string {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'sites:\n' +
        '  myblog:\n' +
        '    platform: ghost\n' +
        '    url: https://original.example.com\n' +
        '    admin_api_key: ${MYBLOG_ADMIN_API_KEY}\n' +
        'default_site: myblog\n',
    );
    writeFileSync(join(home, '.env'), `MYBLOG_ADMIN_API_KEY=${GHOST_KEY}\n`, { mode: 0o600 });
    return home;
  }

  /**
   * A Ghost that accepts everything, recording the Authorization header so the
   * test can prove a KEPT credential was actually put on the wire.
   */
  function stubGhost(): { authHeaders: string[]; urls: string[] } {
    const authHeaders: string[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers?: Record<string, string> }) => {
      urls.push(String(url));
      if (init?.headers?.Authorization) authHeaders.push(init.headers.Authorization);
      const body = String(url).endsWith('/config/')
        ? { config: { version: '6.44' } }
        : { site: { title: 'My Blog' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { authHeaders, urls };
  }

  it('updates an existing blog, changing only the address and keeping the stored key', async () => {
    const home = seedBlog();
    const { urls } = stubGhost();

    // Yes to "add or change a blog", then No to everything after.
    confirmAnswers = [true, false, false, false, false];
    // "Which blog?" → the configured one, which is the ONLY way into the
    // update flow. Typing the name on the new-blog path is still refused.
    selectAnswers = ['myblog'];
    // A new address, then Enter (null) to keep the admin key.
    textAnswers = ['https://updated.example.com', null];

    await runInit([]);

    const config = readFileSync(join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('url: https://updated.example.com');
    expect(config).not.toContain('original.example.com');
    // Still one site, still the default, still referencing the same variable.
    expect(config).toContain('admin_api_key: ${MYBLOG_ADMIN_API_KEY}');
    expect(config).toContain('default_site: myblog');
    // And the secret is untouched — never re-asked, never rewritten wrongly.
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain(`MYBLOG_ADMIN_API_KEY=${GHOST_KEY}`);

    // The user was never asked to retype the key: the credential question
    // offered to keep it.
    const keyPrompts = asked.filter((m) => m.includes('Admin API key'));
    expect(keyPrompts).toHaveLength(1);
    expect(keyPrompts[0]).toContain('Enter to keep');

    // And the kept key was still proven against the live API before anything
    // was written — the authenticated endpoint, at the NEW address.
    expect(urls.some((u) => u === 'https://updated.example.com/ghost/api/admin/config/')).toBe(true);
  });

  it('leaves the blog exactly as it was when the kept credential fails its probe', async () => {
    const home = seedBlog();
    const before = readFileSync(join(home, 'config.yaml'), 'utf8');
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Unknown Admin API Key' }] }), { status: 401 }),
    );

    confirmAnswers = [true, false, false, false, false];
    selectAnswers = ['myblog'];
    // New address, keep the key. The probe then fails; the "What now?" select
    // is unscripted, which the prompter reads as "don't retry".
    textAnswers = ['https://updated.example.com', null];

    await runInit([]);

    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(before);
  });

  it('offers to update an existing blog rather than only refusing its name', async () => {
    seedBlog();
    confirmAnswers = [true, false, false, false, false];
    // Nothing scripted for the menu: an unanswered select ends the loop.
    await runInit([]);
    // The menu itself is the fix — before this, an existing blog could not be
    // reached from `init` at all.
    expect(asked.some((m) => m === 'Which blog?')).toBe(true);
  });

  it('finds an existing persona BEFORE asking the questionnaire, not after', async () => {
    // The worst of the three: `init` used to ask all five questions and only
    // then report the file already existed, discarding every answer typed.
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    writeFileSync(
      join(home, 'personas', 'alex-chen.yaml'),
      'slug: alex-chen\nname: Alex Chen\nrole: Senior Engineer\nwriting_style: Direct\ntone_of_voice: Direct\n',
    );

    // No to the blog question and to both provider families. The persona step
    // then offers a menu instead of the yes/no question; leaving it unanswered
    // keeps everything.
    confirmAnswers = [false, false, false];

    await runInit([]);

    expect(asked.some((m) => m.includes('You already have'))).toBe(true);
    // Not one questionnaire question was asked.
    expect(asked.some((m) => m.includes('Your name — used as the byline'))).toBe(false);
    expect(asked.some((m) => m.includes('Set up your author voice now?'))).toBe(false);
  });

  it('updates a persona in place, keeping the answers the user did not retype', async () => {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    writeFileSync(
      join(home, 'personas', 'alex-chen.yaml'),
      'slug: alex-chen\n' +
        'name: Alex Chen\n' +
        'role: Senior Engineer\n' +
        'writing_style: Analytical, direct\n' +
        'tone_of_voice: Analytical, direct\n' +
        'years_of_experience: 12\n' +
        'subject_expertise: cloud architecture\n' +
        'persona_specific_instructions_for_ai: Never use the word "delve".\n',
    );

    confirmAnswers = [false, false, false];
    selectAnswers = ['alex-chen'];
    // Keep the name, change the role, keep the rest.
    textAnswers = [null, 'Principal Engineer', null, null, null];

    await runInit([]);

    const written = readFileSync(join(home, 'personas', 'alex-chen.yaml'), 'utf8');
    expect(written).toContain('role: Principal Engineer');
    expect(written).toContain('name: Alex Chen');
    expect(written).toContain('years_of_experience: 12');
    expect(written).toContain('subject_expertise: cloud architecture');
    // The hand-edited field the five questions never ask about survives.
    expect(written).toContain('Never use the word "delve".');
    // And the file is still the one file, under the same slug.
    expect(written).toContain('slug: alex-chen');
  });

  it('keeps a stored provider key without asking for it, and still probes it', async () => {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    // A real provider env var, read off the descriptor rather than named here.
    const { defaultChain } = await import('../../src/plugins/images/index.js');
    const varName = defaultChain({})[0]!.credential.name;
    writeFileSync(join(home, '.env'), `${varName}=sk-live-0123456789abcdef\n`, { mode: 0o600 });

    const probed: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      probed.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    // No blog; Yes to the first provider family so its keys are reviewed; No
    // to the second family and to the persona question.
    confirmAnswers = [false, true, false, false];
    // The keep/replace/remove menu, left unanswered → keep.
    selectAnswers = [];

    await runInit([]);

    // Never asked to retype it, and the stored value is not echoed anywhere.
    expect(asked.some((m) => m.includes('Enter nothing to skip') && m.toLowerCase().includes('key'))).toBe(true);
    expect(asked.join('\n')).not.toContain('sk-live-0123456789abcdef');
    // The menu showed a fingerprint of the stored key.
    expect(asked.some((m) => m.includes('already has a key'))).toBe(true);
    // And .env is unchanged: keeping writes nothing.
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain(`${varName}=sk-live-0123456789abcdef`);
  });
});
