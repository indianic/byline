import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

/**
 * End-to-end coverage for `runUpdate`.
 *
 * Separate from tests/cli/commands-e2e.test.ts because it needs
 * `node:child_process` replaced wholesale. `vi.spyOn(child, 'execFile')` does
 * not work here — an ESM module namespace is not configurable, so the spy
 * throws "Cannot redefine property: execFile". A hoisted `vi.mock` factory is
 * the only way to intercept it, and mocking a core module for the whole file
 * is too blunt to share with tests that have nothing to do with it.
 *
 * Two things the mock has to get right:
 *
 *  - `update.ts` calls `promisify(execFile)` at MODULE LOAD, so the mock must
 *    be in place before that import — which is what `vi.mock`'s hoisting does.
 *  - `promisify` honours `util.promisify.custom`. Node's real `execFile`
 *    defines one that resolves to `{ stdout, stderr }`; plain callback
 *    promisification would resolve to `stdout` alone, and `update.ts`'s
 *    `const { stdout } = await execFileAsync(...)` would then destructure a
 *    string and blow up on `.trim()`. The mock defines the same custom symbol
 *    so it behaves like the real thing rather than like a convenient fiction.
 *
 * Nothing here may ever reach a real `npm`. A test that installs a global
 * package is a test that modifies the machine running it.
 */

const calls: Array<{ cmd: string; args: string[] }> = [];
let behaviour: (cmd: string, args: string[]) => { stdout: string } | Error = () => new Error('not configured');

vi.mock('node:child_process', () => {
  const execFile = ((cmd: string, args: string[], cb: (e: Error | null, out?: unknown) => void) => {
    calls.push({ cmd, args });
    const result = behaviour(cmd, args);
    if (result instanceof Error) cb(result);
    else cb(null, result);
    return {} as never;
  }) as unknown as { (...a: unknown[]): unknown; [key: symbol]: unknown };

  execFile[promisify.custom as unknown as symbol] = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const result = behaviour(cmd, args);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };

  return { execFile };
});

const { runUpdate } = await import('../../src/cli/update.js');

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

let written: string[];
const ANSI = /\x1b\[[0-9;]*m/g;
const output = (): string => written.join('').replace(ANSI, '');

beforeEach(() => {
  calls.length = 0;
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('runUpdate', () => {
  it('reports one clean failure and sets exit 1 when the registry cannot be reached', async () => {
    // The CURRENT reality: the package is not published, so `npm view` exits
    // non-zero with an E404. It must not throw, and must not put a stack trace
    // in front of someone who is looking for a fix.
    behaviour = () => new Error('Command failed: npm view @indianic/byline version\nnpm error code E404');

    await expect(runUpdate([])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toContain("Couldn't reach the registry");
    // The most useful part of the message: it names the likely cause instead
    // of leaving the reader to guess at a network problem.
    expect(out).toContain('may not be published yet');
    // And it stopped at the lookup — it never attempted an install.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe('view');
  });

  it('does nothing when the installed version is already the latest', async () => {
    const { getPackageVersion } = await import('../../src/version.js');
    behaviour = () => ({ stdout: `${getPackageVersion()}\n` });

    await runUpdate([]);

    expect(process.exitCode).toBeUndefined();
    // One call: the version lookup. No install.
    expect(calls).toHaveLength(1);
  });

  it('installs the newer version with the package manager that owns the install', async () => {
    behaviour = (cmd, args) => (args[0] === 'view' ? { stdout: '9.9.9\n' } : { stdout: '' });

    await runUpdate([]);

    expect(process.exitCode).toBeUndefined();
    expect(calls).toHaveLength(2);
    const install = calls[1]!;
    expect(['npm', 'pnpm', 'yarn']).toContain(install.cmd);
    expect(install.args.join(' ')).toContain('@indianic/byline@9.9.9');
    expect(output()).toContain('9.9.9');
  });

  it('reports a failed install without throwing, and sets exit 1', async () => {
    behaviour = (cmd, args) =>
      args[0] === 'view' ? { stdout: '9.9.9\n' } : new Error('EACCES: permission denied');

    await expect(runUpdate([])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toContain('EACCES');
    // It tells the user the exact command to run by hand.
    expect(out).toContain('@indianic/byline@9.9.9');
  });

  it('never invokes anything but the version lookup and one install', async () => {
    // A guard on this file rather than on the code: if the mock ever stops
    // intercepting, this suite becomes capable of installing a global package
    // on the machine running it.
    behaviour = (cmd, args) => (args[0] === 'view' ? { stdout: '9.9.9\n' } : { stdout: '' });

    await runUpdate([]);

    expect(calls.every((c) => ['npm', 'pnpm', 'yarn'].includes(c.cmd))).toBe(true);
    expect(calls.filter((c) => c.args[0] === 'view')).toHaveLength(1);
  });
});
