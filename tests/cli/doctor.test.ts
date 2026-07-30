import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/cli/doctor.js';

/**
 * `runDoctor` sets `process.exitCode` rather than calling `process.exit`, so
 * these tests invoke it directly and read that back — reset in
 * beforeEach/afterEach so a failing case in one test can't leak into the next.
 *
 * `runDoctor` takes no `home`/`cwd` parameters (unlike `collectStatus`, which
 * does), so the only lever these tests have is the same one the real CLI
 * responds to: `BYLINE_HOME` for where config lives, and `HOME` for where
 * `collectStatus`'s default `homedir()` — and therefore AI-tool registration
 * detection — resolves to. That mirrors `tests/context.test.ts`'s established
 * pattern of mutating `process.env` directly rather than adding test-only
 * parameters to production code.
 *
 * Restoration is done key-by-key (`restoreEnv`), NOT via `process.env = {
 * ...saved }`. That wholesale-reassignment form — used elsewhere in this repo
 * — was verified to silently detach `process.env` from the native environment
 * after the first restore: every write after it (e.g. the next test's
 * `process.env.HOME = ...`) stops reaching libuv's `getenv`, so `os.homedir()`
 * (which `collectStatus` defaults to) keeps returning whatever the real
 * environment had before any test ever ran. Per-key `delete`/assign does not
 * have that problem.
 */

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value;
  }
}

let wbHome: string;
let fakeHome: string;
let written: string[];

beforeEach(() => {
  wbHome = mkdtempSync(join(tmpdir(), 'wb-doctor-home-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'wb-doctor-fakehome-'));
  process.env.BYLINE_HOME = wbHome;
  process.env.HOME = fakeHome;
  delete process.env.GEMINI_API_KEY;
  delete process.env.XAI_API_KEY;
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreEnv();
  process.exitCode = undefined;
  rmSync(wbHome, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function writeUsableSite(): void {
  writeFileSync(
    join(wbHome, 'config.yaml'),
    [
      'default_site: good',
      'sites:',
      '  good:',
      '    platform: ghost',
      '    url: https://good.example.com',
      '    admin_api_key: ${WB_DOCTOR_GOOD_KEY}',
      '',
    ].join('\n'),
  );
  // Ghost's admin key is `id:secret` where `secret` must be an even-length hex
  // string — anything else fails `ghostToken`'s format check before a single
  // byte reaches the network.
  process.env.WB_DOCTOR_GOOD_KEY = 'id:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
}

function registerAFakeTool(): void {
  writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ mcpServers: { byline: {} } }));
}

describe('runDoctor exit code', () => {
  it('fails with no configuration at all — no sites, no registered tool', async () => {
    await runDoctor(['--offline']);
    expect(process.exitCode).toBe(1);
  });

  it('passes with a usable configured site and at least one registered tool, offline', async () => {
    writeUsableSite();
    registerAFakeTool();
    await runDoctor(['--offline']);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails with a configured site but zero registered AI tools', async () => {
    writeUsableSite();
    // fakeHome deliberately left with no editor config files.
    await runDoctor(['--offline']);
    expect(process.exitCode).toBe(1);
  });

  it('fails with registered tools but zero configured sites', async () => {
    registerAFakeTool();
    // wbHome deliberately left with no config.yaml.
    await runDoctor(['--offline']);
    expect(process.exitCode).toBe(1);
  });

  it('does NOT fail on a missing image provider alone', async () => {
    writeUsableSite();
    registerAFakeTool();
    // Not --offline this time: exercises the real (non-network) provider loop,
    // where neither GEMINI_API_KEY nor XAI_API_KEY is set, so both providers
    // are reported "not configured" and never even reach `healthCheck()`.
    // `fetch` is stubbed only so an unrelated regression in the (also
    // now-live) site probe can't turn this into a flaky network test — it
    // isn't what this test is about.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ site: { title: 'x', version: '6.44' } }), { status: 200 })),
    );
    await runDoctor([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints an actionable fix line for zero configured sites', async () => {
    registerAFakeTool();
    await runDoctor(['--offline']);
    const output = written.join('');
    expect(output).toContain('no sites configured');
    expect(output.toLowerCase()).toContain('byline init');
  });

  it('prints an actionable fix line for zero registered AI tools', async () => {
    writeUsableSite();
    await runDoctor(['--offline']);
    const output = written.join('');
    expect(output).toContain('no AI tool registered');
    expect(output).toContain('byline register --tools all');
  });
});
