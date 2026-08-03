import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../../src/config/paths.js';
import { applyMigration, detectRepoConfig, planMigration, runMigrate } from '../../src/cli/migrate.js';

let repo: string;
let home: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  home = mkdtempSync(join(tmpdir(), 'wb-dest-'));
  mkdirSync(join(repo, 'config'), { recursive: true });
  mkdirSync(join(repo, 'personas'), { recursive: true });
  writeFileSync(join(repo, 'config', 'sites.yaml'), 'default_site: personal\nsites: {}\n');
  writeFileSync(join(repo, '.env'), 'PERSONAL_GHOST_KEY=id:secret\n', { mode: 0o644 });
  writeFileSync(join(repo, 'personas', 'jane-doe.yaml'), 'name: Jane Doe\n');
  writeFileSync(join(repo, 'personas', '_template.yaml'), 'name: \n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const target = () => resolvePaths({ BYLINE_HOME: home }, '/nowhere', '/nowhere');

describe('detectRepoConfig', () => {
  it('finds a repo-local config', () => {
    expect(detectRepoConfig(repo)).toBe(join(repo, 'config', 'sites.yaml'));
  });

  it('returns null when there is nothing to migrate', () => {
    expect(detectRepoConfig(home)).toBeNull();
  });
});

describe('planMigration', () => {
  it('plans the config, the secrets, and every persona', () => {
    const items = planMigration(repo, target());
    const byKind = (kind: string) => items.filter((i) => i.kind === kind);

    expect(byKind('config')[0]).toEqual({
      from: join(repo, 'config', 'sites.yaml'),
      to: join(home, 'config.yaml'),
      kind: 'config',
      action: 'copy',
    });
    expect(byKind('env')[0]!.to).toBe(join(home, '.env'));
    expect(byKind('persona').map((i) => i.to).sort()).toEqual(
      [join(home, 'personas', '_template.yaml'), join(home, 'personas', 'jane-doe.yaml')].sort(),
    );
  });

  it('marks an absent source as skip-missing rather than failing', () => {
    rmSync(join(repo, '.env'));
    const env = planMigration(repo, target()).find((i) => i.kind === 'env')!;
    expect(env.action).toBe('skip-missing');
  });

  it('never overwrites an existing destination', () => {
    writeFileSync(join(home, 'config.yaml'), 'sites: {}\n');
    const config = planMigration(repo, target()).find((i) => i.kind === 'config')!;
    expect(config.action).toBe('skip-exists');
  });
});

describe('applyMigration', () => {
  it('copies every planned file and leaves the source in place', () => {
    const done = applyMigration(planMigration(repo, target()));
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('default_site: personal');
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('PERSONAL_GHOST_KEY=id:secret');
    expect(readFileSync(join(home, 'personas', 'jane-doe.yaml'), 'utf8')).toContain('Jane Doe');
    // Non-destructive: migration is a copy, so a mistake costs nothing.
    expect(existsSync(join(repo, 'config', 'sites.yaml'))).toBe(true);
    expect(done.filter((i) => i.action === 'copy')).toHaveLength(4);
  });

  it('lands .env at mode 600 even though the source was world-readable', () => {
    applyMigration(planMigration(repo, target()));
    expect(statSync(join(home, '.env')).mode & 0o777).toBe(0o600);
  });

  it('does nothing for skipped items', () => {
    writeFileSync(join(home, 'config.yaml'), 'PRESERVE ME\n');
    applyMigration(planMigration(repo, target()));
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('PRESERVE ME\n');
  });

  it('never overwrites a destination that appears between plan and apply', () => {
    // The plan is made while home/config.yaml is still absent, so it says 'copy'.
    const plan = planMigration(repo, target());
    const configItem = plan.find((i) => i.kind === 'config')!;
    expect(configItem.action).toBe('copy');

    // A sentinel destination shows up in the window before apply runs —
    // exactly the gap a future caller with a real plan/apply split could hit.
    writeFileSync(join(home, 'config.yaml'), 'SENTINEL — do not overwrite\n');

    const results = applyMigration(plan);

    // The sentinel survives untouched.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('SENTINEL — do not overwrite\n');

    // The plan/reality mismatch is reported, not silently swallowed.
    const configResult = results.find((i) => i.kind === 'config')!;
    expect(configResult.action).toBe('copy');
    expect(configResult.error).toBeTruthy();

    // Everything else in the plan still went ahead.
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('PERSONAL_GHOST_KEY=id:secret');
  });

  it('reports one failed copy without aborting or throwing, and without touching the rest', () => {
    // Block the persona copy by putting a plain file where its parent
    // directory needs to be created — mkdirSync(..., {recursive:true}) then
    // fails with ENOTDIR, simulating "a destination directory that cannot be
    // created" (e.g. a full disk or permissions problem) mid-migration.
    const plan = planMigration(repo, target());
    writeFileSync(target().personasDir, 'blocking a directory from existing here\n');

    const results = applyMigration(plan);

    const personaResults = results.filter((i) => i.kind === 'persona');
    expect(personaResults.length).toBeGreaterThan(0);
    for (const p of personaResults) {
      expect(p.action).toBe('copy');
      expect(p.error).toBeTruthy();
    }

    // The rest of the plan still copied successfully — one failure did not
    // abort the run.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('default_site: personal');
    const envResult = results.find((i) => i.kind === 'env')!;
    expect(envResult.error).toBeUndefined();
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('PERSONAL_GHOST_KEY=id:secret');
  });
});

/**
 * Drives the failure through `runMigrate` itself — the real CLI entrypoint —
 * rather than through `applyMigration`. `runMigrate` calls `ensureHome(target)`
 * BEFORE `applyMigration` runs, so a destination that cannot be created (a
 * plain file sitting where a subdirectory needs to go) throws out of
 * `ensureHome`, never reaching `applyMigration` at all. The earlier
 * per-item-copy-failure fix (b77c084) only guarded `applyMigration`, so a unit
 * test calling `applyMigration` directly — as every test above does — could
 * never have caught this: it bypasses the exact call that crashes.
 */
describe('runMigrate — destination cannot be created', () => {
  // Restored key-by-key on every pass, never via `process.env = { ...saved }`
  // (that form silently detaches `process.env` from the native environment,
  // leaving `os.homedir()` stale for the rest of the process — see
  // tests/cli/doctor.test.ts, which established this pattern).
  const savedEnv = { ...process.env };
  let originalCwd: string;
  let written: string[];

  function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(repo);
    process.env.BYLINE_HOME = home;
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    restoreEnv();
    process.exitCode = undefined;
  });

  const output = () => written.join('');

  it('reports a clean, actionable failure and does not throw when a destination subdirectory cannot be created', async () => {
    // `home` (== target.home, via BYLINE_HOME) exists as a directory
    // already (mkdtempSync made it), but `personas` inside it is occupied by a
    // plain file — so `ensureHome`'s `mkdirSync(target.personasDir, {
    // recursive: true })` fails with EEXIST, exactly as the reviewer's repro
    // against the real CLI showed.
    const personasPath = join(home, 'personas');
    writeFileSync(personasPath, 'blocking the personas directory from existing here\n');

    await expect(runMigrate(['--yes'])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);

    const out = output();
    // Names the path and the reason, per the finding — not a generic message.
    expect(out).toContain(home);
    expect(out.toLowerCase()).toMatch(/exist|create/);
    // Definitely not the raw stack trace the reviewer reproduced.
    expect(out).not.toContain('at mkdirSync');
    expect(out).not.toContain('at ensureHome');
    expect(out).not.toContain('at Object');

    // Nothing was copied — the run aborted before applyMigration ever ran.
    expect(existsSync(join(home, 'config.yaml'))).toBe(false);
    expect(existsSync(join(home, '.env'))).toBe(false);
  });
});
