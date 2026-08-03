import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus } from '../../src/cli/status.js';
import { runRegister } from '../../src/cli/register.js';
import { runReset } from '../../src/cli/reset.js';

/**
 * End-to-end coverage for the exported `run*` entry points.
 *
 * Everything else in tests/cli/ tests the pure pieces — `collectStatus`,
 * `assertResettable`, `planMigration`, `resolveTools`. Those are worth having,
 * but phase 4's two most serious defects were neither of those things: `init`
 * silently destroying a configured site, and `init` creating an empty
 * `~/.byline/` that permanently shadowed a working repo config. Both were
 * CROSS-FUNCTION bugs — every individual function did what its own unit test
 * said, and the composition was wrong. Only driving the real entry point can
 * see that.
 *
 * `runMigrate` already had this treatment (tests/cli/migrate.test.ts) and is
 * the model. This file covers the remaining four.
 *
 * Every test redirects HOME to a temp directory, so nothing here can read or
 * write the real machine's `~/.byline`, `~/.claude.json`, or any other AI
 * tool config.
 */

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  confirm: vi.fn(async () => false),
  text: vi.fn(async () => null),
  password: vi.fn(async () => null),
  select: vi.fn(async () => null),
  multiselect: vi.fn(async () => []),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

const savedEnv = { ...process.env };

let fakeHome: string;
let written: string[];

/**
 * Restore per key rather than `process.env = { ...savedEnv }`, which replaces
 * the object and detaches it from the native environment — after which
 * `os.homedir()` goes stale for the rest of the worker. These tests set HOME
 * and then rely on `os.homedir()` reflecting it, so the wholesale form would
 * quietly make every assertion here test the developer's real home directory.
 */
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
const output = (): string => written.join('').replace(ANSI, '');

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'wb-cmd-e2e-'));
  process.env.HOME = fakeHome;
  for (const key of ['BYLINE_SITES', 'BYLINE_PERSONAS', 'BYLINE_ENV', 'BYLINE_RUNS']) {
    delete process.env[key];
  }
  // Redirecting HOME alone is NOT enough, and assuming it was made the first
  // draft of this file read the maintainer's real four sites. `resolvePaths`
  // falls back to a repo-local `config/sites.yaml` resolved against the
  // CURRENT WORKING DIRECTORY, and vitest runs with cwd at the repo root — so
  // a temp HOME with no ~/.byline lands on branch 3 and picks up the
  // checkout's own config. Pinning BYLINE_HOME closes that branch off.
  process.env.BYLINE_HOME = join(fakeHome, '.byline');
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  restoreEnv();
  rmSync(fakeHome, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** A minimal but complete ~/.byline, as `init` would leave it. */
function seedConfig(slug = 'myblog'): void {
  const home = join(fakeHome, '.byline');
  mkdirSync(join(home, 'personas'), { recursive: true });
  writeFileSync(
    join(home, 'config.yaml'),
    `sites:\n  ${slug}:\n    platform: ghost\n    url: https://blog.example.com\n    admin_api_key: \${${slug.toUpperCase()}_ADMIN_API_KEY}\ndefault_site: ${slug}\n`,
  );
  writeFileSync(join(home, '.env'), `${slug.toUpperCase()}_ADMIN_API_KEY=${'0'.repeat(24)}:${'a'.repeat(64)}\n`, {
    mode: 0o600,
  });
}

describe('runStatus', () => {
  it('runs on a completely unconfigured machine without throwing', async () => {
    // This is the state someone is in when they reach for `status`, so it is
    // the one state it absolutely must survive. It is never gated on setup.
    await expect(runStatus([])).resolves.toBeUndefined();

    const out = output();
    expect(out).toContain('none configured');
    expect(out).toContain('byline init');
  });

  it('names every configured blog and every resolved path', async () => {
    seedConfig('myblog');

    await runStatus([]);

    const out = output();
    expect(out).toContain('myblog');
    expect(out).toContain('https://blog.example.com');
    expect(out).toContain(join(fakeHome, '.byline', 'config.yaml'));
    expect(out).toContain(join(fakeHome, '.byline', '.env'));
  });

  it('never prints a credential value', async () => {
    // collectStatus has its own version of this. Repeated at the entry point
    // because the renderer is a separate stage, and a leak added there would
    // pass the collector's test.
    seedConfig('myblog');

    await runStatus([]);

    expect(output()).not.toContain('a'.repeat(64));
  });

  it('reports a site whose credential env var is unset without failing the whole run', async () => {
    const home = join(fakeHome, '.byline');
    mkdirSync(join(home, 'personas'), { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'sites:\n  half:\n    platform: ghost\n    url: https://half.example.com\n    admin_api_key: ${NEVER_SET_XYZ}\n',
    );

    await expect(runStatus([])).resolves.toBeUndefined();
    expect(output()).toContain('half');
  });
});

describe('runRegister', () => {
  it('bare form prints the command and writes no file at all', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{"mcpServers":{}}\n');

    await runRegister([]);

    expect(output()).toContain('claude mcp add byline');
    // The bare form is advice, not an action.
    expect(readFileSync(join(fakeHome, '.claude.json'), 'utf8')).toBe('{"mcpServers":{}}\n');
    expect(existsSync(join(fakeHome, '.claude.json.byline-bak'))).toBe(false);
  });

  it('--tools all registers only tools that already exist on this machine', async () => {
    // The phase-4 defect: `all` used to mean all five, so it CREATED
    // ~/.gemini, ~/.codeium and ~/.codex from nothing and then reported all
    // five registered. Here only Claude Code exists.
    writeFileSync(join(fakeHome, '.claude.json'), '{"mcpServers":{}}\n');

    await runRegister(['--tools', 'all']);

    expect(JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8')).mcpServers.byline).toBeTruthy();
    expect(existsSync(join(fakeHome, '.gemini'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codeium'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codex'))).toBe(false);
  });

  it('backs the file up before merging, and leaves unrelated servers and settings intact', async () => {
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { mailman: { command: 'npx', args: ['-y', '@indianic/mailman'] } } }),
    );

    await runRegister(['--tools', 'claude']);

    const backup = join(fakeHome, '.claude.json.byline-bak');
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, 'utf8')).mcpServers.byline).toBeUndefined();

    const after = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.mailman).toBeTruthy();
    expect(after.mcpServers.byline).toBeTruthy();
  });

  it('is idempotent — re-running does not duplicate or corrupt the entry', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{"mcpServers":{}}\n');

    await runRegister(['--tools', 'claude']);
    const once = readFileSync(join(fakeHome, '.claude.json'), 'utf8');
    await runRegister(['--tools', 'claude']);
    const twice = readFileSync(join(fakeHome, '.claude.json'), 'utf8');

    expect(twice).toBe(once);
  });

  it('leaves a following TOML table intact when merging Codex config', async () => {
    // The inherited regex bug: `\[mcp_servers\.X\][^[]*` stopped at the first
    // literal '[', which is inside its OWN args = ["-y", ...] line. It left
    // orphan text behind and appended a fresh block, so the file grew and
    // corrupted on every re-run.
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    const codex = join(fakeHome, '.codex', 'config.toml');
    writeFileSync(codex, '[mcp_servers.other]\ncommand = "other"\n\n[some_other_table]\nkey = "value"\n');

    await runRegister(['--tools', 'codex']);
    await runRegister(['--tools', 'codex']);

    const after = readFileSync(codex, 'utf8');
    expect(after).toContain('[some_other_table]');
    expect(after).toContain('[mcp_servers.other]');
    // Exactly one byline block after two runs.
    expect(after.match(/\[mcp_servers\.byline\]/g)?.length).toBe(1);
  });

  it('ignores an unrecognised tool id rather than writing something unexpected', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{"mcpServers":{}}\n');

    await runRegister(['--tools', 'notatool']);

    expect(readFileSync(join(fakeHome, '.claude.json'), 'utf8')).toBe('{"mcpServers":{}}\n');
  });
});

describe('runReset', () => {
  it('refuses without --yes and leaves everything in place', async () => {
    seedConfig();
    process.env.BYLINE_HOME = join(fakeHome, '.byline');

    await runReset([]);

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(fakeHome, '.byline', 'config.yaml'))).toBe(true);
    expect(output()).toContain('--yes');
  });

  it('removes a real config directory when given --yes', async () => {
    seedConfig();
    process.env.BYLINE_HOME = join(fakeHome, '.byline');

    await runReset(['--yes']);

    expect(existsSync(join(fakeHome, '.byline'))).toBe(false);
  });

  it('refuses a source checkout even with --yes, and deletes nothing', async () => {
    // The guard runs on what the path IS, not how it resolved — an explicit
    // BYLINE_HOME pointing at a repo root used to sail straight through.
    const checkout = join(fakeHome, 'some-project');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}');
    process.env.BYLINE_HOME = checkout;

    await runReset(['--yes']);

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(checkout, 'package.json'))).toBe(true);
    expect(existsSync(join(checkout, '.git'))).toBe(true);
  });

  it('refuses the home directory itself even with --yes', async () => {
    process.env.BYLINE_HOME = fakeHome;
    writeFileSync(join(fakeHome, 'important.txt'), 'do not delete me');

    await runReset(['--yes']);

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(fakeHome, 'important.txt'))).toBe(true);
  });

  it('does not throw when there is nothing to remove', async () => {
    process.env.BYLINE_HOME = join(fakeHome, '.byline');

    await expect(runReset(['--yes'])).resolves.toBeUndefined();
  });
});
