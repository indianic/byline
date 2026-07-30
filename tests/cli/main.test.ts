import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRegister } from '../../src/cli/register.js';
import { ToolError } from '../../src/errors.js';

// `register` is the command mocked below to exercise runCli's error boundary —
// COMMANDS is module-private, so a real dispatch-table entry has to be made to
// throw rather than calling the boundary helper directly. This is the only
// thing in this suite that needs the mock; every other test below dispatches
// commands that never touch `register`.
vi.mock('../../src/cli/register.js', () => ({ runRegister: vi.fn() }));

import { runCli, suggestCommand } from '../../src/cli/main.js';
import { getPackageVersion } from '../../src/version.js';

let written: string[];

beforeEach(() => {
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

const output = () => written.join('');

describe('suggestCommand', () => {
  it('corrects a one-character typo', () => {
    expect(suggestCommand('statuss')).toBe('status');
  });

  it('corrects a transposition', () => {
    expect(suggestCommand('doctro')).toBe('doctor');
  });

  it('returns null when nothing is plausibly close', () => {
    expect(suggestCommand('xyzzyplugh')).toBeNull();
  });
});

describe('runCli', () => {
  it('prints the bare version for --version, with no tree decoration', async () => {
    await runCli(['--version']);
    expect(output()).toBe(`${getPackageVersion()}\n`);
  });

  it('shows help with no arguments', async () => {
    await runCli([]);
    expect(output()).toContain('commands');
    expect(output()).toContain('init');
    expect(output()).toContain('doctor');
  });

  it('names every command in help', async () => {
    await runCli(['help']);
    for (const name of ['init', 'status', 'doctor', 'register', 'migrate', 'reset', 'update']) {
      expect(output()).toContain(name);
    }
  });

  it('suggests the nearest command and exits non-zero on a typo', async () => {
    await runCli(['statuss']);
    expect(output()).toContain('Unknown command: statuss');
    expect(output()).toContain('byline status');
    expect(process.exitCode).toBe(1);
  });

  it('has no unimplemented commands left', async () => {
    await runCli(['help']);
    expect(output()).not.toContain('not implemented yet');
  });
});

describe('runCli error boundary', () => {
  it('renders a clean failure and sets exitCode 1 when a handler throws a plain Error, without letting it escape', async () => {
    vi.mocked(runRegister).mockRejectedValueOnce(new Error('disk on fire'));

    await expect(runCli(['register'])).resolves.toBeUndefined();

    expect(output()).toContain('disk on fire');
    expect(process.exitCode).toBe(1);
  });

  it('renders a ToolError hint, since that field exists to tell the user what to do next', async () => {
    vi.mocked(runRegister).mockRejectedValueOnce(
      new ToolError({
        api: 'register',
        code: 'NO_EDITOR',
        message: 'No editor config could be written',
        hint: 'Pass --tools <a,b|all> or run with -i to pick interactively.',
      }),
    );

    await runCli(['register']);

    expect(output()).toContain('No editor config could be written');
    expect(output()).toContain('Pass --tools <a,b|all> or run with -i to pick interactively.');
    expect(process.exitCode).toBe(1);
  });

  it('does not print the stack by default, but points at BYLINE_DEBUG', async () => {
    vi.mocked(runRegister).mockRejectedValueOnce(new Error('boom'));

    await runCli(['register']);

    expect(output()).not.toContain('.ts:');
    expect(output()).not.toContain('at Object');
    expect(output().toUpperCase()).toContain('BYLINE_DEBUG');
  });

  it('prints the stack when BYLINE_DEBUG is set', async () => {
    const err = new Error('boom with stack');
    vi.mocked(runRegister).mockRejectedValueOnce(err);
    process.env.BYLINE_DEBUG = '1';

    try {
      await runCli(['register']);
      // `detail()` re-wraps a multi-line message per-line with the tree's rail
      // prefix, so the raw multi-line stack never appears as one contiguous
      // substring — checking for a frame line is enough to prove it printed.
      const stackFrame = err.stack!.split('\n').find((line) => line.trim().startsWith('at '));
      expect(stackFrame).toBeDefined();
      expect(output()).toContain(stackFrame!.trim());
    } finally {
      delete process.env.BYLINE_DEBUG;
    }
  });
});
